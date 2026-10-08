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

// ---------- 地形挖洞（下沉广场等）：瓦片着色器里丢弃洞内片元，洞内由模块自己的坑底/挡墙几何补齐 ----------
// 为什么不用平整区压低：地形网格间距 4~21 m（随 LOD），压低的坑与地面之间只能是一两格宽的斜面，
// 斜面会爬上挡墙、盖住坑底商铺；而外扩压低范围又会把坑外的道路、步道一起拉下去。挖洞后地形在坑外保持原样，
// 坑的形状完全由模块几何决定（heightAt 不受影响，坑外道路/树木/建筑取到的仍是地面高度）。
// 数据放在一张 RGBA32F 小纹理里（不占 uniform 向量）：第 0 行每洞 2 个像素 = 包围盒 (x0,z0,x1,z1)、(起点, 点数)；
// 第 1 行起每像素一个顶点 (x, z)。
const HOLE_TW = 256, HOLE_TH = 8, MAX_HOLES = 64, MAX_HOLE_PTS = HOLE_TW * (HOLE_TH - 1);
const HOLE_GLSL = `
uniform highp sampler2D uHoleTex;
uniform int uHoleN;
bool terrInHole(vec2 p) {
  for (int h = 0; h < ${MAX_HOLES}; h++) {
    if (h >= uHoleN) break;
    vec4 bb = texelFetch(uHoleTex, ivec2(h * 2, 0), 0);
    if (p.x < bb.x || p.x > bb.z || p.y < bb.y || p.y > bb.w) continue;
    vec4 rg = texelFetch(uHoleTex, ivec2(h * 2 + 1, 0), 0);
    int s = int(rg.x + 0.5), n = int(rg.y + 0.5);
    bool c = false;
    vec2 b = texelFetch(uHoleTex, ivec2((s + n - 1) % ${HOLE_TW}, 1 + (s + n - 1) / ${HOLE_TW}), 0).xy;
    for (int i = 0; i < 1024; i++) {
      if (i >= n) break;
      int k = s + i;
      vec2 a = texelFetch(uHoleTex, ivec2(k % ${HOLE_TW}, 1 + k / ${HOLE_TW}), 0).xy;
      if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
      b = a;
    }
    if (c) return true;
  }
  return false;
}
`;

// ---------- 地面语义图：用地（绿地/广场）+ 路网（路面、夜间城市光）栅格化成贴图，供地形着色器使用 ----------
// 通道：R = 绿地（公园/草地/林地/果园），G = 夜间城市漫射光（按路网等级与周边路网密度，路灯与店铺溢光的近似），
//       B = 路面（1，地面层道路）/ 广场（0.5）。
// 两张：远图覆盖主城 36 km（17.6 m/像素，供俯视夜景与中远景）；近图跟随相机 1.6 km（1.6 m/像素，人眼高度的绿地边界与灯光衰减）。
const GND_FAR = { x0: -18000, z0: -18000, size: 36000, px: 2048 };
const GND_NEAR = { size: 1600, px: 1024, move: 320, maxAgl: 700 };
const VEG_KINDS = new Set(['park', 'grass', 'forest', 'orchard']);
// 类别 → [夜间光强 0..1, 光晕外扩（米，单侧）]
const ROAD_GLOW = {
  motorway: [0.8, 20], trunk: [1, 22], primary: [1, 20], secondary: [0.9, 16], tertiary: [0.75, 13], residential: [0.5, 10],
  service: [0.32, 7], unclassified: [0.45, 9], motorway_link: [0.7, 12], trunk_link: [0.8, 12], primary_link: [0.8, 12],
  secondary_link: [0.7, 10], pedestrian: [0.8, 10], footway: [0.18, 4],
};

