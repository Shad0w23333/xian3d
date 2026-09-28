#!/usr/bin/env node
// 道路平面线形后处理（可重复运行）：public/data/roads.json 的折线清理与平滑。
// 输入固定取 data-src/roads.before_fix.json（首次运行时由当前 roads.json 备份），输出覆盖 public/data/roads.json，
// 因此多次运行结果一致；上游（roads_update.py / amap_fetch.py merge）重新生成 roads.json 后，删除备份再运行本脚本即可。
// 用法：node tools/roads_fix.mjs [--in data-src/roads.before_fix.json] [--out public/data/roads.json] [--dry]
// 处理步骤（路口节点与端点坐标始终不动，保证路网拓扑）：
//   1) 端点缝隙：悬空端点 3 m 内有同层他线顶点 → 吸附到该顶点；1.5 m 内有同层他线线段（夹角 >10°）→ 在该线段插入节点并吸附
//   2) 去重：相邻重复顶点（<0.3 m）
//   3) 去刺：非路口顶点的回折尖刺（偏角 >150°）与短锯齿（相邻反向偏角 >30° 且段长 <20 m）
//   4) 自交：长度 <150 m、内部不含路口的小环直接剪掉（在交点处接上）
//   5) 圆曲线：非路口折点按道路等级半径做圆弧过渡（切线长不超过相邻段的 45%），弧上每 ≤8° 一个点；
//      偏角 <10° 的点不处理（已足够平顺，也使本步骤对自身输出幂等）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { in: 'data-src/roads.before_fix.json', out: 'public/data/roads.json', dry: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in') opt.in = args[++i];
  else if (args[i] === '--out') opt.out = args[++i];
  else if (args[i] === '--dry') opt.dry = true;
}
const inPath = path.resolve(root, opt.in), outPath = path.resolve(root, opt.out);
if (!fs.existsSync(inPath)) {
  fs.mkdirSync(path.dirname(inPath), { recursive: true });
  fs.copyFileSync(outPath, inPath);
  console.log(`[roads_fix] 首次运行：备份 ${opt.out} → ${opt.in}`);
}
const R = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const feats = R.features;
const CLS = R.classes;
const r1 = (v) => Math.round(v * 10) / 10;
const nodeKey = (x, z) => (Math.round(x * 10) + 700000) * 2000000 + (Math.round(z * 10) + 1000000);
const stat = { snapV: 0, snapS: 0, dup: 0, spike: 0, zig: 0, loop: 0, fillet: 0, addPts: 0 };

// 转成点数组 [[x,z],...]
let P = feats.map((f) => {
  const a = [];
  for (let i = 0; i + 1 < (f.p || []).length; i += 2) a.push([f.p[i], f.p[i + 1]]);
  return a;
});
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const layer = (f) => (f.t ? -9 : f.y || 0);

// —— 节点计数（同一坐标被多少“要素顶点”引用） ——
function buildNodeCount() {
  const m = new Map();
  P.forEach((pts, fi) => {
    if (pts.length < 2) return;
    for (const [x, z] of pts) {
      const k = nodeKey(x, z);
      m.set(k, (m.get(k) || 0) + 1);
    }
  });
  return m;
}

