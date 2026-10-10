// 公园近景：全园规划（大门 / 公厕 / 亭廊 / 廊架 / 导览牌位置，建模块时一次算好）+ 分块生成（生成器，可分帧）。
//
// 分块生成顺序：掩膜 → 水岸 → 园路铺装与路缘石（OSM 园路）/ 路缘石（roads.json 园内步道）/ 园桥 → 大门、公厕、亭廊、廊架
// → 入口导览牌与花境 → 沿路庭院灯、座椅（背向草地、面向园路，每 25~40 m）、分类垃圾桶、健身步道标识、绿篱/花境 → 湖滨步道的
// 灯与座椅（面向水面）→ 孤植树下的树池环凳 → “爱护花草”小牌。每放一件在掩膜里登记占用，后放的避让。
import * as THREE from 'three';
import { M_PARK, M_GRASS, M_WATER, M_BLD, M_ROAD, M_EXCL, M_SOFT, M_OCC, CELL, hash2, pip, segDist, polyline, SOFT_EXCL, greenGrid, lowAt, greenAt, SITE_SOFT, SITE_HARD, SITE_PAVED } from './park-index.js';
import { MeshBuf, lin, strip, resamplePts } from './park-geom.js';
import { InstanceList } from './park-props.js';
import { L, SIGN_BANDS } from './park-tex.js';
import { buildShore } from './park-shore.js';
import { roadY, chainage } from '../core/roadheight.js';

const PI = Math.PI;
const C = {
  pave: lin('#ffffff', 0.92), paveB: lin('#ffffff', 0.9), curb: lin('#ffffff', 0.97), steps: lin('#ffffff', 0.8), deck: lin('#ffffff', 0.98),
  metal: lin('#ffffff'), board: lin('#ffffff'), white: lin('#ffffff'), blue: lin('#4f86c6'), wall: lin('#ffffff', 0.95), plinth: lin('#c8c1b2'),
  door: lin('#4a3324'), window: lin('#2c3236'), roof: lin('#ffffff', 0.95), ridge: lin('#55595d'), wood: lin('#ffffff', 0.95), concrete: lin('#ffffff', 0.92),
};
// 十月：西安各公园菊展（黄/橙/白/紫/红）、月季（红/粉）、一串红 + 万寿菊
// 花色（十月：万寿菊、一串红、矮牵牛、鼠尾草……）略降饱和；花境里约四成花丛只有绿叶（GREEN_HEAD，花头染成叶色），
// 以绿色为底、花色点缀——此前整片高饱和红黄紫小块密铺，像彩色碎屑（审查 g3 城西小区）
const FLOWERS = [
  ['#d2a63a', '#d79a3a', '#c8783a', '#e6e0d0', '#8f6aa8', '#b44a3e', '#dcc372'],
  ['#a83a48', '#cf7890', '#bb5a70', '#e0aabb'],
  ['#c23a2e', '#c23a2e', '#d89a3a', '#d89a3a'],
];
const GREEN_HEAD = '#2f4a22';
const HEX = (h) => { const n = parseInt(h.slice(1), 16); const f = (v) => Math.pow(v / 255, 2.2); return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]; };
const FLOWER_LIN = FLOWERS.map((a) => a.map(HEX));
const GREEN_LIN = HEX(GREEN_HEAD);
const HEDGE = [HEX('#3c6a2c'), HEX('#7e2a22'), HEX('#4d7a34')]; // 大叶黄杨 / 红叶石楠（秋季红叶）/ 金森女贞

// ───────────── 树木索引（读植被模块的种植结果，只读）─────────────
export class TreeIndex {
  constructor(r) {
    this.r = r;
    this.R = r.region; this.C = r.chunk; this.ncx = r.ncx; this.ncz = r.ncz;
  }
  each(x0, z0, x1, z1, fn) {
    const { R, C: c, r } = this;
    const cx0 = Math.max(0, Math.floor((x0 - R.x0) / c)), cx1 = Math.min(this.ncx - 1, Math.floor((x1 - R.x0) / c));
    const cz0 = Math.max(0, Math.floor((z0 - R.z0) / c)), cz1 = Math.min(this.ncz - 1, Math.floor((z1 - R.z0) / c));
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cz * this.ncx + cx;
        for (let i = r.chunkStart[k]; i < r.chunkStart[k + 1]; i++) {
          const x = r.x[i], z = r.z[i];
          if (x < x0 || x > x1 || z < z0 || z > z1) continue;
          if (fn(i, x, z) === false) return;
        }
      }
  }
  near(x, z, rad) {
    if (this.loc && x >= this.loc.x0 && x < this.loc.x1 && z >= this.loc.z0 && z < this.loc.z1) return this._nearLoc(x, z, rad);
    let hit = false;
    this.each(x - rad, z - rad, x + rad, z + rad, (i, tx, tz) => {
      if ((tx - x) ** 2 + (tz - z) ** 2 < rad * rad) { hit = true; return false; }
    });
    return hit;
  }
  /** 块内 4 m 网格（分块生成时先建好，near 查询 O(1)） */
  local(x0, z0, x1, z1) {
    const G = 4, nx = Math.ceil((x1 - x0) / G) + 4, nz = Math.ceil((z1 - z0) / G) + 4;
    const head = new Int32Array(nx * nz).fill(-1), next = [], xs = [], zs = [];
    this.each(x0 - 8, z0 - 8, x1 + 8, z1 + 8, (i, x, z) => {
      const c = Math.floor((x - x0) / G) + 2, r = Math.floor((z - z0) / G) + 2;
      if (c < 0 || r < 0 || c >= nx || r >= nz) return;
      const k = r * nx + c;
      next.push(head[k]); xs.push(x); zs.push(z);
      head[k] = xs.length - 1;
    });
    this.loc = { x0, z0, x1, z1, G, nx, nz, head, next, xs, zs };
  }
  _nearLoc(x, z, rad) {
    const L = this.loc, G = L.G;
    const c0 = Math.floor((x - rad - L.x0) / G) + 2, c1 = Math.floor((x + rad - L.x0) / G) + 2;
    const r0 = Math.floor((z - rad - L.z0) / G) + 2, r1 = Math.floor((z + rad - L.z0) / G) + 2;
    const r2 = rad * rad;
    for (let r = Math.max(0, r0); r <= Math.min(L.nz - 1, r1); r++)
      for (let c = Math.max(0, c0); c <= Math.min(L.nx - 1, c1); c++)
        for (let i = L.head[r * L.nx + c]; i >= 0; i = L.next[i]) if ((L.xs[i] - x) ** 2 + (L.zs[i] - z) ** 2 < r2) return true;
    return false;
  }
}

