// 公园近景：水岸（每块只建岸线中点落在本块内的边，相邻块在共享折点处无缝衔接）。
//
// 城市湖泊/池塘（water 模块重定水位后，水面低于岸顶 0.5~0.7 m）：
//   毛石驳岸立面（水下 0.9 m 起）+ 细面花岗岩压顶（向水面出挑 6 cm，背面下垂盖住岸边地形）+ 湖滨透水砖步道（公园内 2.2 m，
//   其他 0.9 m，外沿有护脚）+ 汉白玉栏杆（公园内面积 ≥ 3000 m² 的湖）；每 ~110 m 一处亲水台阶（栏杆留口），
//   大湖每 ~230 m 一处防腐木亲水平台（伸入水面 3 m，三面木扶手）；公园湖岸每 ~160 m 一块“水深危险”警示牌。湖心岛只砌岸与压顶。
// 护城河（城墙模块已砌石壁与 0.7 m 压顶，水面低于岸顶约 2.2 m）：压顶上加石栏杆，压顶外侧 2.2 m 透水砖步道。
// 河道（浐河、灞河、渭河等，水面低于岸顶约 1.3 m）：六角砖斜坡护岸（坡比约 1:1.8，从岸线向水面一侧铺，水下 0.5 m 收脚）
//   + 坡顶不锈钢护栏 + 3 m 堤顶步道；遇车行道、建筑、地标排除区处断开。
// 只处理 water 模块重定过水位的水体（lvKind 有值）；曲江两湖、广场水景等由各自模块负责。
import { L } from './park-tex.js';
import { lin, strip } from './park-geom.js';
import { M_WATER, M_BLD, M_ROAD, M_EXCL, M_SOFT, M_PARK, ringArea } from './park-index.js';
import { isTileEdge as isTileEdgeLocal } from './water-geom.js';

const COL = {
  wall: lin('#ffffff', 0.92), cope: lin('#ffffff', 0.98), copeMarble: lin('#f4f1ea'), apron: lin('#ffffff', 0.95), skirt: lin('#a7a299', 0.85),
  hex: lin('#ffffff', 0.95), path: lin('#ffffff', 0.9), wood: lin('#ffffff'), post: lin('#9a948a'), sign: lin('#ffffff'), metal: lin('#ffffff'),
};
const RAIL_STEEL = [0.62, 0.64, 0.67], RAIL_WOOD = [0.42, 0.27, 0.16];

/**
 * env: {T, idx, buf, inst, mk (块掩膜), moats (护城河水体列表), signs: {danger(x,y,z,yaw)}}
 * 返回 {walks: [{pts:[{x,z}], face: [nx,nz] per point, kind}], gaps}
 */