// ================= 1) 端点缝隙 =================
{
  const cnt = buildNodeCount();
  const CELL = 50;
  const grid = new Map();
  const gk = (cx, cz) => cx * 1000003 + cz;
  P.forEach((pts, fi) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      if (Math.abs(bx - ax) > 20000 || Math.abs(bz - az) > 20000) continue;
      for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++)
        for (let cz = Math.floor(Math.min(az, bz) / CELL); cz <= Math.floor(Math.max(az, bz) / CELL); cz++) {
          let a = grid.get(gk(cx, cz));
          if (!a) grid.set(gk(cx, cz), (a = []));
          a.push(fi, k);
        }
    }
  });
  const inserts = new Map(); // fi -> [{k, t, x, z}]
  P.forEach((pts, fi) => {
    const f = feats[fi];
    if (pts.length < 2 || f.t) return;
    let flen = 0;
    for (let k = 1; k < pts.length; k++) flen += dist(pts[k - 1], pts[k]);
    if (flen < 6) return; // 极短路段不吸附（避免两端吸到同一点而退化）
    for (const end of [0, pts.length - 1]) {
      const [x, z] = pts[end];
      if ((cnt.get(nodeKey(x, z)) || 0) > 1) continue;
      // 端点方向（指向路外）
      const [qx, qz] = pts[end === 0 ? 1 : end - 1];
      let ux = x - qx, uz = z - qz;
      const ul = Math.hypot(ux, uz) || 1;
      ux /= ul; uz /= ul;
      let best = null;
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++) {
          const arr = grid.get(gk(cx + a, cz + b));
          if (!arr) continue;
          for (let q = 0; q < arr.length; q += 2) {
            const fj = arr[q], kk = arr[q + 1];
            if (fj === fi || layer(feats[fj]) !== layer(f)) continue;
            const pj = P[fj];
            const [ax, az] = pj[kk], [bx, bz] = pj[kk + 1];
            for (const [vx, vz, vk] of [[ax, az, kk], [bx, bz, kk + 1]]) {
              const d = Math.hypot(vx - x, vz - z);
              if (d < 3 && (!best || d < best.d - 1e-6 || (best.seg && d < best.d + 0.5))) best = { d, x: vx, z: vz };
            }
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
            if (l2 < 1e-6) continue;
            const t = ((x - ax) * dx + (z - az) * dz) / l2;
            if (t <= 0.02 || t >= 0.98) continue;
            const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
            const cos = Math.abs((ux * dx + uz * dz) / Math.sqrt(l2));
            if (d < 1.5 && cos < 0.985 && (!best || d < best.d - 0.5)) best = { d, x: px, z: pz, seg: { fj, kk, t } };
          }
        }
      if (!best) continue;
      // 不得吸附到本要素另一端附近（退化）
      const other = pts[end === 0 ? pts.length - 1 : 0];
      if (Math.hypot(best.x - other[0], best.z - other[1]) < 3) continue;
      if (best.seg) {
        const nx = r1(best.x), nz = r1(best.z);
        if (!inserts.has(best.seg.fj)) inserts.set(best.seg.fj, []);
        inserts.get(best.seg.fj).push({ k: best.seg.kk, t: best.seg.t, x: nx, z: nz });
        pts[end] = [nx, nz];
        stat.snapS++;
      } else {
        pts[end] = [best.x, best.z];
        stat.snapV++;
      }
    }
  });
  for (const [fj, list] of inserts) {
    list.sort((a, b) => b.k - a.k || b.t - a.t);
    const pts = P[fj];
    for (const it of list) pts.splice(it.k + 1, 0, [it.x, it.z]);
  }
}

// 路口/端点保护集合（吸附之后重新统计）
let cnt = buildNodeCount();
const isFixed = (pts, k) => k === 0 || k === pts.length - 1 || (cnt.get(nodeKey(pts[k][0], pts[k][1])) || 0) > 1;
const defl = (a, b, c) => {
  const ax = b[0] - a[0], az = b[1] - a[1], bx = c[0] - b[0], bz = c[1] - b[1];
  return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
};

