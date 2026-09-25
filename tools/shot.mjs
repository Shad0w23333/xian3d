#!/usr/bin/env node
// 自动截图工具（给开发/审查用）：内置启动 Vite 开发服务器 + 无头 Chromium（Metal GPU），等待场景加载后截图。
// 用法：
//   node tools/shot.mjs --shot "modules=belltower&view=2&time=12|shots/bell.png" [--shot "...|..."] [--w 1600 --h 900] [--wait 40] [--frames 90]
// 参数说明：
//   查询串会追加 ui=0（隐藏界面）和 online=1（默认开在线影像；加 online=0 可关闭）。可用参数见 src/main.js：
//   modules=a,b（只加载指定模块，none=都不加载）、skip=a,b、view=预设键(1..0 或 !1..!5)、time=小时、q=画质0..3、
//   ll=lon,lat,离地高,目标lon,目标lat,目标离地高、cam=x,离地高,z,tx,目标离地高,tz、orbit=1
//   labels=1 显示地名标注（默认截图不显示）
//   输出：PNG + 控制台打印 JSON（fps、drawcalls、三角形、控制台错误、模块错误）
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { shots: [], w: 1600, h: 900, wait: 45, frames: 90, headed: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--shot') opt.shots.push(args[++i]);
  else if (a === '--w') opt.w = +args[++i];
  else if (a === '--h') opt.h = +args[++i];
  else if (a === '--wait') opt.wait = +args[++i];
  else if (a === '--frames') opt.frames = +args[++i];
  else if (a === '--headed') opt.headed = true;
}
if (!opt.shots.length) {
  console.error('需要至少一个 --shot "query|out.png"');
  process.exit(1);
}

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({
  headless: !opt.headed,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});
const results = [];
try {
  for (const spec of opt.shots) {
    const [query, out] = spec.split('|');
    const q = new URLSearchParams(query);
    if (!q.has('ui')) q.set('ui', '0');
    if (!q.has('mini')) q.set('mini', '0');
    if (!q.has('labels')) q.set('labels', '0');
    q.set('shot', '1');
    const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h }, deviceScaleFactor: 1 });
    const logs = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`.slice(0, 400));
    });
    page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 400)));
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/?${q.toString()}`);
    let info = null;
    try {
      await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: opt.wait * 1000, polling: 250 });
      const fatal = await page.evaluate(() => window.xian.fatal);
      if (fatal) throw new Error('fatal: ' + fatal);
      const startFrame = await page.evaluate(() => window.xian.frame);
      // 等待：至少 N 帧 + 影像队列清空持续 1.5 秒（或超时）
      const deadline = Date.now() + opt.wait * 1000;
      let settledSince = 0;
      while (Date.now() < deadline) {
        const s = await page.evaluate(() => ({ f: window.xian.frame, ok: window.xian.settled() }));
        if (s.f - startFrame >= opt.frames) {
          if (s.ok) {
            settledSince ||= Date.now();
            if (Date.now() - settledSince > 1500) break;
          } else settledSince = 0;
        }
        await page.waitForTimeout(250);
      }
      info = await page.evaluate(() => {
        const r = window.xian.renderer.info;
        return {
          fps: +window.xian.fps.toFixed(1),
          calls: r.render.calls,
          triangles: r.render.triangles,
          geometries: r.memory.geometries,
          textures: r.memory.textures,
          programs: r.programs ? r.programs.length : null,
          moduleErrors: window.xian.errors,
          cam: window.xian.camera.position.toArray().map((v) => +v.toFixed(1)),
          hours: +window.xian.sky.hours.toFixed(2),
          tiles: window.xian.terrain.visibleCount,
          reversedDepth: window.xian.reversedDepth,
        };
      });
    } catch (e) {
      logs.push('[shot] ' + e.message);
    }
    fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
    await page.screenshot({ path: path.resolve(root, out) });
    results.push({ out, seconds: +((Date.now() - t0) / 1000).toFixed(1), ...info, logs: logs.slice(0, 30) });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(results, null, 2));
