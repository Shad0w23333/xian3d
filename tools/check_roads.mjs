#!/usr/bin/env node
// 道路/桥梁几何诊断（全城统计 + 最严重样本，世界坐标：原点钟楼，X 东、Z 南、Y 高程）。
// 用法：node tools/check_roads.mjs [--roads public/data/roads.json] [--top 8] [--json out.json] [--rh src/core/roadheight.js]
//       node tools/check_roads.mjs --prof 3321,9180 [--raw]   # 打印指定要素的纵断面（路面高/地面高），--raw 另打印纵断面节点
// 修复前后对比：--roads data-src/roads.before_fix.json --rh <旧版 roadheight.js>
// 直接调用前端同一套高程规则（src/core/roadheight.js）与断面采样（src/arch/roads_mesh.js），
// 地形用 public/data/dem_*.png 按 terrain.js 的 rawHeightAt 同法采样（不含运行时各模块注册的平整区）。
// 检查项：
//   桥梁/高架纵断面：坡度 >5%、竖曲线折角（相邻 10 m 坡度差 >2%）、桥面起伏（桥上局部极值 >0.5 m）、
//                    桥-桥衔接处下沉、各要素在共享节点处的高程台阶、立交上下层净空 <4.5 m / 层序倒置
//   平面线形：重复顶点、急折角（非路口顶点偏角 >60°）、锯齿（相邻反向偏角 >30° 且段长 <20 m）、自交、
//             双幅路两条中心线交叉、路段端点未接上（距同层他线中心线 <1.5 m 却未共用节点）
//   地面道路：路面（按渲染断面线性插值）低于地形（被埋）、高出地形 >1 m（悬空，桥头路堤除外）、
//             沿线波浪（与 60 m 滑动平均的偏差 >0.5 m）；离桥 400 m 内的抬高算作引桥路堤，单独计里程
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { roads: 'public/data/roads.json', top: 8, json: null, rh: 'src/core/roadheight.js' };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--roads') opt.roads = args[++i];
  else if (args[i] === '--top') opt.top = +args[++i];
  else if (args[i] === '--json') opt.json = args[++i];
  else if (args[i] === '--rh') opt.rh = args[++i]; // 指定另一版高程规则（修复前后对比用）
}

const RH = await import(path.resolve(root, opt.rh));
const MESH = await import(path.join(root, 'src/arch/roads_mesh.js'));
const GEO = await import(path.join(root, 'src/core/geo.js'));

// ---------------- PNG（8 位 RGB/RGBA，非隔行）解码 ----------------
function decodePNG(buf) {
  let o = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    const d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, px: out };
}

// ---------------- 地形（与 terrain.js rawHeightAt 一致） ----------------
class DEM {
  constructor(hts, w, h, b) { Object.assign(this, { hts, w, h, b, sx: w / (b.x1 - b.x0), sz: h / (b.z1 - b.z0), mpp: (b.x1 - b.x0) / w }); }
  contains(x, z) { const b = this.b; return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1; }
  sample(x, z) {
    let fx = (x - this.b.x0) * this.sx - 0.5, fz = (z - this.b.z0) * this.sz - 0.5;
    const w = this.w, h = this.h;
    fx = Math.min(Math.max(fx, 0), w - 1.001); fz = Math.min(Math.max(fz, 0), h - 1.001);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * w + ix;
    const a = this.hts[i], b = this.hts[i + 1], c = this.hts[i + w], d = this.hts[i + w + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }
  edgeDist(x, z) { const b = this.b; return Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z); }
}
const meta = JSON.parse(fs.readFileSync(path.join(root, 'public/data/meta.json'), 'utf8'));
const dems = meta.dem.map((d) => {
  const img = decodePNG(fs.readFileSync(path.join(root, 'public/data', d.file)));
  const n = img.w * img.h, hts = new Float32Array(n);
  for (let i = 0; i < n; i++) hts[i] = img.px[i * img.bpp] * 256 + img.px[i * img.bpp + 1] + img.px[i * img.bpp + 2] / 256 - 32768;
  return new DEM(hts, img.w, img.h, d.bounds);
}).sort((a, b) => a.mpp - b.mpp);
const terrain = {
  rawHeightAt(x, z) {
    for (let i = 0; i < dems.length; i++) {
      const dem = dems[i];
      if (!dem.contains(x, z)) continue;
      const next = dems[i + 1];
      if (next) { const e = dem.edgeDist(x, z); if (e < 1500) { const t = e / 1500; return dem.sample(x, z) * t + next.sample(x, z) * (1 - t); } }
      return dem.sample(x, z);
    }
    return dems[dems.length - 1].sample(x, z);
  },
  heightAt(x, z) { return this.rawHeightAt(x, z); },
};