// ───────────── 全园规划 ─────────────
export function planParks(env, parksData) {
  const { idx, trees, T } = env;
  const t0 = performance.now();
  const plan = new Map(); // 块键 → {gates, toilets, pavs, boards, juncs}
  const add = (type, it) => {
    const k = Math.floor(it.x / CELL) + ',' + Math.floor(it.z / CELL);
    let e = plan.get(k);
    if (!e) plan.set(k, (e = { struct: [], toilet: [], pergola: [], board: [], junc: [], entr: [] }));
    e[type].push(it);
  };
  const lineOf = new Map(); // 公园 → 线
  for (const Lx of idx.lines) {
    const p = Lx.p, m = (p.length / 2) >> 1;
    const pk = idx.parkAt(p[m * 2], p[m * 2 + 1]) || idx.parkAt(p[0], p[1]);
    if (!pk) continue;
    Lx.park = pk;
    if (!lineOf.has(pk)) lineOf.set(pk, []);
    lineOf.get(pk).push(Lx);
  }
  // —— 路口（端点与他线相接，度 ≥ 3）与入口（端点外侧 6 m 已出公园）——
  const endpoints = [];
  for (const Lx of idx.lines) {
    if (!Lx.park) continue;
    const p = Lx.p, n = p.length / 2;
    for (const end of [0, n - 1]) {
      const x = p[end * 2], z = p[end * 2 + 1];
      const nb = end === 0 ? 1 : n - 2;
      const dx = p[nb * 2] - x, dz = p[nb * 2 + 1] - z, dl = Math.hypot(dx, dz) || 1;
      endpoints.push({ x, z, ix: dx / dl, iz: dz / dl, L: Lx });
    }
  }
  const touches = (e) => {
    let d = 1;
    for (const M of idx.lineGrid.query(e.x - 3, e.z - 3, e.x + 3, e.z + 3)) {
      if (M === e.L) continue;
      const p = M.p;
      for (let i = 0; i + 3 < p.length; i += 2) if (segDist(e.x, e.z, p[i], p[i + 1], p[i + 2], p[i + 3]) < 2.2) { d++; break; }
    }
    return d;
  };
  const entrances = new Map();
  const seenJ = [];
  for (const e of endpoints) {
    const pk = e.L.park;
    const deg = touches(e);
    const out = idx.parkAt(e.x - e.ix * 6, e.z - e.iz * 6) !== pk && idx.parkAt(e.x - e.ix * 10, e.z - e.iz * 10) !== pk;
    if (out && deg <= 2) {
      if (!entrances.has(pk)) entrances.set(pk, []);
      entrances.get(pk).push({ ...e, park: pk, w: e.L.w });
    } else if (deg >= 3 && !seenJ.some((j) => Math.abs(j.x - e.x) < 4 && Math.abs(j.z - e.z) < 4)) {
      const j = { x: e.x, z: e.z, deg, park: pk };
      seenJ.push(j);
      add('junc', j);
    }
  }
  // OSM 入口节点（entrance / gate）也算入口
  for (const q of parksData?.pts || []) {
    if (q.t !== 'gate') continue;
    const pk = idx.parkAt(q.x, q.z) || idx.parks.find((p) => p.n === q.pk && Math.abs(p.bb.x0 - q.x) < 3000);
    if (!pk) continue;
    const cx = (pk.bb.x0 + pk.bb.x1) / 2, cz = (pk.bb.z0 + pk.bb.z1) / 2, dl = Math.hypot(cx - q.x, cz - q.z) || 1;
    if (!entrances.has(pk)) entrances.set(pk, []);
    entrances.get(pk).push({ x: q.x, z: q.z, ix: (cx - q.x) / dl, iz: (cz - q.z) / dl, park: pk, w: 4, osm: true });
  }
  const clear = (x, z, r, { water = 3, road = 2, tree = 3 } = {}) => {
    if (idx.exclAt(x, z)) return false;
    if (idx.buildingAt(x, z, r)) return false;
    if (idx.waterAt(x, z) || (water > 0 && idx.shoreDist(x, z, r + water) < r + water)) return false;
    if (road > -5 && idx.roadEdgeDist(x, z, r + road + 1) < r + road) return false;
    if (trees && tree > 0 && trees.near(x, z, tree)) return false;
    return true;
  };
  const stats = { gates: 0, toilets: 0, osmToilets: 0, pavs: 0, langs: 0, pergolas: 0, boards: 0, entrances: 0, juncs: seenJ.length };
  const structs = [];
  const usedT = new Set();
  const farFrom = (x, z, d) => structs.every((s) => (s.x - x) ** 2 + (s.z - z) ** 2 > d * d);
  for (const pk of idx.parks) {
    if (pk.area < 12000) continue;
    const soft = SOFT_EXCL.has(pk.n);
    const ents = (entrances.get(pk) || []).sort((a, b) => hash2(Math.round(a.x), Math.round(a.z), 3) - hash2(Math.round(b.x), Math.round(b.z), 3));
    stats.entrances += ents.length;
    // 导览牌：每个入口一块（大园最多 4 块），立在入口内侧路右手
    let nb = 0;
    for (const e of ents) {
      if (nb >= (pk.area > 100000 ? 4 : 2)) break;
      const rx = -e.iz, rz = e.ix;
      const x = e.x + e.ix * 4 + rx * (e.w / 2 + 1.3), z = e.z + e.iz * 4 + rz * (e.w / 2 + 1.3);
      if (idx.parkAt(x, z) !== pk || idx.exclAt(x, z) & M_EXCL || idx.buildingAt(x, z, 1)) continue;
      add('board', { x, z, yaw: Math.atan2(-e.ix, -e.iz) + 0.35, park: pk });
      add('entr', { x: e.x, z: e.z, ix: e.ix, iz: e.iz, w: e.w, park: pk });
      nb++; stats.boards++;
    }
    // 大路口（四岔及以上）导览牌：每园至多 2 块
    let nj = 0;
    for (const j of seenJ) {
      if (nj >= 2 || j.park !== pk || j.deg < 4 || pk.area < 30000) continue;
      const a = hash2(Math.round(j.x), Math.round(j.z), 31) * PI * 2;
      const x = j.x + Math.cos(a) * 4.2, z = j.z + Math.sin(a) * 4.2;
      if (idx.parkAt(x, z) !== pk || idx.exclAt(x, z) & M_EXCL || idx.buildingAt(x, z, 1) || idx.roadEdgeDist(x, z, 2) < 0.8) continue;
      add('board', { x, z, yaw: Math.atan2(j.x - x, j.z - z), park: pk });
      nj++; stats.boards++;
    }
    if (soft) continue; // 曲江园内：大门、公厕、亭廊由曲江模块负责
    // —— 大门：有名大园，选临主干路的入口 ——
    if (pk.n && pk.area >= 50000 && /公园|花园|游园|园$/.test(pk.n) && !/湿地|保护区|森林|遗址|生态|博物|寺|电影|大学|学院|医院|陵|墓|动物|植物|环城|林带/.test(pk.n)) {
      let best = null, bs = -1;
      for (const e of ents) {
        const ox = e.x - e.ix * 14, oz = e.z - e.iz * 14;
        let sc = e.osm ? 2 : 0;
        for (const r of idx.roadGrid.query(ox - 30, oz - 30, ox + 30, oz + 30)) {
          if (r.own || r.c > 7 || r.bridge) continue;
          for (let i = 0; i + 3 < r.p.length; i += 2) if (segDist(ox, oz, r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3]) < 30) { sc = Math.max(sc, 10 - r.c + (e.w >= 4 ? 1 : 0)); break; }
        }
        if (sc > bs) { bs = sc; best = e; }
      }
      if (best && bs >= 4) {
        const x = best.x + best.ix * 3, z = best.z + best.iz * 3;
        if (!idx.exclAt(x, z) && !idx.buildingAt(x, z, 6.5) && !idx.waterAt(x, z)) {
          const s = { tpl: 'gate', x, z, yaw: Math.atan2(-best.ix, -best.iz), name: pk.n, r: 7 };
          structs.push(s); add('struct', s); stats.gates++;
        }
      }
    }
    // —— 公厕：OSM 节点（无建筑轮廓的）优先；大园没有就在入口内侧补一座 ——
    const osmT = (parksData?.pts || []).filter((q) => q.t === 'toilet' && !usedT.has(q) && idx.parkAt(q.x, q.z) === pk);
    for (const q of osmT) usedT.add(q);
    let haveT = osmT.some((q) => q.bld);
    for (const q of osmT) {
      if (q.bld) continue;
      if (!clear(q.x, q.z, 3.6, { water: 1, road: 0.5, tree: 0 })) continue;
      add('toilet', { x: q.x, z: q.z, yaw: faceLine(idx, q.x, q.z), park: pk });
      haveT = true; stats.toilets++; stats.osmToilets++;
    }
    if (!haveT && pk.area >= 80000) {
      let done = false;
      for (const e of ents) {
        if (done) break;
        for (const side of [1, -1]) {
          const rx = -e.iz * side, rz = e.ix * side;
          const x = e.x + e.ix * 16 + rx * (e.w / 2 + 7), z = e.z + e.iz * 16 + rz * (e.w / 2 + 7);
          if (idx.parkAt(x, z) !== pk || !clear(x, z, 4, { water: 3, road: 1.5, tree: 3 })) continue;
          add('toilet', { x, z, yaw: Math.atan2(-rx, -rz), park: pk });
          done = true; stats.toilets++;
          break;
        }
      }
    }
    // —— 亭、游廊：湖边优先，其次路口；OSM shelter 点 ——
    const quota = Math.max(1, Math.min(5, Math.round(pk.area / 45000)));
    const cands = [];
    for (const q of parksData?.pts || []) if (q.t === 'shelter' && !q.bld && idx.parkAt(q.x, q.z) === pk) cands.push({ x: q.x, z: q.z, pri: 0, kind: 'pav6' });
    for (const w of idx.waterGrid.query(pk.bb.x0, pk.bb.z0, pk.bb.x1, pk.bb.z1)) {
      if (!w.lvKind || w.lvKind === 'river' || w.area < 600) continue;
      const o = w.outer, n = o.length / 2;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ax = o[i * 2], az = o[i * 2 + 1], bx = o[j * 2], bz = o[j * 2 + 1];
        const Lk = Math.hypot(bx - ax, bz - az);
        acc += Lk;
        if (acc < 38 || Lk < 6) continue;
        acc = 0;
        let nx = -(bz - az) / Lk, nz = (bx - ax) / Lk;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (idx.waterAt(mx + nx * 2, mz + nz * 2) === w) { nx = -nx; nz = -nz; }
        const x = mx + nx * 8.5, z = mz + nz * 8.5;
        if (idx.parkAt(x, z) !== pk) continue;
        cands.push({ x, z, pri: 1, kind: hash2(Math.round(x), Math.round(z), 5) < 0.3 && Lk > 14 ? 'lang' : 'pav6', yaw: Math.atan2(-nx, -nz), tx: (bx - ax) / Lk, tz: (bz - az) / Lk });
      }
    }
    for (const j of seenJ) if (j.park === pk) {
      for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) cands.push({ x: j.x + dx * 6.5, z: j.z + dz * 6.5, pri: 2, kind: hash2(Math.round(j.x), Math.round(j.z), 9) < 0.5 ? 'pav4' : 'pav6', yaw: Math.atan2(-dx, -dz) });
    }
    cands.sort((a, b) => a.pri - b.pri || hash2(Math.round(a.x), Math.round(a.z), 7) - hash2(Math.round(b.x), Math.round(b.z), 7));
    let got = 0, gotLang = 0;
    for (const c of cands) {
      if (got >= quota) break;
      if (c.kind === 'lang' && gotLang >= 1) c.kind = 'pav6';
      const r = c.kind === 'lang' ? 7.2 : 3.6;
      if (!farFrom(c.x, c.z, 55)) continue;
      if (idx.parkAt(c.x, c.z) !== pk) continue;
      if (c.kind === 'lang') {
        // 游廊沿岸线方向：两端也要净空
        const ok = [-5, 0, 5].every((u) => clear(c.x + c.tx * u, c.z + c.tz * u, 2.6, { water: 1.5, road: 1, tree: 2.5 }));
        if (!ok) continue;
      } else if (!clear(c.x, c.z, r, { water: 1.5, road: 1.2, tree: 3.2 })) continue;
      // 游廊：局部 X（廊长方向）沿岸线；亭：正面朝水面/路口
      const yaw = c.kind === 'lang' ? Math.atan2(-c.tz, c.tx) : c.yaw ?? faceLine(idx, c.x, c.z);
      const s = { tpl: c.kind, x: c.x, z: c.z, yaw, r, park: pk };
      structs.push(s); add('struct', s);
      got++; if (c.kind === 'lang') { gotLang++; stats.langs++; } else stats.pavs++;
    }
    // —— 廊架（木花架）：较大的园一座，放在路口旁 ——
    if (pk.area >= 40000) {
      for (const j of seenJ) {
        if (j.park !== pk) continue;
        const dir = hash2(Math.round(j.x), Math.round(j.z), 13) * PI * 2;
        const x = j.x + Math.cos(dir) * 8, z = j.z + Math.sin(dir) * 8;
        if (!farFrom(x, z, 40) || idx.parkAt(x, z) !== pk || !clear(x, z, 5, { water: 1, road: 1, tree: 3 })) continue;
        const s = { tpl: 'pergola', x, z, yaw: faceLine(idx, x, z), r: 5, park: pk };
        structs.push(s); add('pergola', s); stats.pergolas++;
        break;
      }
    }
  }
  stats.ms = Math.round(performance.now() - t0);
  void T;
  return { plan, stats };
}