class GroundMaps {
  constructor(data) {
    const roads = data && data.roads;
    const classes = (roads && roads.classes) || [];
    this.roads = [];
    for (const f of (roads && roads.features) || []) {
      const p = f.p;
      if (!p || p.length < 4) continue;
      const g = ROAD_GLOW[classes[f.c]] || [0.4, 8];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
        if (p[i + 1] < z0) z0 = p[i + 1]; if (p[i + 1] > z1) z1 = p[i + 1];
      }
      this.roads.push({
        p, w: Math.max(2, +f.w || 6), glow: f.t ? 0 : g[0] * (f.b ? 0.7 : 1), spill: g[1],
        ground: !f.t && !f.b && !(f.y > 0), bb: [x0, z0, x1, z1],
      });
    }
    this.areas = [];
    for (const f of (data && data.landuse && data.landuse.polys) || []) {
      const kind = VEG_KINDS.has(f.k) ? 1 : f.k === 'square' ? 2 : 0;
      if (!kind || !f.outer || f.outer.length < 6) continue;
      const o = f.outer;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < o.length; i += 2) {
        if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i];
        if (o[i + 1] < z0) z0 = o[i + 1]; if (o[i + 1] > z1) z1 = o[i + 1];
      }
      this.areas.push({ kind, outer: o, holes: f.holes || [], bb: [x0, z0, x1, z1] });
    }
    // 近图检索用格网（400 m）
    this.cell = 400;
    this.grid = new Map();
    const reg = (list, tag) => list.forEach((it, i) => {
      const b = it.bb, c = this.cell;
      if (b[2] - b[0] > 30000 || b[3] - b[1] > 30000) return; // 超大面（外围林地）只进远图
      for (let cx = Math.floor(b[0] / c); cx <= Math.floor(b[2] / c); cx++)
        for (let cz = Math.floor(b[1] / c); cz <= Math.floor(b[3] / c); cz++) {
          const k = cx * 100003 + cz;
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(tag + i);
        }
    });
    reg(this.roads, 0);
    reg(this.areas, 1 << 24);
    this.dens = null; // 周边路网灯光密度（256² 网格，覆盖远图范围）
  }

  _canvas(px) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : Object.assign(document.createElement('canvas'), { width: px, height: px });
    return c;
  }

  /** 把 [x0,z0]-[x0+size] 范围画进 px² 的 RGBA 字节数组（R 绿地 / G 灯光（未乘密度）/ B 路面） */
  _raster(x0, z0, size, px, roads, areas) {
    if (!this._cv || this._cv.width !== px) {
      this._cv = this._canvas(px);
      this._cg = this._canvas(px);
    }
    const c = this._cv.getContext('2d', { willReadFrequently: true });
    const g = this._cg.getContext('2d');
    const s = px / size;
    for (const k of [c, g]) {
      k.setTransform(1, 0, 0, 1, 0, 0);
      k.globalCompositeOperation = 'source-over';
      k.filter = 'none';
      k.fillStyle = '#000';
      k.fillRect(0, 0, px, px);
      k.setTransform(s, 0, 0, s, -x0 * s, -z0 * s);
      k.globalCompositeOperation = 'lighter';
      k.lineCap = 'round';
      k.lineJoin = 'round';
    }
    const inView = (b, m) => b[2] >= x0 - m && b[0] <= x0 + size + m && b[3] >= z0 - m && b[1] <= z0 + size + m;
    // 绿地、广场
    const ring = (r) => {
      c.moveTo(r[0], r[1]);
      for (let i = 2; i < r.length; i += 2) c.lineTo(r[i], r[i + 1]);
      c.closePath();
    };
    for (const kind of [1, 2]) {
      c.beginPath();
      for (const a of areas) {
        if (a.kind !== kind || !inView(a.bb, 0)) continue;
        ring(a.outer);
        for (const h of a.holes) if (h && h.length >= 6) ring(h);
      }
      c.fillStyle = kind === 1 ? '#ff0000' : '#000080';
      c.fill('evenodd');
    }
    // 路面（只画地面层道路；同宽度一批，单条路径内重叠不叠加）
    const byW = new Map();
    for (const r of roads) {
      if (!r.ground || !inView(r.bb, 30)) continue;
      const k = Math.round(r.w);
      if (!byW.has(k)) byW.set(k, []);
      byW.get(k).push(r);
    }
    c.strokeStyle = '#0000ff';
    for (const [w, list] of byW) {
      c.lineWidth = w;
      c.beginPath();
      for (const r of list) {
        const p = r.p;
        c.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
      }
      c.stroke();
    }
    // 夜间灯光：按（光强, 宽度）分批，叠加（路口更亮）
    const byG = new Map();
    for (const r of roads) {
      if (r.glow <= 0 || !inView(r.bb, 60)) continue;
      const k = Math.round(r.glow * 20) + '|' + Math.round(r.w + 2 * r.spill);
      if (!byG.has(k)) byG.set(k, []);
      byG.get(k).push(r);
    }
    for (const [k, list] of byG) {
      const [gi, wi] = k.split('|').map(Number);
      g.strokeStyle = `rgb(0,${Math.round(Math.min(1, gi / 20) * 150)},0)`;
      g.lineWidth = wi;
      g.beginPath();
      for (const r of list) {
        const p = r.p;
        g.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
      }
      g.stroke();
    }
    // 光晕羽化（约 8 m 或 1 像素）后叠进主图 G 通道
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.filter = `blur(${Math.max(1, 8 * s).toFixed(1)}px)`;
    c.drawImage(this._cg, 0, 0);
    c.filter = 'none';
    return c.getImageData(0, 0, px, px).data;
  }

  /** 周边路网灯光密度 0..1（双线性） */
  urbanAt(x, z) {
    const D = this.dens;
    if (!D) return 0;
    const n = 256;
    let fx = ((x - GND_FAR.x0) / GND_FAR.size) * n - 0.5, fz = ((z - GND_FAR.z0) / GND_FAR.size) * n - 0.5;
    if (fx < 0 || fz < 0 || fx > n - 1.001 || fz > n - 1.001) return 0;
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * n + ix;
    return (D[i] * (1 - tx) + D[i + 1] * tx) * (1 - tz) + (D[i + n] * (1 - tx) + D[i + n + 1] * tx) * tz;
  }

  /** 灯光通道乘以“城区程度”（郊野的孤立公路不发光），并加一层随密度的底光（街区内部的店铺/楼宇溢光） */
  _urbanize(d, x0, z0, size, px) {
    const m = size / px;
    for (let j = 0; j < px; j++) {
      const z = z0 + (j + 0.5) * m;
      for (let i = 0; i < px; i++) {
        const k = (j * px + i) * 4;
        const u = this.urbanAt(x0 + (i + 0.5) * m, z);
        const t = Math.min(1, Math.max(0, (u - 0.05) / 0.22));
        const urb = t * t * (3 - 2 * t);
        d[k + 1] = Math.min(255, d[k + 1] * urb + 34 * urb);
        d[k + 3] = 255;
      }
    }
  }

  buildFar() {
    const F = GND_FAR;
    const d = this._raster(F.x0, F.z0, F.size, F.px, this.roads, this.areas);
    // 密度：G 通道按 8×8 块平均到 256²，再做两遍半径 2 的盒式模糊（约 1.4 km）
    const n = 256, b = F.px / n;
    let D = new Float32Array(n * n);
    for (let j = 0; j < F.px; j++)
      for (let i = 0; i < F.px; i++) D[((j / b) | 0) * n + ((i / b) | 0)] += d[(j * F.px + i) * 4 + 1] / 150;
    for (let i = 0; i < D.length; i++) D[i] /= b * b;
    const T = new Float32Array(n * n);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          let s = 0, c = 0;
          for (let k = -2; k <= 2; k++) { const ii = i + k; if (ii >= 0 && ii < n) { s += D[j * n + ii]; c++; } }
          T[j * n + i] = s / c;
        }
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          let s = 0, c = 0;
          for (let k = -2; k <= 2; k++) { const jj = j + k; if (jj >= 0 && jj < n) { s += T[jj * n + i]; c++; } }
          D[j * n + i] = s / c;
        }
    }
    this.dens = D;
    this._urbanize(d, F.x0, F.z0, F.size, F.px);
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
  }

  buildNear(x0, z0) {
    const N = GND_NEAR, c = this.cell;
    const seenR = new Set(), seenA = new Set();
    const roads = [], areas = [];
    for (let cx = Math.floor(x0 / c); cx <= Math.floor((x0 + N.size) / c); cx++)
      for (let cz = Math.floor(z0 / c); cz <= Math.floor((z0 + N.size) / c); cz++) {
        const l = this.grid.get(cx * 100003 + cz);
        if (!l) continue;
        for (const t of l) {
          if (t >= 1 << 24) { const i = t - (1 << 24); if (!seenA.has(i)) { seenA.add(i); areas.push(this.areas[i]); } }
          else if (!seenR.has(t)) { seenR.add(t); roads.push(this.roads[t]); }
        }
      }
    // 超大面（未进格网）：直接按包围盒筛
    for (const a of this.areas) {
      const b = a.bb;
      if ((b[2] - b[0] > 30000 || b[3] - b[1] > 30000) && b[2] >= x0 && b[0] <= x0 + N.size && b[3] >= z0 && b[1] <= z0 + N.size) areas.push(a);
    }
    const d = this._raster(x0, z0, N.size, N.px, roads, areas);
    this._urbanize(d, x0, z0, N.size, N.px);
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  }
}

