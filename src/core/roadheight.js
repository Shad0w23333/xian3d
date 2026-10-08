// 道路高程统一规则（roads / traffic / 路名标注 / skyline 桥塔等共用，保证车辆、路灯、桥塔贴合同一桥面）。
//
// 旧规则的问题（tools/check_roads.mjs 诊断）：每条要素各自“地面高 + 6.5 m×层，两端 90 m 内平滑落地”，
//   · 一座桥在 OSM 里被切成多段 → 每段两端都落回地面，桥面在段与段之间反复下沉/驼峰（锯齿）；
//   · 短桥两端起坡挤在几十米内，坡度可达 100%~200%；桥面还逐点跟随 DEM 起伏；
//   · 立交上下层互不感知，上层在下层正上方往往正处于起坡段，净空不足甚至穿插；
//   · 地面路按 36/75 m 断面线性插值，DEM 的凸起处路面被地形吃掉。
//
// 新规则（prepareRoadProfiles，一次性在整张路网上求纵断面，各要素存为按里程的折线 f._rp）：
//   1) 路网图：各要素顶点（按 0.1 m 坐标合并为共享节点）+ 按步长加密的采样点（桥 10 m、核心区 16 m、远郊 48 m）；
//      共享节点只有一个高程，路口/桥-桥衔接处不会出现台阶。核心区外不渲染的支路/步道不参与。
//   2) 地面路参考面 Yg：节点地面 + “段内地面高出两端连线的最大量”（只补凸起）+ LIFT，再做至多抬高 0.5 m 的投影平滑；
//      渲染断面与节点一一对应（profileStepFn），因此路面折线处处不低于地形（不再被埋），小波浪被削平。
//   3) 桥梁参考面：以落地端（桥要素端点接地面路处）的地面路高程为边界，在桥梁子图上求调和插值
//      （单条桥链上就是两端连线），桥面不再跟随桥下 DEM 起伏；桥面目标抬升 = 层高 × 起坡系数
//      （到最近落地端的里程在 RAMP_IN 内 smoothstep 起坡）；短小的河沟桥（整链 <60 m 且单层）只拱起 1.2 m。
//   4) 最大坡度约束：在“抬升量”空间以桥面目标为源做“抬升 − G×图距离”的最大值传播（G = MAX_GRADE），
//      引桥/路堤自然延伸到相接的地面路上顺接地面，多层匝道在层间按 ≤G 过渡；山区地形本身的坡度不受影响。
//   5) 竖曲线：在“净空硬约束的 2G 坡度锥”之上对抬升量做投影 Laplacian 平滑，磨圆起坡/落坡折角。
//   6) 立交净空：找出所有不共节点、且 60 m 内不共节点（排除分合流）的交叉（至少一方为桥），按层（y）定上下层，
//      上层桥面需高出下层 CLEAR + 梁高 + 0.2 m；不满足就在上层交叉点前后设硬约束。按上层层号 1→5 逐层处理
//      （每层至多复核 3 次），不做全局反复迭代，避免密集立交网里“抬上层 → 经匝道带起下层 → 再抬上层”的正反馈；
//      路网上 170 m 内相连的上下层（天桥与其梯道下的步道等）与“地面路反比桥高 3 m 以上”的 DEM/标注冲突不作约束。
// 隧道（t=1）：不渲染（roadY 返回 null）。未经 prepare 的要素（例如只加载了 traffic 模块）退回旧规则。
import { project, BOUNDS } from './geo.js';

export const LIFT = 0.25;
export const BRIDGE_UNIT = 6.5;
export const RAMP = 90; // 旧规则起坡长度（仅作未 prepare 时的回退）
export const MAX_GRADE = 0.045; // 引桥/匝道最大纵坡（规范 ≤5%，留余量给平滑）
export const CLEAR = 4.5; // 立交最小净空（米）
const RAMP_IN = 120; // 落地端向桥内的起坡距离（桥梁要素在 OSM 里通常从桥台起算，引道路堤另成一段）
const REFINE_DEV = 0.3; // 地面路节点加密阈值：段内地形偏离节点连线超过此值（米）就按 ~4 m 加密
const STEP_BRIDGE = 10, STEP_CORE = 16, STEP_FAR = 48;

/** 计算折线每个顶点的累计里程 */
export function chainage(p) {
  const n = p.length / 2;
  const s = new Float32Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  return s;
}

/** 梁高（与 roads.js 桥面剖面一致） */
export const deckDepth = (f) => ((Number(f.w) || 0) >= 12 ? 1.9 : 1.5);

let _terrain = null;

// 在有序数组 a 中找 a[i] <= v < a[i+1] 的 i
function seek(a, v) {
  let lo = 0, hi = a.length - 1;
  if (v <= a[0]) return 0;
  if (v >= a[hi]) return hi - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (a[m] <= v) lo = m; else hi = m;
  }
  return lo;
}

