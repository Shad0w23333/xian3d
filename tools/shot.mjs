#!/usr/bin/env node
// 自动截图工具（给开发/审查用）：内置启动 Vite 开发服务器 + 无头 Chromium（Metal GPU），等待场景加载后截图。
// 用法：
//   node tools/shot.mjs --shot "modules=belltower&view=2&time=12|shots/bell.png" [--shot "...|..."] [--w 1600 --h 900] [--wait 40] [--frames 90]
// 参数说明：
//   查询串会追加 ui=0（隐藏界面）和 online=1（默认开在线影像；加 online=0 可关闭）。可用参数见 src/main.js：
//   modules=a,b（只加载指定模块，none=都不加载）、skip=a,b、view=预设键(1..0 或 !1..!5)、time=小时、q=画质0..3、
//   ll=lon,lat,离地高,目标lon,目标lat,目标离地高、cam=x,离地高,z,tx,目标离地高,tz、orbit=1
//   labels=1 显示地名标注（默认截图不显示）
//   --dom：连同 DOM 叠加层（地名/路名/小区标注、面板）一起截图（默认只读 WebGL 画布）
//   输出：PNG + 控制台打印 JSON（fps、drawcalls、三角形、控制台错误、模块错误）
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { shots: [], w: 1600, h: 900, wait: 45, frames: 90, headed: false, dom: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--shot') opt.shots.push(args[++i]);
  else if (a === '--w') opt.w = +args[++i];
  else if (a === '--h') opt.h = +args[++i];
  else if (a === '--wait') opt.wait = +args[++i];
  else if (a === '--frames') opt.frames = +args[++i];
  else if (a === '--headed') opt.headed = true;
  else if (a === '--dom') opt.dom = true;
}
if (!opt.shots.length) {
  console.error('需要至少一个 --shot "query|out.png"');
  process.exit(1);
}

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const exe = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({
  ...(exe && process.platform !== 'darwin' ? { executablePath: exe } : {}),
  headless: !opt.headed,
  // macOS 用 Metal GPU；Linux 云端通常无 GPU，改用 SwiftShader 软件渲染（慢，但结果一致）
  args: process.platform === 'darwin' && !process.env.SWIFTSHADER
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu']
    : ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
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
      // 等待：至少 N 帧 + 影像队列清空、通用建筑近景小块集合不再变化，持续 1.5 秒（或超时）
      const deadline = Date.now() + opt.wait * 1000;
      let settledSince = 0, lastHi = '';
      while (Date.now() < deadline) {
        const s = await page.evaluate(() => {
          const b = window.xian.ctx && window.xian.ctx.modules && window.xian.ctx.modules.buildings;
          const st = b && b.stats ? b.stats() : null;
          return { f: window.xian.frame, ok: window.xian.settled(), hi: st ? `${st.hiShown}/${st.hiCached}` : '', busy: st ? st.hiLoading > 0 || st.hiPending > 0 : false };
        });
        const hiStable = s.hi === lastHi && !s.busy;
        lastHi = s.hi;
        if (s.f - startFrame >= opt.frames) {
          if (s.ok && hiStable) {
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
          buildings: window.xian.ctx?.modules?.buildings?.stats?.() || null,
        };
      });
    } catch (e) {
      logs.push('[shot] ' + e.message);
    }
    fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
    // 暂停主循环后直接读取 WebGL 画布（shot=1 时 preserveDrawingBuffer 已开启）；失败再退回整页截图
    let saved = false;
    try {
      const url = await page.evaluate(async () => {
        window.xian.paused = true;
        await new Promise((r) => setTimeout(r, 200));
        return window.xian.renderer.domElement.toDataURL('image/png');
      });
      if (url && url.startsWith('data:image/png') && !opt.dom) {
        fs.writeFileSync(path.resolve(root, out), Buffer.from(url.split(',')[1], 'base64'));
        saved = true;
      }
    } catch (e) {
      logs.push('[shot] canvas 读取失败：' + e.message);
    }
    if (!saved) await page.screenshot({ path: path.resolve(root, out), timeout: 180000 });
    results.push({ out, seconds: +((Date.now() - t0) / 1000).toFixed(1), ...info, logs: [...logs.filter((l) => /^\[(pageerror|error)\]/.test(l)), ...logs.filter((l) => !/^\[(pageerror|error)\]/.test(l)).slice(0, 30)] }); // 错误/页面异常全部保留，其余日志只留前 30 条
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(results, null, 2));
