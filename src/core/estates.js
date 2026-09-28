// 小区：汇总小区名称与范围 → 近距离名称标注 + 可选边界描线
//
// 来源（按可信度合并，同名 800 m 内只保留一个）：
//   1. landuse.json 中有名称的 residential 地块（多边形 = 边界）
//   2. buildings_names.json 中“XX小区-3号楼 / XX花园12栋”一类楼栋名：按前缀归组（≥ 2 栋），
//      组内建筑轮廓的凸包外扩 6 m 作为边界，标注高度取组内最高楼顶
//   3. pois.json 中名称为住宅小区类（花园/家园/苑/小区/公寓/新村……）的 POI（仅点位）
import * as THREE from 'three';
import { Labels } from './labels.js';
import { parseBuildings } from '../arch/bld-gen.js';
import { classByName, C } from '../arch/bld-class.js';

const GENERIC = /^(社区|小区|家属|住宅|住宅区|居民区|居住区|家属院|宿舍|新村|生活区|村)$/;
const TILE = 2000;
const LINE_R = 2600; // 边界线显示半径
const BLD_NAME = /^(.{2,24}?)(?:[-—·\s]+[A-Za-z0-9一二三四五六七八九十]*[区期座]?[-—]?)?(?:[A-Za-z]?\d+|[一二三四五六七八九十]+)(?:号楼|栋|幢|座|号|#)$/;

function hull(pts) {
  // 单调链凸包（pts: [[x,z],...]）
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  up.pop();
  lo.pop();
  return lo.concat(up);
}
const polyArea = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return Math.abs(a) / 2;
};
const inRing = (x, z, p) => {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
  }
  return c;
};
const norm = (n) => n.replace(/[（(].*?[)）]/g, '').replace(/(小区|住宅小区|社区)$/, '').trim();

export class Estates {
  constructor(container, ctx) {
    this.labels = new Labels(container);
    this.labels.root.classList.add('labels-estate');
    this.group = new THREE.Group();
    this.group.name = '小区边界';
    ctx.scene.add(this.group);
    this.terrain = ctx.terrain;
    this.visible = true;
    this.showLines = true;
    this.tiles = [];
    const t0 = performance.now();
    this.items = this._collect(ctx);
    this._buildLabels();
    this._buildLines();
    const bySrc = [0, 0, 0];
    for (const e of this.items) bySrc[e.src]++;
    console.log(`[estates] 小区 ${this.items.length} 个（用地 ${bySrc[0]} / 楼栋名 ${bySrc[1]} / POI ${bySrc[2]}），${(performance.now() - t0).toFixed(0)} ms`);
  }

