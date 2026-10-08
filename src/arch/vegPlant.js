// 城市植被：种植点生成（纯计算，Web Worker 与主线程回退共用；不依赖 DOM / three）。
//
// 输入：roads / landuse / water / rail（ctx.data 原样）、buildings.bin（ArrayBuffer）、
//       树木排除区（多边形列表）、城墙中心线/马面/城门（landmarks.json）。
// 输出：按 200 m 渲染块排序的树木 SoA 数组 + 绿篱段数组（见 plantVegetation 返回值）。
//
// 方法：
//  1. 在种植区（钟楼周边约 27 km 见方）上建 3 m 栅格位图：建筑（B）、道路/铁路/高架（RD）、水面（W）、已种树（T）、
//     绿篱（HB）；6 m 栅格：视廊（AX）、禁种用地（NT）、针叶树冠（CON）。
//  2. 行道树：沿 trunk~tertiary / residential / unclassified / pedestrian 道路两侧，偏移 = 半路宽 + 树池距，
//     间距 6.5~8.5 m。同名道路统一树种（友谊路/含光路/咸宁路/太白路 = 法国梧桐；雁塔西路 = 银杏“黄金大道”；
//     其余按名称散列：国槐为主）。行道树不用针叶树（西安行道树以国槐、法桐为主，部分银杏）。
//     中央分隔带（单行道左侧）：先量出两幅路之间的实际宽度——< 2.4 m 不种；< 4.5 m 只种绿篱 + 灌木球；
//     < 9 m 绿篱 + 灌木球/石榴/小国槐；≥ 9 m 才种乔木（不种针叶树）。
//  2b. 视廊：钟楼四条大街、四座城门内外（北关正街/东关正街/丰镐东路/长安北路南门段）、雁塔北路（对景大雁塔）
//     的车行道两侧 8 m 内、钟楼—城门连线两侧 12 m、城门外正对的条带（420 m × 40 m）只允许分隔带灌木球/绿篱，
//     本路自己的人行道行道树除外；LANDMARK_SIGHTLINES 另列荐福寺山门对景与已改为广场的旧环岛。
//  2c. 禁种用地：广场/工地/运动场（construction、square、pitch、track、stadium、brownfield）里不撒公园树。
//  3. 环城公园：城墙外侧 14 m 起到护城河之间逐排加密种植，河岸 7 m 内为垂柳；城墙内侧顺城巷一排。
//  4. 水岸：湖/河/护城河/池塘岸线外 3~10 m 种垂柳为主；< 400 m² 的湖心小岛按水面处理（岛上没有地面，树会像长在水里）。
//  4b. 院落：地标模块整片排除的寺院（荐福寺/小雁塔）按院落布局补种古槐、古柏（避开殿堂与甬道，见 COURTYARDS）。
//  5. 用地：公园 / 林地 / 草地 / 校园 / 居住区 / 墓地等按密度 + 60 m 尺度的团簇噪声撒点（有林、有草坪空地）。
//  7b. 外圈：VEG_REGION 以外到 VEG_OUTER（渭河两岸、咸阳机场陆侧、长安区）用 6 m 粗栅格低密度种植
//     （林地/公园/墓地/校园/村镇 + 主干道 + 河岸），距中心 12.5~14 km 与主区渐变衔接。
//  所有点都要避开：建筑（带 2~3.5 m 净距）、路面、水面（树干离驳岸 ≥ 1.8 m，三面临水的小方台/窄半岛不种）、
//  排除区、城墙本体/马面/瓮城、已种的树、绿篱；小乔木/灌木不种进针叶树冠下（雪松/侧柏枝叶垂地）。
//  远离市中心（> 6.5 km）按距离递减密度。

// 树种编号（与 vegSpecies.js 的 SP 一致）
const HUAI = 0, WUTONG = 1, XUESONG = 2, LIU = 3, YINXING = 4, SHILIU = 5, GUANMU = 6, BAI = 7;

export const VEG_REGION = { x0: -13200, x1: 14400, z0: -13500, z1: 14100 };
// 外圈（粗栅格、低密度）：西到咸阳机场、北过渭河、南到长安区（约 108.71~109.16E、34.06~34.48N）
export const VEG_OUTER = { x0: -22000, x1: 20000, z0: -24000, z1: 22000 };
export const VEG_CHUNK = 200;
const CELL = 3;
const CENTER_X = 300, CENTER_Z = 900;
const MAX_TREES = 650000; // 主种植区上限
const MAX_OUTER = 180000; // 外圈上限

// 地标正面对景条带与禁种圆区（世界坐标 [x0, z0, x1, z1, 半宽]，起止点相同即圆）：区内不种树（钟楼四街/城门/雁塔北路另按道路生成）
export const LANDMARK_SIGHTLINES = [
  [-456, 2402, -456, 2575, 16], // 荐福寺山门 → 荐福寺路北侧广场（对景小雁塔）
  // 未央城市广场（原张家堡环岛）不在这里整片禁种：src/modules/weiyang.js 已把用地换成广场公园，并只对坑口、环坑步道、园路登记不种树
];

// 地标模块整片设为“树木排除区”的寺院院落：植被侧按院落布局补种古槐、古柏（荐福寺院内古槐成林，小雁塔掩映在大树中）。
// 坐标取自 src/modules/heritage.js（SITES.xiaoyanta 原点 −456, 2244；buildXiaoyanta 的殿堂布局，z 向南）。
// keep：塔基/殿堂/配殿/钟鼓楼/山门（已含檐口、月台、台阶外扩）与中轴甬道；rows：甬道两侧柏树行；mix：其余空地散植。
// 若以后地标模块改为只排除殿堂本体（trees 只登记建筑轮廓，如 heritage26 的做法），这里的院落可删掉。
export const COURTYARDS = (() => {
  const X0 = -456, Z0 = 2244;
  const r = (x0, z0, x1, z1) => [X0 + x0, Z0 + z0, X0 + x1, Z0 + z1];
  return [
    {
      name: '荐福寺',
      p: [X0 - 39, Z0 - 55, X0 + 39, Z0 - 55, X0 + 39, Z0 + 157, X0 - 39, Z0 + 157],
      keep: [
        r(-13, -13, 13, 13), // 小雁塔塔基
        r(-12.5, -48, 12.5, -32), // 白衣阁
        r(-12.5, 26, 12.5, 42), // 藏经楼
        r(-14.5, 57, 14.5, 81), // 大雄宝殿（含须弥座月台与前阶）
        r(-30, 59.5, -18, 76.5), r(18, 59.5, 30, 76.5), // 东西配殿
        r(-9.5, 93, 9.5, 111), // 慈氏阁
        r(-27, 121, -13, 135), r(13, 121, 27, 135), // 钟楼、鼓楼
        r(-10, 148, 10, 164), // 山门 + 石狮
        r(-3.6, -32, 3.6, 160), // 中轴甬道
      ],
      rows: [{ x: [X0 - 6.4, X0 + 6.4], z0: Z0 - 30, z1: Z0 + 146, step: 6.5, sp: 7 /* 侧柏 */ }],
      mix: [[0, 0.62], [7, 0.24], [4, 0.14]], // 国槐 / 侧柏 / 银杏
      step: 9,
      sMul: 1.15,
    },
  ];
})();

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