function makeGroundTexture(data, px) {
  const t = new THREE.DataTexture(data, px, px, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------- 地形瓦片着色器补丁：自定义 UV 变换 + 影像调色 + 近处程序化地面 + 夜间压暗与城市光 + 挖洞 ----------
function patchTileMaterial(mat, uvXform, holes, gnd, texM) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uUvXform = uvXform;
    shader.uniforms.uHoleTex = holes.tex;
    shader.uniforms.uHoleN = holes.n;
    shader.uniforms.uTexM = texM;
    shader.uniforms.uGndFar = gnd.far;
    shader.uniforms.uGndFarBox = gnd.farBox;
    shader.uniforms.uGndNear = gnd.near;
    shader.uniforms.uGndNearBox = gnd.nearBox;
    shader.uniforms.uGndNearOn = gnd.nearOn;
    shader.uniforms.uTNight = gnd.night;
    shader.uniforms.uCamAgl = gnd.camAgl;
    shader.uniforms.uGlowGain = gnd.glowGain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uUvXform;\nvarying vec3 vTerrWorld;')
      .replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\n#ifdef USE_MAP\n vMapUv = uv * uUvXform.zw + uUvXform.xy;\n#endif'
      )
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrWorld;\n' + NOISE_GLSL + HOLE_GLSL + GROUND_GLSL)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (uHoleN > 0 && terrInHole(vTerrWorld.xz)) discard;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + TERRAIN_SURFACE_GLSL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += terrGlow;');
  };
  mat.customProgramCacheKey = () => 'xian-terrain-v7';
}