  _collect(ctx) {
    const T = this.terrain;
    const out = [];
    const byNorm = new Map();
    const dup = (n, x, z) => (byNorm.get(norm(n)) || []).some((e) => Math.hypot(e.x - x, e.z - z) < 800);
    const push = (e) => {
      out.push(e);
      const k = norm(e.name);
      if (!byNorm.has(k)) byNorm.set(k, []);
      byNorm.get(k).push(e);
    };
    // 1. 用地
    const lu = (ctx.data.landuse?.polys || []).filter((p) => p.k === 'residential' && p.n && !GENERIC.test(p.n) && p.outer?.length >= 6);
    lu.sort((a, b) => (b.a || 0) - (a.a || 0));
    const luNamed = [];
    for (const p of lu) {
      const o = p.outer;
      let cx = 0, cz = 0;
      for (let i = 0; i < o.length; i += 2) (cx += o[i]), (cz += o[i + 1]);
      cx /= o.length / 2;
      cz /= o.length / 2;
      if (!inRing(cx, cz, o)) {
        // 凹多边形：取最靠近形心的顶点向内偏一点
        let best = 0, bd = Infinity;
        for (let i = 0; i < o.length; i += 2) {
          const d = (o[i] - cx) ** 2 + (o[i + 1] - cz) ** 2;
          if (d < bd) (bd = d), (best = i);
        }
        cx = o[best] * 0.9 + cx * 0.1;
        cz = o[best + 1] * 0.9 + cz * 0.1;
      }
      if (dup(p.n, cx, cz)) continue;
      const area = p.a || polyArea(o);
      const e = { name: p.n, x: cx, z: cz, top: 0, area, ring: o, src: 0, village: /村$/.test(p.n) };
      push(e);
      luNamed.push(e);
    }
    // 2. 楼栋名前缀
    const P = parseBuildings(ctx.data.buildings);
    const names = ctx.data.buildingNames || {};
    if (P) {
      const groups = new Map();
      for (const key in names) {
        const m = BLD_NAME.exec(names[key]);
        if (!m) continue;
        let pre = m[1].replace(/[-—·\s]+$/, '');
        const SUFFIX = /[A-Za-z0-9]+区$|[东西南北中]区$|[一二三四五六七八九十\d]+期$|[A-Za-z]+\d*$|第$|[-—·\s]+$/;
        for (let k = 0; k < 3; k++) {
          const q = pre.replace(SUFFIX, '');
          if (q.length < 2 || q === pre) break;
          pre = q;
        }
        if (pre.length < 2 || GENERIC.test(pre) || /^[\dA-Za-z#\s]+$/.test(pre)) continue;
        const c = classByName(pre);
        if (c >= 0 && c !== C.RES) continue; // “XX大学-3号楼”“XX大厦-A座”等不是小区
        if (!groups.has(pre)) groups.set(pre, []);
        groups.get(pre).push(+key);
      }
      for (const [pre, ids] of groups) {
        if (ids.length < 2) continue;
        // 去掉离中位点 > 600 m 的同名楼（异地同名）
        const xs = ids.map((i) => P.anchorX[i]).sort((a, b) => a - b), zs = ids.map((i) => P.anchorZ[i]).sort((a, b) => a - b);
        const mx = xs[xs.length >> 1], mz = zs[zs.length >> 1];
        const keep = ids.filter((i) => Math.hypot(P.anchorX[i] - mx, P.anchorZ[i] - mz) < 600);
        if (keep.length < 2) continue;
        const pts = [];
        let cx = 0, cz = 0, top = 0;
        for (const i of keep) {
          const ax = P.anchorX[i], az = P.anchorZ[i];
          cx += ax;
          cz += az;
          top = Math.max(top, P.heightDm[i] * 0.1);
          const s = P.vertStart[i] * 2, n = P.vertCount[i];
          for (let k = 0; k < n; k++) pts.push([ax + P.offs[s + k * 2] * 0.1, az + P.offs[s + k * 2 + 1] * 0.1]);
        }
        cx /= keep.length;
        cz /= keep.length;
        if (dup(pre, cx, cz)) continue;
        // 已落在一个有名称的小型住宅地块内 → 视为同一小区
        if (luNamed.some((e) => e.area < 150000 && Math.abs(e.x - cx) < 700 && Math.abs(e.z - cz) < 700 && inRing(cx, cz, e.ring))) continue;
        const hl = hull(pts);
        const ring = [];
        for (const [x, z] of hl) {
          const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz) || 1;
          ring.push(x + (dx / d) * 6, z + (dz / d) * 6);
        }
        push({ name: pre, x: cx, z: cz, top, area: ring.length >= 6 ? polyArea(ring) : 2000, ring: ring.length >= 6 ? ring : null, src: 1 });
      }
    }
    // 3. POI
    for (const p of ctx.data.pois?.pois || []) {
      if (p.k !== 'landmark' && p.k !== 'apartment') continue;
      if (!p.n || /[-—](\d|[A-Z])|号楼$|栋$|座$/.test(p.n) || classByName(p.n) !== C.RES || GENERIC.test(p.n)) continue;
      if (dup(p.n, p.x, p.z)) continue;
      if (luNamed.some((e) => e.area < 150000 && Math.abs(e.x - p.x) < 700 && Math.abs(e.z - p.z) < 700 && inRing(p.x, p.z, e.ring))) continue;
      push({ name: p.n, x: p.x, z: p.z, top: 0, area: 20000, ring: null, src: 2 });
    }
    for (const e of out) e.y = T.heightAt(e.x, e.z);
    return out;
  }

  _buildLabels() {
    for (const e of this.items) {
      const r = Math.sqrt(Math.max(e.area, 5000));
      const maxDist = THREE.MathUtils.clamp(900 + r * 1.6, 900, 2000) * (e.village ? 0.8 : 1);
      const h = Math.max(e.top + 6, 22);
      this.labels.add(e.name, new THREE.Vector3(e.x, e.y + h, e.z), {
        category: 'estate',
        minDist: 20,
        maxDist,
        priority: e.src === 0 ? 0.6 : e.src === 1 ? 0.55 : 0.45,
      });
    }
  }

  _buildLines() {
    const T = this.terrain;
    const tiles = new Map();
    for (const e of this.items) {
      if (!e.ring || e.area > 3e6) continue;
      const key = Math.floor(e.x / TILE) + ':' + Math.floor(e.z / TILE);
      let t = tiles.get(key);
      if (!t) tiles.set(key, (t = { cx: (Math.floor(e.x / TILE) + 0.5) * TILE, cz: (Math.floor(e.z / TILE) + 0.5) * TILE, v: [] }));
      const o = e.ring, n = o.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = o[i * 2], z0 = o[i * 2 + 1], x1 = o[j * 2], z1 = o[j * 2 + 1];
        const L = Math.hypot(x1 - x0, z1 - z0);
        const k = Math.max(1, Math.ceil(L / 30));
        for (let s = 0; s < k; s++) {
          const xa = x0 + ((x1 - x0) * s) / k, za = z0 + ((z1 - z0) * s) / k;
          const xb = x0 + ((x1 - x0) * (s + 1)) / k, zb = z0 + ((z1 - z0) * (s + 1)) / k;
          t.v.push(xa, T.heightAt(xa, za) + 1.5, za, xb, T.heightAt(xb, zb) + 1.5, zb);
        }
      }
    }
    this.mat = new THREE.LineBasicMaterial({ color: 0xffc94a, transparent: true, opacity: 0.85, depthWrite: false, fog: false, toneMapped: false });
    for (const t of tiles.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(t.v, 3));
      g.computeBoundingSphere();
      const m = new THREE.LineSegments(g, this.mat);
      m.name = '小区边界';
      m.renderOrder = 3;
      m.visible = false;
      this.group.add(m);
      this.tiles.push({ cx: t.cx, cz: t.cz, mesh: m });
    }
  }

  setVisible(v) {
    this.visible = v;
    this.labels.setVisible(v);
    this.group.visible = v && this.showLines;
  }
  setLines(v) {
    this.showLines = v;
    this.group.visible = this.visible && v;
  }

  update(camera, w, h) {
    if (!this.visible) return;
    this.labels.update(camera, w, h);
    if (!this.showLines) return;
    const cp = camera.position;
    const agl = camera.userData.agl ?? 500;
    const R = agl > 5000 ? 0 : LINE_R + agl * 0.6;
    for (const t of this.tiles) t.mesh.visible = Math.max(Math.abs(t.cx - cp.x), Math.abs(t.cz - cp.z)) - TILE / 2 < R;
  }
}
