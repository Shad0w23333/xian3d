// 西安明城墙（整体重写）：13.74 km 城墙本体 + 91 马面 + 18 城门（含全部券洞） + 3 方角台角楼 + 西南圆形角台 + 护城河驳岸 + 夜景。
//
// 调研要点（写入常量）：
//  · 墙高 12 m，顶宽 12~14 m，底宽 15~18 m（中线→外皮 8.1 m 取自 OSM 实测，外侧收分 1.5 m）。
//  · 垛口 5984 个 / 13.74 km → 垛距约 2.3 m（垛宽 1.8 + 垛口 0.5），垛墙高约 2 m，内侧女墙约 1 m。
//  · 马面 91 个（数据 wall_mamian），间距约 120~140 m，宽约 20 m、外凸约 11 m；部分马面复建敌楼（取四门两侧）。
//  · 四门三重：闸楼（月城）→ 箭楼（瓮城外墙）→ 正楼。正楼面阔七间、重檐歇山三滴水、高约 36 m（含城台）；
//    箭楼面阔十一间、长 52.6 m、宽 13 m、距地 31~33 m、单檐歇山，正面四层箭窗每层 12 孔、两侧每层 3 孔；
//    永宁门箭楼下不开门洞（入城经瓮城），城台门洞宽高约 6 m。匾额：永寧門 / 安遠門 / 長樂門 / 安定門。
//  · 城角：东南、东北、西北为直角城角 + 方形角台（角台上现有小角亭）；西南角城墙本身仍为直角，
//    角台为圆形（沿用唐皇城西南角圆台旧制）：卫星图实测台顶直径约 20 m、台心位于两外墙面外约 4 m，
//    台体高出墙顶约 1.9 m，台顶无楼，仅铺地与垛口（Esri z19 影像核对，2026-09）。
//  · 券洞（道路穿墙处都有）：四门（永宁/安远/长乐/安定）瓮城两侧各新辟 3 孔（永宁门 1956 年东西各 3 孔、
//    长乐门南北两侧共 6 孔）；近现代城门按资料与道路（roads.json 穿墙位置/宽度）对齐布置，见 GATE_HOLES。
//    券洞与墙身同一套截面（收分、土衬石、海墁）一体生成，真实贯通：拱顶/侧墙/券脸，道路从洞中穿过。
//  · 魁星楼：文昌门券洞西侧约 27 m 的城墙顶（影像核对）。
import * as THREE from 'three';
import { ArchBuilder, buildArch, gateTower, arrowTower, multiStoreyTower, hall, pavilion, eaveLights, lantern, cityPlatform } from '../arch/chinese.js';
import { MeshBuf, wallMaterial, merlonGeometry, merlonLedGeometry, lampPostGeometry, outlineLines } from '../arch/citywall-kit.js';
import { pointInPoly } from '../core/util.js';
import { shadowReach } from '../arch/perf-lod.js';

// 城墙中心线（data-src/landmarks_historic/wall_centerline.json 的 polygon，自西北角顺时针）
const CENTERLINE = [[-1993.2, -1796.8], [-230.9, -1825.6], [-39.3, -1827.5], [-36.6, -1824.5], [-14.0, -1824.5], [64.4, -1831.9], [64.4, -1834.9], [98.4, -1835.7], [2228.6, -1863.1], [2221.8, -1123.4], [2221.2, -546.1], [2221.2, -543.2], [2217.1, -543.1], [2217.5, -519.6], [2221.7, -519.5], [2222.0, -24.9], [2219.9, -3.9], [2224.0, 55.5], [2225.0, 792.3], [1031.3, 848.1], [751.7, 842.6], [28.1, 841.9], [-293.9, 845.6], [-1282.7, 848.0], [-1297.7, 847.9], [-1300.9, 845.0], [-1390.7, 845.0], [-1392.2, 848.7], [-1480.1, 849.6], [-1981.8, 849.6], [-1985.0, 76.8], [-1982.7, 38.3], [-1987.5, -117.2], [-1984.4, -1066.2], [-1986.7, -1080.1]];
const CORNERS = { NW: [-1993.2, -1796.8], NE: [2228.6, -1863.1], SE: [2225.0, 792.3], SW: [-1981.8, 849.6] };

const H = 12; // 墙高
const OB = 8.1, OT = 6.6, IB = -8.1, IT = -6.6; // 中线→外/内皮（底/顶）
const PO = { t: 0.62, h: 1.25 }; // 外侧垛墙下段（垛口底以下）
const PIN = { t: 0.5, h: 1.0 }; // 内侧女墙
const MER = { w: 1.8, h: 0.72, gap: 0.5 };
const MSTEP = MER.w + MER.gap;
// 西南圆形角台：台心在两外墙顶皮外约 4 m（沿两外法线，距中线 off），台顶半径 rT、底半径 rB，高出墙顶 up
const SW_TOWER = { off: OT + 4, rT: 10, rB: 11.2, up: 1.9 };

