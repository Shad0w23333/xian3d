// 公园近景：空间索引 + 分块栅格掩膜（parks 模块专用，纯计算，不创建 three 对象）。
//
// 全城数据只建一次网格索引（450 m 块）：公园/草地多边形、园路（roads.json 公园内的步行道 + parks.json 的 OSM 园路）、
// 水体（ctx.waterBodies：water 模块重定后的水位与水面高度函数）、通用建筑（buildings.bin 轮廓，按锚点分块）、排除区。
// 每个块加载时栅格化一张 1 m 掩膜（450×450 字节）：公园 / 草地 / 水面 / 建筑 / 路面 / 硬排除 / 软排除 / 已占用，
// 供摆放座椅、路灯、花境、草丛时 O(1) 判断。
import { markParkWalkways } from './roads_net.js';

export const CELL = 450;
export const M_PARK = 1, M_GRASS = 2, M_WATER = 4, M_BLD = 8, M_ROAD = 16, M_EXCL = 32, M_SOFT = 64, M_OCC = 128;
// 曲江模块整园登记了“通用建筑让位”，但园内只精建了建筑、驳岸与宫灯：座椅、垃圾桶、草丛、花境照放（软排除），
// 驳岸、亭子、大门、公厕不放（曲江已有）
export const SOFT_EXCL = new Set(['大唐芙蓉园', '曲江池遗址公园', '曲江寒窑遗址公园']);

