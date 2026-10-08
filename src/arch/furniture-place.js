// 全城街道设施的布置规则（streetfurniture 模块）：只算位置，产出每个分块（CHUNK m 见方）的实例数据。
//
// 道路与人行道：与 roads 模块同一套路网分析（roads_net.buildRoadNet：拆边、路口半径 R、人行道起止 sw0/sw1、
//   左右人行道有无 swR/swL、人行横道标志 CW0/CW1），人行道宽 CFG.sw、面高 = 纵断面路面高 roadY + 0.15。
// 人行道横向分区（u = 距路缘石外沿的米数）：
//   0.2~0.75 路缘设施带：垃圾桶、消火栓、标志杆、人行灯杆、路名牌杆、阻车石球；路灯在 u = 0.9（按 roads 的统一灯位相位避让 ±1.1 m）；
//   1.1~1.4 盲道（不放东西）；1.3~2.7 行道树/绿篱带（vegetation 模块：距路缘 1.8~2.0 m ± 0.25，宽主干道树池间连续绿篱）——不放东西；
//   ≥ 2.85 到人行道外沿：共享单车/电动车、配电箱、报刊亭、候车亭（后半可伸到人行道外的空地上）。
// 避让：精建片区（streetscape DISTRICTS 的 bbox）、排除区（buildings / roads 标志）、通用建筑轮廓、所有车行道（含支路）、
//   地铁出入口雨棚（signage）、signage 的“示意”候车亭候选位、同块内已放物件。
// 路口：主干/次干道路口（≥3 个进口、横向道路为次干道及以上）放悬臂信号灯（远端右侧立杆、臂跨出口车道、灯面朝来车）、
//   人行横道两端人行灯（与平行的机动车相位同步）、阻车石球/桩；东西/南北两相位（按主路轴线分组）。
//   每个路口 1~2 根路名牌杆（各挂两块，分别平行于两条路）；非信号路口的人行横道前立“人行横道”标志。
// 公交站：OSM 站点（furniture-data.js）吸附到最近有人行道的道路外侧，按站名去重；主次干道建候车亭，其余只立站牌。
import { buildRoadNet, markParkWalkways, CFG, F, lampStyleFor, LAMP } from './roads_net.js';
import { roadY } from '../core/roadheight.js';
import { DISTRICTS } from './streetscape-data.js';
import { parseBuildings, BuildingIndex } from './signageIndex.js';
import { hash01 as sgHash } from './signageStyle.js';
import { BUS, BUS_NAMES, BUS_ROUTES, PY } from './furniture-data.js';
import { roadPinyin, paintRoadSign, paintBusSign } from './furniture-geo.js';

