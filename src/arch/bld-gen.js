// 通用建筑几何生成器（Web Worker 与主线程回退共用；纯计算，不依赖 DOM / WebGL）
//
// 输入：buildings.bin（v1 / v2，见 docs/CONTRACT.md 3.4）+ 主线程算好的地面高程、排除标记、主干道折线。
// 输出：
//   · 数据纹理（每栋 4 个 RGBA32F texel）：地面高程/高度/层高/风格、主色/种子、首层高/女儿墙/副色/标志、质心/半径/玻璃色
//   · 远景（lo）几何：按 8 km 大块合批，大块内 1 km 小块按 Morton（Z 序）连续排列 → 视锥内的小块集合只形成
//     少数几段连续区间，可用 drawRange 分段绘制（块级剔除 + 少量 draw call）
//     顶点 6×uint16 = 12 B：x z 为 0.2 m 单位、y 为绝对海拔分米（相对大块原点）、u（沿周长分米）、建筑编号低/高 16 位
//   · 近景（hi）几何：按需生成 1 km 小块，外墙逐边独立顶点（u 从每条边起点计），含女儿墙与屋面
//     顶点 8×uint16 = 16 B：x y z u len idLo idHi meta（meta：0-7 外法线角，8-12 边序号，13 临街，14 女儿墙内侧）
//   · 屋顶构件实例（楼梯间/机房、水箱、空调机组、太阳能热水器、彩钢棚、通风器）
//   · 航空障碍灯位置（高度 ≥ 100 m）
import earcut from 'three/src/extras/lib/earcut.js';

export const CHUNK = 1000; // 1 km 小块
export const BLOCK_N = 8; // 8×8 小块 = 8 km 大块（远景合批单元）
export const BLOCK = CHUNK * BLOCK_N;
export const TEX_W = 4096; // 数据纹理宽：每栋 4 texel，每行 1024 栋
export const LO_STRIDE = 6;
export const HI_STRIDE = 8;
const LO_MARGIN = 1000; // 大块原点外扩（米），容纳跨界大建筑
export const LO_QXZ = 5; // 远景 x/z 量化：每米 5 单位（0.2 m），(8 km + 2 km) × 5 = 50000 < 65535
const HI_MARGIN = 2000;

// ———— 风格 ————
export const STYLE = { TOWER: 0, MID: 1, GLASS: 2, STONE: 3, COMM: 4, VILLAGE: 5, INDUS: 6, PUBLIC: 7, HOTEL: 8, HIST: 9 };
export const STYLE_NAMES = ['高层住宅', '老式多层', '玻璃幕墙办公', '石材办公', '商业裙房', '城中村自建房', '工业厂房', '公共建筑', '酒店', '传统风貌'];

/**
 * 风格参数（调研依据，见 research/refs/buildings/）：
 *  · 高层住宅：西安 2000 年后典型 18~34 层塔楼，层高 2.9~3.0 m，面宽开间 3.1~3.7 m，米黄/浅灰/白色涂料或面砖，
 *    顶部 1~2 层变色“皇冠”，南向阳台（封闭或凹阳台），空调百叶机位；临街底层 4.5 m 底商。
 *  · 老式多层：1980~90 年代 5~7 层砖混板楼，层高 2.8~2.9 m，开间 3.0~3.3 m，红砖清水墙 + 混凝土圈梁、白色面砖或米黄涂料，
 *    1.5 m 方窗、低层防盗网、外挂空调、南侧封闭阳台，楼梯间半层错位小窗。
 *  · 办公：层高 3.8~4.2 m；玻璃幕墙（竖梃 1.5 m，层间窗槛墙）或石材 + 带形窗；首层 5~6 m 大堂。
 *  · 商业裙房：首层 5.5~6 m 通透橱窗 + 门头招牌带，上层实墙与广告位。
 *  · 城中村：4~8 层自建房，层高 3.0~3.3 m，小窗不规则、蓝色镀膜玻璃、白瓷砖/水泥/红砖混杂，底层卷帘门。
 *  · 工业厂房：单层 6~15 m，彩钢板（蓝/白/灰），1.2 m 砖砌勒脚，通长高侧窗，大卷帘门。
 */
const STYLE_P = [
  { fh: [2.9, 3.05], gf: [3.3, 3.6], gfShop: 4.5, ph: 1.3 }, // TOWER
  { fh: [2.8, 2.95], gf: [2.9, 3.1], gfShop: 3.6, ph: 0.9 }, // MID
  { fh: [3.9, 4.2], gf: [5.2, 6.0], gfShop: 6.0, ph: 1.2 }, // GLASS
  { fh: [3.8, 4.1], gf: [4.8, 5.6], gfShop: 5.6, ph: 1.2 }, // STONE
  { fh: [4.8, 5.4], gf: [5.5, 6.0], gfShop: 6.0, ph: 1.2 }, // COMM
  { fh: [3.0, 3.3], gf: [3.4, 3.8], gfShop: 3.8, ph: 1.0 }, // VILLAGE
  { fh: [0, 0], gf: [0, 0], gfShop: 0, ph: 0.6 }, // INDUS
  { fh: [3.7, 3.9], gf: [4.0, 4.5], gfShop: 4.5, ph: 1.1 }, // PUBLIC
  { fh: [3.2, 3.4], gf: [4.6, 5.4], gfShop: 5.4, ph: 1.2 }, // HOTEL
  { fh: [3.4, 3.8], gf: [3.6, 4.0], gfShop: 4.0, ph: 0.8 }, // HIST
];
// 室内亮灯类别：0 住宅 1 办公 2 商业
export const LIT_CLASS = [0, 0, 1, 1, 2, 0, 1, 1, 0, 0];

