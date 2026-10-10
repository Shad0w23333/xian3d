// 道路/铁路网预处理（roads 模块专用）：拆边、路口分析、对向车道配对、灯位、铁路链与高架抬升。
// 纯 CPU 计算，不创建任何 three 对象。所有坐标为世界坐标（米，X 东 Z 南）。
import { chainage } from '../core/roadheight.js';
import { DISTRICTS } from './streetscape-data.js';

// —— 道路等级配置（下标与 roads.json classes 一致） ——
// rank：路口主次；minW：最小路面宽（米）；dashLong：6m/9m 长虚线（设计速度≥60），否则 2m/4m；
// lamp：路灯间距（米，0=不布灯）；sw：人行道宽（米，0=无）；far：远景是否保留（'core'=仅核心区）
export const CFG = [
  { id: 'motorway', rank: 10, major: 1, minW: 7.5, dashLong: 1, lamp: 42, sw: 0, far: 1, edge: 0.2 },
  { id: 'trunk', rank: 9, major: 1, minW: 7, dashLong: 1, lamp: 36, sw: 4.5, far: 1, edge: 0.18 },
  { id: 'primary', rank: 8, major: 1, minW: 7, dashLong: 1, lamp: 34, sw: 5, far: 1, edge: 0.15 },
  { id: 'secondary', rank: 7, major: 1, minW: 6.5, dashLong: 0, lamp: 32, sw: 4, far: 1, edge: 0.15 },
  { id: 'tertiary', rank: 6, major: 1, minW: 6, dashLong: 0, lamp: 30, sw: 3, far: 'core', edge: 0.15 },
  // 支路/小区路：单侧路灯（间距约 36 m）。远景灯点在主干道光带之间铺出一层暗的灯网，人眼高度小巷夜里也有光斑
  { id: 'residential', rank: 3, major: 0, minW: 5, dashLong: 0, lamp: 36, sw: 0, far: 0, noMark: 1, lampOne: 1 },
  { id: 'service', rank: 2, major: 0, minW: 3.5, dashLong: 0, lamp: 0, sw: 0, far: 0, noMark: 1 },
  { id: 'unclassified', rank: 4, major: 0, minW: 5, dashLong: 0, lamp: 38, sw: 0, far: 0, noMark: 1, lampOne: 1 },
  { id: 'motorway_link', rank: 5, major: 1, link: 1, minW: 4.5, dashLong: 1, lamp: 0, sw: 0, far: 1, edge: 0.15 },
  { id: 'trunk_link', rank: 5, major: 1, link: 1, minW: 4.5, dashLong: 1, lamp: 0, sw: 0, far: 1, edge: 0.15 },
  { id: 'primary_link', rank: 5, major: 1, link: 1, minW: 4.5, dashLong: 1, lamp: 0, sw: 0, far: 1, edge: 0.15 },
  { id: 'secondary_link', rank: 5, major: 1, link: 1, minW: 4, dashLong: 0, lamp: 0, sw: 0, far: 'core', edge: 0.15 },
  { id: 'pedestrian', rank: 2, major: 0, minW: 4, dashLong: 0, lamp: 0, sw: 0, far: 0, paving: 1 },
  { id: 'footway', rank: 1, major: 0, minW: 2, dashLong: 0, lamp: 0, sw: 0, far: 0, paving: 1 },
];

// 标志位（aRoad.z），着色器里按位解码
export const F = {
  ONEWAY: 1,
  MEDIAN: 2, // 左侧为中央分隔带（左边线用黄色实线）
  DASHLONG: 4,
  LAMPS: 8, // 夜间路面光斑（远景程序化）
  NOMARK: 16,
  MOTORWAY: 32,
  LINK: 64,
  CW0: 128, // 起点端有人行横道
  CW1: 256, // 终点端有人行横道
  EDGES: 512, // 画边线
  PAIRED: 1024, // 有对向车道（左侧中央分隔带灯）
  // 2048/4096/8192 为 roads.js 的路灯侧别位（LAMPL/LAMPR/LAMPM）
  FOOTWAY: 16384, // 公园/小区步道（铺装着色用较深的暖灰石材）
};

// 表面种类（aRoad.x）
export const KIND = { ASPHALT: 0, SIDEWALK: 1, CURB: 2, BALLAST: 4, RAIL: 5, PAVING: 7 };

// 中国结路灯：东西南北大街、长安路；唐风宫灯：曲江/大雁塔一带；红灯笼：二环
const KNOT_NAMES = /^(东大街|西大街|南大街|北大街|长安北路|长安中路|长安南路|长安路)$/;
const PALACE_NAMES = /(雁塔|芙蓉|曲江|慈恩|大唐|雁南|雁展|大雁塔|玄奘|唐延)/;
const LANTERN_NAMES = /二环/;

// 灯型（KNOT2 = 中国结装饰灯的不挂结款，与 KNOT 隔杆交替）
export const LAMP = { SINGLE: 0, DOUBLE: 1, KNOT: 2, PALACE: 3, LANTERN: 4, KNOT2: 5 };

/**
 * 景区步行化区：OSM 把广场里的门洞通道、绕楼环路、广场边的单车道标成 residential/service/unclassified，
 * 画成沥青车行道、跑车（审查 P1：鼓楼前石材广场被三条沥青路切开）。
 *   p：区内（≥60% 取样点）的支路一律按步行道（f._ped，石板铺装、不布灯、不跑车、放行人），不论有没有路名；
 *   cut：只有一段穿过广场的支路（西大街北侧单车道）在这些多边形里不画、不通车（roads 模块 prepare 登记 roads 排除区）。
 */
