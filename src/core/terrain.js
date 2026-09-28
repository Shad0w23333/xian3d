// 地形：DEM 解码 + 高度查询 + 平整区 + 四叉树 LOD 瓦片（每块瓦片贴对应的卫星影像）
import * as THREE from 'three';
import { BOUNDS, lonLatBoxToWorld, lonLatToTile, tileWorldBounds } from './geo.js';
import { loadImageBitmap, bitmapPixels } from './data.js';

const DEFAULT_H = 405;

class DEM {
  constructor(heights, w, h, bounds) {
    this.hts = heights;
    this.w = w;
    this.h = h;
    this.b = bounds;
    this.sx = w / (bounds.x1 - bounds.x0);
    this.sz = h / (bounds.z1 - bounds.z0);
    this.mpp = (bounds.x1 - bounds.x0) / w;
  }
  contains(x, z, margin = 0) {
    const b = this.b;
    return x >= b.x0 + margin && x <= b.x1 - margin && z >= b.z0 + margin && z <= b.z1 - margin;
  }
  /** 双线性采样（像素中心对齐） */
  sample(x, z) {
    let fx = (x - this.b.x0) * this.sx - 0.5;
    let fz = (z - this.b.z0) * this.sz - 0.5;
    const w = this.w, h = this.h;
    if (fx < 0) fx = 0; else if (fx > w - 1.001) fx = w - 1.001;
    if (fz < 0) fz = 0; else if (fz > h - 1.001) fz = h - 1.001;
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i = iz * w + ix;
    const a = this.hts[i], b = this.hts[i + 1], c = this.hts[i + w], d = this.hts[i + w + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }
  /** 到边缘的距离（米），用于主/外 DEM 过渡 */
  edgeDist(x, z) {
    const b = this.b;
    return Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z);
  }
}