// —— 位图（带世界坐标的栅格：格宽 cell 米，越界读作“已占用”） ——
class Grid {
  constructor(r, cell) {
    this.x0 = r.x0;
    this.z0 = r.z0;
    this.cell = cell;
    this.w = Math.ceil((r.x1 - r.x0) / cell);
    this.h = Math.ceil((r.z1 - r.z0) / cell);
    this.x1 = this.x0 + this.w * cell;
    this.z1 = this.z0 + this.h * cell;
    this.a = new Uint32Array(Math.ceil((this.w * this.h) / 32));
  }
  ci(x) {
    return Math.floor((x - this.x0) / this.cell);
  }
  cj(z) {
    return Math.floor((z - this.z0) / this.cell);
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
  at(x, z) {
    return this.get(this.ci(x), this.cj(z));
  }
  mark(x, z) {
    this.set(this.ci(x), this.cj(z));
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
  // 主种植区 3 m 栅格：建筑（B）、道路/铁路/高架（RD）、水面（W）、已种树（T）
  const B = new Grid(R, CELL), RD = new Grid(R, CELL), W = new Grid(R, CELL), T = new Grid(R, CELL);
  const ci = (x) => T.ci(x);
  const cj = (z) => T.cj(z);
  const inRegion = (x, z) => x > R.x0 + 20 && x < R.x1 - 20 && z > R.z0 + 20 && z < R.z1 - 20;
  const inOuterBox = (x, z) => x > VEG_OUTER.x0 && x < VEG_OUTER.x1 && z > VEG_OUTER.z0 && z < VEG_OUTER.z1;

  // —— 多边形扫描线填充（格心在内即置位；环可带洞，奇偶规则） ——
  function fillRings(g, rings, edges) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of rings)
      for (let i = 0; i < p.length; i += 2) {
        const x = p[i], z = p[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    const C = g.cell;
    if (x1 < g.x0 || x0 > g.x1 || z1 < g.z0 || z0 > g.z1) return;
    const j0 = Math.max(0, Math.ceil((z0 - g.z0) / C - 0.5)), j1 = Math.min(g.h - 1, Math.floor((z1 - g.z0) / C - 0.5));
    if (j1 < j0) {
      if (edges) for (const p of rings) strokeRing(g, p);
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
        const ja = Math.max(j0, Math.ceil((lo - g.z0) / C - 0.5)), jb = Math.min(j1, Math.ceil((hi - g.z0) / C - 0.5) - 1);
        for (let j = ja; j <= jb; j++) {
          const zc = g.z0 + (j + 0.5) * C;
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
        const ia = Math.max(0, Math.ceil((xs[k] - g.x0) / C - 0.5)), ib = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.x0) / C - 0.5));
        for (let i = ia; i <= ib; i++) g.set(i, j);
      }
    }
    if (edges) for (const p of rings) strokeRing(g, p);
  }
  function strokeRing(g, p) {
    const n = p.length / 2;
    for (let k = 0; k < n; k++) {
      const kb = (k + 1) % n;
      strokeSeg(g, p[k * 2], p[k * 2 + 1], p[kb * 2], p[kb * 2 + 1]);
    }
  }
  function strokeSeg(g, xa, za, xb, zb) {
    const L = Math.hypot(xb - xa, zb - za);
    const n = Math.max(1, Math.ceil(L / (g.cell * 0.7)));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      g.mark(xa + (xb - xa) * t, za + (zb - za) * t);
    }
  }
  /** 胶囊（线段 + 半宽）盖章 */
  function stampCapsule(g, xa, za, xb, zb, hw) {
    const L = Math.hypot(xb - xa, zb - za);
    if (L > 24) {
      const n = Math.ceil(L / 20);
      for (let s = 0; s < n; s++)
        stampCapsule(g, xa + ((xb - xa) * s) / n, za + ((zb - za) * s) / n, xa + ((xb - xa) * (s + 1)) / n, za + ((zb - za) * (s + 1)) / n, hw);
      return;
    }
    const x0 = Math.min(xa, xb) - hw, x1 = Math.max(xa, xb) + hw, z0 = Math.min(za, zb) - hw, z1 = Math.max(za, zb) + hw;
    if (x1 < g.x0 || x0 > g.x1 || z1 < g.z0 || z0 > g.z1) return;
    const C = g.cell;
    const i0 = Math.max(0, g.ci(x0)), i1 = Math.min(g.w - 1, g.ci(x1)), j0 = Math.max(0, g.cj(z0)), j1 = Math.min(g.h - 1, g.cj(z1));
    const dx = xb - xa, dz = zb - za, l2 = dx * dx + dz * dz || 1e-6;
    const hw2 = hw * hw;
    for (let j = j0; j <= j1; j++) {
      const zc = g.z0 + (j + 0.5) * C;
      for (let i = i0; i <= i1; i++) {
        const xc = g.x0 + (i + 0.5) * C;
        let t = ((xc - xa) * dx + (zc - za) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = xa + dx * t - xc, ez = za + dz * t - zc;
        if (ex * ex + ez * ez <= hw2) g.set(i, j);
      }
    }
  }
  const blocked = (g, x, z) => g.at(x, z);
  /** 以 r 为半径的 8 方向探针 + 中心：任一命中返回 true */
  function nearAny(g, x, z, r) {
    if (g.at(x, z)) return true;
    if (r <= 0) return false;
    const d = r * 0.7071;
    return (g.at(x + r, z) || g.at(x - r, z) || g.at(x, z + r) || g.at(x, z - r) || g.at(x + d, z + d) || g.at(x - d, z + d) || g.at(x + d, z - d) || g.at(x - d, z - d)) === 1;
  }

  // —— 1. 建筑 ——
  const bd = parseBuildings(input.buildings);
  let nb = 0;
  if (bd) {
    const ring = [];
    for (let b = 0; b < bd.n; b++) {
      const ax = bd.ax[b], az = bd.az[b];
      if (ax < R.x0 - 300 || ax > R.x1 + 300 || az < R.z0 - 300 || az > R.z1 + 300) continue; // 区边外的楼也要登记（区边的树会伸进去）
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
      if (!inOuterBox(xa, za) && !inOuterBox(xb, zb)) continue;
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
  const ringArea = (p) => {
    let a = 0;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
    return Math.abs(a) / 2;
  };
  // 水岸线段索引：树干离岸线（精确矢量距离）< 1.8 m 不种——3 m 栅格量不出驳岸的小凹口，曾有垂柳长在芙蓉湖岸边的方形水湾里
  const WEC = 40;
  const weGrid = new Map(), weSeg = [];
  const addWaterEdge = (p) => {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xa = p[j], za = p[j + 1], xb = p[i], zb = p[i + 1];
      if (!inRegion(xa, za) && !inRegion(xb, zb)) continue;
      const id = weSeg.length / 4;
      weSeg.push(xa, za, xb, zb);
      for (let cx = Math.floor((Math.min(xa, xb) - 3) / WEC); cx <= Math.floor((Math.max(xa, xb) + 3) / WEC); cx++)
        for (let cz = Math.floor((Math.min(za, zb) - 3) / WEC); cz <= Math.floor((Math.max(za, zb) + 3) / WEC); cz++) {
          const k = cx * 100003 + cz;
          let l = weGrid.get(k);
          if (!l) weGrid.set(k, (l = []));
          l.push(id);
        }
    }
  };
  const waterEdgeHit = (x, z, r) => {
    const l = weGrid.get(Math.floor(x / WEC) * 100003 + Math.floor(z / WEC));
    if (!l) return false;
    for (const id of l) {
      const o = id * 4;
      const xa = weSeg[o], za = weSeg[o + 1], dx = weSeg[o + 2] - xa, dz = weSeg[o + 3] - za;
      let t = ((x - xa) * dx + (z - za) * dz) / (dx * dx + dz * dz || 1e-6);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = xa + dx * t - x, ez = za + dz * t - z;
      if (ex * ex + ez * ez < r * r) return true;
    }
    return false;
  };
  /** 8 个方向的射线（2~12 m）里有几条碰到水面：≥ 5 说明是伸进湖里的小方台/窄半岛（三面临水） */
  const waterAround = (x, z) => {
    if (!nearAny(W, x, z, 12)) return 0;
    let c = 0;
    for (let k = 0; k < 8; k++) {
      const dx = Math.cos(k * 0.7853982), dz = Math.sin(k * 0.7853982);
      for (let d = 2; d <= 12; d += 2)
        if (W.at(x + dx * d, z + dz * d)) {
          c++;
          break;
        }
    }
    return c;
  };
  for (const w of water.polys || []) {
    if (!w.outer || w.outer.length < 6) continue;
    // 小岛（< 400 m²）按水面处理：曲江/芙蓉园这类小岛只有一圈驳岸、岛内就是水面高度，种上树像从水里长出来
    const holes = (w.holes || []).filter((h) => h.length >= 6 && ringArea(h) >= 400);
    fillRings(W, [w.outer, ...holes], false);
    addWaterEdge(w.outer);
    for (const h of holes) addWaterEdge(h);
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
  // 排除区栅格（只用于树冠收缩的距离探针；树干是否落在排除区仍按多边形精确判断）
  const EXB = new Grid(R, CELL);
  for (const it of input.exclusions || []) if (it.p && it.p.length >= 6) fillRings(EXB, [it.p], true);
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

  // —— 视廊（城市主轴线对景：钟楼、城门、大雁塔） ——
  // 这些道路车行道两侧 8 m 内（含中央分隔带）与城门外正对的条带只允许灌木球/绿篱；本路自己的人行道行道树不受限。
  // 例：东大街中央分隔带原先种了 25 m 高的雪松，正好挡住 450 m 外的钟楼；永宁门外长安北路分隔带两排雪松挡住城门。
  const AXIS_NAMES = new Set(['东大街', '西大街', '南大街', '北大街', '北关正街', '东关正街', '丰镐东路', '长安北路', '雁塔北路']);
  // 各轴线的生效范围（世界坐标 x0,z0,x1,z1）：长安北路只管南门外约 1.6 km，丰镐东路只管安定门外约 1.6 km
  const AXIS_BOX = [
    [-90, -3400, 130, 0], // 北：北大街 + 北关正街（安远门）
    [-100, 0, 90, 2500], // 南：南大街 + 永宁门外长安北路
    [0, -70, 3600, 100], // 东：东大街 + 东关正街（长乐门）
    [-3600, -100, 0, 80], // 西：西大街 + 丰镐东路（安定门）
    [1440, 780, 1640, 4100], // 雁塔北路（和平门 → 大雁塔北广场）
  ];
  const inAxisBox = (x, z) => {
    for (const b of AXIS_BOX) if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]) return true;
    return false;
  };
  const isAxisRoad = (f) => AXIS_NAMES.has(f.n || '');
  const AX = new Grid(R, 6);
  for (const f of feats) {
    if (f.t || !isAxisRoad(f)) continue;
    const p = f.p;
    if (!p || p.length < 4) continue;
    const hw = roadW(f) / 2 + 8;
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (!inAxisBox(p[i], p[i + 1]) && !inAxisBox(p[i + 2], p[i + 3])) continue;
      stampCapsule(AX, p[i], p[i + 1], p[i + 2], p[i + 3], hw);
    }
  }
  // 四座主城门外正对的条带（护城河、吊桥、门前广场直到城门外大街）：钟楼 → 城门方向延长 420 m，宽 40 m（约等于瓮城宽度）
  // 城内：钟楼 → 城门的连线两侧 12 m（南大街两幅路相距近 60 m，中间的横街行道树/分隔带树原先正好落在轴线上）
  for (const g of input.gates || []) {
    if (!(g.check_half >= 100) || !g.world) continue;
    const gx = g.world.x, gz = g.world.z, L = Math.hypot(gx, gz) || 1;
    stampCapsule(AX, gx, gz, gx + (gx / L) * 420, gz + (gz / L) * 420, 20);
    stampCapsule(AX, (gx / L) * 75, (gz / L) * 75, gx, gz, 12);
  }
  // 其他地标的正面对景（[x0, z0, x1, z1, 半宽]）：荐福寺山门 → 荐福寺路，山门外广场看小雁塔（原先山门正前方一棵大法桐、
  // 两棵雪松把 43 m 高的塔整个挡住）；以及已改造成广场的旧环岛公园（整片不种树）
  for (const s of LANDMARK_SIGHTLINES) stampCapsule(AX, s[0], s[1], s[2], s[3], s[4]);
  // —— 禁种用地：广场、工地/棕地、运动场（球场/跑道/体育场）——公园/校园撒点不落在这些多边形里
  // （高新体育训练中心的条纹草皮球场与旁边的黄土工地上曾撒满树）。landuse.json 目前只有 construction/square，
  // pitch/track/stadium/brownfield 需数据管线（tools/build_data.py）从 OSM leisure=* 补进 landuse.json 后自动生效
  const NO_TREE_KINDS = new Set(['construction', 'square', 'pitch', 'track', 'stadium', 'brownfield']);
  const NT = new Grid(R, 6);
  for (const f of input.landuse?.polys || []) if (NO_TREE_KINDS.has(f.k) && f.outer && f.outer.length >= 6) fillRings(NT, [f.outer, ...(f.holes || [])], false);
  const noTree = (x, z) => NT.at(x, z) === 1;
  /** 视廊内不种树；只有中央分隔带的灌木球（shrubOk）可以 */
  const axisBlocked = (x, z, sp, shrubOk = false) => !(shrubOk && sp === GUANMU) && AX.at(x, z) === 1;

  // —— 绿篱占位（HB）与针叶树冠占位（CON）：别的树不种在绿篱上、不种进雪松/侧柏垂地的树冠里 ——
  const HB = new Grid(R, CELL), CON = new Grid(R, 6);
  /** 圆盘内是否有任一格置位 */
  function diskHit(g, x, z, r) {
    const i0 = g.ci(x - r), i1 = g.ci(x + r), j0 = g.cj(z - r), j1 = g.cj(z + r);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const ex = g.x0 + (i + 0.5) * g.cell - x, ez = g.z0 + (j + 0.5) * g.cell - z;
        if (ex * ex + ez * ez <= r * r && g.get(i, j)) return true;
      }
    return false;
  }
  /** 中央分隔带实际宽度：从车行道中心点沿法线（指向分隔带）外探，首次碰到其他车行道的距离 − 本幅半宽 */
  function medianGap(cx, cz, nx, nz, hw) {
    for (let d = hw + 0.6; d < hw + 26; d += 0.7) if (roadHit(cx + nx * d, cz + nz * d, 0)) return d - hw - 0.35;
    return 26;
  }

  // —— 输出缓冲 ——
  let cap = 1 << 18, n = 0;
  let X = new Float32Array(cap), Z = new Float32Array(cap);
  let SPC = new Uint8Array(cap), SC = new Uint8Array(cap), ROT = new Uint8Array(cap), RK = new Uint8Array(cap), LAMP = new Uint8Array(cap), YEL = new Uint8Array(cap), BR = new Uint8Array(cap);
  let SRCA = new Uint8Array(cap); // 种植来源（诊断用：1 行道 2 分隔带 3 环城外 4 环城内 5 岸环 6 岸线 7 用地 8 院落 9 外圈）
  const grow = () => {
    cap *= 2;
    const g = (A, C) => { const b = new C(cap); b.set(A); return b; };
    X = g(X, Float32Array); Z = g(Z, Float32Array);
    SPC = g(SPC, Uint8Array); SC = g(SC, Uint8Array); ROT = g(ROT, Uint8Array); RK = g(RK, Uint8Array);
    LAMP = g(LAMP, Uint8Array); YEL = g(YEL, Uint8Array); BR = g(BR, Uint8Array); SRCA = g(SRCA, Uint8Array);
  };
  const rnd = mulberry(20260925);
  const stats = { street: 0, median: 0, wallpark: 0, bank: 0, landuse: 0, court: 0, outer: 0, hedge: 0, shrunk: 0, axis: 0 };
  // 树冠水平半径（米，缩放 1 时；与 vegSpecies.js 各树种 crownR 一致）：国槐 法桐 雪松 垂柳 银杏 石榴 灌木球 侧柏
  const CROWN_R = [4.3, 7.2, 4.6, 4.8, 3.1, 1.9, 0.85, 2.6];
  const CONIFER = (sp) => sp === XUESONG || sp === BAI;
  /**
   * 树干到最近建筑外墙的大致距离（米，探到 maxR 为止）：通用建筑与精建排除区（档案建筑/地标/古建/下沉广场……
   * 多为楼体外扩 2.5 m）各用 3 m 栅格、16 方向探针逐米外扩。exb=false：不看排除区（院落补种的树本身就在排除区内）
   */
  function crownRoom(x, z, maxR, exb = true, bg = B) {
    let best = maxR;
    for (let r = 1; r < best; r += 1) {
      let hit = false;
      for (let k = 0; k < 16 && !hit; k++) {
        const a = (k / 16) * Math.PI * 2;
        hit = !!bg.at(x + Math.cos(a) * r, z + Math.sin(a) * r);
      }
      if (hit) {
        best = Math.max(0, r - 1.5); // 命中格中心到格边 1.5 m
        break;
      }
    }
    if (exb)
      for (let r = 1; r < best; r += 1) {
        let hit = false;
        for (let k = 0; k < 16 && !hit; k++) {
          const a = (k / 16) * Math.PI * 2;
          hit = !!EXB.at(x + Math.cos(a) * r, z + Math.sin(a) * r);
        }
        if (hit) {
          best = r; // 区边在 r-2.1 ~ r 之间，楼体在区边内约 2.5 m：楼距按 r 计（偏保守）
          break;
        }
      }
    return best;
  }
  // 树种高度随机范围（相对 vegSpecies 基准几何）
  const SCALE = [
    [0.72, 1.12], // 国槐 7.9~12.3 m
    [0.72, 1.08], // 法桐 12~18 m
    [0.62, 1.18], // 雪松 9~18 m
    [0.82, 1.22], // 垂柳 8~12 m
    [0.62, 0.98], // 银杏 8~12.5 m（多为青年树）
    [0.7, 1.15], // 石榴 3.4~5.6 m
    [0.65, 1.35], // 灌木球
    [0.72, 1.15], // 侧柏 8~13 m
  ];
  // 秋色（9 月下旬）：银杏刚开始微黄（大部分仍绿），法桐少量泛黄
  const YELLOW = [[0, 0.08], [0.03, 0.22], [0, 0], [0, 0.05], [0.04, 0.3], [0, 0.05], [0, 0], [0, 0]];
  // 树冠净距（米）：建筑 / 其他树
  const CLEAR_B = [2.6, 3.4, 3.0, 2.8, 2.2, 1.6, 0.8, 2.0];
  function occupyTree(x, z, sp) {
    const i = ci(x), j = cj(z);
    T.set(i, j);
    if (sp === WUTONG || sp === XUESONG) { T.set(i + 1, j); T.set(i - 1, j); T.set(i, j + 1); T.set(i, j - 1); }
  }
  function treeFree(x, z, sp, bClear) {
    const i = ci(x), j = cj(z);
    if (T.get(i, j) || HB.at(x, z) || CON.at(x, z)) return false; // 已有树 / 绿篱上 / 雪松侧柏垂地的树冠下
    if (W.get(i, j) || waterEdgeHit(x, z, 1.8)) return false; // 水面里 / 紧贴驳岸
    if (waterAround(x, z) >= 5) return false; // 伸进湖里的小方台/窄半岛（驳岸围成一圈，地面常被湖面平整压到水位）
    if (sp !== GUANMU && sp !== SHILIU && (T.get(i + 1, j) || T.get(i - 1, j) || T.get(i, j + 1) || T.get(i, j - 1))) return false;
    // 石榴（3~5 m 小乔木）离别的树干 ≥ 3 m：不和大树树冠互相穿插
    if (sp === SHILIU && nearAny(T, x, z, 3)) return false;
    // 针叶树冠下（约 0.6 倍冠幅）不能已有树
    if (CONIFER(sp) && diskHit(T, x, z, CROWN_R[sp] * 0.6)) return false;
    if (nearAny(B, x, z, bClear ?? CLEAR_B[sp])) return false;
    return true;
  }
  /**
   * 放置一棵树（已通过路面/水面检查）。rankMul：rank 偏置（行道树更靠前保留）；exb=false 不按排除区收冠；
   * room(x,z)：额外的冠幅上限（院落里离殿堂/院墙的距离）
   */
  function addTree(x, z, sp, { lamp = 0, sMul = 1, rankMul = 1, src = 0, exb = true, room = null, face = null, bg = B } = {}) {
    if (n >= cap) grow();
    const [s0, s1] = SCALE[sp];
    let s = (s0 + (s1 - s0) * rnd()) * sMul;
    // 树冠不插进楼：按离最近建筑（通用建筑栅格 / 精建排除区）的距离收小整棵树（最小到本树种下限的 60%）
    let d = crownRoom(x, z, CROWN_R[sp] * s + 0.5, exb, bg);
    if (room) d = Math.min(d, room(x, z));
    if (CROWN_R[sp] * s > d + 0.5) {
      s = Math.max((d + 0.5) / CROWN_R[sp], s0 * 0.6);
      stats.shrunk++;
    }
    X[n] = x; Z[n] = z; SPC[n] = sp;
    SC[n] = Math.max(1, Math.min(255, Math.round(s * 127.5)));
    // 旋转：face=[fx,fz] 时让树的本地 +x 大致朝向 face（行道树朝车行道：夜间路灯补光只照朝路一侧），否则随机。
    // 实例矩阵把本地 +x 变到世界 (cosθ, −sinθ)
    if (face) {
      const th = Math.atan2(-face[1], face[0]) + (rnd() - 0.5) * 0.9;
      ROT[n] = ((Math.round((th / (Math.PI * 2)) * 256) % 256) + 256) % 256;
    } else ROT[n] = (rnd() * 256) | 0;
    RK[n] = Math.min(255, (rnd() * 256 * rankMul) | 0);
    LAMP[n] = Math.round(Math.max(0, Math.min(1, lamp)) * 255);
    const [y0, y1] = YELLOW[sp];
    YEL[n] = Math.round((y0 + (y1 - y0) * rnd() * rnd() * 1.6) * 255) & 255;
    BR[n] = (rnd() * 256) | 0;
    SRCA[n] = src;
    occupyTree(x, z, sp);
    if (CONIFER(sp)) stampCapsule(CON, x - 0.01, z, x + 0.01, z, CROWN_R[sp] * s * 0.7);
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
  // 同名道路统一树种：真实老路（友谊路/含光路/咸宁路/太白路…）为法桐；雁塔西路银杏；其余按名称散列。
  // 行道树不用针叶树：西安行道树以国槐、法桐为主，部分银杏（此前约 5% 的路名散列成雪松，小寨东路等人行道成排云杉）
  const WUTONG_RE = /友谊|含光|咸宁|太白|雁塔北路|建设路|长乐|西五路|东五路|环城|兴庆|朱雀|南关|北关|西关|东关|劳动路|丰庆|桃园|西影|翠华|长安北路|长安中路/;
  const YINXING_RE = /雁塔西路|唐延|科技|锦业|丈八一|高新|天谷|云水|团结南|芙蓉|曲江|雁南|大唐|慈恩|凤城|未央路|明光/;
  const HUAI_RE = /东大街|西大街|南大街|北大街|钟楼|鼓楼|北院门|西华门|东新街|解放路|莲湖|青年路|东木头市|竹笆市|五味什字|德福巷|书院门|湘子庙|南院门|粉巷|案板街/;
  function roadSpecies(f) {
    const name = f.n || '';
    if (name) {
      if (HUAI_RE.test(name)) return [HUAI, 0.92];
      if (/雁塔西路/.test(name)) return [YINXING, 0.96];
      if (WUTONG_RE.test(name)) return [WUTONG, 0.85];
      if (YINXING_RE.test(name)) return [YINXING, 0.75];
      const h = strHash(name);
      return [h < 0.55 ? HUAI : h < 0.86 ? WUTONG : YINXING, 0.82];
    }
    const h = hashI(Math.round(f.p[0] / 50), Math.round(f.p[1] / 50), 7);
    return [h < 0.6 ? HUAI : h < 0.82 ? WUTONG : YINXING, 0.7];
  }
  const OTHER_STREET = [[HUAI, 0.55], [WUTONG, 0.2], [YINXING, 0.15], [SHILIU, 0.1]];
  // 宽分隔带（≥ 9 m）里的乔木：不种针叶树
  const MEDIAN_WIDE = [[HUAI, 0.45], [YINXING, 0.2], [SHILIU, 0.2], [GUANMU, 0.15]];
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
  /** 绿篱段：登记 + 盖章到 HB（别的树不再种在上面）；与已有绿篱重叠（两幅路各自探到同一条窄分隔带）则跳过 */
  function hedgeSeg(ax, az, bx, bz, wid, hgt, variant) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1.5 || len > 11) return false;
    if (HB.at(mx, mz)) return false;
    addHedge(mx, mz, Math.atan2(bz - az, bx - ax), len, wid, hgt, variant);
    stampCapsule(HB, ax, az, bx, bz, wid / 2 + 0.4);
    return true;
  }
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
    const axisRoad = isAxisRoad(f);
    const L = lenOf(p);
    if (L < 12) continue;
    // 沿线采样
    for (const side of [1, -1]) {
      const median = oneway && side === -1; // 单行道左侧 = 中央分隔带
      if (median && !major) continue;
      let seg = 0, segStart = 0, segLen = Math.hypot(p[2] - p[0], p[3] - p[1]);
      let s = rnd() * spacing;
      let hedgeRun = 0, hedgeAcc = null;
      let medPrev = null; // 分隔带上一个采样点 [x, z, 有无乔灌木]
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
        const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t; // 中心线上的点
        const stepHere = spacing * (0.9 + rnd() * 0.2);
        s += stepHere;
        if (median) {
          // —— 中央分隔带：先量宽度，再定绿篱与树种 ——
          const gap = medianGap(cx, cz, nx, nz, hw);
          if (gap < 2.4 || !inRegion(cx, cz)) { medPrev = null; continue; }
          const wide = gap >= 9;
          const off = wide ? hw + 2.4 : hw + gap / 2;
          const lat = (rnd() - 0.5) * (wide ? 0.5 : 0.15);
          const x = cx + nx * (off + lat), z = cz + nz * (off + lat);
          const onAxis = axisRoad && inAxisBox(x, z);
          if (roadHit(x, z, Math.min(1.0, gap / 2 - 0.2)) || nearAny(W, x, z, 1.5) || excluded(x, z) || wallBlocked(x, z)) { medPrev = null; continue; }
          // 乔灌木：窄分隔带与视廊上只有灌木球；4.5~9 m 灌木球/石榴/小国槐；≥ 9 m 才种乔木
          let sp = -1, sMul = 1;
          const r = rnd();
          if (onAxis || gap < 4.5) {
            if (r < 0.3) sp = GUANMU;
          } else if (!wide) {
            if (r < 0.25) sp = GUANMU;
            else if (r < 0.45) sp = SHILIU;
            else if (r < 0.65) { sp = HUAI; sMul = 0.68; }
          } else if (r < 0.85) {
            sp = rnd() < 0.55 && sp0 !== WUTONG ? sp0 : pick(MEDIAN_WIDE, rnd());
            if (sp === LIU || CONIFER(sp)) sp = HUAI;
          }
          let planted = false;
          if (sp >= 0 && rnd() < prob * (0.5 + 0.5 * fo) && !axisBlocked(x, z, sp, true) && treeFree(x, z, sp, Math.min(CLEAR_B[sp], 1.5))) {
            addTree(x, z, sp, { lamp: lamp * (0.8 + rnd() * 0.2), sMul: sMul * (sp === GUANMU ? 1 : ageMul(x, z)), rankMul: 0.72, src: 2 });
            stats.median++;
            planted = true;
          }
          // 绿篱：与上一个采样点连成一段；两端有树/灌木球时留出 1.1 m（树池），否则只留 0.25 m 缝
          if (medPrev) {
            const L2 = Math.hypot(x - medPrev[0], z - medPrev[1]) || 1;
            const ux = (x - medPrev[0]) / L2, uz = (z - medPrev[1]) / L2;
            const t0 = medPrev[2] ? 1.1 : 0.25, t1 = planted ? 1.1 : 0.25;
            const hx0 = medPrev[0] + ux * t0, hz0 = medPrev[1] + uz * t0, hx1 = x - ux * t1, hz1 = z - uz * t1;
            const mx = (hx0 + hx1) / 2, mz = (hz0 + hz1) / 2;
            if (!roadHit(mx, mz, Math.min(0.9, gap / 2 - 0.3)) && !nearAny(B, mx, mz, 1.2) && !excluded(mx, mz)) {
              const variant = !onAxis && hashI(Math.round(mx / 300), Math.round(mz / 300), 3) < 0.2 ? 2 : 0; // 红叶石楠（视廊大街用常绿黄杨）
              hedgeSeg(hx0, hz0, hx1, hz1, Math.max(0.8, Math.min(1.5, gap - 1.0)), onAxis ? 0.6 : 0.75, variant);
            }
          }
          medPrev = [x, z, planted];
          continue;
        }
        const lat = (rnd() - 0.5) * 0.5;
        const x = cx + nx * (hw + curb + lat), z = cz + nz * (hw + curb + lat);
        const dbg = input.debugBox && x > input.debugBox[0] && x < input.debugBox[1] && z > input.debugBox[2] && z < input.debugBox[3];
        const rej = (k) => { if (dbg) stats['rej_' + k] = (stats['rej_' + k] || 0) + 1; };
        if (rnd() > prob * (f.c <= 3 ? 0.5 + 0.5 * fo : fo * (0.25 + 0.75 * fo))) { hedgeRun = 0; rej('prob'); continue; }
        if (!inRegion(x, z)) continue;
        // 路面：树干处及 0.9 m 内不能是路（排除路口）
        if (roadHit(x, z, 0.9) || nearAny(W, x, z, 1.5)) { hedgeRun = 0; rej('road'); continue; }
        if (excluded(x, z) || wallBlocked(x, z)) { hedgeRun = 0; rej('excl'); continue; }
        let sp = rnd() < loyal ? sp0 : pick(OTHER_STREET, rnd());
        if (nearWater(x, z, 9) && rnd() < 0.8) sp = LIU;
        // 窄路不种大法桐
        if (sp === WUTONG && hw < 5) sp = HUAI;
        // 视廊：别的路（路口横街）的行道树不能落进轴线大街的车行道/分隔带两侧
        if (!axisRoad && axisBlocked(x, z, sp)) { hedgeRun = 0; stats.axis++; rej('axis'); continue; }
        if (!treeFree(x, z, sp, Math.min(CLEAR_B[sp], hw < 5 ? 1.1 : 1.5))) { hedgeRun = 0; rej(nearAny(B, x, z, 1.5) ? 'bld' : 'tree'); continue; }
        rej('ok');
        addTree(x, z, sp, { lamp: lamp * (0.8 + rnd() * 0.2), sMul: ageMul(x, z) * (hw < 5 ? 0.85 : 1), rankMul: 0.72, src: 1, face: [-nx, -nz] });
        stats.street++;
        stats['st_' + f.c] = (stats['st_' + f.c] || 0) + 1;
        // 绿篱：主干道树池之间连续绿篱带
        if (major && hw >= 9) {
          if (hedgeRun > 0 && hedgeAcc) {
            const L2 = Math.hypot(x - hedgeAcc[0], z - hedgeAcc[1]) || 1;
            const ux = (x - hedgeAcc[0]) / L2, uz = (z - hedgeAcc[1]) / L2;
            const hx0 = hedgeAcc[0] + ux * 0.7, hz0 = hedgeAcc[1] + uz * 0.7, hx1 = x - ux * 0.7, hz1 = z - uz * 0.7;
            const mx = (hx0 + hx1) / 2, mz = (hz0 + hz1) / 2;
            if (!roadHit(mx, mz, 0.7) && !nearAny(B, mx, mz, 1.2) && !excluded(mx, mz)) {
              const variant = hashI(Math.round(mx / 400), Math.round(mz / 400), 5) < 0.3 ? 1 : 0;
              hedgeSeg(hx0, hz0, hx1, hz1, 1.2, 0.7, variant);
            }
          }
          hedgeRun++;
          hedgeAcc = [x, z];
        }
      }
    }
  }

  // —— 4b. 院落补种（地标模块整片排除的寺院：古槐、古柏） ——
  for (const c of input.courtyards || COURTYARDS) {
    const keepHit = (x, z, m) => {
      for (const k of c.keep) if (x > k[0] - m && x < k[2] + m && z > k[1] - m && z < k[3] + m) return true;
      return false;
    };
    // 冠幅上限：离最近殿堂（keep 矩形）与院墙的距离
    const room = (x, z) => {
      let d = 1e9;
      for (const k of c.keep) d = Math.min(d, Math.hypot(Math.max(k[0] - x, 0, x - k[2]), Math.max(k[1] - z, 0, z - k[3])));
      const p = c.p;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
        const ax = p[j], az = p[j + 1], dx = p[i] - ax, dz = p[i + 1] - az;
        let t = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = Math.min(d, Math.hypot(ax + dx * t - x, az + dz * t - z));
      }
      return d + 0.6; // 院墙 3 m 高、殿堂檐口 4~6 m：树冠可略探过墙头/檐下
    };
    const place = (x, z, sp, sMul) => {
      if (!pip(x, z, c.p) || keepHit(x, z, 1.2)) return;
      if (nearAny(B, x, z, 1.5) || nearAny(W, x, z, 1.5) || nearAny(RD, x, z, 1.2)) return;
      if (!treeFree(x, z, sp, 1.2)) return;
      addTree(x, z, sp, { sMul, rankMul: 0.45, src: 8, exb: false, room, lamp: 0.15 });
      stats.court++;
    };
    // 甬道两侧柏树行
    for (const r of c.rows || [])
      for (const rx of r.x) for (let z = r.z0; z <= r.z1; z += r.step) place(rx + (rnd() - 0.5) * 0.6, z + (rnd() - 0.5) * 1.2, r.sp, c.sMul * (0.9 + rnd() * 0.2));
    // 院内散植古槐为主
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < c.p.length; i += 2) {
      x0 = Math.min(x0, c.p[i]); x1 = Math.max(x1, c.p[i]); z0 = Math.min(z0, c.p[i + 1]); z1 = Math.max(z1, c.p[i + 1]);
    }
    for (let z = z0 + c.step * 0.5; z < z1; z += c.step)
      for (let x = x0 + c.step * 0.5; x < x1; x += c.step) {
        if (rnd() > 0.85) continue;
        place(x + (rnd() - 0.5) * c.step * 0.7, z + (rnd() - 0.5) * c.step * 0.7, pick(c.mix, rnd()), c.sMul * (0.85 + rnd() * 0.3));
      }
  }

  // —— 5. 环城公园（城墙与护城河之间） ——
  if (wall.length > 10) {
    let cx = 0, cz = 0;
    for (const w of wall) { cx += w[0]; cz += w[1]; }
    cx /= wall.length; cz /= wall.length;
    const WALLMIX = [[HUAI, 0.3], [BAI, 0.1], [XUESONG, 0.04], [WUTONG, 0.14], [YINXING, 0.1], [SHILIU, 0.08], [GUANMU, 0.12], [LIU, 0.12]];
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
        if (excluded(x, z) || wallBlocked(x, z) || noTree(x, z)) continue;
        let sp = pick(WALLMIX, rnd());
        if (nearWater(x, z, 7) && rnd() < 0.85) sp = LIU;
        if (axisBlocked(x, z, sp)) { stats.axis++; continue; }
        if (!treeFree(x, z, sp)) continue;
        addTree(x, z, sp, { lamp: 0.25 + rnd() * 0.3, rankMul: 0.8, src: 3 });
        stats.wallpark++;
      }
      // 内侧顺城巷一排
      if (rnd() < 0.55) {
        const d = 13 + rnd() * 3;
        const x = px - nx * d, z = pz - nz * d;
        if (!nearAny(RD, x, z, 1.2) && !excluded(x, z) && !wallBlocked(x, z)) {
          const sp = rnd() < 0.7 ? HUAI : rnd() < 0.5 ? SHILIU : YINXING;
          if (!axisBlocked(x, z, sp) && treeFree(x, z, sp, 1.8)) {
            addTree(x, z, sp, { lamp: 0.5, rankMul: 0.85, src: 4 });
            stats.wallpark++;
          }
        }
      }
    }
  }

  // —— 6. 水岸垂柳 ——
  const BANKMIX = [[LIU, 0.74], [HUAI, 0.12], [YINXING, 0.03], [SHILIU, 0.04], [GUANMU, 0.07]];
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
            if (excluded(x, z) || wallBlocked(x, z) || noTree(x, z)) continue;
            const sp = d < 5 ? (rnd() < 0.85 ? LIU : pick(BANKMIX, rnd())) : pick(BANKMIX, rnd());
            if (axisBlocked(x, z, sp) || !treeFree(x, z, sp)) continue;
            addTree(x, z, sp, { lamp: 0.2 * rnd(), rankMul: 0.85, src: 5 });
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
          if (nearAny(W, x, z, 1.5) || nearAny(RD, x, z, 1.4) || excluded(x, z) || noTree(x, z)) continue;
          const sp = rnd() < 0.8 ? LIU : pick(BANKMIX, rnd());
          if (axisBlocked(x, z, sp) || !treeFree(x, z, sp)) continue;
          addTree(x, z, sp, { lamp: 0.1, rankMul: 0.9, src: 6 });
          stats.bank++;
        }
      }
      s -= L;
    }
  }

  // —— 7. 用地撒点 ——
  // 类别 → [每棵树的平均用地面积 m²，树种组合，团簇强度 0..1]
  // 西安公园/小区/大院以国槐、法桐、银杏、垂柳为主，针叶树（雪松、侧柏）合计约 5%；林地、墓地以侧柏为主
  const MIX_PARK = [[HUAI, 0.3], [WUTONG, 0.16], [YINXING, 0.13], [LIU, 0.1], [SHILIU, 0.1], [GUANMU, 0.15], [XUESONG, 0.03], [BAI, 0.03]];
  const MIX_FOREST = [[HUAI, 0.46], [BAI, 0.2], [XUESONG, 0.06], [YINXING, 0.1], [WUTONG, 0.1], [GUANMU, 0.08]];
  const MIX_GRASS = [[GUANMU, 0.36], [SHILIU, 0.22], [HUAI, 0.26], [YINXING, 0.12], [BAI, 0.04]];
  const MIX_UNI = [[HUAI, 0.34], [WUTONG, 0.2], [YINXING, 0.16], [XUESONG, 0.08], [BAI, 0.04], [SHILIU, 0.06], [GUANMU, 0.12]];
  const MIX_RES = [[HUAI, 0.34], [SHILIU, 0.14], [YINXING, 0.13], [GUANMU, 0.22], [WUTONG, 0.09], [LIU, 0.06], [XUESONG, 0.02]];
  const MIX_CEM = [[BAI, 0.55], [XUESONG, 0.15], [HUAI, 0.2], [GUANMU, 0.1]];
  const MIX_ORCH = [[SHILIU, 0.85], [GUANMU, 0.15]];
  const MIX_WORK = [[HUAI, 0.46], [WUTONG, 0.18], [YINXING, 0.08], [XUESONG, 0.04], [GUANMU, 0.24]];
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
    // boost：用地多边形可带的密度加成（如未央城市广场的集中绿地，离市中心远但是精建广场）
    const fo = Math.min(1, falloff((x0 + x1) / 2, (z0 + z1) / 2) * (f.boost || 1));
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
          if (excluded(x, z) || wallBlocked(x, z) || noTree(x, z)) continue;
          // 树种：40 m 尺度的同种林团
          let sp = hashI(Math.floor(x / 38), Math.floor(z / 38), 91 + seedN) < 0.6 ? pick(mix, hashI(Math.floor(x / 38), Math.floor(z / 38), 5 + seedN)) : pick(mix, rnd());
          if (sp !== GUANMU && nearWater(x, z, 8) && rnd() < 0.7) sp = LIU;
          if (axisBlocked(x, z, sp)) { stats.axis++; continue; }
          if (!treeFree(x, z, sp)) continue;
          addTree(x, z, sp, { lamp: rnd() < 0.25 ? 0.25 : 0, rankMul: 1, src: 7 });
          stats.landuse++;
          stats['lu_' + f.k] = (stats['lu_' + f.k] || 0) + 1;
        }
      }
    }
  }

  // —— 7b. 外圈：主种植区以外（距中心 12.5 km 起渐入）到渭河两岸、咸阳机场、长安区 ——
  // 此前 VEG_REGION 以外一棵树都没有（渭河南岸林带、机场陆侧绿化、长安区 34.134°N 以南光秃）。外圈用 6 m 粗栅格，
  // 只种公园/林地/草地/墓地/校园/大院/村镇绿化 + 主干道行道树 + 河岸垂柳，密度约为市中心的 0.28（与主区边缘衔接）。
  const nInner = n;
  if (input.outer !== false) {
    const OUT = VEG_OUTER, OC = 6;
    const B2 = new Grid(OUT, OC), RD2 = new Grid(OUT, OC), W2 = new Grid(OUT, OC), T2 = new Grid(OUT, OC);
    const ringW = (x, z) => {
      const r = Math.hypot(x - CENTER_X, z - CENTER_Z);
      return r < 12500 ? 0 : Math.min(1, (r - 12500) / 1500);
    };
    const bbRing = (x0, z0, x1, z1) => {
      // 外接矩形是否有任何部分在 12.5 km 圈外且与外圈相交
      if (x1 < OUT.x0 || x0 > OUT.x1 || z1 < OUT.z0 || z0 > OUT.z1) return false;
      const fx = Math.max(Math.abs(x0 - CENTER_X), Math.abs(x1 - CENTER_X)), fz = Math.max(Math.abs(z0 - CENTER_Z), Math.abs(z1 - CENTER_Z));
      return Math.hypot(fx, fz) > 12500;
    };
    if (bd) {
      const ring = [];
      for (let b = 0; b < bd.n; b++) {
        const ax = bd.ax[b], az = bd.az[b];
        if (ax < OUT.x0 - 300 || ax > OUT.x1 + 300 || az < OUT.z0 - 300 || az > OUT.z1 + 300) continue;
        if (Math.hypot(ax - CENTER_X, az - CENTER_Z) < 12000) continue;
        if (bd.mh[b] > 45) continue;
        const s = bd.vs[b], c = bd.vc[b];
        if (c < 3) continue;
        ring.length = 0;
        for (let k = 0; k < c; k++) ring.push(ax + bd.offs[(s + k) * 2] * 0.1, az + bd.offs[(s + k) * 2 + 1] * 0.1);
        fillRings(B2, [ring], true);
      }
    }
    for (const f of feats) {
      if (f.t) continue;
      const p = f.p;
      if (!p || p.length < 4) continue;
      const hw = roadW(f) / 2 + (f.b ? 2.5 : 0.3);
      for (let i = 0; i + 3 < p.length; i += 2) if (ringW(p[i], p[i + 1]) > 0 || ringW(p[i + 2], p[i + 3]) > 0) stampCapsule(RD2, p[i], p[i + 1], p[i + 2], p[i + 3], hw);
    }
    for (const f of input.rail?.features || []) {
      const p = f.p;
      if (f.t || !p || p.length < 4) continue;
      for (let i = 0; i + 3 < p.length; i += 2) if (ringW(p[i], p[i + 1]) > 0) stampCapsule(RD2, p[i], p[i + 1], p[i + 2], p[i + 3], 5);
    }
    for (const w of water.polys || []) {
      if (!w.outer || w.outer.length < 6) continue;
      fillRings(W2, [w.outer, ...(w.holes || []).filter((h) => h.length >= 6 && ringArea(h) >= 400)], false);
    }
    for (const l of water.lines || []) {
      const p = l.p;
      if (!p || p.length < 4) continue;
      for (let i = 0; i + 3 < p.length; i += 2) if (ringW(p[i], p[i + 1]) > 0) stampCapsule(W2, p[i], p[i + 1], p[i + 2], p[i + 3], Math.max(2, (l.w || 8) / 2));
    }
    const inOut = (x, z) => x > OUT.x0 + 20 && x < OUT.x1 - 20 && z > OUT.z0 + 20 && z < OUT.z1 - 20;
    const free2 = (x, z, sp, bClear = 3) => {
      if (!inOut(x, z) || T2.at(x, z)) return false;
      if (inRegion(x, z) && (nearAny(T, x, z, 2.5) || HB.at(x, z) || noTree(x, z) || axisBlocked(x, z, sp) || wallBlocked(x, z))) return false; // 与主区边缘的树/绿篱/禁种区衔接
      if (nearAny(B2, x, z, bClear) || nearAny(W2, x, z, 2)) return false;
      if (excluded(x, z)) return false;
      return true;
    };
    const add2 = (x, z, sp, opt) => {
      addTree(x, z, sp, { ...opt, exb: false, bg: B2 });
      T2.mark(x, z);
      if (sp === WUTONG || sp === XUESONG || sp === BAI) for (const [dx, dz] of [[OC, 0], [-OC, 0], [0, OC], [0, -OC]]) T2.mark(x + dx, z + dz);
      stats.outer++;
    };
    // 快速路/主干道/次干道行道树（间距放大、概率约三成）
    for (const f of feats) {
      const cfg = STREET[f.c];
      if (!cfg || f.b || f.t || f.c > 3) continue;
      const p = f.p;
      if (!p || p.length < 4) continue;
      let inRing = false;
      for (let i = 0; i < p.length && !inRing; i += 2) if (ringW(p[i], p[i + 1]) > 0 && inOut(p[i], p[i + 1])) inRing = true;
      if (!inRing) continue;
      const [spacing, curb, prob, lamp] = cfg;
      const hw = roadW(f) / 2;
      const [sp0, loyal] = roadSpecies(f);
      const L = lenOf(p);
      for (const side of [1, -1]) {
        if (f.o && side === -1) continue; // 单行道左侧（分隔带）外圈不种
        let seg = 0, segStart = 0, segLen = Math.hypot(p[2] - p[0], p[3] - p[1]);
        for (let s = rnd() * spacing; s < L; s += spacing * (1.25 + rnd() * 0.3)) {
          while (seg < p.length / 2 - 2 && s > segStart + segLen) {
            segStart += segLen;
            seg++;
            segLen = Math.hypot(p[seg * 2 + 2] - p[seg * 2], p[seg * 2 + 3] - p[seg * 2 + 1]);
          }
          const t = segLen > 0 ? (s - segStart) / segLen : 0;
          const ax = p[seg * 2], az = p[seg * 2 + 1], bx = p[seg * 2 + 2], bz = p[seg * 2 + 3];
          const dx = (bx - ax) / (segLen || 1), dz = (bz - az) / (segLen || 1);
          const nx = -dz * side, nz = dx * side;
          const off = hw + curb + (rnd() - 0.5) * 0.5;
          const x = ax + (bx - ax) * t + nx * off, z = az + (bz - az) * t + nz * off;
          const w = ringW(x, z);
          if (!w || rnd() > prob * 0.3 * w) continue;
          if (roadHit(x, z, 0.9)) continue;
          let sp = rnd() < loyal ? sp0 : pick(OTHER_STREET, rnd());
          if (sp === WUTONG && hw < 5) sp = HUAI;
          if (!free2(x, z, sp, 1.5)) continue;
          add2(x, z, sp, { lamp: lamp * 0.8, sMul: 0.9, rankMul: 0.8, src: 9, face: [-nx, -nz] });
          stats.outerStreet = (stats.outerStreet || 0) + 1;
        }
      }
    }
    // 河岸垂柳（线状河道两岸、湖/河/水库岸线外侧）
    const bank2 = (x, z) => {
      const w = ringW(x, z);
      if (!w || rnd() > 0.5 * w) return;
      if (W2.at(x, z) || nearAny(RD2, x, z, 1)) return;
      const sp = rnd() < 0.8 ? LIU : pick(BANKMIX, rnd());
      if (!free2(x, z, sp, 2)) return;
      add2(x, z, sp, { lamp: 0, rankMul: 0.9, src: 9 });
      stats.outerBank = (stats.outerBank || 0) + 1;
    };
    for (const l of water.lines || []) {
      const p = l.p;
      if (!p || p.length < 4 || !(l.w > 6)) continue;
      const hw = l.w / 2;
      let s = 0;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const ax = p[k], az = p[k + 1], bx = p[k + 2], bz = p[k + 3];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.1) continue;
        if (!ringW(ax, az) && !ringW(bx, bz)) { s = 0; continue; }
        const tx = (bx - ax) / L, tz = (bz - az) / L;
        for (; s < L; s += 10 + rnd() * 4)
          for (const side of [1, -1]) {
            const d = hw + 4 + rnd() * 3;
            bank2(ax + tx * s - tz * side * d, az + tz * s + tx * side * d);
          }
        s -= L;
      }
    }
    for (const w of water.polys || []) {
      if (!w.outer || w.outer.length < 6 || !['lake', 'pond', 'river', 'canal', 'reservoir'].includes(w.k)) continue;
      const p = w.outer;
      let s = rnd() * 10;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
        const ax = p[j], az = p[j + 1], bx = p[i], bz = p[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.1) continue;
        if (!ringW(ax, az) && !ringW(bx, bz)) { s = 0; continue; }
        const tx = (bx - ax) / L, tz = (bz - az) / L;
        for (; s < L; s += 10 + rnd() * 4)
          for (const side of [1, -1]) bank2(ax + tx * s - tz * side * 5, az + tz * s + tx * side * 5);
        s -= L;
      }
    }
    // 用地撒点（林地/公园保持成林的观感，村镇居住区很稀）
    const LU2 = { park: 1500, forest: 1200, grass: 5000, university: 2500, residential: 9000, cemetery: 800, military: 5000 };
    for (const f of polys) {
      const area = LU2[f.k];
      if (!area || !f.outer || f.outer.length < 6) continue;
      const [, mix, clump] = LU[f.k];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      const o = f.outer;
      for (let i = 0; i < o.length; i += 2) {
        if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i]; if (o[i + 1] < z0) z0 = o[i + 1]; if (o[i + 1] > z1) z1 = o[i + 1];
      }
      if (!bbRing(x0, z0, x1, z1)) continue;
      const step = Math.sqrt(area * 0.55);
      const rings = [o, ...(f.holes || [])];
      const seedN = (strHash(f.n || '') * 1000) | 0;
      for (let zr = Math.max(z0, OUT.z0) + step * 0.5; zr < Math.min(z1, OUT.z1); zr += step) {
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
        for (let q = 0; q + 1 < xs.length; q += 2)
          for (let xr = Math.max(xs[q], OUT.x0) + step * rnd(); xr < Math.min(xs[q + 1], OUT.x1); xr += step) {
            const x = xr + (rnd() - 0.5) * step * 0.9, z = zr + (rnd() - 0.5) * step * 0.9;
            const w = ringW(x, z);
            if (!w) continue;
            const nz = vnoise(x / 55, z / 55, 11 + seedN) * 0.7 + vnoise(x / 17, z / 17, 23) * 0.3;
            const dens = 1 - clump + clump * Math.max(0, Math.min(1, (nz - 0.3) * 2.6));
            if (rnd() > dens * w) continue;
            if (nearAny(RD2, x, z, 1)) continue;
            let sp = hashI(Math.floor(x / 38), Math.floor(z / 38), 91 + seedN) < 0.6 ? pick(mix, hashI(Math.floor(x / 38), Math.floor(z / 38), 5 + seedN)) : pick(mix, rnd());
            if (sp !== GUANMU && nearAny(W2, x, z, 8) && rnd() < 0.7) sp = LIU;
            if (!free2(x, z, sp)) continue;
            add2(x, z, sp, { lamp: 0, rankMul: 1, src: 9 });
            stats['outer_' + f.k] = (stats['outer_' + f.k] || 0) + 1;
          }
      }
    }
  }

  // —— 8. 数量上限：超出时随机剔除（保持分布均匀；主区与外圈分别计） ——
  let keep = null;
  const nOuter = n - nInner;
  if (nInner > MAX_TREES || nOuter > MAX_OUTER) {
    keep = new Uint8Array(n);
    const pi = Math.min(1, MAX_TREES / nInner), po = Math.min(1, MAX_OUTER / Math.max(1, nOuter));
    for (let i = 0; i < n; i++) keep[i] = rnd() < (i < nInner ? pi : po) ? 1 : 0;
  }

  // —— 9. 按渲染块排序（输出区域 = 外圈范围） ——
  const RO = VEG_OUTER;
  const NCX = Math.ceil((RO.x1 - RO.x0) / VEG_CHUNK), NCZ = Math.ceil((RO.z1 - RO.z0) / VEG_CHUNK);
  const nC = NCX * NCZ;
  const cidx = new Int32Array(n);
  const counts = new Uint32Array(nC + 1);
  for (let i = 0; i < n; i++) {
    if (keep && !keep[i]) { cidx[i] = -1; continue; }
    const cx = Math.min(NCX - 1, Math.max(0, Math.floor((X[i] - RO.x0) / VEG_CHUNK)));
    const cz = Math.min(NCZ - 1, Math.max(0, Math.floor((Z[i] - RO.z0) / VEG_CHUNK)));
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
  if (input.debug) out.src = new Uint8Array(total);
  for (let i = 0; i < n; i++) {
    if (cidx[i] < 0) continue;
    const k = fill[cidx[i]]++;
    out.x[k] = X[i]; out.z[k] = Z[i]; out.sp[k] = SPC[i]; out.sc[k] = SC[i]; out.rot[k] = ROT[i];
    out.rank[k] = RK[i]; out.lamp[k] = LAMP[i]; out.yel[k] = YEL[i]; out.br[k] = BR[i];
    if (out.src) out.src[k] = SRCA[i];
  }
  // 绿篱同样分块
  const hc = new Int32Array(hn);
  const hcounts = new Uint32Array(nC + 1);
  for (let i = 0; i < hn; i++) {
    const cx = Math.min(NCX - 1, Math.max(0, Math.floor((HED[i * 7] - RO.x0) / VEG_CHUNK)));
    const cz = Math.min(NCZ - 1, Math.max(0, Math.floor((HED[i * 7 + 1] - RO.z0) / VEG_CHUNK)));
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
  const spCount = new Uint32Array(8);
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
    region: RO,
    chunk: VEG_CHUNK,
    stats: { ...stats, generated: n, total, buildings: nb, species: Array.from(spCount), ms: Date.now() - t0 },
  };
}

/** 结果中需要转移（transfer）的 ArrayBuffer 列表 */
export function transferList(r) {
  return [r.x, r.z, r.sp, r.sc, r.rot, r.rank, r.lamp, r.yel, r.br, r.chunkStart, r.hedges, r.hedgeStart].map((a) => a.buffer);
}