export const PED_ZONES = [
  {
    name: '钟鼓楼广场',
    p: [-395, -165, -60, -165, -60, 12, -395, 12],
    // 西大街北侧单车道（OSM 无名 unclassified 3.5 m）在鼓楼—钟鼓楼广场南缘这一段：中线两侧各 2.3 m
    cut: [[-100, -5.4, -226, -0.3, -269, -1.3, -325, -0.3, -356, -0.1, -356, 4.5, -325, 4.3, -269, 3.3, -226, 4.3, -100, -0.6]],
  },
];
const inPoly = (x, z, p) => {
  let c = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

/**
 * 建成区密度：buildings.bin（原始缓冲）建筑占地面积按 250 m 格累加，返回 dens(x, z) = 该处 3×3 邻域（750 m 见方）
 * 的建筑覆盖率（0~1）。按占地面积而不是栋数：浐灞、空港新城这类新区楼少而大，按栋数会被当成郊野。
 * 缓冲缺失或格式不符时返回 null（调用方按“处处建成区”处理）。
 */
export function urbanDensity(buffer) {
  if (!buffer || buffer.byteLength < 16) return null;
  const dv = new DataView(buffer);
  if (dv.getUint8(0) !== 88 || dv.getUint8(1) !== 66 || dv.getUint8(2) !== 76 || dv.getUint8(3) !== 68) return null;
  const version = dv.getUint32(4, true), count = dv.getUint32(8, true), totalVerts = dv.getUint32(12, true);
  let o = 16;
  const ax = new Float32Array(buffer, o, count); o += count * 4;
  const az = new Float32Array(buffer, o, count); o += count * 4;
  const vs = new Uint32Array(buffer, o, count); o += count * 4;
  const vc = new Uint16Array(buffer, o, count); o += count * 2;
  o += count * 2 * 2 + count * 2 + (version >= 2 ? count : 0); // 高度、底高、kind、flags、style
  o = (o + 3) & ~3;
  if (o + totalVerts * 4 > buffer.byteLength) return null;
  const offs = new Int16Array(buffer, o, totalVerts * 2);
  const C = 250, OFF = 72000, NG = 576; // 覆盖 ±72 km
  const grid = new Float32Array(NG * NG);
  const cell = (v) => Math.max(0, Math.min(NG - 1, Math.floor((v + OFF) / C)));
  for (let i = 0; i < count; i++) {
    const s = vs[i] * 2, n = vc[i];
    let A = 0;
    for (let j = 0, k = n - 1; j < n; k = j++) A += offs[s + k * 2] * offs[s + j * 2 + 1] - offs[s + j * 2] * offs[s + k * 2 + 1];
    grid[cell(ax[i]) * NG + cell(az[i])] += Math.abs(A) * 0.005; // 分米² → 米²（含 1/2）
  }
  const memo = new Map(), AREA = 9 * C * C;
  return (x, z) => {
    const cx = cell(x), cz = cell(z), k = cx * NG + cz;
    let v = memo.get(k);
    if (v === undefined) {
      v = 0;
      for (let i = Math.max(0, cx - 1); i <= Math.min(NG - 1, cx + 1); i++)
        for (let j = Math.max(0, cz - 1); j <= Math.min(NG - 1, cz + 1); j++) v += grid[i * NG + j];
      v /= AREA;
      memo.set(k, v);
    }
    return v;
  };
}
/** 城市建设用地（OSM landuse：居住/商业/工业/高校/在建）点查询，500 m 格网索引 */
export function urbanLanduse(landuse) {
  const KINDS = new Set(['residential', 'commercial', 'industrial', 'university', 'construction']);
  const polys = (landuse?.polys || []).filter((q) => KINDS.has(q.k) && q.outer && q.outer.length >= 6);
  const CELL = 500, grid = new Map();
  for (const q of polys) {
    const o = q.outer;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    if (x1 - x0 > 20000 || z1 - z0 > 20000) continue;
    const it = { o, bb: [x0, z0, x1, z1] };
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = cx * 100003 + cz;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(it);
      }
  }
  return (x, z) => {
    const a = grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (a) for (const it of a) { const b = it.bb; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inPoly(x, z, it.o)) return true; }
    return false;
  };
}
// 建成区阈值（750 m 见方内建筑覆盖率）：低于 URBAN_MIN 且不在城市建设用地内为田野/郊野（乡道、田间路不布灯）；
// 核心区外达到 FAR_URBAN（或在远郊新城名单里）的补画次干道与三级路
export const URBAN_MIN = 0.02;
export const FAR_URBAN = 0.07;
// 核心区外的新城/城区（经纬度框）：空港新城、长安区（韦曲/郭杜/大学城）、沣东/沣西、秦汉/泾河、港务区、临潼
export const FAR_DISTRICTS = [
  ['空港新城', 108.72, 34.38, 108.87, 34.47],
  ['长安区', 108.82, 34.07, 109.02, 34.17],
  ['沣东沣西', 108.66, 34.19, 108.84, 34.33],
  ['秦汉泾河', 108.74, 34.35, 109.0, 34.5],
  ['港务区', 109.06, 34.28, 109.14, 34.42],
  ['临潼', 109.18, 34.34, 109.26, 34.4],
];

export const BIKE_W = 2.4; // 人非共板：非机动车道 2.0 m + 两侧收边
const inStreetscape = (x, z) => DISTRICTS.some((D) => D.bbox && x > D.bbox[0] - 100 && x < D.bbox[2] + 100 && z > D.bbox[1] - 100 && z < D.bbox[3] + 100);
// 公交专用道（最外侧车道，黄色虚线 + “公交专用”）：只给公交走廊上的主干道、单向 ≥3 车道的路段（示意性选取，非官方名单）
const BUS_NAMES = /^(长安北路|长安中路|长安南路|北大街|南大街|未央路|朱雀大街|太白南路|太白北路|含光路|雁塔北路|雁塔路|科技路|友谊西路|友谊东路|西二环|东二环|北二环|南二环)/;
/** 字符串散列 → [0,1) */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

const nodeKey = (x, z) => (Math.round(x * 10) + 700000) * 2000000 + (Math.round(z * 10) + 1000000);

/**
 * 景区/公园/广场里的无名支路（OSM 常把寺院甬道、园路、广场通道标成 service/unclassified/residential）：
 * 要素 60% 以上的顶点与段中点落在 landuse 的 park/square 多边形内 → 标 f._ped = 1，按步行道处理
 * （roads 画石板铺装、不布路灯；traffic 不跑车；pedestrians 当步行街放人）。有名字的街道一律不动。
 * 结果缓存在 roads 上（不可枚举属性），各模块重复调用无开销。返回标记数。
 */
export function markParkWalkways(roads, landuse) {
  if (!roads || !roads.features) return 0;
  if (roads._parkWalk !== undefined) return roads._parkWalk;
  const polys = (landuse?.polys || []).filter((q) => (q.k === 'park' || q.k === 'square') && q.outer && q.outer.length >= 6);
  const CELL = 500, grid = new Map();
  for (const q of polys) {
    const o = q.outer;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    q._bb = [x0, z0, x1, z1];
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = cx * 100003 + cz;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(q);
      }
  }
  const pip = (x, z, p) => {
    let c = false;
    for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const inPark = (x, z) => {
    const a = grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (a) for (const q of a) { const b = q._bb; if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pip(x, z, q.outer)) return true; }
    return false;
  };
  let n = 0;
  const frac = (p, test) => {
    let hit = 0, tot = 0;
    for (let i = 0; i < p.length; i += 2) {
      tot++; if (test(p[i], p[i + 1])) hit++;
      if (i + 3 < p.length) { tot++; if (test((p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2)) hit++; }
    }
    return hit / tot;
  };
  const mark = (f, k, v) => Object.defineProperty(f, k, { value: v, writable: true, configurable: true, enumerable: false });
  for (const f of roads.features) {
    if ((f.c !== 5 && f.c !== 6 && f.c !== 7) || f.b || f.t || !f.p || f.p.length < 4) continue;
    const p = f.p;
    // 景区步行化区（不论路名）
    const z = PED_ZONES.find((Z) => frac(p, (x, zz) => inPoly(x, zz, Z.p)) >= 0.6);
    if (z) { mark(f, '_ped', 1); mark(f, '_pedZone', z.name); n++; continue; }
    if (f.n) continue;
    if (frac(p, inPark) >= 0.6) { mark(f, '_ped', 1); n++; }
  }
  Object.defineProperty(roads, '_parkWalk', { value: n, writable: true, configurable: true, enumerable: false });
  return n;
}

