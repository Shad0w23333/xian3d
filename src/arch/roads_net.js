// 道路/铁路网预处理（roads 模块专用）：拆边、路口分析、对向车道配对、灯位、铁路链与高架抬升。
// 纯 CPU 计算，不创建任何 three 对象。所有坐标为世界坐标（米，X 东 Z 南）。
import { chainage } from '../core/roadheight.js';

// —— 道路等级配置（下标与 roads.json classes 一致） ——
// rank：路口主次；minW：最小路面宽（米）；dashLong：6m/9m 长虚线（设计速度≥60），否则 2m/4m；
// lamp：路灯间距（米，0=不布灯）；sw：人行道宽（米，0=无）；far：远景是否保留（'core'=仅核心区）
export const CFG = [
  { id: 'motorway', rank: 10, major: 1, minW: 7.5, dashLong: 1, lamp: 42, sw: 0, far: 1, edge: 0.2 },
  { id: 'trunk', rank: 9, major: 1, minW: 7, dashLong: 1, lamp: 36, sw: 4.5, far: 1, edge: 0.18 },
  { id: 'primary', rank: 8, major: 1, minW: 7, dashLong: 1, lamp: 34, sw: 5, far: 1, edge: 0.15 },
  { id: 'secondary', rank: 7, major: 1, minW: 6.5, dashLong: 0, lamp: 32, sw: 4, far: 1, edge: 0.15 },
  { id: 'tertiary', rank: 6, major: 1, minW: 6, dashLong: 0, lamp: 30, sw: 3, far: 'core', edge: 0.15 },
  { id: 'residential', rank: 3, major: 0, minW: 5, dashLong: 0, lamp: 0, sw: 0, far: 0, noMark: 1 },
  { id: 'service', rank: 2, major: 0, minW: 3.5, dashLong: 0, lamp: 0, sw: 0, far: 0, noMark: 1 },
  { id: 'unclassified', rank: 4, major: 0, minW: 5, dashLong: 0, lamp: 0, sw: 0, far: 0, noMark: 1 },
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
};

// 表面种类（aRoad.x）
export const KIND = { ASPHALT: 0, SIDEWALK: 1, CURB: 2, BALLAST: 4, RAIL: 5, PAVING: 7 };

// 中国结路灯：东西南北大街、长安路；唐风宫灯：曲江/大雁塔一带；红灯笼：二环
const KNOT_NAMES = /^(东大街|西大街|南大街|北大街|长安北路|长安中路|长安南路|长安路)$/;
const PALACE_NAMES = /(雁塔|芙蓉|曲江|慈恩|大唐|雁南|雁展|大雁塔|玄奘|唐延)/;
const LANTERN_NAMES = /二环/;

// 灯型
export const LAMP = { SINGLE: 0, DOUBLE: 1, KNOT: 2, PALACE: 3, LANTERN: 4 };

const nodeKey = (x, z) => (Math.round(x * 10) + 700000) * 2000000 + (Math.round(z * 10) + 1000000);

/** 读入道路要素，给出有效宽度、车道数、标志 */
function featureInfo(f) {
  const cfg = CFG[f.c] || CFG[7];
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
    const p = f.p;
    if (!p || p.length < 4 || f.t) continue;
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
  const dA = [0, 0], dB = [0, 0];
  const analyzeEnd = (E, atStart) => {
    const fi = E.fi;
    const node = atStart ? E.n0 : E.n1;
    const vi = atStart ? E.i0 : E.i1;
    const me = info[fi];
    const res = { R: 0, trim: 0, sw: 0, nX: 0, cw: false };
    if (degAll[node] < 3 && !(me.cfg.link && degAll[node] >= 2)) return res;
    dirAt(fi, vi, atStart ? 1 : -1, dA);
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
            const bigger = oth.cfg.rank > me.cfg.rank || (oth.cfg.rank === me.cfg.rank && fj < fi);
            res.sw = Math.max(res.sw, (hw + (bigger ? oth.cfg.sw : 0)) * k);
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
    const cwOk = cfg.major && !cfg.link && f.c >= 2 && f.c <= 4 && !E.b;
    if (cwOk && a.nX >= 1 && E.len > 28 && a.R > 0 && a.R < 30) flags |= F.CW0;
    if (cwOk && b.nX >= 1 && E.len > 28 && b.R > 0 && b.R < 30) flags |= F.CW1;
    E.flags = flags;
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
  return { edges, feats, info, chain, total, inDetail };
}

/** 路灯灯型：按道路名 */
export function lampStyleFor(f) {
  const n = f.n || '';
  if (KNOT_NAMES.test(n)) return LAMP.KNOT;
  if (LANTERN_NAMES.test(n)) return LAMP.LANTERN;
  if (PALACE_NAMES.test(n)) return LAMP.PALACE;
  return LAMP.SINGLE;
}

/**
 * 布置路灯（记录，不建几何）。返回 {x,y,z,yaw,type,n}（类型化数组）
 * yaw：灯臂指向（弧度，atan2(dx,dz) 约定：局部 +Z 指向路面）
 */
export function placeLamps(net, terrain, roadY, { region, LIFT, edgeFilter = null }) {
  const { edges, feats, info, chain, total } = net;
  const out = { x: [], y: [], z: [], yaw: [], type: [], lvl: [] };
  let curLvl = 3;
  const push = (x, y, z, yaw, type) => {
    out.x.push(x); out.y.push(y); out.z.push(z); out.yaw.push(yaw); out.type.push(type); out.lvl.push(curLvl);
  };
  for (const E of edges) {
    const f = feats[E.fi];
    const cfg = info[E.fi].cfg;
    if (!cfg.lamp || f.t) continue;
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
      const sideType = style === LAMP.PALACE ? LAMP.PALACE : style === LAMP.KNOT ? LAMP.KNOT : style === LAMP.LANTERN ? LAMP.LANTERN : LAMP.SINGLE;
      if (f.c === 0) {
        // 高速/快速路：中央分隔带双臂灯（配对时只由一侧布置）
        if (E.flags & F.PAIRED) {
          if (E.pairF > E.fi && E.gap > 0.5 && E.gap < 30) {
            const m = hw + E.gap / 2;
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
        push(x, baseY(x, z), z, yawR, sideType);
      }
      if (E.flags & F.PAIRED) {
        // 双幅路：中央分隔带双臂灯，由编号小的一幅负责
        if (E.pairF > E.fi && E.gap > 1.2 && E.gap < 40 && !onBridge) {
          const m = hw + E.gap / 2;
          const x = cx - rx * m, z = cz - rz * m;
          push(x, gY(x, z) + 0.2, z, yawL, sideType === LAMP.PALACE ? LAMP.PALACE : sideType === LAMP.KNOT ? LAMP.KNOT : LAMP.DOUBLE);
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
