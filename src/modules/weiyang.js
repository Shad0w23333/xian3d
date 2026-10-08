// 未央城市广场（原张家堡环岛，未央路 × 凤城八路）：2026-02-08 投用。
//
// 现状（新闻报道，见文末出处）：
//   · “环岛变十字”：原环岛改十字路口，人车分离；原环岛公园挪到道路两侧（西侧并入城市运动公园）。
//   · 四个象限各一座下沉庭院，俯看“像四只蝴蝶”，波浪形台阶；与地铁 2/4 号线行政中心站连通，
//     22 个地铁/市政出入口整合为 18 个，地下封闭通行 200 m → 80 m。
//   · 西北：双层商业 + 集中绿地；西南：水景 + 台阶步道；东南：檐下避雨、林中步道、休憩座椅、预留商业；
//     东北：一坡到底的绿地 + 出挑商业（绿意中的地铁入口）。
// 影像：离线谷歌影像是施工期（凤城八路已从中间穿心通车、未央路直行段在施工），Esri / Bing 是改造前，
//   找不到竣工后的影像，所以路口按施工期影像的十字位置、庭院按报道描述估计（尺寸、形状为示意）。
//
// 做法：
//   prepare（模块表里排第一，先于所有模块）：
//     · 就地改 ctx.data.roads：删环岛与四个喇叭口连接线，未央路 / 凤城八路接成直行十字
//       （道路、车流、行人、行道树、路名、通用建筑避让都用同一份数据，随之更新）；
//     · 用地：环岛公园换成整块广场公园（植被模块在草坪上种树）；
//     · 排除区：通用建筑 / 兴趣点 / 其他下沉广场让位；坑口、环坑步道、园路不种树；
//     · 地形压平 + 坑口挖洞（坑内由本模块几何补齐）。
//   build：地面铺装与草坪（按符号距离场裁剪的 2 m 网格，边缘埋进人行道下）、四座蝴蝶形下沉庭院
//     （波浪台阶 / 水阶 / 草坡 / 商铺墙 / 地铁通道口）、压顶与玻璃栏杆、檐廊、出挑商业、地面商业、
//     玻璃电梯、扶梯、地铁出入口亭、花带、灯杆与台阶灯带。
import * as THREE from 'three';
import * as G from '../arch/sky-geom.js';
import { grain, text as textTex } from '../core/textures.js';

const NAME = '未央城市广场';
const D2R = Math.PI / 180;
const MOTOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'unclassified',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
// 与 src/arch/roads_net.js CFG 一致：最小路宽、人行道宽
const MIN_W = { motorway: 7.5, trunk: 7, primary: 7, secondary: 6.5, tertiary: 6, residential: 5, service: 3.5, unclassified: 5, motorway_link: 4.5, trunk_link: 4.5, primary_link: 4.5, secondary_link: 4 };
const SW_W = { trunk: 4.5, primary: 5, secondary: 4, tertiary: 3 };
const roadHW = (f, c) => {
  let W = +f.w || MIN_W[c] || 5;
  W = Math.max(W, MIN_W[c] || 5, Math.max(1, Math.min(8, f.l | 0 || 1)) * (c === 'motorway' || c === 'trunk' || c === 'primary' ? 3.4 : 3.1));
  return Math.min(W, 42) / 2;
};

// 原环岛四个喇叭口连接线（起点、终点）：删掉；其远端就是新直行段要接的端点
const LINKS = [
  { a: [-41.6, -8929], b: [10.4, -8863], keep: 'b', role: 'sbEnd' }, // 未央路南段南行（接 5395 起点）
  { a: [37.9, -8868.4], b: [94.2, -8938.4], keep: 'a', role: 'nbStart' }, // 未央路南段北行（接 5394 终点）
  { a: [262.1, -9087.8], b: [171.7, -9147.5], keep: 'a', role: 'wbStart' }, // 凤城八路东段西行
  { a: [174, -9019.3], b: [263.2, -9076.6], keep: 'b', role: 'ebEnd' }, // 凤城八路东段东行
];
const TRIM_R = 50; // 接环岛的路段：端点离环岛 < 50 m 的顶点删掉，由新线形接上（喇叭口一并抹掉）

const near = (x, z, X, Z, t = 3) => Math.abs(x - X) < t && Math.abs(z - Z) < t;
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
function polyDist(x, z, p, closed = true) {
  let d = Infinity;
  const n = p.length / 2, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % n;
    d = Math.min(d, segDist(x, z, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]));
  }
  return d;
}
/** 带符号距离：多边形内为正 */
const sdPoly = (x, z, p) => (G.pointIn(x, z, p) ? 1 : -1) * polyDist(x, z, p);
function bezier(P0, P1, P2, P3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0],
      u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1]]);
  }
  return out;
}
function straight(A, B, step = 20) {
  const n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) / step)), out = [];
  for (let i = 0; i <= n; i++) out.push([A[0] + ((B[0] - A[0]) * i) / n, A[1] + ((B[1] - A[1]) * i) / n]);
  return out;
}
const r1 = (v) => Math.round(v * 10) / 10;
const flatPts = (pts) => pts.flatMap(([x, z]) => [r1(x), r1(z)]);
/** 两条折线的交点（第一个），返回 [x, z, ia, ib]（ia/ib：所在线段下标） */
function crossing(a, b) {
  for (let i = 0; i + 1 < a.length; i++)
    for (let j = 0; j + 1 < b.length; j++) {
      const [ax, az] = a[i], [bx, bz] = a[i + 1], [cx, cz] = b[j], [dx, dz] = b[j + 1];
      const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
      const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [ax + (bx - ax) * t, az + (bz - az) * t, i, j];
    }
  return null;
}

/**
 * 路网改造：删环岛 + 喇叭口，接直行十字。返回 { ring, removed:[折线], added:[折线], cx, cz } 或 null（数据对不上时不动）。
 */