// ---------- 平整区（地标台基、广场、湖面等） ----------
function polyArea(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

class FlattenZone {
  constructor({ points, height = null, feather = 30, mode = 'set', offset = 0 }, terrain) {
    this.p = Float64Array.from(points);
    this.feather = Math.max(0.01, feather);
    this.mode = mode;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < this.p.length; i += 2) {
      x0 = Math.min(x0, this.p[i]); x1 = Math.max(x1, this.p[i]);
      z0 = Math.min(z0, this.p[i + 1]); z1 = Math.max(z1, this.p[i + 1]);
    }
    this.bb = { x0, x1, z0, z1 };
    const f = this.feather;
    this.ebb = { x0: x0 - f, x1: x1 + f, z0: z0 - f, z1: z1 + f };
    if (height == null) {
      // 取多边形内原始地形的平均高度
      let s = 0, n = 0;
      for (let i = 0; i <= 8; i++)
        for (let j = 0; j <= 8; j++) {
          const x = x0 + ((x1 - x0) * i) / 8, z = z0 + ((z1 - z0) * j) / 8;
          if (this.inside(x, z)) { s += terrain.rawHeightAt(x, z); n++; }
        }
      height = n ? s / n : terrain.rawHeightAt((x0 + x1) / 2, (z0 + z1) / 2);
    }
    this.height = height + offset;
  }
  inside(x, z) {
    const p = this.p;
    let c = false;
    for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  }
  dist(x, z) {
    const p = this.p;
    let best = Infinity;
    for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
      const ax = p[j * 2], az = p[j * 2 + 1], bx = p[i * 2], bz = p[i * 2 + 1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      const d = ex * ex + ez * ez;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  /** 返回权重 0..1 */
  weight(x, z) {
    const b = this.ebb;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return 0;
    if (this.inside(x, z)) return 1;
    const d = this.dist(x, z);
    if (d >= this.feather) return 0;
    const t = 1 - d / this.feather;
    return t * t * (3 - 2 * t);
  }
}

// ---------- 地形瓦片着色器补丁：自定义 UV 变换 + 近处细节 ----------
function patchTileMaterial(mat, uvXform) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uUvXform = uvXform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uUvXform;\nvarying vec3 vTerrWorld;')
      .replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = uv * uUvXform.zw + uUvXform.xy;\n#endif'
      )
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrWorld;\n' + NOISE_GLSL)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          // 近处叠加细节噪声，削弱卫星图放大后的模糊感
          float dcam = length(vTerrWorld - cameraPosition);
          float fade = 1.0 - smoothstep(60.0, 900.0, dcam);
          if (fade > 0.0) {
            float n = tnoise(vTerrWorld.xz * 0.9) * 0.5 + tnoise(vTerrWorld.xz * 3.7) * 0.3 + tnoise(vTerrWorld.xz * 11.0) * 0.2;
            diffuseColor.rgb *= 1.0 + (n - 0.5) * 0.22 * fade;
          }
          // 卫星图自带的阴影与过曝：轻微压缩动态范围
          vec3 tc = diffuseColor.rgb;
          float tl = dot(tc, vec3(0.2126, 0.7152, 0.0722));
          tc = mix(vec3(tl), tc, 1.22);            // 饱和度
          tc = pow(max(tc, 0.0), vec3(1.1)) * 1.08; // 对比度
          diffuseColor.rgb = tc;
        }`
      );
  };
  mat.customProgramCacheKey = () => 'xian-terrain-v2';
}

const NOISE_GLSL = `
float thash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float tnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(thash(i),thash(i+vec2(1,0)),u.x), mix(thash(i+vec2(0,1)),thash(i+vec2(1,1)),u.x), u.y); }
`;

// ---------- 四叉树节点 ----------
class Node {
  constructor(z, x, y, parent) {
    this.z = z;
    this.x = x;
    this.y = y;
    this.parent = parent;
    this.b = tileWorldBounds(z, x, y);
    this.size = this.b.x1 - this.b.x0;
    this.cx = (this.b.x0 + this.b.x1) / 2;
    this.cz = (this.b.z0 + this.b.z1) / 2;
    this.children = null;
    this.mesh = null;
    this.minH = parent ? parent.minH : 300;
    this.maxH = parent ? parent.maxH : 3000;
    this.lastVisible = -1;
    this.texLevel = -1; // 当前影像来源精度（在线瓦片的 zoom；底图记为 -mpp）
    this.srcKey = null;
  }
}

export class Terrain {
  constructor() {
    this.dems = [];
    this.zones = [];
    this.zoneGrid = new Map();
    this.cell = 1000;
    this.ready = false;
  }

  async load(meta) {
    const list = (meta && meta.dem) || [];
    const dems = await Promise.all(
      list.map(async (d) => {
        const bmp = await loadImageBitmap(d.file, { optional: true, flip: false });
        if (!bmp) return null;
        const px = bitmapPixels(bmp);
        const n = bmp.width * bmp.height;
        const hts = new Float32Array(n);
        for (let i = 0; i < n; i++) hts[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        bmp.close && bmp.close();
        return new DEM(hts, d.w || bmp.width, d.h || bmp.height, d.bounds);
      })
    );
    this.dems = dems.filter(Boolean).sort((a, b) => a.mpp - b.mpp); // 精细在前
    this.ready = true;
    if (!this.dems.length) console.warn('[terrain] 未找到 DEM，使用平地');
  }

  /** 原始地面高度（不含平整区） */
  rawHeightAt(x, z) {
    const d = this.dems;
    if (!d.length) return DEFAULT_H;
    for (let i = 0; i < d.length; i++) {
      const dem = d[i];
      if (!dem.contains(x, z)) continue;
      // 与下一级（更粗）DEM 在边缘 1.5 km 内平滑过渡
      const next = d[i + 1];
      if (next) {
        const e = dem.edgeDist(x, z);
        if (e < 1500) {
          const t = e / 1500;
          return dem.sample(x, z) * t + next.sample(x, z) * (1 - t);
        }
      }
      return dem.sample(x, z);
    }
    return d[d.length - 1].sample(x, z);
  }

  /** 地面高度（含平整区） */
  heightAt(x, z) {
    let h = this.rawHeightAt(x, z);
    if (this.zones.length) {
      const list = this.zoneGrid.get(this._cellKey(x, z));
      if (list)
        for (const zn of list) {
          const w = zn.weight(x, z);
          if (w <= 0) continue;
          if (zn.mode === 'set') h += (zn.height - h) * w;
          else if (zn.mode === 'max') h = Math.max(h, h + (zn.height - h) * w);
          else if (zn.mode === 'min') h = Math.min(h, h + (zn.height - h) * w);
        }
    }
    return h;
  }

  normalAt(x, z, out = new THREE.Vector3(), step = 8) {
    const hl = this.heightAt(x - step, z), hr = this.heightAt(x + step, z);
    const hu = this.heightAt(x, z - step), hd = this.heightAt(x, z + step);
    return out.set(hl - hr, 2 * step, hu - hd).normalize();
  }

  _cellKey(x, z) {
    return Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell);
  }

  /**
   * 注册平整区。points: [x,z,...]（世界坐标）；height: 目标海拔（null=取区域平均）；
   * feather: 过渡带宽（米）；mode: set | max（只抬高）| min（只压低）；offset: 在目标上的附加偏移
   * 返回最终目标海拔。
   */
  addFlatten(opts) {
    const zn = new FlattenZone(opts, this);
    this.zones.push(zn);
    const b = zn.ebb;
    for (let cx = Math.floor(b.x0 / this.cell); cx <= Math.floor(b.x1 / this.cell); cx++)
      for (let cz = Math.floor(b.z0 / this.cell); cz <= Math.floor(b.z1 / this.cell); cz++) {
        const k = cx * 100003 + cz;
        if (!this.zoneGrid.has(k)) this.zoneGrid.set(k, []);
        this.zoneGrid.get(k).push(zn);
      }
    if (this.nodes) this.invalidate(b);
    return zn.height;
  }

  /** 沿射线求与地面交点（步进 + 二分），返回 Vector3 或 null */
  raycast(origin, dir, maxDist = 60000) {
    let t = 0;
    let step = Math.max(2, (origin.y - this.heightAt(origin.x, origin.z)) * 0.02);
    let prevT = 0;
    const p = new THREE.Vector3();
    while (t < maxDist) {
      p.copy(dir).multiplyScalar(t).add(origin);
      const h = this.heightAt(p.x, p.z);
      if (p.y <= h) {
        let a = prevT, b = t;
        for (let i = 0; i < 20; i++) {
          const m = (a + b) / 2;
          p.copy(dir).multiplyScalar(m).add(origin);
          if (p.y <= this.heightAt(p.x, p.z)) b = m; else a = m;
        }
        return p.copy(dir).multiplyScalar(b).add(origin);
      }
      prevT = t;
      t += step;
      step = Math.min(step * 1.04 + 0.5, 400);
    }
    return null;
  }

  // =================== 渲染 ===================
  initRender(scene, imagery, quality) {
    this.imagery = imagery;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.frame = 0;
    this.meshCount = 0;
    this.visibleCount = 0;
    this.buildMsBudget = 6;
    this.indexCache = new Map();
    this.nodes = new Set();

    const outer = lonLatBoxToWorld(BOUNDS.OUTER);
    this.mainBox = lonLatBoxToWorld(BOUNDS.MAIN);
    this.outerBox = outer;
    const RZ = 9;
    const a = lonLatToTile(BOUNDS.OUTER[0], BOUNDS.OUTER[3], RZ);
    const b = lonLatToTile(BOUNDS.OUTER[2], BOUNDS.OUTER[1], RZ);
    this.roots = [];
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
      for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) this.roots.push(new Node(RZ, x, y, null));

    imagery.onLoaded((z, x, y) => this._onTileImagery(z, x, y));
  }

  setQuality(q) {
    this.quality = q;
  }

  _maxZoom(n) {
    const b = n.b, m = this.mainBox;
    const inMain = b.x1 > m.x0 && b.x0 < m.x1 && b.z1 > m.z0 && b.z0 < m.z1;
    const q = this.quality.maxTileZoom;
    const onlineOn = this.imagery.online.enabled;
    if (!inMain) return 13;
    // 本地离线高清包：比在线再细一级（包里有 z19/z20 时，“高”画质到 19、“超高”到 20），
    // 但只细分到本块范围内包里实际有的最深一级；包只有粗级（全域 z15）或没覆盖的地方按无在线影像时的深度
    const im = this.imagery;
    if (onlineOn && im.provider.local && im.pack) return Math.min(q + 1, Math.max(im.pack.coverZ(n.z, n.x, n.y), Math.min(q, 16)));
    return onlineOn ? q : Math.min(q, 16);
  }

  _distTo(n, cam) {
    const b = n.b;
    const dx = Math.max(b.x0 - cam.x, 0, cam.x - b.x1);
    const dz = Math.max(b.z0 - cam.z, 0, cam.z - b.z1);
    const dy = Math.max(n.minH - cam.y, 0, cam.y - n.maxH);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  update(camera) {
    if (!this.group) return;
    this.frame++;
    const cam = camera.position;
    this._t0 = performance.now();
    this._camPos = cam;
    this.visibleCount = 0;
    for (const r of this.roots) this._select(r, cam, true);
    // 隐藏/回收不再需要的网格
    if (this.frame % 30 === 0) this._gc();
  }

  _select(n, cam, mustRender) {
    const d = this._distTo(n, cam);
    const split = n.z < this._maxZoom(n) && d < n.size * this.quality.terrainSplit;
    if (split) {
      if (!n.children) {
        const z = n.z + 1, x = n.x * 2, y = n.y * 2;
        n.children = [new Node(z, x, y, n), new Node(z, x + 1, y, n), new Node(z, x, y + 1, n), new Node(z, x + 1, y + 1, n)];
      }
      let ready = true;
      for (const c of n.children) {
        if (!c.mesh) {
          if (performance.now() - this._t0 < this.buildMsBudget || !n.mesh) this._build(c);
          else ready = false;
        }
      }
      if (ready) {
        if (n.mesh) n.mesh.visible = false;
        // 中间节点仍在使用（父节点细分前要求子网格齐全）：记为活跃，免得 _gc 每 30 帧销毁后又立刻重建
        n.lastVisible = this.frame;
        for (const c of n.children) this._select(c, cam, true);
        return;
      }
    }
    if (!n.mesh) this._build(n);
    n.mesh.visible = true;
    n.lastVisible = this.frame;
    this.visibleCount++;
    this._refreshTexture(n, d);
    // 子节点全部隐藏
    if (n.children) for (const c of n.children) this._hideSubtree(c);
  }

  _hideSubtree(n) {
    if (n.mesh) n.mesh.visible = false;
    if (n.children) for (const c of n.children) this._hideSubtree(c);
  }

  _gc() {
    const keepFrames = 240;
    // 引用的是旧影像源的在线瓦片（切换影像源之后）
    const pid = this.imagery.providerId + ':';
    const stale = (n) => n.srcKey && n.srcKey !== 'none' && !n.srcKey.startsWith('m:') && !n.srcKey.startsWith(pid);
    const walk = (n) => {
      if (n.children) {
        for (const c of n.children) walk(c);
        // 整个子树长期不可见则回收
        if (n.children.every((c) => !c.mesh && !c.children)) {
          if (this.frame - Math.max(...n.children.map((c) => c.lastVisible)) > keepFrames) n.children = null;
        }
      }
      if (n.mesh && !n.mesh.visible) {
        if (this.frame - n.lastVisible > keepFrames && n.parent) this._dispose(n);
        else if (stale(n)) this._refreshTexture(n, 1e9, false); // 隐藏的中间节点仍引用旧影像源纹理：换掉（不发请求），让旧纹理能被回收
      }
    };
    for (const r of this.roots) walk(r);
  }

  _dispose(n) {
    if (!n.mesh) return;
    this.group.remove(n.mesh);
    n.mesh.geometry.dispose();
    this.imagery.release(n.mesh.material.map);
    n.mesh.material.dispose();
    n.mesh = null;
    n.texLevel = -1;
    n.srcKey = null;
    this.meshCount--;
  }

  /** 平整区变化后重建相关瓦片 */
  invalidate(b) {
    const walk = (n) => {
      const nb = n.b;
      if (nb.x1 < b.x0 || nb.x0 > b.x1 || nb.z1 < b.z0 || nb.z0 > b.z1) return;
      if (n.mesh) {
        const vis = n.mesh.visible;
        this._dispose(n);
        this._build(n);
        n.mesh.visible = vis;
      }
      if (n.children) for (const c of n.children) walk(c);
    };
    if (this.roots) for (const r of this.roots) walk(r);
  }

  _index(seg) {
    if (this.indexCache.has(seg)) return this.indexCache.get(seg);
    const W = seg + 1;
    const idx = [];
    for (let j = 0; j < seg; j++)
      for (let i = 0; i < seg; i++) {
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    // 裙边：四条边各 W 个顶点，位于网格顶点之后
    const base = W * W;
    const edges = [
      (k) => k, // 北边 j=0
      (k) => seg * W + k, // 南边
      (k) => k * W, // 西边
      (k) => k * W + seg, // 东边
    ];
    edges.forEach((ef, e) => {
      for (let k = 0; k < seg; k++) {
        const a = ef(k), b = ef(k + 1);
        const sa = base + e * W + k, sb = sa + 1;
        idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa); // 双面，免去方向判断
      }
    });
    const attr = new THREE.BufferAttribute(W * W + 4 * W > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
    this.indexCache.set(seg, attr);
    return attr;
  }

  _build(n) {
    const seg = n.z >= 17 ? 16 : n.z >= 14 ? 24 : 32;
    const W = seg + 1;
    const b = n.b;
    const dx = (b.x1 - b.x0) / seg, dz = (b.z1 - b.z0) / seg;
    // 带 1 圈外扩的高度网格，便于求法线
    const G = W + 2;
    const hg = new Float32Array(G * G);
    let minH = Infinity, maxH = -Infinity;
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const h = this.heightAt(b.x0 + (i - 1) * dx, b.z0 + (j - 1) * dz);
        hg[j * G + i] = h;
        if (i > 0 && j > 0 && i < G - 1 && j < G - 1) {
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
        }
      }
    n.minH = minH;
    n.maxH = maxH;
    const nv = W * W + 4 * W;
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const skirt = Math.min(200, n.size * 0.02 + 4);
    for (let j = 0; j < W; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const gi = (j + 1) * G + (i + 1);
        pos[k * 3] = b.x0 + i * dx - n.cx;
        pos[k * 3 + 1] = hg[gi];
        pos[k * 3 + 2] = b.z0 + j * dz - n.cz;
        const nx = (hg[gi - 1] - hg[gi + 1]) / (2 * dx);
        const nz = (hg[gi - G] - hg[gi + G]) / (2 * dz);
        const l = Math.hypot(nx, 1, nz);
        nor[k * 3] = nx / l;
        nor[k * 3 + 1] = 1 / l;
        nor[k * 3 + 2] = nz / l;
        uv[k * 2] = i / seg;
        uv[k * 2 + 1] = 1 - j / seg;
      }
    const edges = [(k) => k, (k) => seg * W + k, (k) => k * W, (k) => k * W + seg];
    edges.forEach((ef, e) => {
      for (let k = 0; k < W; k++) {
        const src = ef(k), dst = W * W + e * W + k;
        pos[dst * 3] = pos[src * 3];
        pos[dst * 3 + 1] = pos[src * 3 + 1] - skirt;
        pos[dst * 3 + 2] = pos[src * 3 + 2];
        nor.copyWithin(dst * 3, src * 3, src * 3 + 3);
        uv[dst * 2] = uv[src * 2];
        uv[dst * 2 + 1] = uv[src * 2 + 1];
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(this._index(seg));
    g.boundingBox = new THREE.Box3(new THREE.Vector3(b.x0 - n.cx, minH - skirt, b.z0 - n.cz), new THREE.Vector3(b.x1 - n.cx, maxH, b.z1 - n.cz));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());

    const uvXform = { value: new THREE.Vector4(0, 0, 1, 1) };
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0.0, color: 0xffffff });
    mat.userData.uvXform = uvXform;
    patchTileMaterial(mat, uvXform);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(n.cx, 0, n.cz);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = `tile ${n.z}/${n.x}/${n.y}`;
    mesh.userData.terrain = true;
    n.mesh = mesh;
    n.texLevel = -1;
    n.srcKey = null;
    this.group.add(mesh);
    this.meshCount++;
    this._refreshTexture(n, this._camPos ? this._distTo(n, this._camPos) : 1e9);
  }

  /** 选择当前最清晰的可用影像：在线瓦片（自身或祖先）或内置底图 */
  _refreshTexture(n, dist, request = true) {
    const im = this.imagery;
    const onlineMax = im.online.maxZoom;
    let best = null; // {tex, level(越大越清晰), bounds, key}
    if (im.online.enabled || im.cache.size) {
      const zTop = Math.min(n.z, onlineMax);
      const prio = dist / Math.max(1, n.size);
      let want = request && im.online.enabled; // 还需要为本块请求一级影像
      for (let z = zTop; z >= 9; z--) {
        const s = n.z - z;
        const ax = n.x >> s, ay = n.y >> s;
        const tex = im.get(z, ax, ay);
        if (tex) {
          const bb = tileWorldBounds(z, ax, ay);
          best = { tex, mpp: (bb.x1 - bb.x0) / 256, bounds: bb, key: `${im.providerId}:${z}/${ax}/${ay}` };
          break;
        }
        // 请求最深一级尚未失败的影像：本地包缺这一级时 request 会同步记为失败，继续向上请求祖先
        // （否则包里只有 z17 的地方，z18+ 叶子在切换影像源后再没人请求 z17）
        if (want && z >= 10 && !im.isFailed(z, ax, ay)) {
          im.request(z, ax, ay, prio);
          if (!im.isFailed(z, ax, ay)) want = false;
        }
      }
    }
    const m = im.bestMosaic(n.b);
    if (m && (!best || m.mpp < best.mpp * 0.8)) best = { tex: m.texture, mpp: m.mpp, bounds: m.bounds, key: 'm:' + m.file };
    if (!best) {
      if (n.srcKey !== 'none') {
        n.mesh.material.color.set(0x8a8270);
        n.srcKey = 'none';
      }
      return;
    }
    if (best.key === n.srcKey) return;
    const mat = n.mesh.material;
    const hadMap = !!mat.map;
    if (mat.map) im.release(mat.map);
    im.retain(best.tex);
    mat.map = best.tex;
    mat.color.set(0xffffff);
    const A = best.bounds, b = n.b;
    const W = A.x1 - A.x0, H = A.z1 - A.z0;
    mat.userData.uvXform.value.set((b.x0 - A.x0) / W, 1 - (b.z1 - A.z0) / H, (b.x1 - b.x0) / W, (b.z1 - b.z0) / H);
    if (!hadMap) mat.needsUpdate = true;
    n.srcKey = best.key;
    n.texLevel = -best.mpp;
  }

  _onTileImagery(z, x, y) {
    // 让覆盖范围内、当前影像更粗的可见瓦片刷新
    const walk = (n) => {
      if (n.z <= z) {
        const s = z - n.z;
        if (x >> s !== n.x || y >> s !== n.y) return;
      } else {
        const s = n.z - z;
        if (n.x >> s !== x || n.y >> s !== y) return;
      }
      if (n.mesh && n.mesh.visible && n.z >= z) this._refreshTexture(n, this._camPos ? this._distTo(n, this._camPos) : 1e9);
      if (n.children) for (const c of n.children) walk(c);
    };
    for (const r of this.roots) walk(r);
  }
}