export const CHUNK = 450;
const ckey = (i, j) => i * 100003 + j;
const yawOf = (dx, dz) => Math.atan2(-dz, dx);
/** 整数散列 → [0,1) */
function h01(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const PY_MAP = new Map();
for (const m of PY.matchAll(/([一-鿿])([a-z]+)/g)) PY_MAP.set(m[1], m[2]);

// 共享单车品牌色（美团黄、哈啰蓝、青桔绿）与电动车车壳色
const BRAND = [[0.98, 0.78, 0.05], [0.05, 0.42, 0.92], [0.42, 0.74, 0.22]];
const BRAND_W = [0.4, 0.35, 0.25];
const EBIKE = [[0.92, 0.92, 0.9], [0.08, 0.08, 0.09], [0.75, 0.1, 0.1], [0.15, 0.35, 0.7], [0.85, 0.55, 0.65], [0.55, 0.57, 0.6], [0.95, 0.95, 0.95]];
const POST_GREY = [0.36, 0.38, 0.4], POST_LIGHT = [0.62, 0.64, 0.66];
const CAB = [[0.4, 0.47, 0.43], [0.6, 0.6, 0.58], [0.34, 0.42, 0.38]];
/** 路口进口 e 的人行道起点（距路口节点的里程，与 roads 模块画人行道的起止一致） */
const swStart = (e) => (e.sg > 0 ? e.E.sw0 : e.E.sw1) + 0.5;

/** 人行道上的一个位置帧：中心线点 (cx,cz)、切向 (tx,tz)、外法线 (nx,nz)（σ 侧，远离车行道） */
class Frame {
  constructor() { this.cx = 0; this.cz = 0; this.tx = 1; this.tz = 0; this.nx = 0; this.nz = 1; this.y = 0; this.hw = 0; }
  at(u) { return [this.cx + this.nx * (this.hw + u), this.cz + this.nz * (this.hw + u)]; }
}

export class Planner {
  constructor(ctx) {
    const T0 = performance.now();
    this.ctx = ctx;
    this.why = {}; // 放置被拒原因计数（诊断：1 片区 2 排除区 3 车行道 4 建筑 5 地铁口 6 示意候车亭 7 已占）
    this.terrain = ctx.terrain;
    const roads = ctx.data.roads;
    this.roads = roads;
    const pa = ctx.geo.project(108.84, 34.35), pb = ctx.geo.project(109.06, 34.17);
    this.core = { x0: pa.x, z0: pa.z, x1: pb.x, z1: pb.z };
    const inCore = (x, z) => x > pa.x && x < pb.x && z > pa.z && z < pb.z;
    this.inCore = inCore;
    markParkWalkways(roads, ctx.data.landuse);
    const net = buildRoadNet(roads, { inDetail: inCore });
    this.net = net;
    const { edges, feats, info, chain } = net;
    this.lampS = new Float32Array(feats.length);
    for (let fi = 0; fi < feats.length; fi++) {
      const cfg = info[fi]?.cfg;
      if (!cfg || !cfg.lamp) continue;
      const st = lampStyleFor(feats[fi]);
      this.lampS[fi] = st === LAMP.PALACE ? 26 : st === LAMP.KNOT ? 30 : cfg.lamp;
    }
    // —— 有人行道的边（与 roads 模块画人行道的条件一致：核心区、非桥、主次干道、非匝道） ——
    this.sw = [];
    const edgeCh = new Map();
    for (let ei = 0; ei < edges.length; ei++) {
      const E = edges[ei];
      const f = feats[E.fi], cfg = info[E.fi].cfg;
      if (!(cfg.sw > 0) || cfg.link || f.b || f.t || f.c < 1 || f.c > 4) continue;
      if (!E.swR && !E.swL) continue;
      const ch = chain[E.fi];
      const [mx, mz] = this.pointAt(f, ch, (E.s0 + E.s1) / 2);
      if (!inCore(mx, mz)) continue;
      const k = this.sw.length;
      this.sw.push(E);
      const seen = new Set();
      for (let s = E.s0; ; s += 20) {
        const ss = Math.min(s, E.s1);
        const [x, z] = this.pointAt(f, ch, ss);
        for (const ox of [-40, 40]) for (const oz of [-40, 40]) {
          const key = ckey(Math.floor((x + ox) / CHUNK), Math.floor((z + oz) / CHUNK));
          if (seen.has(key)) continue;
          seen.add(key);
          let l = edgeCh.get(key);
          if (!l) edgeCh.set(key, (l = []));
          l.push(k);
        }
        if (ss >= E.s1) break;
      }
    }
    this.edgeCh = edgeCh;
    // —— 车行道线段网格（物件不得伸进任何车行道；桥面/隧道/人行步道除外） ——
    const RG = 40;
    this.RG = RG;
    const rseg = [];
    const rgrid = new Map();
    for (let fi = 0; fi < feats.length; fi++) {
      const f = feats[fi];
      if (!f.p || f.p.length < 4 || f.b || f.t || f.c === 13) continue;
      if (Math.abs(f.p[0]) > 16000 || Math.abs(f.p[1]) > 16000) continue;
      const hw = (info[fi]?.W || 6) / 2;
      const p = f.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const id = rseg.length / 6;
        rseg.push(p[i], p[i + 1], p[i + 2], p[i + 3], hw, fi);
        const x0 = Math.floor((Math.min(p[i], p[i + 2]) - hw - 2) / RG), x1 = Math.floor((Math.max(p[i], p[i + 2]) + hw + 2) / RG);
        const z0 = Math.floor((Math.min(p[i + 1], p[i + 3]) - hw - 2) / RG), z1 = Math.floor((Math.max(p[i + 1], p[i + 3]) + hw + 2) / RG);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > 2500) continue;
        for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) {
          const key = ckey(a, b);
          let l = rgrid.get(key);
          if (!l) rgrid.set(key, (l = []));
          l.push(id);
        }
      }
    }
    this.rseg = Float32Array.from(rseg);
    this.rgrid = rgrid;
    // —— 建筑轮廓索引（与招牌模块同一实现；usable 与通用建筑的让位结果一致） ——
    this.bi = new BuildingIndex(parseBuildings(ctx.data.buildings), ctx.exclusions);
    // —— 精建片区（streetscape）范围：不重复放 ——
    this.districts = DISTRICTS.map((D) => D.bbox);
    // —— 地铁出入口（signage 在此生成雨棚）与餐饮 POI ——
    this.subway = new Map();
    this.shops = new Map();
    for (const p of ctx.data.pois?.pois || []) {
      if (!inCore(p.x, p.z)) continue;
      const tgt = p.k === 'subway_entrance' ? this.subway : /^(restaurant|fast_food|cafe|shop|marketplace|food_court)$/.test(p.k) ? this.shops : null;
      if (!tgt) continue;
      const key = ckey(Math.floor(p.x / CHUNK), Math.floor(p.z / CHUNK));
      let l = tgt.get(key);
      if (!l) tgt.set(key, (l = []));
      l.push(p);
    }
    // —— signage 模块的“示意”候车亭候选位（同一算法复算，避免两处候车亭叠在一起） ——
    this.sgBus = new Map();
    this.signageBusCandidates();
    // —— 路口 ——
    this.junctions = new Map();
    const nJ = this.buildJunctions();
    // —— 公交站 ——
    this.stops = new Map();
    const nB = this.snapBusStops();
    this.stats = { edges: this.sw.length, junctions: nJ, busStops: nB, ms: Math.round(performance.now() - T0) };
  }

  // ───────────────────────── 几何工具 ─────────────────────────
  /** 折线 f.p 在里程 s 处的点与单位切向 */
  pointAt(f, ch, s) {
    const p = f.p, n = ch.length;
    if (s <= 0) s = 0;
    if (s >= ch[n - 1]) s = ch[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ch[m] <= s) lo = m; else hi = m; }
    const L = ch[lo + 1] - ch[lo] || 1;
    const t = Math.min(1, Math.max(0, (s - ch[lo]) / L));
    const dx = p[lo * 2 + 2] - p[lo * 2], dz = p[lo * 2 + 3] - p[lo * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    return [p[lo * 2] + dx * t, p[lo * 2 + 1] + dz * t, dx / l, dz / l];
  }
  /** 填写帧：边 E（要素 fi）的 σ 侧、里程 s；返回 false = 无路面高（隧道等） */
  frame(Fm, fi, s, sigma) {
    const { feats, chain, total, info } = this.net;
    const f = feats[fi];
    const [cx, cz, tx, tz] = this.pointAt(f, chain[fi], s);
    Fm.cx = cx; Fm.cz = cz; Fm.tx = tx; Fm.tz = tz;
    Fm.nx = -tz * sigma; Fm.nz = tx * sigma;
    Fm.hw = info[fi].W / 2;
    const y = roadY(this.terrain, f, cx, cz, Math.min(Math.max(s, 0), total[fi]), total[fi]);
    if (y === null) return false;
    Fm.y = y + 0.15;
    return true;
  }
  /** 距最近路灯灯位（roads 的统一相位 (k+0.5)·S）的里程差 */
  lampGap(fi, s) {
    const S = this.lampS[fi];
    if (!S) return 99;
    let fr = (s / S - 0.5) % 1;
    if (fr < 0) fr += 1;
    return Math.min(fr, 1 - fr) * S;
  }
  inDistrict(x, z, m = 25) {
    for (const b of this.districts) if (x > b[0] - m && x < b[2] + m && z > b[1] - m && z < b[3] + m) return true;
    return false;
  }
  roadHit(x, z, r) {
    const RG = this.RG, S = this.rseg;
    const l = this.rgrid.get(ckey(Math.floor(x / RG), Math.floor(z / RG)));
    if (!l) return false;
    for (const id of l) {
      const o = id * 6;
      const ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az;
      const L2 = dx * dx + dz * dz || 1e-6;
      let t = ((x - ax) * dx + (z - az) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t - x, qz = az + dz * t - z;
      const lim = S[o + 4] + r;
      if (qx * qx + qz * qz < lim * lim) return true;
    }
    return false;
  }
  /**
   * 路口进口 e 的“横穿道路净空”：沿本路中心线从路口节点向外 0~40 m，最后一处仍压在横向道路（非同名、不平行）车行道 + 1 m 内的距离。
   * OSM 双幅路口常常只有一幅进了路口簇，R 只量到近侧一幅；灯杆/路名牌要立在整个路口之外。
   */
  clearAlong(e) {
    if (e.clear !== undefined) return e.clear;
    const { feats, chain } = this.net;
    const RG = this.RG, S = this.rseg;
    const name = e.f.n || '';
    let last = 0;
    for (let a = 0; a <= 40; a += 1) {
      const [x, z, tx, tz] = this.pointAt(e.f, chain[e.fi], e.s + e.sg * a);
      const l = this.rgrid.get(ckey(Math.floor(x / RG), Math.floor(z / RG)));
      if (!l) continue;
      for (const id of l) {
        const o = id * 6;
        const fj = S[o + 5];
        if (fj === e.fi || (name && feats[fj].n === name)) continue;
        const ax = S[o], az = S[o + 1], dx = S[o + 2] - ax, dz = S[o + 3] - az;
        const L = Math.hypot(dx, dz) || 1e-6;
        if (Math.abs((dx * tx + dz * tz) / L) > 0.75) continue; // 平行的路（辅路、对向一幅）不算横穿
        let t = ((x - ax) * dx + (z - az) * dz) / (L * L);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(ax + dx * t - x, az + dz * t - z) < S[o + 4] + 1) { last = a; break; }
      }
    }
    e.clear = last;
    return last;
  }
  bldHit(x, z, r) {
    let hit = false;
    const bi = this.bi;
    bi.candidates(x, z, r, (b) => { if (!hit && bi.distTo(b, x, z) < r) hit = true; });
    return hit;
  }
  near(map, x, z, r) {
    const i = Math.floor(x / CHUNK), j = Math.floor(z / CHUNK);
    for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) {
      const l = map.get(ckey(a, b));
      if (!l) continue;
      for (const p of l) if (Math.hypot(p.x - x, p.z - z) < r) return true;
    }
    return false;
  }
  /** 0 = 可放；否则返回原因码。r：占地半径（建筑/已放物件），rr：朝车行道一侧的半径（默认同 r） */
  blocked(x, z, r, opt) {
    const w = this._blocked(x, z, r, opt);
    this.why[w] = (this.why[w] || 0) + 1;
    return w;
  }
  _blocked(x, z, r, { road = true, occ = null, sg = true, rr = r } = {}) {
    if (this.inDistrict(x, z)) return 1;
    const ex = this.ctx.exclusions;
    if (ex && ex.items && ex.items.length && (ex.test(x, z, 'buildings') || ex.test(x, z, 'roads'))) return 2;
    if (road && this.roadHit(x, z, rr + 0.03)) return 3;
    if (this.bldHit(x, z, r + 0.05)) return 4;
    if (this.near(this.subway, x, z, r + 5.5)) return 5;
    if (sg && this.near(this.sgBus, x, z, r + 5.2)) return 6;
    if (occ) for (let i = 0; i < occ.length; i += 3) {
      const d = r + occ[i + 2];
      const dx = occ[i] - x, dz = occ[i + 1] - z;
      if (dx * dx + dz * dz < d * d) return 7;
    }
    return 0;
  }

  // ───────────────────────── signage 候车亭候选 ─────────────────────────
  signageBusCandidates() {
    const feats = this.roads.features, cls = this.roads.classes || [];
    const ok = new Set(['trunk', 'primary', 'secondary'].map((n) => cls.indexOf(n)));
    for (let fi = 0; fi < feats.length; fi++) {
      const f = feats[fi];
      if (!ok.has(f.c) || f.b || f.t || !f.n || !f.p || f.p.length < 4) continue;
      const p = f.p;
      if (Math.abs(p[0]) > 15000 || Math.abs(p[1]) > 15000) continue;
      let next = 120 + sgHash(fi * 31 + 7) * 300, s = 0;
      const w = f.w || 12;
      for (let i = 2; i < p.length; i += 2) {
        const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az, L = Math.hypot(dx, dz);
        if (L < 1e-3) continue;
        while (next <= s + L) {
          const t = (next - s) / L;
          const x = ax + dx * t, z = az + dz * t;
          for (const side of f.o ? [1] : [1, -1]) {
            const off = side > 0 ? 0 : 45;
            const xx = x - (dx / L) * off, zz = z - (dz / L) * off;
            const cdx = (dx / L) * side, cdz = (dz / L) * side;
            const o = w / 2 + 2.5;
            const px = xx - cdz * o, pz = zz + cdx * o;
            const key = ckey(Math.floor(px / CHUNK), Math.floor(pz / CHUNK));
            let l = this.sgBus.get(key);
            if (!l) this.sgBus.set(key, (l = []));
            l.push({ x: px, z: pz });
          }
          next += 520;
        }
        s += L;
      }
    }
  }

  // ───────────────────────── 路口 ─────────────────────────
  buildJunctions() {
    const { edges, feats, info, chain } = this.net;
    const ends = new Map();
    for (const E of edges) {
      const f = feats[E.fi], cfg = info[E.fi].cfg;
      if (!cfg.major || cfg.link || f.c === 0 || f.b || f.t) continue;
      const ch = chain[E.fi];
      for (const atStart of [true, false]) {
        const s = atStart ? E.s0 : E.s1;
        const sg = atStart ? 1 : -1;
        const [x, z] = this.pointAt(f, ch, s);
        if (!this.inCore(x, z)) continue;
        const [x2, z2] = this.pointAt(f, ch, s + sg * Math.min(10, E.len * 0.5));
        const l = Math.hypot(x2 - x, z2 - z) || 1;
        const node = atStart ? E.n0 : E.n1;
        let a = ends.get(node);
        if (!a) ends.set(node, (a = []));
        a.push({
          x, z, dx: (x2 - x) / l, dz: (z2 - z) / l, hw: E.W / 2, R: atStart ? E.R0 : E.R1, fi: E.fi, f, s, sg, E,
          cw: !!(E.flags & (atStart ? F.CW0 : F.CW1)), swOut: sg > 0 ? E.swR : E.swL, swIn: sg > 0 ? E.swL : E.swR, oneway: !!f.o,
        });
      }
    }
    const jn = [];
    for (const [node, a] of ends) if (a.length >= 3) jn.push(node);
    const par = new Map(jn.map((n) => [n, n]));
    const find = (a) => { while (par.get(a) !== a) { par.set(a, par.get(par.get(a))); a = par.get(a); } return a; };
    const JC = 35, jg = new Map();
    for (const n of jn) {
      const e0 = ends.get(n)[0];
      const k = ckey(Math.floor(e0.x / JC), Math.floor(e0.z / JC));
      let l = jg.get(k);
      if (!l) jg.set(k, (l = []));
      l.push(n);
    }
    for (const n of jn) {
      const e0 = ends.get(n)[0];
      const cx = Math.floor(e0.x / JC), cz = Math.floor(e0.z / JC);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const l = jg.get(ckey(cx + i, cz + j));
        if (!l) continue;
        for (const m of l) {
          if (m === n) continue;
          const e1 = ends.get(m)[0];
          if (Math.hypot(e1.x - e0.x, e1.z - e0.z) < JC) { const ra = find(n), rb = find(m); if (ra !== rb) par.set(ra, rb); }
        }
      }
    }
    const groups = new Map();
    for (const n of jn) {
      const r = find(n);
      let g = groups.get(r);
      if (!g) groups.set(r, (g = { nodes: [], ends: [] }));
      g.nodes.push(n);
      g.ends.push(...ends.get(n));
    }
    let count = 0;
    for (const g of groups.values()) {
      let cx = 0, cz = 0;
      for (const n of g.nodes) { const e = ends.get(n)[0]; cx += e.x; cz += e.z; }
      cx /= g.nodes.length; cz /= g.nodes.length;
      let spread = 0;
      for (const e of g.ends) spread = Math.max(spread, Math.hypot(e.x - cx, e.z - cz));
      if (spread > 45) continue; // 立交/环岛/大广场：不按平面路口处理
      // 进口分组（方向相近的为同一条路的一个方向，双幅路两幅合为一组）
      const es = g.ends.map((e) => ({ e, a: Math.atan2(e.dz, e.dx) })).sort((p, q) => p.a - q.a);
      const legs = [];
      for (const it of es) {
        const L = legs[legs.length - 1];
        if (L && Math.abs(it.a - L.a0) < 0.5) L.ends.push(it.e);
        else legs.push({ a0: it.a, ends: [it.e] });
      }
      if (legs.length > 1) {
        const A = legs[0], B = legs[legs.length - 1];
        if (A.a0 + Math.PI * 2 - B.a0 < 0.5) { A.ends.push(...B.ends); legs.pop(); }
      }
      if (legs.length < 3 || legs.length > 5) continue;
      for (const L of legs) {
        let ux = 0, uz = 0, cls = 9, names = new Map();
        for (const e of L.ends) {
          ux += e.dx; uz += e.dz;
          cls = Math.min(cls, e.f.c);
          if (e.f.n) names.set(e.f.n, (names.get(e.f.n) || 0) + 1);
        }
        const l = Math.hypot(ux, uz) || 1;
        L.ux = ux / l; L.uz = uz / l;
        L.rx = -L.uz; L.rz = L.ux;
        L.cls = cls;
        L.name = [...names].sort((p, q) => q[1] - p[1])[0]?.[0] || '';
        let bestR = -Infinity, bestL = Infinity;
        for (const e of L.ends) {
          const o = (e.x - cx) * L.rx + (e.z - cz) * L.rz;
          if (o + e.hw > bestR) { bestR = o + e.hw; L.rightEnd = e; }
          if (o - e.hw < bestL) { bestL = o - e.hw; L.leftEnd = e; }
        }
        L.width = bestR - bestL;
      }
      const main = legs.slice().sort((p, q) => p.cls - q.cls || q.width - p.width)[0];
      const cross = legs.filter((L) => Math.abs(L.ux * main.ux + L.uz * main.uz) < 0.6);
      if (!cross.length) continue;
      const bestCross = Math.min(...cross.map((L) => L.cls));
      const id = Math.round(cx * 7) * 31 + Math.round(cz * 3);
      const J = {
        x: cx, z: cz, legs, main, id,
        signal: bestCross <= 3 || (bestCross === 4 && main.cls <= 2 && h01(id, 5) < 0.6),
        offset: h01(id, 9) * 64,
      };
      for (const L of legs) L.g = Math.abs(L.ux * main.ux + L.uz * main.uz) >= 0.7071 ? 0 : 1;
      const key = ckey(Math.floor(cx / CHUNK), Math.floor(cz / CHUNK));
      let l = this.junctions.get(key);
      if (!l) this.junctions.set(key, (l = []));
      l.push(J);
      count++;
    }
    return count;
  }

  // ───────────────────────── 公交站 ─────────────────────────
  /** 有人行道的边上离 (x,z) 最近的位置：{k(边序号), s, d(到中心线), side} */
  snapSidewalk(x, z, maxD, cands) {
    const { feats, chain } = this.net;
    let best = null;
    for (const k of cands) {
      const E = this.sw[k];
      const f = feats[E.fi], p = f.p, ch = chain[E.fi];
      for (let i = E.i0; i < E.i1; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], dx = p[i * 2 + 2] - ax, dz = p[i * 2 + 3] - az;
        const L2 = dx * dx + dz * dz || 1e-6;
        let t = ((x - ax) * dx + (z - az) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t, qz = az + dz * t;
        const d = Math.hypot(x - qx, z - qz);
        if (d < maxD && (!best || d < best.d)) {
          const cr = dx * (z - az) - dz * (x - ax); // >0：点在行进方向右侧（x 东 z 南）
          best = { k, s: ch[i] + Math.sqrt(L2) * t, d, side: cr >= 0 ? 1 : -1 };
        }
      }
    }
    return best;
  }
  snapBusStops() {
    const { feats } = this.net;
    const placed = [];
    let n = 0;
    for (let i = 0; i < BUS.length; i += 5) {
      const x = BUS[i] / 10, z = BUS[i + 1] / 10;
      if (this.inDistrict(x, z, 40)) continue;
      const cands = this.edgeCh.get(ckey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
      if (!cands) continue;
      const hit = this.snapSidewalk(x, z, 32, cands);
      if (!hit) continue;
      const E = this.sw[hit.k];
      const f = feats[E.fi];
      let side = hit.side;
      if (f.o && side < 0 && !E.swL) continue; // 双幅路中分带一侧：交给对向一幅
      if (!(side > 0 ? E.swR : E.swL)) continue;
      const half = f.c <= 2 ? 4.6 : 3.4;
      const sA = E.s0 + E.sw0 + half + 2, sB = E.s1 - E.sw1 - half - 2;
      if (sB < sA) continue;
      let s = hit.s;
      if (s < sA) { if (sA - s > 18) continue; s = sA; }
      if (s > sB) { if (s - sB > 18) continue; s = sB; }
      const name = BUS_NAMES[BUS[i + 2]];
      if (placed.some((q) => q.name === name && q.fi === E.fi && q.side === side && Math.abs(q.s - s) < 60)) continue;
      if (placed.some((q) => q.fi === E.fi && q.side === side && Math.abs(q.s - s) < 14)) continue;
      const [cx, cz, tx, tz] = this.pointAt(f, this.net.chain[E.fi], s);
      // signage 的示意候车亭在同侧 35 m 内：不再重复
      const ox = cx - tz * side * (E.W / 2 + 3), oz = cz + tx * side * (E.W / 2 + 3);
      if (this.near(this.sgBus, ox, oz, 35)) continue;
      const st = { k: hit.k, fi: E.fi, side, s, name, routes: BUS_ROUTES[BUS[i + 3]] || '', tag: BUS[i + 4], x: cx, z: cz };
      placed.push(st);
      const key = ckey(Math.floor(cx / CHUNK), Math.floor(cz / CHUNK));
      let l = this.stops.get(key);
      if (!l) this.stops.set(key, (l = []));
      l.push(st);
      n++;
    }
    // 按要素/侧索引（护栏避开站台）
    this.stopBy = new Map();
    for (const q of placed) {
      const k = q.fi * 2 + (q.side > 0 ? 1 : 0);
      let l = this.stopBy.get(k);
      if (!l) this.stopBy.set(k, (l = []));
      l.push(q.s);
    }
    return n;
  }

  // ───────────────────────── 分块生成 ─────────────────────────
  /** 生成第 (i, j) 块；atlas：TextAtlas（路名/站名占格，卸载时按 keys 释放） */
  plan(i, j, atlas, withText = true) {
    const out = new ChunkOut(i, j);
    const x0 = i * CHUNK, z0 = j * CHUNK;
    out.inside = (x, z) => x >= x0 && x < x0 + CHUNK && z >= z0 && z < z0 + CHUNK;
    out.text = withText;
    this.atlas = atlas;
    this.withText = withText;
    const key = ckey(i, j);
    for (const J of this.junctions.get(key) || []) this.planJunction(out, J);
    for (const st of this.stops.get(key) || []) this.planStop(out, st);
    for (const p of this.subway.get(key) || []) this.planSubwayBikes(out, p);
    for (const k of this.edgeCh.get(key) || []) this.planEdge(out, k);
    for (const p of this.shops.get(key) || []) this.planShopBikes(out, p);
    return out.finish();
  }

  /** 牌：pool 'plate'，中心 (x,y,z)，正面法线 (fx,fz)，宽 w、高 h；uvF/uvB 图集矩形 */
  plate(out, x, y, z, fx, fz, w, h, uvF, uvB) {
    out.push('plate', x, y, z, yawOf(fx, fz), 1, h, w, null, { aUV: uvF, aUV2: uvB || uvF });
  }
  roadSignUV(out, name) {
    if (!this.withText) return null;
    const key = 'R|' + name;
    const slot = this.atlas.acquire(key, (g, x, y, w, h) => paintRoadSign(g, x, y, w, h, name, roadPinyin(name, PY_MAP)));
    if (slot < 0) return null;
    out.keys.push(key);
    return this.atlas.rect(slot);
  }
  busSignUV(out, name, routes) {
    if (!this.withText) return null;
    const key = 'B|' + name + '|' + routes;
    const slot = this.atlas.acquire(key, (g, x, y, w, h) => paintBusSign(g, x, y, w, h, name, routes));
    if (slot < 0) return null;
    out.keys.push(key);
    return { all: this.atlas.rect(slot), name: this.atlas.rect(slot, 0, 0, 1, routes ? 0.62 : 1) };
  }
  /** 交通标志：立杆 + 牌（cell 正面方格，back 背面方格），面朝 (fx,fz) */
  trafficSign(out, x, y, z, fx, fz, cell, back, size = 0.7, hc = 2.45) {
    out.push('post', x, y, z, 0, 0.04, hc + size / 2 - 0.05, 0.04, POST_LIGHT);
    this.plate(out, x + fx * 0.05, y + hc, z + fz * 0.05, fx, fz, size, size, this.atlas.signRect(cell), this.atlas.signRect(back));
  }
  /** 信号灯组 + 灯面：中心 (x,y,z)，灯面朝 (fx,fz)；kind0 起始灯色编号（0 红 1 黄 2 绿 / 3 红人 4 绿人） */
  head(out, ped, x, y, z, fx, fz, J, g) {
    const yaw = yawOf(fx, fz);
    out.push(ped ? 'pedHead' : 'sigHead', x, y, z, yaw, 1, 1, 1);
    const off = ped ? 0.115 : 0.135;
    const lens = ped ? [[0.16, 3], [-0.16, 4]] : [[0.38, 0], [0, 1], [-0.38, 2]];
    for (const [ly, k] of lens) out.push('lens', x + fx * off, y + ly, z + fz * off, yaw, ped ? 0.12 : 0.14, ped ? 0.12 : 0.14, ped ? 0.12 : 0.14, null, { aSig: [J.offset, g, k, 0] });
  }

  planJunction(out, J) {
    const Fm = new Frame();
    const occ = out.occ;
    const legs = J.legs;
    const tryAt = (e, sigma, a0, u, r, step = 1.2, n = 4) => {
      for (let t = 0; t < n; t++) {
        const a = a0 + t * step;
        const s = e.s + e.sg * a;
        if (s < 0.5 || s > this.net.total[e.fi] - 0.5) return null;
        if (!this.frame(Fm, e.fi, s, sigma)) return null;
        const [x, z] = Fm.at(u);
        if (!this.blocked(x, z, r, { occ })) return { x, z, y: Fm.y, s, nx: Fm.nx, nz: Fm.nz, tx: Fm.tx, tz: Fm.tz };
      }
      return null;
    };
    const pedDone = new Set();
    if (J.signal) {
      for (const B of legs) {
        const opp = legs.find((A) => A !== B && A.ux * B.ux + A.uz * B.uz < -0.8);
        const e = B.rightEnd;
        const sigma = e.sg; // 出口方向右侧
        // 右侧是驶入的单行道（双幅路只有一幅进了路口簇）或右侧没有人行道：不立杆（避免立到中分带里）
        if (opp && ((e.oneway && e.sg < 0) || !e.swOut)) continue;
        if (!opp && !B.ends.some((q) => !q.oneway)) continue;
        if (opp) {
          // —— 远端右侧悬臂灯杆：立在本出口道右侧人行道，横臂跨出口车道，灯面朝对面驶来的车 ——
          let P = null;
          const a0 = Math.max(e.R + 7, this.clearAlong(e) + 6, swStart(e) + 1);
          for (let t = 0; t < 4 && !P; t++) {
            const a = a0 + t * 1.5;
            const s = e.s + e.sg * a;
            if (this.lampGap(e.fi, s) < 1.2) continue;
            P = tryAt(e, sigma, a, 0.6, 0.35, 1, 1);
          }
          if (!P) continue;
          const outx = P.tx * e.sg, outz = P.tz * e.sg; // 出口方向
          const ix = -P.nx, iz = -P.nz; // 指向路中
          out.push('sigPole', P.x, P.y, P.z, yawOf(ix, iz), 1, 1, 1);
          const L = Math.max(3.2, Math.min(12, (e.oneway ? 2 * e.hw : e.hw) + 0.3));
          out.push('sigArm', P.x, P.y + 6.3, P.z, yawOf(ix, iz), L, 1, 1);
          const nH = L > 8.5 ? 3 : L > 5.5 ? 2 : 1;
          for (let k = 0; k < nH; k++) {
            const d = 1.6 + (k + 0.5) * ((L - 1.6) / nH);
            this.head(out, false, P.x + ix * d, P.y + 6.3 - 0.95, P.z + iz * d, -outx, -outz, J, B.g);
          }
          // 部分灯杆上挂一块圆牌（限速/禁止停车），面朝来车
          if (h01(J.id, e.fi, 13) < 0.35) {
            const cell = h01(J.id, e.fi, 14) < 0.5 ? 4 : e.f.c <= 1 ? 0 : e.f.c === 2 ? 1 : e.f.c === 3 ? 2 : 3;
            this.plate(out, P.x - outx * 0.2, P.y + 3.7, P.z - outz * 0.2, -outx, -outz, 0.7, 0.7, this.atlas.signRect(cell), this.atlas.signRect(7));
          }
          // 杆上人行灯（面朝人行横道对岸）
          if (e.cw) {
            this.head(out, true, P.x + ix * 0.3, P.y + 2.75, P.z + iz * 0.3, ix, iz, J, 1 - B.g);
            pedDone.add(e);
          }
          occ.push(P.x, P.z, 0.5);
          if (e.cw) this.cornerBollards(out, J, e, sigma);
        } else {
          // —— T 形路口的支路进口：对面（主路远侧人行道）立杆，灯面朝支路来车 ——
          let far = 0;
          for (const L2 of legs) {
            if (Math.abs(L2.ux * B.ux + L2.uz * B.uz) > 0.5) continue;
            for (const e2 of L2.ends) far = Math.max(far, -((e2.x - J.x) * B.ux + (e2.z - J.z) * B.uz) + e2.hw);
          }
          const le = B.leftEnd;
          const lat = (le.x - J.x) * B.rx + (le.z - J.z) * B.rz - le.hw * 0.5;
          const qx = J.x - B.ux * (far + 1.0) + B.rx * lat, qz = J.z - B.uz * (far + 1.0) + B.rz * lat;
          if (!this.blocked(qx, qz, 0.35, { occ })) {
            const y = (roadY(this.terrain, le.f, le.x, le.z, le.s, this.net.total[le.fi]) ?? this.terrain.heightAt(qx, qz)) + 0.15;
            out.push('sigPole', qx, y, qz, yawOf(B.ux, B.uz), 1, 1, 1);
            out.push('sigArm', qx, y + 6.3, qz, yawOf(B.ux, B.uz), 3.4, 1, 1);
            this.head(out, false, qx + B.ux * 2.6, y + 5.35, qz + B.uz * 2.6, B.ux, B.uz, J, B.g);
            occ.push(qx, qz, 0.5);
          }
        }
      }
      // —— 人行横道两端的人行灯杆（杆上没有的那一端），阻车石球/桩 ——
      for (const B of legs) for (const e of B.ends) {
        if (!e.cw) continue;
        for (const sigma of [e.sg, -e.sg]) {
          const hasSw = sigma === e.sg ? e.swOut : e.swIn;
          if (!hasSw) continue;
          if (sigma === e.sg && pedDone.has(e)) continue;
          const P = tryAt(e, sigma, Math.max(e.R + 6.3, swStart(e) + 0.4), 0.45, 0.15, 0.8, 3);
          if (!P) continue;
          out.push('post', P.x, P.y, P.z, 0, 0.065, 3.15, 0.065, POST_LIGHT);
          this.head(out, true, P.x - P.nx * 0.22, P.y + 2.75, P.z - P.nz * 0.22, -P.nx, -P.nz, J, 1 - B.g);
          occ.push(P.x, P.z, 0.3);
          this.cornerBollards(out, J, e, sigma);
        }
      }
      // —— 主干道进口：部分路段人行道护栏 ——
      for (const B of legs) {
        if (B.cls > 2) continue;
        for (const e of B.ends) {
          if (h01(J.id, e.fi, 3) > 0.42) continue;
          for (const sigma of [e.sg, -e.sg]) {
            const hasSw = sigma === e.sg ? e.swOut : e.swIn;
            if (hasSw) this.fence(out, e, sigma, e.R + 9, 22 + 34 * h01(J.id, e.fi, 4));
          }
        }
      }
    } else {
      // 非信号路口：人行横道前立“人行横道”标志（面朝来车）
      for (const B of legs) for (const e of B.ends) {
        if (!e.cw || (e.oneway && e.sg > 0) || !e.swIn) continue;
        if (h01(J.id, e.fi, 7) > 0.6) continue;
        const P = tryAt(e, -e.sg, e.R + 9.5, 0.45, 0.4, 1.0, 3);
        if (!P) continue;
        if (this.lampGap(e.fi, P.s) < 1.0) continue;
        this.trafficSign(out, P.x, P.y, P.z, P.tx * e.sg, P.tz * e.sg, 5, 8, 0.7);
        occ.push(P.x, P.z, 0.45);
      }
    }
    // —— 路名牌：主路右侧转角一杆（大路口再加对角一杆），每杆两块，分别平行于两条路 ——
    const names = new Set(legs.map((L) => L.name).filter(Boolean));
    if (names.size >= 2 && this.withText) {
      const right = (B) => {
        let best = null, ba = 9;
        for (const L of legs) {
          if (L === B) continue;
          const a = Math.atan2(L.ux * B.rx + L.uz * B.rz, L.ux * B.ux + L.uz * B.uz);
          if (a > 0.2 && a < ba) { ba = a; best = L; }
        }
        return best;
      };
      // 可立杆的转角：该进口右侧是有人行道的出口道/双向道，且右邻路口名称不同
      const okCorner = (B) => {
        const e = B.rightEnd, K = right(B);
        return !!(K && B.name && K.name && B.name !== K.name && e.swOut && !(e.oneway && e.sg < 0));
      };
      const order = legs.slice().sort((p, q) => p.cls - q.cls || q.width - p.width);
      const corners = [];
      const B0 = order.find(okCorner);
      if (B0) {
        corners.push(B0);
        const big = J.signal && B0.cls <= 2 && legs.length >= 4;
        const B2 = big && legs.find((A) => A !== B0 && A.ux * B0.ux + A.uz * B0.uz < -0.8 && okCorner(A));
        if (B2) corners.push(B2);
      }
      for (const B of corners) {
        const K = right(B);
        const e = B.rightEnd;
        const P = tryAt(e, e.sg, Math.max(e.R + 0.4, this.clearAlong(e) + 0.6, swStart(e) + 0.6), 0.55, 0.3, 0.7, 8);
        if (!P) continue;
        const ux = P.tx * e.sg, uz = P.tz * e.sg;
        const uvB = this.roadSignUV(out, B.name), uvK = this.roadSignUV(out, K.name);
        if (!uvB || !uvK) continue;
        out.push('post', P.x, P.y, P.z, 0, 0.055, 3.1, 0.055, POST_GREY);
        this.plate(out, P.x + ux * 0.72, P.y + 2.82, P.z + uz * 0.72, P.nx, P.nz, 1.32, 0.42, uvB);
        this.plate(out, P.x + K.ux * 0.72, P.y + 2.34, P.z + K.uz * 0.72, K.rx, K.rz, 1.32, 0.42, uvK);
        occ.push(P.x, P.z, 0.4);
      }
    }
  }
  /** 人行横道路缘口的阻车石球/不锈钢桩（3 个，间距 1.3 m） */
  cornerBollards(out, J, e, sigma) {
    const ball = h01(J.id, 11) < 0.55;
    const Fm = new Frame();
    for (const da of [2.2, 3.5, 4.8]) {
      if (e.R + da < swStart(e)) continue; // 人行横道落点处还没有人行道铺装（转角归横向道路）：不放
      const s = e.s + e.sg * (e.R + da);
      if (!this.frame(Fm, e.fi, s, sigma)) continue;
      const [x, z] = Fm.at(0.38);
      if (this.blocked(x, z, 0.28, { occ: out.occ })) continue;
      out.push(ball ? 'ball' : 'bollard', x, Fm.y, z, 0, 1, 1, 1);
      out.occ.push(x, z, 0.3);
    }
  }
  /** 人行道护栏（路缘内侧 0.15 m，2 m 一节） */
  fence(out, e, sigma, a0, len) {
    const E = e.E;
    const lim = E.len - (e.sg > 0 ? E.R1 : E.R0) - 15;
    const a1 = Math.min(a0 + len, lim);
    const stops = this.stopBy.get(e.fi * 2 + (sigma > 0 ? 1 : 0)) || [];
    const Fm = new Frame();
    for (let a = a0; a + 2 <= a1; a += 2) {
      const s = e.s + e.sg * a;
      if (stops.some((q) => Math.abs(q - s) < 16)) continue;
      if (!this.frame(Fm, e.fi, s, sigma)) continue;
      const [x, z] = Fm.at(0.15);
      if (this.blocked(x, z, 0.05, { sg: false })) continue;
      const [x2, z2] = (() => { const F2 = new Frame(); this.frame(F2, e.fi, s + e.sg * 2, sigma); return F2.at(0.15); })();
      if (this.blocked(x2, z2, 0.05, { sg: false })) continue;
      out.push('fence', x, Fm.y, z, yawOf(x2 - x, z2 - z), Math.hypot(x2 - x, z2 - z) / 2, 1, 1);
      out.occ.push((x + x2) / 2, (z + z2) / 2, 1.05);
    }
  }

  planStop(out, st) {
    const { feats, info } = this.net;
    const E = this.sw[st.k];
    const f = feats[st.fi];
    const cfg = info[st.fi].cfg;
    const sigma = st.side;
    const Fm = new Frame();
    if (!this.frame(Fm, st.fi, st.s, sigma)) return;
    const occ = out.occ;
    const tdir = sigma; // 本侧车流方向（相对要素方向）
    const ax = Fm.tx * sigma, az = Fm.tz * sigma; // 候车亭本地 +X（沿路，本地 +Z = 外法线）
    const sw = cfg.sw;
    const shelter = st.tag !== 2 && f.c <= 4 && sw >= 3;
    const nb = f.c <= 2 ? 3 : 2;
    const L = nb * 2.4;
    let placedShelter = false;
    if (shelter) {
      const uBack = Math.max(sw - 0.15, 4.9);
      const [bx, bz] = Fm.at(uBack);
      // 占地抽样：背板线与前缘线各 5 点
      let ok = true;
      for (let k = -2; k <= 2 && ok; k++) for (const du of [0, -1.9]) {
        const px = bx + ax * (k * L / 4) + Fm.nx * du, pz = bz + az * (k * L / 4) + Fm.nz * du;
        if (this.blocked(px, pz, 0.35, { occ })) ok = false;
      }
      const gy = this.terrain.heightAt(bx, bz);
      if (ok && gy < Fm.y + 1.2 && gy > Fm.y - 0.6) { // 背后地面高出太多或低于站台垫层底都不建
        const yaw = yawOf(ax, az);
        out.push(nb === 3 ? 'shelter3' : 'shelter2', bx, Fm.y, bz, yaw, 1, 1, 1);
        for (let b = 1; b < nb; b++) {
          const lx = -L / 2 + (b + 0.5) * 2.4;
          out.push('pane', bx + ax * lx + Fm.nx * 0.05, Fm.y + 1.34, bz + az * lx + Fm.nz * 0.05, yaw, 2.28, 2.0, 1);
        }
        // 广告灯箱（第 0 跨，双面画面）
        const lx0 = -L / 2 + 1.2;
        const pc = (h01(st.fi, Math.round(st.s)) * 4) | 0;
        const cell = this.posterCell(pc), cell2 = this.posterCell((pc + 1) % 4);
        out.push('ad', bx + ax * lx0 + Fm.nx * 0.05, Fm.y + 1.34, bz + az * lx0 + Fm.nz * 0.05, yawOf(-Fm.nx, -Fm.nz), 8.9, 1.95, 2.08, null, { aUV: cell, aUV2: cell2 });
        // 檐口站名（朝路、朝人行道两面）
        const uv = this.busSignUV(out, st.name, st.routes);
        if (uv) {
          const cx = bx - Fm.nx * 1.99, cz = bz - Fm.nz * 1.99;
          this.plate(out, cx, Fm.y + 2.72, cz, -Fm.nx, -Fm.nz, 1.9, 0.27, uv.name);
          const cx2 = bx + Fm.nx * 0.22, cz2 = bz + Fm.nz * 0.22;
          this.plate(out, cx2, Fm.y + 2.72, cz2, Fm.nx, Fm.nz, 1.9, 0.27, uv.name);
        }
        for (let k = -2; k <= 2; k++) occ.push(bx + ax * (k * L / 4) - Fm.nx * 0.95, bz + az * (k * L / 4) - Fm.nz * 0.95, 1.3);
        placedShelter = true;
      }
    }
    // 站牌杆：路缘设施带，候车亭下游端外 1.5 m（车流方向）
    const sEnd = st.s + tdir * (L / 2 + 1.5);
    for (const ds of [0, 1.5, -1.5, 3]) {
      const s = sEnd + tdir * ds;
      if (s < E.s0 + E.sw0 + 1 || s > E.s1 - E.sw1 - 1 || this.lampGap(st.fi, s) < 1.0) continue;
      if (!this.frame(Fm, st.fi, s, sigma)) continue;
      const [x, z] = Fm.at(0.5);
      if (this.blocked(x, z, 0.3, { occ })) continue;
      const uv = this.busSignUV(out, st.name, st.routes);
      if (!uv) break;
      out.push('post', x, Fm.y, z, 0, 0.05, 3.05, 0.05, POST_LIGHT);
      // 站牌面朝来车（双面同文）
      this.plate(out, x - Fm.tx * tdir * 0.06, Fm.y + 2.6, z - Fm.tz * tdir * 0.06, -Fm.tx * tdir, -Fm.tz * tdir, 1.16, 0.3, uv.all, uv.all);
      occ.push(x, z, 0.35);
      break;
    }
    // 主干道公交专用标志（上游 5 m 路缘）
    if (f.c <= 2 && h01(st.fi, Math.round(st.s), 3) < 0.55) {
      const s = st.s - tdir * (L / 2 + 5);
      if (this.frame(Fm, st.fi, s, sigma) && this.lampGap(st.fi, s) > 1.0) {
        const [x, z] = Fm.at(0.45);
        if (!this.blocked(x, z, 0.3, { occ })) {
          this.trafficSign(out, x, Fm.y, z, -Fm.tx * tdir, -Fm.tz * tdir, 6, 8, 0.75, 2.5);
          occ.push(x, z, 0.35);
        }
      }
    }
    // 站台旁的共享单车与垃圾桶
    if (h01(st.fi, Math.round(st.s), 5) < 0.55) this.bikeCluster(out, st.fi, sigma, st.s + tdir * (L / 2 + 5 + 4 * h01(st.fi, 9)), 3 + (h01(st.fi, Math.round(st.s), 6) * 6 | 0), false, h01(st.fi, Math.round(st.s), 7));
    if (placedShelter && this.frame(Fm, st.fi, st.s - tdir * (L / 2 + 0.9), sigma)) {
      const [x, z] = Fm.at(Math.max(sw - 0.6, 3.2));
      if (!this.blocked(x, z, 0.5, { occ, rr: 0.25 })) { out.push('bin', x, Fm.y, z, yawOf(-Fm.nx, -Fm.nz), 1, 1, 1); occ.push(x, z, 0.55); }
    }
  }
  posterCell(i) { return this.posters ? this.posters(i) : [0, 0, 1, 1]; }

  /** 共享单车簇：σ 侧、中心里程 s、n 辆；电动车 ebike = true；hb 品牌散列 */
  bikeCluster(out, fi, sigma, s, n, ebike, hb) {
    const { info } = this.net;
    const cfg = info[fi].cfg;
    const sw = cfg.sw;
    const Fm = new Frame();
    const len = ebike ? 1.9 : 1.75, wid = ebike ? 0.7 : 0.58;
    // 停放角度：后排设施带够深就垂直于路缘，否则斜放；都不行就停到人行道外的空地（无建筑处）
    const zone0 = 2.85, D = sw - 0.15 - zone0;
    let ang = 0, u0 = 0;
    for (const a of [90, 60, 42, 28]) {
      const r = (a * Math.PI) / 180;
      const dep = len * Math.sin(r) + wid * Math.cos(r);
      if (dep <= D) { ang = r; u0 = zone0 + dep / 2; break; }
    }
    let frontage = false;
    if (!ang) { ang = Math.PI / 2; u0 = sw + 0.35 + len / 2; frontage = true; }
    const spacing = (ebike ? 0.78 : 0.6) / Math.max(0.5, Math.sin(ang));
    const flip = h01(fi, Math.round(s), 21) < 0.5 ? 1 : -1;
    let bi = 0;
    const mixed = h01(fi, Math.round(s), 22) < 0.18;
    let brand = 0;
    { let r = hb, acc = 0; for (let k = 0; k < 3; k++) { acc += BRAND_W[k]; if (r < acc) { brand = k; break; } } }
    for (let k = 0; k < n; k++) {
      const ss = s + (k - (n - 1) / 2) * spacing * sigma;
      if (!this.frame(Fm, fi, ss, sigma)) continue;
      const jit = (h01(fi, Math.round(ss * 10), 23) - 0.5);
      const a = ang + jit * 0.16;
      const [x, z] = Fm.at(u0 + jit * 0.12);
      if (this.blocked(x, z, wid * 0.52, { occ: out.occ })) continue;
      // 车身朝向：沿路方向与外法线的组合；车头、车尾两点也不能压到已放物件（配电箱、报刊亭等）
      const dx = (Fm.tx * sigma * Math.cos(a) + Fm.nx * Math.sin(a)) * flip, dz = (Fm.tz * sigma * Math.cos(a) + Fm.nz * Math.sin(a)) * flip;
      const hl = len * 0.38;
      if (this._blocked(x + dx * hl, z + dz * hl, 0.2, { occ: out.occ, sg: false }) || this._blocked(x - dx * hl, z - dz * hl, 0.2, { occ: out.occ, sg: false })) continue;
      let y = Fm.y;
      if (frontage) {
        const gy = this.terrain.heightAt(x, z);
        if (Math.abs(gy - Fm.y) > 0.9) continue;
        y = gy + 0.02;
        const [xe, ze] = Fm.at(u0 + len / 2);
        if (this.bldHit(xe, ze, 0.3)) continue;
      }
      if (ebike) {
        const c = EBIKE[(h01(fi, Math.round(ss * 10), 24) * EBIKE.length) | 0];
        out.push('ebike', x, y, z, yawOf(dx, dz), 1, 1, 1, c);
        if (h01(fi, Math.round(ss * 10), 25) < 0.35) out.push('dbox', x, y, z, yawOf(dx, dz), 1, 1, 1, h01(fi, Math.round(ss * 10), 26) < 0.6 ? [0.98, 0.78, 0.05] : [0.1, 0.55, 0.95]);
      } else {
        const b = mixed ? (h01(fi, Math.round(ss * 10), 27) * 3) | 0 : brand;
        out.push('bike', x, y, z, yawOf(dx, dz), 1, 1, 1, BRAND[b]);
      }
      bi++;
      out.occ.push(x, z, wid * 0.42, x + dx * hl, z + dz * hl, 0.22, x - dx * hl, z - dz * hl, 0.22);
    }
    return bi;
  }

  planSubwayBikes(out, p) {
    const cands = this.edgeCh.get(ckey(Math.floor(p.x / CHUNK), Math.floor(p.z / CHUNK)));
    if (!cands) return;
    const hit = this.snapSidewalk(p.x, p.z, 28, cands);
    if (!hit) return;
    const E = this.sw[hit.k];
    if (!(hit.side > 0 ? E.swR : E.swL)) return;
    const h = h01(Math.round(p.x), Math.round(p.z), 31);
    const dir = h < 0.5 ? 1 : -1;
    for (const d of [dir, -dir]) {
      const s = hit.s + d * (10 + 5 * h);
      if (s < E.s0 + E.sw0 + 4 || s > E.s1 - E.sw1 - 4) continue;
      if (this.bikeCluster(out, E.fi, hit.side, s, 7 + ((h * 97) % 1) * 9 | 0, false, (h * 13) % 1) > 2) break;
    }
  }
  planShopBikes(out, p) {
    const h = h01(Math.round(p.x * 3), Math.round(p.z * 3), 41);
    if (h > 0.22) return;
    const cands = this.edgeCh.get(ckey(Math.floor(p.x / CHUNK), Math.floor(p.z / CHUNK)));
    if (!cands) return;
    const hit = this.snapSidewalk(p.x, p.z, 30, cands);
    if (!hit) return;
    const E = this.sw[hit.k];
    if (!(hit.side > 0 ? E.swR : E.swL)) return;
    if (hit.s < E.s0 + E.sw0 + 4 || hit.s > E.s1 - E.sw1 - 4) return;
    this.bikeCluster(out, E.fi, hit.side, hit.s, 2 + ((h * 50) % 1) * 4 | 0, true, 0);
  }

  /** 沿人行道的常规小品：垃圾桶、消火栓、配电箱、报刊亭、单车/电动车簇、限速/禁停标志 */
  planEdge(out, k) {
    const E = this.sw[k];
    const { feats, info } = this.net;
    const f = feats[E.fi], cfg = info[E.fi].cfg, fi = E.fi;
    const sA = E.s0 + E.sw0 + 1.5, sB = E.s1 - E.sw1 - 1.5;
    if (sB - sA < 6) return;
    const sw = cfg.sw;
    const Fm = new Frame();
    const occ = out.occ;
    for (const sigma of [1, -1]) {
      if (!(sigma > 0 ? E.swR : E.swL)) continue;
      const sd = sigma > 0 ? 1 : 2;
      const stations = (S, salt, jit, cb) => {
        const ph = h01(fi, sd, salt) * S;
        for (let n = Math.ceil((sA - ph) / S); ; n++) {
          const s0 = ph + n * S;
          if (s0 > sB + jit) break;
          const s = s0 + (h01(fi, n, salt * 7 + sd) - 0.5) * jit;
          if (s < sA || s > sB) continue;
          if (!this.frame(Fm, fi, s, sigma)) continue;
          if (!out.inside(Fm.cx, Fm.cz)) continue;
          cb(s, n);
        }
      };
      const place = (pool, s, u, r, face, col = null, rr = r) => {
        for (const ds of [0, 1.6, -1.6, 3.2]) {
          const ss = s + ds;
          if (ss < sA || ss > sB) continue;
          if (u < 1.3 && this.lampGap(fi, ss) < 1.1) continue;
          if (!this.frame(Fm, fi, ss, sigma)) continue;
          const [x, z] = Fm.at(u);
          if (this.blocked(x, z, r, { occ, rr })) continue;
          let y = Fm.y;
          if (u > sw) {
            const gy = this.terrain.heightAt(x, z);
            if (Math.abs(gy - Fm.y) > 0.9) continue;
            y = Math.max(gy + 0.02, Fm.y - 0.45);
          }
          const fx = face * Fm.nx, fz = face * Fm.nz;
          out.push(pool, x, y, z, yawOf(fx, fz), 1, 1, 1, col);
          occ.push(x, z, r);
          return true;
        }
        return false;
      };
      // 分类垃圾桶：约 40 m 一组，路缘设施带
      stations(40, 1, 10, (s) => place('bin', s, 0.42, 0.5, 1, null, 0.2));
      // 消火栓：约 130 m
      stations(130, 2, 20, (s) => place('hydrant', s, 0.38, 0.3, -1, null, 0.2));
      // 配电箱 / 通信交接箱：约 180 m，六成
      stations(180, 3, 40, (s, n) => {
        if (h01(fi, n, 33 + sd) > 0.6) return;
        const u = sw >= 3.6 ? sw - 0.32 : sw + 0.45;
        place('cabinet', s, u, 0.6, -1, CAB[(h01(fi, n, 34) * 3) | 0]);
      });
      // 报刊亭：主次干道约 700 m 三成，人行道 ≥ 4.5 m
      if (f.c <= 3 && sw >= 4.5) stations(700, 4, 120, (s, n) => {
        if (h01(fi, n, 44 + sd) > 0.32) return;
        const u = sw - 0.82;
        if (place('kiosk', s, u, 1.25, -1)) {
          const [x, z] = Fm.at(u);
          // 店招（报刊亭顶部正面）
          this.plate(out, x - Fm.nx * 0.78, Fm.y + 2.08, z - Fm.nz * 0.78, -Fm.nx, -Fm.nz, 1.9, 0.3, this.atlas.rect(3));
        }
      });
      // 共享单车簇：约 70 m 一处，五成半，每簇 3~11 辆
      stations(70, 5, 25, (s, n) => {
        if (h01(fi, n, 55 + sd) > 0.55) return;
        this.bikeCluster(out, fi, sigma, s, 3 + ((h01(fi, n, 56) * 9) | 0), false, h01(fi, n, 57));
      });
      // 电动车：约 110 m 一处，四成
      stations(110, 6, 35, (s, n) => {
        if (h01(fi, n, 66 + sd) > 0.4) return;
        this.bikeCluster(out, fi, sigma, s, 2 + ((h01(fi, n, 67) * 4) | 0), true, 0);
      });
      // 交通标志：只放在本侧车流的右侧路缘（单行道只有右侧），面朝来车
      if (!f.o || sigma > 0) {
        const sign = (s, cell, back) => {
          for (const ds of [0, 2, -2]) {
            const ss = s + ds;
            if (ss < sA || ss > sB || this.lampGap(fi, ss) < 1.1) continue;
            if (!this.frame(Fm, fi, ss, sigma) || !out.inside(Fm.cx, Fm.cz)) continue;
            const [x, z] = Fm.at(0.45);
            if (this.blocked(x, z, 0.3, { occ })) continue;
            this.trafficSign(out, x, Fm.y, z, -Fm.tx * sigma, -Fm.tz * sigma, cell, back, 0.72);
            occ.push(x, z, 0.35);
            return;
          }
        };
        const len = sB - sA;
        // 限速：车流驶离路口后 30 m（主干 60、次干 50、支路 40；快速路 70）
        if (len > 160 && h01(fi, sd, 77) < 0.35) {
          const s = sigma > 0 ? sA + 30 : sB - 30;
          sign(s, f.c === 1 ? 0 : f.c === 2 ? 1 : f.c === 3 ? 2 : 3, 7);
        }
        // 禁止停车：路段中部
        if (len > 110 && h01(fi, sd, 78) < 0.3) sign((sA + sB) / 2 + (h01(fi, sd, 79) - 0.5) * 30, 4, 7);
      }
    }
  }
}

