#!/usr/bin/env node
// 性能巡检：加载完整场景，依次切到每个预设视角（白天/夜晚），测平均帧时间、draw calls、三角形。
// 用法：node tools/perf.mjs [--q 2] [--w 1600 --h 900] [--views 1,2,3,4,5,6,7,8,9,0] [--night]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const q = +get('--q', 2), W = +get('--w', 1600), H = +get('--h', 900);
const views = get('--views', '1,2,3,4,5,6,7,8,9,0').split(',');
const night = a.includes('--night');

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/?ui=0&labels=0&mini=0&q=${q}&view=${views[0]}${night ? '&time=21' : '&time=15'}`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 180000 });
console.log(`加载 ${((Date.now() - t0) / 1000).toFixed(1)} s；模块错误：`, await page.evaluate(() => window.xian.errors));
const rows = [];
for (const v of views) {
  await page.evaluate(({ v, night }) => {
    const x = window.xian;
    const all = [...(window.__presets || [])];
    x.goto(v);
    x.controls.tween && (x.controls.tween.dur = 0.01);
    if (night) x.setHours(21);
  }, { v, night });
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => new Promise((res) => {
    const ts = [];
    let last = performance.now();
    const f = (t) => {
      ts.push(t - last);
      last = t;
      if (ts.length < 180) requestAnimationFrame(f);
      else {
        ts.sort((a, b) => a - b);
        const avg = ts.reduce((s, x) => s + x, 0) / ts.length;
        const info = window.xian.renderer.info.render;
        res({ avgMs: +avg.toFixed(2), p95Ms: +ts[Math.floor(ts.length * 0.95)].toFixed(2), calls: info.calls, tris: info.triangles, tiles: window.xian.terrain.visibleCount });
      }
    };
    requestAnimationFrame(f);
  }));
  rows.push({ view: v, fps: +(1000 / r.avgMs).toFixed(1), ...r });
  console.log(JSON.stringify(rows[rows.length - 1]));
}
const mem = await page.evaluate(() => window.xian.renderer.info.memory);
console.log('GPU 资源：', mem, '页面错误：', errors.slice(0, 5));
await browser.close();
await server.close();
