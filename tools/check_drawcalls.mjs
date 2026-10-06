#!/usr/bin/env node
// 逐模块 draw call / 三角形诊断（差分法）：对给定机位，分别只加载某个模块（modules=X）或跳过某个模块（skip=X），
// 与基线（modules=none / 全场景）相减得到每个模块的开销，输出 Markdown 表格。
// 用法：
//   node tools/check_drawcalls.mjs                       # 10 个预设视角（view=1..0），白天 time=15，isolate 法
//   node tools/check_drawcalls.mjs --views 6 --time 20.8
//   node tools/check_drawcalls.mjs --ll 108.98745,34.19616,150,108.98445,34.19836,30 --time 14.5   # 自定义机位（同 shot.mjs）
//   node tools/check_drawcalls.mjs --cam x,离地高,z,tx,目标离地高,tz
//   node tools/check_drawcalls.mjs --modules qujiang,datang --method skip --out docs/PERF_DRAWCALLS.md --json /tmp/dc.json
// 参数：--views 视角键列表（默认 1,2,3,4,5,6,7,8,9,0）；--time 小时；--q 画质 0..3（默认 2）；--w/--h 分辨率（默认 1280×720）
//      --modules 只统计这些模块（默认注册表里全部非 dev 模块）；--method isolate（默认，快：modules=X − modules=none）
//      或 skip（慢但更准：全场景 − skip=X，包含模块间让位/排除区的相互影响）；--frames 每个机位采样帧数（默认 12，取中位数）
//      --wait 每个机位最长等待秒数（默认 60）；--out 写 Markdown；--json 写原始数据
// 说明：统计的 calls 是 renderer.info.render.calls（含阴影贴图通道与后期全屏通道），与 shot.mjs 口径一致；一律 online=0。
//      isolate 法下通用建筑/植被不会给未加载的地标让位，数值会略高于全场景里的真实开销；“全场景”和“各模块之和”两行可对照残差。
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../src/modules/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const opt = {
  views: get('--views', '1,2,3,4,5,6,7,8,9,0').split(',').filter(Boolean),
  ll: get('--ll', ''), cam: get('--cam', ''),
  time: +get('--time', 15), q: +get('--q', 2), w: +get('--w', 1280), h: +get('--h', 720),
  modules: get('--modules', '') ? get('--modules', '').split(',').filter(Boolean) : MODULES.filter((m) => !m.dev).map((m) => m.id),
  method: get('--method', 'isolate'), frames: +get('--frames', 12), wait: +get('--wait', 60),
  out: get('--out', ''), json: get('--json', ''),
};
// 机位列表：预设键 或 一个自定义机位
const spots = opt.ll ? [{ key: 'll', name: '自定义 ll=' + opt.ll, ll: opt.ll.split(',').map(Number) }]
  : opt.cam ? [{ key: 'cam', name: '自定义 cam=' + opt.cam, cam: opt.cam.split(',').map(Number) }]
  : opt.views.map((k) => ({ key: k, name: '' }));