export function buildShore(env, w, out) {
  const { T, idx, mk } = env;
  const kind = w.lvKind;
  if (!kind) return;
  const rings = kind === 'river' ? [w.outer] : [w.outer, ...w.holes];
  const inPark = (x, z) => { const v = mk.get(x, z); return v > 0 && v & M_PARK; };
  rings.forEach((ring, ri) => {
    const n = ring.length / 2;
    if (n < 3) return;
    // 环方向：最长的真实岸线边（不取河道 2.4 km 分块切边——切边两侧都是水）中点左侧在本水面里 → 环要反向遍历（保证陆地在左）
    let li = -1, ll = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, l = Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1]);
      if (kind === 'river' && isTileEdgeLocal(ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1])) continue;
      if (l > ll) { ll = l; li = i; }
    }
    if (li < 0) return;
    const lj = (li + 1) % n;
    const ex = (ring[lj * 2] - ring[li * 2]) / ll, ez = (ring[lj * 2 + 1] - ring[li * 2 + 1]) / ll;
    const mx = (ring[li * 2] + ring[lj * 2]) / 2, mz = (ring[li * 2 + 1] + ring[lj * 2 + 1]) / 2;
    const inL = idx.waterAt(mx - ez * 0.8, mz + ex * 0.8) === w, inR = idx.waterAt(mx + ez * 0.8, mz - ex * 0.8) === w;
    const rev = inL && !inR ? true : !inL && inR ? false : Math.sign(ringArea(ring)) * (ri === 0 ? 1 : -1) > 0;
    const V = (k) => { const q = rev ? (n - 1 - (((k % n) + n) % n)) : (((k % n) + n) % n); return [ring[q * 2], ring[q * 2 + 1]]; };
    // 折点切向（前后边平均）与环上弧长
    const S = new Float64Array(n + 1);
    for (let k = 1; k <= n; k++) { const a = V(k - 1), b = V(k); S[k] = S[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]); }
    const tangentAt = (k) => {
      const a = V(k - 1), b = V(k), c = V(k + 1);
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, l2 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
      let tx = (b[0] - a[0]) / l1 + (c[0] - b[0]) / l2, tz = (b[1] - a[1]) / l1 + (c[1] - b[1]) / l2;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      // 角平分线放宽：1 / cos(半角)，限制 1.6
      const k2 = Math.min(1.6, 1 / Math.max(0.6, ((b[0] - a[0]) / l1) * tx + ((b[1] - a[1]) / l1) * tz));
      return [tx, tz, k2];
    };
    // 有效边
    const valid = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const a = V(k), b = V(k + 1);
      const Lk = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (Lk < 0.3) continue;
      const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
      if (cx < mk.x0 || cx >= mk.x1 || cz < mk.z0 || cz >= mk.z1) continue;
      if (kind === 'river' && isTileEdgeLocal(a[0], a[1], b[0], b[1])) continue;
      const nx = -(b[1] - a[1]) / Lk, nz = (b[0] - a[0]) / Lk; // 左 = 陆地
      if (kind === 'moat' && env.moatJoint(w, cx, cz)) continue;
      const land = mk.get(cx + nx * 1.6, cz + nz * 1.6);
      if (land > 0 && land & M_WATER) continue; // 两块水面相接（闸、相邻池）
      if (land > 0 && land & M_EXCL) continue; // 地标精建区
      if (land > 0 && land & M_SOFT && ri === 0 && kind !== 'river') continue; // 曲江园内湖岸由曲江模块负责
      const wet = mk.get(cx - nx * 1.5, cz - nz * 1.5);
      if (land > 0 && wet > 0 && land & M_ROAD && wet & M_ROAD) continue; // 路从这里跨过岸线（堤上的路/未标桥的小桥）
      valid[k] = 1;
    }
    // 连续有效边 → 段
    let start = -1;
    for (let k = 0; k < n; k++) if (valid[k] && !valid[(k - 1 + n) % n]) { start = k; break; }
    if (start < 0) { if (valid.every((v) => v)) start = 0; else return; }
    for (let c = 0, k = start; c < n; ) {
      if (!valid[k % n]) { k++; c++; continue; }
      const run = [];
      while (c < n && valid[k % n]) {
        run.push(k);
        k++; c++;
      }
      // 段内点：折点 + 边内重采样（≤ 3 m）
      const pts = [];
      for (let q = 0; q < run.length; q++) {
        const kk = run[q];
        const a = V(kk), b = V(kk + 1);
        const Lk = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const m = Math.max(1, Math.ceil(Lk / 3));
        const tx = (b[0] - a[0]) / Lk, tz = (b[1] - a[1]) / Lk;
        for (let j = q === 0 ? 0 : 1; j <= m; j++) {
          const t = j / m;
          let nx = -tz, nz = tx, kb = 1;
          if (j === 0 || j === m) { const tg = tangentAt(j === 0 ? kk : kk + 1); nx = -tg[1]; nz = tg[0]; kb = tg[2]; }
          pts.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, nx, nz, kb, s: S[(kk % n)] + Lk * t, tx, tz });
        }
      }
      if (pts.length >= 2) emitRun(env, w, kind, ri, pts, inPark, out);
    }
  });
}