/** 读入道路要素，给出有效宽度、车道数、标志 */
function featureInfo(f) {
  const cfg = CFG[f._ped ? 12 : f.c] || CFG[7];
  const lanes = Math.max(1, Math.min(8, f.l | 0 || 1));
  let W = Number(f.w) || cfg.minW;
  if (!cfg.paving) W = Math.max(W, cfg.minW, lanes * (cfg.rank >= 8 ? 3.4 : 3.1));
  W = Math.min(W, 42);
  return { cfg, lanes, W };
}

/**
 * 构建道路网络：拆边 + 路口分析 + 配对。
 * 返回 {edges, feats}，edges 为数组：
 *  {fi, i0, i1, s0, s1, len, W, lanes, flags, cls, R0, R1, trim0, trim1, sw0, sw1, swR, swL, gap, pairF}
 */
export function buildRoadNet(roads, { inDetail }) {
  const feats = roads?.features || [];
  const nF = feats.length;
  const info = new Array(nF);
  const chain = new Array(nF);
  const total = new Float32Array(nF);
  // —— 节点表 ——
  const nodeId = new Map();
  let nNodes = 0;
  const incF = [], incV = []; // 每个节点的入射（要素、顶点）链表：用扁平数组 + 头指针
  const head = [], next = [];
  const featNodes = new Array(nF);
  for (let fi = 0; fi < nF; fi++) {
    const f = feats[fi];
    info[fi] = featureInfo(f);
    info[fi].sw = info[fi].cfg.sw;
    const p = f.p;
    if (!p || p.length < 4 || f.t) continue;
    // 人非共板非机动车道（人行道加宽 2.4 m：设施带外侧 2 m 绿色铺装 + 自行车图标）：二环外有名的主次干道约一半（按路名整条一致）
    if ((f.c === 2 || f.c === 3) && !f.b && f.n) {
      const mx = p[(p.length >> 2) * 2], mz = p[(p.length >> 2) * 2 + 1];
      if (inDetail(mx, mz) && Math.hypot(mx, mz) > 2700 && hashStr('bike:' + f.n) < 0.5 && !inStreetscape(mx, mz)) {
        info[fi].sw = info[fi].cfg.sw + BIKE_W;
        info[fi].bike = 1;
      }
    }
    const ch = chainage(p);
    chain[fi] = ch;
    total[fi] = ch[ch.length - 1];
    const n = p.length / 2;
    const nodes = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = nodeKey(p[i * 2], p[i * 2 + 1]);
      let id = nodeId.get(k);
      if (id === undefined) {
        id = nNodes++;
        nodeId.set(k, id);
        head.push(-1);
      }
      nodes[i] = id;
      const e = incF.length;
      incF.push(fi);
      incV.push(i);
      next.push(head[id]);
      head[id] = e;
    }
    featNodes[fi] = nodes;
  }
  // 节点度（半边数：端点 1，中间点 2）
  const degAll = new Uint8Array(nNodes), degMaj = new Uint8Array(nNodes);
  for (let e = 0; e < incF.length; e++) {
    const fi = incF[e], i = incV[e];
    const n = feats[fi].p.length / 2;
    const d = i === 0 || i === n - 1 ? 1 : 2;
    let id = featNodes[fi][i];
    degAll[id] = Math.min(255, degAll[id] + d);
    if (info[fi].cfg.major) degMaj[id] = Math.min(255, degMaj[id] + d);
  }

  // —— 拆边 ——
  const edges = [];
  for (let fi = 0; fi < nF; fi++) {
    const nodes = featNodes[fi];
    if (!nodes) continue;
    const f = feats[fi];
    const { cfg } = info[fi];
    const n = nodes.length;
    let start = 0;
    for (let i = 1; i < n; i++) {
      const id = nodes[i];
      const split = i === n - 1 || (cfg.major ? degMaj[id] >= 3 : degAll[id] >= 3);
      if (!split) continue;
      const s0 = chain[fi][start], s1 = chain[fi][i];
      if (s1 - s0 > 0.5) edges.push({ fi, i0: start, i1: i, s0, s1, len: s1 - s0, n0: nodes[start], n1: id });
      start = i;
    }
  }

  // —— 路口分析 ——
  const dirAt = (fi, i, sgn, out) => {
    // 从顶点 i 沿 sgn 方向走约 8 m 的单位方向
    const p = feats[fi].p, n = p.length / 2;
    const x0 = p[i * 2], z0 = p[i * 2 + 1];
    let j = i + sgn;
    let dx = 0, dz = 0;
    while (j >= 0 && j < n) {
      dx = p[j * 2] - x0;
      dz = p[j * 2 + 1] - z0;
      if (dx * dx + dz * dz > 64) break;
      j += sgn;
    }
    const l = Math.hypot(dx, dz) || 1;
    out[0] = dx / l;
    out[1] = dz / l;
    return out;
  };
  const dA = [0, 0], dB = [0, 0], dC = [0, 0];
  // 从节点 node 处的顶点 (fj, j) 沿 sgn 走到下一个路口节点（度 ≥3）或折线端点的距离与该节点
  const runToJunction = (fj, j, sgn) => {
    const ch = chain[fj], nodes = featNodes[fj], n = nodes.length;
    let k = j + sgn;
    while (k > 0 && k < n - 1 && degAll[nodes[k]] < 3) k += sgn;
    k = Math.max(0, Math.min(n - 1, k));
    return { d: Math.abs(ch[k] - ch[j]), node: nodes[k], k };
  };
  // 可驶出的路口出口方向（相对来车方向 T）：bit0 左转、bit1 直行、bit2 右转。路口内部短连接段（<45 m，双幅路
  // 两幅之间）沿直行方向再看一层，双幅路交叉口第一个节点处也能看到对面那幅才有的左转。
  const turnMaskAt = (node, Tx, Tz, depth) => {
    let mask = 0;
    for (let e = head[node]; e >= 0; e = next[e]) {
      const fj = incF[e], j = incV[e];
      const fo = feats[fj], oth = info[fj];
      if (!(oth.cfg.major || oth.cfg.rank >= 3) || oth.cfg.paving || fo.t) continue;
      const nj = fo.p.length / 2;
      for (const sgn of [1, -1]) {
        const jj = j + sgn;
        if (jj < 0 || jj >= nj) continue;
        if (fo.o && sgn < 0) continue; // 单行道逆向不可驶出
        dirAt(fj, j, sgn, dC);
        const dot = Tx * dC[0] + Tz * dC[1];
        if (dot < -0.85) continue; // 掉头/来路
        const cr = Tx * dC[1] - Tz * dC[0];
        if (dot > 0.7) {
          mask |= 2;
          if (depth > 0) {
            const r = runToJunction(fj, j, sgn);
            if (r.d < 45 && r.node !== node && degAll[r.node] >= 3) mask |= turnMaskAt(r.node, dC[0], dC[1], depth - 1) & 5;
          }
        } else mask |= cr < 0 ? 1 : 4; // x 东 z 南：叉积 <0 为左
      }
    }
    return mask;
  };
  const analyzeEnd = (E, atStart) => {
    const fi = E.fi;
    const node = atStart ? E.n0 : E.n1;
    const vi = atStart ? E.i0 : E.i1;
    const me = info[fi];
    const res = { R: 0, trim: 0, sw: 0, nX: 0, nXcw: 0, cw: false, turn: 0 };
    if (degAll[node] < 3 && !(me.cfg.link && degAll[node] >= 2)) return res;
    dirAt(fi, vi, atStart ? 1 : -1, dA);
    // 驶向本端的车辆可用的转向（单行道只在终点端有来车）
    if (me.cfg.major && (!feats[fi].o || !atStart)) res.turn = turnMaskAt(node, -dA[0], -dA[1], 1);
    for (let e = head[node]; e >= 0; e = next[e]) {
      const fj = incF[e], j = incV[e];
      const nj = feats[fj].p.length / 2;
      const oth = info[fj];
      for (const sgn of [1, -1]) {
        const jj = j + sgn;
        if (jj < 0 || jj >= nj) continue;
        if (fj === fi && j === vi && sgn === (atStart ? 1 : -1)) continue; // 自身
        dirAt(fj, j, sgn, dB);
        const cos = dA[0] * dB[0] + dA[1] * dB[1];
        const sin = Math.abs(dA[0] * dB[1] - dA[1] * dB[0]);
        const hw = oth.W / 2;
        if (sin < 0.3) {
          // 近似共线：延续段或合流匝道
          if (me.cfg.link && !oth.cfg.link && oth.cfg.major && cos > 0.6 && fj !== fi) {
            res.trim = Math.max(res.trim, Math.min(38, hw / Math.max(sin, 0.22)));
          }
          continue;
        }
        const k = 1 / Math.max(sin, 0.45);
        if (me.cfg.major) {
          if (oth.cfg.major) {
            res.R = Math.max(res.R, hw * k + 0.6);
            res.nX++;
            // 人行横道只认真正的横街：中央分隔带开口（双幅路两幅之间 <45 m 的掉头连接段，远端只接回与本路平行的路）不算
            if (!oth.cfg.link) {
              const r = runToJunction(fj, j, sgn);
              let connector = false;
              if (r.d < 45 && degAll[r.node] >= 3) {
                connector = true;
                for (let e2 = head[r.node]; e2 >= 0 && connector; e2 = next[e2]) {
                  const fk = incF[e2], k2 = incV[e2];
                  if (fk === fj || !info[fk].cfg.major) continue;
                  const nk = feats[fk].p.length / 2;
                  for (const s2 of [1, -1]) {
                    if (k2 + s2 < 0 || k2 + s2 >= nk) continue;
                    dirAt(fk, k2, s2, dC);
                    if (Math.abs(dA[0] * dC[0] + dA[1] * dC[1]) < 0.85) { connector = false; break; }
                  }
                }
              }
              if (!connector) res.nXcw++;
            }
            const bigger = oth.cfg.rank > me.cfg.rank || (oth.cfg.rank === me.cfg.rank && fj < fi);
            res.sw = Math.max(res.sw, (hw + (bigger ? oth.sw : 0)) * k);
          } else if (oth.cfg.rank >= 3 && oth.W >= 6) {
            // 次要道路接入：人行道留出路口（不画路口箱体）
            res.sw = Math.max(res.sw, hw * k);
          }
        } else if (oth.cfg.rank > me.cfg.rank && oth.cfg.major) {
          res.trim = Math.max(res.trim, hw * k - 0.05);
        } else if (oth.cfg.rank > me.cfg.rank && oth.cfg.rank >= 3) {
          res.trim = Math.max(res.trim, hw * k * 0.9);
        }
      }
    }
    res.R = Math.min(res.R, 45);
    res.trim = Math.min(res.trim, 45);
    res.sw = Math.min(res.sw, 50);
    return res;
  };

  for (const E of edges) {
    const f = feats[E.fi];
    const { cfg, lanes, W } = info[E.fi];
    E.W = W;
    E.lanes = lanes;
    E.cls = f.c;
    E.b = f.b ? 1 : 0;
    E.oneway = f.o ? 1 : 0;
    const a = analyzeEnd(E, true), b = analyzeEnd(E, false);
    E.R0 = a.R; E.R1 = b.R;
    E.trim0 = a.trim; E.trim1 = b.trim;
    E.sw0 = a.sw; E.sw1 = b.sw;
    let flags = 0;
    if (E.oneway) flags |= F.ONEWAY;
    if (cfg.dashLong) flags |= F.DASHLONG;
    if (cfg.noMark || cfg.paving) flags |= F.NOMARK;
    if (f.c === 0) flags |= F.MOTORWAY;
    if (cfg.link) flags |= F.LINK;
    if (cfg.major && !cfg.link) flags |= F.EDGES;
    if (f.c === 13) flags |= F.FOOTWAY;
    const cwOk = cfg.major && !cfg.link && f.c >= 2 && f.c <= 4 && !E.b;
    // 两端路口之间要放得下斑马线（各 R+6 m）：双幅路口内部两幅之间的短段（路口中心）不画
    const roomOk = E.len > Math.max(28, a.R + b.R + 14);
    if (cwOk && roomOk && a.nXcw >= 1 && a.R > 0 && a.R < 30) flags |= F.CW0;
    if (cwOk && roomOk && b.nXcw >= 1 && b.R > 0 && b.R < 30) flags |= F.CW1;
    E.flags = flags;
    E.turn0 = a.turn;
    E.turn1 = b.turn;
    // 路段标线属性（着色器 aDet.y 位）：1 公交专用道（最外侧车道）、2 右侧禁停黄线、4 右侧禁止长时停车（黄虚线）
    E.mark = 0;
    if (!E.b && !cfg.link && cfg.major) {
      const perSide = f.o ? lanes : lanes >> 1;
      if ((f.c === 1 || f.c === 2) && perSide >= 3 && BUS_NAMES.test(f.n || '') && E.len > 120) E.mark |= 1;
      if (cfg.sw > 0) {
        // 禁停黄线：主次干道大部分路段（按要素名 + 路段散列，整段一致），少量禁止长时停车
        const h = hashStr((f.n || '') + ':' + Math.round(E.s0 / 50));
        const pk = f.c <= 2 ? 0.75 : f.c === 3 ? 0.55 : 0.3;
        if (h < pk) E.mark |= 2;
        else if (h < pk + 0.12) E.mark |= 4;
      }
    }
    E.gap = 0;
    E.pairF = -1;
    E.swR = cfg.sw > 0 && !E.b;
    E.swL = cfg.sw > 0 && !E.b; // 单行且配对时后面关掉
  }

  // —— 对向车道配对（双幅路） ——
  const CELL = 60;
  const segGrid = new Map();
  const gkey = (cx, cz) => cx * 100003 + cz;
  for (let fi = 0; fi < nF; fi++) {
    const f = feats[fi];
    if (!chain[fi] || !f.o || !info[fi].cfg.major || info[fi].cfg.link) continue;
    const p = f.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      // 长线段按 CELL/2 步长栅格化到经过的所有格子（数据里有 2 km 的直线段）
      const L = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      const nStep = Math.max(1, Math.ceil(L / (CELL * 0.5)));
      let lastK = null;
      for (let k2 = 0; k2 <= nStep; k2++) {
        const t = k2 / nStep;
        const cx = Math.floor((p[i] + (p[i + 2] - p[i]) * t) / CELL), cz = Math.floor((p[i + 1] + (p[i + 3] - p[i + 1]) * t) / CELL);
        const k = gkey(cx, cz);
        if (k === lastK) continue;
        lastK = k;
        let arr = segGrid.get(k);
        if (!arr) segGrid.set(k, (arr = []));
        if (arr[arr.length - 2] === fi && arr[arr.length - 1] === i) continue;
        arr.push(fi, i);
      }
    }
  }
  const probe = (E, t) => {
    // 在边上 t 比例处向左发射射线，找反向的单行主路
    const f = feats[E.fi], p = f.p, ch = chain[E.fi];
    const s = E.s0 + (E.s1 - E.s0) * t;
    let i = E.i0;
    while (i < E.i1 - 1 && ch[i + 1] < s) i++;
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
    const L = Math.hypot(bx - ax, bz - az) || 1;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    const u = (s - ch[i]) / L;
    const ox = ax + (bx - ax) * u, oz = az + (bz - az) * u;
    const lx = dz, lz = -dx; // 左法线 = -右法线（右法线 = (-dz, dx)）
    let best = Infinity, bestF = -1;
    const maxT = E.W / 2 + 68;
    const c0x = Math.floor(Math.min(ox, ox + lx * maxT) / CELL), c1x = Math.floor(Math.max(ox, ox + lx * maxT) / CELL);
    const c0z = Math.floor(Math.min(oz, oz + lz * maxT) / CELL), c1z = Math.floor(Math.max(oz, oz + lz * maxT) / CELL);
    for (let cx = c0x - 1; cx <= c1x + 1; cx++)
      for (let cz = c0z - 1; cz <= c1z + 1; cz++) {
        const arr = segGrid.get(gkey(cx, cz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 2) {
          const fj = arr[k];
          if (fj === E.fi) continue;
          const q = feats[fj].p, j = arr[k + 1];
          const qx = q[j], qz = q[j + 1], rx = q[j + 2] - qx, rz = q[j + 3] - qz;
          const rl = Math.hypot(rx, rz) || 1;
          if ((rx * dx + rz * dz) / rl > -0.85) continue; // 需反向
          // 射线 o + l*t 与线段 q + r*w 求交
          const den = lx * rz - lz * rx;
          if (Math.abs(den) < 1e-6) continue;
          const wx = qx - ox, wz = qz - oz;
          const tt = (wx * rz - wz * rx) / den;
          const w = (wx * lz - wz * lx) / den;
          if (w < -0.02 || w > 1.02 || tt <= E.W * 0.3 || tt > maxT) continue;
          if (tt < best) { best = tt; bestF = fj; }
        }
      }
    return bestF >= 0 ? { t: best, f: bestF } : null;
  };
  for (const E of edges) {
    const cfg = info[E.fi].cfg;
    if (!E.oneway || !cfg.major || cfg.link || E.len < 20) continue;
    const hits = [];
    for (const t of E.len > 60 ? [0.25, 0.5, 0.75] : [0.5]) {
      const h = probe(E, t);
      if (h) hits.push(h);
    }
    if (!hits.length || (E.len > 60 && hits.length < 2)) continue;
    hits.sort((a, b) => a.t - b.t);
    const h = hits[hits.length >> 1];
    const Wo = info[h.f].W;
    E.gap = Math.max(0, h.t - E.W / 2 - Wo / 2);
    E.pairF = h.f;
    E.flags |= F.MEDIAN | F.PAIRED;
    E.swL = false;
  }
  // 与要素 fi 共用任一节点的要素集合（出入口、路口横街；人行道宽度探测时不把它们当成并行的别的路）
  const attachedTo = (fi) => {
    const out = new Set();
    const nodes = featNodes[fi];
    if (!nodes) return out;
    for (const node of nodes) for (let e = head[node]; e >= 0; e = next[e]) out.add(incF[e]);
    return out;
  };
  const net = { edges, feats, info, chain, total, inDetail, attachedTo };
  // 中分带宽沿路变化很大（东大街一条边 1.4 km，两端 0.2 m、中段 3.7 m）：E.gap 只是三点探测的中位数，
  // 这里再沿边每 ~40 m 取局部宽度，记中位数 gapMed（路灯/光斑判定用）；建模与布灯逐断面用 pairGapAt
  for (const E of edges) {
    if (!(E.flags & F.PAIRED)) continue;
    const p = feats[E.fi].p, ch = chain[E.fi];
    const n = Math.max(3, Math.min(40, Math.round(E.len / 40)));
    const gs = [];
    let i = E.i0;
    for (let k = 0; k < n; k++) {
      const s = E.s0 + (E.len * (k + 0.5)) / n;
      while (i < E.i1 - 1 && ch[i + 1] < s) i++;
      const L = ch[i + 1] - ch[i] || 1;
      const dx = (p[i * 2 + 2] - p[i * 2]) / L, dz = (p[i * 2 + 3] - p[i * 2 + 1]) / L;
      const u = s - ch[i];
      const g = pairGapAt(net, E, p[i * 2] + dx * u, p[i * 2 + 1] + dz * u, -dz, dx);
      if (g !== null) gs.push(g);
    }
    gs.sort((a, b) => a - b);
    E.gapMed = gs.length ? gs[gs.length >> 1] : E.gap;
  }
  // —— 出入口（小区/单位/支路接入主路的路段中间节点）：人行道连续，路缘石降坡 ——
  // E.drives = [{s(要素里程), side(+1 右 / -1 左), hw(接入路半宽)}]
  for (const E of edges) {
    const fi = E.fi, cfg = info[fi].cfg;
    if (!cfg.major || cfg.link || !cfg.sw || E.b) continue;
    const nodes = featNodes[fi], ch = chain[fi], p = feats[fi].p;
    for (let i = E.i0 + 1; i < E.i1; i++) {
      const node = nodes[i];
      if (degAll[node] < 3) continue;
      const dx0 = p[i * 2 + 2] - p[i * 2 - 2], dz0 = p[i * 2 + 3] - p[i * 2 - 1];
      const l0 = Math.hypot(dx0, dz0) || 1;
      const rx = -dz0 / l0, rz = dx0 / l0; // 右法线
      for (let e = head[node]; e >= 0; e = next[e]) {
        const fj = incF[e], j = incV[e];
        if (fj === fi) continue;
        const oc = info[fj].cfg;
        if (oc.major || oc.paving || feats[fj]._ped || feats[fj].t || feats[fj].b) continue;
        const nj = feats[fj].p.length / 2;
        for (const sgn of [1, -1]) {
          if (j + sgn < 0 || j + sgn >= nj) continue;
          dirAt(fj, j, sgn, dB);
          const sd = dB[0] * rx + dB[1] * rz;
          if (Math.abs(sd) < 0.35) continue;
          (E.drives || (E.drives = [])).push({ s: ch[i], side: sd > 0 ? 1 : -1, hw: Math.min(4, info[fj].W / 2) / Math.abs(sd) });
        }
      }
    }
  }
  return net;
}