// ---------------- 数据 ----------------
const t0 = Date.now();
const roads = JSON.parse(fs.readFileSync(path.resolve(root, opt.roads), 'utf8'));
const feats = roads.features;
const prepStats = RH.prepareRoadProfiles ? RH.prepareRoadProfiles(roads, terrain) : null;
if (prepStats) console.log('纵断面预处理 ' + JSON.stringify(prepStats));
const tPrep = Date.now() - t0;
// 调试：--prof 1,2,3 打印这些要素的纵断面（里程、路面高、地面高、桥标志）
{
  const k = args.indexOf('--prof');
  if (k >= 0) {
    for (const id of args[k + 1].split(',').map(Number)) {
      const f = feats[id], ch = RH.chainage(f.p), tot = ch[ch.length - 1];
      const rows = [];
      for (let s = 0; s <= tot; s += Math.max(5, tot / 40)) {
        let i = 0;
        while (i < ch.length - 2 && ch[i + 1] < s) i++;
        const t = (s - ch[i]) / (ch[i + 1] - ch[i] || 1);
        const x = f.p[i * 2] + (f.p[i * 2 + 2] - f.p[i * 2]) * t, z = f.p[i * 2 + 1] + (f.p[i * 2 + 3] - f.p[i * 2 + 1]) * t;
        rows.push(`${s.toFixed(0)}:${RH.roadY(terrain, f, x, z, s, tot).toFixed(1)}/${terrain.heightAt(x, z).toFixed(1)}`);
      }
      console.log(`#${id} c${f.c} b${f.b} y${f.y} ${f.n} L=${tot.toFixed(0)} ` + rows.join(' '));
      if (f._rp && args.includes('--raw')) console.log('  节点', Array.from(f._rp.s).map((s, k) => s.toFixed(0) + ':' + f._rp.y[k].toFixed(1)).join(' '));
    }
    process.exit(0);
  }
}
const pa = GEO.project(108.84, 34.35), pb = GEO.project(109.06, 34.17);
const inCore = (x, z) => x > pa.x && x < pb.x && z > pa.z && z < pb.z;
const nodeKey = (x, z) => (Math.round(x * 10) + 700000) * 2000000 + (Math.round(z * 10) + 1000000);
const f1 = (v, d = 1) => Number(v).toFixed(d);
const where = (x, z) => `(${f1(x)}, ${f1(z)})`;

// 与 roads.js 相同的渲染范围判断（按要素中点近似）
const chains = feats.map((f) => (f.p && f.p.length >= 4 ? RH.chainage(f.p) : null));
function pointAt(f, ch, s) {
  const p = f.p, n = p.length / 2;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ch[m] <= s) lo = m; else hi = m; }
  const L = ch[hi] - ch[lo] || 1, t = Math.min(1, Math.max(0, (s - ch[lo]) / L));
  return [p[lo * 2] + (p[hi * 2] - p[lo * 2]) * t, p[lo * 2 + 1] + (p[hi * 2 + 1] - p[lo * 2 + 1]) * t];
}
const rendered = feats.map((f, i) => {
  const ch = chains[i];
  if (!ch || f.t) return 0;
  const tot = ch[ch.length - 1];
  const [mx, mz] = pointAt(f, ch, tot / 2);
  if (inCore(mx, mz)) return 2;
  const c = f.c, r2 = mx * mx + mz * mz;
  if (c >= 5 && c <= 7) return 0;
  if (c >= 12) return 0;
  return c <= 2 || c === 8 || c === 9 || c === 10 || (c === 3 && r2 < 17000 * 17000) ? 1 : 0;
});
const Y = (f, i, s) => {
  const ch = chains[i], tot = ch[ch.length - 1];
  const [x, z] = pointAt(f, ch, s);
  return RH.roadY(terrain, f, x, z, s, tot);
};