function emitRun(env, w, kind, ri, pts, inPark, out) {
  const { T, buf, inst, mk, idx } = env;
  const N = pts.length;
  const off = (p, d) => [p.x + p.nx * p.kb * d, p.z + p.nz * p.kb * d];
  const bad = (x, z, bits) => { const v = mk.get(x, z); return v > 0 && (v & bits) !== 0; };
  const park = inPark(pts[N >> 1].x + pts[N >> 1].nx * 2, pts[N >> 1].z + pts[N >> 1].nz * 2);
  const seed = Math.floor((w.cx || 0) * 13 + (w.cz || 0) * 7 + ri * 101);

  if (kind === 'lake' || kind === 'moat') {
    const wy = w.planeY;
    const lake = kind === 'lake';
    // 岸顶高度
    for (const p of pts) {
      if (lake) {
        const [gx, gz] = off(p, 1.6);
        p.g = T.heightAt(gx, gz);
        p.top = Math.max(p.g + 0.12, wy + 0.42);
      } else {
        const [gx, gz] = off(p, 0.8);
        p.g = T.heightAt(gx, gz);
        p.top = Math.max(p.g + 0.3, w.level + 1.2); // 与城墙模块护城河压顶同一公式
      }
    }
    // 台阶 / 平台位置（按环上弧长取模，跨块一致）
    const big = lake && ri === 0 && park && w.area >= 3000;
    const feats = [];
    if (big) {
      const ph = (seed % 97) * 1.1;
      for (let i = 1; i < N - 1; i++) {
        const p = pts[i], q = pts[i - 1];
        for (const [period, type] of [[110, 'stair'], [230, 'deck']]) {
          if (type === 'deck' && w.area < 25000) continue;
          const k1 = Math.floor((p.s + ph + (type === 'deck' ? 55 : 0)) / period), k0 = Math.floor((q.s + ph + (type === 'deck' ? 55 : 0)) / period);
          if (k1 === k0) continue;
          // 两侧 4 m 内岸线基本平直、背后不是路/楼
          const ok = pts.every((r) => Math.abs(r.s - p.s) > 4 || r.nx * p.nx + r.nz * p.nz > 0.94) && i > 1 && i < N - 2;
          const [bx, bz] = off(p, 2.5);
          if (!ok || bad(bx, bz, M_ROAD | M_BLD | M_EXCL)) continue;
          if (feats.some((f) => Math.abs(f.s - p.s) < 12)) continue;
          feats.push({ type, s: p.s, p, half: type === 'stair' ? 2.1 : 3.4 });
        }
      }
    }
    const inGap = (s) => feats.some((f) => Math.abs(s - f.s) < f.half);
    if (lake) {
      // 毛石立面 + 压顶（前脸、顶面、背面下垂）
      for (let i = 0; i + 1 < N; i++) {
        const a = pts[i], b = pts[i + 1];
        const yb = wy - 0.9;
        const n0 = [-(a.nx + b.nx) / 2, 0, -(a.nz + b.nz) / 2];
        buf.quadN([a.x, yb, a.z], [b.x, yb, b.z], [b.x, b.top - 0.14, b.z], [a.x, a.top - 0.14, a.z], n0, COL.wall, [[a.s, 0], [b.s, 0], [b.s, b.top - 0.14 - yb], [a.s, a.top - 0.14 - yb]], L.MASONRY);
      }
      const copeMat = big ? L.MARBLE : L.STONE, copeCol = big ? COL.copeMarble : COL.cope;
      const cp = pts.map((p) => ({ x: p.x, z: p.z }));
      // 压顶条：从 −0.06（出挑）到 +0.55
      copeStrip(buf, pts, -0.06, 0.55, (p) => p.top, (p) => p.top - 0.14, (p) => p.g - 0.3, copeMat, copeCol);
      void cp;
    }
    // 步道（公园内 2.2 m / 其他 0.9 m；护城河 2.2 m）
    const a0 = lake ? 0.55 : 0.7, aw = lake ? (park || w.area > 20000 ? 2.2 : 0.9) : 2.2;
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        apronStrip(buf, T, seg, a0, a0 + aw, park || !lake ? L.BRICK : L.STONE);
        const cl = seg.map((p) => { const [x, z] = off(p, a0 + aw * 0.5); return { x, z, nx: p.nx, nz: p.nz, s: p.s }; });
        const flat = cl.flatMap((q) => [q.x, q.z]);
        mk.stamp(flat, aw / 2 + 0.1, M_ROAD); // 步道是铺装：不长草、不放沿路小品
        out.paved.push({ p: flat, hw: aw / 2 + 0.1 });
        if (aw >= 2) out.walks.push({ pts: cl, kind, edge: a0 + aw, lake: w, park });
      }
      seg = [];
    };
    for (const p of pts) {
      const [x, z] = off(p, a0 + aw * 0.5);
      const v = mk.get(x, z);
      if (v > 0 && v & (M_ROAD | M_BLD | M_EXCL | M_WATER)) { flush(); continue; }
      seg.push(p);
    }
    flush();
    // 栏杆：湖（公园内较大的湖）用汉白玉，护城河用石栏杆（同一几何，颜色略灰）
    if (big || (kind === 'moat')) {
      const d = lake ? 0.22 : 0.35;
      railAlong(env, pts, d, lake ? 2.1 : 2.2, (p) => p.top, inGap, 'baluster', kind === 'moat' ? [0.86, 0.85, 0.82] : null, seed);
    }
    // 台阶与平台
    for (const f of feats) {
      if (f.type === 'stair') stairs(env, f.p, wy);
      else deck(env, f.p, wy);
      if (env.st) (env.st.feats || (env.st.feats = [])).push([f.type, Math.round(f.p.x), Math.round(f.p.z), +Math.atan2(-f.p.nx, -f.p.nz).toFixed(2)]);
    }
    // 警示牌（公园湖岸，每 ~160 m）
    if (lake && park && ri === 0 && w.area >= 3000) {
      for (let i = 1; i < N; i++) {
        const p = pts[i], q = pts[i - 1];
        if (Math.floor((p.s + seed) / 160) === Math.floor((q.s + seed) / 160)) continue;
        if (inGap(p.s)) continue;
        const [x, z] = off(p, a0 + aw + 0.35);
        if (bad(x, z, M_ROAD | M_BLD | M_WATER | M_EXCL)) continue;
        env.sign('danger', x, T.heightAt(x, z), z, Math.atan2(-p.nx, -p.nz));
      }
    }
  } else if (kind === 'river') {
    // 斜坡护岸：坡顶在岸线（陆侧地面高），坡脚在水下 0.5 m、向水面一侧 run 米
    for (const p of pts) {
      p.wy = w.surfaceY(p.x, p.z);
      const [gx, gz] = off(p, 2);
      p.g = T.heightAt(gx, gz);
      p.top = Math.max(p.g, p.wy + 0.9) + 0.03;
      let run = Math.max(1.5, Math.min(9, (p.top - (p.wy - 0.5)) * 1.8));
      // 窄河道：坡脚不能越过对岸
      for (let t = 0; t < 3 && !idx.waterAt(p.x - p.nx * run * 1.3, p.z - p.nz * run * 1.3); t++) run *= 0.6;
      p.run = run;
    }
    for (let i = 0; i + 1 < N; i++) {
      const a = pts[i], b = pts[i + 1];
      const A0 = [a.x, a.top, a.z], B0 = [b.x, b.top, b.z];
      const A1 = [a.x - a.nx * a.kb * a.run, a.wy - 0.5, a.z - a.nz * a.kb * a.run], B1 = [b.x - b.nx * b.kb * b.run, b.wy - 0.5, b.z - b.nz * b.kb * b.run];
      buf.quadN(A1, B1, B0, A0, [-(a.nx + b.nx) * 0.5, 1, -(a.nz + b.nz) * 0.5], COL.hex, [[a.s, 0], [b.s, 0], [b.s, Math.hypot(b.run, b.top - b.wy)], [a.s, Math.hypot(a.run, a.top - a.wy)]], L.HEX);
      // 坡顶压边石
      buf.quadN([a.x, a.top, a.z], [b.x, b.top, b.z], [b.x + b.nx * 0.3, b.top + 0.05, b.z + b.nz * 0.3], [a.x + a.nx * 0.3, a.top + 0.05, a.z + a.nz * 0.3], [0, 1, 0], COL.cope, [[a.s, 0], [b.s, 0], [b.s, 0.3], [a.s, 0.3]], L.STONE);
    }
    // 堤顶步道 + 护栏（遇路/楼/排除区断开）
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        apronStrip(buf, T, seg, 0.3, 3.3, L.CONCRETE, (p) => p.top + 0.05);
        const cl = seg.map((p) => { const [x, z] = off(p, 1.8); return { x, z, nx: p.nx, nz: p.nz, s: p.s }; });
        const flat = cl.flatMap((q) => [q.x, q.z]);
        mk.stamp(flat, 1.35, M_ROAD);
        out.paved.push({ p: flat, hw: 1.35 });
        out.walks.push({ pts: cl, kind, edge: 3.3, lake: w, park: inPark(seg[0].x + seg[0].nx * 2, seg[0].z + seg[0].nz * 2) });
        railAlong(env, seg, 0.15, 2.5, (p) => p.top + 0.05, () => false, 'rail', RAIL_STEEL, seed);
      }
      seg = [];
    };
    for (const p of pts) {
      const [x, z] = off(p, 1.8);
      if (bad(x, z, M_ROAD | M_BLD | M_EXCL)) { flush(); continue; }
      seg.push(p);
    }
    flush();
  }
}