/**
 * 地面车行道索引（不含高速、步道/步行街/园路、桥、隧道）：inside(x, z, skip) 判断点是否落在某条车行道路面内
 * （中心线距离 < 半宽 + 0.25 m），skip 为要忽略的要素集合；命中信息写在 hit（要素、该要素里程）。
 */
export function carriageIndex(net, inRegion, cutAt = null) {
  const { feats, info, chain } = net;
  const CELL = 40, grid = new Map();
  const gk = (a, b) => a * 1000003 + b;
  for (let fi = 0; fi < feats.length; fi++) {
    const f = feats[fi];
    const cfg = info[fi].cfg;
    if (!chain[fi] || cfg.paving || f._ped || f.b || f.t || f.c === 0) continue;
    const p = f.p, hw = info[fi].W / 2 + 0.25;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const x0 = Math.min(p[k], p[k + 2]) - hw, x1 = Math.max(p[k], p[k + 2]) + hw;
      const z0 = Math.min(p[k + 1], p[k + 3]) - hw, z1 = Math.max(p[k + 1], p[k + 3]) + hw;
      if (x1 - x0 > 6000 || z1 - z0 > 6000) continue;
      if (!inRegion(p[k], p[k + 1]) && !inRegion(p[k + 2], p[k + 3])) continue;
      // 不画的路段（步行化裁切区等）不算车行道：旁边的人行道不必为它收窄
      if (cutAt && cutAt((p[k] + p[k + 2]) / 2, (p[k + 1] + p[k + 3]) / 2)) continue;
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
          let a = grid.get(gk(cx, cz));
          if (!a) grid.set(gk(cx, cz), (a = []));
          a.push(fi, k >> 1);
        }
    }
  }
  const hit = { fi: -1, s: 0, d: 0 };
  const inside = (x, z, skip) => {
    const a = grid.get(gk(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!a) return false;
    let best = 1e9;
    for (let i = 0; i < a.length; i += 2) {
      const fi = a[i], k = a[i + 1], p = feats[fi].p;
      if (skip && skip.has(fi)) continue;
      const ax = p[k * 2], az = p[k * 2 + 1], dx = p[k * 2 + 2] - ax, dz = p[k * 2 + 3] - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z) - (info[fi].W / 2 + 0.25);
      if (d < 0 && d < best) {
        best = d;
        hit.fi = fi;
        hit.s = chain[fi][k] + Math.sqrt(l2) * t;
        hit.d = d;
      }
    }
    return best < 0;
  };
  return { inside, hit };
}

