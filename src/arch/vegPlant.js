// 城市植被：种植点生成（纯计算，Web Worker 与主线程回退共用；不依赖 DOM / three）。
//
// 输入：roads / landuse / water / rail（ctx.data 原样）、buildings.bin（ArrayBuffer）、
//       树木排除区（多边形列表）、城墙中心线/马面/城门（landmarks.json）。
// 输出：按 200 m 渲染块排序的树木 SoA 数组 + 绿篱段数组（见 plantVegetation 返回值）。
//
// 方法：
//  1. 在种植区（钟楼周边约 27 km 见方）上建 3 m 栅格位图：建筑（B）、道路/铁路/高架（R）、水面（W）、已种树（T）。
//  2. 行道树：沿 trunk~tertiary / residential / unclassified / pedestrian 道路两侧，偏移 = 半路宽 + 树池距，
//     间距 6.5~8.5 m；单行道左侧（中央分隔带）够宽时种一排分隔带树 + 绿篱。同名道路统一树种
//     （友谊路/含光路/咸宁路/太白路 = 法国梧桐；雁塔西路 = 银杏“黄金大道”；其余按名称散列：国槐为主）。
//  3. 环城公园：城墙外侧 14 m 起到护城河之间逐排加密种植，河岸 7 m 内为垂柳；城墙内侧顺城巷一排。
//  4. 水岸：湖/河/护城河/池塘岸线外 3~10 m 种垂柳为主。
//  5. 用地：公园 / 林地 / 草地 / 校园 / 居住区 / 墓地等按密度 + 60 m 尺度的团簇噪声撒点（有林、有草坪空地）。
//  所有点都要避开：建筑（带 2~3.5 m 净距）、路面、水面、排除区、城墙本体/马面/瓮城、已种的树。
//  远离市中心（> 6.5 km）按距离递减密度。

// 树种编号（与 vegSpecies.js 的 SP 一致）
const HUAI = 0, WUTONG = 1, XUESONG = 2, LIU = 3, YINXING = 4, SHILIU = 5, GUANMU = 6;

export const VEG_REGION = { x0: -13200, x1: 14400, z0: -13500, z1: 14100 };
export const VEG_CHUNK = 200;
const CELL = 3;
const CENTER_X = 300, CENTER_Z = 900;
const MAX_TREES = 650000;

// —— 随机 ——
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashI(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 144269507)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hashI(ix, iz, seed), b = hashI(ix + 1, iz, seed), c = hashI(ix, iz + 1, seed), d = hashI(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
function pick(mix, r) {
  // mix: [[species, weight], ...]（权重和为 1）
  let acc = 0;
  for (const [s, w] of mix) if (r < (acc += w)) return s;
  return mix[mix.length - 1][0];
}

// —— 位图 ——
class Bits {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.a = new Uint32Array(Math.ceil((w * h) / 32));
  }
  set(i, j) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return;
    const k = j * this.w + i;
    this.a[k >>> 5] |= 1 << (k & 31);
  }
  get(i, j) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 1;
    const k = j * this.w + i;
    return (this.a[k >>> 5] >>> (k & 31)) & 1;
  }
}

/** 解析 buildings.bin（v1/v2） */
function parseBuildings(buf) {
  if (!buf || buf.byteLength < 16) return null;
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'XBLD') return null;
  const ver = dv.getUint32(4, true), n = dv.getUint32(8, true), tv = dv.getUint32(12, true);
  let o = 16;
  const ax = new Float32Array(buf, o, n); o += 4 * n;
  const az = new Float32Array(buf, o, n); o += 4 * n;
  const vs = new Uint32Array(buf, o, n); o += 4 * n;
  const vc = new Uint16Array(buf, o, n); o += 2 * n;
  const hd = new Uint16Array(buf, o, n); o += 2 * n;
  const mh = new Uint16Array(buf, o, n); o += 2 * n;
  const kind = new Uint8Array(buf, o, n); o += n;
  o += n; // flags
  if (ver >= 2) o += n; // style
  o = (o + 3) & ~3;
  const offs = new Int16Array(buf, o, tv * 2);
  return { n, ax, az, vs, vc, hd, mh, kind, offs };
}