// 色板（sRGB）：西安常见米黄、浅灰、砖红、白色面砖；新楼石材米色 / 玻璃蓝灰
const PAL = [
  // TOWER 主色
  ['#dccbaa', '#d6c3a0', '#e2d6bf', '#cfc7ba', '#c7c3bc', '#e6e1d6', '#d9c1a8', '#cdb89c', '#bdb5a9', '#d8cfc0', '#e0c9b0', '#d2bfa4', '#c9b9a6', '#b8b2aa'],
  // MID
  ['#d9d6ce', '#e0ddd5', '#96533f', '#8a4a38', '#a4604a', '#cdb795', '#d8c7a4', '#b9b3a8', '#c9b28f', '#d4bca0', '#9c5a44', '#cfc9bd', '#c4ad8d'],
  // GLASS（此处为竖梃/框料色）
  ['#5d6166', '#7c8187', '#9aa0a6', '#43474c', '#b4b8bc', '#6d6358'],
  // STONE
  ['#cbb899', '#c2b39c', '#d6ccb8', '#a9a49b', '#8e8a84', '#bfae93', '#e0d8c8', '#76726c', '#b9ab95'],
  // COMM
  ['#d8d3c9', '#c8c2b6', '#b8b4ad', '#9a9690', '#e0dbd0', '#cbbfa8', '#7d7a76', '#a89c8a'],
  // VILLAGE（白瓷砖、水泥抹灰、清水红砖、米黄/粉/浅蓝涂料混杂）
  ['#dedbd3', '#d2c7b5', '#b0aaa1', '#c9a08a', '#d8b8a0', '#a7b5b9', '#b8c4b0', '#9a5a46', '#8e5240', '#c4c0b8', '#a9a39a', '#9d978d', '#c8b08e', '#b87f6a'],
  // INDUS（彩钢板）
  ['#4a78a8', '#dfe3e5', '#9aa0a6', '#3e6a96', '#c8ccce', '#8a4234', '#6f8fa8', '#b8bcbe', '#d0d4d6', '#5b86b0'],
  // PUBLIC
  ['#d9c9a8', '#e3ddd0', '#bdb8ae', '#a35e48', '#cfbfa2', '#c8c0b4', '#e0d6c2', '#b06a50'],
  // HOTEL
  ['#cdb896', '#bfae90', '#d8cbb2', '#a89a86', '#8f8378', '#ddd3c0'],
  // HIST
  ['#6f6c68', '#7a756d', '#66625c', '#5e5b57'],
];
// 副色（塔楼皇冠/竖向色带/基座、窗框、招牌等）
const ACC = [
  ['#8c6b52', '#6f6a66', '#9a7a5c', '#5c5f66', '#a0806a', '#7b5a4a', '#b39c82', '#8a8f96', '#c9bda8', '#e8e4dc'],
  ['#8d8a84', '#a9a59d', '#e8e6e0', '#7a6f63', '#b5aea3'],
  ['#2f3236', '#44484d', '#8a8f95'],
  ['#5e5a55', '#8a847a', '#a39a8a', '#e3ddd2'],
  ['#3a3d41', '#9c2f28', '#26508a', '#c9c3b6'],
  ['#e8e6e0', '#9a9690', '#6f6a63'],
  ['#8a7c6c', '#9a948c', '#6d6760'],
  ['#8a8a84', '#6e6a64', '#c7bba4'],
  ['#6d5e50', '#8f8374', '#4f4944'],
  ['#5a2a22', '#3d3a36'],
];
// 玻璃色调（sRGB）：住宅透明（偏绿灰）、幕墙蓝灰/绿/银灰/茶色、城中村蓝色镀膜
const GLASS_RES = ['#3a4a4c', '#34444a', '#40504e', '#3c4550'];
const GLASS_CW = ['#5a7389', '#4a6275', '#4f6d66', '#6a7680', '#6d5a44', '#3f5a6b', '#7d8e98', '#587a8c'];
const GLASS_BLUE = ['#3f78a8', '#4b86b4', '#3a6e9a', '#4a8a9a'];

function hexRGB(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const s2l = (c) => Math.pow(c / 255, 2.2);
function packRGB(rgb) {
  return rgb[0] * 65536 + rgb[1] * 256 + rgb[2];
}

// ———— 哈希 ————
export function hash01(a, b = 0) {
  let x = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x632be5ab, 0x85ebca77)) | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
function pick(arr, r) {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
}

// ———— 解析 ————
export function parseBuildings(buffer) {
  if (!buffer || buffer.byteLength < 16) return null;
  const dv = new DataView(buffer);
  if (dv.getUint8(0) !== 88 || dv.getUint8(1) !== 66 || dv.getUint8(2) !== 76 || dv.getUint8(3) !== 68) return null; // "XBLD"
  const version = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  const totalVerts = dv.getUint32(12, true);
  if (version < 1 || version > 2 || count > 4e6 || totalVerts > 8e7) return null;
  let o = 16;
  const anchorX = new Float32Array(buffer, o, count); o += count * 4;
  const anchorZ = new Float32Array(buffer, o, count); o += count * 4;
  const vertStart = new Uint32Array(buffer, o, count); o += count * 4;
  const vertCount = new Uint16Array(buffer, o, count); o += count * 2;
  const heightDm = new Uint16Array(buffer, o, count); o += count * 2;
  const minHeightDm = new Uint16Array(buffer, o, count); o += count * 2;
  const kind = new Uint8Array(buffer, o, count); o += count;
  const flags = new Uint8Array(buffer, o, count); o += count;
  let style = null;
  if (version >= 2) {
    style = new Uint8Array(buffer, o, count);
    o += count;
  }
  o = (o + 3) & ~3;
  if (o + totalVerts * 4 > buffer.byteLength) return null;
  const offs = new Int16Array(buffer, o, totalVerts * 2);
  return { version, count, totalVerts, anchorX, anchorZ, vertStart, vertCount, heightDm, minHeightDm, kind, flags, style, offs };
}

/**
 * v2 style 字节（见 tools/build_buildings_v2.py assign_kind_style）：
 *   bits0-3 年代：0 未知 1 1990 前 2 1990s 3 2000s 4 2010s 5 2020+
 *   bits4-7 功能：0 未知 1 居住高层塔楼 2 居住多层板楼 3 别墅/低层 4 城中村自建房 5 办公 6 商业综合体 7 工业厂房 8 公共
 * 返回 -1 表示按 kind/高度/面积推断。
 */
function mapStyleByte(sb, kind, H, area, r) {
  const f = sb >> 4, age = sb & 15;
  switch (f) {
    case 1: return H >= 24 ? STYLE.TOWER : STYLE.MID;
    case 2: return H >= 40 || (H >= 24 && age >= 4) ? STYLE.TOWER : STYLE.MID;
    case 3: return area > 700 && H >= 7 ? STYLE.MID : STYLE.VILLAGE;
    case 4: return H >= 30 ? STYLE.TOWER : STYLE.VILLAGE;
    case 5: return H >= 24 ? (r < 0.55 ? STYLE.GLASS : STYLE.STONE) : r < 0.6 ? STYLE.STONE : STYLE.PUBLIC;
    case 6:
      if (kind === 8) return STYLE.HOTEL;
      if (H >= 45) return r < 0.6 ? STYLE.GLASS : STYLE.STONE;
      if (H >= 24 && area < 2500) return r < 0.5 ? STYLE.STONE : STYLE.GLASS;
      return STYLE.COMM;
    case 7: return H > 30 ? STYLE.STONE : STYLE.INDUS;
    case 8:
      if (kind === 5) return STYLE.HIST;
      if (kind === 6) return H > 25 ? STYLE.GLASS : STYLE.COMM;
      if (kind === 8) return STYLE.HOTEL;
      return H > 50 ? (r < 0.5 ? STYLE.STONE : STYLE.GLASS) : STYLE.PUBLIC;
    default: return -1;
  }
}

