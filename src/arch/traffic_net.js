// 交通网络构建（纯数据，无 THREE 依赖）：
//   1) 道路有向边图：每条 roads.json 要素 → 1 条（单行）或 2 条（双向）有向边；节点按端点坐标合并；
//      出边带转角，供车辆在路口/环岛按“直行优先、右转次之、左转再次”随机选路；
//      信号灯：主/次/支路交叉口（≥2 个方向差 > 45° 的进口）聚类成路口，按进口方向分两相位。
//   2) 铁路“笔画”：rail.json 去重（原数据约一半要素重复）后，在道岔处沿最顺直、同名的方向连续串联，
//      得到可供列车长距离运行的连续线路。
// 高度统一使用 core/roadheight.js 的 roadY / bridgeLift 规则（与道路模块一致）。
import { LIFT, bridgeLift } from '../core/roadheight.js';

// 道路等级参数：期望车速（m/s）、高峰每车道每公里车辆数、是否可设信号灯
//               0 motorway 1 trunk 2 primary 3 secondary 4 tertiary 5 residential 6 service 7 unclassified
//               8 motorway_link 9 trunk_link 10 primary_link 11 secondary_link
export const CLASS_SPEED = [25.5, 18.5, 13.5, 12, 10.5, 7.5, 6, 8, 16, 14, 11, 10];
export const CLASS_DENSITY = [20, 27, 44, 36, 22, 7, 3, 10, 11, 12, 14, 12];
const CLASS_SIGNAL = [0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1];
export const ROAD_CLASSES = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);

const nodeKey = (x, z) => Math.round(x * 2) * 1000003 + Math.round(z * 2);

function polyLen(p) {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}

/** 折线在起点/终点处的方向（取离端点约 d 米处的点，抗 OSM 短折点噪声） */
function endHeading(p, atEnd, d = 12) {
  const n = p.length / 2;
  if (atEnd) {
    const ex = p[n * 2 - 2], ez = p[n * 2 - 1];
    let acc = 0, bx = p[n * 2 - 4], bz = p[n * 2 - 3];
    for (let i = n - 2; i >= 0; i--) {
      bx = p[i * 2]; bz = p[i * 2 + 1];
      acc = Math.hypot(ex - bx, ez - bz);
      if (acc >= d) break;
    }
    const l = Math.hypot(ex - bx, ez - bz) || 1;
    return [(ex - bx) / l, (ez - bz) / l];
  }
  const sx = p[0], sz = p[1];
  let bx = p[2], bz = p[3];
  for (let i = 1; i < n; i++) {
    bx = p[i * 2]; bz = p[i * 2 + 1];
    if (Math.hypot(bx - sx, bz - sz) >= d) break;
  }
  const l = Math.hypot(bx - sx, bz - sz) || 1;
  return [(bx - sx) / l, (bz - sz) / l];
}

/** 有符号转角（弧度）：X 东 Z 南坐标系下，正值 = 右转 */
export function turnAngle(ax, az, bx, bz) {
  return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
}