// 四大城门：W=瓮城外皮半宽，P=外凸（数据 other_protrusions），月城仅永宁门
const MAIN = {
  yongning: { plaque: '永寧門', W: 58, P: 130, arrowTunnel: 0, yue: true, label: '永宁门' },
  anyuan: { plaque: '安遠門', W: 44, P: 81, arrowTunnel: 1, label: '安远门' },
  changle: { plaque: '長樂門', W: 45, P: 80, arrowTunnel: 1, label: '长乐门' },
  anding: { plaque: '安定門', W: 52, P: 77, arrowTunnel: 1, label: '安定门' },
};
/**
 * 券洞表（"侧门小洞洞"）：gateId → 若干组连续券洞，每组 = [[中心, 宽, {crown 拱顶高, spring 起拱高}?], ...]
 * 中心为相对城门中线投影点的沿墙里程（m，里程沿中心线顺时针：北墙西→东、东墙北→南、南墙东→西、西墙南→北）。
 * 数量依据：永宁门东西各 3 孔（1956）；长乐门南北两侧共 6 孔；安远/安定门同制；玉祥门 5 孔（中孔约 20 m 机动车、
 * 两侧 4 孔各约 8 m、高约 8 m，1996 重建）；解放门 3 个拱桥式大跨门洞（中 84 m、两侧各 58 m，2004）；
 * 尚德/尚俭/尚勤门 3 孔；中山门 2 孔（东征门/凯旋门，分列城台南北两侧）；勿幕门单孔；和平门 4 孔（1953）；
 * 朱雀门、文昌门 4 孔；朝阳门 4 孔（两条 3 车道单向道路 + 两侧人行）；含光门：中段为唐含光门遗址博物馆，
 * 交通走东西两侧券洞。位置/宽度与 public/data/roads.json 的道路穿墙点逐一对齐（车行孔宽 ≥ 路宽）。
 */
const GATE_HOLES = {
  yongning: [[[-72, 11.5], [-61.5, 4.5], [-82.5, 4.5]], [[73, 11.5], [62.5, 4.5], [83.5, 4.5]]],
  anyuan: [[[-76, 9.5], [-65.5, 5], [-86.5, 5]], [[58, 9.5], [48.5, 4.5], [67.5, 5]]],
  changle: [[[-80, 9], [-69.5, 5], [-90.5, 5]], [[66, 12.5], [53.5, 5], [78.5, 5]]],
  anding: [[[-74, 11.5], [-63.5, 4.5], [-84.5, 4.5]], [[73, 11.5], [62.5, 4.5], [83.5, 4.5]]],
  shangwu: [[[-5, 7.6], [5, 7.6], [-13.7, 5], [13.7, 5]]],
  shangde: [[[-3, 9], [-13, 5], [7, 5]]],
  jiefang: [[[-2, 84, { crown: 8.8, spring: 1.0 }], [-76, 58, { crown: 8.0, spring: 1.0 }], [72, 58, { crown: 8.0, spring: 1.0 }]]],
  shangjian: [[[-1, 8.5], [-11.25, 5], [9.25, 5]]],
  shangqin: [[[-3, 7], [-12.5, 5], [6.5, 5]]],
  chaoyang: [[[-11, 11.5], [3, 11.5], [-21.5, 4.5], [13.5, 4.5]]],
  zhongshan: [[[-30, 8.5]], [[24, 8.5]]],
  jianguo: [[[2, 8.5], [-8.5, 5], [12.5, 5]]],
  heping: [[[-15, 5], [-6, 8], [7, 14], [18.5, 5]]],
  wenchang: [[[-9, 7.6], [1, 7.6], [-17.3, 4.5], [9.3, 4.5]]],
  zhuque: [[[-6, 8.5], [6, 8.5], [-16.5, 5], [16.5, 5]]],
  wumu: [[[2, 7.5]]],
  hanguang: [[[-54, 9], [-64, 7]], [[61, 9], [71.5, 6.5]]],
  yuxiang: [[[-0.6, 22, { crown: 8.6, spring: 3.2 }], [-17.6, 8], [-27.6, 8], [16.4, 8], [26.4, 8]]],
};
const HOLE_END = 3; // 券洞组两端到墙体切口的余量（m）
const MAIN_PLAT = { w: 56, d: 30, zc: -3 }; // 正楼城台

// ───────────── 中心线几何 ─────────────
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

/**
 * 构建城墙中心线环：券洞组范围内的中心线折点（OSM 中心线在城门附近的 3 m 小错台/微折）拉直，
 * 保证带洞墙段是一段直墙，与两端墙身截面、墙顶垛墙严丝合缝。四角折点保留。
 */
