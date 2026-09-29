#!/usr/bin/env node
// 全城建筑穿模/重叠诊断 —— 无浏览器版（与 tools/check_overlap.mjs 同一份 dump 格式，交给 tools/check_overlap.py 分析）。
// 做法：tools/arch_env.mjs 在 Node 里跑各模块 prepare（排除区、平整区、挖洞），只 build 会影响诊断数据的 dossier / skyline / sunken，
// 通用建筑的让位与底高用前端同一函数（src/arch/bld-skip.js 的 preprocess）。比启动 Chromium（SwiftShader）快一个数量级，
// 适合修改前后反复对比；最终结果仍建议用 check_overlap.mjs 在真实页面里复核一次。
// 用法：node tools/check_overlap_node.mjs [--out 目录] [--top 20]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

globalThis.__XIAN_DIAG = 1; // 让排除区记下注册模块
const { buildModules } = await import('./arch_env.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { out: path.join(ROOT, 'shots', 'overlap_node'), top: 20 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opt.out = path.resolve(args[++i]);
  else if (args[i] === '--top') opt.top = +args[++i];
}
fs.mkdirSync(opt.out, { recursive: true });

// 与页面默认加载一致（去掉不影响建筑/排除区的模块）；buildings 由下面的 preprocess 代替
const IDS = ['water', 'landuse', 'roads', 'dossier', 'citywall', 'belltower', 'pagoda', 'datang', 'qujiang', 'heritage', 'heritage26', 'mixc', 'skyline', 'huimin', 'sunken', 'airports'];
const BUILD = new Set(['dossier', 'skyline', 'sunken', 'datang']);
const t0 = Date.now();
const { ctx, mods } = await buildModules(IDS, { build: false });
const warn = console.warn;
console.warn = () => {};
for (const m of mods) {
  ctx.modules[m.id] = {};
  if (!BUILD.has(m.id)) continue;
  try {
    ctx.modules[m.id] = (await m.build(ctx)) || {};
  } catch (e) {
    console.error('[check] build 失败', m.id, e.message);
  }
}
console.warn = warn;
console.error(`[check] 模块 prepare/build ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const { parseBuildings } = await import('../src/arch/bld-gen.js');
const { preprocess } = await import('../src/arch/bld-skip.js');
const T = ctx.terrain;
const r1 = (v) => Math.round(v * 10) / 10;
const samp = (pts) => {
  let lo = Infinity, hi = -Infinity;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[j * 2], bz = pts[j * 2 + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
    for (let s = 0; s < k; s++) {
      const h = T.heightAt(ax + ((bx - ax) * s) / k, az + ((bz - az) * s) / k);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return [r1(lo), r1(hi)];
};
const out = { modules: [...IDS, 'buildings'], errors: [] };
{
  const P = parseBuildings(ctx.data.buildings);
  const B = preprocess(ctx, P);
  const N = P.count;
  const tmin = new Float32Array(N), tmax = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (B.skip[i]) continue;
    const pts = [];
    for (let k = P.vertStart[i] * 2, e = k + P.vertCount[i] * 2; k < e; k += 2) pts.push(P.anchorX[i] + P.offs[k] * 0.1, P.anchorZ[i] + P.offs[k + 1] * 0.1);
    const [a, b] = samp(pts);
    tmin[i] = a;
    tmax[i] = b;
  }
  out.bld = { n: N, skip: Array.from(B.skip), base: Array.from(B.base, r1), ga: Array.from(B.ga, r1), tmin: Array.from(tmin), tmax: Array.from(tmax) };
}
const S = ctx.modules.skyline?.diag;
out.sky = S ? S().map((s) => ({ ...s, pts: s.pts.map(r1), base: r1(s.base), t: samp(s.pts) })) : [];
const Dz = ctx.modules.dossier?.diag;
out.dossier = Dz ? Dz().map((p) => ({ ...p, pts: Array.from(p.pts, r1), bot: r1(p.bot), top: r1(p.top), t: samp(p.pts) })) : null;
const Sk = ctx.modules.sunken?.diag;
out.sunken = Sk ? Sk() : null;
out.datang = ctx.modules.datang?.diag ? ctx.modules.datang.diag() : null;
out.excl = ctx.exclusions.items.map((it) => ({ owner: it.owner || '', name: it.name, flags: it.flags, p: Array.from(it.p, r1) }));
const dumpPath = path.join(opt.out, 'dump.json');
fs.writeFileSync(dumpPath, JSON.stringify(out));
console.error(`[check] 已导出 ${dumpPath}（${(fs.statSync(dumpPath).size / 1e6).toFixed(1)} MB）`);
const py = process.env.PYTHON || (fs.existsSync(path.join(ROOT, '.venv-tools/bin/python')) ? path.join(ROOT, '.venv-tools/bin/python') : 'python3');
const r = spawnSync(py, [path.join(ROOT, 'tools', 'check_overlap.py'), dumpPath, '--out', path.join(opt.out, 'report.json'), '--top', String(opt.top)], { stdio: 'inherit', cwd: ROOT });
process.exit(r.status ?? 1);
