// skyline：通用摩天楼生成器（分段收分/斜顶/塔冠/裙房/屋顶设备/停机坪/避雷针/楼顶字/航空障碍灯）
import * as THREE from 'three';
import { Batcher } from '../core/util.js';
import * as G from './sky-geom.js';
import { style as mkStyle } from './sky-facade.js';

// ---------- 招牌图集：所有楼顶字/立面字合成贴图（按需分页，每页一个材质、一次绘制） ----------
// 已拷进图集并释放了像素的文字画布（textures.text 的模块级缓存会一直持有它们，同键再取到时需换键重绘）
const RELEASED = new WeakSet();
let freshSeq = 0;
export class SignAtlas {
  /**
   * opts（均可选）：
   *   rowH      横排条目在图集中的像素高度（默认 150）
   *   vW        >0 时竖排条目按宽度缩放到 vW 像素（默认 0：与横排一样按高度 rowH，竖排字会很窄）
   *   side      显式指定材质面向（如 FrontSide：只从正面看、背面不画，贴墙的店招用）。
   *             不指定时为“双面正读”：每块字牌生成正反两片（背面那片 U 翻转），材质 FrontSide——
   *             从背后看是正字而不是镜像字（钟楼饭店楼顶立体字、塔楼顶字从反方向看的问题）
   *   maxPages  最多几页（默认 8）：一页写满自动开新页（同尺寸画布），不再丢字；超过上限才报错
   */
  constructor(ctx, W = 4096, H = 2048, opts = {}) {
    this.ctx = ctx;
    this.W = W; this.H = H;
    this.rowH = opts.rowH ?? 150;
    this.vW = opts.vW ?? 0;
    this.twoFaced = opts.side == null;
    this.side = opts.side ?? THREE.FrontSide;
    this.maxPages = opts.maxPages ?? 8;
    this.tag = opts.tag || 'skyline';
    this.pages = [];
    this.cache = new Map();
    this._page();
  }
  _page() {
    const canvas = document.createElement('canvas');
    canvas.width = this.W; canvas.height = this.H;
    const P = { canvas, g: canvas.getContext('2d'), x: 0, y: 0, row: 0, pos: [], uv: [] };
    this.pages.push(P);
    return P;
  }
  /** 渲染文字进图集，返回 {u0,v0,u1,v1,aspect,page}；超过页数上限返回 null（并报错） */
  entry(text, opts) {
    const key = text + JSON.stringify(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    const topts = { size: 110, padding: 0.12, letterSpacing: 0.06, ...opts };
    let t = this.ctx.tex.text(text, topts);
    if (RELEASED.has(t.canvas)) t = this.ctx.tex.text(text, { ...topts, _fresh: ++freshSeq }); // 未知字段只改变缓存键
    const c = t.canvas;
    let w = c.width, h = c.height;
    const k = opts?.vertical && this.vW ? Math.min(1, this.vW / w) : Math.min(1, this.rowH / h);
    w = Math.min(this.W, Math.ceil(w * k)); h = Math.min(this.H, Math.ceil(h * k));
    // 文字画布只用于拷进图集：用完即释放像素（缓存条目仍在，但只剩 1×1），否则每个条目都常驻一张全尺寸画布
    const release = () => {
      t.texture?.dispose?.();
      c.width = c.height = 1;
      RELEASED.add(c);
    };
    let pi = this.pages.length - 1, P = this.pages[pi];
    if (P.x + w > this.W) { P.x = 0; P.y += P.row + 4; P.row = 0; }
    if (P.y + h > this.H) {
      if (this.pages.length >= this.maxPages) {
        console.error(`[${this.tag}] 招牌图集 ${this.pages.length} 页已满，丢弃：`, text);
        release(); this.cache.set(key, null); return null;
      }
      P = this._page(); pi = this.pages.length - 1;
    }
    P.g.drawImage(c, P.x, P.y, w, h);
    release();
    const e = { page: pi, u0: P.x / this.W, u1: (P.x + w) / this.W, v0: 1 - (P.y + h) / this.H, v1: 1 - P.y / this.H, aspect: w / h };
    P.x += w + 4; P.row = Math.max(P.row, h);
    this.cache.set(key, e);
    return e;
  }
  /** 放一块四边形字牌：P 四角 [左下, 右下, 右上, 左上]（从正读的一侧看），e 为 entry 结果。
   *  双面正读时再加一片背面（顶点 1,0,3,2 + 同一组 UV → 从背面看 U 方向反过来，字是正的），两片各自 FrontSide 剔除 */
  quad(e, P) {
    const pg = this.pages[e.page];
    const U = [[e.u0, e.v0], [e.u1, e.v0], [e.u1, e.v1], [e.u0, e.v1]];
    for (const k of [0, 1, 2, 0, 2, 3]) { pg.pos.push(...P[k]); pg.uv.push(...U[k]); }
    if (!this.twoFaced) return;
    const B = [P[1], P[0], P[3], P[2]];
    for (const k of [0, 1, 2, 0, 2, 3]) { pg.pos.push(...B[k]); pg.uv.push(...U[k]); }
  }
  /** 在世界中放置一块文字牌：中心 p，外法线 n（水平单位向量），字高 h（米），最大宽度 maxW */
  place(text, p, nx, nz, h, maxW, opts = {}) {
    const e = this.entry(text, opts);
    if (!e) return;
    let w = h * e.aspect;
    if (maxW && w > maxW) { h *= maxW / w; w = maxW; }
    const rx = nz, rz = -nx; // 面向外看时的右方向
    const x0 = p.x - rx * w / 2, z0 = p.z - rz * w / 2, x1 = p.x + rx * w / 2, z1 = p.z + rz * w / 2;
    const y0 = p.y - h / 2, y1 = p.y + h / 2;
    const o = 0.45;
    const P = [[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]].map(([x, y, z]) => [x + nx * o, y, z + nz * o]);
    this.quad(e, P);
  }
  /** 返回 Group（每页一个网格）；没有字返回 null */
  build() {
    const used = this.pages.filter((P) => P.pos.length);
    if (!used.length) return null;
    const grp = new THREE.Group();
    grp.name = '楼顶字';
    for (const P of this.pages) {
      if (!P.pos.length) continue;
      // 最后一页往往只用了上面一部分：裁到实际用到的高度（取 256 的倍数），省显存；UV 的 v 按新高度换算
      let H = this.H, canvas = P.canvas;
      const usedH = Math.min(this.H, Math.ceil((P.y + P.row + 4) / 256) * 256);
      if (usedH < this.H) {
        const c2 = document.createElement('canvas');
        c2.width = this.W; c2.height = usedH;
        c2.getContext('2d').drawImage(P.canvas, 0, 0);
        canvas = c2; H = usedH;
        const k = this.H / H;
        for (let i = 1; i < P.uv.length; i += 2) P.uv[i] = 1 - (1 - P.uv[i]) * k;
        P.canvas.width = P.canvas.height = 1;
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      const mat = new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0, transparent: true, alphaTest: 0.08,
        roughness: 0.45, metalness: 0.1, side: this.side, depthWrite: true,
      });
      this.ctx.night.register(mat, { day: 0.06, night: 2.6 });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(P.uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.name = '楼顶字';
      grp.add(m);
    }
    if (used.length > 1) console.info(`[${this.tag}] 招牌图集 ${used.length} 页`);
    return grp;
  }
}

// ---------- 航空障碍灯 / 泛光点：一个 Points 绘制 ----------
export class Beacons {
  constructor(ctx) { this.ctx = ctx; this.P = []; this.A = []; }
  /** kind: 0 红色闪光（楼顶） 1 红色常亮（中段） 2 白色闪光（电视塔桅杆顶） */
  add(x, y, z, kind = 0, size = 5) { this.P.push(x, y, z); this.A.push(kind, Math.random(), size); }
  build() {
    const ctx = this.ctx;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.A, 3));
    this.uScale = { value: 500 };
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: ctx.uniforms.uTime, uNight: ctx.uniforms.uNight, uScale: this.uScale },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aInfo; uniform float uTime; uniform float uNight; uniform float uScale;
        varying vec3 vCol; varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float kind = aInfo.x;
          // 中光强航空障碍灯：约 40 次/分，楼顶同步闪
          float ph = kind < 0.5 ? fract(uTime * 0.667) : fract(uTime * 0.8 + aInfo.y * 0.1);
          float on = kind > 0.5 && kind < 1.5 ? 1.0 : smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.28, 0.42, ph));
          vCol = kind > 1.5 ? vec3(1.0, 0.95, 0.9) : vec3(1.0, 0.06, 0.03);
          float day = 1.0 - uNight;
          vA = on * mix(1.0, 0.35, day) * (kind > 0.5 && kind < 1.5 ? 0.7 : 1.0);
          float dist = max(1.0, -mv.z);
          // 光晕直径按 aInfo.z 米的 45% 计（原来按整米数，近看一盏灯有一层楼高的大红球），屏幕上最大 12 px
          float sz = aInfo.z * 0.45 * uScale / dist;
          // 远距离衰减：亚像素灯点按 (像素尺寸/2.2)^0.6 减亮，6 km 起整体减弱、14 km 外不可见——
          // 否则从低机位远看，成片塔楼的障碍灯会在地平线上叠成红色光团再被泛光放大
          float fade = 1.0 - smoothstep(6000.0, 14000.0, dist);
          vA *= fade * fade * min(1.0, pow(max(sz, 0.01) / 2.2, 0.6) + 0.1);
          gl_PointSize = clamp(sz, 2.2, 12.0) * (0.6 + 0.4 * uNight);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <logdepthbuf_pars_fragment>
        varying vec3 vCol; varying float vA;
        void main(){
          #include <logdepthbuf_fragment>
          vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0;
          float core = 1.0 - smoothstep(0.0, 0.35, r); float halo = 1.0 - smoothstep(0.2, 1.0, r);
          float a = (core * 1.0 + halo * 0.35) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vCol * (core * 7.0 + halo * 1.2), a);
        }`,
      // 取最大值混合（WebGL2 原生 MAX）：同一像素里叠多少盏灯只取最亮的一盏，不会越叠越亮；单盏灯的观感与加色混合一致
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    pts.name = '航空障碍灯';
    return pts;
  }
  update(renderer, camera) {
    if (!this.uScale) return;
    const h = renderer.domElement.height || 800;
    this.uScale.value = (h * 0.5) * camera.projectionMatrix.elements[5];
  }
}

// ---------- 共享实体材质 ----------
export function solidMats(ctx) {
  const T = ctx.tex;
  const heli = (() => {
    const c = T.canvas(512);
    const g = c.getContext('2d');
    g.fillStyle = '#2d3a33'; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#e8e2d0'; g.lineWidth = 18;
    g.beginPath(); g.arc(256, 256, 200, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#e0b43a'; g.lineWidth = 8;
    g.beginPath(); g.arc(256, 256, 232, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#eeeae0'; g.font = 'bold 250px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('H', 256, 268);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  })();
  const m = {
    roof: ctx.mats.clone('concrete', { color: 0x8d8a84, roughness: 0.9 }),
    parapet: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.35 }),
    metal: ctx.mats.get('metalGray'),
    white: new THREE.MeshStandardMaterial({ color: 0xd9dadb, metalness: 0.35, roughness: 0.4 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.5, roughness: 0.5 }),
    heli: new THREE.MeshStandardMaterial({ map: heli, roughness: 0.8 }),
    stone: ctx.mats.clone('marble', { color: 0xd8d0c0, roughness: 0.7 }),
    granite: ctx.mats.clone('stonePaving', { color: 0xb9b4aa, roughness: 0.85 }),
    roofTile: ctx.mats.get('roofGray'),
    glassRoof: new THREE.MeshPhysicalMaterial({ color: 0x9fb4c2, metalness: 0.6, roughness: 0.12, envMapIntensity: 1.2 }),
    membrane: new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, emissive: 0xffd9c4, emissiveIntensity: 0 }),
    grass: ctx.mats.get('grass'),
    yellow: new THREE.MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.6, metalness: 0.3 }),
    track: new THREE.MeshStandardMaterial({ color: 0x9a3a2c, roughness: 0.9 }),
    seats: new THREE.MeshStandardMaterial({ color: 0x5b6e84, roughness: 0.8 }),
    lampWarm: ctx.mats.get('lampWarm'),
    ledBlue: new THREE.MeshStandardMaterial({ color: 0xaab4bf, emissive: 0x6fa8ff, emissiveIntensity: 0, roughness: 0.5 }),
    ledRed: new THREE.MeshStandardMaterial({ color: 0x8a2a2a, emissive: 0xff3a2a, emissiveIntensity: 0, roughness: 0.5 }),
  };
  ctx.night.register(m.membrane, { day: 0, night: 0.9 });
  ctx.night.register(m.ledBlue, { day: 0, night: 3.2 });
  ctx.night.register(m.ledRed, { day: 0.05, night: 3.0 });
  return m;
}

/** 轮廓下最低地面高度 */
export function groundMin(ctx, pts) {
  let m = Infinity;
  const c = G.centroid(pts);
  m = Math.min(m, ctx.terrain.heightAt(c.x, c.z));
  for (let i = 0; i < pts.length; i += 2) m = Math.min(m, ctx.terrain.heightAt(pts[i], pts[i + 1]));
  return m;
}

function longestEdges(poly, k = 2) {
  const n = poly.length / 2, e = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    e.push({ i, L: Math.hypot(poly[j * 2] - poly[i * 2], poly[j * 2 + 1] - poly[i * 2 + 1]) });
  }
  e.sort((a, b) => b.L - a.L);
  return e.slice(0, k).map((x) => x.i);
}
function edgeInfo(poly, i) {
  const n = poly.length / 2, j = (i + 1) % n;
  const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
  const L = Math.hypot(bx - ax, bz - az) || 1;
  return { mx: (ax + bx) / 2, mz: (az + bz) / 2, nx: (bz - az) / L, nz: -(bx - ax) / L, L };
}

/**
 * 构建一栋塔楼。env: {ctx, fb, solid(Batcher), detail(Batcher), mats, signs, beacons}
 * spec 见 sky-data.js
 */
export function buildTower(env, spec) {
  const { ctx, fb, solid, detail, mats, signs, beacons } = env;
  const pts = G.ccw(spec.pts);
  const base = spec.base ?? groundMin(ctx, spec.podium ? spec.podium.pts.concat(pts) : pts);
  const c = G.centroid(pts);
  const H = spec.h;
  const st = mkStyle(spec.style || {});
  const crownH = spec.crown ? spec.crown.h : 0;
  const drop = spec.slope ? spec.slope.drop : 0;
  const taper = spec.taper ?? 1;
  const sAt = (y) => 1 - (1 - taper) * Math.min(1, Math.max(0, y / H));
  const at = (poly, y) => (taper !== 1 ? G.scaleAbout(poly, c.x, c.z, sAt(y)) : poly);
  const topF = H - crownH - drop; // 最高楼层顶
  // 斜顶：沿 dir 方向，最低处 H-drop、最高处 H
  let yTopFn = null;
  if (spec.slope) {
    const [dx, dz] = spec.slope.dir, dl = Math.hypot(dx, dz);
    let r = 0;
    for (let i = 0; i < pts.length; i += 2) r = Math.max(r, Math.abs(((pts[i] - c.x) * dx + (pts[i + 1] - c.z) * dz) / dl));
    yTopFn = (x, z) => base + H - drop * (0.5 - 0.5 * (((x - c.x) * dx + (z - c.z) * dz) / dl / r));
  }
  // —— 分段 ——
  const tiers = (spec.tiers || [{ to: topF, inset: 0 }]).map((t) => ({ ...t, to: t.to <= 1.001 ? t.to * topF : t.to }));
  let y0 = -3, prevPoly = null;
  for (let k = 0; k < tiers.length; k++) {
    const t = tiers[k];
    const poly = G.inset(pts, t.inset || 0);
    const s = t.style ? mkStyle({ ...spec.style, ...t.style }) : st;
    const b = at(poly, Math.max(0, y0)), tp = at(poly, t.to);
    if (prevPoly && (t.inset || 0) !== (tiers[k - 1].inset || 0)) {
      // 退台挑檐
      solid.add(G.annulus(at(prevPoly, y0), b, base + y0 + 0.02), mats.parapet);
    }
    fb.ring(b, tp, base + y0, base + t.to, s, { vBase: base });
    prevPoly = poly;
    y0 = t.to;
  }
  const lastInset = tiers[tiers.length - 1].inset || 0;
  // —— 塔冠 ——
  let slopeTop = null, slopeY = null; // 斜顶无塔冠时的顶轮廓与斜面高度函数
  const crownPoly = G.inset(pts, lastInset + (spec.crown?.inset || 0));
  const cb = at(crownPoly, topF);
  if (spec.crown) {
    const cs = mkStyle({ ...spec.style, mode: 4, floorH: crownH + drop, spandrel: 0, lit: 0, mullW: spec.crown.mullW ?? 0.14, colW: spec.crown.colW ?? st.colW * 2, spd: spec.crown.color || '#ffe2b8', tint: spec.crown.tint || spec.style?.tint });
    const ct = at(crownPoly, topF + crownH);
    if (spec.crown.inset) solid.add(G.annulus(at(prevPoly, topF), cb, base + topF + 0.02), mats.parapet);
    fb.ring(cb, ct, base + topF, yTopFn || base + topF + crownH, cs, { vLocal: true });
    // 塔冠顶檐（厚金属环）
    const rim = G.inset(ct, -0.6);
    solid.add(G.wallGeometry(rim, rim, yTopFn ? (x, z) => yTopFn(x, z) - 1.2 : base + topF + crownH - 1.2, yTopFn || base + topF + crownH), mats.parapet);
    solid.add(G.annulus(rim, G.inset(ct, 1.0), yTopFn || base + topF + crownH), mats.parapet);
    // 屋面：略低于顶檐的平/斜屋面
    const roofY = yTopFn ? (x, z) => yTopFn(x, z) - 3.5 : base + topF + crownH - 3.5;
    solid.add(G.capGeometry(G.inset(ct, 0.4), roofY), mats.dark);
  } else if (yTopFn) {
    // 斜顶、无塔冠（W 酒店 / 万众国际）：幕墙按原立面一直升到斜面，斜面从 H-drop+LIFT（低侧）到 H（高侧）；
    // 顶点高度与该高度处的收分互相依赖，迭代求一个过顶轮廓的斜平面 slopeY。
    // 斜面最低点比末层顶（topF = H-drop）高 LIFT：否则最低顶点的上下沿重合，fb.ring 用 e1×(top-bot) 求面法线会得零向量
    // （该四边形另一三角形面积不为零，着色器 normalize 零向量 → NaN 光照）
    const LIFT = 0.1, dropE = drop - LIFT;
    const [sdx, sdz] = spec.slope.dir, sdl = Math.hypot(sdx, sdz);
    const proj = (x, z) => ((x - c.x) * sdx + (z - c.z) * sdz) / sdl;
    const n = prevPoly.length / 2;
    const ys = new Array(n).fill(H - dropE * 0.5);
    let top = null, p0 = 0, p1 = 1;
    for (let it = 0; it < 8; it++) {
      top = [];
      for (let i = 0; i < n; i++) {
        const s = taper !== 1 ? sAt(ys[i]) : 1;
        top.push(c.x + (prevPoly[i * 2] - c.x) * s, c.z + (prevPoly[i * 2 + 1] - c.z) * s);
      }
      p0 = Infinity; p1 = -Infinity;
      for (let i = 0; i < n; i++) { const q = proj(top[i * 2], top[i * 2 + 1]); p0 = Math.min(p0, q); p1 = Math.max(p1, q); }
      for (let i = 0; i < n; i++) ys[i] = H - dropE * (p1 - proj(top[i * 2], top[i * 2 + 1])) / Math.max(1e-6, p1 - p0);
    }
    const P0 = p0, PL = Math.max(1e-6, p1 - p0);
    slopeY = (x, z) => base + H - dropE * (P0 + PL - proj(x, z)) / PL;
    slopeTop = top;
    const lt = tiers[tiers.length - 1];
    const ls = lt.style ? mkStyle({ ...spec.style, ...lt.style }) : st;
    fb.ring(at(prevPoly, topF), top, base + topF, slopeY, ls, { vBase: base });
    // 随坡金属檐口 + 斜玻璃屋面
    const par = spec.roof?.parapet ?? 0.9;
    const up = (d) => (x, z) => slopeY(x, z) + d;
    const ti = G.inset(top, 0.35);
    solid.add(G.wallGeometry(top, top, slopeY, up(par)), mats.parapet);
    solid.add(G.wallGeometry(ti, ti, up(par), up(0.1)), mats.parapet);
    solid.add(G.annulus(top, ti, up(par)), mats.parapet);
    solid.add(G.capGeometry(ti, up(0.1)), mats.glassRoof || mats.roof);
  } else {
    // 女儿墙 + 屋面
    const par = spec.roof?.parapet ?? 1.4;
    const tp = at(prevPoly, topF);
    solid.add(G.wallGeometry(tp, tp, base + topF, base + topF + par), mats.parapet);
    solid.add(G.capGeometry(G.inset(tp, 0.35), base + topF + 0.1), mats.roof);
    solid.add(G.wallGeometry(G.inset(tp, 0.35), G.inset(tp, 0.35), base + topF + par, base + topF + 0.1), mats.parapet);
  }
  // —— 屋顶设备 / 停机坪 / 避雷针 ——
  const roofTop = spec.crown ? base + topF + crownH - 3.5 - (spec.slope ? drop : 0) : base + topF;
  const rpoly = slopeTop || at(crownPoly, topF);
  const rb = G.bbox(rpoly);
  const rw = rb.x1 - rb.x0, rd = rb.z1 - rb.z0;
  if (spec.roof?.mech !== false && !spec.slope) {
    const mw = Math.min(rw, rd) * 0.42;
    detail.add(G.box(c.x, roofTop + 2.6, c.z, mw, 5.2, mw * 0.8), mats.roof, null, { worldUV: 1 });
    detail.add(G.box(c.x + mw * 0.2, roofTop + 5.8, c.z - mw * 0.1, mw * 0.4, 1.2, mw * 0.3), mats.metal);
    for (let k = 0; k < 3; k++) detail.add(G.cyl(c.x - mw * 0.35 + k * mw * 0.3, roofTop + 5.2, c.z + mw * 0.55, 1.4, 1.4, 1.6, 10), mats.metal);
  }
  if (spec.roof?.helipad) {
    const hr = Math.min(rw, rd) * 0.36;
    const hy = roofTop + (spec.roof.helipadY ?? 6.5);
    const disk = new THREE.CircleGeometry(hr, 40);
    disk.rotateX(-Math.PI / 2);
    disk.translate(c.x, hy + 0.35, c.z);
    solid.add(disk, mats.heli);
    solid.add(G.cyl(c.x, hy - 0.4, c.z, hr + 0.3, hr + 0.3, 0.75, 40), mats.white);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      detail.add(G.cyl(c.x + Math.cos(a) * hr * 0.7, roofTop, c.z + Math.sin(a) * hr * 0.7, 0.35, 0.35, hy - roofTop, 6), mats.metal);
    }
    // 停机坪边灯（绿色常亮用暖灯代替）
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      detail.add(G.box(c.x + Math.cos(a) * hr, hy + 0.5, c.z + Math.sin(a) * hr, 0.3, 0.3, 0.3), mats.lampWarm);
    }
  }
  const topY = spec.slope ? base + H : roofTop + (spec.roof?.helipad ? (spec.roof.helipadY ?? 6.5) : 6);
  if (spec.roof?.spire) {
    const sh = spec.roof.spire;
    const sx = spec.roof.spireAt ? spec.roof.spireAt[0] : c.x, sz = spec.roof.spireAt ? spec.roof.spireAt[1] : c.z;
    detail.add(G.cyl(sx, topY - 2, sz, 1.1, 0.25, sh + 2, 8), mats.metal);
    beacons.add(sx, topY + sh, sz, 0, 6);
  }
  // 屋顶四角障碍灯
  if (H > 60) {
    const corners = [];
    const n = rpoly.length / 2;
    const cand = [];
    for (let i = 0; i < n; i++) cand.push([rpoly[i * 2], rpoly[i * 2 + 1]]);
    // 取距中心最远的 4 个且彼此分散
    cand.sort((a, b) => Math.hypot(b[0] - c.x, b[1] - c.z) - Math.hypot(a[0] - c.x, a[1] - c.z));
    for (const p of cand) {
      if (corners.length >= 4) break;
      if (corners.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > Math.min(rw, rd) * 0.5)) corners.push(p);
    }
    const cy = spec.crown ? (yTopFn ? null : base + topF + crownH + 0.6) : slopeY ? null : base + topF + 1.8;
    for (const [x, z] of corners) beacons.add(x, cy ?? (slopeY || yTopFn)(x, z) + (slopeY ? 1.2 : 0.6), z, 0, H > 150 ? 5 : 3.5);
    if (H > 150) for (const [x, z] of corners.slice(0, 2)) beacons.add(x, base + H * 0.5, z, 1, 2.5);
  }
  // —— 楼顶字 ——
  for (const sg of spec.signs || []) {
    const poly = sg.poly ? G.ccw(sg.poly) : at(sg.onCrown === false ? prevPoly : crownPoly, sg.y ?? topF + crownH * 0.5);
    const faces = sg.faces === 'all' ? [...Array(poly.length / 2).keys()] : Array.isArray(sg.faces) ? sg.faces : longestEdges(poly, sg.faces || 2);
    const y = base + (sg.y ?? (spec.crown ? topF + crownH * 0.5 : topF - 3));
    for (const i of faces) {
      const e = edgeInfo(poly, i);
      if (e.L < 6) continue;
      signs.place(sg.text, { x: e.mx, y, z: e.mz }, e.nx, e.nz, sg.h || 6, e.L * (sg.fill ?? 0.8), { color: sg.color || '#ffffff', weight: 800, serif: !!sg.serif, glow: sg.glow || null });
    }
  }
  // —— 裙房 ——
  if (spec.podium) buildPodium(env, { ...spec.podium, base });
  return { base, top: base + H, c };
}

/** 带洞多边形顶盖（outer CCW，holes 任意方向），朝上，非索引 */
function capWithHoles(outer, holes, y) {
  const V = (p) => { const o = []; for (let i = 0; i < p.length; i += 2) o.push(new THREE.Vector2(p[i], p[i + 1])); return o; };
  const contour = V(outer), hv = holes.map(V);
  const tris = THREE.ShapeUtils.triangulateShape(contour, hv);
  const all = contour.concat(...hv), pos = [];
  for (const t of tris) {
    const a = all[t[0]], b = all[t[1]], c = all[t[2]];
    const up = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y) > 0;
    for (const k of up ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]]) pos.push(all[k].x, y, all[k].y);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** 裙房/商场：幕墙体 + 屋面 + 女儿墙 + 招牌；p.holes（可选）：内院轮廓（院内立面 + 女儿墙，屋面挖空） */
export function buildPodium(env, p) {
  const { ctx, fb, solid, detail, mats, signs } = env;
  const pts = G.ccw(p.pts);
  const base = p.base ?? groundMin(ctx, pts);
  const st = mkStyle({ mode: 6, floorH: 5.5, colW: 3.0, spandrel: 0.3, mullW: 0.18, lit: 0.9, tint: '#3a4650', spd: '#b8b1a4', ...(p.style || {}) });
  fb.prism(pts, base - 3, base + p.h, st, { vBase: base });
  const par = 1.2;
  solid.add(G.wallGeometry(pts, pts, base + p.h, base + p.h + par), mats.parapet);
  const inn = G.inset(pts, 0.4);
  solid.add(G.wallGeometry(inn, inn, base + p.h + par, base + p.h + 0.05), mats.parapet);
  if (p.holes?.length) {
    // 内院轮廓取顺时针：外法线 (dz,-dx) 指向院内，立面/女儿墙外侧朝院内；G.inset 对顺时针轮廓向院外（屋面一侧）偏移
    const holeIn = [];
    for (const h0 of p.holes) {
      const c = G.ccw(h0), h = [];
      for (let i = c.length - 2; i >= 0; i -= 2) h.push(c[i], c[i + 1]);
      fb.prism(h, base - 3, base + p.h, st, { vBase: base });
      solid.add(G.wallGeometry(h, h, base + p.h, base + p.h + par), mats.parapet);
      const hi = G.inset(h, 0.4);
      solid.add(G.wallGeometry(hi, hi, base + p.h + par, base + p.h + 0.05), mats.parapet);
      holeIn.push(hi);
    }
    solid.add(capWithHoles(inn, holeIn, base + p.h + 0.05), p.roofMat || mats.roof);
  } else {
    solid.add(G.capGeometry(inn, base + p.h + 0.05), p.roofMat || mats.roof);
  }
  for (const sg of p.signs || []) {
    const faces = Array.isArray(sg.faces) ? sg.faces : longestEdges(pts, sg.faces || 1);
    for (const i of faces) {
      const e = edgeInfo(pts, i);
      signs.place(sg.text, { x: e.mx, y: base + (sg.y ?? p.h - (sg.h || 4) * 0.7), z: e.mz }, e.nx, e.nz, sg.h || 4, e.L * 0.85, { color: sg.color || '#ffffff', weight: 800, glow: sg.glow || null, bg: sg.bg || null });
    }
  }
  return base;
}

export { Batcher };