function classify(kind, H, area, elong, r, sb) {
  if (sb) {
    const m = mapStyleByte(sb, kind, H, area, r);
    if (m >= 0) return m;
  }
  switch (kind) {
    case 1: // 住宅
      if (H >= 26) return STYLE.TOWER;
      if (H >= 11) return area > 2500 && elong < 1.6 ? STYLE.TOWER : STYLE.MID;
      return area < 500 ? STYLE.VILLAGE : STYLE.MID;
    case 2: // 商业/办公
      if (H >= 45) return r < 0.6 ? STYLE.GLASS : STYLE.STONE;
      if (area > 2500 && H < 32) return STYLE.COMM;
      return H >= 18 ? (r < 0.5 ? STYLE.STONE : STYLE.GLASS) : STYLE.COMM;
    case 3:
      return H > 30 ? STYLE.STONE : STYLE.INDUS;
    case 4:
    case 7:
      return H > 50 ? (r < 0.5 ? STYLE.STONE : STYLE.GLASS) : STYLE.PUBLIC;
    case 5:
      return STYLE.HIST;
    case 6:
      return H > 25 ? STYLE.GLASS : STYLE.COMM;
    case 8:
      return STYLE.HOTEL;
    default:
      if (H >= 60) return r < 0.72 ? STYLE.TOWER : r < 0.88 ? STYLE.GLASS : STYLE.STONE;
      if (H >= 26) return r < 0.82 ? STYLE.TOWER : r < 0.92 ? STYLE.STONE : STYLE.GLASS;
      if (area > 4000 && H < 20) return r < 0.55 ? STYLE.INDUS : STYLE.COMM;
      if (H >= 11) return elong > 2.0 || r < 0.75 ? STYLE.MID : STYLE.PUBLIC;
      if (area < 380) return STYLE.VILLAGE;
      return r < 0.55 ? STYLE.MID : STYLE.VILLAGE;
  }
}

// ———— 可增长的类型化数组 ————
class Grow {
  constructor(Type, cap = 1024) {
    this.Type = Type;
    this.a = new Type(cap);
    this.n = 0;
  }
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new this.Type(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push(v) {
    if (this.n >= this.a.length) this.reserve(1);
    this.a[this.n++] = v;
  }
  out() {
    return this.a.slice(0, this.n);
  }
}

// ———— 轮廓处理 ————
const SX = new Float64Array(70000), SZ = new Float64Array(70000);
const QX = new Float64Array(70000), QZ = new Float64Array(70000);

/** 解码第 i 栋建筑外环到 (xs, zs)：去重、去共线、统一为正向（shoelace > 0），返回点数 */
function decodeRing(P, i, xs, zs) {
  const n0 = P.vertCount[i], s = P.vertStart[i];
  const ax = P.anchorX[i], az = P.anchorZ[i], offs = P.offs;
  let n = 0;
  for (let j = 0; j < n0; j++) {
    const x = ax + offs[(s + j) * 2] * 0.1, z = az + offs[(s + j) * 2 + 1] * 0.1;
    if (n && Math.abs(x - xs[n - 1]) < 0.05 && Math.abs(z - zs[n - 1]) < 0.05) continue;
    xs[n] = x;
    zs[n] = z;
    n++;
  }
  while (n > 1 && Math.abs(xs[0] - xs[n - 1]) < 0.05 && Math.abs(zs[0] - zs[n - 1]) < 0.05) n--;
  // 去共线（点到前后连线距离 < 5 cm）
  let changed = true;
  while (changed && n > 3) {
    changed = false;
    let m = 0;
    for (let j = 0; j < n; j++) {
      const pj = (j - 1 + n) % n, nj = (j + 1) % n;
      const dx = xs[nj] - xs[pj], dz = zs[nj] - zs[pj];
      const L = Math.hypot(dx, dz);
      const cr = Math.abs((xs[j] - xs[pj]) * dz - (zs[j] - zs[pj]) * dx);
      if (L > 1e-6 && cr / L < 0.05 && n - (j - m) > 3) {
        changed = true;
        continue;
      }
      xs[m] = xs[j];
      zs[m] = zs[j];
      m++;
    }
    n = m;
  }
  if (n < 3) return 0;
  let a = 0;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    a += xs[j] * zs[k] - xs[k] * zs[j];
  }
  if (a < 0) {
    for (let j = 0, k = n - 1; j < k; j++, k--) {
      let t = xs[j]; xs[j] = xs[k]; xs[k] = t;
      t = zs[j]; zs[j] = zs[k]; zs[k] = t;
    }
  }
  return n;
}

function ringArea(xs, zs, n) {
  let a = 0;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    a += xs[j] * zs[k] - xs[k] * zs[j];
  }
  return a / 2;
}

/** Visvalingam 简化（远景用）：删除三角形面积 < minArea 的点，至少保留 4 点 */
function simplifyRing(xs, zs, n, minArea) {
  if (n <= 4) return n;
  for (let guard = 0; guard < 4096 && n > 4; guard++) {
    let best = -1, ba = minArea;
    for (let j = 0; j < n; j++) {
      const pj = (j - 1 + n) % n, nj = (j + 1) % n;
      const ar = Math.abs((xs[j] - xs[pj]) * (zs[nj] - zs[pj]) - (xs[nj] - xs[pj]) * (zs[j] - zs[pj])) * 0.5;
      if (ar < ba) {
        ba = ar;
        best = j;
      }
    }
    if (best < 0) break;
    for (let j = best; j < n - 1; j++) {
      xs[j] = xs[j + 1];
      zs[j] = zs[j + 1];
    }
    n--;
  }
  return n;
}

