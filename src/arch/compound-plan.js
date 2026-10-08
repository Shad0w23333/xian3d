// 小区/校园内部布局规划（纯计算，不依赖 three；compounds 模块在 prepare 阶段对全城一次性规划）。
//
// 小区来源：
//   · landuse.json 的 residential（住宅）与 university（校园/中小学/幼儿园/医院等单位大院）多边形。
//     跳过：城中村（名称以“村”结尾且不是“新村”、或楼多为自建房）、面积过小/过大、精建片区（排除区 buildings）。
//     嵌套多边形（小区里的幼儿园）：楼归最小的那个多边形；外层小区把内层当障碍。
//   · 楼群小区：OSM 没画住宅用地的住宅楼（约一半）按楼距 ≤ 30 m、中间不隔市政路聚类，凸包外扩 10 m 作范围；
//     只规划内部（车行道/停车/绿地/设施），不画围墙大门；与其他用地相交处在栅格里挖掉。
//   · 运动场地（sports.json，OSM leisure=track/pitch）：落在小区内的当障碍，渲染见 compound-sports.js。
//
// 每个小区一个局部坐标系（u, v）：按楼栋外墙边方向的长度加权直方图取主方向 θ（模 90°），u 轴取偏东西的那一支，
// v 轴约朝南（+Z）。西安住宅绝大多数坐北朝南、行列式布置，单元门开在北面 → 车行道放在每排楼的北侧。
// 规划结果全部是局部坐标里的轴对齐矩形（u0,u1,v0,v1），外加 OSM 小区内道路（任意方向，只用来定位大门与停车）。
//
// 规划顺序：
//   1. 宅前车行道：每栋楼北墙外“入户铺装带（apron）+ 半个路宽”处一条候选，同一行合并，沿 u 向两端延伸到楼/围墙/市政路为止
//      （市政路外侧留 1.6 m 行道树带；不与小区内 OSM 道路重叠）
//   2. 连接道：相邻两条车行道之间在端部找一条无遮挡的竖向通道
//   3. 大门：车行道端头/中段延伸到边界外紧邻市政道路处；沿边界取点向内找到最近车行道的通道；OSM 小区内道路穿越边界处；
//      estates_style 有照片的大门（门楼由通用建筑模块画，这里只开口、接车道）
//   4. 停车：车行道两侧按车位逐格判可用（障碍外接框整段标记）——新小区路侧平行车位为主，老小区垂直车位 + 一半不画线
//   5. 单元门前铺装带、宅前园路；宅间绿地（楼南侧、楼东西两侧空地）→ 作为“公园”小地块交给植被模块种树
//   6. 设施：健身器材区、儿童游乐、凉亭/廊架、自行车棚/电动车充电棚、垃圾分类亭、快递柜、篮球场、旗杆广场（校园）、地下车库坡道
// 排除区：车行道（吸收紧贴的车位带/铺装带）、其余车位、园路、设施矩形按 250 m 分片、按“互不重叠层”拼成多环多边形
// （零宽桥接，奇偶规则下桥接边抵消），交给植被模块（trees:true，buildings/roads/pois 都为 false）。
//
// 坐标：世界 X 东、Z 南（北为 -Z）；建筑 buildings.bin 见 docs/CONTRACT.md 3.4。

export const CHUNK = 500; // 流式分块（米）

// —— 尺寸常量（米）；依据：《城市居住区规划设计标准》GB 50180-2018 小区路宽 4~6 m（车行）、宅间路 ≥ 2.5 m；
//    小型车位 2.5×5.3 m（垂直）/ 2.4×6.0 m（平行）；西安老小区（1980~2000）宅间路多为 3.5~4.5 m 水泥路 ——
const LANE_W = { new: 5.5, old: 4.0, uni: 6.0 };
const APRON = { new: 2.6, old: 1.9, uni: 3.0 };
const PERP_D = 5.3, PERP_W = 2.5, PARA_D = 2.4, PARA_L = 6.0;

// —— 小工具 ——
const now = () => (typeof performance !== 'undefined' ? performance : Date).now();
function hash(a, b, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const hash01 = hash;
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function pip(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const zi = p[i + 1], zj = p[j + 1];
    if (zi > z !== zj > z && x < ((p[j] - p[i]) * (z - zi)) / (zj - zi) + p[i]) c = !c;
  }
  return c;
}
function ringArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return a / 2;
}
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}
export function ringDist(x, z, p) {
  let d = Infinity;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) d = Math.min(d, segDist2(x, z, p[j], p[j + 1], p[i], p[i + 1]));
  return Math.sqrt(d);
}
/** 线段 (a→b) 是否与轴对齐矩形（已含余量）相交 */
function segHitsBox(ax, az, bx, bz, x0, x1, z0, z1) {
  if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(az, bz) < z0 || Math.min(az, bz) > z1) return false;
  if ((ax >= x0 && ax <= x1 && az >= z0 && az <= z1) || (bx >= x0 && bx <= x1 && bz >= z0 && bz <= z1)) return true;
  // Liang–Barsky
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dz, az - z0) && clip(dz, z1 - az) && t0 <= t1;
}

/**
 * 最小面积外接矩形（凸包 + 逐边旋转）：返回 {cx, cz, ang, L, B}，ang 为长边方向（弧度，世界 x 轴起、朝 +z 为正）
 */
export function minRect(p) {
  const pts = [];
  for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of h) {
      const u = q[0] * ux + q[1] * uz, v = -q[0] * uz + q[1] * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { A, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, du: u1 - u0, dv: v1 - v0 };
    }
  }
  if (!best) return null;
  // 长边为 L
  if (best.du >= best.dv) return { cx: best.cx, cz: best.cz, ang: Math.atan2(best.uz, best.ux), L: best.du, B: best.dv };
  return { cx: best.cx, cz: best.cz, ang: Math.atan2(best.ux, -best.uz), L: best.dv, B: best.du };
}

/**
 * 运动场地预处理（sports.json）：每个场地求外接矩形；足球场/无运动类型大场地若尺寸像“400 m 跑道 + 内场”则按田径场画。
 * 返回 [{kind, p, cx, cz, ang, L, B, bb}]，kind: track | soccer | basketball | tennis | volleyball | badminton | table_tennis | multi
 */
export function prepSports(sp) {
  const out = [];
  const add = (kind, p) => {
    const r = minRect(p);
    if (!r || r.B < 4) return;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
    out.push({ kind, p, ...r, bb: [x0, z0, x1, z1] });
  };
  for (const t of sp?.tracks || []) add('track', t.p);
  for (const q of sp?.pitches || []) {
    let k = q.s;
    const r = minRect(q.p);
    if (!r) continue;
    // 足球场轮廓接近 400 m（或 300/200 m）跑道外沿 → 田径场；与已有跑道重合的内场仍按足球场画
    if (k === 'soccer' && r.L > 120 && r.L < 205 && r.B > 62 && r.B < 112 && r.L / r.B > 1.45) k = 'track';
    add(k, q.p);
  }
  // 去重：田径场内的足球场保留（作内场），被田径场完全包含的“田径场”只留大的
  out.sort((a, b) => b.L * b.B - a.L * a.B);
  const keep = [];
  for (const f of out) {
    if (f.kind === 'track' && keep.some((g) => g.kind === 'track' && Math.hypot(g.cx - f.cx, g.cz - f.cz) < Math.min(g.B, f.B) / 2)) continue;
    keep.push(f);
  }
  return keep;
}

/** buildings.bin 解析（只取本模块需要的字段，视图不拷贝） */
export function parseBld(buf) {
  if (!buf || buf.byteLength < 16) return null;
  const dv = new DataView(buf);
  const ver = dv.getUint32(4, true), N = dv.getUint32(8, true), TV = dv.getUint32(12, true);
  let o = 16;
  const ax = new Float32Array(buf, o, N); o += N * 4;
  const az = new Float32Array(buf, o, N); o += N * 4;
  const vs = new Uint32Array(buf, o, N); o += N * 4;
  const vc = new Uint16Array(buf, o, N); o += N * 2;
  const hd = new Uint16Array(buf, o, N); o += N * 2;
  const md = new Uint16Array(buf, o, N); o += N * 2;
  const kind = new Uint8Array(buf, o, N); o += N;
  const flags = new Uint8Array(buf, o, N); o += N;
  let style = null;
  if (ver >= 2) { style = new Uint8Array(buf, o, N); o += N; }
  o = (o + 3) & ~3;
  const offs = new Int16Array(buf, o, TV * 2);
  return { n: N, ax, az, vs, vc, hd, md, kind, flags, style, offs };
}

/** 稀疏网格（按外接框登记 id） */
class BoxGrid {
  constructor(cell) {
    this.cell = cell;
    this.m = new Map();
  }
  add(x0, z0, x1, z1, id) {
    const C = this.cell;
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++)
      for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
        const k = i * 73856093 + j;
        let a = this.m.get(k);
        if (!a) this.m.set(k, (a = []));
        a.push(id);
      }
  }
  /** 外接框内的 id（可能重复，调用方用 stamp 去重） */
  each(x0, z0, x1, z1, fn) {
    const C = this.cell;
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++)
      for (let j = Math.floor(z0 / C); j <= Math.floor(z1 / C); j++) {
        const a = this.m.get(i * 73856093 + j);
        if (a) for (let k = 0; k < a.length; k++) fn(a[k]);
      }
  }
}

