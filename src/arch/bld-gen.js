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
//   · 小区风貌覆盖（public/data/estates_style.json，tools/build_estates.py 按档案与实景照片生成）：
//     锚点落在有照片依据的小区多边形内的住宅楼，按“高度÷3 m”估层数选档位（≤3 / 4–7 / 8–11 / ≥12 层）套用 style：
//     墙色/点缀色写进数据纹理，style 编号写进 flags（bit 6–13，着色器据此查 uEst 参数纹理），层高调到 2.9–3.0 m 使层数与真实一致；
//     屋顶附属几何（坡屋顶、Art Deco 收分塔冠、檐口 + 中部升起、坡檐）随楼体写进远景/近景几何，装饰构架走屋顶构件实例。
//     只改风貌与细节，不改轮廓与楼高（坡屋顶/塔冠加在女儿墙顶以上，同现有屋顶机房的处理）。
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

// ———— 小区风貌（estates_style.json 的数值编码，见 tools/build_estates.py ENUMS） ————
export const EST_SCHEME = { GENERIC: 0, MODERN: 1, NEO: 2, DECO: 3, BRICK: 4, OLD: 5, NC: 6, VILLA: 7 };
export const EST_ROOF = { FLAT: 0, HIP: 1, STEEP: 2, MANSARD: 3, DECO: 4, CORNICE: 5, FRAME: 6 };
export const EST_TEXELS = 4; // 每种 style 占 4 个 RGBA32F texel
const EST_FLAG_SHIFT = 6; // flags bit 6–13：style 编号（0 = 不覆盖）
export const EST_PITCHED = 1 << 14; // flags bit 14：本楼加了坡屋面
const hexPack = (h) => (h ? packRGB(hexRGB(h)) : -1);

/**
 * 小区 style → 着色器参数纹理数据（RGBA32F，宽 = (最大 id + 1) × 4，高 1）：
 *   t0 = 风格 饰面 阳台 竖向构件；t1 = 基座层数 顶部层数 腰线周期 标志(1 窗套 2 飘窗 4 防盗网)；
 *   t2 = 线脚色 基座色 顶部色 腰线色；t3 = 窗框色(-1 默认) 玻璃色 第二点缀色 开间组合周期（颜色为 sRGB 打包整数）
 */
export function packEstateStyles(styles) {
  let maxId = 0;
  for (const s of styles || []) maxId = Math.max(maxId, s.id | 0);
  const W = (maxId + 1) * EST_TEXELS;
  const a = new Float32Array(Math.max(1, W) * 4);
  for (const s of styles || []) {
    const o = (s.id | 0) * EST_TEXELS * 4;
    a.set([s.scheme | 0, s.finish | 0, s.balcony | 0, s.vstrip | 0], o);
    a.set([s.base | 0, s.crown | 0, s.band | 0, s.flags | 0], o + 4);
    a.set([hexPack(s.trim), hexPack(s.basec), hexPack(s.crownc), hexPack(s.bandc)], o + 8);
    a.set([hexPack(s.frame), hexPack(s.glass || '#3a4a4c'), hexPack(s.accent2), Math.max(1, s.P | 0)], o + 12);
  }
  return { data: a, width: Math.max(1, W) };
}

