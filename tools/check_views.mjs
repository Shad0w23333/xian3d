#!/usr/bin/env node
// 预设视角 / 机位批量体检：只加载一次页面，依次切到 10 个预设 + 5 个扩展视角（或 --list 给的机位），等待就绪后截图，
// 并报告：相机是否落在实体内（建筑/城墙/城楼等，见 core/occluders.js）、是否被推出、当前显示的标注数；
// 另可测画质切换卡顿（--quality 0,1,3,2：每次切换记录最长帧间隔）。
// 用法：
//   node tools/check_views.mjs [--out shots/views] [--w 1280 --h 720] [--q 2] [--time 15] [--labels] [--ui]
//                              [--only 1,5,!3] [--list spots.json] [--quality 0,1,3,2] [--extra "bldclass=1"]
//   spots.json：[{ "id": "east", "ll": [lon, lat, 离地高, 目标lon, 目标lat, 目标离地高], "time": 15 }, { "id": "v4", "view": "4" }]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const outDir = path.resolve(root, get('--out', 'shots/views'));
const W = +get('--w', 1280), H = +get('--h', 720), Q = get('--q', '2'), TIME = get('--time', '15');
const only = get('--only', '') ? new Set(get('--only', '').split(',')) : null;
const qSeq = get('--quality', '') ? get('--quality', '').split(',').map(Number) : null;
fs.mkdirSync(outDir, { recursive: true });

let spots;
if (a.includes('--list')) spots = JSON.parse(fs.readFileSync(path.resolve(get('--list')), 'utf8'));
else {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '!1', '!2', '!3', '!4', '!5'];
  spots = keys.map((k) => ({ id: 'view' + k.replace('!', 'x'), view: k }));
}
if (only) spots = spots.filter((s) => only.has(s.id) || only.has(s.view));

// 独立的依赖预构建缓存目录：多个工作树共用 node_modules 时避免互相覆盖 .vite 缓存
const cacheDir = process.env.VITE_CACHE || path.join(os.tmpdir(), 'xian3d-vite-' + Buffer.from(root).toString('base64url').slice(-24));
const server = await createServer({ root, logLevel: 'error', cacheDir, server: { port: 0, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } }); // 不热更新、不监听：拍摄中改代码不会重载页面
await server.listen();
const port = server.httpServer.address().port;
const mac = process.platform === 'darwin' && !process.env.SWIFTSHADER;
const browser = await chromium.launch({
  headless: true,
  args: mac ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 300)));

