// 西安明城墙（整体重写）：13.74 km 城墙本体 + 91 马面 + 18 城门 + 4 角楼 + 护城河驳岸 + 夜景。
//
// 调研要点（写入常量）：
//  · 墙高 12 m，顶宽 12~14 m，底宽 15~18 m（中线→外皮 8.1 m 取自 OSM 实测，外侧收分 1.5 m）。
//  · 垛口 5984 个 / 13.74 km → 垛距约 2.3 m（垛宽 1.8 + 垛口 0.5），垛墙高约 2 m，内侧女墙约 1 m。
//  · 马面 91 个（数据 wall_mamian），间距约 120~140 m，宽约 20 m、外凸约 11 m；部分马面复建敌楼（取四门两侧）。
//  · 四门三重：闸楼（月城）→ 箭楼（瓮城外墙）→ 正楼。正楼面阔七间、重檐歇山三滴水、高约 36 m（含城台）；
//    箭楼面阔十一间、长 52.6 m、宽 13 m、距地 31~33 m、单檐歇山，正面四层箭窗每层 12 孔、两侧每层 3 孔；
//    永宁门箭楼下不开门洞（入城经瓮城），城台门洞宽高约 6 m。匾额：永寧門 / 安遠門 / 長樂門 / 安定門。
//  · 西南角为圆弧形城角（唐皇城旧制，中线在角部切去约 28 m），圆形角台；其余三角方形角台。
//  · 现代城门按券洞数（和平门 4、建国门/尚勤门 3 等，参考西安本地宝/澎湃城门介绍）。
import * as THREE from 'three';
import { ArchBuilder, buildArch, gateTower, arrowTower, multiStoreyTower, hall, pavilion, eaveLights, lantern, cityPlatform } from '../arch/chinese.js';
import { MeshBuf, wallMaterial, merlonGeometry, merlonLedGeometry, lampPostGeometry, outlineLines } from '../arch/citywall-kit.js';
import { pointInPoly } from '../core/util.js';

// 城墙中心线（data-src/landmarks_historic/wall_centerline.json 的 polygon，自西北角顺时针）
const CENTERLINE = [[-1993.2, -1796.8], [-230.9, -1825.6], [-39.3, -1827.5], [-36.6, -1824.5], [-14.0, -1824.5], [64.4, -1831.9], [64.4, -1834.9], [98.4, -1835.7], [2228.6, -1863.1], [2221.8, -1123.4], [2221.2, -546.1], [2221.2, -543.2], [2217.1, -543.1], [2217.5, -519.6], [2221.7, -519.5], [2222.0, -24.9], [2219.9, -3.9], [2224.0, 55.5], [2225.0, 792.3], [1031.3, 848.1], [751.7, 842.6], [28.1, 841.9], [-293.9, 845.6], [-1282.7, 848.0], [-1297.7, 847.9], [-1300.9, 845.0], [-1390.7, 845.0], [-1392.2, 848.7], [-1480.1, 849.6], [-1981.8, 849.6], [-1985.0, 76.8], [-1982.7, 38.3], [-1987.5, -117.2], [-1984.4, -1066.2], [-1986.7, -1080.1]];
const CORNERS = { NW: [-1993.2, -1796.8], NE: [2228.6, -1863.1], SE: [2225.0, 792.3], SW: [-1981.8, 849.6] };

const H = 12; // 墙高
const OB = 8.1, OT = 6.6, IB = -8.1, IT = -6.6; // 中线→外/内皮（底/顶）
const PO = { t: 0.62, h: 1.25 }; // 外侧垛墙下段（垛口底以下）
const PIN = { t: 0.5, h: 1.0 }; // 内侧女墙
const MER = { w: 1.8, h: 0.72, gap: 0.5 };
const MSTEP = MER.w + MER.gap;
const SW_R = 30; // 西南圆角半径

// 四大城门：W=瓮城外皮半宽，P=外凸（数据 other_protrusions），月城仅永宁门
const MAIN = {
  yongning: { plaque: '永寧門', W: 58, P: 130, arrowTunnel: 0, yue: true, label: '永宁门' },
  anyuan: { plaque: '安遠門', W: 56, P: 81, arrowTunnel: 1, label: '安远门' },
  changle: { plaque: '長樂門', W: 45, P: 80, arrowTunnel: 1, label: '长乐门' },
  anding: { plaque: '安定門', W: 52, P: 77, arrowTunnel: 1, label: '安定门' },
};
// 现代城门：[券洞数, 券洞宽]
const MODERN = {
  shangwu: [3, 6], shangde: [3, 7.5], jiefang: [3, 8], shangjian: [3, 7], shangqin: [3, 7], chaoyang: [3, 7.5],
  zhongshan: [2, 6.5], jianguo: [3, 7.5], heping: [4, 7.5], wenchang: [2, 7], zhuque: [3, 7.5], wumu: [1, 7],
  hanguang: [3, 7], yuxiang: [2, 8],
};
const MAIN_PLAT = { w: 56, d: 30, zc: -3 }; // 正楼城台

// ───────────── 中心线几何 ─────────────
function filletRing() {
  const P = CENTERLINE.map((p) => p.slice());
  const k = P.findIndex((p) => p[0] === CORNERS.SW[0] && p[1] === CORNERS.SW[1]);
  const V = P[k], A = P[k - 1], B = P[k + 1];
  const da = norm([A[0] - V[0], A[1] - V[1]]), db = norm([B[0] - V[0], B[1] - V[1]]);
  const half = Math.acos(Math.max(-1, Math.min(1, da[0] * db[0] + da[1] * db[1]))) / 2;
  const tl = SW_R / Math.tan(half);
  const T1 = [V[0] + da[0] * tl, V[1] + da[1] * tl], T2 = [V[0] + db[0] * tl, V[1] + db[1] * tl];
  const bis = norm([da[0] + db[0], da[1] + db[1]]);
  const cd = SW_R / Math.sin(half);
  const C = [V[0] + bis[0] * cd, V[1] + bis[1] * cd];
  const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
  let a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const arc = [];
  for (let i = 0; i <= 10; i++) {
    const a = a1 + (d * i) / 10;
    arc.push([C[0] + Math.cos(a) * SW_R, C[1] + Math.sin(a) * SW_R]);
  }
  P.splice(k, 1, ...arc);
  return { P, swCenter: C, swMid: arc[5], swOut: [-bis[0], -bis[1]] };
}
function norm(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

class Ring {
  constructor(P) {
    this.P = P;
    const n = P.length;
    let cx = 0, cz = 0;
    for (const p of P) { cx += p[0]; cz += p[1]; }
    cx /= n; cz /= n;
    this.segs = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
      this.segs.push({ a, b, len, tx, tz, s0: s });
      s += len;
    }
    this.L = s;
    // 外法线方向
    const g = this.segs[0];
    const mx = (g.a[0] + g.b[0]) / 2, mz = (g.a[1] + g.b[1]) / 2;
    const sign = Math.hypot(mx - g.tz - cx, mz + g.tx - cz) > Math.hypot(mx - cx, mz - cz) ? 1 : -1;
    for (const sg of this.segs) { sg.nx = -sg.tz * sign; sg.nz = sg.tx * sign; }
    this.vm = this.segs.map((sg, i) => {
      const pr = this.segs[(i - 1 + n) % n];
      const m = norm([pr.nx + sg.nx, pr.nz + sg.nz]);
      const sc = 1 / Math.max(0.3, m[0] * sg.nx + m[1] * sg.nz);
      return { nx: m[0], nz: m[1], sc };
    });
  }
  /** 最近点投影：{s, seg, off(外正)} */
  project(x, z) {
    let best = null;
    for (const sg of this.segs) {
      let t = (x - sg.a[0]) * sg.tx + (z - sg.a[1]) * sg.tz;
      t = Math.max(0, Math.min(sg.len, t));
      const px = sg.a[0] + sg.tx * t, pz = sg.a[1] + sg.tz * t;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { d, s: sg.s0 + t, seg: sg, off: (x - px) * sg.nx + (z - pz) * sg.nz };
    }
    return best;
  }
  wrap(s) {
    return ((s % this.L) + this.L) % this.L;
  }
  segAt(s) {
    s = this.wrap(s);
    let lo = 0, hi = this.segs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.segs[m].s0 <= s) lo = m;
      else hi = m - 1;
    }
    return this.segs[lo];
  }
  frame(s) {
    const sg = this.segAt(s);
    const t = this.wrap(s) - sg.s0;
    return { x: sg.a[0] + sg.tx * t, z: sg.a[1] + sg.tz * t, tx: sg.tx, tz: sg.tz, nx: sg.nx, nz: sg.nz };
  }
}