/** 压顶：front 偏移 d0（负 = 向水面出挑）到 d1，顶面 top(p)，前脸底 frontBot(p)，背面下垂到 backBot(p) */
function copeStrip(buf, pts, d0, d1, top, frontBot, backBot, mat, col) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const P = (p, d, y) => [p.x + p.nx * p.kb * d, y, p.z + p.nz * p.kb * d];
    const nW = [-(a.nx + b.nx) / 2, 0, -(a.nz + b.nz) / 2];
    // 前脸
    buf.quadN(P(a, d0, frontBot(a)), P(b, d0, frontBot(b)), P(b, d0, top(b)), P(a, d0, top(a)), nW, col, [[a.s, 0], [b.s, 0], [b.s, 0.14], [a.s, 0.14]], mat);
    // 顶
    buf.quadN(P(a, d0, top(a)), P(b, d0, top(b)), P(b, d1, top(b)), P(a, d1, top(a)), [0, 1, 0], col, [[a.s, 0], [b.s, 0], [b.s, d1 - d0], [a.s, d1 - d0]], mat);
    // 背面（朝陆地，下垂盖住岸边地形）
    buf.quadN(P(a, d1, backBot(a)), P(b, d1, backBot(b)), P(b, d1, top(b)), P(a, d1, top(a)), [-nW[0], 0, -nW[2]], col, [[a.s, 0], [b.s, 0], [b.s, top(b) - backBot(b)], [a.s, top(a) - backBot(a)]], mat);
  }
}