const q = new URLSearchParams({ online: '0', q: Q, time: TIME, view: '1', mini: '0' });
q.set('ui', a.includes('--ui') ? '1' : '0');
q.set('labels', a.includes('--labels') ? '1' : '0');
if (!a.includes('--ui')) q.set('shot', '1');
// --extra "bldclass=1&skip=a"：附加 URL 参数
for (const [k, v] of new URLSearchParams(get('--extra', ''))) q.set(k, v);
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/?${q}`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000, polling: 500 });
const fatal = await page.evaluate(() => window.xian.fatal);
if (fatal) { console.error('启动失败：', fatal); process.exit(1); }
console.log(`加载 ${((Date.now() - t0) / 1000).toFixed(1)} s，模块错误：`, await page.evaluate(() => window.xian.errors));
// 遮挡体全部栅格化完成
await page.waitForFunction(() => !window.xian.occluders || window.xian.occluders.queue.length === 0, null, { timeout: 120000, polling: 500 });

const settle = async () => {
  await page.waitForTimeout(2000);
  const deadline = Date.now() + 45000;
  let stable = 0, last = '';
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const b = window.xian.ctx.modules.buildings;
      const bs = b && b.stats ? b.stats() : {};
      return { k: `${bs.hiShown}/${bs.hiCached}`, ok: window.xian.settled() && !(bs.hiLoading > 0) && !(bs.hiPending > 0) && !window.xian.controls.tween };
    });
    if (st.k === last && st.ok) stable++;
    else stable = 0;
    last = st.k;
    if (stable >= 3) break;
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(500);
};

const rows = [];
for (const s of spots) {
  const before = logs.length;
  const want = await page.evaluate((s) => {
    const x = window.xian;
    const defTime = s.defTime;
    const T = x.terrain;
    let p;
    if (s.view) {
      const v = x.presets.find((q) => q.key === s.view);
      p = x.resolveView(v).p;
      x.goto(s.view);
      const tw = x.controls.tween;
      if (tw) tw.dur = 0.05;
    } else {
      const [lon, lat, agl, tlon, tlat, tagl] = s.ll;
      const pp = x.project(lon, lat), tt = x.project(tlon, tlat);
      x.setView({ pos: [pp.x, agl, pp.z], target: [tt.x, tagl, tt.z], agl: true });
      p = x.camera.position.clone();
      p.set(pp.x, T.heightAt(pp.x, pp.z) + agl, pp.z);
    }
    // 时刻：机位自带 time 优先；预设自带 hours（如不夜城夜景）时保持；否则回到 --time
    const pv = s.view ? x.presets.find((q) => q.key === s.view) : null;
    if (s.time != null) x.setHours(s.time);
    else if (!(pv && pv.hours != null)) x.setHours(+defTime);
    return { x: p.x, y: p.y, z: p.z };
  }, { ...s, defTime: TIME });
  await settle();
  const info = await page.evaluate((want) => {
    const x = window.xian;
    const c = x.camera.position;
    const r = x.renderer.info.render;
    const ls = x.labelSpace;
    return {
      fps: +x.fps.toFixed(0), calls: r.calls, tris: +(r.triangles / 1e6).toFixed(2),
      agl: +(c.y - x.terrain.heightAt(c.x, c.z)).toFixed(1),
      inside: x.controls.blocked(c.x, c.y, c.z),
      pushed: +Math.hypot(c.x - want.x, c.y - want.y, c.z - want.z).toFixed(1),
      labels: ls ? ls.count : 0,
    };
  }, want);
  const file = path.join(outDir, `${s.id}.png`);
  await page.screenshot({ path: file });
  const row = { ...s, file: path.relative(root, file), ...info, logs: logs.slice(before).filter((l) => !/willReadFrequently|Failed to load resource/.test(l)).slice(0, 6) };
  rows.push(row);
  console.log(`${s.id.padEnd(16)} 离地 ${String(info.agl).padStart(6)} m  ${info.inside ? '【在实体内】' : '            '} 推出 ${String(info.pushed).padStart(5)} m  标注 ${String(info.labels).padStart(3)}  fps ${info.fps}  calls ${info.calls}  ${row.logs.length ? '日志 ' + row.logs.length : ''}`);
}

if (qSeq) {
  console.log('—— 画质切换卡顿 ——');
  for (const lv of qSeq) {
    const r = await page.evaluate(async (lv) => {
      const x = window.xian;
      const gaps = [];
      let last = performance.now(), run = true;
      const loop = () => { const n = performance.now(); gaps.push(n - last); last = n; if (run) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      const t0 = performance.now();
      if (document.querySelector(`.q[data-q="${lv}"]`)) document.querySelector(`.q[data-q="${lv}"]`).click();
      else await x.setQuality(lv);
      // 等到切换完成（编译结束）
      await new Promise((res) => { const chk = () => (!x.compiling && performance.now() - t0 > 300 ? res() : setTimeout(chk, 50)); chk(); });
      const done = performance.now() - t0;
      await new Promise((res) => setTimeout(res, 2500));
      run = false;
      return { done: Math.round(done), compile: x.lastCompileMs, maxGap: Math.round(Math.max(...gaps)), over1s: gaps.filter((g) => g > 1000).length };
    }, lv);
    rows.push({ id: 'quality' + lv, ...r });
    console.log(`画质 ${lv}：完成 ${r.done} ms（编译 ${r.compile} ms），最长帧间隔 ${r.maxGap} ms，>1 s 卡顿 ${r.over1s} 次`);
  }
}
fs.writeFileSync(path.join(outDir, 'views.json'), JSON.stringify(rows, null, 2));
const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
console.log(`完成 ${rows.length} 项，错误 ${errs.length} 条 → ${path.relative(root, outDir)}/views.json`);
for (const e of errs.slice(0, 10)) console.log('  ', e);
await browser.close();
await server.close();