function inCuts(s, cuts, L) {
  for (const [a, b] of cuts) if ((s >= a && s <= b) || (s + L >= a && s + L <= b) || (s - L >= a && s - L <= b)) return true;
  return false;
}

// ───────────── 几何发射 ─────────────
const P3 = (p, o, y) => [p.x + p.nx * o * p.sc, y, p.z + p.nz * o * p.sc];

/** 墙身截面扫掠：stations [{x,z,nx,nz,sc,s,tx,tz,b,lo,loI}]；sec {oB,oT,iB,iT,H} */
function emitBody(bufs, st, sec, capStart = true, capEnd = true) {
  const { brick, pave, stone } = bufs;
  const { oB, oT, iB, iT } = sec;
  const Hh = sec.H;
  const oPl = oB - ((oB - oT) * 0.9) / Hh, iPl = iB + ((iT - iB) * 0.6) / Hh;
  for (let k = 0; k < st.length - 1; k++) {
    const a = st[k], b = st[k + 1];
    const En = [a.nx + b.nx, 0.12, a.nz + b.nz], Ei = [-En[0], 0.12, -En[2]];
    // 外侧土衬石
    stone.quad(P3(a, oB + 0.12, a.lo), P3(b, oB + 0.12, b.lo), P3(b, oB + 0.12, b.b + 0.9), P3(a, oB + 0.12, a.b + 0.9),
      [[a.s, a.lo - a.b], [b.s, b.lo - b.b], [b.s, 0.9], [a.s, 0.9]], [[0, 0.8], [0, 0.8], [0.9, 0.8], [0.9, 0.8]], En);
    stone.quad(P3(a, oB + 0.12, a.b + 0.9), P3(b, oB + 0.12, b.b + 0.9), P3(b, oPl, b.b + 0.9), P3(a, oPl, a.b + 0.9),
      [[a.s, 0], [b.s, 0], [b.s, 0.3], [a.s, 0.3]], [0.9, 0.5], [0, 1, 0]);
    // 外墙面（收分）
    brick.quad(P3(a, oPl, a.b + 0.9), P3(b, oPl, b.b + 0.9), P3(b, oT, b.b + Hh), P3(a, oT, a.b + Hh),
      [[a.s, 0.9], [b.s, 0.9], [b.s, Hh], [a.s, Hh]], [[0.9, 1], [0.9, 1], [Hh, 0.5], [Hh, 0.5]], En);
    // 顶面海墁
    pave.quad(P3(a, oT, a.b + Hh), P3(b, oT, b.b + Hh), P3(b, iT, b.b + Hh), P3(a, iT, a.b + Hh),
      [[a.s, oT], [b.s, oT], [b.s, iT], [a.s, iT]], [Hh, 0], [0, 1, 0]);
    // 内墙面
    brick.quad(P3(a, iT, a.b + Hh), P3(b, iT, b.b + Hh), P3(b, iPl, b.b + 0.6), P3(a, iPl, a.b + 0.6),
      [[a.s, Hh], [b.s, Hh], [b.s, 0.6], [a.s, 0.6]], [[Hh, 0.3], [Hh, 0.3], [0.6, 0.55], [0.6, 0.55]], Ei);
    stone.quad(P3(a, iB - 0.1, a.b + 0.6), P3(b, iB - 0.1, b.b + 0.6), P3(b, iB - 0.1, b.loI), P3(a, iB - 0.1, a.loI),
      [[a.s, 0.6], [b.s, 0.6], [b.s, b.loI - b.b], [a.s, a.loI - a.b]], [[0.6, 0.5], [0.6, 0.5], [0, 0.5], [0, 0.5]], Ei);
    stone.quad(P3(a, iPl, a.b + 0.6), P3(b, iPl, b.b + 0.6), P3(b, iB - 0.1, b.b + 0.6), P3(a, iB - 0.1, a.b + 0.6),
      [[a.s, 0], [b.s, 0], [b.s, 0.3], [a.s, 0.3]], [0.6, 0.3], [0, 1, 0]);
  }
  const cap = (p, sg) => {
    const E = [p.tx * sg, 0, p.tz * sg];
    brick.quad(P3(p, oB + 0.12, p.lo), P3(p, oT, p.b + Hh), P3(p, iT, p.b + Hh), P3(p, iB - 0.1, p.loI),
      [[oB, p.lo - p.b], [oT, Hh], [iT, Hh], [iB, p.loI - p.b]], [[0, 0.6], [Hh, 0.4], [Hh, 0.4], [0, 0.6]], E);
  };
  if (capStart) cap(st[0], -1);
  if (capEnd) cap(st[st.length - 1], 1);
}

/**
 * 垛墙/女墙：pts [{x,z,y,nx,nz,sc,s}]（中心线上的点，n 为外法线、sc 斜接系数，y 为墙顶）。
 * merl：若给出数组，按 MSTEP 放垛（perSeg：逐段独立排布，用于转角多的环）。
 */
function emitParapet(buf, pts, t, h, merl = null, perSeg = false, floodK = 0.45) {
  if (pts.length < 2) return;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const E = [a.nx + b.nx, 0, a.nz + b.nz];
    const hs0 = [H, floodK], hs1 = [H + h, floodK * 0.85];
    buf.quad(P3(a, t / 2, a.y), P3(b, t / 2, b.y), P3(b, t / 2, b.y + h), P3(a, t / 2, a.y + h), [[a.s, H], [b.s, H], [b.s, H + h], [a.s, H + h]], [hs0, hs0, hs1, hs1], E);
    buf.quad(P3(a, -t / 2, a.y), P3(b, -t / 2, b.y), P3(b, -t / 2, b.y + h), P3(a, -t / 2, a.y + h), [[a.s, H], [b.s, H], [b.s, H + h], [a.s, H + h]], [[H, 0.2], [H, 0.2], [H + h, 0.2], [H + h, 0.2]], [-E[0], 0, -E[2]]);
    buf.quad(P3(a, t / 2, a.y + h), P3(b, t / 2, b.y + h), P3(b, -t / 2, b.y + h), P3(a, -t / 2, a.y + h), [[a.s, 0], [b.s, 0], [b.s, t], [a.s, t]], [H + h, 0.15], [0, 1, 0]);
  }
  const cap = (p, q, sg) => {
    const tx = q.x - p.x, tz = q.z - p.z, l = Math.hypot(tx, tz) || 1;
    const E = [(tx / l) * sg, 0, (tz / l) * sg];
    buf.quad(P3(p, t / 2, p.y), P3(p, -t / 2, p.y), P3(p, -t / 2, p.y + h), P3(p, t / 2, p.y + h), [[0, H], [t, H], [t, H + h], [0, H + h]], [H, 0.3], E);
  };
  cap(pts[0], pts[1], -1);
  cap(pts[pts.length - 1], pts[pts.length - 2], 1);
  if (!merl) return;
  const place = (a, b, s) => {
    // a,b 相邻点，s ∈ [0,1]
    const x = a.x + (b.x - a.x) * s, z = a.z + (b.z - a.z) * s, y = a.y + (b.y - a.y) * s;
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    let nx = -tz / l, nz = tx / l;
    if (nx * (a.nx + b.nx) + nz * (a.nz + b.nz) < 0) { nx = -nx; nz = -nz; }
    merl.push([x, y + h, z, nx, nz]);
  };
  if (perSeg) {
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z) - t;
      const n = Math.floor((L + MER.gap) / MSTEP);
      if (n < 1) continue;
      const start = (L - (n * MSTEP - MER.gap)) / 2 + t / 2 + MER.w / 2;
      const Lf = L + t;
      for (let i = 0; i < n; i++) place(a, b, (start + i * MSTEP) / Lf);
    }
    return;
  }
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
  const L = cum[cum.length - 1];
  const n = Math.floor((L - 0.4 + MER.gap) / MSTEP);
  if (n < 1) return;
  const start = (L - (n * MSTEP - MER.gap)) / 2 + MER.w / 2;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const d = start + i * MSTEP;
    while (k < pts.length - 2 && cum[k + 1] < d) k++;
    const seg = cum[k + 1] - cum[k] || 1;
    place(pts[k], pts[k + 1], (d - cum[k]) / seg);
  }
}