export const hash2 = (a, b, s = 0) => {
  let h = Math.imul((a * 73856093) ^ (b * 19349663) ^ (s * 83492791), 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return ((h >>> 0) % 1000003) / 1000003;
};
export const hashF = (x, z, s = 0) => hash2(Math.floor(x * 7.31) | 0, Math.floor(z * 5.17) | 0, s);

export function bboxOf(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], z = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
export function ringArea(p) {
  let a = 0;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return a / 2;
}
export function pip(x, z, p) {
  let c = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
export function inRings(x, z, outer, holes) {
  if (!pip(x, z, outer)) return false;
  if (holes) for (const h of holes) if (h && h.length >= 6 && pip(x, z, h)) return false;
  return true;
}
export function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  let t = ((x - ax) * dx + (z - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - x, ez = az + dz * t - z;
  return Math.sqrt(ex * ex + ez * ez);
}

class Grid {
  constructor(cell = CELL) { this.cell = cell; this.m = new Map(); }
  add(item, b, pad = 0) {
    const c = this.cell;
    for (let cx = Math.floor((b.x0 - pad) / c); cx <= Math.floor((b.x1 + pad) / c); cx++)
      for (let cz = Math.floor((b.z0 - pad) / c); cz <= Math.floor((b.z1 + pad) / c); cz++) {
        const k = cx * 100003 + cz;
        let l = this.m.get(k);
        if (!l) this.m.set(k, (l = []));
        l.push(item);
      }
  }
  at(cx, cz) { return this.m.get(cx * 100003 + cz) || []; }
  /** 包围盒内的（去重）条目 */
  query(x0, z0, x1, z1) {
    const c = this.cell, out = [], seen = new Set();
    for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++)
      for (let cz = Math.floor(z0 / c); cz <= Math.floor(z1 / c); cz++)
        for (const it of this.at(cx, cz)) if (!seen.has(it)) { seen.add(it); out.push(it); }
    return out;
  }
}

/** 折线弧长表 + 取点 */
export function polyline(p) {
  const n = p.length / 2, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  let seg = 0;
  return {
    p, n, cum, len: cum[n - 1],
    /** s 处的点与切向（单调递增调用时 O(1)） */
    at(s, out = {}) {
      if (s < cum[seg]) seg = 0;
      while (seg < n - 2 && cum[seg + 1] < s) seg++;
      const L = cum[seg + 1] - cum[seg] || 1e-6;
      const t = Math.max(0, Math.min(1, (s - cum[seg]) / L));
      const ax = p[seg * 2], az = p[seg * 2 + 1], bx = p[seg * 2 + 2], bz = p[seg * 2 + 3];
      out.x = ax + (bx - ax) * t; out.z = az + (bz - az) * t;
      out.tx = (bx - ax) / L; out.tz = (bz - az) / L;
      return out;
    },
  };
}

export class ParkIndex {
  constructor(ctx, parksData) {
    this.ctx = ctx;
    this.T = ctx.terrain;
    const t0 = performance.now();
    // —— 公园 / 草地 ——
    this.parks = [];
    this.grass = [];
    this.parkGrid = new Grid();
    this.grassGrid = new Grid();
    this.squareGrid = new Grid();
    for (const f of ctx.data.landuse?.polys || []) {
      if ((f.k !== 'park' && f.k !== 'grass' && f.k !== 'square') || !f.outer || f.outer.length < 6) continue;
      const area = Math.abs(ringArea(f.outer));
      if (area < 300 || area > 30e6) continue;
      const it = { n: f.n || '', k: f.k, outer: f.outer, holes: (f.holes || []).filter((h) => h && h.length >= 6), bb: bboxOf(f.outer), area };
      if (f.k === 'park') { it.id = this.parks.length; this.parks.push(it); this.parkGrid.add(it, it.bb); }
      else if (f.k === 'square') this.squareGrid.add(it, it.bb); // 广场：掩膜里按公园位登记（座椅、灯、树池环凳照放），不做大门/亭/公厕
      else { this.grass.push(it); this.grassGrid.add(it, it.bb); }
    }
    // —— 园路 ——
    // roads.json：footway / pedestrian 与“公园内无名支路”（roads 模块已按步行道画铺装）——只收落在公园里的；
    // parks.json：OSM 园路（roads 模块不画，本模块画铺装 + 路缘石）
    this.lines = [];
    this.lineGrid = new Grid();
    const roads = ctx.data.roads;
    if (roads && roads.features) {
      markParkWalkways(roads, ctx.data.landuse);
      for (const f of roads.features) {
        const ped = f.c === 12 || f.c === 13 || f._ped;
        if (!ped || f.t || !f.p || f.p.length < 4) continue;
        const p = f.p;
        let hit = 0, tot = 0;
        for (let i = 0; i < p.length; i += 2) { tot++; if (this.parkAt(p[i], p[i + 1])) hit++; }
        if (hit * 2 < tot) continue;
        this._addLine({ p, w: Math.max(f.c === 13 ? 2 : 3, Math.min(8, Number(f.w) || (f.c === 13 ? 2 : 4))), b: f.b ? 1 : 0, own: false, kind: f.c === 13 ? 'footway' : 'pedestrian', road: f });
      }
    }
    for (const q of parksData?.paths || []) {
      if (!q.p || q.p.length < 4) continue;
      this._addLine({ p: q.p, w: Math.max(1.2, Math.min(8, q.w || 2.5)), b: q.b ? 1 : 0, own: true, kind: q.k, steps: q.k === 'steps' });
    }
    // —— 全部道路（掩膜用：路面不放东西）——
    this.roadGrid = new Grid();
    for (const f of roads?.features || []) {
      if (f.t || !f.p || f.p.length < 4) continue;
      const hw = Math.min(21, (Number(f.w) || 6) / 2) + (f.c <= 4 ? 1.5 : 0.3); // 主干路带上人行道边缘
      const it = { p: f.p, hw, bridge: !!f.b, c: f.c };
      this.roadGrid.add(it, bboxOf(f.p), hw);
    }
    for (const L of this.lines) if (L.own) this.roadGrid.add({ p: L.p, hw: L.w / 2 + 0.15, bridge: !!L.b, c: 13, own: true }, L.bb, L.w);
    // —— 栈道 / 亲水平台（OSM man_made=pier）——
    this.pierGrid = new Grid();
    for (const q of parksData?.piers || []) {
      if (!q.p || q.p.length < 4) continue;
      const it = { p: q.p, area: !!q.area && q.p.length >= 6, w: Math.max(1.5, Math.min(6, q.w || 2.4)), bb: bboxOf(q.p) };
      let cx = 0, cz = 0;
      for (let i = 0; i < q.p.length; i += 2) { cx += q.p[i]; cz += q.p[i + 1]; }
      it.cx = cx / (q.p.length / 2); it.cz = cz / (q.p.length / 2);
      this.pierGrid.add(it, it.bb, 2);
    }
    // —— 水体 ——
    this.water = [];
    this.waterGrid = new Grid();
    const bodies = ctx.waterBodies;
    if (bodies && bodies.length) {
      for (const w of bodies) { const it = { ...w, holes: (w.holes || []).filter((h) => h && h.length >= 6) }; this.water.push(it); this.waterGrid.add(it, w.bb, 4); }
    } else {
      for (const w of ctx.data.water?.polys || []) {
        if (!w.outer || w.outer.length < 6) continue;
        const bb = bboxOf(w.outer);
        const h = Number(w.h) || this.T.heightAt((bb.x0 + bb.x1) / 2, (bb.z0 + bb.z1) / 2);
        const it = { n: w.n || '', k: w.k, outer: w.outer, holes: (w.holes || []).filter((q) => q && q.length >= 6), bb, area: Math.abs(ringArea(w.outer)), level: h, planeY: h + 0.15, lvKind: null, surfaceY: () => h + 0.15 };
        this.water.push(it); this.waterGrid.add(it, bb, 4);
      }
    }
    this.waterLines = [];
    this.wlineGrid = new Grid();
    for (const l of ctx.data.water?.lines || []) {
      if (!l.p || l.p.length < 4) continue;
      const it = { p: l.p, hw: Math.max(1.5, Math.min(15, (Number(l.w) || 6) / 2)) };
      this.waterLines.push(it); this.wlineGrid.add(it, bboxOf(l.p), it.hw);
    }
    // —— 排除区 ——
    this.exclGrid = new Grid();
    for (const it of ctx.exclusions?.items || []) {
      const f = it.flags || {};
      let kind = 0;
      if (SOFT_EXCL.has(it.name)) kind = M_SOFT;
      else if (f.buildings && f.maxHeight == null) kind = M_EXCL;
      else if (f.trees && !f.buildings) kind = M_EXCL; // 地标足迹/视廊/停车场（只让树的）也不放小品
      else if (f.buildings && f.maxHeight != null && (it.bb.x1 - it.bb.x0) * (it.bb.z1 - it.bb.z0) < 2500) kind = M_EXCL; // 地铁口等小件
      if (!kind) continue;
      this.exclGrid.add({ p: it.p, bb: it.bb, kind, name: it.name }, it.bb);
    }
    // —— 通用建筑（buildings.bin，按锚点分块，懒解析轮廓）——
    this._initBuildings(ctx.data.buildings);
    this.stats = { parks: this.parks.length, grass: this.grass.length, lines: this.lines.length, own: this.lines.filter((l) => l.own).length, water: this.water.length, ms: Math.round(performance.now() - t0) };
  }

  _addLine(L) {
    L.bb = bboxOf(L.p);
    L.id = this.lines.length;
    L.pl = polyline(L.p);
    L.len = L.pl.len;
    this.lines.push(L);
    this.lineGrid.add(L, L.bb, 6);
  }

  _initBuildings(B) {
    this.bld = null;
    if (!B || B.byteLength < 16) return;
    const dv = new DataView(B);
    const ver = dv.getUint32(4, true), N = dv.getUint32(8, true), tv = dv.getUint32(12, true);
    let o = 16;
    const ax = new Float32Array(B, o, N); o += N * 4;
    const az = new Float32Array(B, o, N); o += N * 4;
    const vs = new Uint32Array(B, o, N); o += N * 4;
    const vc = new Uint16Array(B, o, N); o += N * 2;
    const hd = new Uint16Array(B, o, N); o += N * 2;
    const mh = new Uint16Array(B, o, N); o += N * 2;
    o += N; // kind
    const flags = new Uint8Array(B, o, N); o += N;
    if (ver >= 2) o += N;
    o = (o + 3) & ~3;
    const offs = new Int16Array(B, o, tv * 2);
    const grid = new Map();
    const skip = this.ctx.exclusions?.buildingSkip || null;
    for (let i = 0; i < N; i++) {
      if (flags[i] & 128) continue;
      if (skip && skip[i]) continue;
      if (mh[i] > 45) continue;
      const k = Math.floor(ax[i] / CELL) * 100003 + Math.floor(az[i] / CELL);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(i);
    }
    this.bld = { ax, az, vs, vc, hd, offs, grid };
  }

  /** 包围盒内的建筑轮廓 [{p, bb, h}]（按锚点所在块 + 相邻块查找，楼最大跨度按 300 m 计） */
  buildingsIn(x0, z0, x1, z1) {
    const B = this.bld;
    if (!B) return [];
    const out = [];
    for (let cx = Math.floor((x0 - 300) / CELL); cx <= Math.floor((x1 + 300) / CELL); cx++)
      for (let cz = Math.floor((z0 - 300) / CELL); cz <= Math.floor((z1 + 300) / CELL); cz++) {
        const l = B.grid.get(cx * 100003 + cz);
        if (!l) continue;
        for (const i of l) {
          const n = B.vc[i];
          if (n < 3) continue;
          const p = new Array(n * 2);
          let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
          for (let k = 0; k < n; k++) {
            const x = B.ax[i] + B.offs[(B.vs[i] + k) * 2] * 0.1, z = B.az[i] + B.offs[(B.vs[i] + k) * 2 + 1] * 0.1;
            p[k * 2] = x; p[k * 2 + 1] = z;
            if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
          }
          if (bx1 < x0 || bx0 > x1 || bz1 < z0 || bz0 > z1) continue;
          out.push({ p, bb: { x0: bx0, x1: bx1, z0: bz0, z1: bz1 }, h: B.hd[i] * 0.1 });
        }
      }
    return out;
  }

  parkAt(x, z) {
    for (const p of this.parkGrid.at(Math.floor(x / CELL), Math.floor(z / CELL))) {
      const b = p.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (inRings(x, z, p.outer, p.holes)) return p;
    }
    return null;
  }
  waterAt(x, z, pad = 0) {
    for (const w of this.waterGrid.at(Math.floor(x / CELL), Math.floor(z / CELL))) {
      const b = w.bb;
      if (x < b.x0 - pad || x > b.x1 + pad || z < b.z0 - pad || z > b.z1 + pad) continue;
      if (inRings(x, z, w.outer, w.holes)) return w;
    }
    return null;
  }
  /** 到最近水岸线（任一水体外环/洞）的距离，超过 cap 返回 cap */
  shoreDist(x, z, cap = 30) {
    let best = cap;
    for (const w of this.waterGrid.query(x - cap, z - cap, x + cap, z + cap)) {
      const b = w.bb;
      if (x < b.x0 - cap || x > b.x1 + cap || z < b.z0 - cap || z > b.z1 + cap) continue;
      for (const r of [w.outer, ...w.holes]) {
        for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
          const ax = r[j * 2], az = r[j * 2 + 1], bx = r[i * 2], bz = r[i * 2 + 1];
          if (Math.max(ax, bx) < x - best || Math.min(ax, bx) > x + best || Math.max(az, bz) < z - best || Math.min(az, bz) > z + best) continue;
          const d = segDist(x, z, ax, az, bx, bz);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
  /** 到最近道路/园路边缘的距离（负数 = 在路面上），超过 cap 返回 cap */
  roadEdgeDist(x, z, cap = 12) {
    let best = cap;
    for (const r of this.roadGrid.query(x - cap, z - cap, x + cap, z + cap)) {
      const p = r.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        if (Math.max(ax, bx) < x - best - r.hw || Math.min(ax, bx) > x + best + r.hw || Math.max(az, bz) < z - best - r.hw || Math.min(az, bz) > z + best + r.hw) continue;
        const d = segDist(x, z, ax, az, bx, bz) - r.hw;
        if (d < best) best = d;
      }
    }
    return best;
  }
  exclAt(x, z) {
    let k = 0;
    for (const e of this.exclGrid.at(Math.floor(x / CELL), Math.floor(z / CELL))) {
      const b = e.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (pip(x, z, e.p)) k |= e.kind;
    }
    return k;
  }
  buildingAt(x, z, pad = 0) {
    for (const q of this.buildingsIn(x - pad - 1, z - pad - 1, x + pad + 1, z + pad + 1)) {
      if (pip(x, z, q.p)) return q;
      if (pad > 0) for (let i = 0, n = q.p.length / 2, j = n - 1; i < n; j = i++) if (segDist(x, z, q.p[j * 2], q.p[j * 2 + 1], q.p[i * 2], q.p[i * 2 + 1]) < pad) return q;
    }
    return null;
  }

  /**
   * 块掩膜（1 m 栅格，CELL×CELL 字节）。返回 {gx, gz, x0, z0, n, m, get(x,z), set...}
   */
  mask(gx, gz) {
    const n = CELL, x0 = gx * CELL, z0 = gz * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
    const m = new Uint8Array(n * n);
    const fillRings = (rings, bit) => {
      // 扫描线（偶奇规则）：行中心 z = z0 + r + 0.5
      const edges = [];
      for (const r of rings) {
        if (!r || r.length < 6) continue;
        for (let i = 0, k = r.length / 2, j = k - 1; i < k; j = i++) {
          const az = r[j * 2 + 1], bz = r[i * 2 + 1];
          if (Math.max(az, bz) < z0 || Math.min(az, bz) > z1) continue;
          edges.push(r[j * 2], az, r[i * 2], bz);
        }
      }
      if (!edges.length) return;
      const xs = [];
      for (let row = 0; row < n; row++) {
        const z = z0 + row + 0.5;
        xs.length = 0;
        for (let e = 0; e < edges.length; e += 4) {
          const az = edges[e + 1], bz = edges[e + 3];
          if (az > z !== bz > z) xs.push(edges[e] + ((z - az) * (edges[e + 2] - edges[e])) / (bz - az));
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        const o = row * n;
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const c0 = Math.max(0, Math.ceil(xs[q] - x0 - 0.5)), c1 = Math.min(n - 1, Math.floor(xs[q + 1] - x0 - 0.5));
          for (let c = c0; c <= c1; c++) m[o + c] |= bit;
        }
      }
    };
    const stampLine = (p, hw, bit) => {
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        const cx0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - x0)), cx1 = Math.min(n - 1, Math.floor(Math.max(ax, bx) + hw - x0));
        const cz0 = Math.max(0, Math.floor(Math.min(az, bz) - hw - z0)), cz1 = Math.min(n - 1, Math.floor(Math.max(az, bz) + hw - z0));
        if (cx0 > cx1 || cz0 > cz1) continue;
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9, h2 = hw * hw;
        for (let r = cz0; r <= cz1; r++) {
          const z = z0 + r + 0.5;
          for (let c = cx0; c <= cx1; c++) {
            const x = x0 + c + 0.5;
            let t = ((x - ax) * dx + (z - az) * dz) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + dx * t - x, ez = az + dz * t - z;
            if (ex * ex + ez * ez <= h2) m[r * n + c] |= bit;
          }
        }
      }
    };
    for (const p of this.parkGrid.at(gx, gz)) fillRings([p.outer, ...p.holes], M_PARK);
    for (const p of this.squareGrid.at(gx, gz)) fillRings([p.outer, ...p.holes], M_PARK);
    for (const p of this.grassGrid.at(gx, gz)) fillRings([p.outer, ...p.holes], M_GRASS);
    for (const w of this.waterGrid.at(gx, gz)) fillRings([w.outer, ...w.holes], M_WATER);
    for (const l of this.wlineGrid.at(gx, gz)) stampLine(l.p, l.hw, M_WATER);
    for (const r of this.roadGrid.at(gx, gz)) if (!r.bridge) stampLine(r.p, r.hw, M_ROAD);
    for (const b of this.buildingsIn(x0, z0, x1, z1)) fillRings([b.p], M_BLD);
    for (const e of this.exclGrid.at(gx, gz)) fillRings([e.p], e.kind);
    const get = (x, z) => {
      const c = Math.floor(x - x0), r = Math.floor(z - z0);
      if (c < 0 || r < 0 || c >= n || r >= n) return -1;
      return m[r * n + c];
    };
    /** 圆盘内是否有任一 bits（半径 rad 米，采样 1 m） */
    const any = (x, z, rad, bits) => {
      const r0 = Math.ceil(rad);
      for (let dz = -r0; dz <= r0; dz++)
        for (let dx = -r0; dx <= r0; dx++) {
          if (dx * dx + dz * dz > rad * rad + 0.5) continue;
          const v = get(x + dx, z + dz);
          if (v > 0 && v & bits) return true;
        }
      return false;
    };
    const occupy = (x, z, rad) => {
      const r0 = Math.ceil(rad);
      for (let dz = -r0; dz <= r0; dz++)
        for (let dx = -r0; dx <= r0; dx++) {
          if (dx * dx + dz * dz > rad * rad + 0.5) continue;
          const c = Math.floor(x + dx - x0), r = Math.floor(z + dz - z0);
          if (c >= 0 && r >= 0 && c < n && r < n) m[r * n + c] |= M_OCC;
        }
    };
    return { gx, gz, x0, z0, x1, z1, n, m, get, any, occupy, stamp: stampLine };
  }
}

/**
 * 影像“是草”置信度（块内 4 m 栅格，0..255）：取覆盖本块的最清晰内置底图（img_core 约 5 m/像素、城墙/曲江 2 m），
 * 偏绿 → 高；偏亮且不绿（园路、广场、铺装）→ 低。近景地面着色器用同一类判据（亮度 0.09~0.2 线性 ≈ sRGB 0.34~0.48）。
 */
export function greenGrid(ctx, gx, gz, idx = null) {
  const G = CELL / 4 | 0;
  const out = new Uint8Array(G * G).fill(200);
  const low = new Uint8Array(G * G);
  const x0 = gx * CELL, z0 = gz * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
  // 低于近旁水面的地面（曲江湖岸凹口、湖心小岛等——精建模块在那里另铺了岛面，地形本身在水下）：不长草、不放小品
  if (idx) {
    const T = ctx.terrain;
    for (const w of idx.waterGrid.at(gx, gz)) {
      const b = w.bb, py = w.planeY;
      if (!Number.isFinite(py)) continue;
      const i0 = Math.max(0, Math.floor((b.x0 - 30 - x0) / 4)), i1 = Math.min(G - 1, Math.floor((b.x1 + 30 - x0) / 4));
      const j0 = Math.max(0, Math.floor((z1 - b.z1 - 30) / 4)), j1 = Math.min(G - 1, Math.floor((z1 - b.z0 + 30) / 4));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = j * G + i;
          if (low[k]) continue;
          const x = x0 + (i + 0.5) * 4, z = z1 - (j + 0.5) * 4;
          if (T.heightAt(x, z) < py + 0.12) low[k] = 1;
        }
    }
  }
  const ms = ctx.imagery?.mosaics || [];
  const m = ms.find((q) => q.bounds.x0 <= x0 && q.bounds.x1 >= x1 && q.bounds.z0 <= z0 && q.bounds.z1 >= z1 && q.texture?.image);
  const done = () => {
    for (let k = 0; k < G * G; k++) if (low[k]) out[k] = 0;
    // 广场用地（不与公园/草地重叠处）：地面着色器画铺装，这里也按铺装算
    if (idx) {
      const sq = idx.squareGrid.at(gx, gz);
      if (sq.length)
        for (let j = 0; j < G; j++)
          for (let i = 0; i < G; i++) {
            const x = x0 + (i + 0.5) * 4, z = z1 - (j + 0.5) * 4;
            if (!sq.some((q) => x >= q.bb.x0 && x <= q.bb.x1 && z >= q.bb.z0 && z <= q.bb.z1 && inRings(x, z, q.outer, q.holes))) continue;
            if (idx.parkAt(x, z)) continue;
            out[j * G + i] = Math.min(out[j * G + i], 20);
          }
    }
    return { G, data: out, low, x0, z1 };
  };
  if (!m) return done();
  try {
    const b = m.bounds, img = m.texture.image;
    const W = img.width, H = img.height;
    const sx = ((x0 - b.x0) / (b.x1 - b.x0)) * W, sw = (CELL / (b.x1 - b.x0)) * W;
    const sy = ((b.z1 - z1) / (b.z1 - b.z0)) * H, sh = (CELL / (b.z1 - b.z0)) * H; // 位图已上下翻转（第 0 行 = 南）
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(G, G) : Object.assign(document.createElement('canvas'), { width: G, height: G });
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'medium';
    g.drawImage(img, sx, sy, sw, sh, 0, 0, G, G);
    const px = g.getImageData(0, 0, G, G).data;
    // 与近景地面着色器同一判据（src/core/terrain.js：imgVeg / bright / veg），公园用地内 vegR = 1
    const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const LUT = new Float32Array(256);
    for (let i = 0; i < 256; i++) LUT[i] = Math.pow(i / 255, 2.2);
    for (let i = 0; i < G * G; i++) {
      const r = LUT[px[i * 4]], gg = LUT[px[i * 4 + 1]], bb = LUT[px[i * 4 + 2]];
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * bb;
      const mx = Math.max(r, gg, bb, 0.02);
      const imgVeg = ss(0.03, 0.12, (gg - Math.max(r, bb)) / mx);
      const bright = ss(0.09, 0.2, lum) * (1 - imgVeg);
      const veg = Math.max(imgVeg, 1 - bright);
      // 画布第 j 行 = 南边起第 j 行（z 从 z1 往北）
      out[i] = Math.round(ss(0.42, 0.58, veg) * 255);
    }
  } catch (e) {
    /* 位图不可读：按草地处理 */
  }
  return done();
}
/** 块内 4 m 栅格取值（0..1 草地置信度；low = 低于近旁水面） */
export function greenAt(gr, x, z) {
  const i = Math.floor((x - gr.x0) / 4), j = Math.floor((gr.z1 - z) / 4);
  if (i < 0 || j < 0 || i >= gr.G || j >= gr.G) return -1;
  return gr.data[j * gr.G + i] / 255;
}
export function lowAt(gr, x, z) {
  const i = Math.floor((x - gr.x0) / 4), j = Math.floor((gr.z1 - z) / 4);
  if (i < 0 || j < 0 || i >= gr.G || j >= gr.G) return false;
  return gr.low[j * gr.G + i] === 1;
}
