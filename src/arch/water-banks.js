// 水位与岸高（water 模块 prepare 阶段）：按当前地形重定城市静水与河道的水位，并把水面多边形内的地形压到水位以下。
//
// 为什么：water.json 的 h 是旧 DEM 在多边形内取的低分位数；换成 FABDEM（建筑/植被去除 + 大水面平整）之后，
// 公园湖泊四周的地面只比 h 低 0.3 m 左右，护城河南段、浐河市区段甚至比 h 低 4~5 m（2026-10-08 实测）。
// 水面按 h + 0.15 画，结果是“一张水皮浮在草地上 0.5~4 m”：人眼高度看湖岸是水面直接贴地（半透明边缘透出草地），
// 护城河南段两侧是 5 m 高的光墙。
//
// 做法：
//   · 岸高 bank = 岸线外侧 5 m / 9 m 处地形（取高者）的中位数（只取真实岸线：跳过 2400 m 数据分块切边、相邻护城河段的拼接边）；
//   · 水位 L = min(h, bank − 落差)：护城河 2.2 m（石砌高岸 + 栏杆）、城市湖泊 0.7 m（小池塘 0.5 m）、河道 1.3 m（斜坡护岸）；
//   · 岸边垫高：外环内（含湖心岛）mode 'max' 抬到岸高、向外羽化 15 m——30 m DEM 在湖边是一圈低洼“碗沿”（兴庆湖岸外 4 m
//     有一成采样比水位低 3 m），岛也被平整成了湖底；只抬不压，岸上本来就高的地方不动；
//   · 水下压低：多边形内 mode 'min' 压到 L − 1.2~1.5 m（湖心岛 / 河中沙洲是洞，用“钥匙孔”单环表达，岛上不压），
//     水面就是一个平面（不再在浅岸处爬坡），岸线外 5 cm 起地形不受影响；
//   · 改写 data.water.polys[i].h（共享数据）：城墙模块的护城河石壁、植被、驳岸模块都按新水位取高度。
// 跳过：大唐芙蓉园芙蓉湖 / 曲江池（曲江模块按原水位精建驳岸、岛面与倒影）、喷泉/泳池类、basin（广场水景，多由地标模块自建）、
//       水库与 3 km² 以上大湖、远郊水体。
import { ringArea, isTileEdge } from './water-geom.js';

const SKIP_NAMES = new Set(['芙蓉湖', '曲江池']);
const SKIP_RE = /喷泉|泳|水景|水池/;
const CX = 300, CZ = 900; // 主城中心（钟楼略南）