function hash32(n) {
  let x = (n | 0) + 0x9e3779b9;
  x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15; x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** 折线累计里程 */
function cumLen(p) {
  const n = p.length / 2;
  const c = new Float64Array(n);
  for (let i = 1; i < n; i++) c[i] = c[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  return c;
}
/** 折线上里程 s 处的点 */
function pointAtS(p, cum, s, out) {
  const n = cum.length;
  if (s <= 0) { out[0] = p[0]; out[1] = p[1]; return out; }
  if (s >= cum[n - 1]) { out[0] = p[n * 2 - 2]; out[1] = p[n * 2 - 1]; return out; }
  let lo = 1, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
  const d = cum[lo] - cum[lo - 1] || 1e-9, t = (s - cum[lo - 1]) / d;
  out[0] = p[lo * 2 - 2] + (p[lo * 2] - p[lo * 2 - 2]) * t;
  out[1] = p[lo * 2 - 1] + (p[lo * 2 + 1] - p[lo * 2 - 1]) * t;
  return out;
}
/** 子段 [s0,s1] 在端点处的方向（沿要素正向），窗口约 12 m */
function subHeading(p, cum, s0, s1, atEnd) {
  const a = [0, 0], b = [0, 0];
  const w = Math.min(12, (s1 - s0) * 0.8);
  if (atEnd) { pointAtS(p, cum, s1 - w, a); pointAtS(p, cum, s1, b); }
  else { pointAtS(p, cum, s0, a); pointAtS(p, cum, s0 + w, b); }
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

/**
 * 道路有向边图
 * 要素在与其它要素共享的顶点、以及被别的路端点“吸附”的投影点处打断成子段；
 * 端点若不与任何顶点重合，则 ①投影吸附到 6 m 内的其它路段 ②或与 22 m 内方向连续的端点相连（补数据缺口）。
 * edges[i] = { f, s0, s1, dir, L, lanes, lw, twoWay, cls, from, to, h0, h1, next:[{e,a}], x0..z1, junction, group }
 */
export function buildRoadGraph(roads) {
  const feats = roads?.features || [];
  const inc = [];
  const cums = new Array(feats.length);
  const featLen = new Float32Array(feats.length);
  for (let fi = 0; fi < feats.length; fi++) {
    const f = feats[fi];
    if (!ROAD_CLASSES.has(f.c) || f.t || f._ped || !f.p || f.p.length < 4) continue;
    const c = cumLen(f.p);
    const L = c[c.length - 1];
    if (L < 1.5) continue;
    cums[fi] = c;
    featLen[fi] = L;
    inc.push(fi);
  }
  // —— 顶点表 & 线段网格 ——
  const vmap = new Map();
  const SG = 40, sgrid = new Map();
  for (const fi of inc) {
    const p = feats[fi].p, n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const k = nodeKey(p[i * 2], p[i * 2 + 1]);
      let l = vmap.get(k);
      if (!l) vmap.set(k, (l = []));
      l.push(fi, i);
    }
    for (let i = 1; i < n; i++) {
      const ax = p[i * 2 - 2], az = p[i * 2 - 1], bx = p[i * 2], bz = p[i * 2 + 1];
      const gx0 = Math.floor((Math.min(ax, bx) - 6) / SG), gx1 = Math.floor((Math.max(ax, bx) + 6) / SG);
      const gz0 = Math.floor((Math.min(az, bz) - 6) / SG), gz1 = Math.floor((Math.max(az, bz) + 6) / SG);
      if ((gx1 - gx0 + 1) * (gz1 - gz0 + 1) > 400) continue; // 超长单段（高速远郊）不参与吸附
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gz = gz0; gz <= gz1; gz++) {
          const k = gx * 100003 + gz;
          let l = sgrid.get(k);
          if (!l) sgrid.set(k, (l = []));
          l.push(fi, i);
        }
    }
  }
  // —— 并查集（节点键） ——
  const par = new Map();
  const find = (k) => {
    if (!par.has(k)) { par.set(k, k); return k; }
    let r = k;
    while (par.get(r) !== r) r = par.get(r);
    while (par.get(k) !== r) { const nx = par.get(k); par.set(k, r); k = nx; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra, rb); };
  const keyPos = new Map();
  const splits = new Map(); // fi -> [{s, key}]
  const addSplit = (fi, s, key, x, z) => {
    let l = splits.get(fi);
    if (!l) splits.set(fi, (l = []));
    l.push({ s, key });
    if (!keyPos.has(key)) keyPos.set(key, [x, z]);
    find(key);
  };
  for (const fi of inc) {
    const p = feats[fi].p, n = p.length / 2, c = cums[fi];
    addSplit(fi, 0, nodeKey(p[0], p[1]), p[0], p[1]);
    addSplit(fi, c[n - 1], nodeKey(p[n * 2 - 2], p[n * 2 - 1]), p[n * 2 - 2], p[n * 2 - 1]);
  }
  // ① 共享顶点
  for (const [k, l] of vmap) {
    if (l.length < 4) continue;
    let distinct = false;
    for (let i = 2; i < l.length; i += 2) if (l[i] !== l[0]) distinct = true;
    if (!distinct) continue;
    for (let i = 0; i < l.length; i += 2) {
      const fi = l[i], vi = l[i + 1];
      const p = feats[fi].p;
      addSplit(fi, cums[fi][vi], k, p[vi * 2], p[vi * 2 + 1]);
    }
  }
  // ② 孤立端点：投影吸附 / 缺口连接
  const endpointList = []; // [fi, atEnd]
  for (const fi of inc) { endpointList.push(fi, 0, fi, 1); }
  const epGrid = new Map(), EG = 50;
  for (const fi of inc) {
    const p = feats[fi].p, n = p.length;
    for (const [x, z, e] of [[p[0], p[1], 0], [p[n - 2], p[n - 1], 1]]) {
      const k = Math.floor(x / EG) * 100003 + Math.floor(z / EG);
      let l = epGrid.get(k);
      if (!l) epGrid.set(k, (l = []));
      l.push(fi, e);
    }
  }
  const tmp = [0, 0];
  for (let q = 0; q < endpointList.length; q += 2) {
    const fi = endpointList[q], atEnd = endpointList[q + 1];
    const f = feats[fi], p = f.p, n = p.length;
    const x = atEnd ? p[n - 2] : p[0], z = atEnd ? p[n - 1] : p[1];
    const k = nodeKey(x, z);
    const l = vmap.get(k);
    let shared = false;
    for (let i = 0; i < l.length; i += 2) if (l[i] !== fi) { shared = true; break; }
    if (shared) continue;
    // (a) 投影到 6 m 内的其它路段
    let best = null, bd = 6;
    const gx = Math.floor(x / SG), gz = Math.floor(z / SG);
    const segs = sgrid.get(gx * 100003 + gz);
    if (segs)
      for (let i = 0; i < segs.length; i += 2) {
        const fj = segs[i], si = segs[i + 1];
        if (fj === fi) continue;
        const pp = feats[fj].p;
        const ax = pp[si * 2 - 2], az = pp[si * 2 - 1], bx = pp[si * 2], bz = pp[si * 2 + 1];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
        let t = ((x - ax) * dx + (z - az) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < bd) { bd = d; best = { fj, si, t, px: ax + dx * t, pz: az + dz * t }; }
      }
    if (best) {
      const c = cums[best.fj];
      const s = c[best.si - 1] + (c[best.si] - c[best.si - 1]) * best.t;
      const pk = nodeKey(best.px, best.pz);
      addSplit(best.fj, s, pk, best.px, best.pz);
      union(k, pk);
      continue;
    }
    // (b) 22 m 内方向连续的端点（数据缺口，如西门瓮城处）
    const h = endHeading(p, !!atEnd);
    const hx = atEnd ? h[0] : -h[0], hz = atEnd ? h[1] : -h[1]; // 离开本要素的方向
    let bestE = null, be = 22;
    const ex0 = Math.floor(x / EG), ez0 = Math.floor(z / EG);
    for (let ddx = -1; ddx <= 1; ddx++)
      for (let ddz = -1; ddz <= 1; ddz++) {
        const el = epGrid.get((ex0 + ddx) * 100003 + ez0 + ddz);
        if (!el) continue;
        for (let i = 0; i < el.length; i += 2) {
          const fj = el[i], ej = el[i + 1];
          if (fj === fi) continue;
          const g = feats[fj], gp = g.p, gn = gp.length;
          const ox = ej ? gp[gn - 2] : gp[0], oz = ej ? gp[gn - 1] : gp[1];
          const d = Math.hypot(ox - x, oz - z);
          if (d >= be || d < 0.3) continue;
          // 单行路：终点只接起点、起点只接终点
          if (f.o && g.o && (atEnd ? ej !== 0 : ej !== 1)) continue;
          const gh = endHeading(gp, !!ej);
          const gx2 = ej ? -gh[0] : gh[0], gz2 = ej ? -gh[1] : gh[1]; // 进入对方要素的方向
          if (hx * gx2 + hz * gz2 < 0.75) continue;
          // 缺口本身也要大致顺着行进方向
          if (d > 3 && ((ox - x) * hx + (oz - z) * hz) / d < 0.5) continue;
          be = d; bestE = nodeKey(ox, oz);
        }
      }
    if (bestE !== null) union(k, bestE);
  }

  // —— 节点 ——
  const nodeIndex = new Map();
  const nodes = [];
  const nodeOf = (key) => {
    const r = find(key);
    let id = nodeIndex.get(r);
    if (id === undefined) {
      id = nodes.length;
      nodeIndex.set(r, id);
      const pos = keyPos.get(r) || keyPos.get(key);
      nodes.push({ x: pos[0], z: pos[1], inE: [], outE: [], junction: -1 });
    }
    return id;
  };

  // —— 子段 → 有向边 ——
  const edges = [];
  for (const fi of inc) {
    const f = feats[fi], p = f.p, c = cums[fi];
    const sp = splits.get(fi).sort((a, b) => a.s - b.s);
    // 合并过近的切点
    const uniq = [];
    for (const q of sp) {
      const last = uniq[uniq.length - 1];
      if (last && q.s - last.s < 1.0) { union(q.key, last.key); continue; }
      uniq.push(q);
    }
    if (uniq.length < 2) continue;
    const total = Math.max(1, f.l | 0);
    const w = Number(f.w) || 7;
    for (let i = 1; i < uniq.length; i++) {
      const s0 = uniq[i - 1].s, s1 = uniq[i].s;
      const L = s1 - s0;
      if (L < 0.8) continue;
      const a = nodeOf(uniq[i - 1].key), b = nodeOf(uniq[i].key);
      if (a === b && L < 30) continue;
      const hs = subHeading(p, c, s0, s1, false), he = subHeading(p, c, s0, s1, true);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      const acc = (x, z) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; };
      pointAtS(p, c, s0, tmp); acc(tmp[0], tmp[1]);
      pointAtS(p, c, s1, tmp); acc(tmp[0], tmp[1]);
      for (let v = 0; v < c.length; v++) if (c[v] > s0 && c[v] < s1) acc(p[v * 2], p[v * 2 + 1]);
      const mk = (dir, lanes, twoWay) => {
        const e = {
          id: edges.length, f: fi, s0, s1, dir, L, lanes, twoWay, cls: f.c,
          lw: Math.min(3.6, Math.max(2.9, w / (twoWay ? lanes * 2 : lanes))),
          from: dir > 0 ? a : b, to: dir > 0 ? b : a,
          h0: dir > 0 ? hs : [-he[0], -he[1]],
          h1: dir > 0 ? he : [-hs[0], -hs[1]],
          next: [], x0, z0, x1, z1, junction: -1, group: 0, internal: false,
          speed: CLASS_SPEED[f.c] || 10, density: CLASS_DENSITY[f.c] || 8,
        };
        edges.push(e);
        return e;
      };
      if (f.o) mk(1, total, false);
      else {
        const per = Math.max(1, Math.floor(total / 2));
        mk(1, per, true);
        mk(-1, per, true);
      }
    }
  }
  // 并查集在建边过程中可能又合并了节点：按最终根节点重新映射
  const remap = new Map();
  const finalNodes = [];
  const rootOfNode = [];
  for (const [r, id] of nodeIndex) rootOfNode[id] = find(r);
  for (let id = 0; id < nodes.length; id++) {
    const r = rootOfNode[id];
    let nid = remap.get(r);
    if (nid === undefined) { nid = finalNodes.length; remap.set(r, nid); finalNodes.push({ x: nodes[id].x, z: nodes[id].z, inE: [], outE: [], junction: -1 }); }
    nodes[id].final = nid;
  }
  for (const e of edges) {
    e.from = nodes[e.from].final;
    e.to = nodes[e.to].final;
    finalNodes[e.from].outE.push(e.id);
    finalNodes[e.to].inE.push(e.id);
  }
  return finishGraph(feats, featLen, finalNodes, edges);
}