/** 岸边步道：偏移 d0..d1，顶面贴地 + 5 cm（或 yFn），外沿护脚下垂 0.45 m */
function apronStrip(buf, T, pts, d0, d1, mat, yFn = null) {
  const P = (p, d) => [p.x + p.nx * p.kb * d, p.z + p.nz * p.kb * d];
  const Y = (p, x, z) => (yFn ? Math.max(yFn(p), T.heightAt(x, z) + 0.05) : T.heightAt(x, z) + 0.05);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const [ax0, az0] = P(a, d0), [bx0, bz0] = P(b, d0), [ax1, az1] = P(a, d1), [bx1, bz1] = P(b, d1);
    const ya0 = Y(a, ax0, az0), yb0 = Y(b, bx0, bz0), ya1 = Y(a, ax1, az1), yb1 = Y(b, bx1, bz1);
    buf.quadN([ax0, ya0, az0], [bx0, yb0, bz0], [bx1, yb1, bz1], [ax1, ya1, az1], [0, 1, 0], COL.apron, [[a.s, d0], [b.s, d0], [b.s, d1], [a.s, d1]], mat);
    buf.quadN([ax1, ya1 - 0.45, az1], [bx1, yb1 - 0.45, bz1], [bx1, yb1, bz1], [ax1, ya1, az1], [a.nx, 0, a.nz], COL.skirt, [[a.s, 0], [b.s, 0], [b.s, 0.45], [a.s, 0.45]], L.STONE);
  }
}

/** 沿岸栏杆：偏移 d，柱距 step（按弧长对齐，跨块一致），gap(s) 为真处断开 */
function railAlong(env, pts, d, step, yFn, gap, type, rgb, seed) {
  const { inst } = env;
  const posts = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const k0 = Math.ceil((a.s + 0.001) / step), k1 = Math.floor(b.s / step);
    for (let k = k0; k <= k1; k++) {
      const s = k * step;
      if (gap(s)) { posts.push(null); continue; }
      const t = (s - a.s) / (b.s - a.s || 1);
      const nx = a.nx * a.kb + (b.nx * b.kb - a.nx * a.kb) * t, nz = a.nz * a.kb + (b.nz * b.kb - a.nz * a.kb) * t;
      posts.push({ x: a.x + (b.x - a.x) * t + nx * d, z: a.z + (b.z - a.z) * t + nz * d, y: yFn(a) + (yFn(b) - yFn(a)) * t, s });
    }
  }
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    if (!p) continue;
    const q = posts[i + 1];
    if (type === 'baluster') {
      inst.add('bpost', p.x, p.y, p.z, 0, 1, 1, 1, rgb);
      if (q) {
        const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz);
        if (l > 0.3 && l < 4) {
          const yaw = Math.atan2(-dz, dx);
          const ux = dx / l, uz = dz / l;
          inst.add('bpanel', p.x + ux * 0.1, Math.min(p.y, q.y), p.z + uz * 0.1, yaw, l - 0.2, 1, 1, rgb);
        }
      }
    } else if (q) {
      const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz);
      if (l > 0.3 && l < 5) inst.add('rail', p.x, Math.min(p.y, q.y), p.z, Math.atan2(-dz, dx), l, 1, 1, rgb);
    }
  }
  void seed;
}