const mac = process.platform === 'darwin' && !process.env.SWIFTSHADER;
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const exe = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({
  ...(exe && !mac ? { executablePath: exe } : {}),
  headless: true,
  args: mac ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

/** 加载一次页面（modulesParam：'none' / 'a,b' / null=全部；skipParam），依次切到各机位并采样 */
async function measure(modulesParam, skipParam) {
  const q = new URLSearchParams({ ui: '0', mini: '0', labels: '0', online: '0', q: String(opt.q), time: String(opt.time) });
  if (modulesParam != null) q.set('modules', modulesParam);
  if (skipParam) q.set('skip', skipParam);
  const s0 = spots[0];
  if (s0.ll) q.set('ll', s0.ll.join(',')); else if (s0.cam) q.set('cam', s0.cam.join(',')); else q.set('view', s0.key);
  const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?${q.toString()}`);
  await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000, polling: 250 });
  const fatal = await page.evaluate(() => window.xian.fatal);
  if (fatal) { await page.close(); throw new Error('页面致命错误：' + fatal); }
  const modErrors = await page.evaluate(() => window.xian.errors);
  const rows = [];
  for (const sp of spots) {
    // 切机位（瞬移），时间重设（有些预设自带时刻）
    const name = await page.evaluate(async ({ sp, time }) => {
      const x = window.xian;
      let v = null, nm = sp.name;
      if (sp.ll) { const p = x.project(sp.ll[0], sp.ll[1]), t = x.project(sp.ll[3], sp.ll[4]); v = { pos: [p.x, sp.ll[2], p.z], target: [t.x, sp.ll[5] || 0, t.z], agl: true }; }
      else if (sp.cam) v = { pos: [sp.cam[0], sp.cam[1], sp.cam[2]], target: [sp.cam[3], sp.cam[4], sp.cam[5]], agl: true };
      else {
        const cfg = await import('/src/core/config.js');
        v = [...cfg.PRESETS, ...cfg.PRESETS_EXTRA].find((p) => p.key === sp.key);
        nm = v ? v.name : sp.key;
      }
      if (v) x.setView(v);
      x.setHours(time);
      return nm;
    }, { sp, time: opt.time });
    // 等待：≥ 30 帧、影像队列清空、通用建筑近景小块稳定 1 s（最长 opt.wait 秒）
    const start = await page.evaluate(() => window.xian.frame);
    const deadline = Date.now() + opt.wait * 1000;
    let settledSince = 0, lastHi = '';
    while (Date.now() < deadline) {
      const s = await page.evaluate(() => {
        const b = window.xian.ctx?.modules?.buildings;
        const st = b && b.stats ? b.stats() : null;
        return { f: window.xian.frame, ok: window.xian.settled(), hi: st ? `${st.hiShown}/${st.hiCached}` : '', busy: st ? st.hiLoading > 0 || st.hiPending > 0 : false };
      });
      const stable = s.hi === lastHi && !s.busy;
      lastHi = s.hi;
      if (s.f - start >= 30 && s.ok && stable) {
        settledSince ||= Date.now();
        if (Date.now() - settledSince > 1000) break;
      } else settledSince = 0;
      await page.waitForTimeout(200);
    }
    // 采样 N 帧取中位数
    const sample = await page.evaluate(async (n) => {
      const x = window.xian, calls = [], tris = [];
      for (let i = 0; i < n; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        calls.push(x.renderer.info.render.calls);
        tris.push(x.renderer.info.render.triangles);
      }
      const med = (arr) => { const s = arr.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
      return { calls: med(calls), tris: med(tris), callsMin: Math.min(...calls), callsMax: Math.max(...calls) };
    }, opt.frames);
    rows.push({ key: sp.key, name, ...sample });
  }
  await page.close();
  return { rows, errors, modErrors, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

const log = (...s) => console.error(...s);
const result = { method: opt.method, time: opt.time, q: opt.q, size: `${opt.w}x${opt.h}`, spots: [], base: null, full: null, modules: {} };
try {
  log(`方法 ${opt.method}；机位 ${spots.map((s) => s.key).join(',')}；time=${opt.time} q=${opt.q}；模块 ${opt.modules.length} 个`);
  const full = await measure(null, null);
  result.full = full;
  result.spots = full.rows.map((r) => ({ key: r.key, name: r.name }));
  log(`全场景：${full.rows.map((r) => `${r.key}:${r.calls}`).join(' ')}（${full.seconds}s）`, full.modErrors.length ? '模块错误 ' + JSON.stringify(full.modErrors) : '');
  if (opt.method === 'isolate') {
    result.base = await measure('none', null);
    log(`基线 none：${result.base.rows.map((r) => `${r.key}:${r.calls}`).join(' ')}`);
  }
  for (const id of opt.modules) {
    const m = opt.method === 'isolate' ? await measure(id, null) : await measure(null, id);
    result.modules[id] = m;
    const parts = m.rows.map((r, i) => {
      const ref = opt.method === 'isolate' ? result.base.rows[i] : full.rows[i];
      const d = opt.method === 'isolate' ? r.calls - ref.calls : ref.calls - r.calls;
      return `${r.key}:${d}`;
    });
    log(`${id.padEnd(12)} ${parts.join(' ')}（${m.seconds}s）`, m.modErrors.length ? '模块错误 ' + JSON.stringify(m.modErrors) : '');
  }
} finally {
  await browser.close();
  await server.close();
}

// ─── 汇总为 Markdown ───
const keys = result.spots;
const callsOf = (id, i) => {
  const m = result.modules[id];
  if (!m) return null;
  return opt.method === 'isolate' ? { calls: m.rows[i].calls - result.base.rows[i].calls, tris: m.rows[i].tris - result.base.rows[i].tris }
    : { calls: result.full.rows[i].calls - m.rows[i].calls, tris: result.full.rows[i].tris - m.rows[i].tris };
};
const lines = [];
lines.push(`方法 ${opt.method}，time=${opt.time}，q=${opt.q}，${opt.w}×${opt.h}，online=0；calls 含阴影通道与后期通道。`);
lines.push('');
lines.push('### draw call（每模块的增量）');
lines.push('');
lines.push('| 模块 | ' + keys.map((k) => `${k.key} ${k.name}`).join(' | ') + ' | 最大 |');
lines.push('|---|' + keys.map(() => '---:').join('|') + '|---:|');
if (result.base) lines.push('| （基线 none：地形+天空+后期） | ' + result.base.rows.map((r) => r.calls).join(' | ') + ' | |');
const over = [];
const order = opt.modules.slice().sort((p, q) => Math.max(...keys.map((_, i) => callsOf(q, i)?.calls ?? 0)) - Math.max(...keys.map((_, i) => callsOf(p, i)?.calls ?? 0)));
for (const id of order) {
  const vals = keys.map((_, i) => callsOf(id, i)?.calls ?? 0);
  const mx = Math.max(...vals);
  lines.push(`| ${id} | ${vals.join(' | ')} | ${mx > 150 ? `**${mx}**` : mx} |`);
  vals.forEach((v, i) => { if (v > 150) over.push({ id, view: keys[i], calls: v, tris: callsOf(id, i).tris }); });
}
lines.push('| **全场景** | ' + result.full.rows.map((r) => `**${r.calls}**`).join(' | ') + ' | |');
if (result.base) {
  const sums = keys.map((_, i) => result.base.rows[i].calls + opt.modules.reduce((s, id) => s + (callsOf(id, i)?.calls ?? 0), 0));
  lines.push('| 各模块之和 + 基线（与全场景之差 = 模块间让位/排除区的相互影响） | ' + sums.join(' | ') + ' | |');
}
lines.push('');
lines.push('### 三角形（千，每模块的增量）');
lines.push('');
lines.push('| 模块 | ' + keys.map((k) => `${k.key}`).join(' | ') + ' |');
lines.push('|---|' + keys.map(() => '---:').join('|') + '|');
if (result.base) lines.push('| （基线 none） | ' + result.base.rows.map((r) => Math.round(r.tris / 1000)).join(' | ') + ' |');
for (const id of order) lines.push(`| ${id} | ${keys.map((_, i) => Math.round((callsOf(id, i)?.tris ?? 0) / 1000)).join(' | ')} |`);
lines.push('| **全场景** | ' + result.full.rows.map((r) => `**${Math.round(r.tris / 1000)}**`).join(' | ') + ' |');
lines.push('');
lines.push('### 任一机位 draw call > 150 的模块');
lines.push('');
if (!over.length) lines.push('无。');
for (const o of over.sort((p, q) => q.calls - p.calls)) lines.push(`- ${o.id}：机位 ${o.view.key} ${o.view.name} ${o.calls} 次（三角形 ${Math.round(o.tris / 1000)}k）`);
const allErr = [...new Set([...result.full.modErrors, ...Object.values(result.modules).flatMap((m) => m.modErrors)])];
if (allErr.length) { lines.push(''); lines.push('模块错误：' + allErr.join('；')); }
const md = lines.join('\n');
console.log(md);
if (opt.out) { fs.mkdirSync(path.dirname(path.resolve(root, opt.out)), { recursive: true }); fs.writeFileSync(path.resolve(root, opt.out), md + '\n'); log('已写入', opt.out); }
if (opt.json) { fs.writeFileSync(path.resolve(root, opt.json), JSON.stringify(result, null, 1)); log('已写入', opt.json); }