function wallRing(gates) {
  const r0 = new Ring(CENTERLINE.map((p) => p.slice()));
  const keep = new Set(Object.values(CORNERS).map((c) => c.join(',')));
  const drop = new Set();
  for (const g of gates) {
    const groups = GATE_HOLES[g.id];
    if (!groups) continue;
    const s = r0.project(g.world?.x ?? g.x, g.world?.z ?? g.z).s;
    for (const grp of groups) {
      const a0 = Math.min(...grp.map(([c, w]) => c - w / 2)) - HOLE_END, a1 = Math.max(...grp.map(([c, w]) => c + w / 2)) + HOLE_END;
      r0.segs.forEach((sg, i) => {
        if (sg.s0 > s + a0 - 0.5 && sg.s0 < s + a1 + 0.5 && !keep.has(sg.a.join(','))) drop.add(i);
      });
    }
  }
  return new Ring(r0.P.filter((_, i) => !drop.has(i)));
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
function emitParapet(buf, pts, t, h, merl = null, perSeg = false, floodK = 0.45, smooth = false) {
  if (pts.length < 2) return;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const E = [a.nx + b.nx, 0, a.nz + b.nz];
    const hs0 = [H, floodK], hs1 = [H + h, floodK * 0.85];
    const uvs = [[a.s, H], [b.s, H], [b.s, H + h], [a.s, H + h]], hsI = [[H, 0.2], [H, 0.2], [H + h, 0.2], [H + h, 0.2]];
    if (smooth) {
      // 圆弧垛墙：逐顶点径向法线，消除折面感
      const na = [a.nx, 0, a.nz], nb = [b.nx, 0, b.nz], ma = [-a.nx, 0, -a.nz], mb = [-b.nx, 0, -b.nz];
      buf.quadN(P3(a, t / 2, a.y), P3(b, t / 2, b.y), P3(b, t / 2, b.y + h), P3(a, t / 2, a.y + h), uvs, [hs0, hs0, hs1, hs1], [na, nb, nb, na]);
      buf.quadN(P3(a, -t / 2, a.y), P3(b, -t / 2, b.y), P3(b, -t / 2, b.y + h), P3(a, -t / 2, a.y + h), uvs, hsI, [ma, mb, mb, ma]);
    } else {
      buf.quad(P3(a, t / 2, a.y), P3(b, t / 2, b.y), P3(b, t / 2, b.y + h), P3(a, t / 2, a.y + h), uvs, [hs0, hs0, hs1, hs1], E);
      buf.quad(P3(a, -t / 2, a.y), P3(b, -t / 2, b.y), P3(b, -t / 2, b.y + h), P3(a, -t / 2, a.y + h), uvs, hsI, [-E[0], 0, -E[2]]);
    }
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

// ───────────── 券洞（贯通城墙的拱形门洞） ─────────────
// 墙身截面（与 emitBody 一致）：外皮 y≤0.9 为土衬石（OB+0.12），其上砖面自 O_PL 收分到 OT；内皮 y≤0.6 为条石，其上 I_PL→IT。
const O_PL = OB - ((OB - OT) * 0.9) / H, I_PL = IB + ((IT - IB) * 0.6) / H;
const oOutB = (y) => O_PL + ((OT - O_PL) * (y - 0.9)) / (H - 0.9); // 外砖面
const oInB = (y) => I_PL + ((IT - I_PL) * (y - 0.6)) / (H - 0.6); // 内砖面

/**
 * 券洞拱线：宽 w、拱顶高 crown、起拱高 spring。半圆能放下就用半圆（起拱 = crown − w/2），
 * 否则用弓形拱（大跨，如解放门/玉祥门中孔）。返回 {spring, pts:[[a,y,na,ny]]}（na,ny 为指向拱心的单位法线）。
 */
function archProfile(cx, w, crown, spring) {
  const r = w / 2;
  const pts = [];
  let ys, R, yc, th;
  if (crown - r >= spring - 1e-6) {
    ys = crown - r;
    R = r;
    yc = ys;
    th = Math.PI / 2;
  } else {
    const f = crown - spring;
    R = (r * r + f * f) / (2 * f);
    yc = crown - R;
    th = Math.asin(Math.min(1, r / R));
    ys = spring;
  }
  const n = Math.max(20, Math.min(96, Math.ceil((2 * th * R) / 0.45)));
  for (let i = 0; i <= n; i++) {
    const a = Math.PI / 2 + th - (2 * th * i) / n;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = i === 0 ? cx - r : i === n ? cx + r : cx + ca * R;
    const y = i === 0 || i === n ? ys : yc + sa * R;
    pts.push([x, y, -ca, -sa]);
  }
  return { spring: ys, pts, R };
}

/** 券洞默认尺寸：拱顶高随宽度增长，封顶 9.2 m（上方留出匾额与海墁） */
function holeDims(w, o = {}) {
  const crown = o.crown ?? Math.min(9.2, 3.6 + 0.7 * w);
  const spring = o.spring ?? Math.max(1.2, crown - w / 2);
  return { crown, spring };
}

/**
 * 一段带券洞的墙身（替换 [stA.s, stB.s] 间的普通墙身，两端与墙身截面严丝合缝）：
 * 内外立面（开洞多边形三角化）、土衬石与石沿、洞内两侧墙（三段对应土衬/条石/砖面）与拱顶（逐顶点法线）、
 * 券脸（凸出 7 cm 的砖券）、顶面海墁。垛墙/女墙沿用整圈墙顶的连续扫掠，不在此处生成。
 * holes：[{c, w, crown, spring}]（c 相对 stA 的沿墙距离）。lo：相对墙基的地下埋深（负值）。
 */
function emitHoleWall(bufs, stA, stB, holes, lo) {
  const { brick, pave, stone } = bufs;
  const Lb = stB.s - stA.s;
  const W = (a, o, y) => {
    const t = a / Lb;
    const A = P3(stA, o, 0), B = P3(stB, o, 0);
    return [A[0] + (B[0] - A[0]) * t, stA.b + (stB.b - stA.b) * t + y, A[2] + (B[2] - A[2]) * t];
  };
  const tl = Math.hypot(stB.x - stA.x, stB.z - stA.z) || 1;
  const T = [(stB.x - stA.x) / tl, 0, (stB.z - stA.z) / tl];
  const Nn = norm([stA.nx + stB.nx, stA.nz + stB.nz]);
  const EO = [Nn[0], 0.12, Nn[1]], EI = [-Nn[0], 0.12, -Nn[1]], UP = [0, 1, 0];
  const u = (a) => stA.s + a;
  const hs = holes.map((h) => ({ ...h, ...archProfile(h.c, h.w, h.crown, h.spring) })).sort((p, q) => p.c - q.c);

  // —— 内外立面：底边绕过各券洞的多边形 ——
  const facade = (y0, oF, E, fl) => {
    const cont = [[0, y0]];
    for (const h of hs) {
      cont.push([h.c - h.w / 2, y0]);
      for (const p of h.pts) cont.push([p[0], p[1]]);
      cont.push([h.c + h.w / 2, y0]);
    }
    cont.push([Lb, y0], [Lb, H], [0, H]);
    const tris = THREE.ShapeUtils.triangulateShape(cont.map(([a, y]) => new THREE.Vector2(a, y)), []);
    for (const [i, j, k] of tris) {
      const P = [cont[i], cont[j], cont[k]];
      brick.tri(...P.map(([a, y]) => W(a, oF(y), y)), P.map(([a, y]) => [u(a), y]), P.map(([, y]) => [y, fl(y)]), E);
    }
  };
  facade(0.9, oOutB, EO, (y) => 1 - (0.5 * (y - 0.9)) / (H - 0.9));
  facade(0.6, oInB, EI, (y) => 0.55 - (0.25 * (y - 0.6)) / (H - 0.6));

  // —— 土衬石（逐墩） ——
  const oS = OB + 0.12, iS = IB - 0.1;
  const edges = [0];
  for (const h of hs) edges.push(h.c - h.w / 2, h.c + h.w / 2);
  edges.push(Lb);
  for (let i = 0; i < edges.length; i += 2) {
    const p0 = edges[i], p1 = edges[i + 1];
    if (p1 - p0 < 1e-3) continue;
    stone.quad(W(p0, oS, lo), W(p1, oS, lo), W(p1, oS, 0.9), W(p0, oS, 0.9), [[u(p0), lo], [u(p1), lo], [u(p1), 0.9], [u(p0), 0.9]], [[0, 0.8], [0, 0.8], [0.9, 0.8], [0.9, 0.8]], EO);
    stone.quad(W(p0, oS, 0.9), W(p1, oS, 0.9), W(p1, O_PL, 0.9), W(p0, O_PL, 0.9), [[u(p0), 0], [u(p1), 0], [u(p1), 0.3], [u(p0), 0.3]], [0.9, 0.5], UP);
    stone.quad(W(p0, iS, lo), W(p1, iS, lo), W(p1, iS, 0.6), W(p0, iS, 0.6), [[u(p0), lo], [u(p1), lo], [u(p1), 0.6], [u(p0), 0.6]], [[0, 0.5], [0, 0.5], [0.6, 0.5], [0.6, 0.5]], EI);
    stone.quad(W(p0, I_PL, 0.6), W(p1, I_PL, 0.6), W(p1, iS, 0.6), W(p0, iS, 0.6), [[u(p0), 0], [u(p1), 0], [u(p1), 0.3], [u(p0), 0.3]], [0.6, 0.3], UP);
  }

  // —— 洞内：两侧墙 + 拱顶 + 券脸 ——
  const FL = 0.32; // 洞内夜间泛光系数（暖光透出洞口）
  for (const h of hs) {
    for (const [a, sg] of [[h.c - h.w / 2, 1], [h.c + h.w / 2, -1]]) {
      const E = [T[0] * sg, 0, T[2] * sg];
      const band = (y0, y1, i0, i1, o0, o1, buf) =>
        buf.quad(W(a, i0, y0), W(a, o0, y0), W(a, o1, y1), W(a, i1, y1), [[i0, y0], [o0, y0], [o1, y1], [i1, y1]], [[y0, FL], [y0, FL], [y1, FL], [y1, FL]], E);
      band(lo, 0.6, iS, iS, oS, oS, stone);
      band(0.6, 0.9, I_PL, oInB(0.9), oS, oS, stone);
      band(0.9, h.spring, oInB(0.9), oInB(h.spring), O_PL, oOutB(h.spring), brick);
    }
    let acc = 0;
    for (let i = 0; i < h.pts.length - 1; i++) {
      const p = h.pts[i], q = h.pts[i + 1];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const np = [T[0] * p[2], p[3], T[2] * p[2]], nq = [T[0] * q[2], q[3], T[2] * q[2]];
      brick.quadN(W(p[0], oInB(p[1]), p[1]), W(q[0], oInB(q[1]), q[1]), W(q[0], oOutB(q[1]), q[1]), W(p[0], oOutB(p[1]), p[1]),
        [[acc, oInB(p[1])], [acc + d, oInB(q[1])], [acc + d, oOutB(q[1])], [acc, oOutB(p[1])]], [[p[1], FL], [q[1], FL], [q[1], FL], [p[1], FL]], [np, nq, nq, np]);
      acc += d;
    }
    // 券脸：拱外沿一圈凸出 7 cm 的砖券（内外两面）
    const k = Math.max(0.4, Math.min(1.2, h.w * 0.05)), dz = 0.07;
    h.k = k;
    const P = h.pts.map((p) => [p[0], p[1], p[0] - p[2] * k, p[1] - p[3] * k, p[2], p[3]]);
    for (const [oF, sgn, E] of [[oOutB, 1, EO], [oInB, -1, EI]]) {
      const f = (a, y, raise) => W(a, oF(y) + sgn * raise, y);
      for (let i = 0; i < P.length - 1; i++) {
        const [a0, y0, b0, z0, na, ny] = P[i], [a1, y1, b1, z1] = P[i + 1];
        brick.quad(f(a0, y0, dz), f(a1, y1, dz), f(b1, z1, dz), f(b0, z0, dz), [[u(a0), y0], [u(a1), y1], [u(b1), z1], [u(b0), z0]], [[y0, 0.9], [y1, 0.9], [z1, 0.9], [z0, 0.9]], E);
        const nOut = [-T[0] * na, -ny, -T[2] * na];
        brick.quad(f(b0, z0, 0), f(b1, z1, 0), f(b1, z1, dz), f(b0, z0, dz), [[u(b0), 0], [u(b1), 0], [u(b1), dz], [u(b0), dz]], [z0, 0.9], nOut);
        brick.quad(f(a0, y0, 0), f(a1, y1, 0), f(a1, y1, dz), f(a0, y0, dz), [[u(a0), 0], [u(a1), 0], [u(a1), dz], [u(a0), dz]], [y0, 0.6], [-nOut[0], -nOut[1], -nOut[2]]);
      }
      for (const j of [0, P.length - 1]) {
        const [a0, y0, b0, z0] = P[j];
        brick.quad(f(a0, y0, 0), f(b0, z0, 0), f(b0, z0, dz), f(a0, y0, dz), [[0, 0], [k, 0], [k, dz], [0, dz]], [y0, 0.8], [0, -1, 0]);
      }
    }
  }
  // —— 顶面海墁 ——
  pave.quad(W(0, OT, H), W(Lb, OT, H), W(Lb, IT, H), W(0, IT, H), [[u(0), OT], [u(Lb), OT], [u(Lb), IT], [u(0), IT]], [H, 0], UP);
  return { W, hs, T, Nn };
}

/**
 * 西南圆形角台：圆台（底半径 rB→顶半径 rT，收分，逐顶点法线 128 分段）、土衬石圈、台顶海墁（同心两圈），
 * 圆弧垛墙（逐顶点法线、垛按弧长均布），朝城内一侧开口 + 7 级砖踏步下到墙顶马道。
 * C：台心；by：墙基高程；lo：相对墙基的埋深；inward：台心→城角内侧的单位向量。
 */
function emitRoundBastion(bufs, merl, outlineRuns, C, by, lo, inward) {
  const { brick, pave, stone } = bufs;
  const { rT, rB, up } = SW_TOWER;
  const top = H + up;
  const N = 128;
  const rAt = (y) => rB + ((rT - rB) * (y - 0.9)) / (top - 0.9);
  const slope = (rB - rT) / (top - 0.9); // 收分使外法线略上仰
  const pt = (c, s, r, y) => [C[0] + c * r, by + y, C[1] + s * r];
  const r1 = rT * 0.45;
  for (let i = 0; i < N; i++) {
    const A = (i / N) * Math.PI * 2, B = ((i + 1) / N) * Math.PI * 2;
    const ca = Math.cos(A), sa = Math.sin(A), cb = Math.cos(B), sb = Math.sin(B);
    const uA = A * rB, uB = B * rB;
    const na = [ca, slope, sa], nb = [cb, slope, sb];
    brick.quadN(pt(ca, sa, rAt(0.9), 0.9), pt(cb, sb, rAt(0.9), 0.9), pt(cb, sb, rT, top), pt(ca, sa, rT, top),
      [[uA, 0.9], [uB, 0.9], [uB, top], [uA, top]], [[0.9, 1], [0.9, 1], [top, 0.5], [top, 0.5]], [na, nb, nb, na]);
    const rs = rB + 0.12;
    stone.quadN(pt(ca, sa, rs, lo), pt(cb, sb, rs, lo), pt(cb, sb, rs, 0.9), pt(ca, sa, rs, 0.9),
      [[uA, lo], [uB, lo], [uB, 0.9], [uA, 0.9]], [[0, 0.8], [0, 0.8], [0.9, 0.8], [0.9, 0.8]], [[ca, 0, sa], [cb, 0, sb], [cb, 0, sb], [ca, 0, sa]]);
    stone.quad(pt(ca, sa, rs, 0.9), pt(cb, sb, rs, 0.9), pt(cb, sb, rAt(0.9), 0.9), pt(ca, sa, rAt(0.9), 0.9),
      [[uA, 0], [uB, 0], [uB, 0.3], [uA, 0.3]], [0.9, 0.5], [0, 1, 0]);
    // 台顶：外环 + 内扇，避免细长三角
    pave.quad(pt(ca, sa, rT, top), pt(cb, sb, rT, top), pt(cb, sb, r1, top), pt(ca, sa, r1, top),
      [[C[0] + ca * rT, C[1] + sa * rT], [C[0] + cb * rT, C[1] + sb * rT], [C[0] + cb * r1, C[1] + sb * r1], [C[0] + ca * r1, C[1] + sa * r1]], [top, 0], [0, 1, 0]);
    pave.tri(pt(0, 0, 0, top), pt(cb, sb, r1, top), pt(ca, sa, r1, top), [[C[0], C[1]], [C[0] + cb * r1, C[1] + sb * r1], [C[0] + ca * r1, C[1] + sa * r1]], [top, 0], [0, 1, 0]);
  }
  // 垛墙：整圈，仅在朝城内的踏步口断开
  const hw = 1.6;
  const a0 = Math.atan2(inward[1], inward[0]);
  const half = Math.asin((hw + 0.3) / rT);
  const Rp = rT - PO.t / 2;
  const M = 120, span = 2 * Math.PI - 2 * half;
  const pts = [];
  for (let i = 0; i <= M; i++) {
    const A = a0 + half + (span * i) / M;
    const nx = Math.cos(A), nz = Math.sin(A);
    pts.push({ x: C[0] + nx * Rp, z: C[1] + nz * Rp, y: by + top, nx, nz, sc: 1, s: (i * span * Rp) / M });
  }
  emitParapet(brick, pts, PO.t, PO.h, merl, false, 0.45, true);
  outlineRuns.push(pts.map((p) => [p.x + p.nx * (PO.t / 2 + 0.05), p.y + PO.h + MER.h * 0.5, p.z + p.nz * (PO.t / 2 + 0.05)]));
  // 踏步：自台顶沿 inward 方向下到墙顶（7 级，每级高 up/7、深 0.34 m，宽 3.2 m）
  const d = inward, pn = [-d[1], d[0]];
  const nStep = 7, hr = up / nStep, run = 0.34;
  const S = (r, p, y) => [C[0] + d[0] * r + pn[0] * p, by + y, C[1] + d[1] * r + pn[1] * p];
  const rTop = rT - 0.3; // 最上一级伸入圆台内，接缝藏于台身
  const prof = [[rTop, H + (nStep - 1) * hr]];
  for (let i = nStep - 1; i >= 1; i--) {
    const r0 = i === nStep - 1 ? rTop : rT + (nStep - 1 - i) * run, r2 = rT + (nStep - i) * run;
    const y = H + i * hr;
    brick.quad(S(r0, -hw, y), S(r2, -hw, y), S(r2, hw, y), S(r0, hw, y), [[r0, -hw], [r2, -hw], [r2, hw], [r0, hw]], [y, 0.4], [0, 1, 0]);
    brick.quad(S(r2, -hw, y), S(r2, -hw, y - hr), S(r2, hw, y - hr), S(r2, hw, y), [[-hw, y], [-hw, y - hr], [hw, y - hr], [hw, y]], [y, 0.5], [d[0], 0, d[1]]);
    prof.push([r2, y], [r2, y - hr]);
  }
  prof.push([rTop, H]);
  const tri2 = THREE.ShapeUtils.triangulateShape(prof.map(([r, y]) => new THREE.Vector2(r, y)), []);
  for (const sg of [-1, 1]) {
    for (const [i, j, k] of tri2) {
      const P = [prof[i], prof[j], prof[k]];
      brick.tri(...P.map(([r, y]) => S(r, sg * hw, y)), P.map(([r, y]) => [r, y]), [H, 0.4], [pn[0] * sg, 0, pn[1] * sg]);
    }
  }
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
    const ring = wallRing(ctx.data?.landmarks?.gates || []);
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
    const ring = wallRing(gates);
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
    const mainGates = [], modernGates = [], holeGroups = [];
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
      } else modernGates.push(f);
      // 券洞组：墙身在组范围内切开，由 emitHoleWall 以同一截面补上带洞墙段
      for (const grp of GATE_HOLES[g.id] || []) {
        const hl = grp.map(([c, w, o]) => ({ c, w, ...holeDims(w, o) }));
        const a0 = Math.min(...hl.map((h) => h.c - h.w / 2)) - HOLE_END, a1 = Math.max(...hl.map((h) => h.c + h.w / 2)) + HOLE_END;
        const sA = f.s + a0, sB = f.s + a1;
        addCut(bodyCuts, sA, sB);
        holeGroups.push({ f, sA: ring.wrap(sA), sB: ring.wrap(sB), holes: hl.map((h) => ({ ...h, c: h.c - a0 })), minC: Math.min(...hl.map((h) => Math.abs(h.c))) });
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
    // 西南圆形角台：城墙仍为直角，圆台心在两外墙顶皮外约 4 m（两外法线方向），台顶无楼
    const sw = (() => {
      const c = CORNERS.SW;
      const i = ring.segs.findIndex((sg) => Math.abs(sg.a[0] - c[0]) < 0.01 && Math.abs(sg.a[1] - c[1]) < 0.01);
      const n2 = ring.segs[i], n1 = ring.segs[(i - 1 + ring.segs.length) % ring.segs.length];
      const C = [c[0] + (n1.nx + n2.nx) * SW_TOWER.off, c[1] + (n1.nz + n2.nz) * SW_TOWER.off];
      const inward = norm([c[0] - C[0], c[1] - C[1]]);
      const rH = SW_TOWER.rB + ((SW_TOWER.rT - SW_TOWER.rB) * (H - 0.9)) / (H + SW_TOWER.up - 0.9);
      // 外侧垛墙在城角处断开；两侧垛墙沿各自直线延伸到圆台台身内 0.3 m（见 swExtend），接缝藏入台身
      addCut(outCuts, n2.s0 - 0.03, n2.s0 + 0.03);
      return { key: 'SW', x: C[0], z: C[1], C, inward, s: n2.s0, by: baseAt(n2.s0), rH };
    })();
    // 马面
    const mamian = [];
    for (const m of mamianData) {
      const [x, z] = m.center_on_centerline;
      const pr = ring.project(x, z);
      if (bodyCuts.some(([a, b]) => pr.s > a - 12 && pr.s < b + 12)) continue;
      if (mainGates.some((g) => Math.abs(pr.s - g.s) < g.spec.W + 12)) continue;
      if (corners.some((c) => Math.abs(ring.wrap(pr.s - c.s + L / 2) - L / 2) < 30) || Math.abs(ring.wrap(pr.s - sw.s + L / 2) - L / 2) < 40) continue;
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
    // 西南城角两侧垛墙：端点顺直线方向延伸至圆台台身（半径 rH − 0.3）
    const swExtend = (pts) => {
      for (const [iE, iP] of [[0, 1], [pts.length - 1, pts.length - 2]]) {
        const p = pts[iE], q = pts[iP];
        if (Math.abs(ring.wrap(p.s - sw.s + L / 2) - L / 2) > 0.2) continue;
        const d = norm([p.x - q.x, p.z - q.z]);
        const R = sw.rH - 0.3, fx = p.x - sw.C[0], fz = p.z - sw.C[1];
        const bq = fx * d[0] + fz * d[1], cq = fx * fx + fz * fz - R * R, disc = bq * bq - cq;
        if (disc < 0) continue;
        const t = -bq - Math.sqrt(disc); // 首次进入圆的距离
        if (t > 0 && t < 12) pts[iE] = { ...p, x: p.x + d[0] * t, z: p.z + d[1] * t, sc: 1 };
      }
      return pts;
    };
    for (const r of runs(outCuts)) {
      const pts = swExtend(shiftPts(r, OT - PO.t / 2));
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
      const lo = Math.min(0, ...[0, 1, 2, 3, 4, 5].map((k) => hAt(sw.C[0] + Math.cos(k) * 11, sw.C[1] + Math.sin(k) * 11) - sw.by)) - 1.5;
      emitRoundBastion(bufs, merl, outlineRuns, sw.C, sw.by, lo, sw.inward);
    }

    // —— 券洞墙段 ——
    const stAt = (s) => {
      let best = null;
      for (const p of ST) if (!best || Math.abs(p.s - s) < Math.abs(best.s - s)) best = p;
      return best;
    };
    for (const g of holeGroups) {
      const stA = stAt(g.sA), stB = stAt(g.sB);
      if (ring.segAt(g.sA + 0.1) !== ring.segAt(g.sB - 0.1)) console.warn('[citywall] 券洞组跨中心线折点：', g.f.g.id);
      let lo = 0;
      for (let k = 0; k <= 8; k++) {
        const fr = ring.frame(g.sA + ((g.sB - g.sA) * k) / 8);
        const bb = stA.b + ((stB.b - stA.b) * k) / 8;
        for (const o of [OB, 0, IB]) lo = Math.min(lo, hAt(fr.x + fr.nx * o, fr.z + fr.nz * o) - bb);
      }
      g.geo = emitHoleWall(bufs, stA, stB, g.holes, lo - 1.2);
      g.holeCount = g.holes.length;
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
    // 近现代城门匾额：挂在离城门中线最近的券洞上方，内外各一，贴合收分墙面（倾角一致，不穿插）
    const plaqueStyle = { bg: '#5d5850', color: '#f2e6c4', border: '#a09682' };
    const plaqueMtx = new THREE.Matrix4(), vX = new THREE.Vector3(), vY = new THREE.Vector3(), vZ = new THREE.Vector3();
    for (const f of modernGates) {
      let best = null;
      for (const g of holeGroups) if (g.f === f && g.geo && (!best || g.minC < best.minC)) best = g;
      if (!best) continue;
      const { W, hs, T, Nn } = best.geo;
      // 城门中线落在本组内则匾居中（如朱雀门两车行孔之间），否则挂在最近券洞正上方
      const aC = f.s - best.sA;
      let hb = hs[0];
      for (const h of hs) if (Math.abs(h.c - aC) < Math.abs(hb.c - aC)) hb = h;
      const Lg = best.sB - best.sA;
      const aP = aC > 4 && aC < Lg - 4 ? aC : hb.c;
      const pw = Math.min(5.6, hb.w * 0.75 + 1.2);
      let yTop = 0;
      for (const h of hs) if (Math.abs(h.c - aP) < h.w / 2 + h.k + pw / 2) yTop = Math.max(yTop, h.crown + h.k);
      const yP = Math.min(10.75, Math.max(yTop + 0.8, 8.5));
      const k = (OT - O_PL) / (H - 0.9); // 外墙面 do/dy（收分，负值）
      for (const side of [1, -1]) {
        const o = side > 0 ? oOutB(yP) + 0.04 : oInB(yP) - 0.04;
        const p = W(aP, o, yP);
        vZ.set(Nn[0] * side, -k, Nn[1] * side).normalize();
        vY.set(Nn[0] * side * k, 1, Nn[1] * side * k).normalize();
        vX.crossVectors(vY, vZ).normalize();
        plaqueMtx.makeBasis(vX, vY, vZ).setPosition(p[0], p[1], p[2]);
        mb.push(plaqueMtx.clone());
        mb.plaque(f.g.name, 0, 0, 0, pw, 1.3, plaqueStyle);
        mb.pop();
      }
      void T;
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
    // 魁星楼（文昌门券洞西侧约 27 m 的城墙顶，偏内侧；Esri z19 影像核对）
    const wen = modernGates.find((g) => g.g.id === 'wenchang');
    if (wen) {
      const s = wen.s + 27;
      const f = ring.frame(s);
      mb.push(f.x - f.nx * 1.5, baseAt(s) + H, f.z - f.nz * 1.5, Math.atan2(f.nx, f.nz));
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
      // 垛口（1 m 高）几公里外亚像素（按画质 1.6~3.6 km）；阴影只在阴影贴图覆盖范围内投射
      merlons.visible = dWall < ([1600, 2400, 3000, 3600][ctx.quality.level ?? 2] ?? 3000);
      merlons.castShadow = dWall < shadowReach(ctx, 1500, 12);
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