/** 亲水台阶：宽 4 m，从压顶下一级起逐级伸入水面 */
function stairs(env, p, wy) {
  const { buf } = env;
  const rise = 0.16;
  const cnt = Math.max(2, Math.min(9, Math.round((p.top - wy) / rise)));
  const r = (p.top - (wy + 0.03)) / cnt;
  const yaw = Math.atan2(-p.nz, p.nx); // 局部 X 沿法线？——用 box 的局部 Z = −n（伸向水面）
  void yaw;
  const tx = -p.nz, tz = p.nx; // 切向（陆地在左 → 切向 = (−nz, nx)… 与段方向一致）
  for (let j = 0; j < cnt; j++) {
    const depth = (j + 1) * 0.36;
    const y1 = p.top - (j + 1) * r;
    const cx = p.x - p.nx * depth / 2, cz = p.z - p.nz * depth / 2;
    // box：局部 X = 切向，局部 Z = 法线方向
    const yawB = Math.atan2(-tz, tx);
    buf.box(cx, wy - 0.9, cz, yawB, 4.0, y1 - (wy - 0.9), depth, COL.cope, L.STONE);
  }
}

/** 亲水木平台：6.5 m × 3 m，面高水面 + 0.38 m，木桩 + 三面木扶手 */
function deck(env, p, wy) {
  const { buf, inst } = env;
  const W = 6.5, D = 3.0, y = wy + 0.38;
  const tx = -p.nz, tz = p.nx;
  const yawB = Math.atan2(-tz, tx);
  const cx = p.x - p.nx * D / 2, cz = p.z - p.nz * D / 2;
  buf.box(cx, y - 0.16, cz, yawB, W, 0.16, D + 0.4, COL.wood, L.WOOD);
  // 桩
  for (const u of [-W / 2 + 0.3, 0, W / 2 - 0.3])
    for (const v of [0.6, D - 0.2]) buf.box(p.x + tx * u - p.nx * v, wy - 1.2, p.z + tz * u - p.nz * v, yawB, 0.22, 1.2 + 0.22, 0.22, COL.post, L.CONCRETE);
  // 下到平台的一级台阶（压顶 → 平台）
  if (p.top - y > 0.2) buf.box(p.x + p.nx * 0.2, y, p.z + p.nz * 0.2, yawB, 2.2, Math.max(0.05, (p.top - y) * 0.5), 0.4, COL.wood, L.WOOD);
  // 三面扶手
  const c0 = [p.x + tx * (-W / 2) - p.nx * 0.2, p.z + tz * (-W / 2) - p.nz * 0.2];
  const c1 = [p.x + tx * (-W / 2) - p.nx * (D + 0.1), p.z + tz * (-W / 2) - p.nz * (D + 0.1)];
  const c2 = [p.x + tx * (W / 2) - p.nx * (D + 0.1), p.z + tz * (W / 2) - p.nz * (D + 0.1)];
  const c3 = [p.x + tx * (W / 2) - p.nx * 0.2, p.z + tz * (W / 2) - p.nz * 0.2];
  for (const [a, b] of [[c0, c1], [c1, c2], [c2, c3]]) {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    const k = Math.max(1, Math.round(l / 2));
    for (let j = 0; j < k; j++) inst.add('rail', a[0] + (dx * j) / k, y, a[1] + (dz * j) / k, Math.atan2(-dz, dx), l / k, 1, 1, RAIL_WOOD);
  }
  inst.add('rail', c3[0], y, c3[1], 0, 0.01, 1, 1, RAIL_WOOD); // 末端立柱
}

export { strip };
