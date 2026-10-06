#!/usr/bin/env node
// 性能巡检：加载完整场景，依次切到每个预设视角（白天/夜晚），测平均帧时间、draw calls、三角形。
// 用法：node tools/perf.mjs [--q 2] [--w 1600 --h 900] [--views 1,2,3,4,5,6,7,8,9,0] [--night]
//        [--cams "x,离地高,z,tx,目标离地高,tz;..."]（自定义视角，世界坐标，代替 --views）
//        [--frames 180]（每个视角统计的帧数；Linux 软件渲染很慢，建议 3~10）[--warm 5]（计时前空跑的帧数，避开着色器编译）
// macOS 用 Metal GPU；Linux/云端无 GPU 时自动用 SwiftShader 软件渲染（帧率只作相对比较，draw calls / 三角形数可直接对比）。
// 近景建筑小块按需生成：每个视角先等建筑近景小块就绪、影像队列清空再计时。
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const q = +get('--q', 2), W = +get('--w', 1600), H = +get('--h', 900);
const FR = +get('--frames', 180);
const WARM = +get('--warm', 5);
const cams = get('--cams', '') ? get('--cams', '').split(';').map((s) => s.split(',').map(Number)) : null;
const views = cams ? cams.map((_, i) => 'cam' + (i + 1)) : get('--views', '1,2,3,4,5,6,7,8,9,0').split(',');
const night = a.includes('--night');
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
const first = cams ? `cam=${cams[0].join(',')}` : `view=${views[0]}`;
await page.goto(`http://127.0.0.1:${port}/?ui=0&labels=0&mini=0&online=0&q=${q}&${first}${night ? '&time=21' : '&time=15'}`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000 });
console.log(`加载 ${((Date.now() - t0) / 1000).toFixed(1)} s；模块错误：`, await page.evaluate(() => window.xian.errors));
const rows = [];
for (let vi = 0; vi < views.length; vi++) {
  const v = views[vi];
  await page.evaluate(({ v, night, cam }) => {
    const x = window.xian;
    if (cam) x.setView({ pos: [cam[0], cam[1], cam[2]], target: [cam[3], cam[4], cam[5]], agl: true });
    else {
      x.goto(v);
      x.controls && x.controls.tween && (x.controls.tween.dur = 0.01);
    }
    if (night) x.setHours(21);
  }, { v, night, cam: cams ? cams[vi] : null });
  // 等待：至少 3 秒；建筑近景小块集合稳定、影像队列清空（最长 180 秒）
  const deadline = Date.now() + 180000;
  let stable = 0, last = '';
  await page.waitForTimeout(3000);
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const b = window.xian.ctx.modules.buildings;
      const st = b && b.stats ? b.stats() : {};
      return { k: `${st.hiShown}/${st.hiCached}`, ok: window.xian.settled() && !(st.hiLoading > 0) && !(st.hiPending > 0) };
    });
    if (s.k === last && s.ok) stable++;
    else stable = 0;
    last = s.k;
    if (stable >= 4) break;
    await page.waitForTimeout(1000);
  }
  // 先空跑 WARM 帧（新出现的材质/阴影程序在这几帧里编译，软件渲染下单次可达数十秒），再计时 FR 帧
  const r = await page.evaluate(({ FR, WARM }) => new Promise((res) => {
    const ts = [];
    let last = performance.now(), warm = WARM;
    const f = (t) => {
      if (warm > 0) {
        warm--;
        last = t;
        requestAnimationFrame(f);
        return;
      }
      ts.push(t - last);
      last = t;
      if (ts.length < FR) requestAnimationFrame(f);
      else {
        ts.sort((a, b) => a - b);
        const avg = ts.reduce((s, x) => s + x, 0) / ts.length;
        const info = window.xian.renderer.info.render;
        const b = window.xian.ctx.modules.buildings;
        res({ avgMs: +avg.toFixed(2), medMs: +ts[Math.floor(ts.length / 2)].toFixed(2), p95Ms: +ts[Math.floor(ts.length * 0.95)].toFixed(2), calls: info.calls, tris: info.triangles, tiles: window.xian.terrain.visibleCount, bld: b && b.stats ? b.stats() : null });
      }
    };
    requestAnimationFrame(f);
  }), { FR, WARM });
  rows.push({ view: v, fps: +(1000 / r.avgMs).toFixed(1), ...r });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
const mem = await page.evaluate(() => window.xian.renderer.info.memory);
console.log('GPU 资源：', mem, '页面错误：', errors.slice(0, 5));
await browser.close();
await server.close();