/** 解析小区风貌数据：多边形网格索引 + 档位 → style + 卫星逐栋屋面 */
function prepareEstates(doc, P) {
  if (!doc || !Array.isArray(doc.estates) || !Array.isArray(doc.styles)) return null;
  const styles = new Map();
  for (const s of doc.styles) styles.set(s.id | 0, s);
  const CELL = 500;
  const grid = new Map();
  const list = [];
  let anchorMap = null;
  const byAnchor = (x, z) => {
    if (!anchorMap) {
      anchorMap = new Map();
      for (let i = 0; i < P.count; i++) anchorMap.set(Math.round(P.anchorX[i] * 20) + ',' + Math.round(P.anchorZ[i] * 20), i);
    }
    return anchorMap.get(Math.round(x * 20) + ',' + Math.round(z * 20));
  };
  for (const e of doc.estates) {
    const rules = e.rules || {};
    if (!e.polys || !e.polys.length || !Object.keys(rules).length) continue;
    const polys = e.polys.map((p) => Float64Array.from(p));
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of polys)
      for (let k = 0; k < p.length; k += 2) {
        x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]);
        z0 = Math.min(z0, p[k + 1]); z1 = Math.max(z1, p[k + 1]);
      }
    // 卫星逐栋屋面：[下标, 锚点 x, z, 颜色, 是否红瓦]；下标对不上（buildings.bin 重排）时按锚点找
    const roofs = new Map();
    for (const r of e.roofs || []) {
      let i = r[0] | 0;
      if (!(i < P.count && Math.abs(P.anchorX[i] - r[1]) < 0.06 && Math.abs(P.anchorZ[i] - r[2]) < 0.06)) i = byAnchor(r[1], r[2]);
      if (i !== undefined && i >= 0) roofs.set(i, { col: packRGB(hexRGB(r[3])), red: !!r[4] });
    }
    const E = { name: e.name, polys, rules, roofs, year: e.year | 0 };
    const id = list.length;
    list.push(E);
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++)
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        const k = cx * 100003 + cz;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(id);
      }
  }
  if (!list.length) return null;
  const inPoly = (x, z, p) => {
    let c = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
    }
    return c;
  };
  return {
    styles,
    list,
    /** 锚点所在小区（无则 null） */
    find(x, z) {
      const l = grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
      if (!l) return null;
      for (const id of l) for (const p of list[id].polys) if (inPoly(x, z, p)) return list[id];
      return null;
    },
  };
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
  let EST = null, estSid, estRoof, estRoofCol, estFloors;
  const rd = { d: 0, dx: 0, dz: 0 };

  /**
   * 小区风貌：返回 {sid, s(style), roof, roofCol, floors} 或 null（不覆盖）。
   * 只对住宅/未知功能、通用分类为住宅类（塔楼/多层/自建房）的楼生效；会所、学校、底商等其他功能的楼保持通用规则。
   */
  function estateOf(i, st, H, area) {
    if (!EST || area < 40 || H < 4) return null;
    const k = P.kind[i];
    if (k !== 0 && k !== 1) return null;
    // CMAB 功能为办公/商业/工业/公共的楼（底商、会所、学校等）保持通用；功能未知的楼在住宅小区多边形里按住宅处理
    // （通用分类会把一部分功能未知的高层随机归成玻璃幕墙/石材办公，小区里不对）
    const fn = P.style ? P.style[i] >> 4 : 0;
    if (fn >= 5) return null;
    if (k === 1 && st !== STYLE.TOWER && st !== STYLE.MID && st !== STYLE.VILLAGE) return null;
    if (st === STYLE.INDUS || st === STYLE.COMM || st === STYLE.HIST || st === STYLE.HOTEL) return null; // 大体量低层（车库、会所、商业）
    const E = EST.find(P.anchorX[i], P.anchorZ[i]);
    if (!E) return null;
    const floors = Math.max(1, Math.round(H / 3.0));
    const cls = floors <= 3 ? 'low' : floors <= 7 ? 'mid' : floors <= 11 ? 'mh' : 'high';
    const sid = E.rules[cls] | 0;
    const s = sid ? EST.styles.get(sid) : null;
    if (!s) return null;
    const sat = E.roofs.get(i);
    let roof = s.roof | 0;
    const pitchedRule = roof === EST_ROOF.HIP || roof === EST_ROOF.STEEP || roof === EST_ROOF.MANSARD;
    // 卫星“只对红瓦楼加坡顶”：取样不是红瓦的楼不加；风格为通用（只改屋面）的，整栋不覆盖
    if (s.sat === 2 && !(sat && sat.red)) {
      if (!s.scheme) return null;
      if (pitchedRule) roof = EST_ROOF.FLAT;
    }
    // 塔冠/构架只加在小高层以上；檐口+中部升起只加在多层以上
    if ((roof === EST_ROOF.DECO || roof === EST_ROOF.FRAME) && floors < 8) roof = EST_ROOF.FLAT;
    if (roof === EST_ROOF.CORNICE && floors < 4) roof = EST_ROOF.FLAT;
    const roofCol = sat ? sat.col : s.roofc ? packRGB(hexRGB(s.roofc)) : 0x8a4a3a;
    return { sid, s, roof, roofCol, floors, E };
  }

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
    flagA = new Uint32Array(N);
    colA = new Uint32Array(N);
    accA = new Uint32Array(N);
    EST = prepareEstates(msg.estates, P);
    estSid = new Uint8Array(N);
    estRoof = new Uint8Array(N);
    estRoofCol = new Uint32Array(N);
    estFloors = new Uint8Array(N);
    const tex = new Float32Array(Math.ceil(N / 1024) * TEX_W * 4);
    const lights = [];
    const blocks = new Map();
    chunkLists = new Map();
    const stat = { built: 0, skipped: 0, styles: new Array(10).fill(0), tall: 0, loVerts: 0, loTris: 0, estates: 0, estRoofs: 0, estNames: new Set() };

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
      let st = classify(P.kind[i], H, area, elong, r0, P.style ? P.style[i] : 0);
      // —— 小区风貌覆盖：楼型按层数重新归档（小区里的 3 层楼是联排/别墅，不是城中村自建房） ——
      const es = estateOf(i, st, H, area);
      if (es && es.s.scheme) st = es.floors >= 8 ? STYLE.TOWER : STYLE.MID;
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
      // 小区风貌：坡屋面不设女儿墙；层高按真实层数调到 2.9–3.0 m 左右（楼高已按成交记录层数 × 3.0 m 修正）
      const estPitched = !!es && (es.roof === EST_ROOF.HIP || es.roof === EST_ROOF.STEEP || es.roof === EST_ROOF.MANSARD);
      if (estPitched) ph = 0;
      if (es && es.s.scheme && st !== STYLE.INDUS) {
        gf = street ? sp.gfShop : st === STYLE.TOWER ? 3.3 : 3.0;
        if (H < gf + 2.4) gf = Math.max(2.8, Math.min(gf, H - ph - 0.3));
        const avail = H - ph - 0.3 - gf;
        if (avail > 2.0) {
          const nf = Math.max(1, Math.round(avail / (es.s.fh || 2.95)));
          fh = Math.min(3.3, Math.max(2.7, avail / nf));
        } else fh = 2.95;
      }
      // 色彩
      // 老旧：1990s 以前的楼，或年代未知的多层/城中村
      const age = P.style ? P.style[i] & 15 : 0;
      let old = age === 1 || age === 2 || ((st === STYLE.MID || st === STYLE.VILLAGE) && age !== 4 && age !== 5) ? 1 : 0;
      let col = hexRGB(pick(PAL[st], r3));
      let acc = hexRGB(pick(ACC[st], hash01(i, 5)));
      let glass;
      if (st === STYLE.GLASS || st === STYLE.STONE) glass = hexRGB(pick(GLASS_CW, hash01(i, 6)));
      else if (st === STYLE.VILLAGE && hash01(i, 7) < 0.45) glass = hexRGB(pick(GLASS_BLUE, hash01(i, 6)));
      else if (st === STYLE.COMM) glass = hexRGB(pick(GLASS_CW, hash01(i, 6)));
      else glass = hexRGB(pick(GLASS_RES, hash01(i, 6)));
      if (es && es.s.scheme) {
        // 照片目测墙色/点缀色；几种外墙对应不到楼的（列表）按楼随机
        const ws = es.s.walls;
        if (ws && ws.length) col = hexRGB(ws[Math.min(ws.length - 1, Math.floor(hash01(i, 12) * ws.length))]);
        if (es.s.accent) acc = hexRGB(es.s.accent);
        old = es.s.scheme === EST_SCHEME.OLD || (es.E.year > 0 && es.E.year < 2000) ? 1 : 0;
      }
      const variant = Math.floor(hash01(i, 8) * 8) & 7;
      const tall = H >= 100 ? 1 : 0;
      let flags = (street ? 1 : 0) | (variant << 1) | (old << 4) | (tall << 5);
      if (es) {
        flags |= (es.sid & 255) << EST_FLAG_SHIFT;
        if (estPitched) flags |= EST_PITCHED;
        estSid[i] = es.sid;
        estRoof[i] = es.roof;
        estRoofCol[i] = es.roofCol;
        estFloors[i] = Math.min(255, es.floors);
        stat.estates++;
        if (estPitched) stat.estRoofs++;
        stat.estNames.add(es.E.name);
      }
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
      // 小区楼：玻璃色由 style 参数纹理给出，这一格改存坡屋面颜色
      tex[t + 15] = es ? (estPitched ? es.roofCol : packRGB(hexRGB(es.s.glass || '#3a4a4c'))) : packRGB(glass);
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
    stat.estNames = stat.estNames.size;
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
    if (!(flagA[i] & EST_PITCHED)) roofTris(SX, SZ, n, t0, I);
    if (estRoof[i]) estateExtras(i, SX, SZ, n, emitter(false, V, I, ox, oz, i, bb));
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

  // ═════════════ 小区屋顶附属几何（坡屋顶 / Art Deco 收分塔冠 / 檐口 + 中部升起 / 坡檐） ═════════════
  // 远景（lo）与近景（hi）顶点格式不同，统一用写出器：v() 写顶点，t() 写三角形并按期望朝向自动定向。
  // 近景墙面 meta 加 bit 15（附属几何），u/len 按每条边起算，着色器照常按开间处理（塔冠墙面在屋面标高以上，不开窗）。
  const EP = new Float64Array(3 * 8192);
  const clampU16 = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v);
  function emitter(hi, V, I, ox, oz, i, bb) {
    const S = hi ? HI_STRIDE : LO_STRIDE;
    const base0 = V.n / S;
    const lo16 = i & 0xffff, hi16 = i >>> 16;
    let nv = 0;
    return {
      v(x, y, z, u = 0, len = 0, meta = 0) {
        if (nv >= 8192) return base0 + nv - 1;
        V.reserve(S);
        const a = V.a, o = V.n;
        if (hi) {
          a[o] = clampU16(Math.round((x - ox) * 10));
          a[o + 1] = clampU16(Math.round(y * 10));
          a[o + 2] = clampU16(Math.round((z - oz) * 10));
          a[o + 3] = clampU16(Math.round(u * 10));
          a[o + 4] = clampU16(Math.round(len * 10));
          a[o + 5] = lo16;
          a[o + 6] = hi16;
          a[o + 7] = meta;
        } else {
          a[o] = clampU16(Math.round((x - ox) * LO_QXZ));
          a[o + 1] = clampU16(Math.round(y * 10));
          a[o + 2] = clampU16(Math.round((z - oz) * LO_QXZ));
          a[o + 3] = Math.round(u * 10) & 0xffff;
          a[o + 4] = lo16;
          a[o + 5] = hi16;
        }
        V.n += S;
        EP[nv * 3] = x;
        EP[nv * 3 + 1] = y;
        EP[nv * 3 + 2] = z;
        if (x < bb[0]) bb[0] = x;
        if (x > bb[3]) bb[3] = x;
        if (y < bb[1]) bb[1] = y;
        if (y > bb[4]) bb[4] = y;
        if (z < bb[2]) bb[2] = z;
        if (z > bb[5]) bb[5] = z;
        return base0 + nv++;
      },
      /** 三角形 a b c，(hx,hy,hz) 为期望的正面朝向 */
      t(a, b, c, hx, hy, hz) {
        const pa = (a - base0) * 3, pb = (b - base0) * 3, pc = (c - base0) * 3;
        const ux = EP[pb] - EP[pa], uy = EP[pb + 1] - EP[pa + 1], uz = EP[pb + 2] - EP[pa + 2];
        const wx = EP[pc] - EP[pa], wy = EP[pc + 1] - EP[pa + 1], wz = EP[pc + 2] - EP[pa + 2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        I.reserve(3);
        I.a[I.n++] = a;
        if (nx * hx + ny * hy + nz * hz < 0) {
          I.a[I.n++] = c;
          I.a[I.n++] = b;
        } else {
          I.a[I.n++] = b;
          I.a[I.n++] = c;
        }
      },
    };
  }
  const RX0 = new Float64Array(70000), RZ0 = new Float64Array(70000), RX1 = new Float64Array(70000), RZ1 = new Float64Array(70000);
  const D2R = Math.PI / 180;
  /** 竖直墙面四边形（x0,z0 → x1,z1 为正向环上的一条边，外法线 = (dz, -dx)） */
  function wallQuad(e, x0, z0, x1, z1, y0, y1, k) {
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 0.05 || y1 - y0 < 0.02) return;
    const nx = (z1 - z0) / L, nz = -(x1 - x0) / L;
    let ang = Math.round((Math.atan2(nz, nx) / (Math.PI * 2)) * 256);
    ang = ((ang % 256) + 256) % 256;
    const meta = ang | ((k & 31) << 8) | (1 << 15);
    const a = e.v(x0, y0, z0, 0, L, meta), b = e.v(x1, y0, z1, L, L, meta);
    const c = e.v(x0, y1, z0, 0, L, meta), d = e.v(x1, y1, z1, L, L, meta);
    e.t(a, c, b, nx, 0, nz);
    e.t(b, c, d, nx, 0, nz);
  }
  /** 水平多边形面（xs/zs 前 n 点），up=true 朝上 */
  function capPoly(e, xs, zs, n, y, up) {
    if (n < 3) return;
    flat.length = n * 2;
    for (let j = 0; j < n; j++) {
      flat[j * 2] = xs[j] - xs[0];
      flat[j * 2 + 1] = zs[j] - zs[0];
    }
    const tris = n === 3 ? [0, 1, 2] : earcut(flat, null, 2);
    const vi = new Array(n);
    for (let j = 0; j < n; j++) vi[j] = e.v(xs[j], y, zs[j]);
    for (let k = 0; k < tris.length; k += 3) e.t(vi[tris[k]], vi[tris[k + 1]], vi[tris[k + 2]], 0, up ? 1 : -1, 0);
  }
  /** 主轴坐标 (s,t) → 世界 (x,z) */
  const pAt = (pr, s, t, out) => {
    out[0] = s * pr.ux - t * pr.uz;
    out[1] = s * pr.uz + t * pr.ux;
    return out;
  };
  const _p = [0, 0];
  /** 主轴对齐矩形（中心 sc,tc，半边 hs,ht）的正向四角 → RX1/RZ1 */
  function rectRing(pr, sc, tc, hs, ht) {
    const cs = [[sc - hs, tc - ht], [sc + hs, tc - ht], [sc + hs, tc + ht], [sc - hs, tc + ht]];
    for (let k = 0; k < 4; k++) {
      pAt(pr, cs[k][0], cs[k][1], _p);
      RX1[k] = _p[0];
      RZ1[k] = _p[1];
    }
    let a = 0;
    for (let j = 0; j < 4; j++) {
      const k = (j + 1) % 4;
      a += RX1[j] * RZ1[k] - RX1[k] * RZ1[j];
    }
    if (a < 0) {
      let t = RX1[1]; RX1[1] = RX1[3]; RX1[3] = t;
      t = RZ1[1]; RZ1[1] = RZ1[3]; RZ1[3] = t;
    }
  }
  /** 主轴对齐矩形缩到轮廓以内（四角 + 四边中点都在环内），返回缩放系数（0 = 放不下） */
  function fitRect(xs, zs, n, pr, sc, tc, hs, ht) {
    let k = 1;
    for (let it = 0; it < 7; it++, k *= 0.84) {
      let ok = true;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
        pAt(pr, sc + a * hs * k, tc + b * ht * k, _p);
        if (!pointInRing(_p[0], _p[1], xs, zs, n)) {
          ok = false;
          break;
        }
      }
      if (ok) return k;
    }
    return 0;
  }
  /** 主轴对齐盒体（四面墙 + 顶面） */
  function rectBox(e, pr, sc, tc, hs, ht, y0, y1) {
    rectRing(pr, sc, tc, hs, ht);
    for (let k = 0; k < 4; k++) {
      const q = (k + 1) % 4;
      wallQuad(e, RX1[k], RZ1[k], RX1[q], RZ1[q], y0, y1, 20 + k);
    }
    const a = e.v(RX1[0], y1, RZ1[0]), b = e.v(RX1[1], y1, RZ1[1]), c = e.v(RX1[2], y1, RZ1[2]), d = e.v(RX1[3], y1, RZ1[3]);
    e.t(a, b, c, 0, 1, 0);
    e.t(a, c, d, 0, 1, 0);
  }
  /** 四坡顶（外接矩形 + 挑檐）：屋脊沿长向，坡度 pitch 度 */
  function hipRoof(e, pr, y0, pitch, over) {
    let a0 = pr.s0 - over, a1 = pr.s1 + over, b0 = pr.t0 - over, b1 = pr.t1 + over;
    let swap = false;
    if (b1 - b0 > a1 - a0) swap = true;
    const P2 = (s, t) => (swap ? pAt(pr, t, s, [0, 0]) : pAt(pr, s, t, [0, 0]));
    if (swap) [a0, a1, b0, b1] = [b0, b1, a0, a1];
    const hw = (b1 - b0) / 2, bc = (b0 + b1) / 2;
    const rise = Math.min(9, hw * Math.tan(pitch * D2R));
    const r0 = Math.min(a0 + hw, (a0 + a1) / 2), r1 = Math.max(a1 - hw, (a0 + a1) / 2);
    const pts = [P2(a0, b0), P2(a1, b0), P2(a1, b1), P2(a0, b1), P2(r0, bc), P2(r1, bc)];
    const v = pts.map((p, k) => e.v(p[0], k < 4 ? y0 : y0 + rise, p[1]));
    const [E00, E10, E11, E01, R0, R1] = v;
    e.t(E00, E10, R1, 0, 1, 0);
    e.t(E00, R1, R0, 0, 1, 0);
    e.t(E11, E01, R0, 0, 1, 0);
    e.t(E11, R0, R1, 0, 1, 0);
    e.t(E01, E00, R0, 0, 1, 0);
    e.t(E10, E11, R1, 0, 1, 0);
    // 檐下（挑檐底面）
    e.t(E00, E10, E11, 0, -1, 0);
    e.t(E00, E11, E01, 0, -1, 0);
    return rise;
  }
  /** 沿轮廓的“内缩坡顶”（非矩形轮廓）：外环（挑檐）→ 内缩 d 处升高 rise，顶面平 */
  function insetRoof(e, xs, zs, n, y0, d, rise, over) {
    insetRing(xs, zs, n, -over, RX0, RZ0);
    insetRing(xs, zs, n, d, RX1, RZ1);
    const vo = new Array(n), vi = new Array(n);
    for (let j = 0; j < n; j++) {
      vo[j] = e.v(RX0[j], y0, RZ0[j]);
      vi[j] = e.v(RX1[j], y0 + rise, RZ1[j]);
    }
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      e.t(vo[j], vo[k], vi[k], 0, 1, 0);
      e.t(vo[j], vi[k], vi[j], 0, 1, 0);
    }
    capPoly(e, RX1, RZ1, n, y0 + rise, true);
    capPoly(e, RX0, RZ0, n, y0, false);
  }
  /** 檐口：轮廓外扩 out 的一圈挑出线脚（y0–y1），顶/底为环形面 */
  function cornice(e, xs, zs, n, y0, y1, out) {
    insetRing(xs, zs, n, -out, RX0, RZ0);
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      wallQuad(e, RX0[j], RZ0[j], RX0[k], RZ0[k], y0, y1, j);
      const a = e.v(RX0[j], y1, RZ0[j]), b = e.v(RX0[k], y1, RZ0[k]), c = e.v(xs[k], y1, zs[k]), d = e.v(xs[j], y1, zs[j]);
      e.t(a, b, c, 0, 1, 0);
      e.t(a, c, d, 0, 1, 0);
      const a2 = e.v(RX0[j], y0, RZ0[j]), b2 = e.v(RX0[k], y0, RZ0[k]), c2 = e.v(xs[k], y0, zs[k]), d2 = e.v(xs[j], y0, zs[j]);
      e.t(a2, b2, c2, 0, -1, 0);
      e.t(a2, c2, d2, 0, -1, 0);
    }
  }

  /** 小区楼的屋顶附属几何（lo / hi 共用；xs/zs 为正向环） */
  function estateExtras(i, xs, zs, n, e) {
    const roof = estRoof[i];
    if (!roof || n < 3) return;
    const H = hA[i], yt = ga[i] + H, ph = phA[i], yr = yt - ph;
    const pr = principal(xs, zs, n);
    const L = pr.L, W = pr.W;
    if (L < 4 || W < 3) return;
    const sc = (pr.s0 + pr.s1) / 2, tc = (pr.t0 + pr.t1) / 2;
    if (roof === EST_ROOF.HIP || roof === EST_ROOF.STEEP) {
      // 坡屋顶：矩形度高用外接矩形四坡顶，否则沿轮廓内缩成坡
      const pitch = roof === EST_ROOF.STEEP ? 50 : estFloors[i] >= 8 ? 34 : 30;
      const rect = ringArea(xs, zs, n) / Math.max(1, L * W);
      if (rect >= 0.72 && n <= 16) hipRoof(e, pr, yt + 0.03, pitch, roof === EST_ROOF.STEEP ? 0.35 : 0.5);
      else {
        const d = Math.min(W * 0.42, rect < 0.55 ? 2.4 : 4.0);
        insetRoof(e, xs, zs, n, yt + 0.03, d, Math.min(7, d * Math.tan(pitch * D2R)), 0.4);
      }
    } else if (roof === EST_ROOF.MANSARD) {
      insetRoof(e, xs, zs, n, yt + 0.03, Math.min(1.4, W * 0.3), 1.7, 0.35);
    } else if (roof === EST_ROOF.DECO) {
      // Art Deco 收分塔冠：屋面上 2–3 级主轴对齐盒体逐级收进（板楼按单元分两处）
      const units = L / Math.max(W, 1) > 2.4 && L > 40 ? 2 : 1;
      for (let u = 0; u < units; u++) {
        const cs = units === 2 ? sc + (u ? 1 : -1) * L * 0.25 : sc;
        const hs0 = units === 2 ? L * 0.25 - 1.5 : L / 2 - 1.3, ht0 = W / 2 - 1.3;
        const k = fitRect(xs, zs, n, pr, cs, tc, hs0, ht0);
        if (!k) continue;
        const hs = hs0 * k, ht = ht0 * k;
        const tiers = H >= 60 ? [[1, 1, 3.4], [0.66, 0.72, 2.8], [0.34, 0.46, 2.4]] : [[1, 1, 3.0], [0.6, 0.7, 2.4]];
        let y = yr;
        for (let q = 0; q < tiers.length; q++) {
          const [fs, ft, hh] = tiers[q];
          const y1 = (q === 0 ? yt : y) + hh;
          rectBox(e, pr, cs, tc, hs * fs, ht * ft, y, y1);
          y = y1;
        }
      }
    } else if (roof === EST_ROOF.CORNICE) {
      // 新古典檐口 + 中部升起一层（带檐口收头）
      cornice(e, xs, zs, n, yt - 0.55, yt, 0.42);
      if (estFloors[i] >= 8) {
        const slab = L / Math.max(W, 1) > 1.7;
        const hs0 = slab ? L * 0.19 : L * 0.22, ht0 = slab ? W * 0.4 : W * 0.22;
        const k = fitRect(xs, zs, n, pr, sc, tc, hs0, ht0);
        if (k) rectBox(e, pr, sc, tc, hs0 * k, ht0 * k, yr, yt + (slab ? 3.2 : 4.0));
      }
    }
  }

  /** 装饰构架 / Art Deco 转角壁柱（屋顶构件实例，只在近景） */
  function estateRoofProps(i, n, push, pr, yr, col) {
    const roof = estRoof[i];
    const L = pr.L, W = pr.W;
    const sc = (pr.s0 + pr.s1) / 2, tc = (pr.t0 + pr.t1) / 2;
    const rot = -pr.ang;
    if (roof === EST_ROOF.FRAME) {
      // 装饰构架：屋面上方 4.2 m 的梁柱框（柱距约 6 m）+ 横向格栅梁
      const k = fitRect(QX, QZ, n, pr, sc, tc, L / 2 - 0.5, W / 2 - 0.5);
      if (!k) return;
      const hs = (L / 2 - 0.5) * k, ht = (W / 2 - 0.5) * k;
      const Hf = 4.2, b = 0.42;
      const ns = Math.max(1, Math.round((2 * hs) / 6));
      for (let c = 0; c <= ns; c++) {
        const s = sc - hs + (2 * hs * c) / ns;
        push(0, s, tc - ht, yr, b, Hf, b, rot, col, false);
        push(0, s, tc + ht, yr, b, Hf, b, rot, col, false);
      }
      push(0, sc, tc - ht, yr + Hf - 0.5, 2 * hs + b, 0.5, b, rot, col, false);
      push(0, sc, tc + ht, yr + Hf - 0.5, 2 * hs + b, 0.5, b, rot, col, false);
      push(0, sc - hs, tc, yr + Hf - 0.5, b, 0.5, 2 * ht, rot, col, false);
      push(0, sc + hs, tc, yr + Hf - 0.5, b, 0.5, 2 * ht, rot, col, false);
      const ng = Math.max(1, Math.round((2 * hs) / 3));
      for (let c = 1; c < ng; c++) push(0, sc - hs + (2 * hs * c) / ng, tc, yr + Hf - 0.42, 0.24, 0.3, 2 * ht, rot, col, false);
    } else if (roof === EST_ROOF.DECO) {
      // Art Deco：转角通高壁柱冲出屋面 3.5 m
      const k = fitRect(QX, QZ, n, pr, sc, tc, L / 2 - 0.4, W / 2 - 0.4);
      if (!k) return;
      const hs = (L / 2 - 0.4) * k, ht = (W / 2 - 0.4) * k;
      for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) push(0, sc + a * hs, tc + c * ht, yr, 0.7, phA[i] + 3.5, 0.7, rot, col, false);
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
      if (estRoof[i]) estateExtras(i, SX, SZ, n, emitter(true, V, I, ox, oz, i, bb));
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
    if (flagA[i] & EST_PITCHED) return; // 坡屋面楼：平屋面被坡顶完全盖住，不写
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
    // 小区楼：装饰构架 / Art Deco 转角壁柱；塔冠、中部升起已由楼体几何表现（代替机房盒体，免得穿插）
    const eR = estRoof[i];
    if (eR === EST_ROOF.FRAME || eR === EST_ROOF.DECO) {
      const lift = (c, k) => {
        const f = (v) => Math.min(255, Math.round(v * k + 255 * (1 - k) * 0.35));
        return f((c >> 16) & 255) * 65536 + f((c >> 8) & 255) * 256 + f(c & 255);
      };
      estateRoofProps(i, n, push, pr, yr, eR === EST_ROOF.FRAME ? lift(col, 0.8) : col);
    }
    if (eR === EST_ROOF.DECO || eR === EST_ROOF.CORNICE) return;
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