/**
 * 步道/步行街与车行道的重叠（roads 模块渲染时剔除，人行道铺装不再画到车行道上）与路段中间的过街点。
 * 沿每条铺装要素每 1.2 m 取样，落在任一地面车行道（中心线距离 < 半宽 + 0.25 m）内的样本连成区间。
 * 返回 { cuts: Map(fi → [[sA, sB], ...]), mids: [{fi(车行道要素), s(该要素里程), dir}] }：
 *   区间短（横穿）且车行道是主次干道时记一处路段人行横道（路口进口 R+14 m 内的不记，路口斑马线已覆盖）。
 */
export function pavingCuts(net, inRegion, ci = null) {
  const { feats, info, chain, edges } = net;
  ci = ci || carriageIndex(net, inRegion);
  const hit = ci.hit, inside = (x, z) => ci.inside(x, z, null);
  const cuts = new Map(), mids = [];
  for (let fi = 0; fi < feats.length; fi++) {
    const f = feats[fi];
    const cfg = info[fi].cfg;
    if (!chain[fi] || !(cfg.paving || f._ped) || f.b || f.t) continue;
    const p = f.p, ch = chain[fi];
    if (!inRegion(p[0], p[1]) && !inRegion(p[p.length - 2], p[p.length - 1])) continue;
    const tot = ch[ch.length - 1];
    const STEP = 1.2;
    const n = Math.max(2, Math.ceil(tot / STEP));
    let runA = -1, runHits = [];
    const list = [];
    const close = (sEnd) => {
      list.push([Math.max(0, runA - STEP * 0.6), Math.min(tot, sEnd + STEP * 0.6), runHits]);
      runA = -1;
      runHits = [];
    };
    let seg = 0;
    for (let q = 0; q <= n; q++) {
      const s = (q / n) * tot;
      while (seg < ch.length - 2 && ch[seg + 1] < s) seg++;
      const L = ch[seg + 1] - ch[seg] || 1, t = (s - ch[seg]) / L;
      const x = p[seg * 2] + (p[seg * 2 + 2] - p[seg * 2]) * t, z = p[seg * 2 + 1] + (p[seg * 2 + 3] - p[seg * 2 + 1]) * t;
      if (inside(x, z)) {
        if (runA < 0) runA = s;
        runHits.push(hit.fi, hit.s);
      } else if (runA >= 0) close(s - tot / n);
    }
    if (runA >= 0) close(tot);
    if (!list.length) continue;
    cuts.set(fi, list.map((r) => [r[0], r[1]]));
    // 横穿主次干道的短区间 → 路段人行横道（取区间中点处命中的车行道）
    for (const [a, b, hits] of list) {
      if (b - a > 45 || hits.length < 2) continue;
      const m = (hits.length >> 2) * 2;
      const mf = hits[m], ms = hits[m + 1];
      const mc = info[mf].cfg;
      if (!mc.major || mc.link || feats[mf].c < 1 || feats[mf].c > 4) continue;
      mids.push({ fi: mf, s: ms });
    }
  }
  // 去重（同一车行道 10 m 内）并挂到边上；路口进口附近（R+14 m 内）的交给路口斑马线
  mids.sort((a, b) => a.fi - b.fi || a.s - b.s);
  const byF = new Map();
  for (const E of edges) {
    let a = byF.get(E.fi);
    if (!a) byF.set(E.fi, (a = []));
    a.push(E);
  }
  let last = null, nMid = 0;
  for (const m of mids) {
    if (last && last.fi === m.fi && m.s - last.s < 10) continue;
    last = m;
    const E = (byF.get(m.fi) || []).find((e) => m.s >= e.s0 && m.s <= e.s1);
    if (!E || E.b) continue;
    const d0 = m.s - E.s0, d1 = E.s1 - m.s;
    if ((E.R0 > 0 || E.flags & F.CW0) && d0 < E.R0 + 14) continue;
    if ((E.R1 > 0 || E.flags & F.CW1) && d1 < E.R1 + 14) continue;
    if (d0 < 6 || d1 < 6) continue;
    (E.mids || (E.mids = [])).push(m.s);
    nMid++;
  }
  return { cuts, nMid };
}