/** 已求纵断面的要素：里程 s 处路面高 */
function profY(rp, s) {
  const S = rp.s, Y = rp.y;
  if (S.length < 2) return Y[0];
  const i = seek(S, s);
  const L = S[i + 1] - S[i] || 1;
  const t = Math.min(1, Math.max(0, (s - S[i]) / L));
  return Y[i] + (Y[i + 1] - Y[i]) * t;
}

/** 折线 p 在里程 s 处的点 */
function pointOn(p, ch, s) {
  const i = seek(ch, s);
  const L = ch[i + 1] - ch[i] || 1;
  const t = Math.min(1, Math.max(0, (s - ch[i]) / L));
  return [p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t, p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t];
}

/** 旧规则抬升（未 prepare 时回退用） */
function legacyLift(feature, s, total) {
  if (!feature.b) return 0;
  const lift = BRIDGE_UNIT * Math.max(1, feature.y || 1);
  const ramp = Math.min(RAMP, total * 0.35);
  if (ramp <= 0) return lift;
  const k = Math.min(1, s / ramp, (total - s) / ramp);
  const t = Math.max(0, k);
  return lift * t * t * (3 - 2 * t);
}

/**
 * 路面相对“地面 + LIFT”的抬升量（米）。保留旧接口供 traffic 使用：terrain.heightAt(x,z) + LIFT + bridgeLift(...)
 * 已求纵断面时 = 纵断面高 − 中心线处地面 − LIFT（地面路一般为 0~0.3 m 的包络余量，桥/引桥为桥面抬升）。
 */
export function bridgeLift(feature, s, total) {
  const rp = feature._rp;
  if (rp && _terrain) {
    const [x, z] = pointOn(feature.p, rp.ch, s);
    return profY(rp, s) - _terrain.heightAt(x, z) - LIFT;
  }
  return legacyLift(feature, s, total);
}

/** 路面高度：terrain 为 ctx.terrain；隧道返回 null */
export function roadY(terrain, feature, x, z, s, total) {
  if (feature.t) return null;
  const rp = feature._rp;
  if (rp) return profY(rp, s);
  return terrain.heightAt(x, z) + LIFT + legacyLift(feature, s, total);
}

/**
 * 渲染断面步长函数：返回从 s 到下一个纵断面采样点的距离（不超过 maxStep），
 * 使路面网格的断面与纵断面节点重合（线性插值后仍不低于地形、桥面曲线不被粗采样削平）。
 */
export function profileStepFn(feature, maxStep) {
  const rp = feature._rp;
  if (!rp) return () => maxStep;
  const S = rp.s;
  return (s) => {
    let i = seek(S, s + 0.06);
    while (i < S.length - 1 && S[i] <= s + 0.06) i++;
    const d = S[i] - s;
    return d > 0.06 ? Math.min(maxStep, d) : maxStep;
  };
}

// ---------------- 最大堆（Dijkstra 最大值传播用） ----------------
class MaxHeap {
  constructor(cap = 1024) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  push(key, id) {
    if (this.n >= this.k.length) {
      const k = new Float64Array(this.k.length * 2), v = new Int32Array(this.k.length * 2);
      k.set(this.k); v.set(this.v);
      this.k = k; this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] >= key) break;
      K[i] = K[p]; V[i] = V[p];
      i = p;
    }
    K[i] = key; V[i] = id;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0], topK = K[0];
    const lk = K[--this.n], lv = V[this.n];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && K[c + 1] > K[c]) c++;
      if (K[c] <= lk) break;
      K[i] = K[c]; V[i] = V[c];
      i = c;
    }
    K[i] = lk; V[i] = lv;
    this.topK = topK;
    return top;
  }
}

/**
 * 在整张路网上求纵断面，结果写入每条要素 f._rp = {s, y, ch}（按里程的节点高程）。
 * 幂等：同一份 roads 与 terrain 只算一次。返回统计信息。
 */