// 节点表（顶点 → 入射）
const nodeInc = new Map();
feats.forEach((f, i) => {
  if (!chains[i] || f.t) return;
  const n = f.p.length / 2;
  for (let k = 0; k < n; k++) {
    const key = nodeKey(f.p[k * 2], f.p[k * 2 + 1]);
    let a = nodeInc.get(key);
    if (!a) nodeInc.set(key, (a = []));
    a.push(i, k);
  }
});

const R = {}; // 统计：name -> {count, samples:[{v, msg}]}
let curCore = false; // 当前样本是否在核心区（按要素中点）
function hit(name, v, msg) {
  let r = R[name];
  if (!r) R[name] = r = { count: 0, core: 0, samples: [] };
  r.count++;
  if (curCore) { r.core++; msg = '[核心区] ' + msg; }
  r.samples.push({ v, msg });
  if (r.samples.length > 400) { r.samples.sort((a, b) => b.v - a.v); r.samples.length = 60; }
}
const fname = (f, i) => `#${i} ${roads.classes[f.c]}${f.n ? ' ' + f.n : ''}${f.b ? ' 桥y' + (f.y || 1) : ''}`;

// ================= 1. 桥梁纵断面 =================
const deckD = (f) => ((Number(f.w) || 0) >= 12 ? 1.9 : 1.5);
let bridgeKm = 0;
feats.forEach((f, i) => {
  if (!f.b || f.t || !chains[i] || !rendered[i]) return;
  curCore = rendered[i] === 2;
  const ch = chains[i], tot = ch[ch.length - 1];
  bridgeKm += tot / 1000;
  if (tot < 20) return;
  const st = 5, n = Math.max(2, Math.ceil(tot / st) + 1);
  const ys = new Float64Array(n), ss = new Float64Array(n);
  for (let k = 0; k < n; k++) { ss[k] = (tot * k) / (n - 1); ys[k] = Y(f, i, ss[k]); }
  const ds = ss[1] - ss[0];
  // 坡度（20 m 基线）
  const w = Math.max(1, Math.round(20 / ds));
  let gMax = 0, gAt = 0;
  for (let k = 0; k + w < n; k++) { const g = Math.abs(ys[k + w] - ys[k]) / (ss[k + w] - ss[k]); if (g > gMax) { gMax = g; gAt = ss[k] + 10; } }
  if (gMax > 0.05) { const [x, z] = pointAt(f, ch, gAt); hit('桥面坡度>5%', gMax * 100, `${fname(f, i)} 坡度 ${f1(gMax * 100)}% @ ${where(x, z)} s=${f1(gAt, 0)}/${f1(tot, 0)}`); }
  // 竖曲线折角：相邻 10 m 坡度差
  const w2 = Math.max(1, Math.round(10 / ds));
  let kMax = 0, kAt = 0;
  for (let k = w2; k + w2 < n; k++) {
    const g1 = (ys[k] - ys[k - w2]) / (ss[k] - ss[k - w2]), g2 = (ys[k + w2] - ys[k]) / (ss[k + w2] - ss[k]);
    const dk = Math.abs(g2 - g1);
    if (dk > kMax) { kMax = dk; kAt = ss[k]; }
  }
  if (kMax > 0.02) { const [x, z] = pointAt(f, ch, kAt); hit('竖曲线折角>2%', kMax * 100, `${fname(f, i)} 坡差 ${f1(kMax * 100)}% @ ${where(x, z)}`); }
  // 桥上起伏：内部局部极值（凹陷/驼峰），显著度 >0.5 m
  let bumps = 0, worst = 0, wAt = 0;
  const m = Math.max(1, Math.round(15 / ds));
  for (let k = m; k + m < n; k++) {
    const a = ys[k - m], b = ys[k], c = ys[k + m];
    const dip = Math.min(a, c) - b, hump = b - Math.max(a, c);
    const v = Math.max(dip, hump);
    if (v > 0.5 && ((b <= ys[k - 1] && b <= ys[k + 1]) || (b >= ys[k - 1] && b >= ys[k + 1]))) {
      // 桥两端 RAMP 的自然起坡不算；只算内部
      if (ss[k] > 40 && tot - ss[k] > 40) { bumps++; if (v > worst) { worst = v; wAt = ss[k]; } }
    }
  }
  if (bumps) { const [x, z] = pointAt(f, ch, wAt); hit('桥面起伏(凹陷/驼峰)', worst, `${fname(f, i)} ${bumps} 处，最大 ${f1(worst, 2)} m @ ${where(x, z)}`); }
});