/** 朝向最近园路的偏航角（正面 +Z 指向路） */
function faceLine(idx, x, z) {
  let best = 1e9, bx = x, bz = z + 1;
  for (const Lx of idx.lineGrid.query(x - 40, z - 40, x + 40, z + 40)) {
    const p = Lx.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, l2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t, qz = az + dz * t, d = (qx - x) ** 2 + (qz - z) ** 2;
      if (d < best) { best = d; bx = qx; bz = qz; }
    }
  }
  return Math.atan2(bx - x, bz - z);
}

// ───────────── 分块生成 ─────────────
export function* buildChunk(env, gx, gz) {
  const { T, idx } = env;
  const t0 = performance.now();
  const tm = [];
  let tl = performance.now();
  const lap = () => { const n = performance.now(); tm.push(Math.round(n - tl)); tl = n; };
  const mk = idx.mask(gx, gz);
  if (env.trees) env.trees.local(mk.x0, mk.z0, mk.x1, mk.z1);
  lap();
  const green = greenGrid(env.ctx, gx, gz, idx);
  lap();
  yield;
  const buf = new MeshBuf();
  const inst = new InstanceList();
  const lamps = [];
  const structs = [];
  const st = { shore: 0, path: 0, lamps: 0, benches: 0, bins: 0, flowers: 0, hedges: 0, rings: 0, signs: 0 };
  const E = { ...env, buf, inst, mk, lamps, structs, st, green };
  E.sign = (band, x, y, z, yaw) => smallSign(E, SIGN_BANDS[band], x, y, z, yaw);
  E.moatJoint = (self, x, z) => {
    for (const m of idx.waterGrid.query(x - 4, z - 4, x + 4, z + 4)) {
      if (m === self || m.lvKind !== 'moat') continue;
      const o = m.outer;
      for (let i = 0, n = o.length / 2, j = n - 1; i < n; j = i++) if (segDist(x, z, o[j * 2], o[j * 2 + 1], o[i * 2], o[i * 2 + 1]) < 3) return true;
    }
    return false;
  };
  const out = { walks: [], paved: [] };
  // —— 1. 水岸 ——
  st.shoreT = [];
  for (const w of idx.waterGrid.at(gx, gz)) {
    if (!w.lvKind) continue;
    const t1 = performance.now();
    buildShore(E, w, out);
    st.shore++;
    const dt = performance.now() - t1;
    if (dt > 8) st.shoreT.push((w.n || w.k) + Math.round(dt));
  }
  lap();
  yield;
  // —— 2. 园路 ——
  const lines = idx.lineGrid.at(gx, gz);
  for (const Lx of lines) pathGeometry(E, Lx);
  for (const q of idx.pierGrid.at(gx, gz)) if (q.cx >= mk.x0 && q.cx < mk.x1 && q.cz >= mk.z0 && q.cz < mk.z1) pierGeometry(E, q);
  lap();
  yield;
  // —— 3. 规划好的构筑物 ——
  const P = env.plan.get(gx + ',' + gz);
  if (P) {
    for (const s of P.struct) {
      const y = T.heightAt(s.x, s.z);
      const BAD = M_BLD | M_WATER | M_EXCL | M_SOFT;
      if (mk.any(s.x, s.z, Math.min(s.r, 4.5), BAD)) continue;
      structs.push({ tpl: s.tpl, x: s.x, y: y - 0.05, z: s.z, yaw: s.yaw });
      mk.occupy(s.x, s.z, s.r + 0.6);
      if (s.tpl === 'gate') { gatePlate(E, s, y); gateLights(E, s, y); }
    }
    for (const s of P.toilet) {
      if (mk.any(s.x, s.z, 3.4, M_BLD | M_WATER | M_EXCL | M_OCC | M_SOFT)) continue;
      toilet(E, s.x, T.heightAt(s.x, s.z), s.z, s.yaw);
      mk.occupy(s.x, s.z, 4.6);
    }
    for (const s of P.pergola) {
      if (mk.any(s.x, s.z, 4, M_BLD | M_WATER | M_EXCL | M_OCC | M_ROAD | M_SOFT)) continue;
      pergola(E, s.x, T.heightAt(s.x, s.z), s.z, s.yaw);
      mk.occupy(s.x, s.z, 5.5);
    }
    for (const b of P.board) {
      if (mk.any(b.x, b.z, 0.9, M_BLD | M_WATER | M_EXCL | M_OCC | M_ROAD)) continue;
      signBoard(E, b.x, T.heightAt(b.x, b.z), b.z, b.yaw, b.park);
      mk.occupy(b.x, b.z, 1.4);
      st.signs++;
    }
    for (const e of P.entr) {
      // 入口两侧花境
      for (const side of [1, -1]) {
        const rx = -e.iz * side, rz = e.ix * side;
        const ax = e.x + e.ix * 7 + rx * (e.w / 2 + 1.0), az = e.z + e.iz * 7 + rz * (e.w / 2 + 1.0);
        flowerBed(E, ax, az, e.ix, e.iz, 4, 1.0, hash2(Math.round(ax), Math.round(az), 3));
      }
    }
    for (const j of P.junc) {
      const h = hash2(Math.round(j.x), Math.round(j.z), 17);
      if (h < 0.55) placeBin(E, j.x + 2.2 * Math.cos(h * 40), j.z + 2.2 * Math.sin(h * 40), h * 40);
      if (h > 0.8) {
        // 路口花坛（圆形，一圈菊花）
        const a = h * 77;
        const cx = j.x + Math.cos(a) * 4.5, cz = j.z + Math.sin(a) * 4.5;
        roundBed(E, cx, cz, 1.6, h);
      }
    }
  }
  yield;
  // —— 4. 沿路小品 ——
  lap();
  for (const Lx of lines) alongLine(E, Lx);
  lap();
  yield;
  // —— 5. 湖滨步道小品 ——
  for (const wk of out.walks) alongWalk(E, wk);
  // —— 6. 树池环凳 + 铺装广场上的灯与座椅 ——
  if (env.trees) treeRings(E);
  plazaPass(E);
  lap();
  const geo = buf.empty ? null : buf.geometry();
  lap();
  st.ms = Math.round(performance.now() - t0);
  st.tm = tm.join('/') + (st.shoreT.length ? ' 岸:' + st.shoreT.join(',') : '');
  return { geo, inst: inst.freeze(), lamps, structs, mk, st, paved: out.paved, green };
}

// ───────────── 园桥判定 ─────────────
const POOL_RE = /喷泉|泳|水景|水池/;
/**
 * 园路上哪些点是“跨水的园桥”。只认真正横跨水面的段：
 *  · 水体是 water 模块按岸高重定过水位的湖/池/河/护城河（lvKind 有值）——喷泉池、广场水景（basin）、泳池不算；
 *  · 不在精建场地里（site[i] ≥ SITE_HARD：地标模块自建水池与桥，如大雁塔北广场音乐喷泉）；曲江三园（SITE_SOFT）只认 OSM 标的桥；
 *  · 一段连续的水上点两头都要回到岸上（园路尽头伸进水里的是栈道/码头，不是桥）；
 *  · 横穿而不是贴岸走：水上段离岸最远 ≥ 1.2 m，且水上段长度 ≤ 6 × 离岸最远 + 6 m
 *    （园路数据与水面多边形错位时，沿池边走的园路会有一长串点“落水”，但离岸始终只有 1 m 左右）。
 * OSM 标了 bridge 的园路：放宽到离岸 ≥ 0.5 m、不看长度比例（仍要两头上岸、不在精建场地里）。
 * 返回 {wet: Uint8Array（1 = 桥上水面点，pts[i].wy 为水面高度）, any}。
 */