/**
 * 双幅路局部中分带宽（米）：从路中心点 (x,z) 沿左法线（右法线 (rx,rz) 取反）射向配对要素折线，
 * 交点距离减去两幅半宽。没有交点（配对要素在此处已结束等）返回 null。
 */
export function pairGapAt(net, E, x, z, rx, rz) {
  if (E.pairF < 0) return null;
  const q = net.feats[E.pairF].p;
  const rl = Math.hypot(rx, rz) || 1;
  const lx = -rx / rl, lz = -rz / rl;
  const maxT = E.W / 2 + 75;
  let best = Infinity;
  for (let j = 0; j + 3 < q.length; j += 2) {
    const qx = q[j], qz = q[j + 1], sx = q[j + 2] - qx, sz = q[j + 3] - qz;
    const den = lx * sz - lz * sx;
    if (Math.abs(den) < 1e-6) continue;
    const wx = qx - x, wz = qz - z;
    const t = (wx * sz - wz * sx) / den;
    const w = (wx * lz - wz * lx) / den;
    if (w < -0.02 || w > 1.02 || t <= E.W * 0.3 || t > maxT) continue;
    if (t < best) best = t;
  }
  if (best === Infinity) return null;
  return best - E.W / 2 - net.info[E.pairF].W / 2;
}