// 共享节点：台阶 + 桥-桥衔接下沉
for (const [key, a] of nodeInc) {
  curCore = rendered[a[0]] === 2;
  if (a.length < 4) continue;
  let yMin = Infinity, yMax = -Infinity, nb = 0, x = 0, z = 0, any = false;
  for (let j = 0; j < a.length; j += 2) {
    const i = a[j], k = a[j + 1], f = feats[i];
    if (!rendered[i]) continue;
    any = true;
    const y = Y(f, i, chains[i][k]);
    x = f.p[k * 2]; z = f.p[k * 2 + 1];
    yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    if (f.b) nb++;
  }
  if (!any) continue;
  if (yMax - yMin > 0.3) hit('节点高程台阶>0.3m', yMax - yMin, `${where(x, z)} 台阶 ${f1(yMax - yMin, 2)} m（${a.length / 2} 条入射）`);
  // 桥-桥衔接：只由桥梁要素组成的节点，沿各入射方向 30 m 处的高程与节点比较
  if (nb * 2 === a.length && nb >= 2) {
    let yN = 0, ring = Infinity;
    for (let j = 0; j < a.length; j += 2) {
      const i = a[j], k = a[j + 1], f = feats[i], ch = chains[i], tot = ch[ch.length - 1];
      if (!rendered[i]) continue;
      yN = Y(f, i, ch[k]);
      for (const d of [-30, 30]) { const s = ch[k] + d; if (s >= 0 && s <= tot) ring = Math.min(ring, Y(f, i, s)); }
    }
    const dip = ring - yN;
    if (ring < Infinity && dip > 1) hit('桥-桥衔接下沉>1m', dip, `${where(x, z)} 下沉 ${f1(dip, 2)} m`);
  }
}