// 道路等级（roads.json classes 下标）→ [是否为市政机动车道, 人行道宽]
const ROAD_SW = [0, 4.5, 5, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const MIN_W = [7.5, 7, 7, 6.5, 6, 5, 3.5, 5, 4.5, 4.5, 4.5, 4, 4, 2];
function roadHalfW(f) {
  const c = f.c | 0;
  const lanes = Math.max(1, Math.min(8, f.l | 0 || 1));
  let W = Number(f.w) || MIN_W[c] || 5;
  if (c !== 12 && c !== 13) W = Math.max(W, MIN_W[c] || 5, lanes * (c <= 2 ? 3.4 : 3.1));
  return Math.min(W, 42) / 2;
}

const VILLAGE = /村$/;
const NEW_VILLAGE = /新村$|[一二三四五六七八九十\d]村$/; // “XX新村”“交大二村”是单位宿舍/老小区
const SCHOOL_KG = /幼儿园|托儿所/;
const SCHOOL = /小学|中学|学校|附中|附小|实验|职业|技工/;
const INST = /医院|卫生|研究|设计院|疗养|门诊|保健/;

/**
 * 全城规划。
 * input: { landuse, roads, bld (parseBld 结果), estates (estates_style.json 或 null), excluded(x,z) → 是否精建区 }
 * 返回 { list: [compound], stats }
 */
export function planAll(input) {
  const it = planIter(input);
  let r;
  while (!(r = it.next()).done);
  return r.value;
}

/** 同 planAll，但每规划完一个小区 yield 一次（模块在 prepare 里按时间片推进，加载界面不卡死） */
export function* planIter(input) {
  const t0 = now();
  const B = input.bld;
  const excluded = input.excluded || (() => false);
  const stats = { cand: 0, planned: 0, lanes: 0, conns: 0, gates: 0, stalls: 0, pads: 0, paths: 0, skipVillage: 0, skipExcl: 0, skipEmpty: 0, ms: 0 };

  // —— 1. 候选多边形 ——
  const polys = [];
  for (const f of input.landuse?.polys || []) {
    if ((f.k !== 'residential' && f.k !== 'university') || !f.outer || f.outer.length < 8) continue;
    const o = f.outer;
    const A = Math.abs(ringArea(o));
    if (A < 1500 || A > 2.5e6) continue;
    const n = f.n || '';
    if (f.k === 'residential' && VILLAGE.test(n) && !NEW_VILLAGE.test(n)) { stats.skipVillage++; continue; }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) {
      if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i];
      if (o[i + 1] < z0) z0 = o[i + 1]; if (o[i + 1] > z1) z1 = o[i + 1];
    }
    polys.push({ f, ring: o, holes: (f.holes || []).filter((h) => h.length >= 6), area: A, bb: [x0, z0, x1, z1], name: n, k: f.k, own: [] });
  }
  stats.cand = polys.length;
  const polyGrid = new BoxGrid(250);
  polys.forEach((p, i) => polyGrid.add(p.bb[0], p.bb[1], p.bb[2], p.bb[3], i));

  // —— 2. 楼归属：锚点所在的最小多边形 ——
  const N = B ? B.n : 0;
  const owner = new Int32Array(N).fill(-1);
  const bbx = new Float32Array(N * 4); // 世界外接框
  const bgrid = new BoxGrid(80);
  for (let b = 0; b < N; b++) {
    if (B.flags[b] & 128) continue; // 数据层让位
    if (B.md[b] > 30) continue; // 悬空 building:part
    const s = B.vs[b] * 2, c = B.vc[b], ax = B.ax[b], az = B.az[b];
    if (c < 3) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < c; k++) {
      const x = ax + B.offs[s + k * 2] * 0.1, z = az + B.offs[s + k * 2 + 1] * 0.1;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    bbx[b * 4] = x0; bbx[b * 4 + 1] = z0; bbx[b * 4 + 2] = x1; bbx[b * 4 + 3] = z1;
    bgrid.add(x0, z0, x1, z1, b);
    let best = -1, bestA = Infinity;
    polyGrid.each(ax, az, ax, az, (i) => {
      const p = polys[i];
      if (p.area >= bestA || ax < p.bb[0] || ax > p.bb[2] || az < p.bb[1] || az > p.bb[3]) return;
      if (!pip(ax, az, p.ring)) return;
      for (const h of p.holes) if (pip(ax, az, h)) return;
      best = i;
      bestA = p.area;
    });
    owner[b] = best;
    if (best >= 0) polys[best].own.push(b);
  }

  // —— 3. 道路段网格 ——
  const roads = input.roads?.features || [];
  const rsegs = []; // [ax, az, bx, bz, clear, cls, fi]
  const rgrid = new BoxGrid(80);
  const flen = new Float32Array(roads.length);
  for (let fi = 0; fi < roads.length; fi++) {
    const f = roads[fi];
    { const p = f.p; let L = 0; for (let i = 0; i + 3 < p.length; i += 2) L += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]); flen[fi] = L; }
    if (f.t) continue; // 隧道
    const c = f.c | 0;
    const hw = roadHalfW(f);
    const clear = hw + (ROAD_SW[c] || 0) + (c === 13 ? 0 : 0.6);
    const p = f.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const id = rsegs.length;
      rsegs.push([p[i], p[i + 1], p[i + 2], p[i + 3], clear, c, fi, hw]);
      rgrid.add(Math.min(p[i], p[i + 2]) - clear, Math.min(p[i + 1], p[i + 3]) - clear, Math.max(p[i], p[i + 2]) + clear, Math.max(p[i + 1], p[i + 3]) + clear, id);
    }
  }

  // —— 3b. 楼群小区：OSM 没画住宅用地的住宅楼（约占一半），按楼间距 ≤ 30 m、中间不隔市政路聚成楼群，
  //        凸包外扩 10 m 作范围。只做内部（车行道/停车/绿地/设施），不画围墙大门（范围是推出来的，不可靠）——
  const otherLU = (input.landuse?.polys || []).filter((f) => f.outer && f.outer.length >= 6 && f.k !== 'residential' && f.k !== 'university' && f.k !== 'farmland' && f.k !== 'orchard');
  const luGrid = new BoxGrid(250);
  const luBB = otherLU.map((f, i) => {
    const o = f.outer;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < o.length; k += 2) { x0 = Math.min(x0, o[k]); x1 = Math.max(x1, o[k]); z0 = Math.min(z0, o[k + 1]); z1 = Math.max(z1, o[k + 1]); }
    if ((x1 - x0) * (z1 - z0) < 4e7) luGrid.add(x0, z0, x1, z1, i);
    return [x0, z0, x1, z1];
  });
  {
    const isC = new Uint8Array(N);
    const cands = [];
    for (let b = 0; b < N; b++) {
      if (owner[b] >= 0 || (B.flags[b] & 128) || B.md[b] > 30) continue;
      const st = B.style ? B.style[b] >> 4 : 0;
      const resi = B.kind[b] === 1 || st === 1 || st === 2;
      if (!resi || st === 3 || st === 4) continue;
      if (B.hd[b] < 90) continue; // < 9 m：低层/自建
      const w = bbx[b * 4 + 2] - bbx[b * 4], d = bbx[b * 4 + 3] - bbx[b * 4 + 1];
      if (w * d < 150) continue;
      // 落在其他用地（公园、商业、工业……）里的不算
      let inLU = false;
      luGrid.each(B.ax[b], B.az[b], B.ax[b], B.az[b], (i) => {
        if (inLU) return;
        const q = luBB[i];
        if (B.ax[b] < q[0] || B.ax[b] > q[2] || B.az[b] < q[1] || B.az[b] > q[3]) return;
        if (pip(B.ax[b], B.az[b], otherLU[i].outer)) inLU = true;
      });
      if (inLU) continue;
      isC[b] = 1;
      cands.push(b);
    }
    const par = new Int32Array(N).fill(-1);
    for (const b of cands) par[b] = b;
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const crossesRoad = (ax, az, bx, bz) => {
      let hit = false;
      rgrid.each(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (id) => {
        if (hit) return;
        const r = rsegs[id];
        const c = r[5];
        if (c === 6 || c >= 12) return; // service / 步行道不隔断
        // 线段相交
        const d1x = bx - ax, d1z = bz - az, d2x = r[2] - r[0], d2z = r[3] - r[1];
        const den = d1x * d2z - d1z * d2x;
        if (Math.abs(den) < 1e-9) return;
        const t = ((r[0] - ax) * d2z - (r[1] - az) * d2x) / den, u = ((r[0] - ax) * d1z - (r[1] - az) * d1x) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) hit = true;
      });
      return hit;
    };
    const G0 = 30;
    for (const b of cands) {
      const x0 = bbx[b * 4], z0 = bbx[b * 4 + 1], x1 = bbx[b * 4 + 2], z1 = bbx[b * 4 + 3];
      bgrid.each(x0 - G0, z0 - G0, x1 + G0, z1 + G0, (c) => {
        if (c <= b || !isC[c]) return;
        const gx = Math.max(0, bbx[c * 4] - x1, x0 - bbx[c * 4 + 2]), gz = Math.max(0, bbx[c * 4 + 1] - z1, z0 - bbx[c * 4 + 3]);
        if (gx > G0 || gz > G0 || Math.hypot(gx, gz) > G0) return;
        const rb = find(b), rc = find(c);
        if (rb === rc) return;
        if (crossesRoad(B.ax[b], B.az[b], B.ax[c], B.az[c])) return;
        par[rb] = rc;
      });
    }
    const groups = new Map();
    for (const b of cands) {
      const r = find(b);
      let a = groups.get(r);
      if (!a) groups.set(r, (a = []));
      a.push(b);
    }
    let nCl = 0;
    for (const mem of groups.values()) {
      if (mem.length < 3) continue;
      const pts = [];
      let cx = 0, cz = 0;
      for (const b of mem) {
        pts.push([bbx[b * 4], bbx[b * 4 + 1]], [bbx[b * 4 + 2], bbx[b * 4 + 1]], [bbx[b * 4 + 2], bbx[b * 4 + 3]], [bbx[b * 4], bbx[b * 4 + 3]]);
        cx += B.ax[b]; cz += B.az[b];
      }
      cx /= mem.length; cz /= mem.length;
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const q of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
      for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
      const h = lo.slice(0, -1).concat(up.slice(0, -1));
      if (h.length < 3) continue;
      const ring = [];
      for (const q of h) {
        const dx = q[0] - cx, dz = q[1] - cz, L = Math.hypot(dx, dz) || 1;
        ring.push(Math.round((q[0] + (dx / L) * 10) * 10) / 10, Math.round((q[1] + (dz / L) * 10) * 10) / 10);
      }
      const A = Math.abs(ringArea(ring));
      if (A < 3000 || A > 600000) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
      const pid = polys.length;
      polys.push({ f: null, ring, holes: [], area: A, bb: [x0, z0, x1, z1], name: '', k: 'cluster', own: mem.slice() });
      polyGrid.add(x0, z0, x1, z1, pid);
      for (const b of mem) owner[b] = pid;
      nCl++;
    }
    stats.clusters = nCl;
  }

  // —— 4. 有照片依据的大门（buildings 模块已经画了门楼，本模块只开口、接车道） ——
  const sports = input.sports || [];
  const sgrid = new BoxGrid(250);
  sports.forEach((f, i) => sgrid.add(f.bb[0], f.bb[1], f.bb[2], f.bb[3], i));
  const photoGates = [];
  for (const e of input.estates?.estates || []) if (e.gate && e.gate.x != null) photoGates.push(e.gate);

  // —— 5. 逐小区规划 ——
  const list = [];
  const ctx = { B, bbx, bgrid, owner, rsegs, rgrid, roads, flen, polys, polyGrid, photoGates, stats, excluded, sports, sgrid, luGrid, luBB, otherLU };
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    const c = planOne(ctx, p, i);
    if (c) {
      c.id = list.length;
      list.push(c);
    }
    yield i;
  }
  stats.planned = list.length;
  // 全城大门通道（门外 22 m 到门内 8 m 的车道走廊）：任何小区的围墙都不能横穿别家的门口
  const gateLanes = [];
  const ggrid = new BoxGrid(120);
  for (const c of list)
    for (const g of c.gates) {
      const [x, z] = toWorld(c, g.u, g.v);
      const dx = g.du * c.cs - g.dv * c.sn, dz = g.du * c.sn + g.dv * c.cs;
      const ax = x - dx * 22, az = z - dz * 22, bx = x + dx * 8, bz = z + dz * 8;
      const hw = c.LW / 2 + 2.2;
      ggrid.add(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, gateLanes.length);
      gateLanes.push([ax, az, bx, bz, hw, c.id]);
    }
  stats.ms = Math.round(now() - t0);
  // index：流式生成阶段复用的全局索引（楼外接框网格、道路段网格）
  return { list, stats, index: { B, bbx, bgrid, rsegs, rgrid, roads, polys, sports, sgrid, gateLanes, ggrid } };
}

// ————————————————————————————————————————————————————————————————————————————————
// 单个小区
// ————————————————————————————————————————————————————————————————————————————————