/** 向内偏移（女儿墙内侧）：斜接，锐角限长 */
function insetRing(xs, zs, n, d, ox, oz) {
  for (let i = 0; i < n; i++) {
    const p = (i - 1 + n) % n, q = (i + 1) % n;
    let e0x = xs[i] - xs[p], e0z = zs[i] - zs[p];
    let e1x = xs[q] - xs[i], e1z = zs[q] - zs[i];
    const l0 = Math.hypot(e0x, e0z) || 1, l1 = Math.hypot(e1x, e1z) || 1;
    e0x /= l0; e0z /= l0; e1x /= l1; e1z /= l1;
    const n0x = -e0z, n0z = e0x, n1x = -e1z, n1z = e1x; // 内法线
    let den = 1 + n0x * n1x + n0z * n1z;
    if (den < 0.35) den = 0.35;
    let k = d / den;
    k = Math.min(k, 0.45 * Math.min(l0, l1)); // 短边防止翻折
    ox[i] = xs[i] + (n0x + n1x) * k;
    oz[i] = zs[i] + (n0z + n1z) * k;
  }
}

function pointInRing(x, z, xs, zs, n) {
  let c = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (zs[i] > z !== zs[j] > z && x < ((xs[j] - xs[i]) * (z - zs[i])) / (zs[j] - zs[i]) + xs[i]) c = !c;
  }
  return c;
}

/** 主轴（最长边方向）与主轴坐标系下的包围盒 */
function principal(xs, zs, n) {
  let best = 0, ang = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = xs[j] - xs[i], dz = zs[j] - zs[i];
    const L = dx * dx + dz * dz;
    if (L > best) {
      best = L;
      ang = Math.atan2(dz, dx);
    }
  }
  const ux = Math.cos(ang), uz = Math.sin(ang);
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = xs[i] * ux + zs[i] * uz, t = -xs[i] * uz + zs[i] * ux;
    if (s < s0) s0 = s;
    if (s > s1) s1 = s;
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
  }
  return { ang, ux, uz, s0, s1, t0, t1, L: s1 - s0, W: t1 - t0 };
}

// ———— 道路（临街判定） ————
function buildRoadIndex(roads) {
  if (!roads || !roads.pts || !roads.pts.length) return null;
  const { pts, starts, widths } = roads;
  const cell = 64;
  const grid = new Map();
  const segs = new Grow(Float32Array, 1 << 16); // x0 z0 x1 z1 hw
  for (let r = 0; r < widths.length; r++) {
    const a = starts[r], b = starts[r + 1];
    const hw = widths[r] * 0.5;
    for (let k = a; k < b - 1; k++) {
      const x0 = pts[k * 2], z0 = pts[k * 2 + 1], x1 = pts[k * 2 + 2], z1 = pts[k * 2 + 3];
      const id = segs.n / 5;
      segs.reserve(5);
      segs.a.set([x0, z0, x1, z1, hw], segs.n);
      segs.n += 5;
      const pad = hw + 20;
      const cx0 = Math.floor((Math.min(x0, x1) - pad) / cell), cx1 = Math.floor((Math.max(x0, x1) + pad) / cell);
      const cz0 = Math.floor((Math.min(z0, z1) - pad) / cell), cz1 = Math.floor((Math.max(z0, z1) + pad) / cell);
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 400) continue;
      for (let cx = cx0; cx <= cx1; cx++)
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = cx * 73856093 + cz;
          let l = grid.get(key);
          if (!l) grid.set(key, (l = []));
          l.push(id);
        }
    }
  }
  return { grid, cell, segs: segs.out() };
}

/** 点到最近主干道的“路缘距离”（到中心线距离 - 半宽）与朝路方向 */
function roadDist(R, x, z, out) {
  out.d = Infinity;
  if (!R) return out;
  const l = R.grid.get(Math.floor(x / R.cell) * 73856093 + Math.floor(z / R.cell));
  if (!l) return out;
  const S = R.segs;
  for (const id of l) {
    const o = id * 5;
    const x0 = S[o], z0 = S[o + 1], x1 = S[o + 2], z1 = S[o + 3], hw = S[o + 4];
    const dx = x1 - x0, dz = z1 - z0;
    const L2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - x0) * dx + (z - z0) * dz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x0 + dx * t, pz = z0 + dz * t;
    const d = Math.hypot(x - px, z - pz) - hw;
    if (d < out.d) {
      out.d = d;
      out.dx = px - x;
      out.dz = pz - z;
    }
  }
  return out;
}

