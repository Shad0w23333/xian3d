#!/usr/bin/env node
// 公园园桥全城普查（无浏览器）：跑 water（水位重定）与各片区模块的 prepare（登记排除区），用前端同一套
// ParkIndex + bridgeSpans（src/arch/park-layout.js）判定每条园路的跨水段，与旧规则（任一点落在任一水面里就整条当桥）对比，
// 列出旧规则误判的“园桥”（贴池边、压在喷泉水池/广场水景上、精建场地里）与新规则保留的园桥。
// 用法：node tools/check_park_bridges.mjs [--json out.json] [--list 30]
import fs from 'node:fs';
import { buildModules } from './arch_env.mjs';

const args = process.argv.slice(2);
const opt = { json: null, list: 30 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') opt.json = args[++i];
  else if (args[i] === '--list') opt.list = +args[++i];
}
const IDS = ['weiyang', 'water', 'dossier', 'citywall', 'belltower', 'pagoda', 'datang', 'qujiang', 'heritage', 'heritage26', 'mixc', 'skyline', 'huimin', 'sunken', 'airports'];
const t0 = Date.now();
const { ctx } = await buildModules(IDS, { build: false });
const { ParkIndex } = await import('../src/arch/park-index.js');
const { bridgeSpans } = await import('../src/arch/park-layout.js');
const { resamplePts } = await import('../src/arch/park-geom.js');
const parks = JSON.parse(fs.readFileSync(new URL('../public/data/parks.json', import.meta.url), 'utf8'));
// 水体登记（与 water 模块 build 的 ctx.waterBodies 同口径：水位取重定结果，planeY 近似为水位 + 0.15）
const lv = ctx.waterLevels || new Map();
const bodies = [];
for (const src of ctx.data.water?.polys || []) {
  if (!src.outer || src.outer.length < 6) continue;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < src.outer.length; i += 2) {
    x0 = Math.min(x0, src.outer[i]); x1 = Math.max(x1, src.outer[i]); z0 = Math.min(z0, src.outer[i + 1]); z1 = Math.max(z1, src.outer[i + 1]);
  }
  if (x1 - x0 > 26000 || z1 - z0 > 26000) continue;
  const v = lv.get(src);
  const h = v ? v.L : Number(src.h) || ctx.terrain.heightAt((x0 + x1) / 2, (z0 + z1) / 2);
  bodies.push({ n: src.n || '', k: src.k, outer: src.outer, holes: src.holes || [], bb: { x0, x1, z0, z1 }, area: 0, level: h, planeY: h + 0.15, lvKind: v ? v.kind : null, src, surfaceY: () => h + 0.15 });
}
ctx.waterBodies = bodies;
const idx = new ParkIndex(ctx, parks);
console.error(`[bridges] 准备 ${((Date.now() - t0) / 1000).toFixed(1)} s；园路 ${idx.lines.length}（自画 ${idx.stats.own}），水体 ${bodies.length}（重定水位 ${bodies.filter((b) => b.lvKind).length}）`);

const oldOnly = [], kept = [];
let oldN = 0, newN = 0, siteDrop = 0;
for (const L of idx.lines) {
  const pts = resamplePts(L.p, 2.5);
  if (pts.length < 2) continue;
  const n = pts.length;
  const site = new Uint8Array(n);
  let ns = 0;
  let np = 0;
  for (let i = 0; i < n; i++) if ((site[i] = idx.siteAt(pts[i].x, pts[i].z))) { ns++; if (site[i] === 3) np++; }
  if (L.own && np === n) siteDrop++;
  // 旧规则
  let oldWet = null;
  for (let i = 0; i < n; i++) { const w = idx.waterAt(pts[i].x, pts[i].z); if (w) { oldWet = { w, x: pts[i].x, z: pts[i].z }; break; } }
  const oldBr = !!L.b || !!oldWet;
  const { any } = bridgeSpans(idx, pts, L, site);
  const newBr = any || (!!L.b && site.some((v) => v < 2));
  if (oldBr) oldN++;
  if (newBr) newN++;
  const rec = { own: L.own, k: L.kind, w: L.w, osmBridge: !!L.b, x: Math.round(pts[n >> 1].x), z: Math.round(pts[n >> 1].z), water: oldWet ? `${oldWet.w.n || oldWet.w.k}${oldWet.w.lvKind ? '' : '(未重定)'}` : '', at: oldWet ? [Math.round(oldWet.x), Math.round(oldWet.z)] : null, site: ns };
  if (oldBr && !newBr) oldOnly.push(rec);
  else if (newBr) kept.push(rec);
}
console.log(`旧规则园桥 ${oldN} 条 → 新规则 ${newN} 条；去掉 ${oldOnly.length} 条（其中精建场地内 ${oldOnly.filter((r) => r.site).length}、压在未重定水位的水池/水景上 ${oldOnly.filter((r) => /未重定/.test(r.water)).length}）；精建场地内整条不画的园路 ${siteDrop} 条`);
console.log(`\n去掉的（前 ${opt.list}）：`);
for (const r of oldOnly.slice(0, opt.list)) console.log(`  ${r.own ? 'OSM园路' : 'roads园路'} ${r.k} w${r.w} 水上点(${r.at})  水体 ${r.water}${r.site ? '  精建场地' : ''}`);
console.log(`\n保留的园桥（前 ${opt.list}）：`);
for (const r of kept.slice(0, opt.list)) console.log(`  ${r.own ? 'OSM园路' : 'roads园路'} ${r.k} w${r.w}${r.osmBridge ? ' OSM桥' : ''} 中点(${r.x},${r.z}) 水体 ${r.water}`);
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ oldN, newN, removed: oldOnly, kept }, null, 1));
