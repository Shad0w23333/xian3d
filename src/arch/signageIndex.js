// 招牌模块专用：建筑轮廓 / 道路的空间索引，以及“POI 最近的临街立面”搜索。
// 数据来源：buildings.bin（v1 / v2，见 docs/CONTRACT.md 3.4）、roads.json（3.5）。
// 只读共享 ArrayBuffer，不复制顶点数据；网格索引只覆盖城市核心 ±R_MAX 米。

const R_MAX = 17000; // 只索引离钟楼 17 km 以内（CORE 全量）
const BG = 50; // 建筑网格边长（米）
const RG = 60; // 道路网格边长（米）
const key = (cx, cz) => (cx + 4096) * 8192 + (cz + 4096);

/** 解析 buildings.bin（v1：…kind、flags；v2：flags 后多一个 uint8 style 数组） */
export function parseBuildings(buffer) {
  if (!buffer || buffer.byteLength < 16) return null;
  const dv = new DataView(buffer);
  if (dv.getUint8(0) !== 88 || dv.getUint8(1) !== 66 || dv.getUint8(2) !== 76 || dv.getUint8(3) !== 68) return null;
  const version = dv.getUint32(4, true), count = dv.getUint32(8, true), total = dv.getUint32(12, true);
  if (version < 1 || version > 2 || count > 2e6 || total > 2e7) return null;
  let o = 16;
  const ax = new Float32Array(buffer, o, count); o += 4 * count;
  const az = new Float32Array(buffer, o, count); o += 4 * count;
  const start = new Uint32Array(buffer, o, count); o += 4 * count;
  const vc = new Uint16Array(buffer, o, count); o += 2 * count;
  const hDm = new Uint16Array(buffer, o, count); o += 2 * count;
  const minDm = new Uint16Array(buffer, o, count); o += 2 * count;
  const kind = new Uint8Array(buffer, o, count); o += count;
  const flags = new Uint8Array(buffer, o, count); o += count;
  let style = null;
  if (version >= 2) { style = new Uint8Array(buffer, o, count); o += count; }
  o = (o + 3) & ~3;
  if (o + total * 4 > buffer.byteLength) return null;
  const offs = new Int16Array(buffer, o, total * 2);
  return { version, count, total, ax, az, start, vc, hDm, minDm, kind, flags, style, offs };
}

/**
 * 建筑空间索引。
 *  - candidates(x, z, r, cb)：遍历 bbox 与圆相交的建筑
 *  - vertex(b, j) → [x, z]；orient(b)：外环方向符号（+1 = shoelace>0）
 *  - inside(x, z)：点是否落在任一（未被排除的）建筑内，返回建筑号或 -1
 */