export function bridgeSpans(idx, pts, Lx, site) {
  const n = pts.length;
  const wet = new Uint8Array(n);
  const cand = new Uint8Array(n);
  const wy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (site && (site[i] >= SITE_HARD || (site[i] === SITE_SOFT && !Lx.b))) continue;
    const w = idx.waterAt(pts[i].x, pts[i].z);
    if (!w || !Number.isFinite(w.planeY)) continue;
    // OSM 标了 bridge 的也可以跨没重定水位的水体（水库、远郊河），但喷泉池/广场水景/泳池一律不算
    if (w.lvKind || (Lx.b && w.k !== 'basin' && !POOL_RE.test(w.n || ''))) { cand[i] = 1; wy[i] = w.planeY; }
  }
  let any = false;
  for (let a = 0; a < n; a++) {
    if (!cand[a]) continue;
    let b = a;
    while (b + 1 < n && cand[b + 1]) b++;
    const ok0 = a > 0 && b < n - 1 && !(site && (site[a - 1] >= SITE_HARD || site[b + 1] >= SITE_HARD));
    if (ok0) {
      let far = 0, len = 0;
      for (let i = a; i <= b; i++) far = Math.max(far, idx.shoreDist(pts[i].x, pts[i].z, 30));
      for (let i = a; i <= b + 1; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      const ok = Lx.b ? far >= 0.5 : far >= 1.2 && len <= 6 * far + 6;
      if (ok) {
        for (let i = a; i <= b; i++) { wet[i] = 1; pts[i].wy = wy[i]; }
        any = true;
      }
    }
    a = b;
  }
  return { wet, any };
}

// ───────────── 园路 ─────────────
function pathGeometry(E, Lx) {
  const { T, mk, buf, idx } = E;
  const pts = resamplePts(Lx.p, 2.5);
  if (pts.length < 2) return;
  const n = pts.length;
  const own = Lx.own;
  const hw = Lx.w / 2;
  // 精建场地等级（见 ParkIndex.siteAt）：SITE_PAVED 里的段不画（场地铺装由地标模块自建，roads.json 园路也不补路缘石）
  const site = new Uint8Array(n);
  let nPaved = 0;
  for (let i = 0; i < n; i++) if ((site[i] = idx.siteAt(pts[i].x, pts[i].z)) === SITE_PAVED) nPaved++;
  if (nPaved === n) return;
  // 每个点：是否是跨水园桥上的点
  const { wet, any: anyWet } = bridgeSpans(idx, pts, Lx, site);
  // OSM 标了 bridge 却没跨任何水面（小沟、干涸河道、数据里没有的水渠）：整条按桥面画（精建地标场地外）
  const dryBridge = !!Lx.b && !anyWet;
  // 路面高度
  let ys;
  if (own) {
    ys = pts.map((p) => T.heightAt(p.x, p.z) + 0.07);
    if (anyWet) {
      for (let i = 0; i < n; i++) if (wet[i]) ys[i] = Math.max(ys[i], pts[i].wy + 0.85);
      // 引坡：坡度 ≤ 8%
      for (let k = 0; k < 2; k++) {
        for (let i = 1; i < n; i++) ys[i] = Math.max(ys[i], ys[i - 1] - 0.2);
        for (let i = n - 2; i >= 0; i--) ys[i] = Math.max(ys[i], ys[i + 1] - 0.2);
      }
    }
  } else {
    const f = Lx.road;
    const ch = chainage(f.p);
    const tot = ch[ch.length - 1];
    // 重采样点的里程：累加
    let s = 0;
    ys = pts.map((p, i) => {
      if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const y = roadY(T, f, p.x, p.z, Math.min(s, tot), tot);
      return y == null ? T.heightAt(p.x, p.z) + 0.25 : y;
    });
  }
  // 桥面点：跨水点 + 引坡（路面高出地面 0.15 m 以上）；OSM 旱桥整条
  const isBr = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (site[i] >= SITE_HARD) continue;
    if (dryBridge || wet[i]) isBr[i] = 1;
    else if (own && anyWet && ys[i] > T.heightAt(pts[i].x, pts[i].z) + 0.15) isBr[i] = 1;
  }
  // 本块负责的连续段（段中点在块内）；桥面段与普通园路段分开出（交界点共用）
  let run = [], runBr = 0;
  const flush = () => {
    if (run.length >= 2) emitPath(E, Lx, run, ys, runBr, wet);
    run = [];
  };
  for (let i = 0; i + 1 < n; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, mz = (pts[i].z + pts[i + 1].z) / 2;
    const inC = mx >= mk.x0 && mx < mk.x1 && mz >= mk.z0 && mz < mk.z1;
    if (!inC || site[i] === SITE_PAVED || site[i + 1] === SITE_PAVED) { flush(); continue; }
    const br = (isBr[i] && isBr[i + 1]) || wet[i] || wet[i + 1] ? 1 : 0;
    if (run.length && br !== runBr) flush();
    if (!run.length) { run.push(i); runBr = br; }
    run.push(i + 1);
  }
  flush();
  function emitPath(E, Lx, ids, ys, bridge, wet) {
    const P = ids.map((i) => ({ x: pts[i].x, z: pts[i].z, i }));
    const Y = (i) => ys[i];
    const yAt = (x, z, side, k) => Y(P[k].i);
    if (own) {
      if (!bridge) {
        strip(buf, P, hw, hw, yAt, { mat: Lx.kind === 'path' || Lx.kind === 'cycleway' || Lx.kind === 'track' ? L.BRICK : L.GRANITE, col: Lx.steps ? C.steps : C.pave });
        // 路缘石：两侧 0.12 m 宽，高出路面 0.05 m，外侧下垂到地面以下；在别的园路路面上断开（路口不横穿）
        curbs(P, (x, z, s2, k) => Y(P[k].i) + 0.05, 0.15);
        E.st.path++;
      } else {
        // 园桥：桥面（花岗岩）+ 两侧 0.35 m 厚桥身 + 汉白玉栏杆（水面上的段）
        strip(buf, P, hw + 0.15, hw + 0.15, yAt, { mat: L.GRANITE, col: C.deck, sideDown: (x, z, y) => y - 0.42 });
        for (const sg of [1, -1]) {
          let prev = null;
          for (let k = 0; k < P.length; k++) {
            const i = P[k].i;
            const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
            const dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1;
            const nx = -dz / dl * sg, nz = dx / dl * sg;
            const x = P[k].x + nx * (hw + 0.05), z = P[k].z + nz * (hw + 0.05), y = Y(i);
            const near = wet[i] || wet[Math.max(0, i - 1)] || wet[Math.min(pts.length - 1, i + 1)];
            if (!near) { prev = null; continue; }
            E.inst.add('bpost', x, y, z);
            if (prev) {
              const ddx = x - prev.x, ddz = z - prev.z, l = Math.hypot(ddx, ddz);
              if (l > 0.3 && l < 4) E.inst.add('bpanel', prev.x + (ddx / l) * 0.1, Math.min(y, prev.y), prev.z + (ddz / l) * 0.1, Math.atan2(-ddz, ddx), l - 0.2);
            }
            prev = { x, y, z };
          }
        }
        E.st.path++;
      }
    } else if (!bridge) {
      // roads.json 园内步道：路面由 roads 模块画，这里只补两侧路缘石
      curbs(P, (x, z, s2, k) => Y(P[k].i) + 0.04, 0.12);
    }
  }
  function curbs(P, yTop, down) {
    const H = segHash(E);
    const onOther = (x, z) => {
      const l = H.m.get(Math.floor(x / 8) * 100003 + Math.floor(z / 8));
      if (!l) return false;
      for (let q = 0; q < l.length; q++) {
        const sgm = l[q];
        if (sgm[0] === Lx) continue;
        if (segDist(x, z, sgm[1], sgm[2], sgm[3], sgm[4]) < sgm[5]) return true;
      }
      return false;
    };
    for (const sg of [1, -1]) {
      let run = [];
      const go = () => {
        if (run.length >= 2) strip(buf, run, sg > 0 ? hw + 0.12 : -hw, sg > 0 ? -hw : hw + 0.12, (x, z, s2, k) => yTop(x, z, s2, run[k].k), { mat: L.STONE, col: C.curb, sideDown: (x, z) => T.heightAt(x, z) - down });
        run = [];
      };
      for (let k = 0; k < P.length; k++) {
        const i = P[k].i;
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1;
        const cx = P[k].x - (dz / dl) * sg * (hw + 0.06), cz = P[k].z + (dx / dl) * sg * (hw + 0.06);
        if (onOther(cx, cz)) { go(); continue; }
        run.push({ x: P[k].x, z: P[k].z, k });
      }
      go();
    }
  }
}