export function plantVegetation(input) {
  const t0 = Date.now();
  const R = VEG_REGION;
  const GW = Math.ceil((R.x1 - R.x0) / CELL), GH = Math.ceil((R.z1 - R.z0) / CELL);
  const B = new Bits(GW, GH), RD = new Bits(GW, GH), W = new Bits(GW, GH), T = new Bits(GW, GH);
  const ci = (x) => Math.floor((x - R.x0) / CELL);
  const cj = (z) => Math.floor((z - R.z0) / CELL);
  const inRegion = (x, z) => x > R.x0 + 20 && x < R.x1 - 20 && z > R.z0 + 20 && z < R.z1 - 20;

  // —— 多边形扫描线填充（格心在内即置位；环可带洞，奇偶规则） ——
  function fillRings(bits, rings, edges) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of rings)
      for (let i = 0; i < p.length; i += 2) {
        const x = p[i], z = p[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    if (x1 < R.x0 || x0 > R.x1 || z1 < R.z0 || z0 > R.z1) return;
    const j0 = Math.max(0, Math.ceil((z0 - R.z0) / CELL - 0.5)), j1 = Math.min(GH - 1, Math.floor((z1 - R.z0) / CELL - 0.5));
    if (j1 < j0) {
      if (edges) for (const p of rings) strokeRing(bits, p);
      return;
    }
    const rows = new Array(j1 - j0 + 1);
    for (const p of rings) {
      const n = p.length / 2;
      for (let k = 0; k < n; k++) {
        const xa = p[k * 2], za = p[k * 2 + 1];
        const kb = (k + 1) % n;
        const xb = p[kb * 2], zb = p[kb * 2 + 1];
        if (za === zb) continue;
        const lo = Math.min(za, zb), hi = Math.max(za, zb);
        const ja = Math.max(j0, Math.ceil((lo - R.z0) / CELL - 0.5)), jb = Math.min(j1, Math.ceil((hi - R.z0) / CELL - 0.5) - 1);
        for (let j = ja; j <= jb; j++) {
          const zc = R.z0 + (j + 0.5) * CELL;
          const x = xa + ((zc - za) * (xb - xa)) / (zb - za);
          (rows[j - j0] || (rows[j - j0] = [])).push(x);
        }
      }
    }
    for (let r = 0; r < rows.length; r++) {
      const xs = rows[r];
      if (!xs || xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const j = j0 + r;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const ia = Math.max(0, Math.ceil((xs[k] - R.x0) / CELL - 0.5)), ib = Math.min(GW - 1, Math.floor((xs[k + 1] - R.x0) / CELL - 0.5));
        for (let i = ia; i <= ib; i++) bits.set(i, j);
      }
    }
    if (edges) for (const p of rings) strokeRing(bits, p);
  }
  function strokeRing(bits, p) {
    const n = p.length / 2;
    for (let k = 0; k < n; k++) {
      const kb = (k + 1) % n;
      strokeSeg(bits, p[k * 2], p[k * 2 + 1], p[kb * 2], p[kb * 2 + 1]);
    }
  }
  function strokeSeg(bits, xa, za, xb, zb) {
    const L = Math.hypot(xb - xa, zb - za);
    const n = Math.max(1, Math.ceil(L / (CELL * 0.7)));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      bits.set(ci(xa + (xb - xa) * t), cj(za + (zb - za) * t));
    }
  }
  /** 胶囊（线段 + 半宽）盖章 */
  function stampCapsule(bits, xa, za, xb, zb, hw) {
    const L = Math.hypot(xb - xa, zb - za);
    if (L > 24) {
      const n = Math.ceil(L / 20);
      for (let s = 0; s < n; s++)
        stampCapsule(bits, xa + ((xb - xa) * s) / n, za + ((zb - za) * s) / n, xa + ((xb - xa) * (s + 1)) / n, za + ((zb - za) * (s + 1)) / n, hw);
      return;
    }
    const x0 = Math.min(xa, xb) - hw, x1 = Math.max(xa, xb) + hw, z0 = Math.min(za, zb) - hw, z1 = Math.max(za, zb) + hw;
    if (x1 < R.x0 || x0 > R.x1 || z1 < R.z0 || z0 > R.z1) return;
    const i0 = Math.max(0, ci(x0)), i1 = Math.min(GW - 1, ci(x1)), j0 = Math.max(0, cj(z0)), j1 = Math.min(GH - 1, cj(z1));
    const dx = xb - xa, dz = zb - za, l2 = dx * dx + dz * dz || 1e-6;
    const hw2 = hw * hw;
    for (let j = j0; j <= j1; j++) {
      const zc = R.z0 + (j + 0.5) * CELL;
      for (let i = i0; i <= i1; i++) {
        const xc = R.x0 + (i + 0.5) * CELL;
        let t = ((xc - xa) * dx + (zc - za) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = xa + dx * t - xc, ez = za + dz * t - zc;
        if (ex * ex + ez * ez <= hw2) bits.set(i, j);
      }
    }
  }
  const blocked = (bits, x, z) => bits.get(ci(x), cj(z));
  /** 以 r 为半径的 8 方向探针 + 中心：任一命中返回 true */
  function nearAny(bits, x, z, r) {
    if (bits.get(ci(x), cj(z))) return true;
    if (r <= 0) return false;
    const d = r * 0.7071;
    return (
      bits.get(ci(x + r), cj(z)) || bits.get(ci(x - r), cj(z)) || bits.get(ci(x), cj(z + r)) || bits.get(ci(x), cj(z - r)) ||
      bits.get(ci(x + d), cj(z + d)) || bits.get(ci(x - d), cj(z + d)) || bits.get(ci(x + d), cj(z - d)) || bits.get(ci(x - d), cj(z - d))
    ) === 1;
  }

  // —— 1. 建筑 ——
  const bd = parseBuildings(input.buildings);
  let nb = 0;
  if (bd) {
    const ring = [];
    for (let b = 0; b < bd.n; b++) {
      const ax = bd.ax[b], az = bd.az[b];
      if (!inRegion(ax, az)) continue;
      if (bd.mh[b] > 45) continue; // 悬空的 building:part
      const s = bd.vs[b], c = bd.vc[b];
      if (c < 3) continue;
      ring.length = 0;
      for (let k = 0; k < c; k++) ring.push(ax + bd.offs[(s + k) * 2] * 0.1, az + bd.offs[(s + k) * 2 + 1] * 0.1);
      fillRings(B, [ring], true);
      nb++;
    }
  }

  // —— 2. 道路 / 铁路 / 水面 ——
  const MINW = [7.5, 7, 7, 6.5, 6, 5, 3.5, 5, 4.5, 4.5, 4.5, 4, 4, 2];
  const roadW = (f) => {
    const c = f.c | 0;
    const lanes = Math.max(1, Math.min(8, f.l | 0 || 1));
    let w = Number(f.w) || MINW[c] || 5;
    if (c !== 12 && c !== 13) w = Math.max(w, MINW[c] || 5, lanes * (c <= 2 ? 3.4 : 3.1));
    return Math.min(w, 42);
  };
  const feats = input.roads?.features || [];
  for (const f of feats) {
    if (f.t) continue;
    const p = f.p;
    if (!p || p.length < 4) continue;
    const hw = roadW(f) / 2 + (f.b ? 2.5 : 0.3);
    for (let i = 0; i + 3 < p.length; i += 2) stampCapsule(RD, p[i], p[i + 1], p[i + 2], p[i + 3], hw);
  }
  // 矢量道路索引（行道树/绿篱用精确距离判断，避免 3 m 栅格量化把树池也判成路面）
  const SEGC = 40;
  const segGrid = new Map();
  const segArr = [];
  for (const f of feats) {
    if (f.t) continue;
    const c = f.c | 0;
    if (c === 6 || c === 12 || c === 13) continue; // 人行道/步行街/辅路：行道树允许种在其上
    const p = f.p;
    if (!p || p.length < 4) continue;
    const hw = roadW(f) / 2 + (f.b ? 1.5 : 0);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const xa = p[i], za = p[i + 1], xb = p[i + 2], zb = p[i + 3];
      if (!inRegion(xa, za) && !inRegion(xb, zb)) continue;
      const id = segArr.length / 5;
      segArr.push(xa, za, xb, zb, hw);
      const e = hw + 3;
      for (let cx = Math.floor((Math.min(xa, xb) - e) / SEGC); cx <= Math.floor((Math.max(xa, xb) + e) / SEGC); cx++)
        for (let cz = Math.floor((Math.min(za, zb) - e) / SEGC); cz <= Math.floor((Math.max(za, zb) + e) / SEGC); cz++) {
          const k = cx * 100003 + cz;
          let l = segGrid.get(k);
          if (!l) segGrid.set(k, (l = []));
          l.push(id);
        }
    }
  }
  /** 点到任一车行道边缘距离 < margin（margin ≤ 3） */
  const roadHit = (x, z, margin) => {
    const l = segGrid.get(Math.floor(x / SEGC) * 100003 + Math.floor(z / SEGC));
    if (!l) return false;
    for (const id of l) {
      const o = id * 5;
      const xa = segArr[o], za = segArr[o + 1], dx = segArr[o + 2] - xa, dz = segArr[o + 3] - za;
      let t = ((x - xa) * dx + (z - za) * dz) / (dx * dx + dz * dz || 1e-6);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = xa + dx * t - x, ez = za + dz * t - z;
      const r = segArr[o + 4] + margin;
      if (ex * ex + ez * ez < r * r) return true;
    }
    return false;
  };
  for (const f of input.rail?.features || []) {
    if (f.t) continue;
    const p = f.p;
    if (!p || p.length < 4) continue;
    for (let i = 0; i + 3 < p.length; i += 2) stampCapsule(RD, p[i], p[i + 1], p[i + 2], p[i + 3], 5);
  }
  const water = input.water || {};
  for (const w of water.polys || []) {
    if (!w.outer || w.outer.length < 6) continue;
    fillRings(W, [w.outer, ...(w.holes || [])], false);
  }
  for (const l of water.lines || []) {
    const p = l.p;
    if (!p || p.length < 4) continue;
    const hw = Math.max(2, (l.w || 8) / 2);
    for (let i = 0; i + 3 < p.length; i += 2) stampCapsule(W, p[i], p[i + 1], p[i + 2], p[i + 3], hw);
  }

  // —— 3. 排除区（树木） ——
  const EXC = 500;
  const exGrid = new Map();
  for (const it of input.exclusions || []) {
    const p = it.p;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
    }
    const e = { p, x0, x1, z0, z1 };
    for (let cx = Math.floor(x0 / EXC); cx <= Math.floor(x1 / EXC); cx++)
      for (let cz = Math.floor(z0 / EXC); cz <= Math.floor(z1 / EXC); cz++) {
        const k = cx * 100003 + cz;
        if (!exGrid.has(k)) exGrid.set(k, []);
        exGrid.get(k).push(e);
      }
  }
  const pip = (x, z, p) => {
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const excluded = (x, z) => {
    const list = exGrid.get(Math.floor(x / EXC) * 100003 + Math.floor(z / EXC));
    if (!list) return false;
    for (const e of list) if (x >= e.x0 && x <= e.x1 && z >= e.z0 && z <= e.z1 && pip(x, z, e.p)) return true;
    return false;
  };

  // —— 城墙：本体 / 马面 / 瓮城 ——
  const wall = input.wall || [];
  const WC = 60;
  const wallGrid = new Map();
  const wallSegs = [];
  for (let i = 0; i < wall.length; i++) {
    const a = wall[i], b = wall[(i + 1) % wall.length];
    const s = [a[0], a[1], b[0], b[1]];
    wallSegs.push(s);
    for (let cx = Math.floor((Math.min(a[0], b[0]) - 30) / WC); cx <= Math.floor((Math.max(a[0], b[0]) + 30) / WC); cx++)
      for (let cz = Math.floor((Math.min(a[1], b[1]) - 30) / WC); cz <= Math.floor((Math.max(a[1], b[1]) + 30) / WC); cz++) {
        const k = cx * 100003 + cz;
        if (!wallGrid.has(k)) wallGrid.set(k, []);
        wallGrid.get(k).push(s);
      }
  }
  const wallDist = (x, z) => {
    const list = wallGrid.get(Math.floor(x / WC) * 100003 + Math.floor(z / WC));
    if (!list) return 1e9;
    let best = 1e18;
    for (const s of list) {
      const dx = s[2] - s[0], dz = s[3] - s[1];
      let t = ((x - s[0]) * dx + (z - s[1]) * dz) / (dx * dx + dz * dz || 1);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = s[0] + dx * t - x, ez = s[1] + dz * t - z;
      best = Math.min(best, ex * ex + ez * ez);
    }
    return Math.sqrt(best);
  };
  const mamian = (input.mamian || []).map((m) => m.center_on_centerline);
  const gates = (input.gates || []).map((g) => [g.world.x, g.world.z, g.check_half >= 100 ? 88 : 30]);
  const wallBlocked = (x, z) => {
    if (!wall.length) return false;
    if (Math.abs(x - -150) > 2900 || Math.abs(z - 200) > 2600) return false;
    if (wallDist(x, z) < 11.5) return true;
    for (const m of mamian) if (Math.abs(m[0] - x) < 24 && Math.abs(m[1] - z) < 24 && Math.hypot(m[0] - x, m[1] - z) < 22) return true;
    for (const g of gates) if (Math.abs(g[0] - x) < g[2] && Math.abs(g[1] - z) < g[2] && Math.hypot(g[0] - x, g[1] - z) < g[2]) return true;
    return false;
  };

  // —— 输出缓冲 ——
  let cap = 1 << 18, n = 0;
  let X = new Float32Array(cap), Z = new Float32Array(cap);
  let SPC = new Uint8Array(cap), SC = new Uint8Array(cap), ROT = new Uint8Array(cap), RK = new Uint8Array(cap), LAMP = new Uint8Array(cap), YEL = new Uint8Array(cap), BR = new Uint8Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (A, C) => { const b = new C(cap); b.set(A); return b; };
    X = g(X, Float32Array); Z = g(Z, Float32Array);
    SPC = g(SPC, Uint8Array); SC = g(SC, Uint8Array); ROT = g(ROT, Uint8Array); RK = g(RK, Uint8Array);
    LAMP = g(LAMP, Uint8Array); YEL = g(YEL, Uint8Array); BR = g(BR, Uint8Array);
  };
  const rnd = mulberry(20260925);
  const stats = { street: 0, median: 0, wallpark: 0, bank: 0, landuse: 0, hedge: 0 };
  // 树种高度随机范围（相对 vegSpecies 基准几何）
  const SCALE = [
    [0.72, 1.12], // 国槐 7.9~12.3 m
    [0.72, 1.08], // 法桐 12~18 m
    [0.62, 1.18], // 雪松 9~18 m
    [0.82, 1.22], // 垂柳 8~12 m
    [0.62, 0.98], // 银杏 8~12.5 m（多为青年树）
    [0.7, 1.15], // 石榴 3.4~5.6 m
    [0.65, 1.35], // 灌木球
  ];
  // 秋色（9 月下旬）：银杏开始微黄，法桐少量泛黄
  const YELLOW = [[0, 0.1], [0.04, 0.28], [0, 0], [0, 0.06], [0.18, 0.55], [0, 0.05], [0, 0]];
  // 树冠净距（米）：建筑 / 其他树
  const CLEAR_B = [2.6, 3.4, 3.0, 2.8, 2.2, 1.6, 0.8];
  function occupyTree(x, z, sp) {
    const i = ci(x), j = cj(z);
    T.set(i, j);
    if (sp === WUTONG || sp === XUESONG) { T.set(i + 1, j); T.set(i - 1, j); T.set(i, j + 1); T.set(i, j - 1); }
  }
  function treeFree(x, z, sp, bClear) {
    const i = ci(x), j = cj(z);
    if (T.get(i, j)) return false;
    if (sp !== GUANMU && sp !== SHILIU && (T.get(i + 1, j) || T.get(i - 1, j) || T.get(i, j + 1) || T.get(i, j - 1))) return false;
    if (nearAny(B, x, z, bClear ?? CLEAR_B[sp])) return false;
    return true;
  }
  /**
   * 放置一棵树（已通过路面/水面检查）。kind：rank 偏置（行道树更靠前保留）
   */
  function addTree(x, z, sp, { lamp = 0, sMul = 1, rankMul = 1 } = {}) {
    if (n >= cap) grow();
    const [s0, s1] = SCALE[sp];
    const s = (s0 + (s1 - s0) * rnd()) * sMul;
    X[n] = x; Z[n] = z; SPC[n] = sp;
    SC[n] = Math.max(1, Math.min(255, Math.round(s * 127.5)));
    ROT[n] = (rnd() * 256) | 0;
    RK[n] = Math.min(255, (rnd() * 256 * rankMul) | 0);
    LAMP[n] = Math.round(Math.max(0, Math.min(1, lamp)) * 255);
    const [y0, y1] = YELLOW[sp];
    YEL[n] = Math.round((y0 + (y1 - y0) * rnd() * rnd() * 1.6) * 255) & 255;
    BR[n] = (rnd() * 256) | 0;
    occupyTree(x, z, sp);
    n++;
  }
  const falloff = (x, z) => {
    const r = Math.hypot(x - CENTER_X, z - CENTER_Z);
    if (r < 6500) return 1;
    if (r < 12500) return 1 - (0.72 * (r - 6500)) / 6000;
    return Math.max(0, 0.28 * (1 - (r - 12500) / 1500));
  };
  const nearWater = (x, z, r) => nearAny(W, x, z, r);

  // —— 绿篱段 ——
  let hcap = 1 << 15, hn = 0;
  let HED = new Float32Array(hcap * 7);
  function addHedge(x, z, yaw, len, wid, hgt, variant) {
    if (hn >= hcap) {
      hcap *= 2;
      const b = new Float32Array(hcap * 7);
      b.set(HED);
      HED = b;
    }
    HED.set([x, z, yaw, len, wid, hgt, variant], hn * 7);
    hn++;
    stats.hedge++;
  }

  // —— 4. 行道树 ——
  // 同名道路统一树种：真实老路（友谊路/含光路/咸宁路/太白路…）为法桐；雁塔西路银杏；其余按名称散列
  const WUTONG_RE = /友谊|含光|咸宁|太白|雁塔北路|建设路|长乐|西五路|东五路|环城|兴庆|朱雀|南关|北关|西关|东关|劳动路|丰庆|桃园|西影|翠华/;
  const YINXING_RE = /雁塔西路|唐延|科技|锦业|丈八一|高新|天谷|云水|团结南|芙蓉|曲江|雁南|大唐|慈恩|凤城|未央路|明光/;
  const XUESONG_RE = /长安北路|长安中路|南二环|北二环|东二环|西二环|含元|玄武/;
  const HUAI_RE = /东大街|西大街|南大街|北大街|钟楼|鼓楼|北院门|西华门|东新街|解放路|莲湖|青年路|东木头市|竹笆市|五味什字|德福巷|书院门|湘子庙|南院门|粉巷|案板街/;
  function roadSpecies(f) {
    const name = f.n || '';
    if (name) {
      if (HUAI_RE.test(name)) return [HUAI, 0.92];
      if (/雁塔西路/.test(name)) return [YINXING, 0.96];
      if (WUTONG_RE.test(name)) return [WUTONG, 0.85];
      if (YINXING_RE.test(name)) return [YINXING, 0.75];
      if (XUESONG_RE.test(name) && strHash(name) < 0.5) return [XUESONG, 0.6];
      const h = strHash(name);
      return [h < 0.46 ? HUAI : h < 0.76 ? WUTONG : h < 0.9 ? YINXING : h < 0.95 ? XUESONG : HUAI, 0.82];
    }
    const h = hashI(Math.round(f.p[0] / 50), Math.round(f.p[1] / 50), 7);
    return [h < 0.6 ? HUAI : h < 0.82 ? WUTONG : YINXING, 0.7];
  }
  const OTHER_STREET = [[HUAI, 0.55], [WUTONG, 0.2], [YINXING, 0.15], [SHILIU, 0.1]];
  // 类别 → [间距, 距路缘, 种植概率, 灯光]
  const STREET = { 1: [6.5, 2.0, 0.94, 1], 2: [6.5, 2.0, 0.94, 1], 3: [7.5, 1.9, 0.9, 1], 4: [8, 1.8, 0.85, 0.9], 5: [9, 1.4, 0.6, 0.45], 7: [9.5, 1.5, 0.55, 0.45], 12: [7, 1.3, 0.8, 0.8] };
  // 老城区（城墙内）与二环内：大树；新区：青年树
  const ageMul = (x, z) => {
    const r = Math.hypot(x, z);
    return r < 2600 ? 1.08 : r < 5200 ? 1.0 : 0.88;
  };
  const lenOf = (p) => {
    let L = 0;
    for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    return L;
  };
  for (const f of feats) {
    const cfg = STREET[f.c];
    if (!cfg || f.b || f.t) continue;
    const p = f.p;
    if (!p || p.length < 4) continue;
    if (!inRegion(p[0], p[1]) && !inRegion(p[p.length - 2], p[p.length - 1])) continue;
    const fo = falloff(p[0], p[1]);
    if (fo <= 0) continue;
    const [spacing, curb, prob, lamp] = cfg;
    const hw = roadW(f) / 2;
    const [sp0, loyal] = roadSpecies(f);
    const oneway = !!f.o;
    const major = f.c <= 3;
    const L = lenOf(p);
    if (L < 12) continue;
    // 沿线采样
    for (const side of [1, -1]) {
      const median = oneway && side === -1; // 单行道左侧 = 中央分隔带
      if (median && !major) continue;
      let seg = 0, segStart = 0, segLen = Math.hypot(p[2] - p[0], p[3] - p[1]);
      let s = rnd() * spacing;
      let hedgeRun = 0, hedgeAcc = null;
      const off = median ? hw + 2.4 : hw + curb;
      while (s < L) {
        while (seg < p.length / 2 - 2 && s > segStart + segLen) {
          segStart += segLen;
          seg++;
          segLen = Math.hypot(p[seg * 2 + 2] - p[seg * 2], p[seg * 2 + 3] - p[seg * 2 + 1]);
        }
        const t = segLen > 0 ? (s - segStart) / segLen : 0;
        const ax = p[seg * 2], az = p[seg * 2 + 1], bx = p[seg * 2 + 2], bz = p[seg * 2 + 3];
        const dx = (bx - ax) / (segLen || 1), dz = (bz - az) / (segLen || 1);
        // 右法线（x 东 z 南，行进方向右侧）：(-dz, dx)
        const nx = -dz * side, nz = dx * side;
        const lat = (rnd() - 0.5) * 0.5;
        const x = ax + (bx - ax) * t + nx * (off + lat), z = az + (bz - az) * t + nz * (off + lat);
        const stepHere = spacing * (0.9 + rnd() * 0.2);
        s += stepHere;
        const dbg = input.debugBox && x > input.debugBox[0] && x < input.debugBox[1] && z > input.debugBox[2] && z < input.debugBox[3];
        const rej = (k) => { if (dbg) stats['rej_' + k] = (stats['rej_' + k] || 0) + 1; };
        if (rnd() > prob * (f.c <= 3 ? 0.5 + 0.5 * fo : fo * (0.25 + 0.75 * fo))) { hedgeRun = 0; rej('prob'); continue; }
        if (!inRegion(x, z)) continue;
        // 路面：树干处及 1.3 m 内不能是路（排除路口）；分隔带要求两侧都有余量
        if (roadHit(x, z, median ? 1.2 : 0.9) || nearAny(W, x, z, 1.5)) { hedgeRun = 0; rej(median ? 'roadM' : 'road'); continue; }
        if (excluded(x, z) || wallBlocked(x, z)) { hedgeRun = 0; rej('excl'); continue; }
        let sp = rnd() < loyal ? sp0 : pick(OTHER_STREET, rnd());
        if (median) sp = rnd() < 0.55 ? sp : rnd() < 0.5 ? XUESONG : SHILIU;
        if (nearWater(x, z, 9) && rnd() < 0.8) sp = LIU;
        // 窄路不种大法桐
        if (sp === WUTONG && hw < 5) sp = HUAI;
        if (!treeFree(x, z, sp, Math.min(CLEAR_B[sp], hw < 5 ? 1.1 : 1.5))) { hedgeRun = 0; rej(nearAny(B, x, z, 1.5) ? 'bld' : 'tree'); continue; }
        rej('ok');
        addTree(x, z, sp, { lamp: lamp * (0.8 + rnd() * 0.2), sMul: ageMul(x, z) * (hw < 5 ? 0.85 : 1), rankMul: 0.72 });
        if (median) stats.median++;
        else stats.street++;
        stats['st_' + f.c] = (stats['st_' + f.c] || 0) + 1;
        // 绿篱：主干道树池之间连续绿篱带；中央分隔带绿篱
        if (major && (median || hw >= 9)) {
          if (hedgeRun > 0 && hedgeAcc) {
            const mx = (hedgeAcc[0] + x) / 2, mz = (hedgeAcc[1] + z) / 2;
            const len = Math.hypot(x - hedgeAcc[0], z - hedgeAcc[1]) - 1.4;
            if (len > 1.5 && len < 11 && !roadHit(mx, mz, median ? 0.9 : 0.7) && !nearAny(B, mx, mz, 1.2) && !excluded(mx, mz)) {
              const variant = median ? (hashI(Math.round(mx / 300), Math.round(mz / 300), 3) < 0.35 ? 2 : 0) : hashI(Math.round(mx / 400), Math.round(mz / 400), 5) < 0.3 ? 1 : 0;
              addHedge(mx, mz, Math.atan2(z - hedgeAcc[1], x - hedgeAcc[0]), len, median ? 1.6 : 1.2, median ? 0.9 : 0.7, variant);
            }
          }
          hedgeRun++;
          hedgeAcc = [x, z];
        }
      }
    }
  }

  // —— 5. 环城公园（城墙与护城河之间） ——
  if (wall.length > 10) {
    let cx = 0, cz = 0;
    for (const w of wall) { cx += w[0]; cz += w[1]; }
    cx /= wall.length; cz /= wall.length;
    const WALLMIX = [[HUAI, 0.26], [XUESONG, 0.2], [WUTONG, 0.12], [YINXING, 0.1], [SHILIU, 0.1], [GUANMU, 0.12], [LIU, 0.1]];
    // 沿中心线每 5.5 m 一个断面
    const pts = [];
    for (let i = 0; i < wall.length; i++) {
      const a = wall[i], b = wall[(i + 1) % wall.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const k = Math.max(1, Math.round(L / 4.8));
      for (let s = 0; s < k; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / k, a[1] + ((b[1] - a[1]) * s) / k, (b[0] - a[0]) / L, (b[1] - a[1]) / L]);
    }
    for (const [px, pz, tx, tz] of pts) {
      let nx = -tz, nz = tx;
      if (nx * (px - cx) + nz * (pz - cz) < 0) { nx = -nx; nz = -nz; } // 外法线
      // 外侧：从 14 m 起逐排到护城河
      for (let d = 13.5 + rnd() * 2; d < 95; d += 4.3 + rnd() * 1.4) {
        const lat = (rnd() - 0.5) * 4.5;
        const x = px + nx * d + tx * lat, z = pz + nz * d + tz * lat;
        if (blocked(W, x, z) || roadHit(x, z, 0.5)) break; // 到护城河 / 车行道即止（园路不止）
        if (rnd() > 0.9) continue;
        if (nearAny(RD, x, z, 0.8) || nearAny(W, x, z, 1.2)) continue;
        if (excluded(x, z) || wallBlocked(x, z)) continue;
        let sp = pick(WALLMIX, rnd());
        if (nearWater(x, z, 7) && rnd() < 0.85) sp = LIU;
        if (!treeFree(x, z, sp)) continue;
        addTree(x, z, sp, { lamp: 0.25 + rnd() * 0.3, rankMul: 0.8 });
        stats.wallpark++;
      }
      // 内侧顺城巷一排
      if (rnd() < 0.55) {
        const d = 13 + rnd() * 3;
        const x = px - nx * d, z = pz - nz * d;
        if (!nearAny(RD, x, z, 1.2) && !excluded(x, z) && !wallBlocked(x, z)) {
          const sp = rnd() < 0.7 ? HUAI : rnd() < 0.5 ? SHILIU : YINXING;
          if (treeFree(x, z, sp, 1.8)) {
            addTree(x, z, sp, { lamp: 0.5, rankMul: 0.85 });
            stats.wallpark++;
          }
        }
      }
    }
  }

  // —— 6. 水岸垂柳 ——
  const BANKMIX = [[LIU, 0.72], [HUAI, 0.1], [XUESONG, 0.06], [SHILIU, 0.05], [GUANMU, 0.07]];
  function bankRing(p) {
    const nP = p.length / 2;
    if (nP < 3) return;
    let s = rnd() * 7;
    for (let k = 0; k < nP; k++) {
      const kb = (k + 1) % nP;
      const ax = p[k * 2], az = p[k * 2 + 1], bx = p[kb * 2], bz = p[kb * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.1) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      for (; s < L; s += 6.5 + rnd() * 2.5) {
        const mx = ax + tx * s, mz = az + tz * s;
        if (!inRegion(mx, mz) || falloff(mx, mz) < rnd()) continue;
        for (const side of [1, -1]) {
          const nx = -tz * side, nz = tx * side;
          for (const d of [3.5, 9.5]) {
            if (d > 5 && rnd() < 0.55) continue;
            const x = mx + nx * (d + (rnd() - 0.5) * 1.5), z = mz + nz * (d + (rnd() - 0.5) * 1.5);
            if (nearAny(W, x, z, 1.5) || nearAny(RD, x, z, 1.4)) continue;
            if (excluded(x, z) || wallBlocked(x, z)) continue;
            const sp = d < 5 ? (rnd() < 0.85 ? LIU : pick(BANKMIX, rnd())) : pick(BANKMIX, rnd());
            if (!treeFree(x, z, sp)) continue;
            addTree(x, z, sp, { lamp: 0.2 * rnd(), rankMul: 0.85 });
            stats.bank++;
          }
        }
      }
      s -= L;
    }
  }
  for (const w of water.polys || []) {
    if (!w.outer || w.outer.length < 6) continue;
    if (!['lake', 'moat', 'pond', 'river', 'canal', 'reservoir'].includes(w.k)) continue;
    let inside = false;
    for (let i = 0; i < w.outer.length; i += 2) if (inRegion(w.outer[i], w.outer[i + 1])) { inside = true; break; }
    if (!inside) continue;
    bankRing(w.outer);
  }
  for (const l of water.lines || []) {
    const p = l.p;
    if (!p || p.length < 4 || !(l.w > 6)) continue;
    if (!inRegion(p[0], p[1])) continue;
    // 线状河道：两岸各一排
    const hw = l.w / 2;
    let s = 0;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k], az = p[k + 1], bx = p[k + 2], bz = p[k + 3];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.1) continue;
      const tx = (bx - ax) / L, tz = (bz - az) / L;
      for (; s < L; s += 7 + rnd() * 3) {
        for (const side of [1, -1]) {
          const d = hw + 3 + rnd() * 2;
          const x = ax + tx * s - tz * side * d, z = az + tz * s + tx * side * d;
          if (!inRegion(x, z) || rnd() > 0.8 * falloff(x, z)) continue;
          if (nearAny(W, x, z, 1.5) || nearAny(RD, x, z, 1.4) || excluded(x, z)) continue;
          const sp = rnd() < 0.8 ? LIU : pick(BANKMIX, rnd());
          if (!treeFree(x, z, sp)) continue;
          addTree(x, z, sp, { lamp: 0.1, rankMul: 0.9 });
          stats.bank++;
        }
      }
      s -= L;
    }
  }

  // —— 7. 用地撒点 ——
  // 类别 → [每棵树的平均用地面积 m²，树种组合，团簇强度 0..1]
  const MIX_PARK = [[HUAI, 0.24], [XUESONG, 0.2], [WUTONG, 0.12], [YINXING, 0.12], [SHILIU, 0.1], [GUANMU, 0.14], [LIU, 0.08]];
  const MIX_FOREST = [[HUAI, 0.42], [XUESONG, 0.38], [YINXING, 0.08], [WUTONG, 0.07], [GUANMU, 0.05]];
  const MIX_GRASS = [[GUANMU, 0.34], [SHILIU, 0.22], [HUAI, 0.2], [XUESONG, 0.14], [YINXING, 0.1]];
  const MIX_UNI = [[XUESONG, 0.3], [HUAI, 0.26], [WUTONG, 0.16], [YINXING, 0.14], [SHILIU, 0.06], [GUANMU, 0.08]];
  const MIX_RES = [[HUAI, 0.3], [SHILIU, 0.14], [YINXING, 0.12], [XUESONG, 0.1], [GUANMU, 0.2], [WUTONG, 0.08], [LIU, 0.06]];
  const MIX_CEM = [[XUESONG, 0.7], [HUAI, 0.2], [GUANMU, 0.1]];
  const MIX_ORCH = [[SHILIU, 0.85], [GUANMU, 0.15]];
  const MIX_WORK = [[HUAI, 0.4], [XUESONG, 0.25], [WUTONG, 0.15], [GUANMU, 0.2]];
  const LU = {
    park: [190, MIX_PARK, 0.75],
    forest: [420, MIX_FOREST, 0.45],
    grass: [650, MIX_GRASS, 0.8],
    university: [320, MIX_UNI, 0.6],
    residential: [1100, MIX_RES, 0.55],
    cemetery: [120, MIX_CEM, 0.3],
    military: [650, MIX_WORK, 0.6],
    orchard: [520, MIX_ORCH, 0.2],
    commercial: [2600, MIX_WORK, 0.7],
    industrial: [2600, MIX_WORK, 0.7],
  };
  const polys = (input.landuse?.polys || []).slice();
  // 公园/林地优先（面积大者先种，避免被居住区等抢位）
  const order = { park: 0, forest: 1, cemetery: 2, university: 3, grass: 4, military: 5, residential: 6, orchard: 7, commercial: 8, industrial: 9 };
  polys.sort((a, b) => (order[a.k] ?? 99) - (order[b.k] ?? 99));
  for (const f of polys) {
    const cfg = LU[f.k];
    if (!cfg || !f.outer || f.outer.length < 6) continue;
    const [area, mix, clump] = cfg;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const o = f.outer;
    for (let i = 0; i < o.length; i += 2) {
      if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i]; if (o[i + 1] < z0) z0 = o[i + 1]; if (o[i + 1] > z1) z1 = o[i + 1];
    }
    if (x1 < R.x0 || x0 > R.x1 || z1 < R.z0 || z0 > R.z1) continue;
    const fo = falloff((x0 + x1) / 2, (z0 + z1) / 2);
    if (fo <= 0.01) continue;
    const step = Math.sqrt(area * 0.55); // 候选格：约 0.55 倍面积一个候选，再按噪声接受
    const rings = [o, ...(f.holes || [])];
    const seedN = (strHash(f.n || '') * 1000) | 0;
    for (let zr = Math.max(z0, R.z0) + step * 0.5; zr < Math.min(z1, R.z1); zr += step) {
      // 行扫描：本行与多边形的交点
      const xs = [];
      for (const p of rings) {
        const m = p.length / 2;
        for (let k = 0; k < m; k++) {
          const kb = (k + 1) % m;
          const za = p[k * 2 + 1], zb = p[kb * 2 + 1];
          if (za > zr !== zb > zr) xs.push(p[k * 2] + ((zr - za) * (p[kb * 2] - p[k * 2])) / (zb - za));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        for (let xr = xs[q] + step * rnd(); xr < xs[q + 1]; xr += step) {
          const x = xr + (rnd() - 0.5) * step * 0.9, z = zr + (rnd() - 0.5) * step * 0.9;
          // 团簇噪声：林团 + 草坪空地
          const nz = vnoise(x / 55, z / 55, 11 + seedN) * 0.7 + vnoise(x / 17, z / 17, 23) * 0.3;
          const dens = (1 - clump) + clump * Math.max(0, Math.min(1, (nz - 0.3) * 2.6));
          if (rnd() > dens * fo * 1.0) continue;
          if (!inRegion(x, z)) continue;
          if (nearAny(RD, x, z, 1.8) || nearAny(W, x, z, 1.6)) continue;
          if (excluded(x, z) || wallBlocked(x, z)) continue;
          // 树种：40 m 尺度的同种林团
          let sp = hashI(Math.floor(x / 38), Math.floor(z / 38), 91 + seedN) < 0.6 ? pick(mix, hashI(Math.floor(x / 38), Math.floor(z / 38), 5 + seedN)) : pick(mix, rnd());
          if (sp !== GUANMU && nearWater(x, z, 8) && rnd() < 0.7) sp = LIU;
          if (!treeFree(x, z, sp)) continue;
          addTree(x, z, sp, { lamp: rnd() < 0.25 ? 0.25 : 0, rankMul: 1 });
          stats.landuse++;
          stats['lu_' + f.k] = (stats['lu_' + f.k] || 0) + 1;
        }
      }
    }
  }

  // —— 8. 数量上限：超出时随机剔除（保持分布均匀） ——
  let keep = null;
  if (n > MAX_TREES) {
    keep = new Uint8Array(n);
    const pr = MAX_TREES / n;
    for (let i = 0; i < n; i++) keep[i] = rnd() < pr ? 1 : 0;
  }

  // —— 9. 按渲染块排序 ——
  const NCX = Math.ceil((R.x1 - R.x0) / VEG_CHUNK), NCZ = Math.ceil((R.z1 - R.z0) / VEG_CHUNK);
  const nC = NCX * NCZ;
  const cidx = new Int32Array(n);
  const counts = new Uint32Array(nC + 1);
  for (let i = 0; i < n; i++) {
    if (keep && !keep[i]) { cidx[i] = -1; continue; }
    const cx = Math.min(NCX - 1, Math.max(0, Math.floor((X[i] - R.x0) / VEG_CHUNK)));
    const cz = Math.min(NCZ - 1, Math.max(0, Math.floor((Z[i] - R.z0) / VEG_CHUNK)));
    cidx[i] = cz * NCX + cx;
    counts[cidx[i] + 1]++;
  }
  for (let c = 0; c < nC; c++) counts[c + 1] += counts[c];
  const total = counts[nC];
  const fill = counts.slice(0, nC);
  const out = {
    x: new Float32Array(total), z: new Float32Array(total),
    sp: new Uint8Array(total), sc: new Uint8Array(total), rot: new Uint8Array(total), rank: new Uint8Array(total),
    lamp: new Uint8Array(total), yel: new Uint8Array(total), br: new Uint8Array(total),
  };
  for (let i = 0; i < n; i++) {
    if (cidx[i] < 0) continue;
    const k = fill[cidx[i]]++;
    out.x[k] = X[i]; out.z[k] = Z[i]; out.sp[k] = SPC[i]; out.sc[k] = SC[i]; out.rot[k] = ROT[i];
    out.rank[k] = RK[i]; out.lamp[k] = LAMP[i]; out.yel[k] = YEL[i]; out.br[k] = BR[i];
  }
  // 绿篱同样分块
  const hc = new Int32Array(hn);
  const hcounts = new Uint32Array(nC + 1);
  for (let i = 0; i < hn; i++) {
    const cx = Math.min(NCX - 1, Math.max(0, Math.floor((HED[i * 7] - R.x0) / VEG_CHUNK)));
    const cz = Math.min(NCZ - 1, Math.max(0, Math.floor((HED[i * 7 + 1] - R.z0) / VEG_CHUNK)));
    hc[i] = cz * NCX + cx;
    hcounts[hc[i] + 1]++;
  }
  for (let c = 0; c < nC; c++) hcounts[c + 1] += hcounts[c];
  const hfill = hcounts.slice(0, nC);
  const hedges = new Float32Array(hn * 7);
  for (let i = 0; i < hn; i++) {
    const k = hfill[hc[i]]++;
    hedges.set(HED.subarray(i * 7, i * 7 + 7), k * 7);
  }
  const spCount = new Uint32Array(7);
  for (let i = 0; i < total; i++) spCount[out.sp[i]]++;
  return {
    n: total,
    ...out,
    chunkStart: counts,
    hedges,
    hedgeN: hn,
    hedgeStart: hcounts,
    ncx: NCX,
    ncz: NCZ,
    region: R,
    chunk: VEG_CHUNK,
    stats: { ...stats, generated: n, total, buildings: nb, species: Array.from(spCount), ms: Date.now() - t0 },
  };
}

/** 结果中需要转移（transfer）的 ArrayBuffer 列表 */
export function transferList(r) {
  return [r.x, r.z, r.sp, r.sc, r.rot, r.rank, r.lamp, r.yel, r.br, r.chunkStart, r.hedges, r.hedgeStart].map((a) => a.buffer);
}