export function prepareRoadProfiles(roads, terrain, opt = {}) {
  _terrain = terrain;
  if (!roads || !roads.features) return null;
  if (roads._rpTerrain === terrain && roads._rpStats) return roads._rpStats;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const feats = roads.features;
  const nF = feats.length;
  const pa = project(BOUNDS.CORE[0], BOUNDS.CORE[3]), pb = project(BOUNDS.CORE[2], BOUNDS.CORE[1]);
  const inCore = (x, z) => x > pa.x - 1500 && x < pb.x + 1500 && z > pa.z - 1500 && z < pb.z + 1500;
  const nodeKey = (x, z) => (Math.round(x * 10) + 700000) * 2000000 + (Math.round(z * 10) + 1000000);

  // ============ 1) 采样点与图 ============
  let cap = 1 << 18, nV = 0;
  let X = new Float64Array(cap), Z = new Float64Array(cap);
  const grow = () => {
    cap *= 2;
    const x2 = new Float64Array(cap), z2 = new Float64Array(cap);
    x2.set(X); z2.set(Z);
    X = x2; Z = z2;
  };
  const nodeId = new Map();
  const fIds = new Array(nF), fS = new Array(nF), fCh = new Array(nF);
  // 边：eA, eB, eL, eF（所属要素）
  let eCap = 1 << 18, nE = 0;
  let eA = new Int32Array(eCap), eB = new Int32Array(eCap), eL = new Float32Array(eCap), eF = new Int32Array(eCap);
  const addEdge = (a, b, l, fi) => {
    if (nE >= eCap) {
      eCap *= 2;
      const a2 = new Int32Array(eCap), b2 = new Int32Array(eCap), l2 = new Float32Array(eCap), f2 = new Int32Array(eCap);
      a2.set(eA); b2.set(eB); l2.set(eL); f2.set(eF);
      eA = a2; eB = b2; eL = l2; eF = f2;
    }
    eA[nE] = a; eB[nE] = b; eL[nE] = l; eF[nE] = fi; nE++;
  };
  let nRefined = 0;
  const newV = (x, z) => {
    if (nV >= cap) grow();
    X[nV] = x; Z[nV] = z;
    return nV++;
  };
  for (let fi = 0; fi < nF; fi++) {
    const f = feats[fi];
    const p = f.p;
    delete f._rp;
    if (!p || p.length < 4 || f.t) continue;
    const ch = chainage(p);
    const n = p.length / 2;
    const tot = ch[n - 1];
    if (!(tot > 0.01)) continue;
    const [mx, mz] = pointOn(p, ch, tot / 2);
    const core = inCore(mx, mz);
    // 核心区外的支路/街巷/步道不渲染（roads.js 同一规则），不参与求解（roadY 对其退回旧规则）
    if (!core && !f.b && (f.c === 5 || f.c === 6 || f.c === 7 || f.c === 12 || f.c === 13)) continue;
    const h = f.b ? STEP_BRIDGE : core ? STEP_CORE : STEP_FAR;
    const ids = [], ss = [];
    let prev = -1;
    for (let k = 0; k < n; k++) {
      const x = p[k * 2], z = p[k * 2 + 1];
      const key = nodeKey(x, z);
      let id = nodeId.get(key);
      if (id === undefined) { id = newV(x, z); nodeId.set(key, id); }
      if (k > 0) {
        const L = ch[k] - ch[k - 1];
        let m = Math.max(1, Math.ceil(L / h - 0.2));
        const x0 = p[k * 2 - 2], z0 = p[k * 2 - 1];
        // 核心区地面路：段内地形折得厉害（建筑平整区的羽化坡、DEM 坑）时把节点加密到 ~4 m，路面贴着地形走。
        // 否则下面“只补凸起”的包络会把坑底一端整体抬起 0.5~1 m（锦江酒店内院的小路成了悬空厚板、露出半截挡土墙）
        if (!f.b && core && L > 8) {
          const mf = Math.ceil(L / 4);
          if (mf > m) {
            const H = (t) => terrain.heightAt(x0 + (x - x0) * t, z0 + (z - z0) * t);
            const hc = new Float64Array(m + 1);
            for (let j = 0; j <= m; j++) hc[j] = H(j / m);
            let dev = 0;
            for (let j = 1; j < mf && dev <= REFINE_DEV; j++) {
              const tc = (j / mf) * m, j0 = Math.min(m - 1, Math.floor(tc)), tt = tc - j0;
              dev = Math.max(dev, Math.abs(H(j / mf) - (hc[j0] + (hc[j0 + 1] - hc[j0]) * tt)));
            }
            if (dev > REFINE_DEV) { m = mf; nRefined++; }
          }
        }
        for (let j = 1; j < m; j++) {
          const t = j / m;
          const v = newV(x0 + (x - x0) * t, z0 + (z - z0) * t);
          addEdge(prev, v, L / m, fi);
          ids.push(v); ss.push(ch[k - 1] + L * t);
          prev = v;
        }
        if (id !== prev) addEdge(prev, id, L / m, fi);
      }
      if (id !== prev || k === 0) { ids.push(id); ss.push(ch[k]); }
      else ss[ss.length - 1] = ch[k]; // 重复顶点：只保留一个节点
      prev = id;
    }
    fIds[fi] = Int32Array.from(ids);
    fS[fi] = Float32Array.from(ss);
    fCh[fi] = ch;
  }
  // CSR 邻接
  const deg = new Int32Array(nV + 1);
  for (let e = 0; e < nE; e++) { deg[eA[e]]++; deg[eB[e]]++; }
  const off = new Int32Array(nV + 1);
  for (let i = 0; i < nV; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Int32Array(off[nV]), adjE = new Int32Array(off[nV]);
  {
    const fill = off.slice(0, nV);
    for (let e = 0; e < nE; e++) {
      const a = eA[e], b = eB[e];
      adj[fill[a]] = b; adjE[fill[a]++] = e;
      adj[fill[b]] = a; adjE[fill[b]++] = e;
    }
  }

  // ============ 2) 地面与包络 ============
  const g = new Float32Array(nV), env = new Float32Array(nV);
  for (let i = 0; i < nV; i++) g[i] = terrain.heightAt(X[i], Z[i]);
  env.set(g);
  for (let e = 0; e < nE; e++) {
    if (feats[eF[e]].b) continue; // 桥面本就可以跨越地面起伏
    const a = eA[e], b = eB[e];
    // 段内按 ≤8 m 取点，求地面高出两端连线的最大量 δ；两端各抬 δ 后，断面间的线性插值处处不低于地面。
    // （只补凸起，不按窗口取最大值：斜坡上不会因此悬空）
    const m = Math.max(1, Math.ceil(eL[e] / 8));
    let d = 0;
    for (let j = 1; j < m; j++) {
      const t = j / m;
      const gm = terrain.heightAt(X[a] + (X[b] - X[a]) * t, Z[a] + (Z[b] - Z[a]) * t) - (g[a] + (g[b] - g[a]) * t);
      if (gm > d) d = gm;
    }
    if (g[a] + d > env[a]) env[a] = g[a] + d;
    if (g[b] + d > env[b]) env[b] = g[b] + d;
  }
  // 地面路：包络 + LIFT，只升不降的投影平滑（填平 DEM 的小凹坑，削掉高频波浪）
  const base = new Float32Array(nV);
  for (let i = 0; i < nV; i++) base[i] = env[i] + LIFT;
  const tmp = new Float32Array(nV);
  // 投影平滑：Y ← max(LB, Y 与邻点加权平均的中值)；list 为参与平滑的节点下标（缺省为全部）
  const smoothUp = (Y, LB, iters, list = null) => {
    const n = list ? list.length : nV;
    for (let it = 0; it < iters; it++) {
      if (list) for (let q = 0; q < n; q++) { const i = list[q]; tmp[i] = Y[i]; for (let o = off[i]; o < off[i + 1]; o++) tmp[adj[o]] = Y[adj[o]]; }
      else tmp.set(Y);
      for (let q = 0; q < n; q++) {
        const i = list ? list[q] : q;
        const o0 = off[i], o1 = off[i + 1];
        if (o1 === o0) continue;
        let sw = 0, sy = 0;
        for (let o = o0; o < o1; o++) {
          const w = 1 / Math.max(2, eL[adjE[o]]);
          sw += w; sy += w * tmp[adj[o]];
        }
        // 端点（度 1）只做弱平滑，避免把悬空端点拉低
        const k = o1 - o0 === 1 ? 0.25 : 0.5;
        const y = tmp[i] * (1 - k) + (sy / sw) * k;
        Y[i] = y > LB[i] ? y : LB[i];
      }
    }
  };
  const Yg = base.slice();
  smoothUp(Yg, base, 4);
  // 平滑只用于削掉小波浪：最多抬高 0.5 m（山区 V 形谷底不被“填平”而悬空）
  for (let i = 0; i < nV; i++) if (Yg[i] > base[i] + 0.5) Yg[i] = base[i] + 0.5;

  // ============ 3) 桥链：落地端距离与目标高度 ============
  const isB = new Uint8Array(nV); // 与桥梁边相连的节点
  const hasG = new Uint8Array(nV); // 与地面路边相连的节点
  for (let e = 0; e < nE; e++) {
    const f = feats[eF[e]];
    if (f.b) { isB[eA[e]] = 1; isB[eB[e]] = 1; } else { hasG[eA[e]] = 1; hasG[eB[e]] = 1; }
  }
  // 桥链连通分量（并查集）与总长、最大层
  const par = new Int32Array(nV);
  for (let i = 0; i < nV; i++) par[i] = i;
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let e = 0; e < nE; e++) if (feats[eF[e]].b) { const ra = find(eA[e]), rb = find(eB[e]); if (ra !== rb) par[ra] = rb; }
  const compLen = new Map(), compY = new Map();
  for (let e = 0; e < nE; e++) {
    const f = feats[eF[e]];
    if (!f.b) continue;
    const r = find(eA[e]);
    compLen.set(r, (compLen.get(r) || 0) + eL[e]);
    compY.set(r, Math.max(compY.get(r) || 0, f.y || 1));
  }
  // 节点抬升层高：取相连桥要素的最大值；短小单层桥链只拱起 1.2 m（河沟、涵洞桥）
  const liftN = new Float32Array(nV);
  for (let e = 0; e < nE; e++) {
    const f = feats[eF[e]];
    if (!f.b) continue;
    const r = find(eA[e]);
    const small = compLen.get(r) < 60 && compY.get(r) <= 1;
    const L = small ? 1.2 : BRIDGE_UNIT * Math.max(1, f.y || 1);
    if (L > liftN[eA[e]]) liftN[eA[e]] = L;
    if (L > liftN[eB[e]]) liftN[eB[e]] = L;
  }
  // 落地端：桥要素端点且接地面路，或是整张图上的断头。沿桥梁边做多源 Dijkstra 得到每个桥节点到最近落地端的距离。
  const isExit = new Uint8Array(nV);
  const dist = new Float32Array(nV).fill(Infinity);
  const bEdge = (e) => feats[eF[e]].b;
  {
    const heap = new MaxHeap(4096);
    for (let fi = 0; fi < nF; fi++) {
      const f = feats[fi];
      if (!f.b || !fIds[fi]) continue;
      const ids = fIds[fi];
      for (const v of [ids[0], ids[ids.length - 1]]) {
        if ((hasG[v] || off[v + 1] - off[v] <= 1) && !isExit[v]) { isExit[v] = 1; dist[v] = 0; heap.push(0, v); }
      }
    }
    // 只沿桥梁边传播（以负距离作最大堆键）
    while (heap.n) {
      const v = heap.pop();
      const d0 = -heap.topK;
      if (d0 > dist[v] + 1e-4) continue;
      for (let o = off[v]; o < off[v + 1]; o++) {
        const e = adjE[o];
        if (!bEdge(e)) continue;
        const u = adj[o], d = d0 + eL[e];
        if (d < dist[u] - 1e-4) { dist[u] = d; heap.push(-d, u); }
      }
    }
  }
  // 桥下参考地面 gb：以落地端（及接地面路的桥节点）的地面路高程为边界值，在桥梁子图上求调和插值
  // （单条桥链上即两端按里程线性连线；立交桥网上是连续光滑的插值），不随桥下 DEM 起伏：
  // DEM（~36 m 分辨率）常把桥下的沟谷/路堑抹成“山包”或把河谷抹宽，桥面跟随它就会出现驼峰/下沉，
  // 甚至整座桥连同引道被抬到几十米高空。
  // 求解：把度为 2 的桥节点压缩成链，只在关键节点（落地端/分岔点）上做 Gauss-Seidel，链内按里程线性插值。
  const gb = new Float32Array(nV);
  for (let i = 0; i < nV; i++) gb[i] = hasG[i] ? Yg[i] - LIFT : g[i];
  {
    const bdeg = new Int32Array(nV);
    for (let e = 0; e < nE; e++) if (bEdge(e)) { bdeg[eA[e]]++; bdeg[eB[e]]++; }
    const fixed = (v) => hasG[v] || isExit[v];
    const isKey = new Uint8Array(nV);
    for (let i = 0; i < nV; i++) if (isB[i] && (fixed(i) || bdeg[i] !== 2)) isKey[i] = 1;
    // 纯环（无关键节点的闭合桥链）：取其中一点作关键节点
    const seenE = new Uint8Array(nE);
    const chains = []; // {a, b, verts:[], ds:[], L}
    const walk = (k, o0) => {
      let e = adjE[o0], prev = k, v = adj[o0];
      if (seenE[e]) return;
      const verts = [], ds = [];
      let L = 0;
      seenE[e] = 1;
      L += eL[e];
      while (!isKey[v]) {
        verts.push(v); ds.push(L);
        let nxt = -1;
        for (let o = off[v]; o < off[v + 1]; o++) {
          const e2 = adjE[o];
          if (!bEdge(e2) || e2 === e) continue;
          nxt = o;
          break;
        }
        if (nxt < 0) { isKey[v] = 1; break; }
        e = adjE[nxt];
        if (seenE[e]) { isKey[v] = 1; break; }
        seenE[e] = 1;
        prev = v;
        v = adj[nxt];
        L += eL[e];
      }
      chains.push({ a: k, b: v, verts, ds, L });
    };
    for (let i = 0; i < nV; i++) {
      if (!isKey[i]) continue;
      for (let o = off[i]; o < off[i + 1]; o++) if (bEdge(adjE[o])) walk(i, o);
    }
    for (let i = 0; i < nV; i++) {
      if (!isB[i] || isKey[i]) continue;
      // 仍未访问的纯环
      let any = false;
      for (let o = off[i]; o < off[i + 1]; o++) if (bEdge(adjE[o]) && !seenE[adjE[o]]) any = true;
      if (!any) continue;
      isKey[i] = 1;
      for (let o = off[i]; o < off[i + 1]; o++) if (bEdge(adjE[o])) walk(i, o);
    }
    // 关键节点邻接（压缩图）
    const kAdj = new Map();
    const link = (a, b, L) => {
      if (a === b) return;
      if (!kAdj.has(a)) kAdj.set(a, []);
      kAdj.get(a).push(b, 1 / Math.max(1, L));
    };
    for (const c of chains) { link(c.a, c.b, c.L); link(c.b, c.a, c.L); }
    const keys = [...kAdj.keys()].filter((k) => !fixed(k));
    for (let it = 0; it < 400; it++) {
      let delta = 0;
      for (const k of keys) {
        const a = kAdj.get(k);
        let sw = 0, sy = 0;
        for (let q = 0; q < a.length; q += 2) { sw += a[q + 1]; sy += a[q + 1] * gb[a[q]]; }
        const y = sy / sw;
        delta = Math.max(delta, Math.abs(y - gb[k]));
        gb[k] = y;
      }
      if (delta < 0.01) break;
    }
    for (const c of chains) {
      const ya = gb[c.a], yb = gb[c.b];
      for (let q = 0; q < c.verts.length; q++) gb[c.verts[q]] = ya + ((yb - ya) * c.ds[q]) / (c.L || 1);
    }
  }
  for (let i = 0; i < nV; i++) if (isB[i] && !hasG[i]) Yg[i] = gb[i] + LIFT;
  // 桥面目标抬升（相对参考面 Yg：地面路为包络地面 + LIFT，纯桥节点为两端连线 + LIFT）
  const target = new Float32Array(nV);
  for (let i = 0; i < nV; i++) {
    if (!isB[i]) continue;
    const d = dist[i];
    const k = d === Infinity ? 1 : Math.min(1, d / RAMP_IN);
    target[i] = liftN[i] * k * k * (3 - 2 * k);
  }

  // ============ 4) 坡度约束传播 + 5) 竖曲线平滑（均在“抬升量”空间：Y = Yg + A） ============
  // 抬升量沿路每米至多减少 G：平原上即绝对坡度 ≤ G；山区道路随地形起伏而引桥/路堤长度仍为 抬升/G，
  // 不会从坡顶拉出几十米高的“空中路堤”。
  const G = opt.maxGrade || MAX_GRADE;
  const cone = (src, out) => coneG(src, out, G);
  const coneG = (src, out, G) => {
    // out = max_j (src_j − G·d_ij)，d 为图上最短路（最大堆 Dijkstra，键单调不增）
    out.set(src);
    const heap = new MaxHeap(1 << 16);
    for (let i = 0; i < nV; i++) if (src[i] > 1e-3) heap.push(src[i], i);
    while (heap.n) {
      const v = heap.pop();
      const y = heap.topK;
      if (y < out[v] - 1e-4) continue;
      for (let o = off[v]; o < off[v + 1]; o++) {
        const u = adj[o], c = y - G * eL[adjE[o]];
        if (c > out[u] + 1e-3) { out[u] = c; heap.push(c, u); }
      }
    }
  };
  const hard = new Float32Array(nV); // 净空硬约束（抬升量）
  const A = new Float32Array(nV), LB = new Float32Array(nV), srcH = new Float32Array(nV);
  const Y = new Float32Array(nV);
  const mark = new Uint8Array(nV);
  const solve = (iters) => {
    // 软目标（桥面）与硬约束合并传播
    for (let i = 0; i < nV; i++) srcH[i] = Math.max(target[i], hard[i]);
    cone(srcH, A);
    // 硬约束自身的坡度锥作为平滑下限：用 2G 的陡锥（始终不高于上面的 G 锥），
    // 净空平台处被托住，平台外留出把折角磨圆成竖曲线的余地
    coneG(hard, LB, G * 2);
    // 平滑范围：被抬高的节点外扩两圈（顺接处也要圆顺）
    mark.fill(0);
    let list = [];
    for (let i = 0; i < nV; i++) if (A[i] > 0.02) { mark[i] = 1; list.push(i); }
    for (let r = 0; r < 2; r++) {
      const add = [];
      for (const i of list) for (let o = off[i]; o < off[i + 1]; o++) if (!mark[adj[o]]) { mark[adj[o]] = 1; add.push(adj[o]); }
      list = list.concat(add);
    }
    smoothUp(A, LB, iters, Int32Array.from(list));
    for (let i = 0; i < nV; i++) Y[i] = Yg[i] + A[i];
  };

  // ============ 6) 立交净空 ============
  // 两要素在交叉点 60 m 内有共享节点：分合流区的线形交错，不按上下层处理
  const nearShared = (i, j, x, z) => {
    const A = fIds[i], B = new Set(fIds[j]);
    for (let k = 0; k < A.length; k++) if (B.has(A[k]) && Math.hypot(X[A[k]] - x, Z[A[k]] - z) < 60) return true;
    return false;
  };
  // 交叉点：以桥梁线段建网格，查询所有要素线段
  const crossings = [];
  {
    const CELL = 120;
    const grid = new Map();
    const gk = (cx, cz) => cx * 1000003 + cz;
    const segBox = (p, k) => [Math.min(p[k * 2], p[k * 2 + 2]), Math.max(p[k * 2], p[k * 2 + 2]), Math.min(p[k * 2 + 1], p[k * 2 + 3]), Math.max(p[k * 2 + 1], p[k * 2 + 3])];
    for (let fi = 0; fi < nF; fi++) {
      const f = feats[fi];
      if (!f.b || !fIds[fi]) continue;
      const n = f.p.length / 2;
      for (let k = 0; k + 1 < n; k++) {
        const [x0, x1, z0, z1] = segBox(f.p, k);
        if (x1 - x0 > 30000 || z1 - z0 > 30000) continue;
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
          for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
            let a = grid.get(gk(cx, cz));
            if (!a) grid.set(gk(cx, cz), (a = []));
            a.push(fi, k);
          }
      }
    }
    const seen = new Set();
    for (let fj = 0; fj < nF; fj++) {
      const fb = feats[fj];
      if (!fIds[fj]) continue;
      const q = fb.p, n = q.length / 2;
      for (let kb = 0; kb + 1 < n; kb++) {
        const [x0, x1, z0, z1] = segBox(q, kb);
        if (x1 - x0 > 30000 || z1 - z0 > 30000) continue;
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
          for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
            const a = grid.get(gk(cx, cz));
            if (!a) continue;
            for (let t = 0; t < a.length; t += 2) {
              const fi = a[t], ka = a[t + 1];
              if (fi === fj) continue;
              if (feats[fj].b && fj < fi) continue; // 桥-桥只算一次
              const p = feats[fi].p;
              const ax = p[ka * 2], az = p[ka * 2 + 1], rx = p[ka * 2 + 2] - ax, rz = p[ka * 2 + 3] - az;
              const bx = q[kb * 2], bz = q[kb * 2 + 1], sx = q[kb * 2 + 2] - bx, sz = q[kb * 2 + 3] - bz;
              const den = rx * sz - rz * sx;
              if (Math.abs(den) < 1e-9) continue;
              const wx = bx - ax, wz = bz - az;
              const tt = (wx * sz - wz * sx) / den, uu = (wx * rz - wz * rx) / den;
              if (tt <= 1e-6 || tt >= 1 - 1e-6 || uu <= 1e-6 || uu >= 1 - 1e-6) continue;
              const key = fi + ':' + ka + ':' + fj + ':' + kb;
              if (seen.has(key)) continue;
              seen.add(key);
              const chA = fCh[fi], chB = fCh[fj];
              if (nearShared(fi, fj, ax + rx * tt, az + rz * tt)) continue;
              crossings.push(fi, chA[ka] + (chA[ka + 1] - chA[ka]) * tt, fj, chB[kb] + (chB[kb + 1] - chB[kb]) * uu);
            }
          }
      }
    }
  }
  // 里程 s 处的两端节点与权重
  const nodesAt = (fi, s) => {
    const S = fS[fi];
    const i = seek(S, s);
    const L = S[i + 1] - S[i] || 1;
    return [fIds[fi][i], fIds[fi][i + 1], Math.min(1, Math.max(0, (s - S[i]) / L))];
  };
  const yAt = (fi, s) => {
    const [a, b, t] = nodesAt(fi, s);
    return Y[a] + (Y[b] - Y[a]) * t;
  };
  const layerOf = (f) => (f.b ? Math.max(1, f.y || 1) : Math.min(0, f.y || 0));
  // 上下层在路网上 170 m 内相连（楼梯/坡道/人行天桥与其下的步道等）：按 ≤G 的坡度不可能拉开 CLEAR+梁高，
  // 强行抬高只会让上层与相连的下层一起被越抬越高，此类交叉不作约束
  const coupled = (up, su, lo, sl) => {
    const [a, b] = nodesAt(up, su), [c, d] = nodesAt(lo, sl);
    const LIM = (CLEAR + 2) / G;
    const seen = new Map([[a, 0], [b, 0]]);
    const heap = new MaxHeap(64);
    heap.push(0, a); heap.push(0, b);
    while (heap.n) {
      const v = heap.pop(), d0 = -heap.topK;
      if (v === c || v === d) return true;
      if (d0 > seen.get(v) + 1e-4) continue;
      for (let o = off[v]; o < off[v + 1]; o++) {
        const u = adj[o], dd = d0 + eL[adjE[o]];
        if (dd > LIM) continue;
        const prev = seen.get(u);
        if (prev === undefined || dd < prev - 1e-4) { seen.set(u, dd); heap.push(-dd, u); }
      }
    }
    return false;
  };
  const skipX = new Uint8Array(crossings.length / 4);
  let nCoupled = 0;
  // 按上层的层号由低到高逐层处理（先 y=1 跨地面路，再 y=2 跨 y=1……），每层只求解一次：
  // 下层高程取上一层处理后的结果。不做全局反复迭代——在密集立交网里，抬高上层会经匝道把相连的下层也抬起，
  // 反复迭代会形成“越抬越高”的正反馈（曾把南三环一带的道路推到 50 m 高空）。
  let rounds = 0, viol = 0;
  let nConflict = 0;
  const nX = crossings.length / 4;
  const upL = new Int8Array(nX);
  solve(15);
  for (let q = 0; q < nX; q++) {
    const c = q * 4;
    const i = crossings[c], j = crossings[c + 2];
    upL[q] = Math.max(layerOf(feats[i]), layerOf(feats[j]));
  }
  for (let L = 1, rep = 0; L <= 5; ) {
    let any = 0;
    for (let q = 0; q < nX; q++) {
      if (upL[q] !== L || skipX[q]) continue;
      const c = q * 4;
      const i = crossings[c], si = crossings[c + 1], j = crossings[c + 2], sj = crossings[c + 3];
      const fi = feats[i], fj = feats[j];
      const li = layerOf(fi), lj = layerOf(fj);
      const yi = yAt(i, si), yj = yAt(j, sj);
      let up, su, yl;
      if (li !== lj) {
        [up, su, yl] = li > lj ? [i, si, yj] : [j, sj, yi];
        // 下层是地面路却比上层桥面高出 3 m 以上：DEM 与层标注冲突（多为路堑中的高速被标成桥、
        // 或跨线桥被标成地面路），强行抬高上层会把整段高速顶到空中，按现状处理
        if (!feats[up === i ? j : i].b && yl > (up === i ? yi : yj) + 3) { skipX[q] = 1; nConflict++; continue; }
      } else {
        // 同层交叉：高差 <1 m 视为数据中的平交/合流，不强制；否则较高者为上层
        if (Math.abs(yi - yj) < 1) continue;
        [up, su, yl] = yi > yj ? [i, si, yj] : [j, sj, yi];
      }
      const need = yl + CLEAR + deckDepth(feats[up]) + 0.2;
      const yu = up === i ? yi : yj;
      if (yu >= need - 0.05) continue;
      if (up === i ? coupled(i, si, j, sj) : coupled(j, sj, i, si)) { skipX[q] = 1; nCoupled++; continue; }
      any++;
      // 约束施加在上层交叉点前后“下层半宽 + 8 m”范围内的节点上（桥面在下层上方有一段平台，竖曲线在平台外过渡）
      const half = (Number(feats[up === i ? j : i].w) || 8) / 2 + 8;
      const S = fS[up], ids = fIds[up];
      for (let k = seek(S, su - half), n = S.length; k < n && S[k] <= su + half + (S[k + 1] - S[k] || 0); k++) {
        const v = ids[k];
        if (need - Yg[v] > hard[v]) hard[v] = need - Yg[v];
      }
    }
    if (any) { solve(15); rounds++; }
    // 同一层内的约束是同时施加的：下层若在本轮被其他约束抬高（如夹在两段高架之间的“地面”路段），
    // 需再复核一次；每层至多 3 次，避免正反馈
    if (any && ++rep < 3) continue;
    L++;
    rep = 0;
  }
  solve(60);
  // 最终平滑后复核一次净空
  viol = 0;
  for (let c = 0; c < crossings.length; c += 4) {
    if (skipX[c >> 2]) continue;
    const i = crossings[c], si = crossings[c + 1], j = crossings[c + 2], sj = crossings[c + 3];
    const li = layerOf(feats[i]), lj = layerOf(feats[j]);
    const yi = yAt(i, si), yj = yAt(j, sj);
    if (li === lj && Math.abs(yi - yj) < 1) continue;
    const upI = li !== lj ? li > lj : yi > yj;
    const need = (upI ? yj : yi) + CLEAR + deckDepth(feats[upI ? i : j]);
    if ((upI ? yi : yj) < need - 0.05) viol++;
  }

  // ============ 输出 ============
  let nProf = 0;
  for (let fi = 0; fi < nF; fi++) {
    if (!fIds[fi]) continue;
    const ids = fIds[fi];
    const y = new Float32Array(ids.length);
    for (let k = 0; k < ids.length; k++) y[k] = Y[ids[k]];
    feats[fi]._rp = { s: fS[fi], y, ch: fCh[fi] };
    nProf++;
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const stats = { features: nProf, vertices: nV, edges: nE, refined: nRefined, crossings: crossings.length / 4, rounds: rounds + 1, residual: viol, coupled: nCoupled, conflict: nConflict, ms: Math.round(ms) };
  Object.defineProperty(roads, '_rpTerrain', { value: terrain, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(roads, '_rpStats', { value: stats, writable: true, configurable: true, enumerable: false });
  return stats;
}