/**
 * 路灯灯型：按道路名。唐风宫灯只用于曲江片区的地面次干道、支路与步行街；高架/桥梁、快速路、主干道、匝道
 * 一律普通 LED 灯（审查 P2：曲江路高架与立交各层桥面上立着古铜宫灯杆）。
 */
export function lampStyleFor(f) {
  const n = f.n || '';
  if (KNOT_NAMES.test(n)) return LAMP.KNOT;
  if (LANTERN_NAMES.test(n)) return LAMP.LANTERN;
  if (PALACE_NAMES.test(n) && !f.b && !(f.y > 0) && f.c >= 3 && f.c <= 7) return LAMP.PALACE;
  return LAMP.SINGLE;
}

/**
 * 布置路灯（记录，不建几何）。返回 {x,y,z,yaw,type,n}（类型化数组）
 * yaw：灯臂指向（弧度，atan2(dx,dz) 约定：局部 +Z 指向路面）
 */
/**
 * 该路段是否布灯（与着色器光斑一致的判定，roads.js lampBits 共用）：乡道/田间路（三级路、支路、小区路）
 * 不在建成区就不布灯；urban 为 (x, z) => 是否建成区（null = 处处建成区）。
 */
export function lampUrbanOk(f, urban, x, z) {
  if (!urban || f.c <= 3 || (f.c >= 8 && f.c <= 11)) return true;
  return urban(x, z);
}

export function placeLamps(net, terrain, roadY, { region, LIFT, edgeFilter = null, minorOk = null, urban = null }) {
  const { edges, feats, info, chain, total } = net;
  const out = { x: [], y: [], z: [], yaw: [], type: [], lvl: [] };
  let curLvl = 3;
  const push = (x, y, z, yaw, type) => {
    out.x.push(x); out.y.push(y); out.z.push(z); out.yaw.push(yaw); out.type.push(type); out.lvl.push(curLvl);
  };
  for (const E of edges) {
    const f = feats[E.fi];
    const cfg = info[E.fi].cfg;
    if (!cfg.lamp || f.t || f._ped) continue;
    if (edgeFilter && !edgeFilter(E)) continue;
    curLvl = f.c <= 2 || cfg.link ? 3 : f.c === 3 ? 2 : 1;
    const p = f.p, ch = chain[E.fi];
    // 高速公路只在城区布灯
    const style = lampStyleFor(f);
    const S = style === LAMP.PALACE ? 26 : style === LAMP.KNOT ? 30 : cfg.lamp;
    const vA = E.R0 + (E.flags & F.CW0 ? 9 : 4), vB = E.len - E.R1 - (E.flags & F.CW1 ? 9 : 4);
    if (vB - vA < 6) continue;
    const n0 = Math.max(0, Math.ceil((E.s0 + vA) / S - 0.5));
    let i = E.i0;
    for (let k = n0; ; k++) {
      const s = (k + 0.5) * S; // 全要素统一相位
      if (s > E.s0 + vB) break;
      if (s < E.s0 + vA) continue;
      while (i < E.i1 - 1 && ch[i + 1] < s) i++;
      const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2], bz = p[i * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      const dx = (bx - ax) / L, dz = (bz - az) / L;
      const u = (s - ch[i]) / L;
      const cx = ax + (bx - ax) * u, cz = az + (bz - az) * u;
      if (!region(cx, cz)) continue;
      if (f.c === 0 && !region(cx, cz, true)) continue;
      if (!lampUrbanOk(f, urban, cx, cz)) continue;
      // 中国结隔杆挂：偶数号灯杆挂结，奇数号同款不挂（原每根都挂，夜里一串红点像警示灯）
      const knotT = k % 2 === 0 ? LAMP.KNOT : LAMP.KNOT2;
      const rx = -dz, rz = dx; // 右法线
      const hw = E.W / 2;
      const onBridge = !!E.b;
      // 路面高取纵断面（地面路在引桥路堤段也被抬高）；地面路灯杆立在“路面高与所在点地面”较高者上
      const deckY = roadY(terrain, f, cx, cz, s, total[E.fi]);
      if (deckY === null) continue;
      const gY = (x, z) => Math.max(deckY, terrain.heightAt(x, z) + LIFT);
      const baseY = (x, z) => (onBridge ? deckY + 0.95 : gY(x, z) + 0.15);
      const off = onBridge ? 0.3 : 0.9;
      const yawR = Math.atan2(-rx, -rz); // 右侧灯：灯臂指向 -右法线（路中）
      const yawL = Math.atan2(rx, rz);
      const sideType = style === LAMP.PALACE ? LAMP.PALACE : style === LAMP.KNOT ? knotT : style === LAMP.LANTERN ? LAMP.LANTERN : LAMP.SINGLE;
      // 中分带灯按灯位处的局部中分带宽布置（立在中分带正中；宽度沿路变化，整边一个 gap 会把灯杆插进车道）
      const gLoc = (E.flags & F.PAIRED) && E.pairF > E.fi ? pairGapAt(net, E, cx, cz, rx, rz) ?? -1 : -1;
      if (f.c === 0) {
        // 高速/快速路：中央分隔带双臂灯（配对时只由一侧布置）
        if (E.flags & F.PAIRED) {
          if (E.pairF > E.fi && gLoc > 0.5 && gLoc < 30) {
            const m = hw + gLoc / 2;
            const x = cx - rx * m, z = cz - rz * m;
            push(x, onBridge ? deckY + 0.9 : gY(x, z) + 0.2, z, yawL, LAMP.DOUBLE);
          } else if (onBridge && E.pairF > E.fi) {
            const x = cx - rx * (hw + off), z = cz - rz * (hw + off);
            push(x, baseY(x, z), z, yawL, LAMP.SINGLE);
          }
        } else {
          const x = cx + rx * (hw + off), z = cz + rz * (hw + off);
          push(x, baseY(x, z), z, yawR, LAMP.SINGLE);
        }
        continue;
      }
      // 右侧（外侧人行道）
      {
        const x = cx + rx * (hw + off), z = cz + rz * (hw + off);
        // 支路单侧灯：落在片区自建房屋/地标里（OSM 中心线偏差）就不立
        if (cfg.lampOne) {
          if (!minorOk || minorOk(x, z)) push(x, baseY(x, z), z, yawR, sideType);
          continue;
        }
        push(x, baseY(x, z), z, yawR, sideType);
      }
      if (E.flags & F.PAIRED) {
        // 双幅路：中央分隔带双臂灯，由编号小的一幅负责
        if (E.pairF > E.fi && gLoc > 1.2 && gLoc < 40 && !onBridge) {
          const m = hw + gLoc / 2;
          const x = cx - rx * m, z = cz - rz * m;
          push(x, gY(x, z) + 0.2, z, yawL, style === LAMP.PALACE ? LAMP.PALACE : style === LAMP.KNOT ? knotT : LAMP.DOUBLE);
        }
      } else {
        const x = cx - rx * (hw + off), z = cz - rz * (hw + off);
        push(x, baseY(x, z), z, yawL, sideType);
        // 宽的双向路：中间再加一排双臂灯
        if (!E.oneway && E.W >= 24 && !onBridge) {
          push(cx, gY(cx, cz) + 0.2, cz, yawL, LAMP.DOUBLE);
        }
      }
    }
  }
  return {
    n: out.x.length,
    x: Float32Array.from(out.x),
    y: Float32Array.from(out.y),
    z: Float32Array.from(out.z),
    yaw: Float32Array.from(out.yaw),
    type: Uint8Array.from(out.type),
    lvl: Uint8Array.from(out.lvl),
  };
}

