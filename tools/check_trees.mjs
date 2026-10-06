#!/usr/bin/env node
// 树木穿楼诊断（无浏览器）：在 Node 里跑各片区模块的 prepare（登记排除区），再用前端同一套种植算法（src/arch/vegPlant.js）
// 生成全城树木，统计树干落在建筑轮廓内、树冠（按树种冠幅 × 个体缩放）插进建筑外墙的棵数。
// 建筑：通用建筑（buildings.bin；让位口径同前端 bld-skip.preprocess）+ 逐栋档案建筑落地体块（ctx.superseded.polys）。
// 用法：node tools/check_trees.mjs [--veg 另一版 vegPlant.js（修复前后对比）] [--json out.json] [--top 10]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildModules } from './arch_env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { veg: path.join(ROOT, 'src/arch/vegPlant.js'), json: null, top: 10 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--veg') opt.veg = path.resolve(args[++i]);
  else if (args[i] === '--json') opt.json = args[++i];
  else if (args[i] === '--top') opt.top = +args[++i];
}
// 登记树木排除区的模块（与 src/modules/index.js 顺序一致；不含需要浏览器 Worker 的模块）
const IDS = ['dossier', 'citywall', 'belltower', 'pagoda', 'datang', 'qujiang', 'heritage', 'heritage26', 'mixc', 'skyline', 'huimin', 'sunken', 'airports'];
const t0 = Date.now();
const { ctx } = await buildModules(IDS, { build: false });
console.error(`[trees] prepare ${((Date.now() - t0) / 1000).toFixed(1)} s，排除区 ${ctx.exclusions.items.length}`);

// vegetation.js 的 localExclusions（该模块依赖 Vite Worker 导入，Node 里不能直接 import，这里照抄）
const rect = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];
const circle = (cx, cz, r) => Array.from({ length: 24 }, (_, i) => [cx + Math.cos((i / 24) * Math.PI * 2) * r, cz + Math.sin((i / 24) * Math.PI * 2) * r]).flat();
const local = [rect(1535, 4960, 1615, 7010), rect(1512, 4085, 1632, 4462), circle(1572, 4850, 55), circle(1572, 4590, 42), circle(0, 0, 70)];
const lm = ctx.data.landmarks || {};
const buf = ctx.data.buildings;
const msg = {
  roads: ctx.data.roads, landuse: ctx.data.landuse, water: ctx.data.water, rail: ctx.data.rail, buildings: buf.slice(0),
  exclusions: [...ctx.exclusions.items.filter((it) => it.flags?.trees).map((it) => ({ p: Array.from(it.p) })), ...local.map((p) => ({ p }))],
  wall: lm.wall || [], mamian: lm.mamian || [], gates: lm.gates || [],
};
const { plantVegetation } = await import(pathToFileURL(opt.veg).href);
const t1 = Date.now();
const V = plantVegetation(msg);
console.error(`[trees] 种植 ${V.n} 棵（${((Date.now() - t1) / 1000).toFixed(1)} s）` + (V.stats.shrunk != null ? `，近楼收冠 ${V.stats.shrunk}` : ''));

// —— 建筑轮廓 ——
// 通用建筑是否让位与前端同一口径：src/arch/bld-skip.js 的 preprocess（排除区锚点/轮廓比例、skyline 高楼、地标名称）
const polys = [];
{
  const { parseBuildings } = await import('../src/arch/bld-gen.js');
  const { preprocess } = await import('../src/arch/bld-skip.js');
  const P = parseBuildings(buf);
  for (const id of IDS) ctx.modules[id] ||= {}; // skyline 等模块须为真值，对应的让位规则才生效
  const B = preprocess(ctx, P);
  for (let i = 0; i < P.count; i++) {
    if (B.skip[i] || P.minHeightDm[i] > 450) continue; // 已让位 / 悬空的 building:part
    const p = [];
    for (let k = P.vertStart[i] * 2, e = k + P.vertCount[i] * 2; k < e; k += 2) p.push(P.anchorX[i] + P.offs[k] * 0.1, P.anchorZ[i] + P.offs[k + 1] * 0.1);
    if (p.length >= 6) polys.push({ p, src: 'gen', id: i });
  }
}
for (const [k, p] of (ctx.superseded?.polys || []).entries()) polys.push({ p: Array.from(p), src: 'dossier', id: ctx.superseded.by[k] });
const CELL = 40;
const grid = new Map();
for (const [k, b] of polys.entries()) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < b.p.length; i += 2) { x0 = Math.min(x0, b.p[i]); x1 = Math.max(x1, b.p[i]); z0 = Math.min(z0, b.p[i + 1]); z1 = Math.max(z1, b.p[i + 1]); }
  b.bb = [x0, z0, x1, z1];
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
      const key = cx * 100003 + cz;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(k);
    }
}
function sdist(x, z, p) {
  let inside = false, best = Infinity;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xj - xi, dz = zj - zi, l2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - xi) * dx + (z - zi) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(xi + dx * t - x, zi + dz * t - z));
  }
  return inside ? -best : best;
}
// 树冠水平半径（缩放 1 时，与 src/arch/vegSpecies.js 的 crownR 一致）
const CROWN_R = [4.3, 7.2, 4.6, 4.8, 3.1, 1.9, 0.85];
const NAMES = ['国槐', '法桐', '雪松', '垂柳', '银杏', '石榴', '灌木'];
const res = { trees: V.n, trunkIn: 0, crown1: 0, crown2: 0, bySp: {}, bySrc: {}, worst: [] };
const worst = [];
for (let i = 0; i < V.n; i++) {
  const x = V.x[i], z = V.z[i], sp = V.sp[i];
  const Rc = CROWN_R[sp] * (V.sc[i] / 127.5);
  let dmin = Infinity, who = null;
  const seen = new Set();
  for (let cx = Math.floor((x - Rc) / CELL); cx <= Math.floor((x + Rc) / CELL); cx++)
    for (let cz = Math.floor((z - Rc) / CELL); cz <= Math.floor((z + Rc) / CELL); cz++) {
      for (const k of grid.get(cx * 100003 + cz) || []) {
        if (seen.has(k)) continue;
        seen.add(k);
        const b = polys[k];
        if (x < b.bb[0] - Rc || x > b.bb[2] + Rc || z < b.bb[1] - Rc || z > b.bb[3] + Rc) continue;
        const d = sdist(x, z, b.p);
        if (d < dmin) { dmin = d; who = b; }
      }
    }
  if (!who) continue;
  const intr = Rc - dmin;
  if (dmin < 0) res.trunkIn++;
  if (intr > 1) {
    res.crown1++;
    res.bySp[NAMES[sp]] = (res.bySp[NAMES[sp]] || 0) + 1;
    res.bySrc[who.src] = (res.bySrc[who.src] || 0) + 1;
  }
  if (intr > 2) res.crown2++;
  if (intr > 2) worst.push({ intr: +intr.toFixed(1), sp: NAMES[sp], x: +x.toFixed(1), z: +z.toFixed(1), b: who.src + ':' + who.id });
}
worst.sort((a, b) => b.intr - a.intr);
res.worst = worst.slice(0, opt.top);
console.log(`树木 ${res.trees}：树干在楼内 ${res.trunkIn}；树冠插进外墙 > 1 m ${res.crown1}（> 2 m ${res.crown2}）`);
console.log('  按树种：' + JSON.stringify(res.bySp) + '  按建筑来源：' + JSON.stringify(res.bySrc));
for (const w of res.worst) console.log('   ', JSON.stringify(w));
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(res, null, 1));