// ================= 2. 平面线形 =================
const CELL = 100;
const segGrid = new Map();
const gk = (cx, cz) => cx * 1000003 + cz;
feats.forEach((f, i) => {
  if (!chains[i]) return;
  const p = f.p;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const x0 = Math.min(p[k], p[k + 2]), x1 = Math.max(p[k], p[k + 2]), z0 = Math.min(p[k + 1], p[k + 3]), z1 = Math.max(p[k + 1], p[k + 3]);
    if ((x1 - x0) / CELL > 200 || (z1 - z0) / CELL > 200) continue;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        let arr = segGrid.get(gk(cx, cz));
        if (!arr) segGrid.set(gk(cx, cz), (arr = []));
        arr.push(i, k >> 1);
      }
  }
});
function segX(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return [t, u];
}
const deg = (i, k) => {
  const f = feats[i], a = nodeInc.get(nodeKey(f.p[k * 2], f.p[k * 2 + 1]));
  return a ? a.length / 2 : 1;
};
feats.forEach((f, i) => {
  if (!chains[i] || f.t || !rendered[i]) return;
  curCore = rendered[i] === 2;
  const p = f.p, n = p.length / 2;
  for (let k = 0; k + 1 < n; k++) {
    const L = Math.hypot(p[k * 2 + 2] - p[k * 2], p[k * 2 + 3] - p[k * 2 + 1]);
    if (L < 0.3) hit('重复顶点', 0.3 - L, `${fname(f, i)} @ ${where(p[k * 2], p[k * 2 + 1])} 间距 ${f1(L, 2)} m`);
  }
  let prevDef = 0, prevL = 0;
  for (let k = 1; k + 1 < n; k++) {
    const ax = p[k * 2] - p[k * 2 - 2], az = p[k * 2 + 1] - p[k * 2 - 1], bx = p[k * 2 + 2] - p[k * 2], bz = p[k * 2 + 3] - p[k * 2 + 1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 0.05 || lb < 0.05) continue;
    const d = Math.atan2(ax * bz - az * bx, ax * bx + az * bz) * 180 / Math.PI;
    const junction = deg(i, k) > 1;
    if (!junction && Math.abs(d) > 60) hit('急折角>60°(非路口)', Math.abs(d), `${fname(f, i)} 偏角 ${f1(Math.abs(d), 0)}° @ ${where(p[k * 2], p[k * 2 + 1])} 段长 ${f1(la, 1)}/${f1(lb, 1)}`);
    if (!junction && k > 1 && Math.abs(d) > 30 && Math.abs(prevDef) > 30 && Math.sign(d) !== Math.sign(prevDef) && la < 20 && Math.min(lb, prevL) < 20)
      hit('锯齿(反向折角)', Math.min(Math.abs(d), Math.abs(prevDef)), `${fname(f, i)} ${f1(prevDef, 0)}°/${f1(d, 0)}° @ ${where(p[k * 2], p[k * 2 + 1])}`);
    prevDef = d; prevL = la;
  }
});
// 自交 / 双幅路交叉 / 立交净空（统一在网格内两两求交）
const seenPair = new Set();
function sharedNear(i, j, x, z) {
  const pj = feats[j].p, B = new Set();
  for (let k = 0; k < pj.length; k += 2) B.add(nodeKey(pj[k], pj[k + 1]));
  const pi = feats[i].p;
  for (let k = 0; k < pi.length; k += 2) if (B.has(nodeKey(pi[k], pi[k + 1])) && Math.hypot(pi[k] - x, pi[k + 1] - z) < 60) return true;
  return false;
}
for (const [, arr] of segGrid) {
  for (let a = 0; a < arr.length; a += 2)
    for (let b = a + 2; b < arr.length; b += 2) {
      const i = arr[a], ka = arr[a + 1], j = arr[b], kb = arr[b + 1];
      if (i === j && Math.abs(ka - kb) < 2) continue;
      const fi = feats[i], fj = feats[j];
      if (fi.t || fj.t || !rendered[i] || !rendered[j]) continue;
      const pi = fi.p, pj = fj.p;
      const r = segX(pi[ka * 2], pi[ka * 2 + 1], pi[ka * 2 + 2], pi[ka * 2 + 3], pj[kb * 2], pj[kb * 2 + 1], pj[kb * 2 + 2], pj[kb * 2 + 3]);
      if (!r) continue;
      const pk = i < j ? `${i}:${ka}:${j}:${kb}` : `${j}:${kb}:${i}:${ka}`;
      if (seenPair.has(pk)) continue;
      seenPair.add(pk);
      const x = pi[ka * 2] + (pi[ka * 2 + 2] - pi[ka * 2]) * r[0], z = pi[ka * 2 + 1] + (pi[ka * 2 + 3] - pi[ka * 2 + 1]) * r[0];
      curCore = inCore(x, z);
      if (i === j) { hit('自交', 1, `${fname(fi, i)} @ ${where(x, z)}`); continue; }
      const si = chains[i][ka] + (chains[i][ka + 1] - chains[i][ka]) * r[0], sj = chains[j][kb] + (chains[j][kb + 1] - chains[j][kb]) * r[1];
      // 双幅路：同名单行主路，几乎平行（<30°）却相互穿越
      const dxi = pi[ka * 2 + 2] - pi[ka * 2], dzi = pi[ka * 2 + 3] - pi[ka * 2 + 1], dxj = pj[kb * 2 + 2] - pj[kb * 2], dzj = pj[kb * 2 + 3] - pj[kb * 2 + 1];
      const cos = (dxi * dxj + dzi * dzj) / (Math.hypot(dxi, dzi) * Math.hypot(dxj, dzj) || 1);
      if (fi.o && fj.o && fi.n && fi.n === fj.n && cos < -0.866 && !fi.b === !fj.b && (fi.y || 0) === (fj.y || 0))
        hit('双幅路中心线交叉', 1, `${fname(fi, i)} × #${j} @ ${where(x, z)}`);
      // 立交：至少一方为桥；两线在交叉点 60 m 内共用节点的属分合流区线形交错（与 roadheight 同一口径），不计
      if (!fi.b && !fj.b) continue;
      if (sharedNear(i, j, x, z)) continue;
      const yi = Y(fi, i, si), yj = Y(fj, j, sj);
      const li = fi.b ? fi.y || 1 : 0, lj = fj.b ? fj.y || 1 : 0;
      let up, lo, yu, yl;
      if (li !== lj) [up, lo, yu, yl] = li > lj ? [i, j, yi, yj] : [j, i, yj, yi];
      else [up, lo, yu, yl] = yi >= yj ? [i, j, yi, yj] : [j, i, yj, yi];
      // 同一桥系统上的相接/并行匝道（高差本就很小）不按上下层算：同层且高差 <1 m 视为平交（数据里桥上合流）
      if (li === lj && Math.abs(yi - yj) < 1) continue;
      const clr = yu - deckD(feats[up]) - yl;
      if (yu < yl - 0.1) hit('立交层序倒置', yl - yu, `上层 ${fname(feats[up], up)} 低于 ${fname(feats[lo], lo)} ${f1(yl - yu, 2)} m @ ${where(x, z)}`);
      else if (clr < 4.5) hit('立交净空<4.5m', 4.5 - clr, `${fname(feats[up], up)} / ${fname(feats[lo], lo)} 净空 ${f1(clr, 2)} m @ ${where(x, z)} (Y ${f1(yu, 1)}/${f1(yl, 1)})`);
    }
}
// 端点缝隙
feats.forEach((f, i) => {
  if (!chains[i] || f.t || !rendered[i]) return;
  curCore = rendered[i] === 2;
  const p = f.p, n = p.length / 2;
  for (const k of [0, n - 1]) {
    const x = p[k * 2], z = p[k * 2 + 1];
    if (deg(i, k) > 1) continue;
    let best = Infinity, bj = -1;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const arr = segGrid.get(gk(cx + a, cz + b));
        if (!arr) continue;
        for (let q = 0; q < arr.length; q += 2) {
          const j = arr[q], kk = arr[q + 1];
          if (j === i || feats[j].t || (feats[j].y || 0) !== (f.y || 0)) continue;
          const pj = feats[j].p;
          const ax = pj[kk * 2], az = pj[kk * 2 + 1], bx = pj[kk * 2 + 2], bz = pj[kk * 2 + 3];
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
          // 端点距他线中心线 1.5 m 内却未共用节点
          if (d > 0.05 && d < 1.5 && d < best) { best = d; bj = j; }
        }
      }
    if (bj >= 0) hit('端点缝隙(未接上)', best, `${fname(f, i)} 端点 ${where(x, z)} 距 #${bj} ${f1(best, 2)} m`);
  }
});