function pip(x, z, o) {
  let c = false;
  for (let i = 0, n = o.length / 2, j = n - 1; i < n; j = i++) {
    const xi = o[i * 2], zi = o[i * 2 + 1], xj = o[j * 2], zj = o[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** 外环 + 洞 → 单环（钥匙孔）：偶奇规则下洞内为“外”。每个洞从外环首点进、绕洞一圈、回到外环首点（桥边成对抵消） */
export function keyholeRing(outer, holes) {
  const out = Array.from(outer);
  if (!holes || !holes.length) return out;
  out.push(outer[0], outer[1]);
  for (const h of holes) {
    if (!h || h.length < 6) continue;
    for (let i = 0; i < h.length; i++) out.push(h[i]);
    out.push(h[0], h[1], outer[0], outer[1]);
  }
  return out;
}

/** 道格拉斯-普克简化（闭合环），tol 米；closed 时按环处理（首尾相接） */
export function simplify(p, tol, closed = true) {
  const n = p.length / 2;
  if (n <= 8) return Array.from(p);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  // 闭合环：先找离首点最远的点切成两段
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2; if (d > fd) { fd = d; far = i; } }
  keep[far] = 1;
  const stack = [[0, far], [far, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = p[a * 2], az = p[a * 2 + 1], dx = p[b * 2] - ax, dz = p[b * 2 + 1] - az, l2 = dx * dx + dz * dz || 1e-9;
    let best = -1, bd = t2;
    for (let i = a + 1; i < b; i++) {
      let t = ((p[i * 2] - ax) * dx + (p[i * 2 + 1] - az) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = (ax + dx * t - p[i * 2]) ** 2 + (az + dz * t - p[i * 2 + 1]) ** 2;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  void closed;
  return out.length >= 6 ? out : Array.from(p);
}

/** 单环（可为钥匙孔环）按 cell 方格裁剪（Sutherland–Hodgman，逐格对矩形裁剪）；返回非空小块列表 */
export function clipToGrid(ring, cell) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
  if (x1 - x0 <= cell * 1.2 && z1 - z0 <= cell * 1.2) return [ring];
  const out = [];
  const clip = (pts, axis, v, keepLess) => {
    const res = [];
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = pts[i * 2 + axis], b = pts[j * 2 + axis];
      const ina = keepLess ? a <= v : a >= v, inb = keepLess ? b <= v : b >= v;
      if (ina) res.push(pts[i * 2], pts[i * 2 + 1]);
      if (ina !== inb) {
        const t = (v - a) / (b - a);
        res.push(pts[i * 2] + (pts[j * 2] - pts[i * 2]) * t, pts[i * 2 + 1] + (pts[j * 2 + 1] - pts[i * 2 + 1]) * t);
      }
    }
    return res;
  };
  for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
    for (let cz = Math.floor(z0 / cell); cz <= Math.floor(z1 / cell); cz++) {
      let q = ring;
      q = clip(q, 0, cx * cell, false); if (q.length < 6) continue;
      q = clip(q, 0, (cx + 1) * cell, true); if (q.length < 6) continue;
      q = clip(q, 1, cz * cell, false); if (q.length < 6) continue;
      q = clip(q, 1, (cz + 1) * cell, true); if (q.length < 6) continue;
      if (Math.abs(ringArea(q)) < 0.5) continue;
      out.push(q);
    }
  return out;
}

/** 凸包（单调链），输入/输出 [x,z,...] */
export function convexHull(p) {
  const pts = [];
  for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  const out = [];
  for (const q of h) out.push(q[0], q[1]);
  return out;
}

function kindOf(src, area, cx, cz) {
  const n = src.n || '';
  if (SKIP_NAMES.has(n) || SKIP_RE.test(n)) return null;
  const r = Math.hypot(cx - CX, cz - CZ);
  if (src.k === 'moat') return 'moat';
  if (src.k === 'river' || src.k === 'canal') return r < 26000 ? 'river' : null;
  if (src.k === 'lake' || src.k === 'pond') {
    if (area < 250 || area > 3e6 || r > 18000 || /水库/.test(n)) return null;
    return 'lake';
  }
  return null; // reservoir / basin / 其他
}

/**
 * 计算水位并登记地形压平区。返回 Map(src → {L, bank, kind, h0})。
 * terrain：ctx.terrain（prepare 阶段，可 addFlatten）
 */
export function planWaterLevels(data, terrain, roads = null) {
  const res = new Map();
  const list = [];
  for (const src of data?.polys || []) {
    const o = src.outer;
    if (!o || o.length < 6 || !o.every(Number.isFinite)) continue;
    const area = Math.abs(ringArea(o));
    let cx = 0, cz = 0;
    for (let i = 0; i < o.length; i += 2) { cx += o[i]; cz += o[i + 1]; }
    cx /= o.length / 2; cz /= o.length / 2;
    const kind = kindOf(src, area, cx, cz);
    if (!kind) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    if (x1 - x0 > 26000 || z1 - z0 > 26000 || area > 30e6) continue;
    list.push({ src, kind, area, bb: { x0, x1, z0, z1 } });
  }
  // 护城河各段的边（拼接边判断）
  const moats = list.filter((w) => w.kind === 'moat');
  const nearOtherMoat = (self, x, z) => {
    for (const m of moats) {
      if (m === self) continue;
      const b = m.bb;
      if (x < b.x0 - 4 || x > b.x1 + 4 || z < b.z0 - 4 || z > b.z1 + 4) continue;
      const o = m.src.outer;
      for (let i = 0, n = o.length / 2, j = n - 1; i < n; j = i++) {
        const ax = o[j * 2], az = o[j * 2 + 1], dx = o[i * 2] - ax, dz = o[i * 2 + 1] - az;
        const l2 = dx * dx + dz * dz || 1e-9;
        let t = ((x - ax) * dx + (z - az) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(ax + dx * t - x, az + dz * t - z) < 3) return true;
      }
    }
    return false;
  };
  // 曲江两湖（精建驳岸按原水位）：其附近不做岸边垫高，免得把它们的水下地形抬上来
  const skipped = [];
  for (const src of data?.polys || []) {
    if (!SKIP_NAMES.has(src.n) || !src.outer || src.outer.length < 6) continue;
    const o = src.outer;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    skipped.push({ x0, x1, z0, z1 });
  }
  const plans = [];
  for (const w of list) {
    const o = w.src.outer;
    const n = o.length / 2;
    const sgn = Math.sign(ringArea(o)) || 1;
    const hs = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = o[i * 2], az = o[i * 2 + 1], bx = o[j * 2], bz = o[j * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      if (w.kind === 'river' && isTileEdge(ax, az, bx, bz)) continue;
      // 外法线（指向陆地）：ringArea > 0 时 (dz, −dx) 指向外侧
      let nx = (sgn * (bz - az)) / L, nz = (-sgn * (bx - ax)) / L;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (pip(mx + nx * 0.6, mz + nz * 0.6, o)) { nx = -nx; nz = -nz; } // 自交/方向异常时以点测为准
      const k = Math.max(1, Math.round(L / 8));
      for (let s = 0; s < k; s++) {
        const t = (s + 0.5) / k;
        const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
        if (w.kind === 'moat' && nearOtherMoat(w, px, pz)) continue;
        hs.push(Math.max(terrain.heightAt(px + nx * 5, pz + nz * 5), terrain.heightAt(px + nx * 9, pz + nz * 9)));
      }
    }
    if (hs.length < 3) continue;
    hs.sort((a, b) => a - b);
    // 岸高取中位数：30 m DEM 在湖边是一圈“碗沿”，低的一半由下面的岸边垫高补齐
    const bank = hs[Math.floor(hs.length * 0.5)];
    const drop = w.kind === 'moat' ? 2.2 : w.kind === 'river' ? 1.3 : w.area < 1500 ? 0.5 : 0.7;
    const h0 = Number(w.src.h);
    const L = Number.isFinite(h0) ? Math.min(h0, bank - drop) : bank - drop;
    const b = w.bb, m = 20;
    const nearSkipped = skipped.some((q) => q.x1 > b.x0 - m && q.x0 < b.x1 + m && q.z1 > b.z0 - m && q.z0 < b.z1 + m);
    plans.push({ w, L, bank: L + drop, h0, deep: w.kind === 'lake' ? 1.2 : 1.5, raise: !nearSkipped });
  }
  // ① 岸边垫高（只抬不压）：只给湖泊/池塘，取外环的凸包（DEM 把湖区连同半岛、湖心岛一起平整成了湖底，兴庆湖半岛比水位低 2 m）；
  //    抬到岸高，向外 15 m 羽化。护城河、河道不垫（实测岸边地形与新水位关系正常；河道两侧低地可能是真实滩地）。
  for (const P of plans) {
    if (!P.raise || P.w.kind !== 'lake') continue;
    terrain.addFlatten({ points: simplify(convexHull(P.w.src.outer), 0.8), height: P.bank, mode: 'max', feather: 15 });
  }
  // ② 水下压低（只压不抬，须在全部垫高之后登记：平整区按登记顺序生效）：钥匙孔单环（岛与沙洲不压），
  //    简化后按 300 m 方格裁成小块——平整区每次取高都要做点在多边形内 + 到边距离，大河一块 2.4 km、几百个顶点，
  //    不裁的话附近所有取地面高度的地方（地形网格、植被、建筑、道路）都要多付这笔账
  for (const P of plans) {
    const src = P.w.src;
    const ring = keyholeRing(simplify(src.outer, 0.6, true), (src.holes || []).filter((h) => h && h.length >= 6).map((h) => simplify(h, 0.6, true)));
    for (const piece of clipToGrid(ring, 300)) terrain.addFlatten({ points: piece, height: P.L - P.deep, mode: 'min', feather: 0.05 });
    res.set(src, { L: P.L, bank: P.bank, kind: P.w.kind, h0: P.h0 });
    src.h = Math.round(P.L * 100) / 100;
  }
  // ③ 穿过水面却没标桥的路（OSM 里少数堤上步道、护城河上的人行小桥）：路下地形抬回岸高，像一道堤，免得路面跟着水下地形沉进水里
  if (roads && roads.features) {
    let nCause = 0;
    for (const f of roads.features) {
      if (f.b || f.t || !f.p || f.p.length < 4) continue;
      const p = f.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const mx = (p[i] + p[i + 2]) / 2, mz = (p[i + 1] + p[i + 3]) / 2;
        const P = plans.find((q) => mx >= q.w.bb.x0 && mx <= q.w.bb.x1 && mz >= q.w.bb.z0 && mz <= q.w.bb.z1 && pip(mx, mz, q.w.src.outer) && !(q.w.src.holes || []).some((h) => h.length >= 6 && pip(mx, mz, h)));
        if (!P) continue;
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3], L = Math.hypot(bx - ax, bz - az) || 1;
        const hw = Math.min(12, (Number(f.w) || 4) / 2) + 1.2, nx = (-(bz - az) / L) * hw, nz = ((bx - ax) / L) * hw;
        const ex = ((bx - ax) / L) * 1.5, ez = ((bz - az) / L) * 1.5;
        terrain.addFlatten({ points: [ax - ex + nx, az - ez + nz, bx + ex + nx, bz + ez + nz, bx + ex - nx, bz + ez - nz, ax - ex - nx, az - ez - nz], height: P.bank, mode: 'max', feather: 1.5 });
        nCause++;
      }
    }
    res.causeways = nCause;
  }
  return res;
}