/** 块内园路线段的 8 m 网格索引（路缘石判断“是否压在别的园路上”） */
function segHash(E) {
  if (E._segH) return E._segH;
  const m = new Map();
  const { mk } = E;
  for (const M of E.idx.lineGrid.query(mk.x0 - 12, mk.z0 - 12, mk.x1 + 12, mk.z1 + 12)) {
    const p = M.p, r = M.w / 2 + 0.15;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
      if (Math.max(ax, bx) < mk.x0 - 12 || Math.min(ax, bx) > mk.x1 + 12 || Math.max(az, bz) < mk.z0 - 12 || Math.min(az, bz) > mk.z1 + 12) continue;
      const it = [M, ax, az, bx, bz, r];
      for (let cx = Math.floor((Math.min(ax, bx) - r) / 8); cx <= Math.floor((Math.max(ax, bx) + r) / 8); cx++)
        for (let cz = Math.floor((Math.min(az, bz) - r) / 8); cz <= Math.floor((Math.max(az, bz) + r) / 8); cz++) {
          const k = cx * 100003 + cz;
          let l = m.get(k);
          if (!l) m.set(k, (l = []));
          l.push(it);
        }
    }
  }
  E._segH = { m };
  return E._segH;
}

/** OSM 栈道 / 亲水平台：防腐木面（水面上高出水面 0.45 m），水上部分两侧木扶手、下有桩 */
function pierGeometry(E, q) {
  const { T, idx, buf, inst } = E;
  const RAIL_WOOD = [0.42, 0.27, 0.16];
  const yAt = (x, z) => { const w = idx.waterAt(x, z); return w ? Math.max(w.planeY + 0.45, T.heightAt(x, z) + 0.1) : T.heightAt(x, z) + 0.12; };
  if (q.area) {
    const pts = [];
    for (let i = 0; i < q.p.length; i += 2) pts.push(new THREE.Vector2(q.p[i], q.p[i + 1]));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { return; }
    const y = yAt(q.cx, q.cz);
    for (const t of tris) {
      const [a, b, c] = t.map((k) => pts[k]);
      const up = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0;
      const order = up ? [a, b, c] : [a, c, b];
      const i0 = buf.v(order[0].x, y, order[0].y, 0, 1, 0, C.deck, order[0].x, order[0].y, L.WOOD);
      buf.v(order[1].x, y, order[1].y, 0, 1, 0, C.deck, order[1].x, order[1].y, L.WOOD);
      buf.v(order[2].x, y, order[2].y, 0, 1, 0, C.deck, order[2].x, order[2].y, L.WOOD);
      buf.I.push(i0, i0 + 1, i0 + 2);
    }
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const mx = (a.x + b.x) / 2, mz = (a.y + b.y) / 2, l = Math.hypot(b.x - a.x, b.y - a.y);
      // 边：木饰面（向下 0.3 m）；水上的边加扶手
      buf.quadN([a.x, y - 0.3, a.y], [b.x, y - 0.3, b.y], [b.x, y, b.y], [a.x, y, a.y], [mx - q.cx, 0, mz - q.cz], C.deck, [[0, 0], [l, 0], [l, 0.3], [0, 0.3]], L.WOOD);
      if (!idx.waterAt(mx + (mx - q.cx) * 0.05, mz + (mz - q.cz) * 0.05)) continue;
      const k = Math.max(1, Math.round(l / 2));
      for (let j = 0; j < k; j++) inst.add('rail', a.x + ((b.x - a.x) * j) / k, y, a.y + ((b.y - a.y) * j) / k, Math.atan2(-(b.y - a.y), b.x - a.x), l / k, 1, 1, RAIL_WOOD);
    }
    return;
  }
  const P = resamplePts(q.p, 2);
  if (P.length < 2) return;
  const hw = q.w / 2;
  strip(buf, P, hw, hw, (x, z) => yAt(x, z), { mat: L.WOOD, col: C.deck, sideDown: (x, z, y) => y - 0.3 });
  for (const sg of [1, -1]) {
    let prev = null;
    for (let k = 0; k < P.length; k++) {
      const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1;
      const x = P[k].x - (dz / dl) * sg * (hw - 0.05), z = P[k].z + (dx / dl) * sg * (hw - 0.05);
      const wet = idx.waterAt(x, z);
      if (!wet) { prev = null; continue; }
      const y = yAt(x, z);
      if (prev) { const l = Math.hypot(x - prev.x, z - prev.z); if (l > 0.3) inst.add('rail', prev.x, Math.min(y, prev.y), prev.z, Math.atan2(-(z - prev.z), x - prev.x), l, 1, 1, RAIL_WOOD); }
      if (k % 2 === 0 && sg > 0) buf.box(P[k].x, wet.planeY - 1.2, P[k].z, 0, 0.25, y - 0.18 - (wet.planeY - 1.2), 0.25, C.concrete, L.CONCRETE);
      prev = { x, y, z };
    }
  }
}

// ───────────── 沿路小品 ─────────────
const BAD_SMALL = M_WATER | M_BLD | M_ROAD | M_EXCL | M_OCC;
/** 公园大门：夜间两盏真实点光源（进庭院灯的点光源分配表，不画灯具） */
function gateLights(E, s, y) {
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
  E.lamps.push([s.x + fx * 3, y + 4.5, s.z + fz * 3]);
}
function okSpot(E, x, z, r, needPark = true) {
  const { mk } = E;
  if (x < mk.x0 || x >= mk.x1 || z < mk.z0 || z >= mk.z1) return false;
  const v = mk.get(x, z);
  if (v < 0) return false;
  if (needPark && !(v & (M_PARK | M_SOFT | M_GRASS))) return false;
  if (mk.any(x, z, r, BAD_SMALL)) return false;
  if (lowAt(E.green, x, z)) return false;
  if (E.trees && E.trees.near(x, z, Math.max(0.9, r))) return false;
  return true;
}
function placeLamp(E, x, z) {
  const y = E.T.heightAt(x, z);
  E.inst.add('lamp', x, y, z, hash2(Math.round(x * 3), Math.round(z * 3)) * 0.4);
  E.inst.add('glass', x, y, z, hash2(Math.round(x * 3), Math.round(z * 3)) * 0.4);
  E.inst.add('glow', x, y + 0.06, z, 0, 11, 1, 11);
  E.lamps.push([x, y + 3.5, z]);
  E.mk.occupy(x, z, 0.6);
  E.st.lamps++;
}
function placeBench(E, x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // 1.8 m 长：两端也要空
  for (const u of [-0.8, 0.8]) { const px = x + c * u, pz = z - s * u; if (!okSpot(E, px, pz, 0.35)) return false; }
  if (!okSpot(E, x, z, 0.45)) return false;
  E.inst.add('bench', x, E.T.heightAt(x, z), z, yaw);
  E.mk.occupy(x, z, 1.1);
  E.st.benches++;
  return true;
}
function placeBin(E, x, z, yaw) {
  if (!okSpot(E, x, z, 0.5)) return false;
  E.inst.add('bin', x, E.T.heightAt(x, z), z, yaw);
  E.mk.occupy(x, z, 0.7);
  E.st.bins++;
  return true;
}

/** 主城门外 280 m 内（城外一侧）：南门外广场、环城公园门前段——入城式场地，夜间照明比普通公园密 */
function nearGate(E, x, z) {
  for (const [gx, gz, ux, uz] of E.gates || []) {
    const dx = x - gx, dz = z - gz;
    if (dx * dx + dz * dz < 280 * 280 && dx * ux + dz * uz > -20) return true;
  }
  return false;
}
/** 地埋灯：与地面齐平（白天看不见灯具），夜间只有 2.4 m 的暖光斑 */
function groundLight(E, x, z) {
  const v = E.mk.get(x, z);
  if (v < 0 || v & (M_WATER | M_BLD)) return;
  E.inst.add('glow', x, E.T.heightAt(x, z) + 0.07, z, 0, 2.4, 1, 2.4);
  E.st.glows = (E.st.glows || 0) + 1;
}