function patchRoads(roads) {
  if (!roads?.features?.length) return null;
  const F = roads.features, cls = roads.classes || [];
  const ringIdx = F.findIndex((f) => f.n === '张家堡环岛');
  if (ringIdx < 0) {
    console.warn('[weiyang] 路网里没有“张家堡环岛”（数据已更新？），跳过路口改造');
    return null;
  }
  const ring = G.ccw(Array.from(F[ringIdx].p).slice(0, -2)); // 闭合环：去掉重复的末点
  const onRing = (x, z) => { for (let i = 0; i < ring.length; i += 2) if (near(x, z, ring[i], ring[i + 1], 0.6)) return true; return false; };
  const ringD = (x, z) => (G.pointIn(x, z, ring) ? 0 : polyDist(x, z, ring));
  const drop = new Set([ringIdx]);
  const removed = [Array.from(F[ringIdx].p)];
  const ends = {};
  F.forEach((f, i) => {
    if (drop.has(i) || !f.p || f.p.length < 4) return;
    const n = f.p.length;
    for (const L of LINKS)
      if (near(f.p[0], f.p[1], L.a[0], L.a[1]) && near(f.p[n - 2], f.p[n - 1], L.b[0], L.b[1])) {
        drop.add(i);
        removed.push(Array.from(f.p));
        ends[L.role] = L.keep === 'a' ? [f.p[0], f.p[1]] : [f.p[n - 2], f.p[n - 1]];
      }
  });
  // 接环岛的四条路：裁掉近环岛顶点
  const trimmed = {};
  F.forEach((f, i) => {
    if (drop.has(i) || !f.p || f.p.length < 4) return;
    const p = Array.from(f.p), n = p.length;
    const atHead = onRing(p[0], p[1]), atTail = onRing(p[n - 2], p[n - 1]);
    if (!atHead && !atTail) return;
    const cut = [];
    if (atHead) {
      while (p.length > 4 && ringD(p[0], p[1]) < TRIM_R) cut.push(p.shift(), p.shift());
      cut.push(p[0], p[1]);
    } else {
      while (p.length > 4 && ringD(p[p.length - 2], p[p.length - 1]) < TRIM_R) cut.unshift(...p.splice(-2, 2));
      cut.unshift(p[p.length - 2], p[p.length - 1]);
    }
    removed.push(cut);
    f.p = p;
    const name = f.n || '';
    const key = (name === '未央路' ? 'wy' : name === '凤城八路' ? 'fc' : 'x') + (atHead ? 'H' : 'T');
    trimmed[key] = { f, x: atHead ? p[0] : p[p.length - 2], z: atHead ? p[1] : p[p.length - 1], prev: atHead ? [p[2], p[3]] : [p[p.length - 4], p[p.length - 3]] };
  });
  // 未央路北段：南行（尾接环岛）、北行（头接环岛）；凤城八路西段：西行（头接环岛）、东行（尾接环岛）
  const need = [ends.sbEnd, ends.nbStart, ends.wbStart, ends.ebEnd, trimmed.wyT, trimmed.wyH, trimmed.fcH, trimmed.fcT];
  if (need.some((v) => !v)) {
    console.warn('[weiyang] 环岛接入路段与预期不符，跳过路口改造', Object.keys(ends), Object.keys(trimmed));
    return null;
  }
  const ci = (id) => Math.max(0, cls.indexOf(id));
  const base = { b: 0, t: 0, y: 0, o: 1 };
  const wyAttr = { ...base, c: ci('primary'), n: '未央路', w: 15, l: 4 };
  const fcAttr = { ...base, c: ci('secondary'), n: '凤城八路', w: 11.3, l: 3 };
  // 未央路直行段 x：南段两幅路的走向往北延长到 z=-9150，再用 S 弯接北段（北段两幅路中间是市政府前广场，相距 ~136 m）
  const SB0 = [trimmed.wyT.x, trimmed.wyT.z], NB1 = [trimmed.wyH.x, trimmed.wyH.z];
  const sbE = ends.sbEnd, nbS = ends.nbStart;
  const ZS = -9150;
  const sbX = sbE[0] - 0.0165 * (sbE[1] - ZS); // 5395 的走向（每米 0.0165）
  const nbX = nbS[0] + 0.3;
  const SB = [...bezier(SB0, [SB0[0], SB0[1] + 75], [sbX, ZS - 75], [sbX, ZS], 18), ...straight([sbX, ZS], sbE).slice(1)];
  const NB = [...straight(nbS, [nbX, ZS]), ...bezier([nbX, ZS], [nbX, ZS - 75], [NB1[0], NB1[1] + 75], NB1, 18).slice(1)];
  const WB = straight(ends.wbStart, [trimmed.fcH.x, trimmed.fcH.z]);
  const EB = straight([trimmed.fcT.x, trimmed.fcT.z], ends.ebEnd);
  // 路口：在交点处给两条线插入同一个顶点（车流图与路口分析按共享顶点连通）
  const lines = { SB, NB, WB, EB };
  for (const [a, b] of [['SB', 'WB'], ['SB', 'EB'], ['NB', 'WB'], ['NB', 'EB']]) {
    const X = crossing(lines[a], lines[b]);
    if (!X) continue;
    const P = [r1(X[0]), r1(X[1])];
    lines[a].splice(X[2] + 1, 0, P);
    lines[b].splice(X[3] + 1, 0, P);
  }
  const added = [
    { ...wyAttr, p: flatPts(lines.SB) }, { ...wyAttr, p: flatPts(lines.NB) },
    { ...fcAttr, p: flatPts(lines.WB) }, { ...fcAttr, p: flatPts(lines.EB) },
  ];
  // 端点必须与原路段端点完全一致（车流/路网按坐标连通）
  added[0].p[0] = SB0[0]; added[0].p[1] = SB0[1];
  added[0].p[added[0].p.length - 2] = sbE[0]; added[0].p[added[0].p.length - 1] = sbE[1];
  added[1].p[0] = nbS[0]; added[1].p[1] = nbS[1];
  added[1].p[added[1].p.length - 2] = NB1[0]; added[1].p[added[1].p.length - 1] = NB1[1];
  added[2].p[0] = ends.wbStart[0]; added[2].p[1] = ends.wbStart[1];
  added[2].p[added[2].p.length - 2] = trimmed.fcH.x; added[2].p[added[2].p.length - 1] = trimmed.fcH.z;
  added[3].p[0] = trimmed.fcT.x; added[3].p[1] = trimmed.fcT.z;
  added[3].p[added[3].p.length - 2] = ends.ebEnd[0]; added[3].p[added[3].p.length - 1] = ends.ebEnd[1];
  roads.features = F.filter((_, i) => !drop.has(i)).concat(added);
  // 路口中心：四个交点的平均
  const xs = [];
  for (const [a, b] of [['SB', 'WB'], ['SB', 'EB'], ['NB', 'WB'], ['NB', 'EB']]) {
    const X = crossing(lines[a], lines[b]);
    if (X) xs.push(X);
  }
  const cx = xs.length ? xs.reduce((s, v) => s + v[0], 0) / xs.length : 23;
  const cz = xs.length ? xs.reduce((s, v) => s + v[1], 0) / xs.length : -9078;
  console.warn(`[weiyang] 张家堡环岛改十字：删 ${drop.size} 段、裁 ${Object.keys(trimmed).length} 段、新增 4 段，路口中心 (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
  return { ring, removed, added: added.map((f) => Array.from(f.p)), cx, cz, cls };
}

// ───────────────────────── 几何写入器 ─────────────────────────
class W {
  constructor() { this.p = []; this.c = []; this.uv = []; }
  tri(a, b, c, ca, cb = ca, cc = ca, up = false, S = 3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (up && ny < 0) { [b, c] = [c, b]; [cb, cc] = [cc, cb]; nx = -nx; ny = -ny; nz = -nz; }
    const nl = Math.hypot(nx, ny, nz) || 1;
    const horiz = Math.abs(ny / nl) > 0.6;
    const tx = -nz / nl, tz = nx / nl;
    for (const [v, col] of [[a, ca], [b, cb], [c, cc]]) {
      this.p.push(v[0], v[1], v[2]);
      this.c.push(col.r, col.g, col.b);
      if (horiz) this.uv.push(v[0] / S, v[2] / S);
      else this.uv.push((v[0] * tx + v[2] * tz) / S, v[1] / S);
    }
  }
  quad(a, b, c, d, col, S) { this.tri(a, b, c, col, col, col, false, S); this.tri(a, c, d, col, col, col, false, S); }
  /** 轴对齐/旋转的盒子：中心 (x,z)、底 y0 顶 y1、尺寸 w(沿 yaw 方向) × d、yaw 弧度 */
  box(x, z, y0, y1, w, d, yaw, col, top = col) {
    const c = Math.cos(yaw), s = Math.sin(yaw), hw = w / 2, hd = d / 2;
    const P = (u, v, y) => [x + u * c - v * s, y, z + u * s + v * c];
    const a = P(-hw, -hd, y0), b = P(hw, -hd, y0), cc = P(hw, hd, y0), dd = P(-hw, hd, y0);
    const e = P(-hw, -hd, y1), f = P(hw, -hd, y1), g = P(hw, hd, y1), h = P(-hw, hd, y1);
    this.quad(e, f, g, h, top);
    this.quad(a, b, f, e, col); this.quad(b, cc, g, f, col); this.quad(cc, dd, h, g, col); this.quad(dd, a, e, h, col);
  }
  cyl(x, z, y0, y1, r, seg, col) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = [x + Math.cos(a0) * r, z + Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, z + Math.sin(a1) * r];
      this.quad([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]], col);
      this.tri([x, y1, z], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]], col);
    }
  }
  mesh(mat, name, { shadow = true, cast = true } = {}) {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.receiveShadow = shadow;
    m.castShadow = cast;
    return m;
  }
}
const col = (h) => new THREE.Color(h);
const hash = (x, z, s = 0) => { const v = Math.sin(x * 12.9898 + z * 78.233 + s * 37.719) * 43758.5453; return v - Math.floor(v); };

// ───────────────────────── 下沉庭院 ─────────────────────────
// 角度 φ 以 u 轴（从路口中心指向庭院中心）为 0；外侧两翼大、内侧两翼小，中轴两端与两侧有收腰（蝴蝶）
const NA = 144;
const butterflyR = (R0, phi) => R0 * (0.84 - 0.16 * Math.cos(4 * phi)) * (1 + 0.1 * Math.cos(phi));
const NS = 12; // 波浪台阶级数
const STYLES = {
  // 西北：双层商业（坑底商铺 + 地面商业廊）+ 集中绿地；外侧是波浪台阶看台
  NW: { label: '西北庭院', sectors: [{ t: 'steps', a: -80, b: 80 }], pavilion: [112, 248], escal: [0], lift: 140 },
  // 西南：水景 + 台阶步道（中间一道叠水，两侧台阶）
  SW: { label: '西南庭院', sectors: [{ t: 'steps', a: -100, b: -24 }, { t: 'water', a: -24, b: 24 }, { t: 'steps', a: 24, b: 100 }], pool: true, escal: [-62, 62], lift: 140 },
  // 东南：檐下避雨（地面檐廊）+ 林中步道（坑底树池）+ 座椅 + 预留商业
  SE: { label: '东南庭院', sectors: [{ t: 'steps', a: -85, b: 85 }], canopy: [96, 264], trees: true, escal: [0], lift: -140 },
  // 东北：一坡到底的草坡 + 出挑商业（悬挑玻璃盒子，下面是地铁入口）
  NE: { label: '东北庭院', sectors: [{ t: 'slope', a: -110, b: 110 }], cantilever: 150, lift: -140 },
};
const SF = { wall: 1, steps: 0.5, water: 0.5, slope: 0.36 };

function typeWeights(st, phiDeg) {
  // 返回 {wall, steps, water, slope}，扇区边缘 10° 过渡
  let a = ((phiDeg + 180) % 360 + 360) % 360 - 180;
  const w = { wall: 0, steps: 0, water: 0, slope: 0 };
  let tot = 0;
  for (const s of st.sectors) {
    const k = Math.max(0, Math.min(1, Math.min(a - s.a, s.b - a) / 10 + 0.5));
    w[s.t] = Math.max(w[s.t], k);
  }
  for (const k of ['steps', 'water', 'slope']) tot += w[k];
  w.wall = Math.max(0, 1 - tot);
  return w;
}
function dominant(w) {
  let best = 'wall', v = -1;
  for (const k in w) if (w[k] > v) { v = w[k]; best = k; }
  return best;
}

/** 生成一座庭院的平面：轮廓（世界坐标）与每个角度的剖面 */
function planPit(q) {
  const { cx, cz, ang, R0, D, st } = q;
  const ux = Math.cos(ang), uz = Math.sin(ang), vx = -uz, vz = ux;
  const at = (phi, r) => [cx + (ux * Math.cos(phi) + vx * Math.sin(phi)) * r, cz + (uz * Math.cos(phi) + vz * Math.sin(phi)) * r];
  const rim = [], prof = [];
  const h = D / NS, M = NS * 2 + 1;
  for (let i = 0; i < NA; i++) {
    const phi = (i / NA) * Math.PI * 2 - Math.PI, deg = phi / D2R;
    const r = butterflyR(R0, phi);
    const P = at(phi, r);
    rim.push(P[0], P[1]);
    const w = typeWeights(st, deg);
    const pts = [];
    for (let j = 0; j < M; j++) {
      // 台阶/水阶：0=(1,0)，2k-1=(s_{k-1},-kh)，2k=(s_k,-kh)
      const k = Math.ceil(j / 2), y = -k * h;
      const stepS = (sf) => (j === 0 ? 1 : j % 2 ? 1 - ((k - 1) * (1 - sf)) / NS : 1 - (k * (1 - sf)) / NS);
      const sStep = stepS(SF.steps), sWater = stepS(SF.water);
      const t = j / (M - 1), sSlope = 1 - t * (1 - SF.slope), ySlope = -t * D;
      const s = w.wall * 1 + w.steps * sStep + w.water * sWater + w.slope * sSlope;
      const yy = (w.wall + w.steps + w.water) * y + w.slope * ySlope;
      pts.push([s, yy]);
    }
    prof.push({ phi, deg, r, w, type: dominant(w), pts, sf: pts[M - 1][0] });
  }
  return { rim: G.ccw(rim), prof, at, ux, uz, vx, vz };
}

// ───────────────────────── 模块 ─────────────────────────
export default {
  id: 'weiyang',
  name: NAME,

  prepare(ctx) {
    const T = ctx.terrain;
    const R = patchRoads(ctx.data.roads);
    if (!R) return;
    this.R = R;
    const C = { x: R.cx, z: R.cz };
    this.C = C;
    const ring7 = G.inset(R.ring, -7);
    // —— 广场范围：环岛（含路面外扩 7 m）∪ 删除路段两侧 hw+1 m ——
    const removed = R.removed.filter((p) => p.length >= 4);
    const insideRaw = (x, z) => {
      let v = sdPoly(x, z, ring7);
      for (const p of removed) v = Math.max(v, 8 - polyDist(x, z, p, false));
      return v;
    };
    // 车行道（新十字 + 附近原路段）：按方向区分右侧（外侧人行道）与左侧（中央分隔带）
    const cls = R.cls;
    const segs = [];
    for (const f of ctx.data.roads.features) {
      const c = cls[f.c];
      if (!MOTOR.has(c) || f.t || !f.p) continue;
      const p = f.p;
      let close = false;
      for (let i = 0; i < p.length && !close; i += 2) close = Math.abs(p[i] - C.x) < 420 && Math.abs(p[i + 1] - C.z) < 420;
      if (!close) continue;
      const hw = roadHW(f, c), sw = SW_W[c] || 0;
      for (let i = 0; i + 3 < p.length; i += 2) segs.push({ ax: p[i], az: p[i + 1], bx: p[i + 2], bz: p[i + 3], hw, sw, one: !!f.o });
    }
    // 线段网格（20 m）
    const SG = 20, grid = new Map();
    for (const s of segs) {
      const r = s.hw + 60; // 60 m 内距离精确，超出按 60 m 计
      for (let gx = Math.floor((Math.min(s.ax, s.bx) - r) / SG); gx <= Math.floor((Math.max(s.ax, s.bx) + r) / SG); gx++)
        for (let gz = Math.floor((Math.min(s.az, s.bz) - r) / SG); gz <= Math.floor((Math.max(s.az, s.bz) + r) / SG); gz++) {
          const k = gx * 100003 + gz;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(s);
        }
    }
    /** 离最近车行道路面边缘的距离（路面内为负）与该处是否在人行道带内 */
    const roadEdge = (x, z) => {
      const l = grid.get(Math.floor(x / SG) * 100003 + Math.floor(z / SG));
      let d = 60, swBand = false;
      if (l) for (const s of l) {
        const e = segDist(x, z, s.ax, s.az, s.bx, s.bz) - s.hw;
        if (e < d) d = e;
        if (e >= 0 && e < s.sw) swBand = true;
      }
      return { d, swBand };
    };
    this.roadEdge = roadEdge;
    const field0 = (x, z) => Math.min(insideRaw(x, z), roadEdge(x, z).d - 0.3);
    this.insideRaw = insideRaw;

    // —— 地形压平（广场 + 外扩 20 m），高度取环岛内平均 ——
    const flatPoly = G.inset(R.ring, -24);
    this.y0 = T.addFlatten({ points: flatPoly, height: null, feather: 30, mode: 'set' });

    // —— 四个庭院：每个象限取离边界最远的点（内切圆心）为中心 ——
    const bb = G.bbox(ring7);
    const best = { NW: null, NE: null, SW: null, SE: null };
    for (let x = bb.x0; x <= bb.x1; x += 3)
      for (let z = bb.z0; z <= bb.z1; z += 3) {
        const v = field0(x, z);
        if (v <= 0) continue;
        const q = (z < C.z ? 'N' : 'S') + (x < C.x ? 'W' : 'E');
        // 偏向象限对角线（避开中间那块三角绿岛被选中）
        const dx = x - C.x, dz = z - C.z, dl = Math.hypot(dx, dz) || 1;
        const diag = Math.abs(Math.abs(dx / dl) - Math.abs(dz / dl));
        const score = v - diag * 6;
        if (!best[q] || score > best[q].score) best[q] = { x, z, v, score };
      }
    this.pits = [];
    for (const key of ['NW', 'NE', 'SW', 'SE']) {
      const b = best[key];
      if (!b || b.v < 22) { console.warn('[weiyang] 象限空间不足，不建庭院', key, b); continue; }
      const ang = Math.atan2(b.z - C.z, b.x - C.x);
      let R0 = Math.min(34, (b.v - 9) / 1.12);
      let plan = null;
      // 轮廓逐点核验：离广场边界/路面 ≥ 9 m（环坑步道 7 m + 余量），不够就缩
      for (let it = 0; it < 12; it++) {
        plan = planPit({ cx: b.x, cz: b.z, ang, R0, D: 6.6, st: STYLES[key] });
        let worst = Infinity;
        for (let i = 0; i < plan.rim.length; i += 6) worst = Math.min(worst, field0(plan.rim[i], plan.rim[i + 1]));
        if (worst >= 9) break;
        R0 *= 0.93;
      }
      if (R0 < 14) continue;
      const D = 6.6;
      const top = T.holeRimTop(plan.rim);
      T.addHole(plan.rim);
      ctx.exclusions.add({ points: G.inset(plan.rim, -3), name: 'weiyang-pit' }, { buildings: true, trees: true, pois: true, sunken: true });
      ctx.exclusions.add({ points: G.inset(plan.rim, -0.4), name: 'weiyang-pit' }, { buildings: false, trees: false, pois: false, roads: true });
      ctx.exclusions.add({ points: G.inset(plan.rim, -7.5), name: 'weiyang-walk' }, { buildings: true, trees: true, pois: true });
      this.pits.push({ key, cx: b.x, cz: b.z, ang, R0, D, top, st: STYLES[key], ...plan });
    }
    // 园路：每个庭院四条（朝路口、朝外、两侧），宽 4 m，不种树
    this.paths = [];
    for (const p of this.pits) {
      for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const dx = Math.cos(p.ang + a), dz = Math.sin(p.ang + a);
        const A = [p.cx + dx * p.R0 * 0.55, p.cz + dz * p.R0 * 0.55], B = [p.cx + dx * 160, p.cz + dz * 160];
        this.paths.push([A, B]);
        const nx = -dz * 2.2, nz = dx * 2.2;
        ctx.exclusions.add({ points: [A[0] + nx, A[1] + nz, B[0] + nx, B[1] + nz, B[0] - nx, B[1] - nz, A[0] - nx, A[1] - nz], name: 'weiyang-path' }, { buildings: false, trees: true, pois: false });
      }
    }
    // 整个广场：通用建筑（含施工棚、中心十字楼）/ 兴趣点 / 其他下沉广场清单让位；树交给植被模块按公园种
    const plazaPoly = G.inset(R.ring, -9);
    ctx.exclusions.add({ points: plazaPoly, name: NAME }, { buildings: true, trees: false, pois: true, sunken: true });
    for (const p of removed) {
      // 删掉路段两侧的施工期小楼/摊点
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3], l = Math.hypot(bx - ax, bz - az) || 1;
        const nx = (-(bz - az) / l) * 9, nz = ((bx - ax) / l) * 9;
        ctx.exclusions.add({ points: [ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, ax - nx, az - nz], name: NAME }, { buildings: true, trees: false, pois: true, sunken: true });
      }
    }
    // 地面商业廊 / 出挑商业 / 檐廊：不种树、不放通用建筑
    for (const p of this.pits) {
      const st = p.st;
      const span = st.pavilion || st.canopy;
      if (span) {
        const ring = [];
        for (let d = span[0]; d <= span[1]; d += 6) { const ph = d * D2R - (d > 180 ? 2 * Math.PI : 0); const r = butterflyR(p.R0, ph) + 9; const P = p.at(ph, r); ring.push(P[0], P[1]); }
        for (let d = span[1]; d >= span[0]; d -= 6) { const ph = d * D2R - (d > 180 ? 2 * Math.PI : 0); const r = butterflyR(p.R0, ph) - 1; const P = p.at(ph, r); ring.push(P[0], P[1]); }
        ctx.exclusions.add({ points: G.ccw(ring), name: 'weiyang-hall' }, { buildings: true, trees: true, pois: true });
      }
      if (st.cantilever != null) {
        const ph = st.cantilever * D2R, r = butterflyR(p.R0, ph);
        const P = p.at(ph, r + 3);
        ctx.exclusions.add({ rect: [P[0], P[1], 24, 22, p.ang + ph], name: 'weiyang-hall' }, { buildings: true, trees: true, pois: true });
      }
    }
    // —— 用地：环岛公园 → 整块广场公园（a<6000：不做绿地色调叠加，地面由本模块铺） ——
    const lu = ctx.data.landuse;
    if (lu?.polys) {
      const rb = G.bbox(R.ring);
      lu.polys = lu.polys.filter((f) => {
        if (f.k !== 'park' || f.n) return true;
        const b = G.bbox(f.outer);
        return !(b.x0 > rb.x0 - 5 && b.x1 < rb.x1 + 5 && b.z0 > rb.z0 - 5 && b.z1 < rb.z1 + 5);
      });
      lu.polys.push({ k: 'park', n: NAME, a: 5000, boost: 3, outer: plazaPoly, holes: this.pits.map((p) => G.inset(p.rim, -7.5)) });
    }
    this.field0 = field0;
  },

  build(ctx) {
    if (!this.R) return {};
    const T = ctx.terrain, C = this.C;
    const root = new THREE.Group();
    root.name = NAME;
    ctx.scene.add(root);
    const ground = new W(), stone = new W(), glass = new W(), water = new W(), lamp = new W(), rail = new W(), dark = new W(), flora = new W(), white = new W();
    const LIFT = 0.07;
    const gy = (x, z) => T.heightAt(x, z) + LIFT;

    // —— 1. 地面：2 m 网格 + 符号距离场裁剪（marching triangles） ——
    const pits = this.pits, paths = this.paths;
    const pitOut = (x, z) => {
      let d = Infinity;
      for (const p of pits) {
        if (Math.abs(x - p.cx) > p.R0 * 1.3 + 20 || Math.abs(z - p.cz) > p.R0 * 1.3 + 20) continue;
        d = Math.min(d, -sdPoly(x, z, p.rim));
      }
      return d;
    };
    const field = (x, z) => Math.min(this.field0(x, z), pitOut(x, z) - 0.15);
    const pathD = (x, z) => { let d = Infinity; for (const [A, B] of paths) d = Math.min(d, segDist(x, z, A[0], A[1], B[0], B[1])); return d; };
    // 铺装场：>0 为铺装（环坑步道 7 m、园路 4.4 m、路边人行道带），<0 为草坪；与主场一起按三角形精确裁剪，边界是直线/曲线而不是锯齿
    const pavF = (x, z) => Math.max(7 - pitOut(x, z), 2.2 - pathD(x, z), 5.2 - this.roadEdge(x, z).d);
    // 平滑值噪声（草坪深浅斑块）
    const vnoise = (x, z, s) => {
      const gx = x / s, gz = z / s, ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
      const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
      const h = (a, b) => hash(a, b, s);
      return (h(ix, iz) * (1 - u) + h(ix + 1, iz) * u) * (1 - v) + (h(ix, iz + 1) * (1 - u) + h(ix + 1, iz + 1) * u) * v;
    };
    const lawnA = col('#55773a'), lawnB = col('#7a9a4e'), lawnC = col('#8f9a55');
    const lawnColor = (x, z) => {
      const n = vnoise(x, z, 9) * 0.65 + vnoise(x, z, 3.1) * 0.35, dry = vnoise(x + 500, z, 23);
      const c = lawnA.clone().lerp(lawnB, n);
      return dry > 0.72 ? c.lerp(lawnC, (dry - 0.72) * 2) : c;
    };
    const cGran = col('#d3cdc1'), cSide = col('#b4aea4');
    const paveColor = (x, z) => {
      const c = (this.roadEdge(x, z).d < 5.2 ? cSide : cGran).clone();
      return c.multiplyScalar(0.94 + vnoise(x, z, 6) * 0.1);
    };
    const pave = new W();
    const bb = G.bbox(G.inset(this.R.ring, -60));
    const S = 2, nx = Math.ceil((bb.x1 - bb.x0) / S) + 1, nz = Math.ceil((bb.z1 - bb.z0) / S) + 1;
    const V = new Float32Array(nx * nz), PV = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = bb.x0 + i * S, z = bb.z0 + j * S, v = field(x, z);
      V[j * nx + i] = v;
      PV[j * nx + i] = v > -S * 1.5 ? pavF(x, z) : -1;
    }
    const vert = (x, z) => [x, gy(x, z), z];
    const clip = (poly, key, keepPos) => {
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const ina = keepPos ? a[key] >= 0 : a[key] < 0, inb = keepPos ? b[key] >= 0 : b[key] < 0;
        if (ina) out.push(a);
        if (ina !== inb) {
          const t = a[key] / (a[key] - b[key]);
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          out.push(key === 'v' ? { x, z, v: 0, p: pavF(x, z) } : { x, z, p: 0, v: a.v + (b.v - a.v) * t });
        }
      }
      return out;
    };
    const fan = (poly, w, colorFn) => {
      for (let k = 1; k + 1 < poly.length; k++) {
        const A = poly[0], B = poly[k], Cc = poly[k + 1];
        w.tri(vert(A.x, A.z), vert(B.x, B.z), vert(Cc.x, Cc.z), colorFn(A.x, A.z), colorFn(B.x, B.z), colorFn(Cc.x, Cc.z), true, 4);
      }
    };
    for (let j = 0; j + 1 < nz; j++)
      for (let i = 0; i + 1 < nx; i++) {
        const x0 = bb.x0 + i * S, z0 = bb.z0 + j * S, x1 = x0 + S, z1 = z0 + S;
        const k0 = j * nx + i, k1 = k0 + 1, k2 = k0 + nx + 1, k3 = k0 + nx;
        const a = { x: x0, z: z0, v: V[k0], p: PV[k0] }, b = { x: x1, z: z0, v: V[k1], p: PV[k1] };
        const c = { x: x1, z: z1, v: V[k2], p: PV[k2] }, d = { x: x0, z: z1, v: V[k3], p: PV[k3] };
        for (const t of [[a, b, c], [a, c, d]]) {
          if (t[0].v < 0 && t[1].v < 0 && t[2].v < 0) continue;
          const P = t[0].v >= 0 && t[1].v >= 0 && t[2].v >= 0 ? t : clip(t, 'v', true);
          if (P.length < 3) continue;
          if (P.every((q) => q.p >= 0)) fan(P, pave, paveColor);
          else if (P.every((q) => q.p < 0)) fan(P, ground, lawnColor);
          else { fan(clip(P, 'p', true), pave, paveColor); fan(clip(P, 'p', false), ground, lawnColor); }
        }
      }
    const cEdge = col('#8e8a83');

    // 坑底树：主干 + 三团二十面体树冠（逐面深浅）
    const ico = new THREE.IcosahedronGeometry(1, 2).toNonIndexed().getAttribute('position');
    const tree = (x, y, z, s, seed) => {
      flora.cyl(x, z, y, y + 2.6 * s, 0.17 * s, 7, col('#5a4632'));
      const greens = [col('#4b7434'), col('#567f3a'), col('#5f8a42'), col('#466c31')];
      for (let k = 0; k < 5; k++) {
        const a = seed * 2.1 + k * 1.37, rr = (k === 0 ? 1.9 : 1.35) * s;
        const ox = Math.cos(a) * 1.3 * s * (k > 0), oz = Math.sin(a) * 1.3 * s * (k > 0), oy = (k === 0 ? 4.2 : 3.4 + (k & 1) * 1.1) * s;
        for (let t = 0; t < ico.count; t += 3) {
          const v = (n) => {
            const X = ico.getX(t + n), Y = ico.getY(t + n), Z = ico.getZ(t + n);
            const b = 1 + (hash(Math.round(X * 9), Math.round(Y * 9) + Math.round(Z * 9) * 31, seed + k) - 0.5) * 0.28;
            return [x + ox + X * rr * b, y + oy + Y * rr * 0.8 * b, z + oz + Z * rr * b];
          };
          const c = greens[Math.floor(hash(t, seed * 3 + k, 13) * 4)];
          flora.tri(v(0), v(1), v(2), c, c, c);
        }
      }
    };
    // —— 2. 庭院 ——
    const cStone = col('#d9d3c7'), cRiser = col('#a9a194'), cWood = col('#a7794b'), cWall = col('#d2cbbd'), cFloorC = col('#c9c2b5');
    const cSlope = [col('#5d8a3a'), col('#679342')], cWaterT = col('#5e93ad'), cWaterR = col('#7fb2c8'), cLED = col('#ffe6b8');
    const cFrame = col('#3b3f44'), cShop = [col('#5d7585'), col('#66808f'), col('#57707f'), col('#6d8796')];
    const signC = [col('#b8352f'), col('#1f4e79'), col('#2d6a4f'), col('#a87b1f'), col('#5b2d6e'), col('#2b2b2b')];
    const lights = [];
    let nShops = 0;
    for (const p of pits) {
      const { prof, D, top } = p;
      const at3 = (phi, s, y) => { const r = butterflyR(p.R0, phi) * s; const P = p.at(phi, r); return [P[0], top + y, P[1]]; };
      // 剖面网格
      for (let i = 0; i < NA; i++) {
        const A = prof[i], B = prof[(i + 1) % NA];
        const phB = i + 1 === NA ? B.phi + Math.PI * 2 : B.phi;
        const type = A.w.wall > 0.5 && B.w.wall > 0.5 ? 'wall' : A.type;
        for (let j = 0; j + 1 < A.pts.length; j++) {
          const a = at3(A.phi, A.pts[j][0], A.pts[j][1]), b = at3(phB, B.pts[j][0], B.pts[j][1]);
          const c = at3(phB, B.pts[j + 1][0], B.pts[j + 1][1]), d = at3(A.phi, A.pts[j + 1][0], A.pts[j + 1][1]);
          const riser = j % 2 === 0;
          if (type === 'water') water.quad(a, b, c, d, riser ? cWaterR : cWaterT, 2);
          else if (type === 'slope') stone.quad(a, b, c, d, cSlope[(j >> 2) & 1], 3);
          else if (type === 'wall') stone.quad(a, b, c, d, cWall, 3);
          else stone.quad(a, b, c, d, riser ? cRiser : (j % 6 === 3 ? cWood : cStone), 2);
          // 台阶灯带：每级踏面前沿下方
          if ((type === 'steps' || type === 'water') && !riser && j > 0) {
            const e = at3(A.phi, A.pts[j][0] + 0.004, A.pts[j][1] - 0.05), f = at3(phB, B.pts[j][0] + 0.004, B.pts[j][1] - 0.05);
            const g = at3(phB, B.pts[j][0] + 0.004, B.pts[j][1] - 0.12), h = at3(A.phi, A.pts[j][0] + 0.004, A.pts[j][1] - 0.12);
            lamp.quad(e, f, g, h, cLED);
          }
        }
        // 坑底（扇形三角，按半径分环配色）
        const fa = at3(A.phi, A.sf, -D + 0.02), fb = at3(phB, B.sf, -D + 0.02);
        const cc = [p.cx, top - D + 0.02, p.cz];
        pave.tri(cc, fb, fa, cFloorC, cFloorC, cFloorC, true, 4);
        // 压顶：内侧面 + 顶面 + 外侧裙边（压住洞口边缘）
        const r0 = at3(A.phi, 1, -0.15), r1 = at3(phB, 1, -0.15), t0 = at3(A.phi, 1, 0.16), t1 = at3(phB, 1, 0.16);
        const kA = 1 + 0.7 / A.r, kB = 1 + 0.7 / B.r;
        const o0 = at3(A.phi, kA, 0.16), o1 = at3(phB, kB, 0.16), s0 = at3(A.phi, kA, -1.0), s1 = at3(phB, kB, -1.0);
        stone.quad(r0, r1, t1, t0, cEdge, 1);
        stone.quad(t0, t1, o1, o0, col('#cfc9bd'), 1);
        stone.quad(o0, o1, s1, s0, cEdge, 1);
        lamp.quad(at3(A.phi, 1 - 0.012 / A.r, 0.05), at3(phB, 1 - 0.012 / B.r, 0.05), at3(phB, 1 - 0.012 / B.r, 0.12), at3(A.phi, 1 - 0.012 / A.r, 0.12), cLED);
        // 墙段：玻璃栏杆 + 坑底商铺（玻璃门面 + 店招 + 竖框）
        if (A.w.wall > 0.6 && B.w.wall > 0.6) {
          const g0 = at3(A.phi, 1, 0.16), g1 = at3(phB, 1, 0.16), g2 = at3(phB, 1, 1.2), g3 = at3(A.phi, 1, 1.2);
          rail.quad(g0, g1, g2, g3, col('#cfe3ea'));
          dark.quad(g3, g2, at3(phB, 1, 1.26), at3(A.phi, 1, 1.26), cFrame);
          const portal = Math.abs(Math.abs(A.deg) - 180) < 16 || Math.abs(Math.abs(B.deg) - 180) < 16;
          const kin = 1 - 0.07 / A.r, kinB = 1 - 0.07 / B.r;
          if (portal) {
            // 地铁 / 过街通道口：整面玻璃门
            glass.quad(at3(A.phi, kin, -D + 0.05), at3(phB, kinB, -D + 0.05), at3(phB, kinB, -D + 4.3), at3(A.phi, kin, -D + 4.3), col('#6f8a99'));
          } else {
            const shopTop = -D + 3.5;
            const cs = cShop[Math.floor(hash(i, p.cx) * 4)];
            glass.quad(at3(A.phi, kin, -D + 0.08), at3(phB, kinB, -D + 0.08), at3(phB, kinB, shopTop), at3(A.phi, kin, shopTop), cs);
            if (i % 3 === 0) {
              const sc = signC[Math.floor(hash(i, p.cz, 3) * signC.length)];
              const len = 3;
              const Bp = prof[(i + len) % NA], phE = i + len >= NA ? Bp.phi + Math.PI * 2 : Bp.phi;
              dark.quad(at3(A.phi, kin - 0.002, shopTop + 0.15), at3(phE, 1 - 0.09 / Bp.r, shopTop + 0.15), at3(phE, 1 - 0.09 / Bp.r, shopTop + 0.85), at3(A.phi, kin - 0.002, shopTop + 0.85), sc);
              dark.quad(at3(A.phi, kin - 0.003, -D), at3(A.phi, kin - 0.003, shopTop + 0.9), at3(A.phi + 0.006, kin - 0.003, shopTop + 0.9), at3(A.phi + 0.006, kin - 0.003, -D), cFrame);
              nShops++;
            }
          }
        }
      }
      // 通道口雨棚 + 站名牌
      {
        const ph = Math.PI, r = butterflyR(p.R0, ph);
        const P0 = p.at(ph, r), P1 = p.at(ph, r - 3.2);
        const yaw = p.ang + Math.PI / 2;
        white.box((P0[0] + P1[0]) / 2, (P0[1] + P1[1]) / 2, top - D + 4.4, top - D + 4.75, 13, 3.4, yaw, col('#e9e7e2'));
        const sign = textTex('行政中心站 · 地下通道', { size: 72, color: '#ffffff', bg: '#173e6b', padding: 0.3 });
        const h = 0.9, w = Math.min(10, h * sign.aspect);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: sign.texture, toneMapped: false }));
        const Q = p.at(ph, r - 0.12);
        m.position.set(Q[0], top - D + 5.35, Q[1]);
        m.lookAt(p.cx, top - D + 5.35, p.cz);
        root.add(m);
      }
      // 扶梯（沿台阶斜面径向，成对）
      for (const ed of p.st.escal || []) {
        const ph = ed * D2R, pr = prof[Math.round(((ph + Math.PI) / (2 * Math.PI)) * NA) % NA];
        const r = pr.r, sf = pr.sf;
        for (const off of [-1.0, 1.0]) {
          const dir = p.at(ph, 1), base = p.at(ph, 0);
          const ex = (dir[0] - base[0]), ez = (dir[1] - base[1]); // 单位方向（at 的 r=1）
          const tx = -ez, tz = ex;
          const L0 = r * sf, L1 = r + 0.6;
          const A0 = [base[0] + ex * L0 + tx * off, base[1] + ez * L0 + tz * off], A1 = [base[0] + ex * L1 + tx * off, base[1] + ez * L1 + tz * off];
          const y0 = top - D, y1 = top + 0.15;
          const hw = 0.55;
          const q = (s, o, y) => [A0[0] + (A1[0] - A0[0]) * s + tx * o, y, A0[1] + (A1[1] - A0[1]) * s + tz * o];
          dark.quad(q(0, -hw, y0 + 0.9), q(1, -hw, y1 + 0.9), q(1, hw, y1 + 0.9), q(0, hw, y0 + 0.9), col('#4a4f55'));
          dark.quad(q(0, -hw, y0), q(1, -hw, y1), q(1, -hw, y1 + 0.9), q(0, -hw, y0 + 0.9), col('#6b7076'));
          dark.quad(q(0, hw, y0), q(1, hw, y1), q(1, hw, y1 + 0.9), q(0, hw, y0 + 0.9), col('#6b7076'));
          rail.quad(q(0, -hw, y0 + 0.9), q(1, -hw, y1 + 0.9), q(1, -hw, y1 + 1.9), q(0, -hw, y0 + 1.9), col('#d9eef5'));
          rail.quad(q(0, hw, y0 + 0.9), q(1, hw, y1 + 0.9), q(1, hw, y1 + 1.9), q(0, hw, y0 + 1.9), col('#d9eef5'));
          lamp.quad(q(0, -hw, y0 + 1.9), q(1, -hw, y1 + 1.9), q(1, -hw + 0.08, y1 + 1.95), q(0, -hw + 0.08, y0 + 1.95), col('#dff1ff'));
        }
      }
      // 玻璃观光电梯（无障碍）
      if (p.st.lift != null) {
        const ph = p.st.lift * D2R, r = butterflyR(p.R0, ph);
        const P = p.at(ph, r - 1.9);
        const yaw = p.ang + ph;
        rail.box(P[0], P[1], top - D, top + 3.4, 2.6, 2.6, yaw, col('#cfe6ee'), col('#cfe6ee'));
        dark.box(P[0], P[1], top + 3.4, top + 3.75, 2.9, 2.9, yaw, cFrame);
        for (const [u, v] of [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]]) {
          const c = Math.cos(yaw), s = Math.sin(yaw);
          dark.box(P[0] + u * c - v * s, P[1] + u * s + v * c, top - D, top + 3.4, 0.12, 0.12, yaw, cFrame);
        }
        lamp.box(P[0], P[1], top + 2.9, top + 3.0, 2.2, 2.2, yaw, col('#fff4dc'));
      }
      // 坑底：西南水池 + 喷泉、东南树池、座椅
      const floorAt = (u, v) => [p.cx + p.ux * u + p.vx * v, p.cz + p.uz * u + p.vz * v];
      const fy = top - D;
      if (p.st.pool) {
        const pr0 = prof[NA / 2], rr = pr0.r * pr0.sf;
        const pts = [];
        for (let k = 0; k < 40; k++) { const a = (k / 40) * Math.PI * 2; pts.push(floorAt(rr * 0.45 + Math.cos(a) * rr * 0.35, Math.sin(a) * rr * 0.5)); }
        for (let k = 0; k < 40; k++) {
          const A = pts[k], B = pts[(k + 1) % 40], c0 = floorAt(rr * 0.45, 0);
          water.tri([c0[0], fy + 0.18, c0[1]], [B[0], fy + 0.18, B[1]], [A[0], fy + 0.18, A[1]], cWaterT, cWaterT, cWaterT, true, 2);
          stone.quad([A[0], fy, A[1]], [B[0], fy, B[1]], [B[0], fy + 0.32, B[1]], [A[0], fy + 0.32, A[1]], cEdge, 1);
          if (k % 5 === 0) lamp.box(A[0], A[1], fy + 0.32, fy + 0.4, 0.3, 0.3, 0, col('#cfeaff'));
        }
      }
      if (p.st.trees) {
        for (let k = 0; k < 9; k++) {
          const u = (hash(k, p.cx, 5) - 0.35) * p.R0 * 0.55, v = (hash(k, p.cz, 6) - 0.5) * p.R0 * 0.75;
          const P = floorAt(u, v);
          if (-sdPoly(P[0], P[1], p.rim) > -4) continue;
          stone.box(P[0], P[1], fy, fy + 0.45, 2.6, 2.6, p.ang, cEdge, col('#5b4a38'));
          tree(P[0], fy + 0.45, P[1], 0.9 + hash(k, 7) * 0.35, k);
        }
      }
      for (let k = 0; k < 10; k++) {
        const u = (hash(k, p.cx, 9) - 0.4) * p.R0 * 0.7, v = (hash(k, p.cz, 10) - 0.5) * p.R0 * 0.9;
        const P = floorAt(u, v);
        if (-sdPoly(P[0], P[1], p.rim) > -3) continue;
        stone.box(P[0], P[1], fy, fy + 0.45, 2.2, 0.6, p.ang + hash(k, 1) * 3, cWood);
      }
      // 坑底地灯 + 夜间光源
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2, pr = prof[Math.floor((k / 8) * NA)];
        const P = p.at(pr.phi, pr.r * pr.sf * 0.9);
        lamp.box(P[0], P[1], fy, fy + 0.8, 0.22, 0.22, a, col('#ffe0a6'));
      }
      lights.push({ p: new THREE.Vector3(p.cx, top - D + 6.2, p.cz), i: 150, d: 34 });
      for (const k of [0.25, 0.75]) { const pr = prof[Math.floor(k * NA)]; const P = p.at(pr.phi, pr.r + 4); lights.push({ p: new THREE.Vector3(P[0], gy(P[0], P[1]) + 4.6, P[1]), i: 200, d: 24 }); }
      // —— 地面附属 ——
      const st = p.st;
      if (st.pavilion || st.canopy) {
        // 西北：地面商业廊（玻璃盒子，白色屋面）；东南：檐廊（白色薄檐 + 细柱）
        const [d0, d1] = st.pavilion || st.canopy;
        const isHall = !!st.pavilion;
        const H = isHall ? 4.6 : 4.3, inner = 1.2, outer = isHall ? 8.5 : 7.5;
        for (let d = d0; d < d1; d += 3) {
          const pa = d * D2R, pb = Math.min(d + 3, d1) * D2R;
          const ra = butterflyR(p.R0, pa), rb = butterflyR(p.R0, pb);
          const q = (ph, r, y) => { const P = p.at(ph, r); return [P[0], top + y, P[1]]; };
          white.quad(q(pa, ra + inner, H), q(pb, rb + inner, H), q(pb, rb + outer, H), q(pa, ra + outer, H), col('#eeece7'));
          white.quad(q(pa, ra + inner, H - 0.35), q(pb, rb + inner, H - 0.35), q(pb, rb + inner, H), q(pa, ra + inner, H), col('#d8d5ce'));
          white.quad(q(pa, ra + outer, H - 0.35), q(pb, rb + outer, H - 0.35), q(pb, rb + outer, H), q(pa, ra + outer, H), col('#d8d5ce'));
          if (isHall) {
            const cs = cShop[Math.floor(hash(d, 3) * 4)];
            glass.quad(q(pa, ra + outer - 0.6, 0.05), q(pb, rb + outer - 0.6, 0.05), q(pb, rb + outer - 0.6, H - 0.35), q(pa, ra + outer - 0.6, H - 0.35), cs);
            glass.quad(q(pa, ra + inner + 0.4, 0.05), q(pb, rb + inner + 0.4, 0.05), q(pb, rb + inner + 0.4, H - 0.35), q(pa, ra + inner + 0.4, H - 0.35), cs);
            stone.quad(q(pa, ra + inner + 0.4, 0.04), q(pb, rb + inner + 0.4, 0.04), q(pb, rb + outer - 0.6, 0.04), q(pa, ra + outer - 0.6, 0.04), col('#cdc6b8'), 2);
            for (const rr of [inner + 0.4, outer - 0.6]) { const P = p.at(pa, ra + rr); dark.box(P[0], P[1], top, top + H - 0.35, 0.1, 0.1, p.ang + pa, cFrame); }
          } else if (d % 9 === 0) {
            for (const rr of [outer - 0.5]) { const P = p.at(pa, ra + rr); white.cyl(P[0], P[1], top, top + H - 0.35, 0.13, 8, col('#e4e2dd')); }
            const P = p.at(pa, ra + (inner + outer) / 2);
            lamp.box(P[0], P[1], top + H - 0.42, top + H - 0.36, 1.4, 0.3, p.ang + pa, col('#fff0d2'));
          }
        }
        if (isHall) {
          // 屋面绿化（集中绿地的一部分）
          for (let d = d0 + 6; d < d1 - 6; d += 6) {
            const ph = d * D2R, r = butterflyR(p.R0, ph);
            const P = p.at(ph, r + (inner + outer) / 2);
            flora.box(P[0], P[1], top + H, top + H + 0.25, 4.5, 4.5, p.ang + ph, col('#567a39'), col('#62873f'));
          }
        }
      }
      if (st.cantilever != null) {
        // 东北：出挑商业——玻璃盒子一半落地、一半悬挑在坑口上方，盒底是地铁入口雨棚
        const ph = st.cantilever * D2R, r = butterflyR(p.R0, ph);
        const P = p.at(ph, r - 1);
        const yaw = p.ang + ph;
        glass.box(P[0], P[1], top + 0.6, top + 5.4, 15, 20, yaw + Math.PI / 2, col('#5f7b8c'), col('#5f7b8c'));
        {
          const y2 = yaw + Math.PI / 2, c2 = Math.cos(y2), s2 = Math.sin(y2);
          const fin = (u, v, w, d) => white.box(P[0] + u * c2 - v * s2, P[1] + u * s2 + v * c2, top + 0.6, top + 5.4, w, d, y2, col('#eceae4'));
          for (let u = -7.5; u <= 7.51; u += 2.5) { fin(u, -10.1, 0.18, 0.6); fin(u, 10.1, 0.18, 0.6); }
          for (let v = -7.5; v <= 7.51; v += 2.5) { fin(-7.6, v, 0.6, 0.18); fin(7.6, v, 0.6, 0.18); }
        }
        white.box(P[0], P[1], top + 5.4, top + 6.0, 15.6, 20.6, yaw + Math.PI / 2, col('#efeee9'));
        white.box(P[0], P[1], top + 0.25, top + 0.6, 15.6, 20.6, yaw + Math.PI / 2, col('#e3e1db'));
        const c = Math.cos(yaw), s = Math.sin(yaw);
        for (const [u, v] of [[5, -7], [5, 7], [9, -7], [9, 7]]) dark.box(P[0] + u * c - v * s, P[1] + u * s + v * c, top - 0.3, top + 0.3, 0.5, 0.5, yaw, cFrame);
        const sign = textTex('未央城市广场', { size: 96, color: '#ffffff', padding: 0.15 });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 9 / sign.aspect), new THREE.MeshBasicMaterial({ map: sign.texture, transparent: true, toneMapped: false, depthWrite: false }));
        const Q = p.at(ph, r - 11.1);
        m.position.set(Q[0], top + 4.4, Q[1]);
        m.lookAt(p.cx, top + 4.4, p.cz);
        root.add(m);
      }
      // 环坑步道灯杆（每 ~16 m）
      for (let i = 0; i < NA; i += 8) {
        const pr = prof[i];
        if (st.pavilion && pr.deg > st.pavilion[0] - 186 && false) continue;
        const P = p.at(pr.phi, pr.r + 5.8);
        if (this.field0(P[0], P[1]) < 1.5) continue;
        const y = gy(P[0], P[1]);
        dark.cyl(P[0], P[1], y, y + 4.2, 0.07, 6, col('#555a60'));
        lamp.box(P[0], P[1], y + 4.2, y + 4.45, 0.36, 0.36, 0, col('#fff2d6'));
      }
      // 花带：环坑步道外 9~11.5 m，按扇区换色（“花开四季”）；每块细分成 0.5 m 小格随机点花色
      const flowers = [[col('#b9354f'), col('#e7c8cf')], [col('#e2a72a'), col('#f3e6b0')], [col('#7b4fa8'), col('#d9cde8')], [col('#d9566f'), col('#f7f0e6')]];
      const leaf = [col('#3f6a2d'), col('#4d7a35')];
      for (let i = 0; i < NA; i++) {
        const A = prof[i], B = prof[(i + 1) % NA];
        if (Math.floor(i / 6) % 3 === 2) continue;
        const phB = i + 1 === NA ? B.phi + Math.PI * 2 : B.phi;
        const pa = p.at(A.phi, A.r + 9), pb = p.at(phB, B.r + 9), pc = p.at(phB, B.r + 11.5), pd = p.at(A.phi, A.r + 11.5);
        if ([pa, pb, pc, pd].some((P) => this.field0(P[0], P[1]) < 0.8 || pathD(P[0], P[1]) < 2.4)) continue;
        const [fc, fc2] = flowers[Math.floor(i / 18) % flowers.length];
        const Y = (P) => gy(P[0], P[1]) + 0.13;
        const L = (P, Q, t) => [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t];
        const NU = 6, NV = 10;
        for (let u = 0; u < NU; u++)
          for (let v = 0; v < NV; v++) {
            const q = (uu, vv) => { const P = L(L(pa, pb, uu / NU), L(pd, pc, uu / NU), vv / NV); return [P[0], Y(P), P[1]]; };
            const hv = hash(i * 31 + u, v * 7 + p.cx, 11), hj = hash(u * 13 + i, v + p.cz, 17);
            const c = (hv < 0.5 ? leaf[(u + v) & 1] : hv < 0.9 ? fc : fc2).clone().multiplyScalar(0.85 + hj * 0.3);
            if (hv >= 0.5) c.lerp(leaf[0], 0.25);
            const qa = q(u, v), qb = q(u + 1, v), qc = q(u + 1, v + 1), qd = q(u, v + 1);
            flora.quad(qa, qb, qc, qd, c, 2);
          }
        flora.quad([pa[0], Y(pa) - 0.2, pa[1]], [pb[0], Y(pb) - 0.2, pb[1]], [pb[0], Y(pb), pb[1]], [pa[0], Y(pa), pa[1]], col('#9a958b'), 1);
        flora.quad([pd[0], Y(pd) - 0.2, pd[1]], [pc[0], Y(pc) - 0.2, pc[1]], [pc[0], Y(pc), pc[1]], [pd[0], Y(pd), pd[1]], col('#9a958b'), 1);
      }
    }
    // 园路灯杆
    for (const [A, B] of paths) {
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      for (let s = 14; s < L; s += 22) {
        const x = A[0] + ((B[0] - A[0]) * s) / L, z = A[1] + ((B[1] - A[1]) * s) / L;
        const nx2 = (-(B[1] - A[1]) / L) * 2.9, nz2 = ((B[0] - A[0]) / L) * 2.9;
        const P = [x + nx2, z + nz2];
        if (this.field0(P[0], P[1]) < 2 || pitOut(P[0], P[1]) < 8) continue;
        const y = gy(P[0], P[1]);
        dark.cyl(P[0], P[1], y, y + 3.6, 0.06, 6, col('#555a60'));
        lamp.box(P[0], P[1], y + 3.6, y + 3.82, 0.32, 0.32, 0, col('#fff2d6'));
      }
    }
    // —— 3. 地面地铁出入口亭（原 22 个整合为 18 个：广场内保留四个象限外侧各 3 个，路口四角的 A/B/C/D 并入下沉庭院） ——
    const EXITS = [[-89.4, -9226.5, 'A2'], [-126.4, -9190.8, 'A3'], [-60.9, -9198.3, 'A1'], [166.0, -9189.8, 'D3'], [203.9, -9153.7, 'D2'], [139.0, -9160.1, 'D1'],
      [-127.0, -8975.2, 'B2'], [-94.3, -8939.5, 'B3'], [-64.0, -8974.9, 'B1'], [96.9, -8967.2, 'C1'], [127.6, -8933.5, 'C2'], [169.5, -8972.9, 'C3']];
    let nExit = 0;
    for (const [ex, ez, nm] of EXITS) {
      let x = ex, z = ez;
      // 落在坑里/路上的出口挪到环坑步道外沿或路边
      for (let k = 0; k < 30 && (pitOut(x, z) < 9 || this.field0(x, z) < 4); k++) {
        const dx = x - C.x, dz = z - C.z, l = Math.hypot(dx, dz) || 1;
        x += (dx / l) * 2; z += (dz / l) * 2;
      }
      if (pitOut(x, z) < 9 || this.field0(x, z) < 4) continue;
      const y = gy(x, z), yaw = Math.atan2(z - C.z, x - C.x);
      glass.box(x, z, y, y + 3.0, 8.5, 4.2, yaw, col('#8aa3b0'), col('#8aa3b0'));
      white.box(x, z, y + 3.0, y + 3.35, 9.2, 4.9, yaw, col('#e8e6e0'));
      dark.box(x, z, y, y + 3.0, 8.6, 0.12, yaw, cFrame);
      const sign = textTex('M  ' + nm, { size: 64, color: '#ffffff', bg: '#c8102e', padding: 0.25 });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6 * sign.aspect * 0.5, 0.8), new THREE.MeshBasicMaterial({ map: sign.texture, toneMapped: false, side: THREE.DoubleSide }));
      m.position.set(x, y + 3.75, z);
      m.rotation.y = -yaw;
      root.add(m);
      nExit++;
    }

    // —— 材质与网格 ——
    const gtex = grain({ color: '#d2d1cc', amp: 22, seed: 31, spots: 40, joints: 4 });
    const ltex = grain({ color: '#d8d7d3', amp: 30, seed: 37, spots: 60 });
    const matGround = new THREE.MeshStandardMaterial({ vertexColors: true, map: ltex.map, normalMap: ltex.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.95 });
    const matPave = new THREE.MeshStandardMaterial({ vertexColors: true, map: gtex.map, normalMap: gtex.normalMap, roughness: 0.82 });
    const matStone = new THREE.MeshStandardMaterial({ vertexColors: true, map: ltex.map, normalMap: ltex.normalMap, roughness: 0.85, side: THREE.DoubleSide });
    const matWhite = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const matDark = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide });
    const matGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.3, emissive: 0xffd2a0, emissiveIntensity: 0, side: THREE.DoubleSide });
    const matWater = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.35, emissive: 0x2a6f9a, emissiveIntensity: 0, side: THREE.DoubleSide });
    const matLamp = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffe2b0, emissiveIntensity: 0, roughness: 0.4 });
    const matRail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    const matFlora = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
    ctx.night.register(matGlass, { day: 0.04, night: 0.85 });
    ctx.night.register(matWater, { day: 0, night: 0.5 });
    ctx.night.register(matLamp, { day: 0, night: 2.2 });
    const add = (w, mat, name, opts) => { const m = w.mesh(mat, name, opts); if (m) root.add(m); return m; };
    add(ground, matGround, '广场草坪', { cast: false });
    add(pave, matPave, '广场铺装', { cast: false });
    add(stone, matStone, '下沉庭院');
    add(white, matWhite, '檐廊与屋面');
    add(dark, matDark, '金属构件与店招');
    add(glass, matGlass, '玻璃门面');
    add(water, matWater, '水阶与水池', { cast: false });
    add(lamp, matLamp, '灯带', { cast: false, shadow: false });
    add(rail, matRail, '玻璃栏杆', { cast: false, shadow: false });
    add(flora, matFlora, '花带与树池');
    for (const L of lights) ctx.lights.add({ position: L.p, color: 0xffd3a0, intensity: L.i, distance: L.d, nightOnly: true, priority: 0.8 });
    const y0 = this.y0 ?? T.heightAt(C.x, C.z);
    ctx.labels.add(NAME, new THREE.Vector3(C.x, y0 + 26, C.z), { category: 'landmark', sub: '下沉广场', priority: 2, minDist: 40, maxDist: 5000 });
    console.warn(`[weiyang] ${pits.length} 座下沉庭院（${pits.map((p) => `${p.key} R${p.R0.toFixed(0)}`).join('、')}），地面三角形 ${(ground.p.length / 9) | 0}，商铺 ${nShops}，出入口亭 ${nExit}`);
    return {
      diag: () => ({ center: C, pits: pits.map((p) => ({ key: p.key, cx: p.cx, cz: p.cz, R0: p.R0, top: p.top })) }),
      update() {},
      setLayer(layer, v) { if (layer === 'buildings') root.visible = v; },
      dispose() { root.traverse((o) => o.geometry?.dispose()); ctx.scene.remove(root); },
    };
  },
};

// 出处：腾讯新闻 2026-02-07《张家堡下沉广场（未央城市广场）将于明日正式对外开放投用》
//   https://news.qq.com/rain/a/20260207A05DG500 ；腾讯新闻 2026-02-11《西安最大下沉广场集群开放》
//   https://news.qq.com/rain/a/20260211A06P0200 ；凤凰网陕西 https://sn.ifeng.com/c/8qaDXweU6uC
export { patchRoads, sdPoly, polyDist }; // 供 node 离线自测