// ———— 生成器 ————
export function createGenerator() {
  let P = null, base = null, ga = null, skip = null, R = null;
  let styleA, fhA, gfA, phA, hA, flagA, colA, accA, chunkLists;
  const rd = { d: 0, dx: 0, dz: 0 };

  function init(msg) {
    const t0 = performance.now();
    P = parseBuildings(msg.buffer);
    if (!P) return { msg: { type: 'init', ok: false } };
    base = msg.base;
    ga = msg.ga;
    skip = msg.skip;
    R = buildRoadIndex(msg.roads);
    const N = P.count;
    styleA = new Uint8Array(N);
    fhA = new Float32Array(N);
    gfA = new Float32Array(N);
    phA = new Float32Array(N);
    hA = new Float32Array(N);
    flagA = new Uint16Array(N);
    colA = new Uint32Array(N);
    accA = new Uint32Array(N);
    const tex = new Float32Array(Math.ceil(N / 1024) * TEX_W * 4);
    const lights = [];
    const blocks = new Map();
    chunkLists = new Map();
    const stat = { built: 0, skipped: 0, styles: new Array(10).fill(0), tall: 0, loVerts: 0, loTris: 0 };

    // —— 第一遍：分类 + 数据纹理 + 分块 ——
    for (let i = 0; i < N; i++) {
      if (skip[i]) {
        stat.skipped++;
        continue;
      }
      const n = decodeRing(P, i, SX, SZ);
      if (n < 3) {
        skip[i] = 2;
        continue;
      }
      const area = ringArea(SX, SZ, n);
      if (area < 6) {
        skip[i] = 2;
        continue;
      }
      let H = Math.max(3, P.heightDm[i] * 0.1);
      const minH = P.minHeightDm[i] * 0.1;
      const pr = principal(SX, SZ, n);
      const elong = pr.L / Math.max(1, pr.W);
      const r0 = hash01(i, 1), r1 = hash01(i, 2), r2 = hash01(i, 3), r3 = hash01(i, 4);
      const st = classify(P.kind[i], H, area, elong, r0, P.style ? P.style[i] : 0);
      const sp = STYLE_P[st];
      // 临街：任一足够长的边中点距主干道路缘 < 16 m
      let street = false;
      if (R && st !== STYLE.INDUS && st !== STYLE.HIST) {
        // 快速排除：质心附近没有道路，或最近道路比“半径 + 16 m”还远
        let rad0 = 0;
        for (let j = 0; j < n; j++) rad0 = Math.max(rad0, Math.abs(SX[j] - P.anchorX[i]) + Math.abs(SZ[j] - P.anchorZ[i]));
        roadDist(R, P.anchorX[i], P.anchorZ[i], rd);
        const far = rd.d === Infinity ? rad0 < 24 : rd.d > rad0 + 16;
        for (let j = 0; j < n && !street && !far; j++) {
          const k = (j + 1) % n;
          if (Math.hypot(SX[k] - SX[j], SZ[k] - SZ[j]) < 5) continue;
          roadDist(R, (SX[j] + SX[k]) * 0.5, (SZ[j] + SZ[k]) * 0.5, rd);
          if (rd.d < 16) street = true;
        }
      }
      let ph = sp.ph;
      if (H < 5 || area < 40) ph = 0;
      else if (H < 9) ph = Math.min(ph, 0.7);
      let gf, fh;
      if (st === STYLE.INDUS) {
        gf = fh = H;
      } else {
        fh = sp.fh[0] + (sp.fh[1] - sp.fh[0]) * r1;
        gf = street ? sp.gfShop : sp.gf[0] + (sp.gf[1] - sp.gf[0]) * r2;
        if (H < gf + fh * 0.8) gf = Math.max(2.8, Math.min(gf, H - ph - 0.3));
        // 调整层高，使顶层恰好收于女儿墙下
        const avail = H - ph - 0.3 - gf;
        if (avail > fh * 0.8) {
          const nf = Math.max(1, Math.round(avail / fh));
          const f2 = avail / nf;
          if (f2 > fh * 0.88 && f2 < fh * 1.12) fh = f2;
        }
      }
      // 色彩
      // 老旧：1990s 以前的楼，或年代未知的多层/城中村
      const age = P.style ? P.style[i] & 15 : 0;
      const old = age === 1 || age === 2 || ((st === STYLE.MID || st === STYLE.VILLAGE) && age !== 4 && age !== 5) ? 1 : 0;
      const col = hexRGB(pick(PAL[st], r3));
      let acc = hexRGB(pick(ACC[st], hash01(i, 5)));
      let glass;
      if (st === STYLE.GLASS || st === STYLE.STONE) glass = hexRGB(pick(GLASS_CW, hash01(i, 6)));
      else if (st === STYLE.VILLAGE && hash01(i, 7) < 0.45) glass = hexRGB(pick(GLASS_BLUE, hash01(i, 6)));
      else if (st === STYLE.COMM) glass = hexRGB(pick(GLASS_CW, hash01(i, 6)));
      else glass = hexRGB(pick(GLASS_RES, hash01(i, 6)));
      const variant = Math.floor(hash01(i, 8) * 8) & 7;
      const tall = H >= 100 ? 1 : 0;
      const flags = (street ? 1 : 0) | (variant << 1) | (old << 4) | (tall << 5);
      styleA[i] = st;
      fhA[i] = fh;
      gfA[i] = gf;
      phA[i] = ph;
      hA[i] = H;
      flagA[i] = flags;
      colA[i] = packRGB(col);
      accA[i] = packRGB(acc);
      stat.styles[st]++;
      // 数据纹理
      const t = i * 16;
      const seed = Math.floor(hash01(i, 9) * 16777216) / 16777216;
      tex[t] = ga[i];
      tex[t + 1] = H;
      tex[t + 2] = fh;
      tex[t + 3] = st;
      tex[t + 4] = s2l(col[0]);
      tex[t + 5] = s2l(col[1]);
      tex[t + 6] = s2l(col[2]);
      tex[t + 7] = seed;
      tex[t + 8] = gf;
      tex[t + 9] = ph;
      tex[t + 10] = packRGB(acc);
      tex[t + 11] = flags;
      let rad = 0;
      for (let j = 0; j < n; j++) rad = Math.max(rad, Math.hypot(SX[j] - P.anchorX[i], SZ[j] - P.anchorZ[i]));
      tex[t + 12] = P.anchorX[i];
      tex[t + 13] = P.anchorZ[i];
      tex[t + 14] = rad;
      tex[t + 15] = packRGB(glass);
      // 航空障碍灯（≥ 100 m）：屋顶四角 + 中心
      if (tall && minH < 1) {
        stat.tall++;
        const yTop = ga[i] + H + 0.7;
        const cs = [[pr.s0, pr.t0], [pr.s1, pr.t0], [pr.s1, pr.t1], [pr.s0, pr.t1]];
        const ph0 = hash01(i, 10);
        for (const [s, tt] of cs) {
          // 角点往中心收 1 m
          const sc = (pr.s0 + pr.s1) / 2, tc = (pr.t0 + pr.t1) / 2;
          const s2 = s + Math.sign(sc - s) * 1.0, t2 = tt + Math.sign(tc - tt) * 1.0;
          const x = s2 * pr.ux - t2 * pr.uz, z = s2 * pr.uz + t2 * pr.ux;
          lights.push(x, yTop, z, ph0);
        }
      }
      // 分块
      const cx = Math.floor(P.anchorX[i] / CHUNK), cz = Math.floor(P.anchorZ[i] / CHUNK);
      const ck = cx + ',' + cz;
      let cl = chunkLists.get(ck);
      if (!cl) chunkLists.set(ck, (cl = { cx, cz, list: [] }));
      cl.list.push(i);
    }

    // —— 第二遍：远景几何（按大块） ——
    for (const cl of chunkLists.values()) {
      const bx = Math.floor(cl.cx / BLOCK_N), bz = Math.floor(cl.cz / BLOCK_N);
      const bk = bx + ',' + bz;
      let b = blocks.get(bk);
      if (!b) blocks.set(bk, (b = { bx, bz, chunks: [] }));
      b.chunks.push(cl);
    }
    const blockOut = [];
    const transfer = [];
    for (const b of blocks.values()) {
      const ox = b.bx * BLOCK - LO_MARGIN, oz = b.bz * BLOCK - LO_MARGIN;
      const V = new Grow(Uint16Array, 1 << 14), I = new Grow(Uint32Array, 1 << 14), IF = new Grow(Uint32Array, 1 << 13);
      // 小块按块内 Morton（Z 序）排列
      const mort = (cl) => {
        const lx = cl.cx - b.bx * BLOCK_N, lz = cl.cz - b.bz * BLOCK_N;
        let m = 0;
        for (let k = 0; k < 4; k++) m |= (((lx >> k) & 1) << (2 * k)) | (((lz >> k) & 1) << (2 * k + 1));
        return m;
      };
      b.chunks.sort((a, c) => mort(a) - mort(c));
      const chunks = [];
      for (const cl of b.chunks) {
        const i0 = I.n, f0 = IF.n;
        const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (const i of cl.list) writeLo(i, V, I, ox, oz, bb, IF);
        if (I.n > i0)
          chunks.push({
            cx: cl.cx, cz: cl.cz, slot: (cl.cx - b.bx * BLOCK_N) + (cl.cz - b.bz * BLOCK_N) * BLOCK_N,
            start: i0, count: I.n - i0, fstart: f0, fcount: IF.n - f0, bounds: bb, n: cl.list.length,
          });
      }
      if (!I.n) continue;
      const vb = V.out(), ib = I.out(), fb = IF.out();
      stat.loVerts += vb.length / LO_STRIDE;
      stat.loTris += ib.length / 3;
      stat.farTris = (stat.farTris || 0) + fb.length / 3;
      transfer.push(vb.buffer, ib.buffer, fb.buffer);
      blockOut.push({ bx: b.bx, bz: b.bz, ox, oz, vbuf: vb, ibuf: ib, fibuf: fb, chunks });
    }
    stat.ms = Math.round(performance.now() - t0);
    const lightArr = new Float32Array(lights);
    transfer.push(tex.buffer, lightArr.buffer);
    return {
      msg: { type: 'init', ok: true, version: P.version, count: N, tex, texRows: tex.length / (TEX_W * 4), blocks: blockOut, lights: lightArr, stat },
      transfer,
    };
  }

  function bottomY(i) {
    const minH = P.minHeightDm[i] * 0.1;
    return minH > 0.5 ? ga[i] + minH : base[i] - 0.8;
  }

  /**
   * 远景：外墙共享角点（2(n+1) 顶点），屋面用顶环。
   * IF：超远景索引子集——只含“显眼”的建筑（高 ≥ 15 m 或占地 ≥ 600 m²），更远处小房子由卫星影像表现。
   */
  function writeLo(i, V, I, ox, oz, bb, IF) {
    if (skip[i]) return;
    let n = decodeRing(P, i, SX, SZ);
    if (n < 3) return;
    n = simplifyRing(SX, SZ, n, hA[i] > 40 ? 2 : 6);
    const iStart = I.n;
    const major = hA[i] >= 15 || ringArea(SX, SZ, n) >= 600;
    const yb = bottomY(i), yt = ga[i] + hA[i];
    const id = i;
    const lo = id & 0xffff, hi = id >>> 16;
    const v0 = V.n / LO_STRIDE;
    V.reserve((n + 1) * 2 * LO_STRIDE);
    const a = V.a;
    let u = 0;
    const Yb = Math.round(yb * 10), Yt = Math.round(yt * 10);
    for (let ring = 0; ring < 2; ring++) {
      u = 0;
      for (let j = 0; j <= n; j++) {
        const k = j % n;
        if (j > 0) u += Math.hypot(SX[k] - SX[j - 1], SZ[k] - SZ[j - 1]);
        const X = Math.round((SX[k] - ox) * LO_QXZ), Z = Math.round((SZ[k] - oz) * LO_QXZ);
        const o = V.n;
        a[o] = X < 0 ? 0 : X > 65535 ? 65535 : X;
        a[o + 1] = ring ? Yt : Yb;
        a[o + 2] = Z < 0 ? 0 : Z > 65535 ? 65535 : Z;
        a[o + 3] = Math.round(u * 10) & 0xffff;
        a[o + 4] = lo;
        a[o + 5] = hi;
        V.n += LO_STRIDE;
        if (ring) {
          if (SX[k] < bb[0]) bb[0] = SX[k];
          if (SX[k] > bb[3]) bb[3] = SX[k];
          if (SZ[k] < bb[2]) bb[2] = SZ[k];
          if (SZ[k] > bb[5]) bb[5] = SZ[k];
        }
      }
    }
    if (yb < bb[1]) bb[1] = yb;
    if (yt > bb[4]) bb[4] = yt;
    const b0 = v0, t0 = v0 + n + 1;
    I.reserve(n * 6 + (n - 2) * 3);
    for (let j = 0; j < n; j++) {
      I.a[I.n++] = b0 + j; I.a[I.n++] = t0 + j; I.a[I.n++] = b0 + j + 1;
      I.a[I.n++] = b0 + j + 1; I.a[I.n++] = t0 + j; I.a[I.n++] = t0 + j + 1;
    }
    roofTris(SX, SZ, n, t0, I);
    if (IF && major) {
      const k = I.n - iStart;
      IF.reserve(k);
      IF.a.set(I.a.subarray(iStart, I.n), IF.n);
      IF.n += k;
    }
  }

  const flat = [];
  function roofTris(xs, zs, n, base0, I) {
    flat.length = n * 2;
    const cx = xs[0], cz = zs[0];
    for (let j = 0; j < n; j++) {
      flat[j * 2] = xs[j] - cx;
      flat[j * 2 + 1] = zs[j] - cz;
    }
    const tri = n === 3 ? [0, 1, 2] : n === 4 ? null : earcut(flat, null, 2);
    const tris = tri || [0, 1, 2, 0, 2, 3];
    I.reserve(tris.length);
    for (let k = 0; k < tris.length; k += 3) {
      let a = tris[k], b = tris[k + 1], c = tris[k + 2];
      const x1 = xs[b] - xs[a], z1 = zs[b] - zs[a], x2 = xs[c] - xs[a], z2 = zs[c] - zs[a];
      if (z1 * x2 - x1 * z2 < 0) {
        const t = b; b = c; c = t;
      } // 保证朝上
      I.a[I.n++] = base0 + a;
      I.a[I.n++] = base0 + b;
      I.a[I.n++] = base0 + c;
    }
  }

  /** 近景小块：外墙逐边独立顶点 + 女儿墙 + 屋面 + 屋顶构件 */
  function hiChunk(msg) {
    const cl = chunkLists.get(msg.key);
    if (!cl) return { msg: { type: 'hi', key: msg.key, empty: true } };
    const ox = cl.cx * CHUNK - HI_MARGIN, oz = cl.cz * CHUNK - HI_MARGIN;
    const V = new Grow(Uint16Array, 1 << 15), I = new Grow(Uint32Array, 1 << 15);
    const props = new Grow(Float32Array, 1 << 12);
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const i of cl.list) {
      if (skip[i]) continue;
      const n = decodeRing(P, i, SX, SZ);
      if (n < 3) continue;
      writeHi(i, n, V, I, ox, oz, bb);
      roofProps(i, n, props);
    }
    const vb = V.out(), ib = I.out(), pb = props.out();
    return {
      msg: { type: 'hi', key: msg.key, cx: cl.cx, cz: cl.cz, ox, oz, vbuf: vb, ibuf: ib, props: pb, bounds: bb },
      transfer: [vb.buffer, ib.buffer, pb.buffer],
    };
  }

  function writeHi(i, n, V, I, ox, oz, bb) {
    const yb = bottomY(i), yt = ga[i] + hA[i];
    const ph = phA[i];
    const yr = yt - ph;
    const lo = i & 0xffff, hi = i >>> 16;
    const par = ph > 0.05;
    if (par) insetRing(SX, SZ, n, 0.25, QX, QZ);
    const Yb = Math.round(yb * 10), Yt = Math.round(yt * 10), Yr = Math.round(yr * 10);
    const v0 = V.n / HI_STRIDE;
    const per = par ? 8 : 4;
    V.reserve(n * per * HI_STRIDE);
    const a = V.a;
    const put = (x, y, z, u, len, meta) => {
      const o = V.n;
      const X = Math.round((x - ox) * 10), Z = Math.round((z - oz) * 10);
      a[o] = X < 0 ? 0 : X > 65535 ? 65535 : X;
      a[o + 1] = y;
      a[o + 2] = Z < 0 ? 0 : Z > 65535 ? 65535 : Z;
      a[o + 3] = u;
      a[o + 4] = len;
      a[o + 5] = lo;
      a[o + 6] = hi;
      a[o + 7] = meta;
      V.n += HI_STRIDE;
    };
    const street = flagA[i] & 1;
    for (let e = 0; e < n; e++) {
      const k = (e + 1) % n;
      const dx = SX[k] - SX[e], dz = SZ[k] - SZ[e];
      const L = Math.hypot(dx, dz);
      const nx = dz / L, nz = -dx / L; // 外法线
      let ang = Math.round((Math.atan2(nz, nx) / (Math.PI * 2)) * 256);
      ang = ((ang % 256) + 256) % 256;
      let sf = 0;
      if (street && L >= 3 && R) {
        roadDist(R, (SX[e] + SX[k]) * 0.5 + nx * 2, (SZ[e] + SZ[k]) * 0.5 + nz * 2, rd);
        if (rd.d < 18) {
          const dl = Math.hypot(rd.dx, rd.dz) || 1;
          if ((rd.dx * nx + rd.dz * nz) / dl > 0.25) sf = 1;
        }
      }
      const meta = ang | ((e & 31) << 8) | (sf << 13);
      const Ld = Math.min(65535, Math.round(L * 10));
      put(SX[e], Yb, SZ[e], 0, Ld, meta);
      put(SX[k], Yb, SZ[k], Ld, Ld, meta);
      put(SX[e], Yt, SZ[e], 0, Ld, meta);
      put(SX[k], Yt, SZ[k], Ld, Ld, meta);
      if (par) {
        const metaIn = (((ang + 128) % 256) | ((e & 31) << 8) | (1 << 14));
        put(QX[e], Yt, QZ[e], 0, Ld, metaIn);
        put(QX[k], Yt, QZ[k], Ld, Ld, metaIn);
        put(QX[e], Yr, QZ[e], 0, Ld, metaIn);
        put(QX[k], Yr, QZ[k], Ld, Ld, metaIn);
      }
      if (SX[e] < bb[0]) bb[0] = SX[e];
      if (SX[e] > bb[3]) bb[3] = SX[e];
      if (SZ[e] < bb[2]) bb[2] = SZ[e];
      if (SZ[e] > bb[5]) bb[5] = SZ[e];
    }
    if (yb < bb[1]) bb[1] = yb;
    if (yt > bb[4]) bb[4] = yt;
    I.reserve(n * (par ? 18 : 6) + n * 3);
    const A = I.a;
    for (let e = 0; e < n; e++) {
      const o = v0 + e * per;
      const A0 = o, B0 = o + 1, A1 = o + 2, B1 = o + 3;
      A[I.n++] = A0; A[I.n++] = A1; A[I.n++] = B0;
      A[I.n++] = B0; A[I.n++] = A1; A[I.n++] = B1;
      if (par) {
        const a2 = o + 4, b2 = o + 5, a3 = o + 6, b3 = o + 7;
        // 女儿墙内侧（朝内）
        A[I.n++] = a3; A[I.n++] = b3; A[I.n++] = a2;
        A[I.n++] = b3; A[I.n++] = b2; A[I.n++] = a2;
        // 压顶（朝上）
        A[I.n++] = A1; A[I.n++] = a2; A[I.n++] = B1;
        A[I.n++] = B1; A[I.n++] = a2; A[I.n++] = b2;
      }
    }
    // 屋面：用每条边起点的顶点（女儿墙内侧底 a3 或外墙顶 A1）
    const xs = par ? QX : SX, zs = par ? QZ : SZ;
    flat.length = n * 2;
    for (let j = 0; j < n; j++) {
      flat[j * 2] = xs[j] - xs[0];
      flat[j * 2 + 1] = zs[j] - zs[0];
    }
    const tris = n === 3 ? [0, 1, 2] : earcut(flat, null, 2);
    const off = par ? 6 : 2;
    I.reserve(tris.length);
    for (let k = 0; k < tris.length; k += 3) {
      let p = tris[k], q = tris[k + 1], r = tris[k + 2];
      const x1 = xs[q] - xs[p], z1 = zs[q] - zs[p], x2 = xs[r] - xs[p], z2 = zs[r] - zs[p];
      if (z1 * x2 - x1 * z2 < 0) {
        const t = q; q = r; r = t;
      }
      I.a[I.n++] = v0 + p * per + off;
      I.a[I.n++] = v0 + q * per + off;
      I.a[I.n++] = v0 + r * per + off;
    }
  }

  // 屋顶构件：type 0 盒体（机房/楼梯间/彩钢棚/通风器） 1 水箱 2 空调机组 3 太阳能热水器
  function roofProps(i, n, out) {
    const H = hA[i];
    if (H < 8 || phA[i] < 0.05) return;
    const st = styleA[i];
    const area = ringArea(SX, SZ, n);
    if (area < 90) return;
    insetRing(SX, SZ, n, 0.9, QX, QZ);
    const pr = principal(QX, QZ, n);
    if (pr.W < 5 || pr.L < 6) return;
    const yr = ga[i] + H - phA[i];
    const sc = (pr.s0 + pr.s1) / 2, tc = (pr.t0 + pr.t1) / 2;
    const rot = -pr.ang;
    const col = colA[i];
    const dark = (c, k) => {
      const r = Math.round(((c >> 16) & 255) * k), g = Math.round(((c >> 8) & 255) * k), b = Math.round((c & 255) * k);
      return r * 65536 + g * 256 + b;
    };
    const at = (s, t) => [s * pr.ux - t * pr.uz, s * pr.uz + t * pr.ux];
    const push = (type, s, t, y, sx, sy, sz, r, color, needInside = true) => {
      const [x, z] = at(s, t);
      if (needInside && !pointInRing(x, z, QX, QZ, n)) return false;
      out.reserve(9);
      out.a.set([type, x, y, z, sx, sy, sz, r, color], out.n);
      out.n += 9;
      return true;
    };
    const rnd = (k) => hash01(i, 100 + k);
    const L = pr.L, W = pr.W;
    if (st === STYLE.TOWER || (H >= 45 && (st === STYLE.HOTEL))) {
      // 电梯机房/楼梯间（1~2 组），可能带水箱
      const cores = L > 34 ? 2 : 1;
      for (let c = 0; c < cores; c++) {
        const s = sc + (cores === 2 ? (c ? L / 4 : -L / 4) : (rnd(1) - 0.5) * L * 0.15);
        const sx = Math.min(7.5, L * (cores === 2 ? 0.2 : 0.32)), sz = Math.min(5.5, W * 0.45), sy = 3.3 + rnd(2) * 1.2;
        if (push(0, s, tc, yr, sx, sy, sz, rot, dark(col, 0.92)) && rnd(3 + c) < 0.45)
          push(1, s + (rnd(5) - 0.5) * sx * 0.4, tc, yr + sy, 1.4, 2.2, 1.4, 0, 0xc9ccd0);
      }
      if (H >= 60 && rnd(6) < 0.4) {
        // 塔冠装饰构架
        push(0, sc, tc, yr + 3.8, Math.min(L * 0.5, 12), 0.35, Math.min(W * 0.6, 8), rot, accA[i]);
      }
    } else if (st === STYLE.MID) {
      const ns = Math.max(1, Math.round(L / 15));
      for (let c = 0; c < ns; c++) {
        const s = pr.s0 + (L * (c + 0.5)) / ns;
        push(0, s, pr.t0 + Math.min(2.2, W * 0.3), yr, 2.8, 2.7, 3.4, rot, dark(col, 0.95));
      }
      // 太阳能热水器（朝南）
      const m = Math.floor(rnd(7) * Math.min(8, L / 5));
      for (let c = 0; c < m; c++) {
        const s = pr.s0 + 1.5 + rnd(10 + c) * (L - 3), t = pr.t0 + 1.5 + rnd(30 + c) * (W - 3);
        push(3, s, t, yr, 1.0, 1.0, 1.0, 0, 0xffffff);
      }
      if (rnd(8) < 0.22) {
        // 彩钢棚（蓝）
        const sx = L * (0.25 + rnd(9) * 0.3), s = pr.s0 + sx / 2 + rnd(11) * (L - sx);
        push(0, s, tc, yr, sx, 2.4, W * 0.75, rot, rnd(12) < 0.75 ? 0x3d6fb0 : 0xb8bcc0);
      }
      if (rnd(13) < 0.35) push(1, pr.s0 + 2 + rnd(14) * (L - 4), tc, yr, 1.2, 1.3, 1.2, 0, rnd(15) < 0.5 ? 0x3a70b4 : 0xd8d8d4);
    } else if (st === STYLE.VILLAGE) {
      push(0, pr.s0 + Math.min(2, L * 0.25), pr.t0 + Math.min(1.8, W * 0.3), yr, 2.4, 2.6, 3.0, rot, dark(col, 0.9));
      const m = 1 + Math.floor(rnd(7) * 3);
      for (let c = 0; c < m; c++) push(1, pr.s0 + 1 + rnd(20 + c) * (L - 2), pr.t0 + 1 + rnd(40 + c) * (W - 2), yr, 1.1, 1.1, 1.1, 0, rnd(50 + c) < 0.55 ? 0x2f6db5 : 0xdcdcd6);
      if (rnd(9) < 0.4) push(3, sc, tc, yr, 1.0, 1.0, 1.0, 0, 0xffffff);
      if (rnd(10) < 0.18) push(0, sc, tc, yr, L * 0.6, 2.3, W * 0.7, rot, 0x3d6fb0);
    } else if (st === STYLE.INDUS) {
      const nv = Math.floor(L / 9);
      for (let c = 0; c < nv; c++) push(0, pr.s0 + 4.5 + c * 9, tc, yr, 1.2, 0.9, 1.2, rot, 0x9ea3a8);
    } else {
      // 办公/商业/公共/酒店：机房 + 空调机组阵列
      const sx = Math.min(12, L * 0.28), sz = Math.min(8, W * 0.4);
      push(0, sc - L * 0.18, tc, yr, sx, 3.8, sz, rot, dark(col, 0.9));
      const rows = Math.min(2, Math.max(1, Math.floor(W / 9)));
      const cols = Math.min(5, Math.max(1, Math.floor(L / 11)));
      for (let a = 0; a < rows; a++)
        for (let c = 0; c < cols; c++) {
          if (rnd(60 + a * 7 + c) < 0.3) continue;
          push(2, sc + L * 0.08 + c * 3.2, tc + (a - (rows - 1) / 2) * 2.6, yr, 2.6, 1.7, 1.3, rot, 0xd4d6d6);
        }
      if (area > 3000 && rnd(16) < 0.5) push(1, sc + L * 0.3, tc, yr, 2.2, 3.0, 2.2, 0, 0xbfc3c8);
    }
  }

  return {
    handle(msg) {
      if (msg.type === 'init') return init(msg);
      if (msg.type === 'hi') return hiChunk(msg);
      return { msg: { type: 'noop' } };
    },
  };
}