function alongLine(E, Lx) {
  const { mk, idx } = E;
  if (Lx.len < 12) return;
  const pl = polyline(Lx.p);
  const id = Lx.id;
  const hw = Lx.w / 2;
  const pk = Lx.park;
  const bigPark = pk && pk.area > 50000;
  const lampSide = Lx.w >= 4 ? 0 : hash2(id, 1) < 0.5 ? 1 : -1;
  const q = {};
  // 城门前：庭院灯 14 m 一盏，园路两侧每 5 m 一盏地埋灯（审查 g1：南门外广场夜里几百米见方只有两盏灯）
  pl.at(Lx.len / 2, q);
  const gate = nearGate(E, q.x, q.z);
  const LS = gate ? 14 : 28;
  // 庭院灯：每 27 m（宽路两侧交替）
  const ph = hash2(id, 2) * LS;
  for (let s = ph, k = 0; Lx.len >= 18 && s < Lx.len; s += LS, k++) {
    pl.at(s, q);
    const side = lampSide || (k % 2 ? 1 : -1);
    const nx = -q.tz * side, nz = q.tx * side;
    const x = q.x + nx * (hw + 0.45), z = q.z + nz * (hw + 0.45);
    if (okSpot(E, x, z, 0.45)) placeLamp(E, x, z);
  }
  if (gate && Lx.w >= 2)
    for (let s = 2.5; s < Lx.len; s += 5) {
      pl.at(s, q);
      for (const side of [1, -1]) {
        const x = q.x - q.tz * side * (hw - 0.25), z = q.z + q.tx * side * (hw - 0.25);
        if (x >= mk.x0 && x < mk.x1 && z >= mk.z0 && z < mk.z1) groundLight(E, x, z);
      }
    }
  // 座椅（背向草地、面向园路）：每 25~40 m；隔一张配一组分类垃圾桶
  const bside = lampSide ? -lampSide : 1;
  let s = hash2(id, 3) * 24 + 10, k = 0;
  while (Lx.w >= 1.8 && Lx.len >= 20 && s < Lx.len - 4) {
    pl.at(s, q);
    const side = Lx.w >= 4 ? (k % 2 ? 1 : -1) : bside;
    const nx = -q.tz * side, nz = q.tx * side;
    const x = q.x + nx * (hw + 0.66), z = q.z + nz * (hw + 0.66);
    const yaw = Math.atan2(-nx, -nz); // 正面朝路
    if (placeBench(E, x, z, yaw) && k % 2 === 0) {
      pl.at(Math.min(Lx.len, s + 1.6), q);
      placeBin(E, q.x + nx * (hw + 0.55), q.z + nz * (hw + 0.55), yaw);
    }
    s += 26 + hash2(id, 10 + k) * 14; // 每 26~40 m 一张
    k++;
  }
  // 健身步道标识（大园，每 150 m）
  if (bigPark && Lx.len > 60 && !SOFT_EXCL.has(pk.n)) {
    for (let s2 = 40 + hash2(id, 4) * 60; s2 < Lx.len; s2 += 150) {
      pl.at(s2, q);
      const nx = q.tz, nz = -q.tx; // 右侧
      const x = q.x + nx * (hw + 0.4), z = q.z + nz * (hw + 0.4);
      if (!okSpot(E, x, z, 0.3)) continue;
      fitnessPost(E, x, E.T.heightAt(x, z), z, Math.atan2(q.tx, q.tz));
      E.mk.occupy(x, z, 0.5);
    }
  }
  // 绿篱 / 花境（少量）
  for (let s3 = 30 + hash2(id, 5) * 60; s3 < Lx.len - 12; s3 += 130 + hash2(id, 6) * 60) {
    pl.at(s3, q);
    const side = hash2(id, Math.round(s3)) < 0.5 ? 1 : -1;
    const nx = -q.tz * side, nz = q.tx * side;
    const h = hash2(id, Math.round(s3) + 7);
    if (h < 0.75) hedgeRun(E, pl, s3, Math.min(Lx.len - 2, s3 + 8 + h * 14), side, hw + 0.6, h);
    else {
      const x = q.x + nx * (hw + 1.0), z = q.z + nz * (hw + 1.0);
      flowerBed(E, x, z, q.tx, q.tz, 3 + h * 4, 0.95, h);
    }
  }
  // “爱护花草”小牌
  for (let s4 = 55 + hash2(id, 8) * 60; s4 < Lx.len; s4 += 140) {
    pl.at(s4, q);
    const side = hash2(id, Math.round(s4) + 3) < 0.5 ? 1 : -1;
    const nx = -q.tz * side, nz = q.tx * side;
    const x = q.x + nx * (hw + 1.4), z = q.z + nz * (hw + 1.4);
    if (!okSpot(E, x, z, 0.4) || !(mk.get(x, z) & (M_PARK | M_GRASS))) continue;
    smallSign(E, SIGN_BANDS.lawn, x, E.T.heightAt(x, z), z, Math.atan2(-nx, -nz), 0.45);
    E.mk.occupy(x, z, 0.5);
  }
  void idx;
}

function alongWalk(E, wk) {
  const pts = wk.pts;
  if (pts.length < 2) return;
  const lake = wk.kind !== 'river';
  if (!wk.park && lake) return;
  // 灯在步道外沿（靠草地），座椅在步道上靠外沿、面向水面
  const lampP = lake ? 30 : 34, benchP = lake ? 38 : 60;
  const sp = (s0, s1, period, phase) => Math.floor((s1 + phase) / period) !== Math.floor((s0 + phase) / period);
  const half = wk.kind === 'river' ? 1.5 : 1.1;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = pts[i - 1];
    if (sp(q.s, p.s, lampP, 7)) {
      const x = p.x + p.nx * (half + 0.55), z = p.z + p.nz * (half + 0.55);
      if (okSpot(E, x, z, 0.3, false)) placeLamp(E, x, z);
    } else if (sp(q.s, p.s, benchP, 21)) {
      const x = p.x + p.nx * (half - 0.35), z = p.z + p.nz * (half - 0.35);
      const yaw = Math.atan2(-p.nx, -p.nz);
      if (placeBenchWalk(E, x, z, yaw) && hash2(Math.round(p.s), 3) < 0.4) {
        const tx = -p.nz, tz = p.nx;
        placeBinWalk(E, x + tx * 1.5, z + tz * 1.5, yaw);
      }
    }
  }
  // 湖滨花境：每 ~90 m 一段（步道外侧草地边）
  if (lake) {
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = pts[i - 1];
      if (!sp(q.s, p.s, 140, 45)) continue;
      const x = p.x + p.nx * (half + 1.1), z = p.z + p.nz * (half + 1.1);
      flowerBed(E, x, z, -p.nz, p.nx, 4.5, 0.9, hash2(Math.round(p.s), 9));
    }
  }
}
function placeBenchWalk(E, x, z, yaw) {
  const { mk } = E;
  if (x < mk.x0 || x >= mk.x1 || z < mk.z0 || z >= mk.z1) return false;
  if (mk.any(x, z, 0.8, M_BLD | M_EXCL | M_OCC | M_WATER) || lowAt(E.green, x, z)) return false;
  if (E.trees && E.trees.near(x, z, 0.9)) return false;
  E.inst.add('bench', x, E.T.heightAt(x, z) + 0.05, z, yaw);
  mk.occupy(x, z, 1.1);
  E.st.benches++;
  return true;
}
function placeBinWalk(E, x, z, yaw) {
  const { mk } = E;
  if (x < mk.x0 || x >= mk.x1 || z < mk.z0 || z >= mk.z1) return false;
  if (mk.any(x, z, 0.5, M_BLD | M_EXCL | M_OCC | M_WATER)) return false;
  E.inst.add('bin', x, E.T.heightAt(x, z) + 0.05, z, yaw);
  mk.occupy(x, z, 0.6);
  E.st.bins++;
  return true;
}

/** 绿篱：沿线 s0→s1，偏移 off，分成 ≤ 3 m 的直段 */
function hedgeRun(E, pl, s0, s1, side, off, h) {
  const q = {}, r = {};
  const col = HEDGE[h < 0.2 ? 1 : h < 0.45 ? 0 : 2];
  for (let s = s0; s < s1 - 0.5; s += 3) {
    const e = Math.min(s1, s + 3);
    pl.at(s, q); pl.at(e, r);
    const ax = q.x - q.tz * side * off, az = q.z + q.tx * side * off, bx = r.x - r.tz * side * off, bz = r.z + r.tx * side * off;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, l = Math.hypot(bx - ax, bz - az);
    if (l < 0.5 || !okSpot(E, mx, mz, 0.4)) continue;
    E.inst.add('hedge', mx, E.T.heightAt(mx, mz) - 0.03, mz, Math.atan2(-(bz - az), bx - ax), l + 0.05, 0.55, 0.6, col);
    E.mk.occupy(mx, mz, 0.6);
    E.st.hedges++;
  }
}
/** 花境：中心 (x,z)，沿 (tx,tz) 长 len、宽 wid，两到三排花丛 */
function flowerBed(E, x, z, tx, tz, len, wid, h) {
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;
  const nx = -tz, nz = tx;
  // 先整体检查四角
  for (const [u, v] of [[-len / 2, -wid / 2], [len / 2, -wid / 2], [len / 2, wid / 2], [-len / 2, wid / 2], [0, 0]]) {
    const px = x + tx * u + nx * v, pz = z + tz * u + nz * v;
    const vv = E.mk.get(px, pz);
    if (vv < 0 || !(vv & (M_PARK | M_SOFT | M_GRASS)) || vv & (M_WATER | M_BLD | M_ROAD | M_EXCL | M_OCC)) return;
    if (lowAt(E.green, px, pz) || (E.trees && E.trees.near(px, pz, 0.8))) return;
  }
  const pal = FLOWER_LIN[h < 0.55 ? 0 : h < 0.85 ? 1 : 2];
  const rows = wid > 1.05 ? 3 : 2;
  let k = 0;
  for (let rr = 0; rr < rows; rr++) {
    const v = (rr - (rows - 1) / 2) * (wid / rows);
    for (let u = -len / 2 + 0.25; u <= len / 2 - 0.2; u += 0.4) {
      const jx = (hash2(k, Math.round(h * 1e4), 3) - 0.5) * 0.18, jz = (hash2(k, Math.round(h * 1e4), 5) - 0.5) * 0.18;
      const px = x + tx * (u + jx) + nx * (v + jz), pz = z + tz * (u + jx) + nz * (v + jz);
      // 同色成片：沿长度分 3 段换色；约 40% 只有绿叶（成团，不是零散），高低起伏 0.7~1.4
      const ci = (Math.floor(((u + len / 2) / len) * 3) + rr + Math.floor(h * 10)) % pal.length;
      const leafOnly = hash2(Math.floor((u + len / 2) / 1.2), rr, Math.round(h * 997)) < 0.4;
      const s = 0.75 + 0.5 * hash2(k, 11, Math.round(h * 100));
      E.inst.add('flower', px, E.T.heightAt(px, pz), pz, hash2(k, 13) * 6.28, s, s * (0.7 + 0.7 * hash2(k, 17)), s, leafOnly ? GREEN_LIN : pal[ci]);
      k++;
    }
  }
  // 花境镶边：一圈矮黄杨
  E.inst.add('hedge', x + nx * (wid / 2 + 0.12), E.T.heightAt(x, z) - 0.05, z + nz * (wid / 2 + 0.12), Math.atan2(-tz, tx), len, 0.32, 0.22, HEDGE[0]);
  E.mk.occupy(x, z, Math.max(len, wid) / 2 + 0.3);
  E.st.flowers += k;
}
function roundBed(E, x, z, r, h) {
  const vv = E.mk.get(x, z);
  if (vv < 0 || !(vv & (M_PARK | M_SOFT)) || E.mk.any(x, z, r + 0.4, M_WATER | M_BLD | M_ROAD | M_EXCL | M_OCC) || lowAt(E.green, x, z)) return;
  if (E.trees && E.trees.near(x, z, r)) return;
  const pal = FLOWER_LIN[0];
  let k = 0;
  for (let rr = 0.2; rr <= r; rr += 0.42) {
    const n = Math.max(1, Math.round((2 * PI * rr) / 0.42));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2 + rr;
      const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
      const ci = (Math.floor(rr / 0.42) + Math.floor(h * 7)) % pal.length;
      E.inst.add('flower', px, E.T.heightAt(px, pz) + 0.08 * (1 - rr / r), pz, a, 0.9, 0.9 + 0.3 * (1 - rr / r), 0.9, pal[ci]);
      k++;
    }
  }
  E.mk.occupy(x, z, r + 0.5);
  E.st.flowers += k;
}