// ================= 铁路 =================
export const RAIL_UNIT = 8.5; // 铁路/地铁高架默认梁底以上轨面抬升（米/层）
const RAIL_RAMP = 320; // 引桥/路堤过渡长度

/**
 * 铁路去重（rail.json 每条线重复两次）、剔除地下段，并把度为 2 的节点串成链，
 * 按链计算高架抬升（桥段满高，桥两端外侧沿路堤过渡，避免逐段“下沉”）。
 * 返回 [{f, p, ch(累计里程), lift(Float32Array 每顶点抬升), cls, hsr, total}]
 */
export function buildRailNet(rail) {
  const feats = rail?.features || [];
  const classes = rail?.classes || ['rail', 'subway', 'light_rail'];
  const seen = new Set();
  const list = [];
  for (const f of feats) {
    if (!f.p || f.p.length < 4 || f.t) continue;
    const cls = classes[f.c] || 'rail';
    if (cls !== 'rail' && (f.y || 0) < 0) continue; // 地铁地下段
    if (cls === 'rail' && (f.y || 0) < 0 && !f.b) continue;
    const k = f.p.length + ':' + f.p[0] + ',' + f.p[1] + ':' + f.p[f.p.length - 2] + ',' + f.p[f.p.length - 1];
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ f, p: f.p, cls, hsr: /高速|客专|城际|动走|疏解/.test(f.n || ''), b: f.b ? 1 : 0 });
  }
  // 端点连接
  const endMap = new Map();
  const key = (x, z) => nodeKey(x, z);
  list.forEach((r, i) => {
    const p = r.p, n = p.length;
    for (const [end, x, z] of [[0, p[0], p[1]], [1, p[n - 2], p[n - 1]]]) {
      const k = key(x, z);
      if (!endMap.has(k)) endMap.set(k, []);
      endMap.get(k).push(i * 2 + end);
    }
  });
  // 串链：只在恰好两条同类线相接处连接
  const used = new Uint8Array(list.length);
  const chains = [];
  const other = (k, self) => {
    const arr = endMap.get(k);
    if (!arr || arr.length !== 2) return -1;
    const o = arr[0] === self ? arr[1] : arr[0];
    return o;
  };
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    // 向起点方向回溯到链头
    let cur = i, curEnd = 0, guard = 0;
    for (;;) {
      const r = list[cur], p = r.p, n = p.length;
      const k = curEnd === 0 ? key(p[0], p[1]) : key(p[n - 2], p[n - 1]);
      const o = other(k, cur * 2 + curEnd);
      if (o < 0) break;
      const oi = o >> 1;
      if (oi === i || used[oi] || list[oi].cls !== r.cls || guard++ > 5000) break;
      cur = oi;
      curEnd = (o & 1) ^ 1; // 从另一端继续
      if (cur === i) break;
    }
    // 现在 cur 的 curEnd 是链头的外端；正向遍历
    const seq = [];
    let reverse = curEnd === 1; // 若外端是终点，则该要素反向
    let c = cur;
    guard = 0;
    while (c >= 0 && !used[c] && guard++ < 5000) {
      used[c] = 1;
      seq.push({ i: c, rev: reverse });
      const p = list[c].p, n = p.length;
      const k = reverse ? key(p[0], p[1]) : key(p[n - 2], p[n - 1]);
      const o = other(k, c * 2 + (reverse ? 0 : 1));
      if (o < 0) break;
      const oi = o >> 1;
      if (used[oi] || list[oi].cls !== list[c].cls) break;
      reverse = (o & 1) === 1;
      c = oi;
    }
    chains.push(seq);
  }
  // 链上计算抬升
  const out = [];
  for (const seq of chains) {
    // 链的桥区间
    let acc = 0;
    const segs = [];
    for (const { i, rev } of seq) {
      const r = list[i];
      const ch = chainage(r.p);
      const L = ch[ch.length - 1];
      segs.push({ r, rev, ch, a: acc, L });
      acc += L;
    }
    const intervals = [];
    for (const s of segs) {
      if (!s.r.b) continue;
      const lv = RAIL_UNIT * Math.max(1, s.r.f.y || 1) + (s.r.hsr ? 1.5 : 0);
      const last = intervals[intervals.length - 1];
      if (last && s.a - last.b < 1) { last.b = s.a + s.L; last.h = Math.max(last.h, lv); }
      else intervals.push({ a: s.a, b: s.a + s.L, h: lv });
    }
    const liftAt = (S) => {
      let h = 0;
      for (const it of intervals) {
        let k;
        if (S >= it.a && S <= it.b) k = 1;
        else {
          const d = S < it.a ? it.a - S : S - it.b;
          const ramp = Math.min(RAIL_RAMP, Math.max(80, (it.b - it.a) * 0.8));
          k = d >= ramp ? 0 : 1 - d / ramp;
          k = k * k * (3 - 2 * k);
        }
        h = Math.max(h, it.h * k);
      }
      return h;
    };
    for (const s of segs) {
      const n = s.r.p.length / 2;
      const lift = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        const S = s.rev ? s.a + (s.L - s.ch[j]) : s.a + s.ch[j];
        lift[j] = intervals.length ? liftAt(S) : 0;
      }
      out.push({ f: s.r.f, p: s.r.p, ch: s.ch, lift, cls: s.r.cls, hsr: s.r.hsr, b: s.r.b, total: s.L, chainA: s.a, rev: s.rev, liftAt: intervals.length ? liftAt : null });
    }
  }
  return out;
}