const NOISE_GLSL = `
// 整数位哈希（世界坐标上万米时，fract(p*大数) 的浮点哈希精度不够，会出现成片的斜条纹）
float thash(vec2 p){
  uvec2 u = floatBitsToUint(p) * 1664525u + 1013904223u;
  u.x += u.y * 1664525u; u.y += u.x * 1664525u;
  u ^= u >> 16u;
  u.x += u.y * 1664525u; u.y += u.x * 1664525u;
  u ^= u >> 16u;
  return float(u.x ^ u.y) * (1.0 / 4294967296.0);
}
float tnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(thash(i),thash(i+vec2(1,0)),u.x), mix(thash(i+vec2(0,1)),thash(i+vec2(1,1)),u.x), u.y); }
`;

const GROUND_GLSL = /* glsl */ `
uniform float uTexM;
uniform sampler2D uGndFar; uniform vec4 uGndFarBox;
uniform sampler2D uGndNear; uniform vec4 uGndNearBox; uniform float uGndNearOn;
uniform float uTNight; uniform float uCamAgl; uniform float uGlowGain;
float tLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// 卫星影像调色。原先的“饱和度 ×1.3、pow 1.12 ×1.1”是给 Esri 冬季灰图准备的；现在的 Google 影像本身饱和度正常，
// 再加强会把土黄推成紫红、把浅色铺装与残雪推成纯白（审查：农田发紫、楼间地面像积雪）。现在只做轻度对比，并且：
//  · 压冷色偏色（蓝、品红、紫：阴影、彩钢瓦、残雪、偏色瓦片）；
//  · 高光软肩（白屋顶、过曝铺装、雪斑不再刺白）；远处的高亮低饱和（远山积雪、冬季白斑）压成灰褐（far）；
//  · 提亮影像自带的楼影（lift）。
vec3 tGrade(vec3 c, float lift, float far) {
  c = pow(max(c, 0.0), vec3(1.06)) * 1.03;
  float l = tLuma(c);
  c = max(mix(vec3(l), c, 1.1), 0.0);
  float mx = max(c.r, max(c.g, c.b));
  float cool = (max(0.0, c.b - max(c.r, c.g)) + 0.9 * max(0.0, min(c.r, c.b) - c.g)) / max(mx, 1e-3);
  l = tLuma(c);
  c = mix(c, vec3(l) * vec3(1.03, 1.0, 0.95), smoothstep(0.025, 0.2, cool) * 0.92);
  // 粉紫褐（红最高、蓝高于绿）：冬季影像的荒草地、农田、土路常呈这种色，加上天光就成了“紫色地毯”。把蓝压到绿的水平 → 土黄褐
  c.b -= max(0.0, c.b - c.g) * step(c.b, c.r) * 0.75;
  // 高光软肩（线性亮度 0.42 ≈ sRGB 0.68 以上压缩）
  l = tLuma(c);
  float over = max(l - 0.42, 0.0);
  float lc = l - over + over / (1.0 + over * 2.5);
  c *= lc / max(l, 1e-4);
  l = lc;
  mx = max(c.r, max(c.g, c.b));
  float sat = (mx - min(c.r, min(c.g, c.b))) / max(mx, 1e-3);
  float snow = smoothstep(0.2, 0.38, l) * (1.0 - smoothstep(0.08, 0.22, sat)) * far;
  c = mix(c, vec3(l * 0.55) * vec3(1.05, 1.0, 0.9), snow * 0.8);
  // 影像里的楼影：暗且不偏绿（树冠是暗绿，保留）。3D 楼会投下自己的阴影，影像阴影是重复的，还常与太阳方向相反
  float grn = clamp((c.g - max(c.r, c.b)) / max(mx, 1e-3) * 6.0, 0.0, 1.0);
  float sh = smoothstep(0.05, 0.012, l) * (1.0 - grn) * lift;
  c = mix(c, vec3(1.03, 1.0, 0.96) * min(max(l, 0.004) * 3.5, 0.055), sh);
  return c;
}
// 程序化铺装：返回反照率（线性）。pxw = 每像素米数（缝线抗锯齿）
vec3 tPavers(vec2 w, vec2 sz, float rowShift, vec3 base, float var, float jw, float pxw) {
  vec2 g = w / sz;
  g.x += rowShift * floor(g.y);
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  vec2 jt = vec2(jw) / sz;                         // 缝宽（以砖块为单位）
  vec2 aa = vec2(pxw) / sz;
  vec2 e = smoothstep(0.5 - jt - aa, 0.5 - jt * 0.3, abs(f));
  float joint = max(e.x, e.y) * (1.0 - smoothstep(jw * 1.5, jw * 6.0, pxw));
  float tone = 1.0 + var * (thash(id + 0.37) - 0.5) * 2.0 * (1.0 - smoothstep(sz.y * 0.4, sz.y * 1.5, pxw));
  return base * tone * (1.0 - 0.32 * joint);
}
`;