/** 局部坐标里的矩形索引（障碍物 + 已放置物）：密集网格 + 链表（类型化数组，几乎不产生垃圾） */
class RectIndex {
  constructor(cell, U0, V0, U1, V1) {
    this.cell = cell;
    this.u0 = U0 - 2 * cell;
    this.v0 = V0 - 2 * cell;
    this.nx = Math.max(1, Math.ceil((U1 - U0) / cell) + 4);
    this.ny = Math.max(1, Math.ceil((V1 - V0) / cell) + 4);
    this.head = new Int32Array(this.nx * this.ny).fill(-1);
    this.next = new Int32Array(256);
    this.rid = new Int32Array(256);
    this.ne = 0;
    this.r = new Float64Array(5 * 64); // u0,u1,v0,v1,type
    this.n = 0;
    this.stamp = new Uint32Array(64);
    this.sv = 1;
    this.cand = new Int32Array(256);
  }
  ci(u) { const i = Math.floor((u - this.u0) / this.cell); return i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i; }
  cj(v) { const j = Math.floor((v - this.v0) / this.cell); return j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j; }
  add(u0, u1, v0, v1, type) {
    const id = this.n++;
    if (this.r.length < this.n * 5) { const a = new Float64Array(this.r.length * 2); a.set(this.r); this.r = a; }
    if (this.stamp.length < this.n) { const a = new Uint32Array(this.stamp.length * 2); a.set(this.stamp); this.stamp = a; }
    const r = this.r, o = id * 5;
    r[o] = u0; r[o + 1] = u1; r[o + 2] = v0; r[o + 3] = v1; r[o + 4] = type;
    const i0 = this.ci(u0), i1 = this.ci(u1), j0 = this.cj(v0), j1 = this.cj(v1);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        if (this.ne >= this.next.length) {
          const a = new Int32Array(this.next.length * 2); a.set(this.next); this.next = a;
          const b = new Int32Array(this.rid.length * 2); b.set(this.rid); this.rid = b;
        }
        const k = j * this.nx + i, e = this.ne++;
        this.rid[e] = id;
        this.next[e] = this.head[k];
        this.head[k] = e;
      }
    return id;
  }
  /** 收集外接框（外扩 m）内的候选 id 到 this.cand，返回个数 */
  gather(u0, u1, v0, v1, m) {
    const s = ++this.sv;
    let n = 0;
    const i0 = this.ci(u0 - m), i1 = this.ci(u1 + m), j0 = this.cj(v0 - m), j1 = this.cj(v1 + m);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        for (let e = this.head[j * this.nx + i]; e >= 0; e = this.next[e]) {
          const id = this.rid[e];
          if (this.stamp[id] === s) continue;
          this.stamp[id] = s;
          if (n >= this.cand.length) { const a = new Int32Array(this.cand.length * 2); a.set(this.cand); this.cand = a; }
          this.cand[n++] = id;
        }
    return n;
  }
  /** 矩形（按 clear[type] 外扩；clear 为按类型下标的数组，< -50 表示忽略该类型）是否与任何已登记矩形相交 */
  hit(u0, u1, v0, v1, clear, skipId = -1) {
    const n = this.gather(u0, u1, v0, v1, 3.5), r = this.r, cand = this.cand;
    for (let k = 0; k < n; k++) {
      const id = cand[k];
      if (id === skipId) continue;
      const o = id * 5;
      const c = clear[r[o + 4]];
      if (!(c > -50)) continue;
      if (r[o] - c < u1 && r[o + 1] + c > u0 && r[o + 2] - c < v1 && r[o + 3] + c > v0) return true;
    }
    return false;
  }
  /** 与矩形相交的指定类型（位掩码）矩形中最小的 v0（无则 Infinity） */
  minV(u0, u1, v0, v1, mask) {
    const n = this.gather(u0, u1, v0, v1, 0), r = this.r, cand = this.cand;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 5;
      if (!((1 << r[o + 4]) & mask)) continue;
      if (r[o] < u1 && r[o + 1] > u0 && r[o + 2] < v1 && r[o + 3] > v0) best = Math.min(best, Math.max(v0, r[o + 2]));
    }
    return best;
  }
  /** 与矩形相交的指定类型矩形：最小 u0（east=true）或最大 u1（east=false），无则 ±Infinity */
  edgeU(u0, u1, v0, v1, mask, east) {
    const n = this.gather(u0, u1, v0, v1, 0), r = this.r, cand = this.cand;
    let best = east ? Infinity : -Infinity;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 5;
      if (!((1 << r[o + 4]) & mask)) continue;
      if (r[o] < u1 && r[o + 1] > u0 && r[o + 2] < v1 && r[o + 3] > v0) best = east ? Math.min(best, Math.max(u0, r[o])) : Math.max(best, Math.min(u1, r[o + 1]));
    }
    return best;
  }
  /** 与矩形相交的第一个指定类型（位掩码）id，无则 -1 */
  first(u0, u1, v0, v1, mask) {
    const n = this.gather(u0, u1, v0, v1, 0), r = this.r, cand = this.cand;
    for (let k = 0; k < n; k++) {
      const id = cand[k], o = id * 5;
      if (!((1 << r[o + 4]) & mask)) continue;
      if (r[o] < u1 && r[o + 1] > u0 && r[o + 2] < v1 && r[o + 3] > v0) return id;
    }
    return -1;
  }
  rect(id) { const o = id * 5; return [this.r[o], this.r[o + 1], this.r[o + 2], this.r[o + 3]]; }
}

// 障碍/放置物类型
const T = { BLD: 0, HOLE: 1, LANE: 2, PARK: 3, PATH: 4, PAD: 5, APRON: 6, OSM: 7, BLDS: 8 /* 小附属房（< 60 m²） */ };
const bit = (...ts) => ts.reduce((m, t) => m | (1 << t), 0);
const S_LANE = bit(T.LANE);
const S_LINK = bit(T.LANE, T.OSM, T.APRON, T.PATH);
const S_GAP = bit(T.BLD, T.BLDS, T.HOLE, T.LANE, T.OSM, T.PARK, T.APRON);
/** 净距表：{类型: 米} → 按类型下标的数组（缺省 = 忽略） */
const CL = (o) => { const a = new Float64Array(9).fill(-99); for (const k in o) a[k] = o[k]; return a; };
const CLx = (base, o) => { const a = base.slice(); for (const k in o) a[k] = o[k]; return a; };
const CL_PCONN = CL({ [T.BLD]: 0.6, [T.BLDS]: 0.2, [T.HOLE]: 0.3, [T.PARK]: 0.2, [T.PAD]: 0.2 });
// 各类测试的净距表（模块级常量：热循环里不再新建对象）
const CL_LANE = CL({ [T.BLD]: 1.2, [T.BLDS]: 0.4, [T.HOLE]: 1.0, [T.LANE]: -99, [T.OSM]: 0.3, [T.PARK]: 0.1, [T.PAD]: 0.5, [T.PATH]: -99, [T.APRON]: -99 });
const CL_APP = CL({ [T.BLD]: 0.8, [T.BLDS]: 0.2, [T.HOLE]: 0.5, [T.PAD]: 0.3 });
const CL_PARK = CL({ [T.BLD]: 0.8, [T.BLDS]: 0.3, [T.HOLE]: 0.6, [T.LANE]: 0.05, [T.OSM]: 0.05, [T.PARK]: 0.05, [T.PAD]: 0.4, [T.PATH]: 0.05, [T.APRON]: 0.05 });
const CL_PATH = CL({ [T.BLD]: 0.9, [T.BLDS]: 0.3, [T.HOLE]: 0.5, [T.LANE]: 0.6, [T.OSM]: 0.6, [T.PARK]: 0.6, [T.PAD]: 0.3, [T.PATH]: 0.8, [T.APRON]: 0.3 });
const CL_PAD = CL({ [T.BLD]: 2.5, [T.BLDS]: 0.8, [T.HOLE]: 1.0, [T.LANE]: 1.0, [T.OSM]: 1.5, [T.PARK]: 0.8, [T.PAD]: 1.5, [T.PATH]: 0.4, [T.APRON]: 0.6 });
const CLK0 = CL({ [T.BLD]: 0.8, [T.BLDS]: 0.2, [T.HOLE]: 0.5 });
const CLK1 = CL({ [T.BLD]: 0.8, [T.BLDS]: 0.2, [T.HOLE]: 0.5, [T.PAD]: 0 });
const CLK2 = CL({ [T.BLD]: 1.2, [T.BLDS]: 0.4, [T.HOLE]: 0.5, [T.PARK]: 0.3, [T.LANE]: 0.2 });
const CLK3 = CL({ [T.BLD]: -0.3, [T.HOLE]: 0, [T.PARK]: 0, [T.PAD]: 0 });
const CLK4 = CL({ [T.BLD]: 0.3, [T.BLDS]: 0.1, [T.PARK]: 0.1, [T.PAD]: 0.2, [T.HOLE]: 0.2 });
const CLK5 = CL({ [T.BLD]: 0.3, [T.PAD]: 0.2, [T.PARK]: 0.1 });
const CLK6 = CLx(CL_PAD, { [T.LANE]: 0.4, [T.BLD]: 2.0, [T.PARK]: 0.3, [T.PATH]: 0.3, [T.APRON]: 0.3 });
const CLK7 = CLx(CL_PAD, { [T.BLD]: 1, [T.LANE]: 1.2, [T.PAD]: 0.5 });
const CLK8 = CLx(CL_PAD, { [T.BLD]: 2, [T.PATH]: 0.2 });