// ================= 2) 去重 + 3) 去刺 =================
P = P.map((pts) => {
  if (pts.length < 2) return pts;
  let out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k];
    if (dist(out[out.length - 1], p) < 0.3) {
      stat.dup++;
      // 保留路口/端点那个
      if (isFixed(pts, k) && out.length > 1) out[out.length - 1] = p;
      else if (isFixed(pts, k) && out.length === 1 && k === pts.length - 1) out.push(p);
      continue;
    }
    out.push(p);
  }
  if (out.length < 2) out = [pts[0], pts[pts.length - 1]];
  // 回折尖刺与短锯齿（反复直到不再变化）
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let k = 1; k + 1 < out.length; k++) {
      if (isFixed(out, k)) continue;
      const d = Math.abs(defl(out[k - 1], out[k], out[k + 1]));
      if (d > (150 * Math.PI) / 180) { out.splice(k, 1); k--; stat.spike++; changed = true; continue; }
      if (k + 2 < out.length && !isFixed(out, k + 1)) {
        const d1 = defl(out[k - 1], out[k], out[k + 1]), d2 = defl(out[k], out[k + 1], out[k + 2]);
        const L = dist(out[k], out[k + 1]);
        if (Math.abs(d1) > (30 * Math.PI) / 180 && Math.abs(d2) > (30 * Math.PI) / 180 && Math.sign(d1) !== Math.sign(d2) && L < 20 &&
            Math.min(dist(out[k - 1], out[k]), dist(out[k + 1], out[k + 2])) < 20) {
          // 两个反向折点合并为中点
          const m = [r1((out[k][0] + out[k + 1][0]) / 2), r1((out[k][1] + out[k + 1][1]) / 2)];
          out.splice(k, 2, m);
          stat.zig++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return out;
});

// ================= 4) 自交小环 =================
function segX(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return [a[0] + rx * t, a[1] + rz * t];
}
P = P.map((pts) => {
  for (let guard = 0; guard < 8; guard++) {
    let done = true;
    outer: for (let i = 0; i + 1 < pts.length; i++) {
      let L = 0;
      for (let j = i + 2; j + 1 < pts.length; j++) {
        L += dist(pts[j - 1], pts[j]);
        if (L > 150) break;
        const x = segX(pts[i], pts[i + 1], pts[j], pts[j + 1]);
        if (!x) continue;
        let fixed = false;
        for (let k = i + 1; k <= j; k++) if (isFixed(pts, k)) fixed = true;
        if (fixed) continue;
        pts = [...pts.slice(0, i + 1), [r1(x[0]), r1(x[1])], ...pts.slice(j + 1)];
        stat.loop++;
        done = false;
        break outer;
      }
    }
    if (done) break;
  }
  return pts;
});

// ================= 5) 圆曲线过渡 =================
const RADIUS = {
  motorway: 400, trunk: 250, primary: 120, secondary: 80, tertiary: 50, residential: 20, service: 12, unclassified: 25,
  motorway_link: 60, trunk_link: 50, primary_link: 40, secondary_link: 30, pedestrian: 8, footway: 6,
};
const MIN_DEF = (10 * Math.PI) / 180, MAX_DEF = (135 * Math.PI) / 180, ARC_STEP = (8 * Math.PI) / 180;
P = P.map((pts, fi) => {
  if (pts.length < 3) return pts;
  const Rc = RADIUS[CLS[feats[fi].c]] || 20;
  // 先算每个折点的切线长（相邻两个圆弧共享一段，各自不超过 45%）
  const n = pts.length;
  const tl = new Float64Array(n), th = new Float64Array(n);
  for (let k = 1; k + 1 < n; k++) {
    if (isFixed(pts, k)) continue;
    const d = Math.abs(defl(pts[k - 1], pts[k], pts[k + 1]));
    th[k] = d;
    if (d < MIN_DEF || d > MAX_DEF) continue;
    tl[k] = Math.min(Rc * Math.tan(d / 2), 0.45 * dist(pts[k - 1], pts[k]), 0.45 * dist(pts[k], pts[k + 1]));
  }
  const out = [pts[0]];
  for (let k = 1; k < n; k++) {
    const p = pts[k];
    if (k === n - 1 || tl[k] < 0.5) { out.push(p); continue; }
    const a = pts[k - 1], c = pts[k + 1];
    const la = dist(a, p), lc = dist(p, c), t = tl[k];
    const ux = (p[0] - a[0]) / la, uz = (p[1] - a[1]) / la, vx = (c[0] - p[0]) / lc, vz = (c[1] - p[1]) / lc;
    const T1 = [p[0] - ux * t, p[1] - uz * t], T2 = [p[0] + vx * t, p[1] + vz * t];
    // 圆弧：从 T1 出发、切向 u，转过偏角 th（带符号）到 T2
    const sd = defl(a, p, c), d = Math.abs(sd);
    const Rr = t / Math.tan(d / 2);
    const nx = sd > 0 ? -uz : uz, nz = sd > 0 ? ux : -ux; // 指向圆心的法向（左转向左）
    // 本约定下 defl>0 表示 (ax*bz - az*bx) > 0；左法线为 (−uz, ux)… 直接用几何构造圆心并验证
    let cx = T1[0] + nx * Rr, cz = T1[1] + nz * Rr;
    if (Math.abs(Math.hypot(T2[0] - cx, T2[1] - cz) - Rr) > 0.05 * Rr + 0.05) { cx = T1[0] - nx * Rr; cz = T1[1] - nz * Rr; }
    const a0 = Math.atan2(T1[1] - cz, T1[0] - cx), a1 = Math.atan2(T2[1] - cz, T2[0] - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const m = Math.max(1, Math.ceil(Math.abs(da) / ARC_STEP));
    const arc = [];
    for (let j = 0; j <= m; j++) {
      const ang = a0 + (da * j) / m;
      arc.push([r1(cx + Rr * Math.cos(ang)), r1(cz + Rr * Math.sin(ang))]);
    }
    // 去掉与前一点重合的
    for (const q of arc) if (dist(out[out.length - 1], q) >= 0.3) out.push(q);
    stat.fillet++;
    stat.addPts += arc.length - 1;
  }
  // 圆弧终点与下一点重合时去掉
  const clean = [out[0]];
  for (let k = 1; k < out.length; k++) {
    if (dist(clean[clean.length - 1], out[k]) < 0.3) {
      if (k === out.length - 1) clean[clean.length - 1] = out[k];
      continue;
    }
    clean.push(out[k]);
  }
  return clean.length >= 2 ? clean : pts;
});

// ================= 输出 =================
let nPts0 = 0, nPts1 = 0;
feats.forEach((f, i) => {
  nPts0 += (f.p || []).length / 2;
  // 处理后若退化（不足两个不同点或长度 <1 m），保留原折线
  let L = 0;
  for (let k = 1; k < P[i].length; k++) L += dist(P[i][k - 1], P[i][k]);
  if (P[i].length >= 2 && L >= 1) f.p = P[i].flatMap(([x, z]) => [x, z]);
  nPts1 += f.p.length / 2;
});
console.log(`[roads_fix] 要素 ${feats.length}；顶点 ${nPts0} → ${nPts1}；` + Object.entries(stat).map(([k, v]) => `${k} ${v}`).join('，'));
if (!opt.dry) {
  fs.writeFileSync(outPath, JSON.stringify(R));
  console.log(`[roads_fix] 写出 ${opt.out}`);
}