/** 一个分块的实例数据收集器 */
class ChunkOut {
  constructor(i, j) {
    this.i = i; this.j = j;
    this.pools = new Map();
    this.keys = [];
    this.occ = [];
    this.n = 0;
  }
  push(pool, x, y, z, yaw, sx, sy, sz, col = null, attrs = null) {
    let P = this.pools.get(pool);
    if (!P) this.pools.set(pool, (P = { n: 0, m: [], c: [], a: {} }));
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // 列主序：本地 +X → (c, 0, −s)·sx，+Y → (0, sy, 0)，+Z → (s, 0, c)·sz
    P.m.push(c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1);
    if (col) P.c.push(col[0], col[1], col[2]);
    else P.c.push(1, 1, 1);
    if (attrs) for (const k in attrs) {
      let a = P.a[k];
      if (!a) P.a[k] = a = [];
      a.push(...attrs[k]);
    }
    P.n++;
    this.n++;
  }
  finish() {
    const out = { i: this.i, j: this.j, keys: this.keys, n: this.n, text: this.text, data: {} };
    for (const [k, P] of this.pools) {
      const a = {};
      for (const name in P.a) a[name] = Float32Array.from(P.a[name]);
      out.data[k] = { n: P.n, m: Float32Array.from(P.m), c: Float32Array.from(P.c), a };
    }
    return out;
  }
}