function planOne(G, P, pid) {
  const { B, bbx, bgrid, owner } = G;
  const ring = P.ring;
  // —— 楼：主楼与附属 ——
  const own = P.own;
  if (!own.length) { G.stats.skipEmpty++; return null; }
  // 精建片区：多边形中心或一半以上的楼落在排除区 → 跳过
  let cx = 0, cz = 0;
  for (const b of own) { cx += B.ax[b]; cz += B.az[b]; }
  cx /= own.length; cz /= own.length;
  let nEx = 0;
  for (const b of own) if (G.excluded(B.ax[b], B.az[b])) nEx++;
  if (nEx > own.length * 0.4 || G.excluded(cx, cz)) { G.stats.skipExcl++; return null; }
  // 城中村：自建房占多数
  let nVil = 0, nMain = 0, eraSum = 0, eraN = 0;
  const hs = [];
  for (const b of own) {
    const st = B.style ? B.style[b] : 0;
    if (st >> 4 === 4 || st >> 4 === 3) nVil++;
    const h = B.hd[b] * 0.1;
    if (h >= 6) { nMain++; hs.push(h); }
    if ((st & 15) > 0 && h >= 6) { eraSum += st & 15; eraN++; }
  }
  if (P.k === 'residential' && nVil > own.length * 0.5) { G.stats.skipVillage++; return null; }
  if (!nMain) { G.stats.skipEmpty++; return null; }
  hs.sort((a, b) => a - b);
  const medH = hs[hs.length >> 1];
  const era = eraN ? eraSum / eraN : 0;
  const uni = P.k === 'university';
  const kg = uni && SCHOOL_KG.test(P.name);
  const school = uni && !kg && (SCHOOL.test(P.name) || P.area < 60000);
  const inst = uni && INST.test(P.name); // 医院、研究所等：不放球场/旗杆/健身器材
  // 老小区：1990 年代及以前，或无年代信息但多数为 ≤ 8 层板楼
  const old = !uni && (era ? era < 2.6 : medH <= 24);
  const mode = uni ? 'uni' : old ? 'old' : 'new';

  // —— 主方向（楼栋外墙边方向，模 90°，长度加权，2° 一档，三档平滑） ——
  const hist = new Float64Array(45);
  for (const b of own) {
    const h = B.hd[b] * 0.1;
    if (h < 5) continue;
    const s = B.vs[b] * 2, c = B.vc[b];
    for (let k = 0; k < c; k++) {
      const k2 = (k + 1) % c;
      const dx = (B.offs[s + k2 * 2] - B.offs[s + k * 2]) * 0.1, dz = (B.offs[s + k2 * 2 + 1] - B.offs[s + k * 2 + 1]) * 0.1;
      const L = Math.hypot(dx, dz);
      if (L < 3) continue;
      let a = Math.atan2(dz, dx);
      a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2); // 0..90°
      hist[Math.min(44, Math.floor((a / (Math.PI / 2)) * 45))] += L;
    }
  }
  let bi = 0, bv = -1;
  for (let i = 0; i < 45; i++) {
    const v = hist[(i + 44) % 45] * 0.5 + hist[i] + hist[(i + 1) % 45] * 0.5;
    if (v > bv) { bv = v; bi = i; }
  }
  let th = ((bi + 0.5) / 45) * (Math.PI / 2);
  if (th > Math.PI / 4) th -= Math.PI / 2; // u 轴取偏东西的那一支（-45°..45°）
  const cs = Math.cos(th), sn = Math.sin(th);
  const ox = Math.round(cx), oz = Math.round(cz);
  const toU = (x, z) => (x - ox) * cs + (z - oz) * sn;
  const toV = (x, z) => -(x - ox) * sn + (z - oz) * cs;
  const toX = (u, v) => ox + u * cs - v * sn;
  const toZ = (u, v) => oz + u * sn + v * cs;

  // 多边形（局部坐标）
  const rf = new Float64Array(ring.length);
  let U0 = Infinity, U1 = -Infinity, V0 = Infinity, V1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const u = toU(ring[i], ring[i + 1]), v = toV(ring[i], ring[i + 1]);
    rf[i] = u; rf[i + 1] = v;
    if (u < U0) U0 = u; if (u > U1) U1 = u; if (v < V0) V0 = v; if (v > V1) V1 = v;
  }
  const nE = rf.length / 2;

  const LW = LANE_W[mode], AP = APRON[mode];
  const idx = new RectIndex(16, U0 - 30, V0 - 30, U1 + 30, V1 + 30);
  // —— 障碍：楼（含紧邻的外部楼），局部外接框 ——
  const W0 = P.bb[0] - 20, W1 = P.bb[2] + 20, Z0 = P.bb[1] - 20, Z1 = P.bb[3] + 20;
  const seen = new Set();
  const blds = []; // 本小区主楼 {b, u0,u1,v0,v1,h, id}
  bgrid.each(W0, Z0, W1, Z1, (b) => {
    if (seen.has(b)) return;
    seen.add(b);
    if (bbx[b * 4 + 2] < W0 || bbx[b * 4] > W1 || bbx[b * 4 + 3] < Z0 || bbx[b * 4 + 1] > Z1) return;
    const s = B.vs[b] * 2, c = B.vc[b], ax = B.ax[b], az = B.az[b];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < c; k++) {
      const x = ax + B.offs[s + k * 2] * 0.1, z = az + B.offs[s + k * 2 + 1] * 0.1;
      const u = toU(x, z), v = toV(x, z);
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const h = B.hd[b] * 0.1;
    const small = (u1 - u0) * (v1 - v0) < 60 && h < 6;
    const id = idx.add(u0, u1, v0, v1, small ? T.BLDS : T.BLD);
    if (owner[b] === pid && !small && h >= 5 && (u1 - u0) * (v1 - v0) >= 120) blds.push({ b, u0, u1, v0, v1, h, id });
  });
  if (!blds.length) { G.stats.skipEmpty++; return null; }
  // 嵌套的内层多边形（幼儿园等）与 landuse 洞 → 障碍
  const holeRings = [];
  for (const h of P.holes) holeRings.push(h);
  if (P.k === 'cluster') {
    // 楼群范围是推出来的：与之相交的所有其他用地多边形（别的小区、公园、商业……）都当障碍
    G.polyGrid.each(P.bb[0], P.bb[1], P.bb[2], P.bb[3], (j) => {
      const q = G.polys[j];
      if (q === P || q.bb[2] < P.bb[0] || q.bb[0] > P.bb[2] || q.bb[3] < P.bb[1] || q.bb[1] > P.bb[3]) return;
      if (!holeRings.includes(q.ring)) holeRings.push(q.ring);
    });
    G.luGrid.each(P.bb[0], P.bb[1], P.bb[2], P.bb[3], (j) => {
      const q = G.luBB[j];
      if (q[2] < P.bb[0] || q[0] > P.bb[2] || q[3] < P.bb[1] || q[1] > P.bb[3]) return;
      const o = G.otherLU[j].outer;
      if (!holeRings.includes(o)) holeRings.push(o);
    });
  }
  G.polyGrid.each(P.bb[0], P.bb[1], P.bb[2], P.bb[3], (j) => {
    const q = G.polys[j];
    if (q === P || q.area >= P.area) return;
    if (q.bb[0] < P.bb[0] - 1 || q.bb[2] > P.bb[2] + 1 || q.bb[1] < P.bb[1] - 1 || q.bb[3] > P.bb[3] + 1) return;
    const o = q.ring;
    let mx = 0, mz = 0;
    for (let i = 0; i < o.length; i += 2) { mx += o[i]; mz += o[i + 1]; }
    mx /= o.length / 2; mz /= o.length / 2;
    if (pip(mx, mz, ring)) holeRings.push(o);
  });
  // 普通小区：洞按外接框当障碍；楼群小区：洞在 4 m 栅格里精确挖掉（见下方 mask），外接框太保守会把整片挡死
  if (P.k !== 'cluster')
    for (const h of holeRings) {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < h.length; i += 2) {
        const u = toU(h[i], h[i + 1]), v = toV(h[i], h[i + 1]);
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      idx.add(u0, u1, v0, v1, T.HOLE);
    }

  // —— 道路段（局部坐标）：市政道路 = 障碍；小区内 OSM 道路 = 已有车行道 ——
  const segs = []; // {au,av,bu,bv,clear,cls,internal,fi,hw}
  const fInside = new Map(); // fi -> 多边形内长度占比
  const sIdx = new RectIndex(24, U0 - 40, V0 - 40, U1 + 40, V1 + 40); // 道路段外接框（含净距）索引，type 字段存段下标
  {
    const s0 = new Set();
    G.rgrid.each(W0, Z0, W1, Z1, (id) => {
      if (s0.has(id)) return;
      s0.add(id);
      const r = G.rsegs[id];
      segs.push({ au: toU(r[0], r[1]), av: toV(r[0], r[1]), bu: toU(r[2], r[3]), bv: toV(r[2], r[3]), clear: r[4], cls: r[5], fi: r[6], hw: r[7], ax: r[0], az: r[1], bx: r[2], bz: r[3] });
    });
    // 小区内道路：service/residential/unclassified/footway/pedestrian，且全长 60% 以上在小区内（穿越小区的市政路不算）
    for (const s of segs) {
      const c = s.cls;
      if (!(c === 5 || c === 6 || c === 7 || c === 13 || c === 12)) { s.internal = false; continue; }
      let fr = fInside.get(s.fi);
      if (fr === undefined) {
        const p = G.roads[s.fi].p;
        let inL = 0;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const mx = (p[i] + p[i + 2]) / 2, mz = (p[i + 1] + p[i + 3]) / 2;
          if (mx < P.bb[0] || mx > P.bb[2] || mz < P.bb[1] || mz > P.bb[3]) continue;
          if (pip(mx, mz, ring)) inL += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
        }
        fr = inL / Math.max(1, G.flen[s.fi]);
        fInside.set(s.fi, fr);
      }
      s.inFrac = fr;
      s.internal = fr >= 0.6;
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const c = (s.internal ? s.hw + 0.3 : s.cls === 13 ? 0.5 : s.clear) + 0.6;
      sIdx.add(Math.min(s.au, s.bu) - c, Math.max(s.au, s.bu) + c, Math.min(s.av, s.bv) - c, Math.max(s.av, s.bv) + c, i);
    }
  }
  const roadHit = (u0, u1, v0, v1, extra = 0, internalToo = true) => {
    const n = sIdx.gather(u0, u1, v0, v1, 2.6), cand = sIdx.cand, R = sIdx.r;
    for (let k = 0; k < n; k++) {
      const s = segs[R[cand[k] * 5 + 4]];
      if (s.internal && !internalToo) continue;
      const c = (s.internal ? s.hw + 0.3 : s.cls === 13 ? 0.5 : s.clear) + extra;
      if (segHitsBox(s.au, s.av, s.bu, s.bv, u0 - c, u1 + c, v0 - c, v1 + c)) return true;
    }
    return false;
  };

  // —— 多边形内测试：中心在内且没有边界边进入（外扩 m）。4 m 栅格（内部/近边界/外部）先快速判定 ——
  const MC = Math.max(4, Math.ceil(Math.sqrt(((U1 - U0) * (V1 - V0)) / 30000)));
  const mw = Math.max(1, Math.ceil((U1 - U0) / MC) + 2), mh = Math.max(1, Math.ceil((V1 - V0) / MC) + 2);
  const mu0 = U0 - MC, mv0 = V0 - MC;
  const mask = new Uint8Array(mw * mh); // 0 外 1 内 2 近边界
  {
    // 扫描线填充（格心在内）
    for (let j = 0; j < mh; j++) {
      const vc = mv0 + (j + 0.5) * MC;
      const xs = [];
      for (let i = 0, k = nE - 1; i < nE; k = i++) {
        const va = rf[k * 2 + 1], vb = rf[i * 2 + 1];
        if (va > vc !== vb > vc) xs.push(rf[k * 2] + ((vc - va) * (rf[i * 2] - rf[k * 2])) / (vb - va));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const ia = Math.max(0, Math.ceil((xs[q] - mu0) / MC - 0.5)), ib = Math.min(mw - 1, Math.floor((xs[q + 1] - mu0) / MC - 0.5));
        for (let i = ia; i <= ib; i++) mask[j * mw + i] = 1;
      }
    }
    // 边界边经过的格及其 8 邻格 → 近边界
    for (let i = 0, k = nE - 1; i < nE; k = i++) {
      const ua = rf[k * 2], va = rf[k * 2 + 1], ub = rf[i * 2], vb = rf[i * 2 + 1];
      const L = Math.hypot(ub - ua, vb - va), n = Math.max(1, Math.ceil(L / (MC * 0.5)));
      for (let s = 0; s <= n; s++) {
        const ci = Math.floor((ua + ((ub - ua) * s) / n - mu0) / MC), cj = Math.floor((va + ((vb - va) * s) / n - mv0) / MC);
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const x = ci + di, y = cj + dj;
            if (x >= 0 && y >= 0 && x < mw && y < mh) mask[y * mw + x] = 2;
          }
      }
    }
  }
  if (P.k === 'cluster' && holeRings.length) {
    // 洞内与洞边（外扩一格）都标为外部
    for (const h of holeRings) {
      const hf = new Float64Array(h.length);
      for (let i = 0; i < h.length; i += 2) { hf[i] = toU(h[i], h[i + 1]); hf[i + 1] = toV(h[i], h[i + 1]); }
      const nH = hf.length / 2;
      for (let j = 0; j < mh; j++) {
        const vc = mv0 + (j + 0.5) * MC;
        const xs = [];
        for (let i = 0, k = nH - 1; i < nH; k = i++) {
          const va = hf[k * 2 + 1], vb = hf[i * 2 + 1];
          if (va > vc !== vb > vc) xs.push(hf[k * 2] + ((vc - va) * (hf[i * 2] - hf[k * 2])) / (vb - va));
        }
        xs.sort((a, b) => a - b);
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const ia = Math.max(0, Math.floor((xs[q] - mu0) / MC) - 1), ib = Math.min(mw - 1, Math.ceil((xs[q + 1] - mu0) / MC));
          for (let i = ia; i <= ib; i++) mask[j * mw + i] = 0;
        }
      }
    }
  }
  const inPolyFull = (u0, u1, v0, v1, m) => {
    if (!pip((u0 + u1) / 2, (v0 + v1) / 2, rf)) return false;
    const a0 = u0 - m, a1 = u1 + m, b0 = v0 - m, b1 = v1 + m;
    for (let i = 0, j = nE - 1; i < nE; j = i++) {
      if (segHitsBox(rf[j * 2], rf[j * 2 + 1], rf[i * 2], rf[i * 2 + 1], a0, a1, b0, b1)) return false;
    }
    return true;
  };
  const inPoly = (u0, u1, v0, v1, m) => {
    const i0 = Math.floor((u0 - m - mu0) / MC), i1 = Math.floor((u1 + m - mu0) / MC);
    const j0 = Math.floor((v0 - m - mv0) / MC), j1 = Math.floor((v1 + m - mv0) / MC);
    if (i0 < 0 || j0 < 0 || i1 >= mw || j1 >= mh) return false;
    let edge = false;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const v = mask[j * mw + i];
        if (v === 0) return false;
        if (v === 2) edge = true;
      }
    return edge ? inPolyFull(u0, u1, v0, v1, m) : true;
  };
  const inside = (u, v) => {
    const i = Math.floor((u - mu0) / MC), j = Math.floor((v - mv0) / MC);
    if (i < 0 || j < 0 || i >= mw || j >= mh) return false;
    const m = mask[j * mw + i];
    return m === 2 ? pip(u, v, rf) : m === 1;
  };

  const laneFree = (u0, u1, v0, v1) => inPoly(u0, u1, v0, v1, 2.2) && !idx.hit(u0, u1, v0, v1, CL_LANE) && !roadHit(u0, u1, v0, v1, 1.6, true);

  /**
   * 一条带（沿 along 轴从 a0 起 nU 个长 Wd 的单元，横向 c0..c1）里每个单元是否可用：
   * 先按障碍物外接框（含净距）整段标记占用，再对剩下的单元测道路与多边形边界——比逐格调用 hit 快一个量级
   */
  const freeUnits = (along, a0, Wd, nU, c0, c1, clear, margin, rExtra, rInt) => {
    const ok = new Uint8Array(nU).fill(1);
    const a1 = a0 + nU * Wd;
    const u0 = along ? a0 : c0, u1 = along ? a1 : c1, v0 = along ? c0 : a0, v1 = along ? c1 : a1;
    let n = idx.gather(u0, u1, v0, v1, 3.5);
    let R = idx.r, cand = idx.cand;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 5;
      const c = clear[R[o + 4]];
      if (!(c > -50)) continue;
      const ru0 = R[o] - c, ru1 = R[o + 1] + c, rv0 = R[o + 2] - c, rv1 = R[o + 3] + c;
      if (ru0 >= u1 || ru1 <= u0 || rv0 >= v1 || rv1 <= v0) continue;
      const b0 = along ? ru0 : rv0, b1 = along ? ru1 : rv1;
      const i0 = Math.max(0, Math.floor((b0 - a0) / Wd)), i1 = Math.min(nU - 1, Math.ceil((b1 - a0) / Wd) - 1);
      for (let i = i0; i <= i1; i++) ok[i] = 0;
    }
    n = sIdx.gather(u0, u1, v0, v1, 2.6);
    R = sIdx.r; cand = sIdx.cand;
    for (let k = 0; k < n; k++) {
      const sg = segs[R[cand[k] * 5 + 4]];
      if (sg.internal && !rInt) continue;
      // 市政路外侧留出行道树带（rExtra），小区内道路只留路肩
      const c = sg.internal ? sg.hw + 0.5 : (sg.cls === 13 ? 0.5 : sg.clear) + rExtra;
      const b0 = (along ? Math.min(sg.au, sg.bu) : Math.min(sg.av, sg.bv)) - c, b1 = (along ? Math.max(sg.au, sg.bu) : Math.max(sg.av, sg.bv)) + c;
      const i0 = Math.max(0, Math.floor((b0 - a0) / Wd)), i1 = Math.min(nU - 1, Math.ceil((b1 - a0) / Wd) - 1);
      for (let i = i0; i <= i1; i++) {
        if (!ok[i]) continue;
        const s0 = a0 + i * Wd, s1 = s0 + Wd;
        const hitR = along ? segHitsBox(sg.au, sg.av, sg.bu, sg.bv, s0 - c, s1 + c, c0 - c, c1 + c) : segHitsBox(sg.au, sg.av, sg.bu, sg.bv, c0 - c, c1 + c, s0 - c, s1 + c);
        if (hitR) ok[i] = 0;
      }
    }
    for (let i = 0; i < nU; i++) {
      if (!ok[i]) continue;
      const s0 = a0 + i * Wd, s1 = s0 + Wd;
      if (!(along ? inPoly(s0, s1, c0, c1, margin) : inPoly(c0, c1, s0, s1, margin))) ok[i] = 0;
    }
    return ok;
  };

  const lanes = []; // {u0,u1,v0,v1,dir 0=沿u 1=沿v, kind, id}
  const addLane = (u0, u1, v0, v1, dir, kind) => {
    const L = { u0, u1, v0, v1, dir, kind };
    L.id = idx.add(u0, u1, v0, v1, T.LANE);
    lanes.push(L);
    return L;
  };

  // —— 小区内 OSM 道路：登记为已有车行道（roads 模块画路面） ——
  const osm = [];
  for (const s of segs) {
    if (!s.internal || s.cls === 13 || s.cls === 12) continue;
    const L = Math.hypot(s.bu - s.au, s.bv - s.av);
    if (L < 4) continue;
    osm.push(s);
    // 外接框登记为车行道（防止停车、设施压上去）
    idx.add(Math.min(s.au, s.bu) - s.hw * 0.7, Math.max(s.au, s.bu) + s.hw * 0.7, Math.min(s.av, s.bv) - s.hw * 0.7, Math.max(s.av, s.bv) + s.hw * 0.7, T.OSM);
  }

  // —— 运动场地（OSM 操场/球场）：中心在小区内 → 障碍（不铺车行道/车位/设施），渲染与草坪栅格另行处理 ——
  const fields = [];
  {
    const seenF = new Set();
    G.sgrid.each(P.bb[0], P.bb[1], P.bb[2], P.bb[3], (i) => {
      if (seenF.has(i)) return;
      seenF.add(i);
      const f = G.sports[i];
      if (!pip(f.cx, f.cz, ring)) return;
      fields.push(i);
      if (P.k === 'university') f.campus = true;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      const p = f.p;
      for (let k = 0; k < p.length; k += 2) {
        const u = toU(p[k], p[k + 1]), v = toV(p[k], p[k + 1]);
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      idx.add(u0 - 1, u1 + 1, v0 - 1, v1 + 1, T.HOLE);
    });
  }
  const hasCourt = fields.some((i) => G.sports[i].kind === 'basketball');
  const hasField = fields.some((i) => G.sports[i].kind === 'track' || G.sports[i].kind === 'soccer');

  // —— 1. 宅前车行道 ——
  const cands = [];
  for (const b of blds) {
    const len = b.u1 - b.u0;
    if (len < 8) continue;
    cands.push({ v: b.v0 - AP - LW / 2, u0: b.u0 - 2, u1: b.u1 + 2, w: len });
  }
  cands.sort((a, b) => a.v - b.v);
  const groups = [];
  for (const c of cands) {
    let g = null;
    for (const q of groups) {
      if (Math.abs(q.v - c.v) < 3.2 && c.u0 < q.u1 + 30 && c.u1 > q.u0 - 30) { g = q; break; }
    }
    if (g) {
      g.v = (g.v * g.w + c.v * c.w) / (g.w + c.w);
      g.w += c.w;
      g.u0 = Math.min(g.u0, c.u0);
      g.u1 = Math.max(g.u1, c.u1);
    } else groups.push({ ...c });
  }
  const STEP = 3;
  // 核心区间内逐格测试取连续空段，碰到核心区间两端的空段再向外延伸直到被挡（最多 ext 米）
  const runsAlongU = (v, w, ua, ub, ext) => {
    // 核心区间 + 两侧延伸区一次算出每 3 m 单元是否可用，取与核心区间相连的连续段
    const xa = Math.max(U0 - 5, ua - ext), xb = Math.min(U1 + 5, ub + ext);
    const nU = Math.max(1, Math.round((xb - xa) / STEP)), st = (xb - xa) / nU;
    const ok = freeUnits(true, xa, st, nU, v - w / 2, v + w / 2, CL_LANE, 2.2, 1.6, true);
    const out = [];
    const ka = Math.floor((ua - xa) / st), kb = Math.ceil((ub - xa) / st);
    for (let i = 0; i < nU; ) {
      if (!ok[i]) { i++; continue; }
      let j = i;
      while (j < nU && ok[j]) j++;
      if (j > ka && i < kb) out.push([xa + i * st, xa + j * st]); // 与核心区间有交
      i = j;
    }
    return out;
  };
  const EXT = 60;
  groups.sort((a, b) => b.w - a.w);
  for (const g of groups) {
    const runs = runsAlongU(g.v, LW, g.u0, g.u1, EXT);
    for (const [a, b] of runs) {
      const ov = Math.min(b, g.u1) - Math.max(a, g.u0);
      if (ov < Math.min(10, (g.u1 - g.u0) * 0.4) || b - a < 12) continue;
      // 与已有车行道平行重叠 → 跳过
      if (idx.first(a, b, g.v - LW / 2 + 0.5, g.v + LW / 2 - 0.5, S_LANE) >= 0) continue;
      addLane(a, b, g.v - LW / 2, g.v + LW / 2, 0, 'lane');
    }
  }
  G.stats.lanes += lanes.length;

  // —— 2. 连接道：相邻（v 方向）两条车行道之间找一条竖向通道 ——
  const hl = lanes.filter((l) => l.dir === 0).sort((a, b) => a.v0 - b.v0);
  const laneFreeV = (u0, u1, v0, v1) => inPoly(u0, u1, v0, v1, 2.0) && !idx.hit(u0, u1, v0, v1, CL_LANE) && !roadHit(u0, u1, v0, v1, 1.6, true);
  for (let i = 0; i < hl.length; i++) {
    const A = hl[i];
    for (let j = i + 1; j < hl.length; j++) {
      const Bl = hl[j];
      if (Bl.v0 - A.v1 > 160) break;
      if (Bl.v0 - A.v1 < 3) continue;
      const a = Math.max(A.u0, Bl.u0) + LW / 2 + 0.5, b = Math.min(A.u1, Bl.u1) - LW / 2 - 0.5;
      if (b < a) continue;
      const tries = [a, b, (a + b) / 2, a + (b - a) * 0.25, a + (b - a) * 0.75];
      let done = false;
      for (const u of tries) {
        const r = [u - LW / 2, u + LW / 2, A.v1 - 0.01, Bl.v0 + 0.01];
        if (laneFreeV(r[0], r[1], r[2], r[3])) {
          addLane(r[0], r[1], r[2], r[3], 1, 'conn');
          done = true;
          G.stats.conns++;
          break;
        }
      }
      if (done) break;
    }
  }

  // —— 3. 大门 ——
  // 候选：(a) OSM 小区内道路穿越边界处；(b) 车行道端头/连接道沿轴向延伸到边界外紧邻市政路；(c) 照片大门
  const gates = [];
  const roadNear = (x, z, r) => {
    // 返回最近的市政道路段（不含小区内道路与步行道）及距离（路面边缘起算）
    let best = null, bd = r;
    const u = toU(x, z), v = toV(x, z);
    const n = sIdx.gather(u, u, v, v, r), cand = sIdx.cand, R = sIdx.r;
    for (let k = 0; k < n; k++) {
      const s = segs[R[cand[k] * 5 + 4]];
      if (s.internal || s.cls >= 12) continue;
      const d = Math.sqrt(segDist2(x, z, s.ax, s.az, s.bx, s.bz)) - s.hw;
      if (d < bd) { bd = d; best = s; }
    }
    return best ? { s: best, d: bd } : null;
  };
  // 从局部点 (u,v) 沿单位方向 (du,dv) 走到多边形外：返回出界距离（无则 -1）
  const castOut = (u, v, du, dv, maxD) => {
    if (inside(u + du * maxD, v + dv * maxD)) return -1; // 走到最远仍在小区内：不是边界
    let lo = 0, hi = maxD;
    for (let k = 0; k < 5; k++) { const m = (lo + hi) / 2; if (inside(u + du * m, v + dv * m)) lo = m; else hi = m; }
    return hi;
  };
  const gc = [];
  // (a) OSM 道路穿越边界
  for (const s of segs) {
    if (s.cls >= 12 || !(s.cls === 5 || s.cls === 6 || s.cls === 7)) continue;
    const ia = pip(s.au, s.av, rf), ib = pip(s.bu, s.bv, rf);
    if (ia === ib) continue;
    // 交点（二分）
    let lo = 0, hi = 1;
    for (let k = 0; k < 18; k++) {
      const m = (lo + hi) / 2;
      const im = pip(s.au + (s.bu - s.au) * m, s.av + (s.bv - s.av) * m, rf);
      if (im === ia) lo = m; else hi = m;
    }
    const t = (lo + hi) / 2;
    const u = s.au + (s.bu - s.au) * t, v = s.av + (s.bv - s.av) * t;
    let du = s.bu - s.au, dv = s.bv - s.av;
    const L = Math.hypot(du, dv) || 1;
    du /= L; dv /= L;
    if (!ia) { /* a 在外 b 在内：方向已指向内 */ } else { du = -du; dv = -dv; }
    const internal = (s.inFrac || 0) >= 0.25;
    if (!internal) continue; // 穿越小区的市政路：只开口不设门
    gc.push({ u, v, du, dv, w: Math.max(LW, s.hw * 2), score: 10, osm: true, conn: null });
  }
  // (b) 车行道端头
  const tryEnd = (u, v, du, dv, w, base) => {
    const t = castOut(u, v, du, dv, 16);
    if (t < 0) return;
    const bu = u + du * t, bv = v + dv * t;
    const x = toX(bu, bv), z = toZ(bu, bv);
    const rn = roadNear(toX(bu + du * 3, bv + dv * 3), toZ(bu + du * 3, bv + dv * 3), 22);
    if (!rn) return;
    // 门前通道（从车行道端头到边界）不能压楼
    const r = du !== 0 ? [Math.min(u, bu), Math.max(u, bu), v - w / 2, v + w / 2] : [u - w / 2, u + w / 2, Math.min(v, bv), Math.max(v, bv)];
    if (idx.hit(r[0], r[1], r[2], r[3], CLK0)) return;
    if (roadHit(r[0], r[1], r[2], r[3], -0.5, false) && t > 4) return;
    const clsScore = [0.2, 0.3, 0.6, 1.0, 1.1, 1.0, 0.7, 0.9, 0.2, 0.3, 0.5, 0.7][rn.s.cls] ?? 0.5;
    gc.push({ u: bu, v: bv, du: -du, dv: -dv, w, score: base * clsScore - t * 0.08 - rn.d * 0.05, osm: false, conn: r, x, z });
  };
  for (const L of lanes) {
    if (L.dir === 0) {
      const v = (L.v0 + L.v1) / 2;
      tryEnd(L.u0, v, -1, 0, LW, 5);
      tryEnd(L.u1, v, 1, 0, LW, 5);
      // 车行道中段向北/南直通边界（常见的“正门 → 主路”）
      for (const f of [0.5]) {
        const u = L.u0 + (L.u1 - L.u0) * f;
        tryEnd(u, L.v0, 0, -1, LW, 3.5);
        tryEnd(u, L.v1, 0, 1, LW, 3.5);
      }
    } else {
      const u = (L.u0 + L.u1) / 2;
      tryEnd(u, L.v0, 0, -1, LW, 4);
      tryEnd(u, L.v1, 0, 1, LW, 4);
    }
  }
  // (c) 沿边界每 ~10 m 取点：外侧 18 m 内有市政路 → 沿最接近“指向小区内”的坐标轴向内走到第一条车行道（≤ 70 m，不压楼）
  for (let i = 0, k = nE - 1; i < nE; k = i++) {
    const ua = rf[k * 2], va = rf[k * 2 + 1], ub = rf[i * 2], vb = rf[i * 2 + 1];
    const L = Math.hypot(ub - ua, vb - va);
    if (L < 8) continue;
    let nu = -(vb - va) / L, nv = (ub - ua) / L;
    if (!inside((ua + ub) / 2 + nu * 2, (va + vb) / 2 + nv * 2)) { nu = -nu; nv = -nv; }
    let du = 0, dv = 0;
    if (Math.abs(nu) > Math.abs(nv)) du = Math.sign(nu); else dv = Math.sign(nv);
    if (Math.abs(nu * du + nv * dv) < 0.75) continue; // 边界与轴向太斜，不在这里开门
    const ns = Math.max(1, Math.floor(L / 10));
    for (let s = 0; s < ns; s++) {
      const t = (s + 0.5) / ns;
      const bu = ua + (ub - ua) * t, bv = va + (vb - va) * t;
      const rn = roadNear(toX(bu - nu * 4, bv - nv * 4), toZ(bu - nu * 4, bv - nv * 4), 16);
      if (!rn) continue;
      let reach = -1;
      for (let d = 2; d <= 70; d += 2) {
        const pa = d - 2, pb = d;
        let u0, u1, v0, v1;
        if (du) { const a = bu + du * pa, b = bu + du * pb; u0 = Math.min(a, b); u1 = Math.max(a, b); v0 = bv - LW / 2; v1 = bv + LW / 2; }
        else { const a = bv + dv * pa, b = bv + dv * pb; v0 = Math.min(a, b); v1 = Math.max(a, b); u0 = bu - LW / 2; u1 = bu + LW / 2; }
        if (idx.first(u0, u1, v0, v1, S_LANE) >= 0) { reach = d; break; }
        if (idx.hit(u0, u1, v0, v1, CL_APP)) break;
        if (d > 6 && !inside((u0 + u1) / 2, (v0 + v1) / 2)) break;
      }
      if (reach < 0) continue;
      const r = du ? [Math.min(bu, bu + du * reach), Math.max(bu, bu + du * reach), bv - LW / 2, bv + LW / 2] : [bu - LW / 2, bu + LW / 2, Math.min(bv, bv + dv * reach), Math.max(bv, bv + dv * reach)];
      const clsScore = [0.2, 0.3, 0.6, 1.0, 1.1, 1.0, 0.7, 0.9, 0.2, 0.3, 0.5, 0.7][rn.s.cls] ?? 0.5;
      gc.push({ u: bu, v: bv, du, dv, w: LW, score: 4.2 * clsScore - reach * 0.04 - rn.d * 0.05, osm: false, conn: r });
    }
  }
  // 照片大门
  for (const g of G.photoGates) {
    if (g.x < P.bb[0] - 40 || g.x > P.bb[2] + 40 || g.z < P.bb[1] - 40 || g.z > P.bb[3] + 40) continue;
    const u = toU(g.x, g.z), v = toV(g.x, g.z);
    if (ringDist(u, v, rf) > 35) continue;
    const du = g.dx * cs + g.dz * sn, dv = -g.dx * sn + g.dz * cs;
    gc.push({ u, v, du, dv, w: LW, score: 20, osm: false, photo: true, conn: null });
  }
  gc.sort((a, b) => b.score - a.score);
  const maxGates = P.k === 'cluster' ? 0 : P.area > 120000 ? 3 : P.area > 40000 ? 2 : 1;
  for (const c of gc) {
    if (gates.length >= maxGates && (!(c.osm || c.photo) || P.k === 'cluster')) break;
    if (gates.some((g) => Math.hypot(g.u - c.u, g.v - c.v) < (c.osm || c.photo ? 25 : 90))) continue;
    // 门前连接段登记为车行道
    if (c.conn) {
      const r = c.conn;
      if (idx.hit(r[0], r[1], r[2], r[3], CLK1)) continue;
      if (r[1] - r[0] > 0.6 && r[3] - r[2] > 0.6) addLane(r[0], r[1], r[2], r[3], c.du !== 0 ? 0 : 1, 'gate');
    }
    gates.push({ u: c.u, v: c.v, du: c.du, dv: c.dv, w: c.w, osm: !!c.osm, photo: !!c.photo, main: gates.length === 0 });
  }
  G.stats.gates += gates.length;

  // —— 4. 停车 ——
  const parks = []; // {u0,u1,v0,v1, dir (车位排列方向 0=沿u), type 'perp'|'para', side, lines, n}
  const rnd = mulberry((pid * 9973 + 17) >>> 0);
  const parkFree = (u0, u1, v0, v1) => inPoly(u0, u1, v0, v1, 1.0) && !idx.hit(u0, u1, v0, v1, CL_PARK) && !roadHit(u0, u1, v0, v1, 2.0, true);
  const gateNear = (u, v, r) => gates.some((g) => Math.hypot(g.u - u, g.v - v) < r);
  // 车位带：沿车行道一侧按车位逐格可用性取连续段（二分：整段可用就整段收下，否则拆半，避免逐格测试）
  const strip = (L, side, type) => {
    const D = type === 'perp' ? PERP_D : PARA_D, Wd = type === 'perp' ? PERP_W : PARA_L;
    const along = L.dir === 0;
    const a0 = (along ? L.u0 : L.v0) + 1.5, a1 = (along ? L.u1 : L.v1) - 1.5;
    const nU = Math.floor((a1 - a0) / Wd);
    if (nU < 2) return [];
    const c0 = side < 0 ? (along ? L.v0 : L.u0) - 0.15 - D : (along ? L.v1 : L.u1) + 0.15, c1 = c0 + D;
    const ok = freeUnits(along, a0, Wd, nU, c0, c1, CL_PARK, 1.0, 2.0, true);
    for (let i = 0; i < nU; i++) {
      if (!ok[i]) continue;
      const m = a0 + (i + 0.5) * Wd, mc = (c0 + c1) / 2;
      if (along ? gateNear(m, mc, 14) : gateNear(mc, m, 14)) ok[i] = 0;
    }
    const out = [];
    const minN = type === 'perp' ? 3 : 2;
    for (let i = 0; i < nU; ) {
      if (!ok[i]) { i++; continue; }
      let j = i;
      while (j < nU && ok[j]) j++;
      if (j - i >= minN) {
        const s = a0 + i * Wd, e = a0 + j * Wd;
        out.push(along ? { u0: s, u1: e, v0: c0, v1: c1, dir: 0, type, side, n: j - i } : { u0: c0, u1: c1, v0: s, v1: e, dir: 1, type, side, n: j - i });
      }
      i = j;
    }
    return out;
  };
  const addPark = (r, lines) => {
    r.lines = lines;
    r.id = idx.add(r.u0, r.u1, r.v0, r.v1, T.PARK);
    parks.push(r);
    G.stats.stalls += r.n;
  };
  for (const L of lanes) {
    if (L.kind === 'gate') continue;
    const len = L.dir === 0 ? L.u1 - L.u0 : L.v1 - L.v0;
    if (len < 14) continue;
    for (const side of [-1, 1]) {
      // 新小区：路侧平行车位为主，宽裕处约三成改垂直；老小区：垂直为主（无车位线的占一半）；校园：垂直
      const perp = mode === 'old' ? rnd() < 0.75 : mode === 'uni' ? rnd() < 0.6 : rnd() < 0.3;
      const tryTypes = perp ? ['perp', 'para'] : ['para'];
      for (const ty of tryTypes) {
        const rs = strip(L, side, ty);
        if (!rs.length) continue;
        for (const r of rs) addPark(r, mode === 'old' ? rnd() < 0.45 : true);
        break;
      }
    }
  }
  // 小区内 OSM 道路两侧：平行停车（任意方向，按段记录；只登记外接框给障碍索引）
  const osmParks = [];
  for (const s of osm) {
    const L = Math.hypot(s.bu - s.au, s.bv - s.av);
    if (L < 16) continue;
    const du = (s.bu - s.au) / L, dv = (s.bv - s.av) / L;
    for (const side of [-1, 1]) {
      if (rnd() < 0.35) continue;
      const off = s.hw + 0.2 + PARA_D / 2;
      const nu = -dv * side, nv = du * side;
      const n = Math.floor((L - 6) / PARA_L);
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          osmParks.push({ au: run[0][0], av: run[0][1], du, dv, nu, nv, n: run.length, off });
          G.stats.stalls += run.length;
        }
        run = [];
      };
      for (let k = 0; k < n; k++) {
        const t = 3 + k * PARA_L + PARA_L / 2;
        const cu = s.au + du * t + nu * off, cv = s.av + dv * t + nv * off;
        // 粗测：车位中心在多边形内、不贴楼/设施、不压市政路
        if (!pip(cu, cv, rf) || idx.hit(cu - 1.3, cu + 1.3, cv - 1.3, cv + 1.3, CLK2) || roadHit(cu - 1.1, cu + 1.1, cv - 1.1, cv + 1.1, 0, false)) { flush(); continue; }
        // run 只记段首位置，长度即车位数
        run.push(run.length ? null : [s.au + du * (3 + k * PARA_L) + nu * off, s.av + dv * (3 + k * PARA_L) + nv * off]);
      }
      flush();
    }
  }

  // —— 5. 入户铺装带 + 宅前园路 ——
  const aprons = [], paths = [], gardens = [];
  for (const b of blds) {
    // 北侧入户铺装带：楼与车行道之间（车行道恰好在 AP 处）；没有车行道时也铺 AP 宽
    const r = [b.u0 - 0.5, b.u1 + 0.5, b.v0 - AP, b.v0 - 0.05];
    if (inPoly(r[0], r[1], r[2], r[3], 0.5) && !idx.hit(r[0], r[1], r[2], r[3], CLK3, b.id) && !roadHit(r[0], r[1], r[2], r[3], 1.0, false)) {
      aprons.push({ u0: r[0], u1: r[1], v0: r[2], v1: r[3] });
      idx.add(r[0], r[1], r[2], r[3], T.APRON);
    }
  }
  for (const b of blds) {
    // 南侧宅间绿地：楼南墙到南面最近障碍
    let gap = Math.min(60, idx.minV(b.u0 + 1, b.u1 - 1, b.v1 + 0.5, b.v1 + 60, S_GAP) - b.v1);
    for (let v = b.v1 + 1; v < b.v1 + gap; v += 2) {
      if (!inside(b.u0 + 0.5, v) || !inside(b.u1 - 0.5, v) || !inside((b.u0 + b.u1) / 2, v)) { gap = v - b.v1; break; }
    }
    b.gapS = gap;
    if (gap >= 8 && b.u1 - b.u0 > 8) gardens.push({ u0: b.u0 + 0.5, u1: b.u1 - 0.5, v0: b.v1 + 1.6, v1: b.v1 + gap - 1.2 });
    if (gap < 11) continue;
    const pw = mode === 'old' ? 1.5 : 2.0;
    const vc = b.v1 + Math.min(gap * 0.42, 9);
    // 沿 u 的园路（逐格测试取最长连续段）
    let best = null, s = null;
    for (let u = b.u0 - 6; u < b.u1 + 6; u += 3) {
      const ok = inPoly(u, u + 3, vc - pw / 2, vc + pw / 2, 1.5) && !idx.hit(u, u + 3, vc - pw / 2, vc + pw / 2, CL_PATH);
      if (ok) { if (s === null) s = u; }
      else if (s !== null) { if (!best || u - s > best[1] - best[0]) best = [s, u]; s = null; }
    }
    if (s !== null && (!best || b.u1 + 6 - s > best[1] - best[0])) best = [s, b.u1 + 6];
    if (!best || best[1] - best[0] < 10) continue;
    const pr = { u0: best[0], u1: best[1], v0: vc - pw / 2, v1: vc + pw / 2, dir: 0 };
    paths.push(pr);
    idx.add(pr.u0, pr.u1, pr.v0, pr.v1, T.PATH);
    b.path = pr;
    // 园路两端各接一条竖向小路到北侧铺装带（绕过楼端）或南面车行道
    for (const end of [pr.u0 + pw / 2, pr.u1 - pw / 2]) {
      for (const dir of [1, -1]) {
        let hitAt = -1;
        for (let t = 2; t < 40; t += 2) {
          const v = dir > 0 ? pr.v1 + t : pr.v0 - t;
          const id = idx.first(end - pw / 2, end + pw / 2, v - 1, v + 1, S_LINK);
          if (id >= 0) { const r = idx.rect(id); hitAt = dir > 0 ? Math.max(0.5, r[2] - pr.v1) : Math.max(0.5, pr.v0 - r[3]); break; }
          if (idx.hit(end - pw / 2, end + pw / 2, v - 1, v + 1, CL_PCONN) || !inPoly(end - pw / 2, end + pw / 2, v - 1, v + 1, 0.8)) break;
        }
        if (hitAt > 0) {
          const r = dir > 0 ? [end - pw / 2, end + pw / 2, pr.v1, pr.v1 + hitAt] : [end - pw / 2, end + pw / 2, pr.v0 - hitAt, pr.v0];
          paths.push({ u0: r[0], u1: r[1], v0: r[2], v1: r[3], dir: 1 });
          idx.add(r[0], r[1], r[2], r[3], T.PATH);
          break;
        }
      }
    }
  }
  // 楼东西两侧的空地（点式塔楼之间常见的大块绿地）也作宅间绿地（植被按公园密度种树）
  for (const b of blds) {
    const vA = b.v0 + 1, vB = b.v1 - 1;
    if (vB - vA < 6) continue;
    for (const east of [true, false]) {
      const lim = idx.edgeU(east ? b.u1 + 0.5 : b.u0 - 45, east ? b.u1 + 45 : b.u0 - 0.5, vA, vB, S_GAP, east);
      const ua = east ? b.u1 + 1.6 : (Number.isFinite(lim) ? lim + 1.2 : b.u0 - 40), ub = east ? (Number.isFinite(lim) ? lim - 1.2 : b.u1 + 40) : b.u0 - 1.6;
      if (ub - ua < 8) continue;
      // 只取多边形内部
      if (!inside((ua + ub) / 2, (vA + vB) / 2) || !inside(ua + 1, vA) || !inside(ub - 1, vB)) continue;
      gardens.push({ u0: ua, u1: ub, v0: vA, v1: vB });
    }
  }
  G.stats.paths += paths.length;

  // —— 6. 设施 ——
  const pads = [];
  const padFree = (u0, u1, v0, v1, cl = CL_PAD) => inPoly(u0, u1, v0, v1, 1.5) && !idx.hit(u0, u1, v0, v1, cl) && !roadHit(u0, u1, v0, v1, 0.5, true);
  const addPad = (type, u0, u1, v0, v1, extra = {}) => {
    const p = { type, u0, u1, v0, v1, ...extra };
    idx.add(u0, u1, v0, v1, T.PAD);
    pads.push(p);
    G.stats.pads++;
    return p;
  };
  // 候选中心：每栋主楼南侧宅间绿地（园路两侧）
  const gardenSpots = [];
  for (const b of blds) {
    if (!b.gapS || b.gapS < 13) continue;
    const vA = b.v1 + 2.5, vB = b.v1 + b.gapS - 1.5;
    const pv = b.path ? (b.path.v0 + b.path.v1) / 2 : null;
    for (const f of [0.5, 0.2, 0.8]) {
      const u = b.u0 + (b.u1 - b.u0) * f;
      if (pv !== null) {
        gardenSpots.push({ u, vA, vB: b.path.v0 - 0.6, b, side: 'n' });
        gardenSpots.push({ u, vA: b.path.v1 + 0.6, vB, b, side: 's' });
      } else gardenSpots.push({ u, vA, vB, b, side: 'n' });
    }
  }
  const pick = (type, w, d, maxN, opts = {}) => {
    let n = 0;
    const spots = gardenSpots.slice();
    if (opts.order === 'center') spots.sort((a, b) => Math.hypot(a.u, (a.vA + a.vB) / 2) - Math.hypot(b.u, (b.vA + b.vB) / 2));
    else if (opts.order === 'rand') for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
    for (const s of spots) {
      if (n >= maxN) break;
      if (s.vB - s.vA < d) continue;
      for (const rot of opts.rot === false ? [0] : [0, 1]) {
        const ww = rot ? d : w, dd = rot ? w : d;
        if (s.vB - s.vA < dd) continue;
        const vc = s.side === 's' ? s.vA + dd / 2 : s.vB - dd / 2;
        if (padFree(s.u - ww / 2, s.u + ww / 2, vc - dd / 2, vc + dd / 2)) {
          addPad(type, s.u - ww / 2, s.u + ww / 2, vc - dd / 2, vc + dd / 2, { rot, seed: Math.floor(rnd() * 1e6) });
          n++;
          break;
        }
      }
    }
    return n;
  };
  const nB = blds.length;
  if (kg) {
    pick('play', 16, 11, 2, { order: 'center' });
  } else if (uni) {
    if (!hasCourt && !inst) pick('court', 28, 15, school ? 2 : Math.min(4, 1 + (nB >> 3)), { order: 'rand' });
    pick('fit', 10, 7, inst ? 0 : 1, { order: 'rand' });
    pick('pav', 7, 7, school ? 0 : 2, { order: 'rand' });
  } else {
    pick('fit', 11, 7.5, nB >= 12 ? 2 : 1, { order: 'center' });
    if (!old || nB >= 6) pick('play', 13, 9, old ? 1 : nB >= 10 ? 2 : 1, { order: 'center' });
    pick('pav', old ? 6 : 7, old ? 6 : 7, old ? (nB >= 8 ? 1 : 0) : nB >= 6 ? 2 : 1, { order: 'rand' });
    if (old && nB >= 10 && P.area > 40000 && !hasCourt) pick('court', 28, 15, 1, { order: 'rand' });
  }
  // 车棚 / 垃圾分类亭：贴车行道、靠楼端（车行道远离楼的一侧也可）
  const nearLane = (type, w, d, maxN, gapToLane) => {
    let n = 0;
    const order = blds.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const cl = CLx(CL_PAD, { [T.BLD]: 1.0, [T.LANE]: gapToLane, [T.PAD]: 1.0, [T.PARK]: 0.4 });
    for (const b of order) {
      if (n >= maxN) break;
      // 楼东西两端外侧，贴楼北车行道
      const vRow = b.v0 - AP - LW; // 车行道北边缘
      for (const [u, v] of [[b.u1 + 2 + w / 2, b.v0 + d / 2 + 0.5], [b.u0 - 2 - w / 2, b.v0 + d / 2 + 0.5], [b.u0 + w / 2 + 1, vRow - gapToLane - d / 2], [b.u1 - w / 2 - 1, vRow - gapToLane - d / 2]]) {
        if (padFree(u - w / 2, u + w / 2, v - d / 2, v + d / 2, cl)) {
          addPad(type, u - w / 2, u + w / 2, v - d / 2, v + d / 2, { seed: Math.floor(rnd() * 1e6) });
          n++;
          break;
        }
      }
    }
    return n;
  };
  if (!kg) {
    if (old) nearLane('bike', 12, 3.6, Math.max(1, Math.round(nB * 0.4)), 0.6);
    else if (!uni) nearLane('ebike', 14, 3.8, Math.max(1, Math.round(nB / 5)), 0.6);
    else nearLane('bike', 16, 4, Math.max(1, Math.round(nB / 4)), 0.6);
    nearLane('trash', 4.2, 1.8, Math.max(1, Math.round(nB / (old ? 4 : 6))), 0.4);
  }
  // 地下车库出入口坡道（新小区、主门内侧 12~36 m、贴门内车道一侧；人车分流的小区地面车少、车库口显眼）
  const mg = gates.find((g) => g.main);
  if (mg && mode === 'new' && P.area > 25000 && (medH >= 30 || P.area > 60000)) {
    const pu = -mg.dv, pv = mg.du; // 车道横向
    let done = false;
    for (const off of [18, 24, 30, 14, 36]) {
      for (const sd of [1, -1]) {
        const cu = mg.u + mg.du * off + pu * sd * (LW / 2 + 4.2), cv = mg.v + mg.dv * off + pv * sd * (LW / 2 + 4.2);
        const alongU = Math.abs(mg.du) > 0.5;
        const w = alongU ? 17 : 7.2, d = alongU ? 7.2 : 17;
        if (padFree(cu - w / 2, cu + w / 2, cv - d / 2, cv + d / 2, CLK6)) {
          addPad('ramp', cu - w / 2, cu + w / 2, cv - d / 2, cv + d / 2, { dir: [mg.du, mg.dv] });
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }
  // 快递柜：主门内侧
  const mainGate = gates.find((g) => g.main);
  if (mainGate && !uni) {
    for (const off of [10, 14, 18]) {
      const cu = mainGate.u + mainGate.du * off, cv = mainGate.v + mainGate.dv * off;
      const pu = -mainGate.dv, pv = mainGate.du;
      let placed = false;
      for (const sd of [1, -1]) {
        const u = cu + pu * sd * (LW / 2 + 3), v = cv + pv * sd * (LW / 2 + 3);
        const w = Math.abs(pu) > 0.5 ? 1.0 : 4.2, d = Math.abs(pu) > 0.5 ? 4.2 : 1.0;
        if (padFree(u - w / 2, u + w / 2, v - d / 2, v + d / 2, CLK7)) {
          addPad('locker', u - w / 2, u + w / 2, v - d / 2, v + d / 2, { face: [-pu * sd, -pv * sd] });
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
  }
  // 校园：最大的楼前（南）广场立旗杆
  if (uni && !kg && !inst && (school || hasField || P.area > 80000)) {
    const big = blds.slice().sort((a, b) => (b.u1 - b.u0) * (b.v1 - b.v0) * b.h - (a.u1 - a.u0) * (a.v1 - a.v0) * a.h)[0];
    for (const v of [big.v1 + 14, big.v1 + 10, big.v1 + 18, big.v0 - 14]) {
      const u = (big.u0 + big.u1) / 2;
      if (padFree(u - 9, u + 9, v - 7, v + 7, CLK8)) { addPad('flag', u - 9, u + 9, v - 7, v + 7, { face: v > big.v1 ? -1 : 1 }); break; }
    }
  }

  // —— 7. 路灯（庭院灯）：沿车行道一侧每 ~22 m，园路每 ~18 m（低位草坪灯） ——
  const lamps = [];
  for (const L of lanes) {
    if (L.kind === 'gate') continue;
    const along = L.dir === 0;
    const len = along ? L.u1 - L.u0 : L.v1 - L.v0;
    const n = Math.floor(len / 28);
    for (let k = 0; k <= n; k++) {
      const t = (k + 0.5) * (len / (n + 1));
      const side = k & 1 ? 1 : -1;
      const u = along ? L.u0 + t : (side < 0 ? L.u0 - 0.6 : L.u1 + 0.6);
      const v = along ? (side < 0 ? L.v0 - 0.6 : L.v1 + 0.6) : L.v0 + t;
      if (idx.hit(u - 0.25, u + 0.25, v - 0.25, v + 0.25, CLK4)) continue;
      if (!inPoly(u - 0.2, u + 0.2, v - 0.2, v + 0.2, 0.5)) continue;
      lamps.push([u, v, 0]);
    }
  }
  for (const p of paths) {
    if (p.dir !== 0) continue;
    const len = p.u1 - p.u0;
    const n = Math.floor(len / 26);
    for (let k = 0; k <= n; k++) {
      const u = p.u0 + (k + 0.5) * (len / (n + 1)), v = p.v0 - 0.5;
      if (idx.hit(u - 0.2, u + 0.2, v - 0.2, v + 0.2, CLK5)) continue;
      lamps.push([u, v, k & 1 ? 1 : 0]); // 园路：高杆庭院灯与草坪灯相间
    }
  }

  // 围墙样式：新小区铁艺栏杆（石材/砖砌矮墙基座），老小区砖墙或花格墙，校园铁艺
  const fence = P.k === 'cluster' ? 'none' : uni ? 'iron' : old ? (hash(pid, 3) < 0.6 ? 'brick' : 'lattice') : 'iron';
  return {
    pid, name: P.name, kind: P.k, mode, old, uni, kg, school, area: P.area, era, medH,
    ring, holes: P.k === 'cluster' ? holeRings : P.holes, bb: P.bb, th, cs, sn, ox, oz, U0, U1, V0, V1, rf,
    LW, AP, lanes, parks, osmParks, aprons, paths, pads, gates, lamps, fence,
    bldIds: blds.map((b) => b.b),
    fields, gardens,
  };
}

/** 局部矩形 → 世界四角 [x0,z0,x1,z1,x2,z2,x3,z3]（逆时针） */
export function rectWorld(c, u0, u1, v0, v1, out = []) {
  const { cs, sn, ox, oz } = c;
  const P = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  out.length = 0;
  for (const [u, v] of P) out.push(ox + u * cs - v * sn, oz + u * sn + v * cs);
  return out;
}
export const toWorld = (c, u, v) => [c.ox + u * c.cs - v * c.sn, c.oz + u * c.sn + v * c.cs];

/**
 * 植被排除区：每个小区的车行道（吸收紧贴的车位带/铺装带）、其余车位、园路、设施矩形，按 250 m 分片、分“互不重叠层”，
 * 每片每层拼成一个多环多边形（环之间零宽桥接：串联到下一个环、最后原路返回，奇偶规则下桥接边来回各一次互相抵消）。
 * 植被模块逐点测排除区的开销 ∝ 每 500 m 格里的排除区个数 × 命中件的顶点数，所以按小区合并成少量中等大小的件。
 * 返回 [[x,z,...], ...]
 */
export function exclusionRings(c) {
  const rects = [];
  // 车行道吸收紧贴的车位带与入户铺装带（排除区稍大无妨，矩形数减半，植被逐点测试更快）
  const parks = c.parks.map((p) => ({ r: [p.u0 - 0.5, p.u1 + 0.5, p.v0 - 0.5, p.v1 + 0.5], dir: p.dir, used: false }));
  const aprons = c.aprons.map((p) => ({ r: [p.u0 - 0.2, p.u1 + 0.2, p.v0 - 0.2, p.v1 + 0.2], used: false }));
  const strips = parks.concat(aprons);
  for (const L of c.lanes) {
    const r = [L.u0 - 0.8, L.u1 + 0.8, L.v0 - 0.8, L.v1 + 0.8];
    const along = L.dir === 0;
    // 轴向（沿车行道）区间与横向边界
    const a0 = along ? r[0] : r[2], a1 = along ? r[1] : r[3];
    for (const side of [-1, 1]) {
      let cover = 0, ext = 0;
      const hits = [];
      for (const q of strips) {
        if (q.used || (q.dir !== undefined && q.dir !== L.dir)) continue;
        const qa0 = along ? q.r[0] : q.r[2], qa1 = along ? q.r[1] : q.r[3];
        const qc0 = along ? q.r[2] : q.r[0], qc1 = along ? q.r[3] : q.r[1];
        const edge = side < 0 ? (along ? r[2] : r[0]) : along ? r[3] : r[1];
        const touch = side < 0 ? Math.abs(qc1 - edge) < 1.2 : Math.abs(qc0 - edge) < 1.2;
        if (!touch) continue;
        const ov = Math.min(a1, qa1) - Math.max(a0, qa0);
        if (ov < (qa1 - qa0) * 0.8) continue;
        cover += ov;
        ext = Math.max(ext, qc1 - qc0);
        hits.push(q);
      }
      if (hits.length && cover > (a1 - a0) * 0.35) {
        for (const q of hits) q.used = true;
        if (along) { if (side < 0) r[2] -= ext - 1.0; else r[3] += ext - 1.0; }
        else { if (side < 0) r[0] -= ext - 1.0; else r[1] += ext - 1.0; }
      }
    }
    rects.push(r);
  }
  for (const q of parks) if (!q.used) rects.push(q.r);
  for (const q of aprons) if (!q.used) rects.push(q.r);
  for (const p of c.paths) rects.push([p.u0 - 0.4, p.u1 + 0.4, p.v0 - 0.4, p.v1 + 0.4]);
  for (const p of c.pads) { const m = p.type === 'pav' ? 0.5 : 1.0; rects.push([p.u0 - m, p.u1 + m, p.v0 - m, p.v1 + m]); }
  // 小区内 OSM 道路旁的平行车位
  for (const o of c.osmParks) {
    const L = o.n * PARA_L;
    const cu = o.au + (o.du * L) / 2, cv = o.av + (o.dv * L) / 2;
    const hu = Math.abs(o.du) * L / 2 + Math.abs(o.nu) * 1.6, hv = Math.abs(o.dv) * L / 2 + Math.abs(o.nv) * 1.6;
    rects.push([cu - hu, cu + hu, cv - hv, cv + hv]);
  }
  if (!rects.length) return [];
  // 按 250 m 分片、分“互不重叠层”，每片每层一个多环多边形
  const tiles = new Map();
  for (const r of rects) {
    const [x, z] = toWorld(c, (r[0] + r[1]) / 2, (r[2] + r[3]) / 2);
    const k = Math.floor(x / 250) * 100003 + Math.floor(z / 250);
    let a = tiles.get(k);
    if (!a) tiles.set(k, (a = []));
    a.push(r);
  }
  const out = [];
  for (const arr of tiles.values()) {
    arr.sort((p, q) => (q[1] - q[0]) * (q[3] - q[2]) - (p[1] - p[0]) * (p[3] - p[2]));
    const layers = [];
    for (const r of arr) {
      let L = layers.find((ly) => !ly.some((q) => q[0] < r[1] && q[1] > r[0] && q[2] < r[3] && q[3] > r[2]));
      if (!L) layers.push((L = []));
      L.push(r);
    }
    for (const L of layers) {
      L.sort((p, q) => p[2] - q[2] || p[0] - q[0]);
      const pts = [];
      const starts = [];
      for (const r of L) {
        const q = rectWorld(c, r[0], r[1], r[2], r[3]);
        starts.push([q[0], q[1]]);
        pts.push(q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], q[0], q[1]);
      }
      for (let i = starts.length - 2; i >= 0; i--) pts.push(starts[i][0], starts[i][1]);
      out.push(pts);
    }
  }
  return out;
}

/** 小区按 500 m 块索引（外接框覆盖的块） */
export function chunkIndex(list) {
  const m = new Map();
  for (const c of list) {
    const [x0, z0, x1, z1] = c.bb;
    for (let i = Math.floor(x0 / CHUNK); i <= Math.floor(x1 / CHUNK); i++)
      for (let j = Math.floor(z0 / CHUNK); j <= Math.floor(z1 / CHUNK); j++) {
        const k = i + ',' + j;
        let a = m.get(k);
        if (!a) m.set(k, (a = []));
        a.push(c.id);
      }
  }
  return m;
}