/** 世界二维折线 → 带斜接法线的点（外法线背离 ref） */
function polyFrames(pts, ref, y, closed = false) {
  const n = pts.length;
  const seg = [];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l;
    let nx = -tz, nz = tx;
    const mx = (a[0] + b[0]) / 2 - ref[0], mz = (a[1] + b[1]) / 2 - ref[1];
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    seg.push({ l, nx, nz });
  }
  const out = [];
  let s = 0;
  const cnt = closed ? n + 1 : n;
  for (let i = 0; i < cnt; i++) {
    const ii = i % n;
    const p0 = closed ? seg[(ii - 1 + m) % m] : seg[Math.max(0, i - 1)];
    const p1 = closed ? seg[ii % m] : seg[Math.min(m - 1, i)];
    const mm = norm([p0.nx + p1.nx, p0.nz + p1.nz]);
    const sc = 1 / Math.max(0.3, mm[0] * p1.nx + mm[1] * p1.nz);
    const yy = typeof y === 'function' ? y(ii) : y;
    out.push({ x: pts[ii][0], z: pts[ii][1], y: yy, nx: mm[0], nz: mm[1], sc, s });
    if (i < cnt - 1) s += seg[Math.min(i, m - 1)].l;
  }
  return out;
}

/** 收分台体（矩形，局部 a 沿 X，o 沿 Z），toW(a,o)→[x,z]；底面 [a0,a1]×[o0,o1]，每边收 bat */
function emitBlock(bufs, toW, a0, a1, o0, o1, b, lo, h, bat, sides = [1, 1, 1, 1], topPave = true) {
  const { brick, pave } = bufs;
  const W = (a, o, y) => { const p = toW(a, o); return [p[0], y, p[1]]; };
  const A0 = a0 + bat, A1 = a1 - bat, O0 = o0 + bat, O1 = o1 - bat;
  const cen = toW((a0 + a1) / 2, (o0 + o1) / 2);
  const face = (p, q, P, Q, len) => {
    const E0 = W((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 0);
    const E = [E0[0] - cen[0], 0.1, E0[2] - cen[1]];
    brick.quad(W(p[0], p[1], lo), W(q[0], q[1], lo), W(Q[0], Q[1], b + h), W(P[0], P[1], b + h), [[0, lo - b], [len, lo - b], [len, h], [0, h]], [[0, 1], [0, 1], [h, 0.5], [h, 0.5]], E);
  };
  if (sides[0]) face([a0, o1], [a1, o1], [A0, O1], [A1, O1], a1 - a0); // 外
  if (sides[1]) face([a1, o1], [a1, o0], [A1, O1], [A1, O0], o1 - o0); // 右
  if (sides[2]) face([a1, o0], [a0, o0], [A1, O0], [A0, O0], a1 - a0); // 内
  if (sides[3]) face([a0, o0], [a0, o1], [A0, O0], [A0, O1], o1 - o0); // 左
  if (topPave) pave.quad(W(A0, O1, b + h), W(A1, O1, b + h), W(A1, O0, b + h), W(A0, O0, b + h), [[A0, O1], [A1, O1], [A1, O0], [A0, O0]], [h, 0], [0, 1, 0]);
}

// ───────────── 模块 ─────────────
function gateFrame(ring, g) {
  const pr = ring.project(g.world?.x ?? g.x, g.world?.z ?? g.z);
  const f = ring.frame(pr.s);
  const X = [f.nz, -f.nx]; // 局部 +X（古建构件库：rotY=θ 时正面朝 (sinθ, cosθ)）
  return { s: pr.s, x: f.x, z: f.z, nx: f.nx, nz: f.nz, X, theta: Math.atan2(f.nx, f.nz) };
}

export default {
  id: 'citywall',
  name: '西安明城墙与十八城门',

  prepare(ctx) {
    const { P } = filletRing();
    const ring = new Ring(P);
    // 城墙带状排除区（中线 −16 ~ +26 m，含马面），逐段矩形
    for (const sg of ring.segs) {
      const e = 4;
      const ax = sg.a[0] - sg.tx * e, az = sg.a[1] - sg.tz * e, bx = sg.b[0] + sg.tx * e, bz = sg.b[1] + sg.tz * e;
      const o1 = 26, o0 = -18;
      ctx.exclusions.add({ points: [ax + sg.nx * o0, az + sg.nz * o0, bx + sg.nx * o0, bz + sg.nz * o0, bx + sg.nx * o1, bz + sg.nz * o1, ax + sg.nx * o1, az + sg.nz * o1], name: '城墙' }, { buildings: true, trees: true, pois: false });
    }
    for (const c of Object.values(CORNERS)) ctx.exclusions.add({ circle: [c[0], c[1], 40], name: '角楼' }, { buildings: true, trees: true });
    const gates = ctx.data?.landmarks?.gates || [];
    for (const g of gates) {
      const spec = MAIN[g.id];
      if (!spec) continue;
      const f = gateFrame(ring, g);
      const W = (a, o) => [f.x + f.X[0] * a + f.nx * o, f.z + f.X[1] * a + f.nz * o];
      const poly = (a0, a1, o0, o1) => [W(a0, o0), W(a1, o0), W(a1, o1), W(a0, o1)].flat();
      ctx.exclusions.add({ points: poly(-spec.W - 10, spec.W + 10, -34, spec.P + 40), name: spec.label }, { buildings: true, trees: true, pois: false });
      ctx.terrain.addFlatten({ points: poly(-spec.W - 2, spec.W + 2, -22, spec.P + 4), height: null, feather: 22 });
    }
  },

  async build(ctx) {
    const t0 = performance.now();
    const tl = [];
    const mark = (k) => tl.push(k + ' ' + (performance.now() - t0).toFixed(0));
    const lm = ctx.data?.landmarks || {};
    const gates = lm.gates || [];
    const mamianData = lm.mamian || [];
    const { P, swMid, swOut } = filletRing();
    const ring = new Ring(P);
    const L = ring.L;
    const root = new THREE.Group();
    root.name = '西安城墙';
    ctx.scene.add(root);
    const hAt = (x, z) => ctx.terrain.heightAt(x, z);

    // —— 平滑墙基高程（4 m 采样，±24 m 滑动平均） ——
    const BS = 4, NB = Math.ceil(L / BS);
    const raw = new Float32Array(NB);
    for (let i = 0; i < NB; i++) { const f = ring.frame(i * BS); raw[i] = hAt(f.x, f.z); }
    const base = new Float32Array(NB);
    const Wn = 6;
    for (let i = 0; i < NB; i++) {
      let s = 0;
      for (let k = -Wn; k <= Wn; k++) s += raw[(i + k + NB) % NB];
      base[i] = s / (2 * Wn + 1);
    }
    const baseAt = (s) => {
      s = ring.wrap(s) / BS;
      const i = Math.floor(s), f = s - i;
      return base[i % NB] * (1 - f) + base[(i + 1) % NB] * f;
    };

    // —— 城门 / 角 / 马面：确定切口 ——
    const bodyCuts = [], outCuts = [], inCuts_ = [], forced = [];
    const addCut = (arr, a, b) => { arr.push([a, b]); forced.push(a, b); };
    const mainGates = [], modernGates = [];
    for (const g of gates) {
      const f = gateFrame(ring, g);
      f.by = baseAt(f.s);
      f.g = g;
      if (MAIN[g.id]) {
        const sp = MAIN[g.id];
        f.spec = sp;
        mainGates.push(f);
        addCut(bodyCuts, f.s - MAIN_PLAT.w / 2 + 0.6, f.s + MAIN_PLAT.w / 2 - 0.6);
        addCut(outCuts, f.s - MAIN_PLAT.w / 2, f.s + MAIN_PLAT.w / 2);
        addCut(inCuts_, f.s - MAIN_PLAT.w / 2, f.s + MAIN_PLAT.w / 2);
        const wc = sp.W - 7; // 瓮城侧墙中线
        addCut(outCuts, f.s - wc - 7.5, f.s - wc + 7.5);
        addCut(outCuts, f.s + wc - 7.5, f.s + wc + 7.5);
      } else {
        const [n, tw] = MODERN[g.id] || [2, 7];
        f.n = n;
        f.tw = tw;
        f.w = n * tw + (n + 1) * 4.5;
        modernGates.push(f);
        addCut(bodyCuts, f.s - f.w / 2 + 0.5, f.s + f.w / 2 - 0.5);
      }
    }
    // 方形角台
    const corners = [];
    for (const key of ['NW', 'NE', 'SE']) {
      const c = CORNERS[key];
      const pr = ring.project(c[0], c[1]);
      const i = ring.segs.findIndex((sg) => Math.abs(sg.a[0] - c[0]) < 0.01 && Math.abs(sg.a[1] - c[1]) < 0.01);
      const n2 = ring.segs[i], n1 = ring.segs[(i - 1 + ring.segs.length) % ring.segs.length];
      corners.push({ key, x: c[0], z: c[1], s: n2.s0, u: [n1.nx, n1.nz], v: [n2.nx, n2.nz], by: baseAt(n2.s0) });
      addCut(outCuts, n2.s0 - 10, n2.s0 + 10);
    }
    // 西南圆角台
    const swPr = ring.project(swMid[0], swMid[1]);
    const sw = { key: 'SW', x: swMid[0] + swOut[0] * 3, z: swMid[1] + swOut[1] * 3, s: swPr.s, by: baseAt(swPr.s), out: swOut };
    addCut(outCuts, sw.s - 17, sw.s + 17);
    // 马面
    const mamian = [];
    for (const m of mamianData) {
      const [x, z] = m.center_on_centerline;
      const pr = ring.project(x, z);
      if (bodyCuts.some(([a, b]) => pr.s > a - 12 && pr.s < b + 12)) continue;
      if (mainGates.some((g) => Math.abs(pr.s - g.s) < g.spec.W + 12)) continue;
      if (corners.some((c) => Math.abs(ring.wrap(pr.s - c.s + L / 2) - L / 2) < 30) || Math.abs(pr.s - sw.s) < 40) continue;
      const f = ring.frame(pr.s);
      const w = Math.max(14, Math.min(26, m.width_along_wall_m || 20)), proj = Math.max(8, Math.min(15, m.projection_beyond_face_m || 11));
      mamian.push({ s: pr.s, f, w, proj, by: baseAt(pr.s) });
      addCut(outCuts, pr.s - (w / 2 - 1.5), pr.s + (w / 2 - 1.5));
    }

    // —— 城墙本体 ——
    const bufs = { brick: new MeshBuf(), pave: new MeshBuf(), stone: new MeshBuf() };
    const merl = [];
    const lamps = [];
    // 站点
    const sList = [];
    for (const sg of ring.segs) {
      const n = Math.max(1, Math.ceil(sg.len / 12));
      for (let k = 0; k < n; k++) sList.push({ s: sg.s0 + (sg.len * k) / n, v: k === 0 });
    }
    for (const s of forced) sList.push({ s: ring.wrap(s), v: false });
    sList.sort((a, b) => a.s - b.s);
    const stations = [];
    for (const it of sList) {
      if (stations.length && it.s - stations[stations.length - 1].s < 0.05) {
        if (it.v) stations[stations.length - 1].v = true;
        continue;
      }
      stations.push(it);
    }
    stations.push({ s: L, v: true });
    const mk = (it) => {
      const f = ring.frame(it.s >= L ? 0 : it.s);
      let nx = f.nx, nz = f.nz, sc = 1;
      if (it.v) {
        const sgI = ring.segs.indexOf(ring.segAt(it.s >= L ? 0 : it.s));
        const vm = ring.vm[sgI];
        nx = vm.nx; nz = vm.nz; sc = vm.sc;
      }
      const b = baseAt(it.s);
      const lo = Math.min(hAt(f.x + nx * OB * sc, f.z + nz * OB * sc), b) - 1.2;
      const loI = Math.min(hAt(f.x + nx * IB * sc, f.z + nz * IB * sc), b) - 1.2;
      return { x: f.x, z: f.z, tx: f.tx, tz: f.tz, nx, nz, sc, s: it.s, b, lo, loI };
    };
    const ST = stations.map(mk);
    const runs = (cuts) => {
      const out = [];
      let cur = null;
      for (let k = 0; k < ST.length - 1; k++) {
        const mid = (ST[k].s + ST[k + 1].s) / 2;
        if (!inCuts(mid, cuts, L)) {
          if (!cur) { cur = [ST[k]]; out.push(cur); }
          cur.push(ST[k + 1]);
        } else cur = null;
      }
      // 闭环首尾相接
      if (out.length > 1 && out[0][0].s === 0 && out[out.length - 1][out[out.length - 1].length - 1].s === L) {
        const last = out.pop();
        out[0] = last.concat(out[0].slice(1));
      }
      return out;
    };
    const WSEC = { oB: OB, oT: OT, iB: IB, iT: IT, H };
    for (const r of runs(bodyCuts)) emitBody(bufs, r, WSEC);
    const shiftPts = (r, oc) => r.map((p) => ({ x: p.x + p.nx * oc * p.sc, z: p.z + p.nz * oc * p.sc, y: p.b + H, nx: p.nx, nz: p.nz, sc: p.sc, s: p.s }));
    const outlineRuns = [];
    for (const r of runs(outCuts)) {
      const pts = shiftPts(r, OT - PO.t / 2);
      emitParapet(bufs.brick, pts, PO.t, PO.h, merl);
      outlineRuns.push(pts.map((p) => [p.x + p.nx * (PO.t / 2 + 0.05) * p.sc, p.y + PO.h + MER.h * 0.5, p.z + p.nz * (PO.t / 2 + 0.05) * p.sc]));
    }
    for (const r of runs(inCuts_)) {
      const pts = shiftPts(r, IT + PIN.t / 2);
      emitParapet(bufs.brick, pts, PIN.t, PIN.h, null, false, 0.3);
      // 灯杆：每 24 m
      let acc = 12;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        while (acc < l) {
          const t = acc / l;
          lamps.push([a.x + (b.x - a.x) * t, a.y + PIN.h + (b.y - a.y) * t, a.z + (b.z - a.z) * t, a.nx, a.nz]);
          acc += 24;
        }
        acc -= l;
      }
    }

    // —— 马面 ——
    for (const m of mamian) {
      const f = m.f;
      const toW = (a, o) => [f.x + f.tx * a + f.nx * o, f.z + f.tz * a + f.nz * o];
      const o1 = OB + m.proj, bat = 1.5;
      const lo = Math.min(hAt(...toW(0, o1)), m.by) - 1.2;
      emitBlock(bufs, toW, -m.w / 2, m.w / 2, 4.5, o1, m.by, lo, H, bat, [1, 1, 0, 1], false);
      const A = m.w / 2 - bat;
      bufs.pave.quad(...[[-A, o1 - bat], [A, o1 - bat], [A, OT], [-A, OT]].map(([a, o]) => { const p = toW(a, o); return [p[0], m.by + H, p[1]]; }), [[-A, o1], [A, o1], [A, OT], [-A, OT]], [H, 0], [0, 1, 0]);
      const t = PO.t;
      const loop = [[-A + t / 2, OT - t], [-A + t / 2, o1 - bat - t / 2], [A - t / 2, o1 - bat - t / 2], [A - t / 2, OT - t]].map(([a, o]) => toW(a, o));
      const pts = polyFrames(loop, toW(0, OT), m.by + H);
      emitParapet(bufs.brick, pts, t, PO.h, merl, true);
      outlineRuns.push(pts.map((p) => [p.x + p.nx * (t / 2 + 0.05) * p.sc, p.y + PO.h + MER.h * 0.5, p.z + p.nz * (t / 2 + 0.05) * p.sc]));
    }

    // —— 方形角台 ——
    for (const c of corners) {
      const toW = (u, v) => [c.x + c.u[0] * u + c.v[0] * v, c.z + c.u[1] * u + c.v[1] * v];
      const lo = Math.min(hAt(...toW(15, 15)), c.by) - 1.5;
      const bat = 1.5, lo0 = -11.5, hi0 = 15.5;
      // emitBlock 的 (a,o)：a 沿 v，o 沿 u
      emitBlock(bufs, (a, o) => toW(o, a), lo0, hi0, lo0, hi0, c.by, lo, H, bat);
      const lo1 = lo0 + bat, hi1 = hi0 - bat, t = PO.t;
      const loop = [[OT - t, lo1 + t / 2], [hi1 - t / 2, lo1 + t / 2], [hi1 - t / 2, hi1 - t / 2], [lo1 + t / 2, hi1 - t / 2], [lo1 + t / 2, OT - t]].map(([u, v]) => toW(u, v));
      const pts = polyFrames(loop, toW(2, 2), c.by + H);
      emitParapet(bufs.brick, pts, t, PO.h, merl, true);
      outlineRuns.push(pts.map((p) => [p.x + p.nx * (t / 2 + 0.05) * p.sc, p.y + PO.h + MER.h * 0.5, p.z + p.nz * (t / 2 + 0.05) * p.sc]));
    }
    // —— 西南圆形角台 ——
    {
      const R0 = 19, R1 = 17.5, seg = 40, lo = Math.min(hAt(sw.x + sw.out[0] * 16, sw.z + sw.out[1] * 16), sw.by) - 1.5;
      const yT = sw.by + H;
      const a0 = Math.atan2(-sw.out[1], -sw.out[0]);
      for (let i = 0; i < seg; i++) {
        const A = a0 + (i / seg) * Math.PI * 2, B = a0 + ((i + 1) / seg) * Math.PI * 2;
        const pa = [Math.cos(A), Math.sin(A)], pb = [Math.cos(B), Math.sin(B)];
        const E = [pa[0] + pb[0], 0.1, pa[1] + pb[1]];
        const uA = (i / seg) * 2 * Math.PI * R0, uB = ((i + 1) / seg) * 2 * Math.PI * R0;
        bufs.brick.quad([sw.x + pa[0] * R0, lo, sw.z + pa[1] * R0], [sw.x + pb[0] * R0, lo, sw.z + pb[1] * R0], [sw.x + pb[0] * R1, yT, sw.z + pb[1] * R1], [sw.x + pa[0] * R1, yT, sw.z + pa[1] * R1],
          [[uA, lo - sw.by], [uB, lo - sw.by], [uB, H], [uA, H]], [[0, 1], [0, 1], [H, 0.5], [H, 0.5]], E);
        bufs.pave.tri([sw.x, yT, sw.z], [sw.x + pb[0] * R1, yT, sw.z + pb[1] * R1], [sw.x + pa[0] * R1, yT, sw.z + pa[1] * R1], [[sw.x, sw.z], [sw.x + pb[0] * R1, sw.z + pb[1] * R1], [sw.x + pa[0] * R1, sw.z + pa[1] * R1]], [H, 0], [0, 1, 0]);
      }
      const arc = [];
      const Rp = R1 - PO.t / 2;
      for (let i = 0; i <= 64; i++) {
        const A = a0 + (i / 64) * Math.PI * 2;
        const x = sw.x + Math.cos(A) * Rp, z = sw.z + Math.sin(A) * Rp;
        if (ring.project(x, z).off > OT - PO.t) arc.push([x, z]);
      }
      if (arc.length > 2) {
        const pts = polyFrames(arc, [sw.x, sw.z], yT);
        emitParapet(bufs.brick, pts, PO.t, PO.h, merl, true);
        outlineRuns.push(pts.map((p) => [p.x + p.nx * (PO.t / 2 + 0.05) * p.sc, p.y + PO.h + MER.h * 0.5, p.z + p.nz * (PO.t / 2 + 0.05) * p.sc]));
      }
    }

    // —— 瓮城 / 月城（与墙体同一套扫掠与材质） ——
    for (const g of mainGates) {
      const sp = g.spec;
      const toW = (a, o) => [g.x + g.X[0] * a + g.nx * o, g.z + g.X[1] * a + g.nz * o];
      const wc = sp.W - 7;
      const zA = sp.yue ? 66 : OB + sp.P - 7;
      g.zA = zA;
      const encl = (path2, half, halfTop, hh, cutMid, cutW, ref, openSide) => {
        const wpts = path2.map(([a, o]) => toW(a, o));
        const fr = polyFrames(wpts, toW(...ref), 0);
        const st = fr.map((p, i) => {
          const q = i < fr.length - 1 ? fr[i + 1] : fr[i - 1];
          const sgn = i < fr.length - 1 ? 1 : -1;
          const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
          return { ...p, tx: ((q.x - p.x) / l) * sgn, tz: ((q.z - p.z) / l) * sgn, b: g.by, lo: Math.min(hAt(p.x + p.nx * half, p.z + p.nz * half), g.by) - 1.2, loI: g.by - 1.2 };
        });
        // 细分 + 远端中央切口
        const dense = [];
        for (let k = 0; k < st.length - 1; k++) {
          const a = st[k], b = st[k + 1];
          const len = b.s - a.s;
          const cuts = [];
          if (k === cutMid) cuts.push(len / 2 - cutW / 2, len / 2 + cutW / 2);
          if (openSide && k !== cutMid) cuts.push(len / 2 - 4, len / 2 + 4);
          const n = Math.max(1, Math.ceil(len / 10));
          const ts = [];
          for (let i = 0; i <= n; i++) ts.push((len * i) / n);
          ts.push(...cuts);
          ts.sort((x, y) => x - y);
          for (const t of ts) {
            if (k > 0 && t === 0) continue;
            const f = t / len;
            const vtx = t === 0 || t === len;
            const src = t === 0 ? a : t === len ? b : null;
            dense.push({
              x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
              nx: vtx ? src.nx : a.nx, nz: vtx ? src.nz : a.nz,
              sc: vtx ? src.sc : 1, s: a.s + t, tx: (b.x - a.x) / len, tz: (b.z - a.z) / len, b: g.by,
              lo: Math.min(hAt(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f), g.by) - 1.2, loI: g.by - 1.2,
              cut: cuts.length === 2 && t > cuts[0] && t <= cuts[1] ? 1 : 0, k,
            });
          }
        }
        // 段内法线：用段自身法线（非顶点处）
        for (const p of dense) {
          const a = st[p.k], b = st[p.k + 1];
          if (p.sc === 1 && !(Math.abs(p.x - a.x) < 1e-6 && Math.abs(p.z - a.z) < 1e-6) && !(Math.abs(p.x - b.x) < 1e-6 && Math.abs(p.z - b.z) < 1e-6)) {
            let nx = -p.tz, nz = p.tx;
            if (nx * (a.nx + b.nx) + nz * (a.nz + b.nz) < 0) { nx = -nx; nz = -nz; }
            p.nx = nx; p.nz = nz;
          }
        }
        const sec = { oB: half, oT: halfTop, iB: -half, iT: -halfTop, H: hh };
        const pieces = [];
        let cur = [dense[0]];
        for (let i = 1; i < dense.length; i++) {
          if (dense[i].cut) { if (cur.length > 1) pieces.push(cur); cur = [dense[i]]; }
          else cur.push(dense[i]);
        }
        if (cur.length > 1) pieces.push(cur);
        for (const pc of pieces) {
          emitBody(bufs, pc, sec);
          const o = shiftPts(pc.map((p) => ({ ...p, b: p.b - H + hh })), halfTop - PO.t / 2);
          emitParapet(bufs.brick, o, PO.t, PO.h, merl);
          outlineRuns.push(o.map((p) => [p.x + p.nx * (PO.t / 2 + 0.05) * p.sc, p.y + PO.h + MER.h * 0.5, p.z + p.nz * (PO.t / 2 + 0.05) * p.sc]));
          emitParapet(bufs.brick, shiftPts(pc.map((p) => ({ ...p, b: p.b - H + hh })), -halfTop + PIN.t / 2), PIN.t, PIN.h, null, false, 0.3);
        }
      };
      encl([[-wc, OT - 0.3], [-wc, zA], [wc, zA], [wc, OT - 0.3]], 7, 5.8, H, 1, 62, [0, zA / 2], false);
      if (sp.yue) {
        g.zZ = sp.P + OB - 5;
        encl([[-35, zA + 5], [-35, g.zZ], [35, g.zZ], [35, zA + 5]], 5, 4.3, 10, 1, 34, [0, (zA + g.zZ) / 2], false);
      }
    }

    // —— 正楼城台顶的垛墙（朝瓮城）与女墙（朝城内） ——
    for (const g of mainGates) {
      const toW = (a, o) => [g.x + g.X[0] * a + g.nx * o, g.z + g.X[1] * a + g.nz * o];
      const bat = H * 0.06, A = MAIN_PLAT.w / 2 - bat;
      const oF = MAIN_PLAT.zc + MAIN_PLAT.d / 2 - bat, oK = MAIN_PLAT.zc - MAIN_PLAT.d / 2 + bat;
      const y = g.by + H + 0.08;
      const t = PO.t;
      const loopO = [[-A + t / 2, OT - t], [-A + t / 2, oF - t / 2], [A - t / 2, oF - t / 2], [A - t / 2, OT - t]].map(([a, o]) => toW(a, o));
      const po = polyFrames(loopO, toW(0, OT), y);
      emitParapet(bufs.brick, po, t, PO.h, merl, true);
      outlineRuns.push(po.map((p) => [p.x + p.nx * (t / 2 + 0.05) * p.sc, p.y + PO.h + MER.h * 0.5, p.z + p.nz * (t / 2 + 0.05) * p.sc]));
      const ti = PIN.t;
      const loopI = [[-A + ti / 2, IT + ti], [-A + ti / 2, oK + ti / 2], [A - ti / 2, oK + ti / 2], [A - ti / 2, IT + ti]].map(([a, o]) => toW(a, o));
      emitParapet(bufs.brick, polyFrames(loopI, toW(0, IT), y), ti, PIN.h, null, false, 0.3);
    }

    // —— 护城河驳岸（water.json 的 moat 多边形边缘砌条石） ——
    for (const poly of ctx.data?.water?.polys || []) {
      if (poly.k !== 'moat') continue;
      const p = poly.outer, n = p.length / 2;
      if (n < 3) continue;
      const hw = poly.h ?? hAt(p[0], p[1]) - 2;
      // 判定内侧方向
      const mx = (p[0] + p[2]) / 2, mz = (p[1] + p[3]) / 2;
      const dx = p[2] - p[0], dz = p[3] - p[1], dl = Math.hypot(dx, dz) || 1;
      const inSign = pointInPoly(mx - (dz / dl) * 0.6, mz + (dx / dl) * 0.6, p) ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[((i + 1) % n) * 2], bz = p[((i + 1) % n) * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const ix = (-(bz - az) / len) * inSign, iz = ((bx - ax) / len) * inSign;
        const m = Math.max(1, Math.ceil(len / 10));
        for (let k = 0; k < m; k++) {
          const t0 = k / m, t1 = (k + 1) / m;
          const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
          const y0 = Math.max(hAt(x0 - ix * 0.8, z0 - iz * 0.8) + 0.3, hw + 1.2), y1 = Math.max(hAt(x1 - ix * 0.8, z1 - iz * 0.8) + 0.3, hw + 1.2);
          const s0 = len * t0, s1 = len * t1;
          bufs.stone.quad([x0, hw - 1, z0], [x1, hw - 1, z1], [x1, y1, z1], [x0, y0, z0], [[s0, -1], [s1, -1], [s1, y1 - hw], [s0, y0 - hw]], [0, 0], [ix, 0, iz]);
          bufs.stone.quad([x0, y0, z0], [x1, y1, z1], [x1 - ix * 0.7, y1, z1 - iz * 0.7], [x0 - ix * 0.7, y0, z0 - iz * 0.7], [[s0, 0], [s1, 0], [s1, 0.7], [s0, 0.7]], [0, 0], [0, 1, 0]);
        }
      }
    }

    mark('几何');
    // —— 墙体网格 ——
    const matBrick = wallMaterial(ctx, 'brick');
    const matPave = wallMaterial(ctx, 'pave');
    const matStone = wallMaterial(ctx, 'stone');
    const addMesh = (buf, mat, name) => {
      if (!buf.c) return null;
      const m = new THREE.Mesh(buf.geometry(), mat);
      m.name = name;
      m.castShadow = true;
      m.receiveShadow = true;
      root.add(m);
      return m;
    };
    addMesh(bufs.brick, matBrick, '城墙·墙身');
    addMesh(bufs.pave, matPave, '城墙·海墁');
    addMesh(bufs.stone, matStone, '城墙·条石');

    // —— 垛（实例） + 垛口轮廓灯（实例） ——
    const mtx = new THREE.Matrix4(), X = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3();
    const setM = (im, i, x, y, z, nx, nz) => {
      Z.set(nx, 0, nz);
      X.set(nz, 0, -nx);
      mtx.makeBasis(X, Y, Z).setPosition(x, y, z);
      im.setMatrixAt(i, mtx);
    };
    const merlonMat = wallMaterial(ctx, 'brick', { flood: 2.0 });
    const merlons = new THREE.InstancedMesh(merlonGeometry(MER.w, MER.h, PO.t), merlonMat, merl.length);
    const ledMat = new THREE.MeshStandardMaterial({ color: 0x3b3833, emissive: 0xffbf5e, emissiveIntensity: 0, roughness: 0.5, metalness: 0.3 });
    ctx.night.register(ledMat, { day: 0, night: 4.2 });
    const leds = new THREE.InstancedMesh(merlonLedGeometry(MER.w, MER.h, PO.t, MER.gap, 0.055), ledMat, merl.length);
    const col = new THREE.Color();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    merl.forEach((m, i) => {
      setM(merlons, i, m[0], m[1], m[2], m[3], m[4]);
      setM(leds, i, m[0], m[1], m[2], m[3], m[4]);
      const k = 0.88 + rnd() * 0.22;
      merlons.setColorAt(i, col.setRGB(k, k, k * 0.98));
    });
    merlons.instanceMatrix.needsUpdate = true;
    merlons.castShadow = true;
    merlons.receiveShadow = true;
    merlons.name = '城墙·垛';
    leds.name = '城墙·垛口轮廓灯';
    leds.instanceMatrix.needsUpdate = true;
    merlons.computeBoundingSphere();
    leds.computeBoundingSphere();
    root.add(merlons, leds);

    // —— 远景轮廓灯线（屏幕恒宽） ——
    const outline = outlineLines(ctx, outlineRuns, { color: 0xffb55a, intensity: 2.4, pix: 0.0008 });
    root.add(outline);

    // —— 墙顶灯杆 + 红灯笼（实例） ——
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2826, roughness: 0.5, metalness: 0.6 });
    const posts = new THREE.InstancedMesh(lampPostGeometry(), postMat, lamps.length);
    const lb = new ArchBuilder(ctx, { detail: 1, instancing: true, minInstances: 8, name: 'wall-lanterns' });
    lamps.forEach((l, i) => {
      setM(posts, i, l[0], l[1], l[2], l[3], l[4]);
      lantern(lb, l[0] + l[3] * 0.9, l[1] + 1.55, l[2] + l[4] * 0.9, { kind: 'round', size: 0.62, color: 0xd8281a });
    });
    posts.instanceMatrix.needsUpdate = true;
    posts.computeBoundingSphere();
    posts.name = '城墙·灯杆';
    const lanternGroup = lb.build({ castShadow: false, name: '城墙·灯笼' });
    const smallGroup = new THREE.Group();
    smallGroup.add(posts, lanternGroup);
    root.add(smallGroup);

    mark('墙体+灯');
    // —— 城门群 / 角楼（古建构件库） ——
    const FLOOD = { color: 0xffc47a, strength: 1.7, height: 24, top: 0.45 };
    const complexes = [];
    const glowEaves = (b, info) => eaveLights(b, info, { color: 0xffc56a, width: 0.08 });
    for (const g of mainGates) {
      const sp = g.spec;
      const fn = (b) => {
        // 正楼
        b.push(0, 0, MAIN_PLAT.zc, 0);
        const t = gateTower(b, {
          w: MAIN_PLAT.w, d: MAIN_PLAT.d, h: H, tunnels: 1, tw: 6, th: 7, crenel: false, plaque: sp.plaque, roofColor: 'darkgray',
          tower: { lanterns: true },
        });
        glowEaves(b, t);
        b.pop();
        // 箭楼（瓮城外墙上）
        // 城台 62×22；箭楼楼身外移 3 m，抱厦朝内（瓮城）
        b.push(0, 0, g.zA, 0);
        cityPlatform(b, { w: 62, d: 22, h: H, tunnels: sp.arrowTunnel, tw: 6, th: 7, crenel: false, inner: [] });
        b.pop();
        b.push(0, 0, g.zA + 3, Math.PI);
        const a = arrowTower(b, { w: 52, d: 12.5, h: 13.5, rows: 4, cols: 12, sideCols: 3, roofColor: 'darkgray', y0: H + 0.08 });
        glowEaves(b, a);
        b.pop();
        // 闸楼 + 吊桥（永宁门）
        if (sp.yue) {
          b.push(0, 0, g.zZ, 0);
          const z = gateTower(b, {
            w: 34, d: 12, h: 10, tunnels: 1, tw: 5, th: 6, crenel: false, plaque: sp.plaque, roofColor: 'darkgray',
            hall: { bays: [3.4, 4, 4.6, 4, 3.4], depthBays: [3.4, 3.4], colH: 4.2, roof: 'xieshan', eaves: 1, front: 'windows', back: 'center3', sides: 'wall', lanterns: true },
          });
          glowEaves(b, z);
          // 吊桥：木桥面 + 栏杆 + 铁链
          const z0 = 6, z1 = 30;
          b.box('paint', -3.6, 0.2, z0, 3.6, 0.75, z1, 0x5b4231);
          for (const sx of [-1, 1]) {
            b.box('paint', sx * 3.5 - 0.1, 0.75, z0, sx * 3.5 + 0.1, 1.85, z1, 0x4a3426, { skip: 'bottom' });
            b.sweep('metal', [[sx * 3.4, 1.8, z1 - 0.5], [sx * 3.2, 5.5, (z0 + z1) / 2 - 3], [sx * 2.8, 8.2, z0 - 0.3]], [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]], 0x3a3634, { caps: false });
          }
          b.pop();
        }
      };
      complexes.push({ key: g.g.id, x: g.x, z: g.z, y: g.by, theta: g.theta, fn, r: sp.P + 60 });
    }
    const cornerTower = (b) => {
      const t = multiStoreyTower(b, {
        style: 'ming', roofColor: 'darkgray', platform: 'plain', platformH: 0.45, steps: 'none', y0: H,
        storeys: [
          { bays: [3.4, 4.2, 3.4], depthBays: [3.4, 4.2, 3.4], colH: 4.4, front: 'center3', back: 'windows', sides: 'windows' },
          { colH: 3.6, front: 'windows', back: 'windows', sides: 'windows' },
        ],
        pingzuo: true, balcony: 1.2, topEaves: 2, roof: 'xieshan', lanterns: true,
      });
      glowEaves(b, t);
    };
    for (const c of corners) {
      const cx = c.x + (c.u[0] + c.v[0]) * 2, cz = c.z + (c.u[1] + c.v[1]) * 2;
      const d = norm([c.u[0] + c.v[0], c.u[1] + c.v[1]]);
      complexes.push({ key: 'corner' + c.key, x: cx, z: cz, y: c.by, theta: Math.atan2(c.u[0], c.u[1]), fn: cornerTower, r: 40 });
      void d;
    }
    complexes.push({ key: 'cornerSW', x: sw.x, z: sw.z, y: sw.by, theta: Math.atan2(sw.out[0], sw.out[1]), fn: cornerTower, r: 40 });

    // 近景 LOD：初始只建 detail 0；相机靠近时按需补建 detail 1（< 1300 m）与 detail 2（< 520 m），每帧至多一个
    const nearLODs = [];
    const mkLevel = (c, d) => buildArch(ctx, c.fn, { detail: d, flood: { ...FLOOD, baseY: c.y + H }, name: c.key + '-d' + d });
    const relevel = (n) => {
      const lod = n.lod;
      for (const l of [...lod.children]) lod.remove(l);
      lod.levels.length = 0;
      let dist = 0;
      if (n.l[2]) { lod.addLevel(n.l[2], 0); dist = 420; }
      if (n.l[1]) { lod.addLevel(n.l[1], dist); dist = 1000; }
      lod.addLevel(n.l[0], dist);
    };
    for (const c of complexes) {
      const lod = new THREE.LOD();
      lod.position.set(c.x, c.y, c.z);
      lod.rotation.y = c.theta;
      lod.name = c.key;
      lod.visible = false;
      root.add(lod);
      const n = { lod, c, l: [mkLevel(c, 0), null, null] };
      relevel(n);
      nearLODs.push(n);
    }
    mark('近景LOD');
    // 远景合批（全部城门群 + 角楼，detail 0）
    const fb = new ArchBuilder(ctx, { detail: 0, name: 'citywall-far' });
    let avgY = 0;
    for (const c of complexes) {
      fb.push(c.x, c.y, c.z, c.theta);
      c.fn(fb);
      fb.pop();
      avgY += c.y;
    }
    avgY /= complexes.length || 1;
    const farGroup = fb.build({ flood: { ...FLOOD, baseY: avgY + H }, name: '城门群·远景' });
    root.add(farGroup);

    mark('远景');
    // —— 现代城门、敌楼、魁星楼（合批，detail 1） ——
    const mb = new ArchBuilder(ctx, { detail: 1, name: 'citywall-misc' });
    const d0 = 2 * OB + 0.6;
    for (const g of modernGates) {
      mb.push(g.x, g.by, g.z, g.theta);
      mb.push(0, 0, 0, 0);
      // 城台（不带城楼）
      const cp = { w: g.w, d: d0, h: H, tunnels: g.n, tw: g.tw, th: Math.min(8, g.tw * 1.05), crenel: false, batter: 0.3, color: 0x938f86 };
      // 直接用构件库城台（chinese-wall.cityPlatform 经 gateTower 暴露的参数）
      cityPlatformLite(mb, cp);
      mb.plaque(g.g.name, 0, 9.9, d0 / 2 - 0.2, 5.6, 1.55, { bg: '#5d5850', color: '#f2e6c4', border: '#a09682' });
      mb.push(0, 0, 0, Math.PI);
      mb.plaque(g.g.name, 0, 9.9, d0 / 2 - 0.2, 5.6, 1.55, { bg: '#5d5850', color: '#f2e6c4', border: '#a09682' });
      mb.pop();
      mb.pop();
      mb.pop();
    }
    // 敌楼：四大城门两侧最近的马面（现状复建位置取近似）
    const dilou = new Set();
    for (const g of mainGates) {
      let bestL = null, bestR = null;
      for (const m of mamian) {
        const d = ring.wrap(m.s - g.s + L / 2) - L / 2;
        if (d < 0 && (!bestL || d > bestL.d)) bestL = { m, d };
        if (d > 0 && (!bestR || d < bestR.d)) bestR = { m, d };
      }
      if (bestL) dilou.add(bestL.m);
      if (bestR) dilou.add(bestR.m);
    }
    for (const m of dilou) {
      const f = m.f;
      const o = (OT + OB + m.proj - 1.5) / 2;
      mb.push(f.x + f.nx * o, m.by + H, f.z + f.nz * o, Math.atan2(f.nx, f.nz));
      const t = hall(mb, { bays: [3.2, 3.8, 3.2], depthBays: [3.0, 3.0], colH: 3.6, roof: 'xieshan', eaves: 1, roofColor: 'darkgray', platform: 'plain', platformH: 0.3, steps: 'none', front: 'windows', back: 'center3', sides: 'wall', lanterns: true });
      eaveLights(mb, t, { color: 0xffc56a, width: 0.07 });
      mb.pop();
    }
    // 魁星楼（文昌门东侧城墙上）
    const wen = modernGates.find((g) => g.g.id === 'wenchang');
    if (wen) {
      const s = wen.s - 42;
      const f = ring.frame(s);
      mb.push(f.x, baseAt(s) + H, f.z, Math.atan2(f.nx, f.nz));
      const t = pavilion(mb, { sides: 4, size: 6.4, eaves: 2, colH: 3.8, roofColor: 'darkgray', roof: 'xieshan', platformH: 0.5 });
      eaveLights(mb, t, { color: 0xffc56a, width: 0.07 });
      mb.pop();
    }
    const miscGroup = mb.build({ flood: { ...FLOOD, baseY: avgY + H }, name: '现代城门·敌楼' });
    root.add(miscGroup);

    mark('杂项');
    // —— 灯光与标注 ——
    for (const g of mainGates) {
      const W = (a, o, y) => new THREE.Vector3(g.x + g.X[0] * a + g.nx * o, g.by + y, g.z + g.X[1] * a + g.nz * o);
      ctx.lights.add({ position: W(0, MAIN_PLAT.zc + 22, 3), color: 0xffb566, intensity: 1400, distance: 90, nightOnly: true, priority: 2.2 });
      ctx.lights.add({ position: W(0, g.zA + 16, 3), color: 0xffb566, intensity: 1000, distance: 70, nightOnly: true, priority: 1.8 });
      if (g.spec.yue) ctx.lights.add({ position: W(0, g.zZ + 14, 2), color: 0xffb566, intensity: 700, distance: 50, nightOnly: true, priority: 1.6 });
      ctx.labels.add(g.spec.label, W(0, MAIN_PLAT.zc, 40), { category: 'landmark', minDist: 80, maxDist: 16000, priority: g.spec.yue ? 3.2 : 2.6 });
    }
    ctx.labels.add('西安城墙', new THREE.Vector3(-1990, baseAt(ring.project(-1990, -600).s) + 30, -600), { category: 'landmark', minDist: 500, maxDist: 20000, priority: 2.4 });

    // —— LOD 管理 ——
    const cam = ctx.camera;
    let nearMode = null;
    const bx0 = -2000, bx1 = 2235, bz0 = -1870, bz1 = 855;
    const update = () => {
      const p = cam.position;
      let dmin = Infinity;
      for (const { c } of nearLODs) {
        const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) - c.r;
        if (d < dmin) dmin = d;
      }
      const nm = dmin < 1500;
      if (nm) {
        let best = null, bd = Infinity, bl = 0;
        for (const n of nearLODs) {
          const d = Math.hypot(p.x - n.c.x, p.y - n.c.y, p.z - n.c.z) - n.c.r * 0.5;
          const want = d < 520 ? 2 : d < 1300 ? 1 : 0;
          for (let lv = 1; lv <= want; lv++)
            if (!n.l[lv] && d < bd) { bd = d; best = n; bl = lv; break; }
        }
        if (best) {
          best.l[bl] = mkLevel(best.c, bl);
          relevel(best);
        }
      }
      if (nm !== nearMode) {
        nearMode = nm;
        farGroup.visible = !nm;
        for (const n of nearLODs) n.lod.visible = nm;
      }
      // 距城墙线的距离（矩形边界近似）
      const inside = p.x > bx0 && p.x < bx1 && p.z > bz0 && p.z < bz1;
      const dx = Math.max(bx0 - p.x, 0, p.x - bx1), dz = Math.max(bz0 - p.z, 0, p.z - bz1);
      const edge = inside ? Math.min(p.x - bx0, bx1 - p.x, p.z - bz0, bz1 - p.z) : Math.hypot(dx, dz);
      const dWall = Math.hypot(edge, Math.max(0, p.y - 420));
      smallGroup.visible = dWall < 1400;
      leds.visible = dWall < 2200;
      merlons.visible = dWall < 6000;
      outline.visible = ctx.uniforms.uNight.value > 0.02;
    };
    update();
    console.info(`[citywall] 构建 ${(performance.now() - t0).toFixed(0)} ms：墙体三角 ${((bufs.brick.i.length + bufs.pave.i.length + bufs.stone.i.length) / 3) | 0}，垛 ${merl.length}，灯 ${lamps.length}，马面 ${mamian.length}，城门群 ${complexes.length}｜${tl.join(' / ')}`);

    return {
      update,
      setLayer(layer, on) {
        if (layer === 'citywall') root.visible = on;
      },
      setQuality(q) {
        void q;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};

// 现代城门城台：复用构件库城台（券洞 + 收分 + 土衬石 + 顶面海墁），不做垛口（墙顶垛墙连续跨过）
function cityPlatformLite(b, o) {
  cityPlatform(b, { ...o, inner: [] });
}
