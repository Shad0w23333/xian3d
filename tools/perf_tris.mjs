#!/usr/bin/env node
// 三角形归属巡检：加载完整场景，逐个预设视角统计“每个模块画了多少三角形 / 多少 draw call”，
// 分主相机通道与阴影通道（阴影贴图渲染不走 object.onBeforeRender，所以这里包住 renderer.renderBufferDirect 统计）。
// 用法：node tools/perf_tris.mjs [--q 2] [--w 1280 --h 720] [--views 1,2,3,4,5,6,7,8,9,0] [--night] [--out docs/x.json]
//       [--skip a,b] [--modules a,b]（透传给页面）
// 输出：每个视角一行 JSON（模块 → {tris, calls, shTris, shCalls}），最后打印 Markdown 表。
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const q = +get('--q', 2), W = +get('--w', 1280), H = +get('--h', 720);
const views = get('--views', '1,2,3,4,5,6,7,8,9,0').split(',');
const night = a.includes('--night');
const outFile = get('--out', '');
const extra = (get('--skip', '') ? `&skip=${get('--skip', '')}` : '') + (get('--modules', '') ? `&modules=${get('--modules', '')}` : '');
const mac = process.platform === 'darwin' && !process.env.SWIFTSHADER;

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const exe = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({
  ...(exe && !mac ? { executablePath: exe } : {}),
  headless: true,
  args: mac
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync']
    : ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/?ui=0&labels=0&mini=0&online=0&q=${q}&view=${views[0]}${night ? '&time=21' : '&time=15'}${extra}`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000 });
console.log(`加载 ${((Date.now() - t0) / 1000).toFixed(1)} s；模块错误：`, await page.evaluate(() => window.xian.errors));
// 安装统计钩子（页面因 Vite 热重载而刷新时会重新安装，见 ensureReady）
const installHook = () => page.evaluate(() => {
  const x = window.xian;
  const r = x.renderer;
  const scene = x.scene || x.ctx.scene;
  const modOf = (o) => {
    let p = o;
    while (p && p.parent && p.parent !== scene) p = p.parent;
    if (!p) return '?';
    return p.userData?.module || p.name || p.type || '?';
  };
  const acc = {};
  const orig = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = function (camera, sc, geometry, material, object, group) {
    const t0 = r.info.render.triangles, c0 = r.info.render.calls;
    orig(camera, sc, geometry, material, object, group);
    if (!x.__tally) return;
    const dt = r.info.render.triangles - t0, dc = r.info.render.calls - c0;
    const m = modOf(object);
    const sh = camera !== x.camera;
    const e = acc[m] || (acc[m] = { tris: 0, calls: 0, shTris: 0, shCalls: 0, objs: new Set(), byObj: {} });
    if (sh) (e.shTris += dt), (e.shCalls += dc);
    else (e.tris += dt), (e.calls += dc), e.objs.add(object.name || object.type);
    const on = (object.name || object.type).replace(/\d+$/, '#');
    const bo = e.byObj[on] || (e.byObj[on] = { tris: 0, shTris: 0, calls: 0 });
    if (sh) bo.shTris += dt;
    else (bo.tris += dt), (bo.calls += dc);
  };
  x.__acc = acc;
  x.__tally = false;
  x.__reset = () => { for (const k in acc) delete acc[k]; };
});
await installHook();
// 开发服务器热重载会刷新页面（改了源码时）：等它重新就绪并重装钩子
const ensureReady = async () => {
  const ok = await page.evaluate(() => !!(window.xian && window.xian.ready && window.xian.__acc)).catch(() => false);
  if (ok) return;
  console.log('（页面已刷新，等待重新就绪…）');
  await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000 });
  await installHook();
};
const rows = [];
for (let vi = 0; vi < views.length; vi++) {
  const v = views[vi];
  await ensureReady();
  const jumped = await page.evaluate(({ v, night }) => {
    const x = window.xian;
    x.goto(v);
    x.controls && x.controls.tween && (x.controls.tween.dur = 0.01);
    if (night) x.setHours(21);
    return true;
  }, { v, night }).catch(() => false);
  if (!jumped) {
    // 页面正在刷新（开发服务器热重载）：等就绪后重来
    await page.waitForTimeout(2000);
    vi--;
    continue;
  }
  const deadline = Date.now() + 180000;
  let stable = 0, last = '', reloaded = false;
  await page.waitForTimeout(3000);
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const b = window.xian.ctx.modules.buildings;
      const st = b && b.stats ? b.stats() : {};
      return { k: `${st.hiShown}/${st.hiCached}`, ok: window.xian.settled() && !(st.hiLoading > 0) && !(st.hiPending > 0) };
    }).catch(() => null);
    if (!s) {
      reloaded = true; // 页面刷新过：本视角重来
      break;
    }
    if (s.k === last && s.ok) stable++;
    else stable = 0;
    last = s.k;
    if (stable >= 4) break;
    await page.waitForTimeout(1000);
  }
  if (reloaded) {
    await ensureReady();
    vi--;
    continue;
  }
  const r = await page.evaluate(() => new Promise((res) => {
    const x = window.xian;
    x.__reset();
    let n = 0;
    const f = () => {
      n++;
      if (n === 2) x.__tally = true; // 统计第 2~4 帧（3 帧平均）
      if (n === 5) {
        x.__tally = false;
        const out = {};
        for (const k in x.__acc) {
          const e = x.__acc[k];
          const top = Object.entries(e.byObj).map(([n, b]) => [n, Math.round(b.tris / 3), Math.round(b.shTris / 3), Math.round(b.calls / 3)]).sort((p, q2) => q2[1] + q2[2] - p[1] - p[2]).slice(0, 10);
          out[k] = { tris: Math.round(e.tris / 3), calls: Math.round(e.calls / 3), shTris: Math.round(e.shTris / 3), shCalls: Math.round(e.shCalls / 3), objs: e.objs.size, top };
        }
        const info = x.renderer.info.render;
        res({ total: info.triangles, calls: info.calls, mods: out });
      } else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }));
  rows.push({ view: v, ...r });
  const top = Object.entries(r.mods).sort((p, q2) => q2[1].tris + q2[1].shTris - p[1].tris - p[1].shTris).slice(0, 8)
    .map(([k, e]) => `${k} ${((e.tris + e.shTris) / 1e6).toFixed(2)}M(主${(e.tris / 1e6).toFixed(2)}+影${(e.shTris / 1e6).toFixed(2)}, ${e.calls + e.shCalls}dc)`).join('；');
  console.log(`view ${v}: 总 ${(r.total / 1e6).toFixed(2)}M 三角形 ${r.calls} dc —— ${top}`);
  if (a.includes('--objects')) {
    // 每个模块内三角形最多的对象（主 / 影，k 三角形）
    for (const [k, e] of Object.entries(r.mods).sort((p, q2) => q2[1].tris + q2[1].shTris - p[1].tris - p[1].shTris).slice(0, 10)) {
      if (e.tris + e.shTris < 50000) continue;
      console.log(`    ${k}: ` + e.top.map(([n, t, s, c]) => `${n} ${(t / 1000).toFixed(0)}k${s > 1000 ? '+影' + (s / 1000).toFixed(0) + 'k' : ''}(${c}dc)`).join('; '));
    }
  }
}
await browser.close();
await server.close();
// Markdown 表：行 = 模块，列 = 视角（总三角形，含阴影）
const mods = new Set();
for (const r of rows) for (const k in r.mods) mods.add(k);
const order = [...mods].sort((p, q2) => rows.reduce((s, r) => s + ((r.mods[q2]?.tris || 0) + (r.mods[q2]?.shTris || 0)), 0) - rows.reduce((s, r) => s + ((r.mods[p]?.tris || 0) + (r.mods[p]?.shTris || 0)), 0));
const fmt = (n) => (n >= 1e5 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n));
let md = `| 模块 | ${rows.map((r) => 'view=' + r.view).join(' | ')} |\n|---|${rows.map(() => '---:').join('|')}|\n`;
for (const m of order) md += `| ${m} | ${rows.map((r) => { const e = r.mods[m]; return e ? `${fmt(e.tris + e.shTris)}` + (e.shTris > 1e4 ? ` (影 ${fmt(e.shTris)})` : '') : '-'; }).join(' | ')} |\n`;
md += `| **合计（renderer.info）** | ${rows.map((r) => `**${fmt(r.total)}** / ${r.calls} dc`).join(' | ')} |\n`;
console.log('\n' + md);
if (outFile) fs.writeFileSync(path.resolve(root, outFile), JSON.stringify({ q, W, H, night, rows, md }, null, 1));
console.log('页面错误：', errors.slice(0, 5));
