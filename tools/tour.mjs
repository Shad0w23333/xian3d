#!/usr/bin/env node
// 全城巡检截图：只加载一次页面，按机位清单依次移动相机、等待就绪后截图（比 shot.mjs 每张重载快 3~5 倍）。
// 用法：node tools/tour.mjs --list tools/tour_spots.json --out shots/tour [--w 1280 --h 720] [--q 2] [--only id1,id2] [--extra "skip=a"]
// 机位清单：[{ "id": "bell_street", "ll": [lon, lat, 离地高, 目标lon, 目标lat, 目标离地高], "time": 15, "note": "说明" }, ...]
//   或 { "id": "...", "view": "2", "time": 20.8 }（预设视角）
// 输出：<out>/<id>.png 与 <out>/manifest.json（每张的 fps/calls/三角形/新增控制台错误）
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const listFile = path.resolve(root, get('--list', 'tools/tour_spots.json'));
const outDir = path.resolve(root, get('--out', 'shots/tour'));
const W = +get('--w', 1280), H = +get('--h', 720), Q = +get('--q', 2);
const only = get('--only', '') ? new Set(get('--only', '').split(',')) : null;
const extra = get('--extra', '');
let spots = JSON.parse(fs.readFileSync(listFile, 'utf8'));
if (only) spots = spots.filter((s) => only.has(s.id));
fs.mkdirSync(outDir, { recursive: true });

const mac = process.platform === 'darwin' && !process.env.SWIFTSHADER;
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } }); // 不热更新、不监听：拍摄中改代码不会重载页面
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({
  headless: true,
  args: mac
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300));
});
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 300)));

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/?ui=0&labels=0&mini=0&online=0&shot=1&q=${Q}&view=1&time=15${extra ? '&' + extra : ''}`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000, polling: 500 });
const fatal = await page.evaluate(() => window.xian.fatal);
if (fatal) {
  console.error('启动失败：', fatal);
  process.exit(1);
}
console.log(`加载 ${((Date.now() - t0) / 1000).toFixed(1)} s，模块错误：`, await page.evaluate(() => window.xian.errors));

const manifest = [];
for (const s of spots) {
  const before = logs.length;
  await page.evaluate((s) => {
    const x = window.xian;
    if (s.view) {
      x.goto(s.view);
      if (x.controls && x.controls.tween) x.controls.tween.dur = 0.01;
    } else {
      const [lon, lat, agl, tlon, tlat, tagl] = s.ll;
      const p = x.project(lon, lat), t = x.project(tlon, tlat);
      x.setView({ pos: [p.x, agl, p.z], target: [t.x, tagl, t.z], agl: true });
    }
    if (s.time != null) x.setHours(s.time);
  }, s);
  // 等待：至少 2.5 秒；影像队列清空且建筑近景小块稳定（最长 60 秒）
  await page.waitForTimeout(2500);
  const deadline = Date.now() + 60000;
  let stable = 0, last = '';
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const b = window.xian.ctx.modules.buildings;
      const bs = b && b.stats ? b.stats() : {};
      return { k: `${bs.hiShown}/${bs.hiCached}`, ok: window.xian.settled() && !(bs.hiLoading > 0) && !(bs.hiPending > 0) };
    });
    if (st.k === last && st.ok) stable++;
    else stable = 0;
    last = st.k;
    if (stable >= 3) break;
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const r = window.xian.renderer.info.render;
    return { fps: +window.xian.fps.toFixed(1), calls: r.calls, tris: +(r.triangles / 1e6).toFixed(2), cam: window.xian.camera.position.toArray().map((v) => +v.toFixed(1)), hours: +window.xian.sky.hours.toFixed(2) };
  });
  const file = path.join(outDir, `${s.id}.png`);
  await page.screenshot({ path: file });
  const row = { id: s.id, file: path.relative(root, file), note: s.note || '', ll: s.ll || null, view: s.view || null, time: s.time ?? null, ...info, logs: logs.slice(before).filter((l) => !/willReadFrequently|Failed to load resource/.test(l)).slice(0, 10) };
  manifest.push(row);
  console.log(`${s.id.padEnd(22)} fps ${String(info.fps).padStart(5)}  calls ${String(info.calls).padStart(5)}  tri ${String(info.tris).padStart(6)}M  ${row.logs.length ? '日志 ' + row.logs.length : ''}`);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`完成 ${manifest.length} 张，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)} s → ${path.relative(root, outDir)}/manifest.json`);
await browser.close();
await server.close();