function treeRings(E) {
  const { mk, trees } = E;
  let n = 0;
  trees.each(mk.x0, mk.z0, mk.x1, mk.z1, (i, x, z) => {
    if (n >= 8) return false;
    const sp = trees.r.sp[i];
    if (sp === 2 || sp === 6 || sp === 7 || sp === 3) return; // 雪松、灌木球、侧柏、垂柳不做环凳
    if (hash2(Math.round(x * 10), Math.round(z * 10), 29) > (greenAt(E.green, x, z) < 0.35 ? 0.3 : 0.08)) return;
    const v = mk.get(x, z);
    if (v < 0 || !(v & M_PARK) || v & M_SOFT) return;
    if (mk.any(x, z, 1.8, M_WATER | M_BLD | M_ROAD | M_EXCL | M_OCC) || lowAt(E.green, x, z)) return;
    const paved = greenAt(E.green, x, z) < 0.35; // 铺装广场上的树：直接做环凳
    if (!paved && !mk.any(x, z, 6, M_ROAD)) return; // 草坪上的孤植树：离园路不远才有人坐
    // 孤植：6.5 m 内没有别的树
    let alone = true;
    trees.each(x - 6.5, z - 6.5, x + 6.5, z + 6.5, (j, tx, tz) => { if (j !== i && (tx - x) ** 2 + (tz - z) ** 2 < 42) { alone = false; return false; } });
    if (!alone) return;
    E.inst.add('ring', x, E.T.heightAt(x, z), z, hash2(i, 3) * 0.8);
    mk.occupy(x, z, 2);
    n++; E.st.rings++;
  });
}

/**
 * 铺装广场（公园/广场用地里、影像判为铺装的成片区域，如小雁塔北侧博物院广场）：22 m 抖动格点上放庭院灯与座椅（朝四个方向之一）。
 * 判据：本点与周围 ±11 m 的 9 个点里至少 7 个是“铺装”（影像偏亮不绿）、不压路/楼/水/排除区。
 */
function plazaPass(E) {
  const { mk, green } = E;
  // 城门前的铺装广场：灯阵加密到 13 m，另在格点间放地埋灯
  const gate = nearGate(E, (mk.x0 + mk.x1) / 2, (mk.z0 + mk.z1) / 2) || nearGate(E, mk.x0, mk.z0) || nearGate(E, mk.x1, mk.z1) || nearGate(E, mk.x0, mk.z1) || nearGate(E, mk.x1, mk.z0);
  const S = gate ? 13 : 22;
  for (let gz = Math.ceil(mk.z0 / S); gz * S < mk.z1; gz++)
    for (let gx = Math.ceil(mk.x0 / S); gx * S < mk.x1; gx++) {
      const h = hash2(gx, gz, 71);
      const x = gx * S + (hash2(gx, gz, 73) - 0.5) * 8, z = gz * S + (hash2(gx, gz, 79) - 0.5) * 8;
      const v = mk.get(x, z);
      if (v < 0 || !(v & M_PARK) || v & (M_WATER | M_BLD | M_ROAD | M_EXCL | M_OCC)) continue;
      let paved = 0, valid = 0;
      for (let dz = -11; dz <= 11; dz += 11) for (let dx = -11; dx <= 11; dx += 11) {
        const g = greenAt(green, x + dx, z + dz), vv = mk.get(x + dx, z + dz);
        if (g < 0 || vv < 0 || !(vv & M_PARK)) continue;
        valid++;
        if (g < 0.45) paved++;
      }
      if (valid < 4 || paved < valid * 0.65 || greenAt(green, x, z) >= 0.45) continue;
      if (gate && nearGate(E, x, z)) {
        if (h < 0.6) { if (okSpot(E, x, z, 0.6)) placeLamp(E, x, z); }
        else if (h < 0.75) placeBench(E, x, z, Math.floor(hash2(gx, gz, 83) * 4) * Math.PI / 2);
        groundLight(E, x + S / 2, z);
        groundLight(E, x, z + S / 2);
        continue;
      }
      if (h < 0.55) { if (okSpot(E, x, z, 0.6)) placeLamp(E, x, z); }
      else if (h < 0.8) placeBench(E, x, z, Math.floor(hash2(gx, gz, 83) * 4) * Math.PI / 2);
      else if (h < 0.88) placeBin(E, x, z, Math.floor(hash2(gx, gz, 89) * 4) * Math.PI / 2);
    }
}