// ================= 3. 地面道路 =================
// 渲染断面：新规则与纵断面节点对齐（profileStepFn），旧规则为核心区 36 m / 远郊 75 m
const stepOf = (core, isBridge, tot, f) => (RH.profileStepFn && f._rp ? RH.profileStepFn(f, core ? 36 : 75) : () => (core ? 36 : 75));
let groundKm = 0, buriedKm = 0, floatKm = 0, wavyKm = 0, embankKm = 0;
// 桥梁顶点网格：离桥 400 m 内的地面路抬高视为引桥路堤（新规则下的预期结果），单独统计
const bGrid = new Set();
feats.forEach((f, i) => {
  if (!f.b || f.t || !chains[i]) return;
  for (let k = 0; k < f.p.length; k += 2) bGrid.add(Math.floor(f.p[k] / 200) * 100003 + Math.floor(f.p[k + 1] / 200));
});
const nearBridge = (x, z) => {
  const cx = Math.floor(x / 200), cz = Math.floor(z / 200);
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) if (bGrid.has((cx + a) * 100003 + cz + b)) return true;
  return false;
};
feats.forEach((f, i) => {
  if (!chains[i] || f.t || f.b || !rendered[i]) return;
  curCore = rendered[i] === 2;
  const ch = chains[i], tot = ch[ch.length - 1];
  if (tot < 5) return;
  const core = rendered[i] === 2;
  const secs = MESH.sampleSections(f.p, ch, 0, tot, stepOf(core, false, tot, f), null);
  if (!secs) return;
  const sy = new Float64Array(secs.n);
  for (let k = 0; k < secs.n; k++) sy[k] = RH.roadY(terrain, f, secs.x[k], secs.z[k], secs.s[k], tot);
  groundKm += tot / 1000;
  const st = 4;
  let k = 0, bur = 0, flo = 0, dMax = 0, dAt = 0, fMax = 0, fAt = 0;
  const prof = [];
  for (let s = 0; s <= tot; s += st) {
    while (k < secs.n - 2 && secs.s[k + 1] < s) k++;
    const t = (s - secs.s[k]) / (secs.s[k + 1] - secs.s[k] || 1);
    const ym = sy[k] + (sy[k + 1] - sy[k]) * Math.min(1, Math.max(0, t));
    const [x, z] = pointAt(f, ch, s);
    const g = terrain.heightAt(x, z);
    const d = ym - g;
    prof.push(ym);
    if (d < -0.02) { bur += st; if (-d > dMax) { dMax = -d; dAt = s; } }
    if (d > 1.0) {
      if (nearBridge(x, z)) embankKm += st / 1000;
      else { flo += st; if (d > fMax) { fMax = d; fAt = s; } }
    }
  }
  buriedKm += bur / 1000;
  floatKm += flo / 1000;
  if (bur > 10) { const [x, z] = pointAt(f, ch, dAt); hit('地面路被埋(低于地形)', dMax, `${fname(f, i)} 被埋 ${f1(bur, 0)} m，最深 ${f1(dMax, 2)} m @ ${where(x, z)}`); }
  if (flo > 10) { const [x, z] = pointAt(f, ch, fAt); hit('地面路悬空>1m(远离桥梁)', fMax, `${fname(f, i)} 悬空 ${f1(flo, 0)} m，最高 ${f1(fMax, 2)} m @ ${where(x, z)}`); }
  // 波浪：与 60 m 滑动平均的偏差
  const h = Math.round(30 / st);
  if (prof.length > 2 * h + 2) {
    let wv = 0, wMax = 0, wAt = 0;
    for (let q = h; q + h < prof.length; q++) {
      let sum = 0;
      for (let r = q - h; r <= q + h; r++) sum += prof[r];
      const dev = Math.abs(prof[q] - sum / (2 * h + 1));
      if (dev > 0.5) { wv += st; if (dev > wMax) { wMax = dev; wAt = q * st; } }
    }
    wavyKm += wv / 1000;
    if (wv > 20) { const [x, z] = pointAt(f, ch, wAt); hit('地面路波浪>0.5m', wMax, `${fname(f, i)} 波浪段 ${f1(wv, 0)} m，最大偏差 ${f1(wMax, 2)} m @ ${where(x, z)}`); }
  }
});