export class BuildingIndex {
  constructor(parsed, exclusions) {
    this.p = parsed;
    const n = parsed ? parsed.count : 0;
    this.bb = new Float32Array(n * 4);
    this.orientCache = new Int8Array(n);
    this.state = new Uint8Array(n); // 0 未知 1 可用 2 排除
    this.grid = new Map();
    this.exclusions = exclusions;
    if (!parsed) return;
    const { ax, az, start, vc, offs } = parsed;
    for (let b = 0; b < n; b++) {
      const cnt = vc[b];
      if (cnt < 3) { this.state[b] = 2; continue; }
      const x = ax[b], z = az[b];
      if (Math.abs(x) > R_MAX || Math.abs(z) > R_MAX) { this.state[b] = 2; continue; }
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      const s = start[b] * 2;
      for (let j = 0; j < cnt; j++) {
        const vx = x + offs[s + j * 2] * 0.1, vz = z + offs[s + j * 2 + 1] * 0.1;
        if (vx < x0) x0 = vx; if (vx > x1) x1 = vx;
        if (vz < z0) z0 = vz; if (vz > z1) z1 = vz;
      }
      this.bb[b * 4] = x0; this.bb[b * 4 + 1] = z0; this.bb[b * 4 + 2] = x1; this.bb[b * 4 + 3] = z1;
      const c0 = Math.floor(x0 / BG), c1 = Math.floor(x1 / BG), r0 = Math.floor(z0 / BG), r1 = Math.floor(z1 / BG);
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > 400) continue; // 异常巨大轮廓不参与
      for (let cx = c0; cx <= c1; cx++)
        for (let cz = r0; cz <= r1; cz++) {
          const k = key(cx, cz);
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(b);
        }
    }
  }
  usable(b) {
    let s = this.state[b];
    if (s) return s === 1;
    const p = this.p;
    s = 1;
    if (p.hDm[b] < 25) s = 2; // 低于 2.5 m 的棚子/围墙不挂招牌
    else if (this.exclusions && this.exclusions.test(p.ax[b], p.az[b], 'buildings', p.hDm[b] * 0.1)) s = 2;
    this.state[b] = s;
    return s === 1;
  }
  vx(b, j) { return this.p.ax[b] + this.p.offs[(this.p.start[b] + j) * 2] * 0.1; }
  vz(b, j) { return this.p.az[b] + this.p.offs[(this.p.start[b] + j) * 2 + 1] * 0.1; }
  orient(b) {
    let o = this.orientCache[b];
    if (o) return o;
    const n = this.p.vc[b];
    let a = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += this.vx(b, i) * this.vz(b, j) - this.vx(b, j) * this.vz(b, i);
    }
    o = a >= 0 ? 1 : -1;
    this.orientCache[b] = o;
    return o;
  }
  area(b) {
    const n = this.p.vc[b];
    let a = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += this.vx(b, i) * this.vz(b, j) - this.vx(b, j) * this.vz(b, i);
    }
    return Math.abs(a) / 2;
  }
  height(b) { return this.p.hDm[b] * 0.1; }
  minHeight(b) { return this.p.minDm[b] * 0.1; }
  candidates(x, z, r, cb) {
    const c0 = Math.floor((x - r) / BG), c1 = Math.floor((x + r) / BG), r0 = Math.floor((z - r) / BG), r1 = Math.floor((z + r) / BG);
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let cx = c0; cx <= c1; cx++)
      for (let cz = r0; cz <= r1; cz++) {
        const l = this.grid.get(key(cx, cz));
        if (!l) continue;
        for (const b of l) {
          if (seen.has(b)) continue;
          seen.add(b);
          const bb = this.bb;
          if (x < bb[b * 4] - r || x > bb[b * 4 + 2] + r || z < bb[b * 4 + 1] - r || z > bb[b * 4 + 3] + r) continue;
          if (!this.usable(b)) continue;
          cb(b);
        }
      }
  }
  contains(b, x, z) {
    const bb = this.bb;
    if (x < bb[b * 4] || x > bb[b * 4 + 2] || z < bb[b * 4 + 1] || z > bb[b * 4 + 3]) return false;
    const n = this.p.vc[b];
    let c = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = this.vx(b, i), zi = this.vz(b, i), xj = this.vx(b, j), zj = this.vz(b, j);
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  }
  inside(x, z, skip = -1) {
    const l = this.grid.get(key(Math.floor(x / BG), Math.floor(z / BG)));
    if (!l) return -1;
    for (const b of l) {
      if (b === skip || !this.usable(b)) continue;
      if (this.contains(b, x, z)) return b;
    }
    return -1;
  }
}