function finishGraph(feats, featLen, nodes, edges) {
  // 出边与转角
  for (const e of edges) {
    const nd = nodes[e.to];
    for (const oid of nd.outE) {
      const o = edges[oid];
      if (o.f === e.f && o.dir === -e.dir && Math.abs(o.s0 - e.s0) < 0.01) continue; // 不掉头
      const a = turnAngle(e.h1[0], e.h1[1], o.h0[0], o.h0[1]);
      if (Math.abs(a) > 2.6) continue; // 近乎掉头的急转不走
      e.next.push({ e: oid, a });
    }
  }

  // 信号灯路口：进口 ≥ 2 且方向差 > 45°、等级合适（快速路/高速互通不设灯）
  const sigNodes = [];
  for (let ni = 0; ni < nodes.length; ni++) {
    const nd = nodes[ni];
    if (nd.inE.length < 2 || nd.inE.length + nd.outE.length < 3) continue;
    let bad = false, good = 0;
    for (const eid of [...nd.inE, ...nd.outE]) {
      const c = edges[eid].cls;
      if (c === 0 || c === 8 || c === 1 || c === 9) bad = true;
      if (CLASS_SIGNAL[c]) good++;
    }
    if (bad || good < 2) continue;
    let crossing = false;
    for (let i = 0; i < nd.inE.length && !crossing; i++)
      for (let j = i + 1; j < nd.inE.length; j++) {
        const A = edges[nd.inE[i]].h1, B = edges[nd.inE[j]].h1;
        const d = Math.abs(A[0] * B[0] + A[1] * B[1]);
        if (d < 0.72) { crossing = true; break; }
      }
    if (crossing) sigNodes.push(ni);
  }
  // 聚类（双幅路交叉口由 4 个节点组成）
  const parent = new Map(sigNodes.map((n) => [n, n]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const cell = 45, grid = new Map();
  for (const ni of sigNodes) {
    const k = Math.floor(nodes[ni].x / cell) * 100003 + Math.floor(nodes[ni].z / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(ni);
  }
  for (const ni of sigNodes) {
    const nd = nodes[ni];
    const cx = Math.floor(nd.x / cell), cz = Math.floor(nd.z / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get((cx + dx) * 100003 + cz + dz);
        if (!list) continue;
        for (const nj of list) {
          if (nj <= ni) continue;
          if (Math.hypot(nodes[nj].x - nd.x, nodes[nj].z - nd.z) < 42) {
            const ra = find(ni), rb = find(nj);
            if (ra !== rb) parent.set(ra, rb);
          }
        }
      }
  }
  const junctions = [];
  const jIndex = new Map();
  for (const ni of sigNodes) {
    const r = find(ni);
    let j = jIndex.get(r);
    if (j === undefined) {
      j = junctions.length;
      jIndex.set(r, j);
      const h = hash32(r * 7 + 11);
      junctions.push({ cycle: 70 + h * 45, offset: hash32(r * 13 + 5) * 200, ax: 1, az: 0, best: 99, nodes: [] });
    }
    junctions[j].nodes.push(ni);
    nodes[ni].junction = j;
  }
  // 路口主轴 = 最高等级进口的方向
  for (const J of junctions) {
    for (const ni of J.nodes)
      for (const eid of nodes[ni].inE) {
        const e = edges[eid];
        if (e.cls < J.best || (e.cls === J.best && e.L > 80)) { J.best = e.cls; J.ax = e.h1[0]; J.az = e.h1[1]; }
      }
  }
  for (const e of edges) {
    const j = nodes[e.to].junction;
    if (j < 0) continue;
    // 路口内部连接段（起点也在同一路口）不再停车
    if (nodes[e.from].junction === j) { e.internal = true; continue; }
    const J = junctions[j];
    e.junction = j;
    e.group = Math.abs(e.h1[0] * J.ax + e.h1[1] * J.az) >= 0.64 ? 0 : 1;
  }

  // 空间索引（400 m 网格）
  const G = 400;
  const egrid = new Map();
  const partner = new Int32Array(edges.length).fill(-1);
  for (let i = 0; i + 1 < edges.length; i++)
    if (edges[i].twoWay && edges[i].dir > 0 && edges[i + 1].f === edges[i].f && edges[i + 1].dir < 0) { partner[i] = i + 1; partner[i + 1] = i; }
  for (const e of edges) {
    if (e.dir < 0 && partner[e.id] >= 0) continue; // 双向要素只登记一次（查询时补上反向边）
    for (let gx = Math.floor(e.x0 / G); gx <= Math.floor(e.x1 / G); gx++)
      for (let gz = Math.floor(e.z0 / G); gz <= Math.floor(e.z1 / G); gz++) {
        const k = gx * 100003 + gz;
        let l = egrid.get(k);
        if (!l) egrid.set(k, (l = []));
        l.push(e.id);
      }
  }

  return {
    feats, featLen, nodes, edges, junctions, partner, G, egrid,
    /** 查询包围盒与圆 (x,z,r) 相交的边 id（含双向的反向边），结果写入 out（数组） */
    query(x, z, r, out, stamp, stampArr) {
      out.length = 0;
      const gx0 = Math.floor((x - r) / G), gx1 = Math.floor((x + r) / G);
      const gz0 = Math.floor((z - r) / G), gz1 = Math.floor((z + r) / G);
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gz = gz0; gz <= gz1; gz++) {
          const l = egrid.get(gx * 100003 + gz);
          if (!l) continue;
          for (const id of l) {
            if (stampArr[id] === stamp) continue;
            stampArr[id] = stamp;
            const e = edges[id];
            const dx = Math.max(e.x0 - x, 0, x - e.x1), dz = Math.max(e.z0 - z, 0, z - e.z1);
            if (dx * dx + dz * dz > r * r) continue;
            out.push(id);
            const p = partner[id];
            if (p >= 0) { stampArr[p] = stamp; out.push(p); }
          }
        }
      return out;
    },
  };
}

/**
 * 封闭不通车的边（步行街、下沉广场坑口、楼体内部等“道路模块不画路面”的地方）：
 * 沿边每 step 米取样（两端各让出 5 m，路口本身常在排除区边缘），落在 blocked(x,z) 内的样点
 * 占 30% 以上或累计 ≥ 24 m 即封闭；封闭边从所有出边表里删除（车辆不会选路驶入），活动区也不再激活它。
 * 返回封闭边数。
 */
export function blockEdges(G, blocked, step = 6) {
  const { edges, feats } = G;
  const cumOf = new Map();
  const pt = [0, 0];
  let nb = 0;
  for (const e of edges) {
    let c = cumOf.get(e.f);
    if (!c) cumOf.set(e.f, (c = cumLen(feats[e.f].p)));
    const p = feats[e.f].p;
    const a = e.s0 + Math.min(5, e.L * 0.2), b = e.s1 - Math.min(5, e.L * 0.2);
    const n = Math.max(1, Math.ceil((b - a) / step));
    let hit = 0;
    for (let k = 0; k <= n; k++) {
      pointAtS(p, c, a + ((b - a) * k) / n, pt);
      if (blocked(pt[0], pt[1])) hit++;
    }
    if (hit && (hit / (n + 1) >= 0.3 || hit * ((b - a) / n) >= 24)) { e.blocked = true; nb++; }
  }
  if (nb) for (const e of edges) if (e.next.length) e.next = e.next.filter((q) => !edges[q.e].blocked);
  return nb;
}

/**
 * 要素重采样（懒加载）：等距 step 米，x/z 经两次 [1,2,1] 平滑（圆滑 OSM 折角，端点不动），
 * y = 地面 + LIFT + 桥梁抬升（隧道返回 NaN）。同时给出最小转弯半径推导的限速。
 */
export function resampleFeature(f, L, terrain, step = 4, yOffset = 0) {
  const p = f.p;
  const n = Math.max(2, Math.ceil(L / step) + 1);
  const st = L / (n - 1);
  const xs = new Float32Array(n), zs = new Float32Array(n);
  let seg = 2, acc = 0, segL = Math.hypot(p[2] - p[0], p[3] - p[1]);
  for (let i = 0; i < n; i++) {
    const s = i === n - 1 ? L : i * st;
    while (seg < p.length - 2 && acc + segL < s) {
      acc += segL;
      seg += 2;
      segL = Math.hypot(p[seg] - p[seg - 2], p[seg + 1] - p[seg - 1]);
    }
    const t = segL > 1e-6 ? Math.min(1, Math.max(0, (s - acc) / segL)) : 0;
    xs[i] = p[seg - 2] + (p[seg] - p[seg - 2]) * t;
    zs[i] = p[seg - 1] + (p[seg + 1] - p[seg - 1]) * t;
  }
  // 平滑（窗口随采样步长约 ±8 m）
  const passes = n > 4 ? 3 : 0;
  const tx = new Float32Array(n), tz = new Float32Array(n);
  for (let k = 0; k < passes; k++) {
    tx.set(xs); tz.set(zs);
    for (let i = 1; i < n - 1; i++) {
      xs[i] = (tx[i - 1] + 2 * tx[i] + tx[i + 1]) * 0.25;
      zs[i] = (tz[i - 1] + 2 * tz[i] + tz[i + 1]) * 0.25;
    }
  }
  const xyz = new Float32Array(n * 3);
  let minR = 1e9;
  for (let i = 0; i < n; i++) {
    const s = i * st;
    const x = xs[i], z = zs[i];
    const y = f.t ? NaN : terrain.heightAt(x, z) + LIFT + bridgeLift(f, s, L) + yOffset;
    xyz[i * 3] = x; xyz[i * 3 + 1] = y; xyz[i * 3 + 2] = z;
  }
  // 最小转弯半径（跨 ~12 m 的方向变化）
  const k = Math.max(1, Math.round(12 / st));
  for (let i = k; i + k < n; i += k) {
    const ax = xs[i] - xs[i - k], az = zs[i] - zs[i - k];
    const bx = xs[i + k] - xs[i], bz = zs[i + k] - zs[i];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-3 || lb < 1e-3) continue;
    const ang = Math.abs(turnAngle(ax / la, az / la, bx / lb, bz / lb));
    if (ang < 1e-3) continue;
    const R = ((la + lb) * 0.5) / ang;
    if (R < minR) minR = R;
  }
  return { n, st, xyz, L, vcap: Math.min(40, Math.max(4.5, Math.sqrt(2.4 * minR))) };
}

// ======================================================================
// 铁路笔画
// ======================================================================
export const RAIL_KIND = { HSR: 0, CONV: 1, METRO: 2 };

function railKindOf(cls, name) {
  if (cls === 1) return RAIL_KIND.METRO; // subway
  if (cls === 2) return -1; // light_rail（云巴/智轨）暂不跑车
  if (!name) return RAIL_KIND.CONV;
  if (/高速|客专|城际|动车|动走|疏解|北动走|西安东联络/.test(name)) return RAIL_KIND.HSR;
  if (/专用线|试车|机走|车底|回转|规划|预留|停车场|车辆段|出入段/.test(name)) return -1;
  return RAIL_KIND.CONV;
}

/**
 * rail.json → 去重要素 → 笔画（在节点处选最顺直、优先同名的未用要素延伸）
 * 返回 strokes: [{parts:[{fi,rev}], name, kind, L, p:Float64Array(xz 串联折线)}]
 */
export function buildRailStrokes(rail) {
  const src = rail?.features || [];
  const seen = new Set();
  const feats = [];
  for (const f of src) {
    if (!f.p || f.p.length < 4) continue;
    const k = f.c + '|' + f.p.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    feats.push(f);
  }
  const ends = new Map(); // nodeKey -> [{fi, end}]
  const add = (k, v) => { let l = ends.get(k); if (!l) ends.set(k, (l = [])); l.push(v); };
  for (let fi = 0; fi < feats.length; fi++) {
    const p = feats[fi].p, n = p.length;
    add(nodeKey(p[0], p[1]), { fi, end: 0 });
    add(nodeKey(p[n - 2], p[n - 1]), { fi, end: 1 });
  }
  const used = new Uint8Array(feats.length);
  const strokes = [];
  const extend = (list, atX, atZ, hx, hz, name, cls) => {
    // 从 (atX,atZ) 沿 (hx,hz) 继续
    for (;;) {
      const cands = ends.get(nodeKey(atX, atZ));
      if (!cands) break;
      let best = null, bestScore = Infinity;
      for (const c of cands) {
        if (used[c.fi]) continue;
        const f = feats[c.fi];
        if ((f.c === 1) !== (cls === 1)) continue; // 地铁与国铁不互串
        const h = endHeading(f.p, c.end === 1);
        const dx = c.end === 0 ? h[0] : -h[0], dz = c.end === 0 ? h[1] : -h[1];
        const ang = Math.abs(turnAngle(hx, hz, dx, dz));
        if (ang > 0.55) continue;
        const score = ang + ((f.n || '') === name ? 0 : 0.25);
        if (score < bestScore) { bestScore = score; best = { c, dx, dz }; }
      }
      if (!best) break;
      const { c } = best;
      used[c.fi] = 1;
      const f = feats[c.fi], n = f.p.length;
      list.push({ fi: c.fi, rev: c.end === 1 });
      atX = c.end === 0 ? f.p[n - 2] : f.p[0];
      atZ = c.end === 0 ? f.p[n - 1] : f.p[1];
      const h = endHeading(f.p, c.end === 0);
      hx = c.end === 0 ? h[0] : -h[0];
      hz = c.end === 0 ? h[1] : -h[1];
    }
    return list;
  };
  // 从长要素开始（主线优先成笔）
  const order = feats.map((f, i) => [polyLen(f.p), i]).sort((a, b) => b[0] - a[0]).map((a) => a[1]);
  for (const fi of order) {
    if (used[fi]) continue;
    used[fi] = 1;
    const f = feats[fi], p = f.p, n = p.length;
    const he = endHeading(p, true), hs = endHeading(p, false);
    const fwd = extend([], p[n - 2], p[n - 1], he[0], he[1], f.n || '', f.c);
    const back = extend([], p[0], p[1], -hs[0], -hs[1], f.n || '', f.c);
    // back 是从起点向后延伸的，需要翻转并取反向
    const parts = [...back.reverse().map((q) => ({ fi: q.fi, rev: !q.rev })), { fi, rev: false }, ...fwd];
    // 串联折线
    const pts = [];
    const names = new Map();
    let L = 0;
    for (const q of parts) {
      const fp = feats[q.fi].p, m = fp.length / 2;
      const len = polyLen(fp);
      L += len;
      const nm = feats[q.fi].n || '';
      names.set(nm, (names.get(nm) || 0) + len);
      for (let i = 0; i < m; i++) {
        const j = q.rev ? m - 1 - i : i;
        if (pts.length && i === 0) continue;
        pts.push(fp[j * 2], fp[j * 2 + 1]);
      }
    }
    let name = '', best = -1;
    for (const [k, v] of names) if (v > best && k) { best = v; name = k; }
    const kind = railKindOf(f.c, name);
    strokes.push({ parts, name, cls: f.c, kind, L, p: Float64Array.from(pts) });
  }
  return { feats, strokes };
}

/**
 * 笔画重采样：等距 step，逐段按所属要素的桥梁/隧道规则取高度；tun[i]=1 表示隧道（不可见）
 * liftOf(f, ls, len)：要素 f 上里程 ls 处轨面相对地面的抬升（默认 LIFT + bridgeLift，与道路规则一致；
 * traffic 模块传入 roads_net.buildRailNet 的高架抬升，与道路模块画的轨道对齐）
 */
export function resampleStroke(stroke, feats, terrain, step = 5, yOffset = 0, liftOf = null) {
  const L = stroke.L;
  const n = Math.max(2, Math.ceil(L / step) + 1);
  const st = L / (n - 1);
  const xyz = new Float32Array(n * 3);
  const tun = new Uint8Array(n);
  // 部件边界
  const bounds = [];
  let acc = 0;
  for (const q of stroke.parts) {
    const f = feats[q.fi];
    const len = polyLen(f.p);
    bounds.push({ f, s0: acc, s1: acc + len, rev: q.rev, len });
    acc += len;
  }
  const p = stroke.p;
  let seg = 2, sacc = 0, segL = Math.hypot(p[2] - p[0], p[3] - p[1]);
  let bi = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(L, i * st);
    while (seg < p.length - 2 && sacc + segL < s) {
      sacc += segL;
      seg += 2;
      segL = Math.hypot(p[seg] - p[seg - 2], p[seg + 1] - p[seg - 1]);
    }
    const t = segL > 1e-6 ? Math.min(1, Math.max(0, (s - sacc) / segL)) : 0;
    const x = p[seg - 2] + (p[seg] - p[seg - 2]) * t;
    const z = p[seg - 1] + (p[seg + 1] - p[seg - 1]) * t;
    while (bi < bounds.length - 1 && bounds[bi].s1 < s) bi++;
    const b = bounds[bi];
    const ls = b.rev ? b.s1 - s : s - b.s0;
    xyz[i * 3] = x; xyz[i * 3 + 2] = z;
    // 隧道/地下段（地铁 layer<0 即地下；国铁 layer<0 且非桥）
    if (b.f.t || ((b.f.y || 0) < 0 && (b.f.c !== 0 || !b.f.b))) {
      tun[i] = 1;
      xyz[i * 3 + 1] = terrain.heightAt(x, z) - 12;
    } else {
      const lc = Math.max(0, Math.min(b.len, ls));
      xyz[i * 3 + 1] = terrain.heightAt(x, z) + (liftOf ? liftOf(b.f, lc, b.len) : LIFT + bridgeLift(b.f, lc, b.len)) + yOffset;
    }
  }
  return { n, st, xyz, tun, L };
}