const TERRAIN_SURFACE_GLSL = /* glsl */ `
  vec3 terrGlow = vec3(0.0);
  {
    vec2 w = vTerrWorld.xz;
    float dcam = length(vTerrWorld - cameraPosition);
    float pxw = length(fwidth(w));                    // 每像素覆盖的地面米数（放在分支外求导）
    // 地面语义图（远图 + 跟随相机的近图）：只有夜间（城市光）和近景程序化地面用得到，白天远处不取样（全城俯视时省两次取样）。
    // 分支里不能用隐式导数，按每像素米数手算 mip 级别
    vec3 gnd = vec3(0.0);
    if (uTNight > 0.001 || dcam < 320.0) {
      vec2 uf = (w - uGndFarBox.xy) * uGndFarBox.zw;
      vec2 un = (w - uGndNearBox.xy) * uGndNearBox.zw;
      vec3 gF = textureLod(uGndFar, uf, log2(max(pxw / ${(GND_FAR.size / GND_FAR.px).toFixed(4)}, 1.0))).rgb;
      vec3 gN = textureLod(uGndNear, un, log2(max(pxw / ${(GND_NEAR.size / GND_NEAR.px).toFixed(4)}, 1.0))).rgb;
      vec2 ef = min(uf, 1.0 - uf), en = min(un, 1.0 - un);
      gF *= smoothstep(0.0, 0.02, min(ef.x, ef.y));
      gnd = mix(gF, gN, uGndNearOn * smoothstep(0.0, 0.1, min(en.x, en.y)));
    }

    // 高频噪声按像素尺度淡出（否则远处摩尔纹/斜条纹）
    float aaA = 1.0 - smoothstep(0.06, 0.25, pxw);   // 约 4/m
    float aaB = 1.0 - smoothstep(0.025, 0.1, pxw);   // 约 10/m
    // 近处叠加细节噪声，削弱卫星图放大后的模糊感
    float fade = 1.0 - smoothstep(60.0, 900.0, dcam);
    if (fade > 0.0) {
      float n = tnoise(w * 0.9) * 0.5 + mix(0.5, tnoise(w * 3.7), aaA) * 0.3 + mix(0.5, tnoise(w * 11.0), aaB) * 0.2;
      diffuseColor.rgb *= 1.0 + (n - 0.5) * 0.22 * fade;
    }
    vec3 tc = tGrade(diffuseColor.rgb, 1.0 - 0.5 * smoothstep(1500.0, 8000.0, dcam), smoothstep(5000.0, 14000.0, dcam));
    diffuseColor.rgb = tc;

    // —— 近景地面（人眼高度/低空）：卫星图放大后是糊掉的屋顶、车影和偏蓝的阴影，看着像一滩水。
    //    近处改为程序化地面：用地图（绿地/广场/路面）+ 卫星图低频色调分类，铺装按地块（正南正北的矩形）换材质，
    //    地块边有路缘石，偶见井盖；远处与较高机位保持卫星图。——
    float procW = (1.0 - smoothstep(30.0, 300.0, dcam)) * mix(1.0, 0.35, smoothstep(14.0, 90.0, uCamAgl));
    if (procW > 0.002) {
      #ifdef USE_MAP
        // 低频取样按影像实际分辨率换算成固定的地面尺度（约 8 m / 1.5 m），相邻瓦片影像级别不同也一致（消除 LOD 接缝）
        vec3 low = textureLod(map, vMapUv, log2(max(8.0 / uTexM, 1.0))).rgb;
        vec3 mid = textureLod(map, vMapUv, log2(max(1.5 / uTexM, 1.0))).rgb;
        low = tGrade(low, 1.0, 0.0);
        mid = tGrade(mid, 1.0, 0.0);
      #else
        vec3 low = tc;
        vec3 mid = tc;
      #endif
      float lumL = max(tLuma(low), 1e-3), lumM = tLuma(mid);
      float mxL = max(low.r, max(low.g, low.b));
      float n1 = tnoise(w * 0.35), n2 = mix(0.5, tnoise(w * 2.3), aaA), n3 = mix(0.5, tnoise(w * 9.0), aaB), nl = tnoise(w * 0.06);
      // 分类
      float imgVeg = smoothstep(0.03, 0.12, (low.g - max(low.r, low.b)) / max(mxL, 0.02));
      float bright = smoothstep(0.09, 0.2, lumL) * (1.0 - imgVeg);          // 绿地里的亮灰：园路、小广场
      float veg = max(imgVeg * (0.5 + 0.5 * gnd.r), gnd.r * (1.0 - bright));
      veg = smoothstep(0.42, 0.58, veg + (n1 - 0.5) * 0.3 + (n3 - 0.5) * 0.08);
      float asphalt = smoothstep(0.7, 0.9, gnd.b);
      float plaza = smoothstep(0.3, 0.45, gnd.b) * (1.0 - asphalt);
      float soil = smoothstep(0.12, 0.3, (low.r - low.b) / max(mxL, 0.02)) * (1.0 - veg) * (1.0 - asphalt);

      // 地块：48 m 方格，每格在随机位置按东西或南北一分为二
      vec2 cell = floor(w / 48.0);
      vec2 fc = w - cell * 48.0;
      float hv = thash(cell + 3.1);
      float cut = 10.0 + 28.0 * thash(cell + 7.7);
      float axis = hv > 0.5 ? fc.x : fc.y;
      float side = step(cut, axis);
      float ph = thash(cell * 1.7 + side * 13.1 + 0.5);
      float dB = min(min(fc.x, 48.0 - fc.x), min(fc.y, 48.0 - fc.y));
      dB = min(dB, abs(axis - cut));
      // 材质：影像暗处偏沥青/深色砖，亮处偏水泥/石材
      float pick = clamp(ph + (0.13 - lumL) * 1.6, 0.0, 0.999);
      vec3 pav;
      if (pick < 0.3) pav = tPavers(w, vec2(0.6), 0.0, vec3(0.20, 0.195, 0.185), 0.07, 0.008, pxw);           // 方砖
      else if (pick < 0.52) pav = tPavers(w, vec2(3.0), 0.0, vec3(0.29, 0.28, 0.26), 0.05, 0.006, pxw)        // 水泥板
                                  * (0.86 + 0.2 * nl + 0.06 * n2);
      else if (pick < 0.72) pav = tPavers(w, vec2(0.2, 0.1), 0.5, mix(vec3(0.23, 0.185, 0.155), vec3(0.2, 0.19, 0.18), step(0.5, ph * 7.0 - floor(ph * 7.0))), 0.12, 0.004, pxw); // 小砖
      else if (pick < 0.9) {                                                                                    // 沥青停车场
        pav = vec3(0.072, 0.072, 0.077) * (0.85 + 0.25 * n2 + 0.1 * n3);
        vec2 st = vec2(fract(w.x / 2.5), fract(w.y / 16.0));                                                     // 车位线：2.5 m 宽、5.3 m 深
        float line = (1.0 - smoothstep(0.04, 0.04 + pxw / 2.5, abs(st.x - 0.5))) * step(st.y, 0.33);
        pav = mix(pav, vec3(0.42, 0.42, 0.4), line * 0.8 * (1.0 - smoothstep(0.05, 0.2, pxw)));
      }
      else pav = tPavers(w, vec2(1.0, 0.5), 0.5, vec3(0.27, 0.26, 0.25), 0.06, 0.005, pxw) * (0.93 + 0.12 * n3); // 石板
      // 广场：浅灰花岗岩大板；路面（路口等未被路网网格覆盖处）：沥青
      vec3 granite = tPavers(w, vec2(0.9, 0.6), 0.0, vec3(0.26, 0.255, 0.245), 0.06, 0.005, pxw) * (0.94 + 0.1 * n3);
      vec3 asph = vec3(0.068, 0.068, 0.073) * (0.85 + 0.22 * n2 + 0.12 * n3) * (0.92 + 0.16 * nl);
      pav = mix(pav, granite, plaza);
      // 低频影像色调与亮度：与远处卫星图衔接，块与块之间不至于一个颜色
      vec3 hue = clamp(low / lumL, vec3(0.88), vec3(1.14));
      pav *= mix(vec3(1.0), hue, 0.22) * mix(1.0, clamp(lumL / 0.15, 0.65, 1.3), 0.4);
      // 路缘石（地块边，近处）与井盖
      float curb = (1.0 - smoothstep(0.12, 0.12 + pxw, dB)) * (1.0 - smoothstep(0.03, 0.12, pxw));
      pav = mix(pav, vec3(0.30, 0.295, 0.28), curb * 0.85);
      vec2 mc = floor(w / 9.0);
      vec2 mp = (mc + 0.2 + 0.6 * vec2(thash(mc + 1.3), thash(mc + 5.9))) * 9.0;
      float md = length(w - mp);
      float mh = step(thash(mc + 9.1), 0.06) * (1.0 - smoothstep(0.02, 0.1, pxw)) * (1.0 - plaza * 0.5);
      pav = mix(pav, vec3(0.05, 0.05, 0.055) * (0.8 + 0.4 * step(0.27, md) * step(md, 0.31)), mh * (1.0 - smoothstep(0.33, 0.33 + pxw, md)));
      pav = mix(pav, asph, asphalt);
      // 草地：保留一点低频色相，近处加细碎的叶片噪声；偶有黄斑与裸土
      float gfine = tnoise(w * 31.0) * (1.0 - smoothstep(0.02, 0.08, pxw));
      vec3 grass = mix(vec3(0.052, 0.082, 0.032), vec3(0.105, 0.135, 0.055), n1) * (0.8 + 0.3 * n3 + 0.25 * gfine);
      grass *= 0.85 + 0.3 * tnoise(w * 0.13 + 7.0);                                   // 大块深浅（修剪、湿度）
      grass = mix(grass, vec3(0.14, 0.13, 0.08), smoothstep(0.6, 0.8, nl) * 0.55);      // 枯黄斑
      grass = mix(grass, vec3(0.13, 0.105, 0.075), smoothstep(0.7, 0.9, tnoise(w * 0.5 + 3.0)) * 0.35 * (1.0 - imgVeg)); // 裸土斑
      grass *= mix(vec3(1.0), clamp(low / lumL, vec3(0.85), vec3(1.2)), 0.25);
      vec3 dirt = mix(low * 0.9, vec3(0.19, 0.15, 0.105), 0.55) * (0.85 + 0.25 * n2);
      vec3 ground = mix(mix(pav, dirt, soil), grass, veg);
      // 影像中频（约 1.5 m）明暗：保留地面上的大致图形，但不带卫星图的锐利杂物与接缝
      ground *= mix(1.0, clamp(lumM / lumL, 0.8, 1.25), 0.3);
      diffuseColor.rgb = mix(tc, ground, procW);
    }

    // —— 夜间：月光下的地面不该像白天一样清楚（白屋顶、田块）；城市里按路网叠加暖色漫射光（路灯、店铺溢光），郊野保持暗 ——
    if (uTNight > 0.001) {
      vec3 alb = diffuseColor.rgb;
      float ln = tLuma(alb);
      vec3 nAlb = mix(alb, vec3(ln), 0.4 * uTNight);
      nAlb = min(nAlb, vec3(mix(1.0, 0.16, uTNight)));
      diffuseColor.rgb = nAlb * (1.0 - 0.5 * uTNight);
      terrGlow = min(alb, vec3(0.3)) * vec3(1.0, 0.66, 0.38) * gnd.g * uGlowGain * uTNight;
    }
  }
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
    // 挖洞：多边形列表 + 着色器数据纹理（所有瓦片材质共用同一组 uniform 对象）
    this.holes = [];
    const tex = new THREE.DataTexture(new Float32Array(HOLE_TW * HOLE_TH * 4), HOLE_TW, HOLE_TH, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.holeU = { tex: { value: tex }, n: { value: 0 } };
  }

  /**
   * 挖洞：points [x,z,...]（世界坐标，简单多边形）内的地形瓦片不绘制。只影响渲染，不改 heightAt。
   * 调用方负责用自己的几何把洞补齐（坑底、挡墙、台阶……），挡墙顶至少高出洞口一圈地形（见 holeRimTop）。
   * 返回洞编号；超出容量返回 -1。
   */
  addHole(points) {
    const n = points.length >> 1;
    const used = this.holes.reduce((s, h) => s + h.n, 0);
    if (n < 3 || this.holes.length >= MAX_HOLES || used + n > MAX_HOLE_PTS) {
      console.warn('[terrain] 挖洞容量不足，忽略', n);
      return -1;
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, points[i * 2]); x1 = Math.max(x1, points[i * 2]);
      z0 = Math.min(z0, points[i * 2 + 1]); z1 = Math.max(z1, points[i * 2 + 1]);
    }
    const h = { p: Float64Array.from(points), n, start: used, bb: { x0, x1, z0, z1 } };
    this.holes.push(h);
    const tex = this.holeU.tex.value, d = tex.image.data, k = this.holes.length - 1;
    d.set([x0, z0, x1, z1], k * 2 * 4);
    d.set([h.start, n, 0, 0], (k * 2 + 1) * 4);
    for (let i = 0; i < n; i++) d.set([points[i * 2], points[i * 2 + 1], 0, 0], (HOLE_TW + h.start + i) * 4);
    tex.needsUpdate = true;
    this.holeU.n.value = this.holes.length;
    return k;
  }

  /** 点是否在某个洞内（与着色器同一射线法） */
  inHole(x, z) {
    for (const h of this.holes) {
      const b = h.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      let c = false;
      const p = h.p;
      for (let i = 0, j = h.n - 1; i < h.n; j = i++) {
        const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
      }
      if (c) return true;
    }
    return false;
  }

  /**
   * 洞口一圈地形渲染面可能达到的最高高度：沿轮廓每 ≤ step 米取 heightAt，再加上瓦片网格线性插值的误差余量。
   * 挡墙/压顶做到这个高度以上，洞口边缘就不会露缝（地形面在洞外、挡墙顶在洞口）。
   */
  holeRimTop(points, step = 3, margin = 0.25) {
    let hi = -Infinity;
    const n = points.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = points[i * 2], az = points[i * 2 + 1], bx = points[j * 2], bz = points[j * 2 + 1];
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
      for (let s = 0; s < k; s++) hi = Math.max(hi, this.heightAt(ax + ((bx - ax) * s) / k, az + ((bz - az) * s) / k));
    }
    return hi + margin;
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
  /** ctx（可选）：模块上下文，取 ctx.data（路网、用地 → 地面语义图）与 ctx.uniforms.uNight */
  initRender(scene, imagery, quality, ctx = null) {
    this.imagery = imagery;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    // 地面语义图（所有瓦片材质共用同一组 uniform 对象）
    const blank = makeGroundTexture(new Uint8Array(4), 1);
    this.gndU = {
      far: { value: blank },
      farBox: { value: new THREE.Vector4(GND_FAR.x0, GND_FAR.z0, 1 / GND_FAR.size, 1 / GND_FAR.size) },
      near: { value: blank },
      nearBox: { value: new THREE.Vector4(0, 0, 1 / GND_NEAR.size, 1 / GND_NEAR.size) },
      nearOn: { value: 0 },
      night: (ctx && ctx.uniforms && ctx.uniforms.uNight) || { value: 0 },
      camAgl: { value: 100 },
      glowGain: { value: 0.75 },
    };
    this.gmaps = null;
    if (ctx && ctx.data) {
      try {
        const t0 = performance.now();
        this.gmaps = new GroundMaps(ctx.data);
        this.gndU.far.value = makeGroundTexture(this.gmaps.buildFar(), GND_FAR.px);
        this._nearC = null;
        console.info(`[terrain] 地面语义图：路 ${this.gmaps.roads.length}、绿地/广场 ${this.gmaps.areas.length}，${(performance.now() - t0).toFixed(0)} ms`);
      } catch (e) {
        console.warn('[terrain] 地面语义图生成失败', e);
        this.gmaps = null;
      }
    }
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
    // 影像清晰度细分判据用：屏幕上一个像素对应的视角（弧度）、相机离地高度、水平朝向
    if (camera.isPerspectiveCamera) this._kpx = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(400, (typeof window !== 'undefined' && window.innerHeight) || 900);
    this._agl = cam.y - this.heightAt(cam.x, cam.z);
    camera.getWorldDirection(this._fwd || (this._fwd = new THREE.Vector3()));
    this.visibleCount = 0;
    for (const r of this.roots) this._select(r, cam, true);
    // 隐藏/回收不再需要的网格
    if (this.frame % 30 === 0) this._gc();
    this._updateGround(cam);
  }

  /** 相机离地高度 uniform + 跟随相机的近景语义图（离开中心超过 GND_NEAR.move 米时重画） */
  _updateGround(cam) {
    const U = this.gndU;
    if (!U) return;
    const agl = cam.y - this.heightAt(cam.x, cam.z);
    U.camAgl.value = agl;
    if (!this.gmaps) return;
    if (agl > GND_NEAR.maxAgl) return;
    const c = this._nearC;
    if (c && Math.abs(cam.x - c.x) < GND_NEAR.move && Math.abs(cam.z - c.z) < GND_NEAR.move) return;
    const cx = Math.round(cam.x / 50) * 50, cz = Math.round(cam.z / 50) * 50;
    const x0 = cx - GND_NEAR.size / 2, z0 = cz - GND_NEAR.size / 2;
    try {
      const d = this.gmaps.buildNear(x0, z0);
      const tex = U.near.value;
      if (tex.image && tex.image.width === GND_NEAR.px) {
        tex.image.data.set(d);
        tex.needsUpdate = true;
      } else {
        U.near.value = makeGroundTexture(d.slice(), GND_NEAR.px);
      }
      U.nearBox.value.set(x0, z0, 1 / GND_NEAR.size, 1 / GND_NEAR.size);
      U.nearOn.value = 1;
      this._nearC = { x: cx, z: cz };
    } catch (e) {
      console.warn('[terrain] 近景语义图生成失败', e);
      this.gmaps = null;
    }
  }

  _select(n, cam, mustRender) {
    const d = this._distTo(n, cam);
    const maxZ = this._maxZoom(n);
    let split = n.z < maxZ && d < n.size * this.quality.terrainSplit;
    // 影像清晰度：本块能用的影像（本级瓦片或内置高清底图）每像素米数明显大于屏幕上一个像素覆盖的地面时再细分一级。
    // 主城高清底图（img_core 约 5 m/像素）覆盖范围外，按距离细分出来的远处瓦片只有 z13 影像（约 16 m/像素），
    // 全城俯视时与底图覆盖区之间有一条清晰/模糊分界线（审查：起始视角右下角糊成水彩）。
    // 只对粗瓦片（z11~14，影像 8~60 m/像素）、没有更清晰底图的地方、且最多比按距离的细分远 60% 才生效（等于多细分一级）；
    // 只对高空俯视（离地 > 250 m）且在相机前方的瓦片生效：人眼高度时远处瓦片挤在地平线上看不出差别，
    // 相机身后的瓦片也不必细分（否则可见瓦片从约 600 增到 850，影像缓存 700 张来回淘汰重载，永远加载不完）。
    if (!split && n.z < maxZ && n.z >= 11 && n.z <= 14 && this._kpx && this._agl > 250 && d < n.size * this.quality.terrainSplit * 1.6 &&
        (n.cx - cam.x) * this._fwd.x + (n.cz - cam.z) * this._fwd.z > -n.size) {
      if (n.mosMpp === undefined) {
        const m = this.imagery.bestMosaic(n.b);
        n.mosMpp = m ? m.mpp : Infinity;
      }
      const own = n.size / 256;
      if (n.mosMpp > own * 0.8 && own > 0.7 * Math.max(d, 1) * this._kpx) split = true;
    }
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
    const texM = { value: 1 }; // 当前影像每像素米数（近景低频取样按地面尺度换算 mip 级别）
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0.0, color: 0xffffff });
    mat.userData.uvXform = uvXform;
    mat.userData.texM = texM;
    patchTileMaterial(mat, uvXform, this.holeU, this.gndU, texM);
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
    mat.userData.texM.value = best.mpp;
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