// ───────────── 静态小件（进块网格）─────────────
function smallSign(E, band, x, y, z, yaw, h = 1.0) {
  const { buf } = E;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  buf.box(x, y, z, yaw, 0.06, h + 0.05, 0.06, C.metal, L.METAL);
  const w = 0.62, hh = 0.155, y0 = y + h - 0.05;
  const v0 = band / 4 + 0.01, v1 = (band + 1) / 4 - 0.01;
  const P = (u, v, d) => [x + u * c + d * s, v, z - u * s + d * c];
  buf.box(x, y0 - 0.01, z, yaw, w + 0.04, hh + 0.02, 0.025, C.metal, L.METAL);
  buf.quad(P(-w / 2, y0, 0.014), P(w / 2, y0, 0.014), P(w / 2, y0 + hh, 0.014), P(-w / 2, y0 + hh, 0.014), [s, 0, c], C.white, [[0.01, v1], [0.99, v1], [0.99, v0], [0.01, v0]], L.SIGNS);
  buf.quad(P(w / 2, y0, -0.014), P(-w / 2, y0, -0.014), P(-w / 2, y0 + hh, -0.014), P(w / 2, y0 + hh, -0.014), [-s, 0, -c], C.white, [[0.01, v1], [0.99, v1], [0.99, v0], [0.01, v0]], L.SIGNS);
  E.st.signs++;
}
function fitnessPost(E, x, y, z, yaw) {
  const { buf } = E;
  buf.box(x, y, z, yaw, 0.12, 1.25, 0.12, C.blue, L.METAL);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (u, v, d) => [x + u * c + d * s, v, z - u * s + d * c];
  const v0 = 0.25 + 0.01, v1 = 0.5 - 0.01, y0 = y + 1.25, w = 0.5, hh = 0.125;
  buf.box(x, y0 - 0.01, z, yaw, w + 0.04, hh + 0.02, 0.03, C.metal, L.METAL);
  for (const sg of [1, -1]) buf.quadN(P(-w / 2 * sg, y0, 0.017 * sg), P(w / 2 * sg, y0, 0.017 * sg), P(w / 2 * sg, y0 + hh, 0.017 * sg), P(-w / 2 * sg, y0 + hh, 0.017 * sg), [s * sg, 0, c * sg], C.white, [[0.01, v1], [0.99, v1], [0.99, v0], [0.01, v0]], L.SIGNS);
  E.st.signs++;
}
/** 导览牌：双立柱 + 1.7×1.1 m 图板（本园导览图）+ 小檐 */
function signBoard(E, x, y, z, yaw, park) {
  const { buf, tex } = E;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (u, v, d) => [x + u * c + d * s, v, z - u * s + d * c];
  for (const u of [-0.92, 0.92]) buf.box(x + u * c, y, z - u * s, yaw, 0.1, 2.35, 0.1, C.metal, L.METAL);
  buf.box(x, y + 0.85, z, yaw, 1.86, 1.26, 0.08, C.metal, L.METAL);
  buf.box(x, y + 2.3, z, yaw, 2.1, 0.08, 0.36, C.metal, L.METAL);
  const slot = tex.mapSlot('map:' + park.id, (g, ox, oy, size) => drawMap(E, g, ox, oy, size, park));
  const w = 1.7, h = 1.1, y0 = y + 0.93;
  buf.quad(P(-w / 2, y0, 0.045), P(w / 2, y0, 0.045), P(w / 2, y0 + h, 0.045), P(-w / 2, y0 + h, 0.045), [s, 0, c], C.white, [[slot.u0, slot.v1], [slot.u1, slot.v1], [slot.u1, slot.v0], [slot.u0, slot.v0]], slot.layer);
}
/** 公园大门名牌（贴在牌楼明间花板两面） */
function gatePlate(E, s, y) {
  const { buf, tex } = E;
  const slot = tex.nameSlot(s.name);
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  const P = (u, v, d) => [s.x + u * c + d * sn, y + v, s.z - u * sn + d * c];
  const w = 3.1, h = 0.56, yc = 5.98;
  for (const sg of [1, -1]) {
    buf.quadN(P(-w / 2 * sg, yc - h / 2, 0.15 * sg), P(w / 2 * sg, yc - h / 2, 0.15 * sg), P(w / 2 * sg, yc + h / 2, 0.15 * sg), P(-w / 2 * sg, yc + h / 2, 0.15 * sg), [sn * sg, 0, c * sg], C.white,
      [[slot.u0, slot.v1], [slot.u1, slot.v1], [slot.u1, slot.v0], [slot.u0, slot.v0]], slot.layer);
  }
}
/** 公厕：7 m × 4.6 m 青砖墙、小青瓦硬山顶、两樘门、高窗、门头“公共厕所”标牌 */
function toilet(E, x, y, z, yaw) {
  const { buf } = E;
  const W = 7, D = 4.6, H = 3.0;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (u, v, d) => [x + u * c + d * s, y + v, z - u * s + d * c];
  buf.box(x, y - 0.3, z, yaw, W + 0.5, 0.45, D + 0.5, C.plinth, L.STONE); // 台基
  buf.box(x, y + 0.15, z, yaw, W, H - 0.15, D, C.wall, L.QINGZHUAN);
  // 硬山双坡（屋脊沿 X）
  const ov = 0.45, rise = (D / 2 + ov) * 0.55, yE = H - 0.05;
  const roofQ = (a, b, cc, d, n) => buf.quadN(a, b, cc, d, n, C.roof, [[0, 0], [W + 0.4, 0], [W + 0.4, D / 2 + ov], [0, D / 2 + ov]], L.TILE);
  roofQ(P(-W / 2 - 0.2, yE, D / 2 + ov), P(W / 2 + 0.2, yE, D / 2 + ov), P(W / 2 + 0.2, yE + rise, 0), P(-W / 2 - 0.2, yE + rise, 0), [s * 0.5, 1, c * 0.5]);
  roofQ(P(W / 2 + 0.2, yE, -D / 2 - ov), P(-W / 2 - 0.2, yE, -D / 2 - ov), P(-W / 2 - 0.2, yE + rise, 0), P(W / 2 + 0.2, yE + rise, 0), [-s * 0.5, 1, -c * 0.5]);
  // 山墙三角
  for (const sg of [1, -1]) {
    const a = P(sg * W / 2, yE - 0.01, D / 2), b = P(sg * W / 2, yE - 0.01, -D / 2), t = P(sg * W / 2, yE + rise - 0.25, 0);
    const n = [c * sg, 0, -s * sg];
    const i0 = buf.v(a[0], a[1], a[2], n[0], n[1], n[2], C.wall, 0, 0, L.QINGZHUAN);
    buf.v(b[0], b[1], b[2], n[0], n[1], n[2], C.wall, D, 0, L.QINGZHUAN);
    buf.v(t[0], t[1], t[2], n[0], n[1], n[2], C.wall, D / 2, rise, L.QINGZHUAN);
    buf.I.push(...(sg > 0 ? [i0, i0 + 1, i0 + 2] : [i0, i0 + 2, i0 + 1]));
  }
  // 正脊
  buf.box(P(0, 0, 0)[0], y + yE + rise - 0.06, P(0, 0, 0)[2], yaw, W + 0.5, 0.28, 0.26, C.ridge, L.METAL);
  // 门（男/女）、高窗、门头标牌
  for (const u of [-1.7, 1.7]) {
    buf.box(x + u * c + (D / 2 + 0.01) * s, y + 0.15, z - u * s + (D / 2 + 0.01) * c, yaw, 1.1, 2.15, 0.06, C.door, L.WOOD);
  }
  for (const u of [-2.9, 0, 2.9]) buf.box(x + u * c + (D / 2 + 0.01) * s, y + 2.2, z - u * s + (D / 2 + 0.01) * c, yaw, 0.7, 0.45, 0.05, C.window, L.METAL);
  const w = 2.0, hh = 0.5, y0 = 2.55;
  const v0 = 0.01, v1 = 0.25 - 0.01;
  buf.quad(P(-w / 2, y0, D / 2 + 0.05), P(w / 2, y0, D / 2 + 0.05), P(w / 2, y0 + hh, D / 2 + 0.05), P(-w / 2, y0 + hh, D / 2 + 0.05), [s, 0, c], C.white, [[0.01, v1], [0.99, v1], [0.99, v0], [0.01, v0]], L.SIGNS);
  E.st.signs++;
}
/** 廊架（木花架）：8 m × 3 m，混凝土方柱 + 木梁 + 木格栅，下设两条长凳 */
function pergola(E, x, y, z, yaw) {
  const { buf } = E;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const Wd = 8, D = 3, H = 2.7;
  const at = (u, d) => [x + u * c + d * s, z - u * s + d * c];
  for (const u of [-3.6, -1.2, 1.2, 3.6]) for (const d of [-1.3, 1.3]) { const [px, pz] = at(u, d); buf.box(px, y, pz, yaw, 0.26, H, 0.26, C.concrete, L.CONCRETE); }
  for (const d of [-1.3, 1.3]) { const [px, pz] = at(0, d); buf.box(px, y + H, pz, yaw, Wd + 0.6, 0.22, 0.16, C.wood, L.WOOD); }
  for (let u = -3.9; u <= 3.95; u += 0.45) { const [px, pz] = at(u, 0); buf.box(px, y + H + 0.22, pz, yaw, 0.08, 0.14, D + 0.9, C.wood, L.WOOD); }
  for (const d of [-0.9, 0.9]) { const [px, pz] = at(0, d); buf.box(px, y, pz, yaw, 6.6, 0.45, 0.4, C.concrete, L.STONE); }
  E.mk.occupy(x, z, 5);
}

/** 导览图（槽位 256²）：公园轮廓、水面、园路、标题 */
function drawMap(E, g, ox, oy, size, park) {
  const { idx } = E;
  g.fillStyle = '#23402f';
  g.fillRect(ox, oy, size, size);
  g.fillStyle = '#f3efe3';
  g.fillRect(ox + 6, oy + 6, size - 12, size - 12);
  g.fillStyle = '#23402f';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const title = (park.n || '公园') + '导览图';
  let fs = 22;
  g.font = `700 ${fs}px "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif`;
  while (g.measureText(title).width > size - 24 && fs > 12) { fs -= 2; g.font = `700 ${fs}px "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",sans-serif`; }
  g.fillText(title, ox + size / 2, oy + 24);
  const bb = park.bb, mx0 = ox + 14, my0 = oy + 44, mw = size - 28, mh = size - 58;
  const k = Math.min(mw / (bb.x1 - bb.x0 || 1), mh / (bb.z1 - bb.z0 || 1));
  const X = (x) => mx0 + (mw - (bb.x1 - bb.x0) * k) / 2 + (x - bb.x0) * k, Y = (z) => my0 + (mh - (bb.z1 - bb.z0) * k) / 2 + (z - bb.z0) * k;
  const path = (r) => { g.beginPath(); for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(r[i]), Y(r[i + 1])); g.closePath(); };
  g.fillStyle = '#bcd99a';
  path(park.outer); g.fill();
  g.strokeStyle = '#6d8f4e'; g.lineWidth = 1.5; g.stroke();
  g.fillStyle = '#7fb6d6';
  for (const w of idx.waterGrid.query(bb.x0, bb.z0, bb.x1, bb.z1)) { if (w.area > 2e6) continue; path(w.outer); g.fill(); }
  g.strokeStyle = '#ffffff'; g.lineWidth = 2;
  for (const Lx of idx.lineGrid.query(bb.x0, bb.z0, bb.x1, bb.z1)) {
    if (Lx.park !== park) continue;
    g.beginPath();
    for (let i = 0; i < Lx.p.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(Lx.p[i]), Y(Lx.p[i + 1]));
    g.stroke();
  }
  // 指北针
  g.fillStyle = '#c0392b';
  g.beginPath(); g.moveTo(ox + size - 22, oy + 50); g.lineTo(ox + size - 28, oy + 64); g.lineTo(ox + size - 16, oy + 64); g.closePath(); g.fill();
  g.font = `700 11px sans-serif`; g.fillText('N', ox + size - 22, oy + 72);
}