/** 道路线段索引（世界坐标折线 → 线段），用于判断立面是否临街、公交站定位 */
export class RoadIndex {
  constructor(roads) {
    const feats = (roads && roads.features) || [];
    const classes = (roads && roads.classes) || [];
    const ci = (n) => classes.indexOf(n);
    this.cls = {
      motorway: ci('motorway'), trunk: ci('trunk'), primary: ci('primary'), secondary: ci('secondary'), tertiary: ci('tertiary'),
      motorway_link: ci('motorway_link'), footway: ci('footway'), pedestrian: ci('pedestrian'), service: ci('service'),
    };
    const segs = [];
    this.names = feats.map((f) => f.n || '');
    this.feats = feats;
    for (let fi = 0; fi < feats.length; fi++) {
      const f = feats[fi];
      const p = f.p;
      if (!p || p.length < 4) continue;
      if (f.t) continue; // 隧道
      if (Math.abs(p[0]) > R_MAX + 2000 || Math.abs(p[1]) > R_MAX + 2000) continue;
      const w = f.w || 6;
      for (let i = 2; i < p.length; i += 2) segs.push(p[i - 2], p[i - 1], p[i], p[i + 1], w, f.c, f.b ? 1 : 0, fi);
    }
    const n = segs.length / 8;
    this.n = n;
    this.s = new Float32Array(segs);
    this.grid = new Map();
    for (let i = 0; i < n; i++) {
      const o = i * 8, pad = this.s[o + 4] / 2;
      const x0 = Math.min(this.s[o], this.s[o + 2]) - pad, x1 = Math.max(this.s[o], this.s[o + 2]) + pad;
      const z0 = Math.min(this.s[o + 1], this.s[o + 3]) - pad, z1 = Math.max(this.s[o + 1], this.s[o + 3]) + pad;
      const c0 = Math.floor(x0 / RG), c1 = Math.floor(x1 / RG), r0 = Math.floor(z0 / RG), r1 = Math.floor(z1 / RG);
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > 900) continue;
      for (let cx = c0; cx <= c1; cx++)
        for (let cz = r0; cz <= r1; cz++) {
          const k = key(cx, cz);
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(i);
        }
    }
    this.out = { d: 0, cd: 0, seg: -1, t: 0, px: 0, pz: 0, dx: 0, dz: 0, w: 0, c: -1, fi: -1 };
  }
  /**
   * 最近道路（到路缘的距离 d = 中心线距离 − 半宽，可为负=在路面上）。
   * accept(classIndex, isBridge, featureIndex) 过滤；(tx,tz,minDot) 可选：只取与该方向夹角余弦 ≥ minDot 的路段；返回共享对象（调用方需立即读取）或 null。
   */
  nearest(x, z, maxD, accept = null, tx = 0, tz = 0, minDot = 0) {
    const c0 = Math.floor((x - maxD) / RG), c1 = Math.floor((x + maxD) / RG), r0 = Math.floor((z - maxD) / RG), r1 = Math.floor((z + maxD) / RG);
    let best = Infinity, bi = -1, bt = 0, bcd = 0;
    const s = this.s;
    for (let cx = c0; cx <= c1; cx++)
      for (let cz = r0; cz <= r1; cz++) {
        const l = this.grid.get(key(cx, cz));
        if (!l) continue;
        for (const i of l) {
          const o = i * 8;
          if (accept && !accept(s[o + 5], s[o + 6], s[o + 7])) continue;
          const ax = s[o], az = s[o + 1], dx = s[o + 2] - ax, dz = s[o + 3] - az;
          const L2 = dx * dx + dz * dz || 1e-6;
          if (minDot > 0 && Math.abs(dx * tx + dz * tz) < minDot * Math.sqrt(L2)) continue; // 只要与 (tx,tz) 近似平行的路段
          let t = ((x - ax) * dx + (z - az) * dz) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + dx * t - x, qz = az + dz * t - z;
          const cd = Math.sqrt(qx * qx + qz * qz);
          const d = cd - s[o + 4] / 2;
          if (d < best) { best = d; bi = i; bt = t; bcd = cd; }
        }
      }
    if (bi < 0 || best > maxD) return null;
    const o = bi * 8, r = this.out;
    const dx = s[o + 2] - s[o], dz = s[o + 3] - s[o + 1], L = Math.hypot(dx, dz) || 1;
    r.d = best; r.cd = bcd; r.seg = bi; r.t = bt; r.w = s[o + 4]; r.c = s[o + 5]; r.fi = s[o + 7];
    r.px = s[o] + dx * bt; r.pz = s[o + 1] + dz * bt; r.dx = dx / L; r.dz = dz / L;
    return r;
  }
}

/**
 * 找 POI 的最佳挂牌立面：候选 = 半径 maxR 内建筑的每条外墙边；
 * 评分 = POI 到边的距离 + 0.7 × 该边外侧 7 m 处到最近道路路缘的距离（临街优先）
 *        + 外侧被别的建筑堵住的惩罚 + 短边惩罚。
 * 返回 {b, e, ax, az, bx, bz, L, nx, nz, t, fx, fz, d, inside} 或 null。
 */
export function findFacade(bi, ri, x, z, { maxR = 45, minLen = 3, notRoad = null, filter = null } = {}) {
  let best = null, bestScore = Infinity;
  const accept = (c) => c !== ri.cls.motorway && c !== ri.cls.motorway_link;
  bi.candidates(x, z, maxR, (b) => {
    if (filter && !filter(b)) return;
    const n = bi.p.vc[b];
    const sgn = bi.orient(b);
    const inside = bi.contains(b, x, z);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = bi.vx(b, i), az = bi.vz(b, i), bx = bi.vx(b, j), bz = bi.vz(b, j);
      const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
      if (L < minLen) continue;
      let t = ((x - ax) * dx + (z - az) * dz) / (L * L);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const fx = ax + dx * t, fz = az + dz * t;
      const d = Math.hypot(x - fx, z - fz);
      if (d > maxR) continue;
      const nx = (dz / L) * sgn, nz = (-dx / L) * sgn; // 外法线
      // 若 POI 在建筑外，则应在该边外侧
      const side = (x - fx) * nx + (z - fz) * nz;
      let score = d + (L < 6 ? 3 : 0);
      if (!inside && side < -1.5) score += 25;
      const px = fx + nx * 7, pz = fz + nz * 7;
      const r = ri.nearest(px, pz, 40, accept);
      score += 0.7 * (r ? Math.max(0, r.d) : 40);
      if (bi.inside(fx + nx * 2.5, fz + nz * 2.5, b) >= 0) score += 30; // 外侧紧贴别的建筑（夹缝）
      if (notRoad && r && r.d < -1) score += 10;
      if (score < bestScore) {
        bestScore = score;
        best = { b, e: i, ax, az, bx, bz, L, nx, nz, t, fx, fz, d, inside, score };
      }
    }
  });
  return best;
}