// ================= 输出 =================
const order = ['桥面坡度>5%', '竖曲线折角>2%', '桥面起伏(凹陷/驼峰)', '桥-桥衔接下沉>1m', '节点高程台阶>0.3m', '立交净空<4.5m', '立交层序倒置',
  '重复顶点', '急折角>60°(非路口)', '锯齿(反向折角)', '自交', '双幅路中心线交叉', '端点缝隙(未接上)', '地面路被埋(低于地形)', '地面路悬空>1m(远离桥梁)', '地面路波浪>0.5m'];
console.log(`# 道路诊断 ${opt.roads}  要素 ${feats.length}，渲染桥梁 ${f1(bridgeKm)} km，地面路 ${f1(groundKm)} km；` +
  `被埋 ${f1(buriedKm, 2)} km，悬空 ${f1(floatKm, 2)} km（另有桥梁 400 m 内抬高 >1 m ${f1(embankKm, 2)} km），波浪 ${f1(wavyKm, 2)} km；剖面预处理 ${tPrep} ms，总耗时 ${Date.now() - t0} ms`);
const summary = {};
for (const k of order) {
  const r = R[k] || { count: 0, samples: [] };
  summary[k] = r.count;
  summary[k + '·核心区'] = r.core || 0;
  console.log(`\n## ${k}: ${r.count}（核心区 ${r.core || 0}）`);
  r.samples.sort((a, b) => b.v - a.v);
  for (const s of r.samples.slice(0, opt.top)) console.log('  - ' + s.msg);
}
summary._km = { bridge: +f1(bridgeKm, 2), ground: +f1(groundKm, 2), buried: +f1(buriedKm, 3), float: +f1(floatKm, 3), embank: +f1(embankKm, 3), wavy: +f1(wavyKm, 3) };
console.log('\nSUMMARY ' + JSON.stringify(summary));
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ summary, samples: Object.fromEntries(order.map((k) => [k, (R[k]?.samples || []).slice(0, 40)])) }, null, 1));
