#!/usr/bin/env node
// 地铁专项交互冒烟测试（参照 tools/smoke_ui.mjs）：钟楼机位，白天、夜景各走一遍
//   地面 → X 透视俯视 → X 退出 → U 进站 → 站内前走 2 秒 → U 返回地面
// 每步截图（含界面与标注的整页截图），并记录：相机位置/朝向、控制模式、曝光与泛光、站内画面中心亮度与对比度、
// 显示中的标注（按类别计数，透视模式下列出文字）、路名/小区名层是否可见、新增控制台错误与页面异常。
// 自动判定：透视模式只显示车站标注；返回地面后视点与进站前一致（位置 <0.5 m、朝向 <0.5°）且标注层恢复；
//           白天/夜间站内画面中心亮度相差 <12（0~255）；全程无 pageerror / console.error / 模块错误。
// 用法：node tools/smoke_metro.mjs [--out shots/fix_metro/smoke] [--w 1440 --h 860]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const arg = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const outDir = path.resolve(root, arg('--out', 'shots/fix_metro/smoke'));
const W = +arg('--w', 1440), H = +arg('--h', 860);
fs.mkdirSync(outDir, { recursive: true });
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 400)));
// shot=1：保留绘制缓冲，便于在页面里读取画布像素统计亮度
await page.goto(`http://127.0.0.1:${port}/?online=0&shot=1&view=2&time=13`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000, polling: 500 });
const fatal = await page.evaluate(() => window.xian.fatal || null);
if (fatal) { console.error('启动失败', fatal); process.exit(1); }
await page.waitForTimeout(6000);

const probe = () => page.evaluate(() => {
  const X = window.xian, cam = X.camera, ctx = X.ctx;
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  // 只统计所在图层真正可见时显示中的标注（图层被隐藏时 DOM 里残留的是隐藏前的状态）
  const shown = (L) => (L && vis(L.root) ? L.items.filter((it) => it.shown) : []);
  const lab = shown(ctx.labels);
  const byCat = {};
  for (const it of lab) byCat[it.category] = (byCat[it.category] || 0) + 1;
  const rn = X.roadNames, es = X.estates;
  const rnShown = rn && vis(rn.root) ? [...rn.root.children].filter((e) => e.style.display !== 'none').length : 0;
  const esShown = es && es.labels ? shown(es.labels).length : 0;
  // 画面中心 40% 区域的平均亮度与标准差（0~255，sRGB）
  let lum = null;
  try {
    const c = X.renderer.domElement, w = 160, h = Math.round((160 * c.height) / c.width);
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, w, h);
    const d = g.getImageData(Math.round(w * 0.3), Math.round(h * 0.3), Math.round(w * 0.4), Math.round(h * 0.4)).data;
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; s += y; s2 += y * y; n++; }
    const m = s / n;
    lum = { mean: +m.toFixed(1), std: +Math.sqrt(Math.max(0, s2 / n - m * m)).toFixed(1) };
  } catch (e) { lum = String(e); }
  const q = cam.quaternion;
  return {
    pos: cam.position.toArray().map((v) => +v.toFixed(2)),
    quat: [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(5)),
    mode: X.controls.mode,
    hours: +X.sky.hours.toFixed(2),
    night: +X.sky.night.toFixed(2),
    metro: { xray: ctx.metro?.xray, under: ctx.metro?.underground, station: ctx.metro?.station },
    exposure: +X.renderer.toneMappingExposure.toFixed(3),
    bloom: X.post?.bloom ? { on: X.post.bloom.enabled, s: +X.post.bloom.strength.toFixed(2), thr: +X.post.bloom.threshold.toFixed(2) } : null,
    labelsLayer: vis(ctx.labels.root), roadLayer: rn ? vis(rn.root) : null, estateLayer: es && es.labels ? vis(es.labels.root) : null,
    labelsByCat: byCat, roadShown: rnShown, estateShown: esShown,
    labelTexts: lab.map((it) => `${it.category}:${it.text}`).slice(0, 60),
    lum,
    calls: X.renderer.info.render.calls,
    tris: +(X.renderer.info.render.triangles / 1e6).toFixed(2),
    fps: +X.fps.toFixed(0),
    errors: X.errors.slice(),
    button: document.querySelector('.b-metro-under')?.textContent || null,
  };
});

const result = [];
let n = 0;
async function step(name, fn, wait = 2500) {
  const before = logs.length;
  let err = null;
  try { await fn(); } catch (e) { err = String(e).slice(0, 300); }
  await page.waitForTimeout(wait);
  const file = path.join(outDir, `${String(++n).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: file });
  const st = await probe();
  const row = { step: name, file: path.relative(root, file), err, ...st, logs: logs.slice(before).filter((l) => !/willReadFrequently|Failed to load resource|GPU stall|GL_CLOSE_PATH|Automatic fallback/.test(l)) };
  result.push(row);
  console.log(`${name.padEnd(14)} ${err ? '异常 ' + err : ''}模式 ${st.mode} ${st.hours}h 曝光 ${st.exposure} 泛光 ${st.bloom ? (st.bloom.on ? st.bloom.s + '/' + st.bloom.thr : '关') : '-'} 亮度 ${st.lum?.mean}±${st.lum?.std} 标注 ${JSON.stringify(st.labelsByCat)} 路名 ${st.roadShown} 小区 ${st.estateShown} calls ${st.calls} 新日志 ${row.logs.length}`);
  return row;
}
const key = (k) => page.keyboard.press(k);
const hold = async (k, ms) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); };

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`  ${ok ? '通过' : '失败'}  ${name} ${detail}`); };
const angle = (q1, q2) => { const d = Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]); return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI; };

const stationLum = {};
for (const phase of ['白天', '夜景']) {
  if (phase === '夜景') {
    await page.evaluate(() => window.xian.setHours(20.6));
    await key('Digit2'); // 回到钟楼机位（上一轮返回地面后的视点不作为本轮起点）
    await page.waitForTimeout(6000);
  }
  const g0 = await step(`${phase}_地面`, async () => {}, 1500);
  const x1 = await step(`${phase}_透视X`, () => key('KeyX'), 4500);
  const cats = Object.keys(x1.labelsByCat);
  check(`${phase} 透视只显示车站标注`, cats.length > 0 && cats.every((c) => c === 'metrox') && x1.roadShown === 0 && x1.estateShown === 0, JSON.stringify(x1.labelsByCat) + ` 路名 ${x1.roadShown} 小区 ${x1.estateShown}`);
  check(`${phase} 透视显示“钟楼”换乘站`, x1.labelTexts.includes('metrox:钟楼'), x1.labelTexts.filter((t) => /钟楼|安远门/.test(t)).join('、'));
  const x2 = await step(`${phase}_透视X关`, () => key('KeyX'), 3500);
  check(`${phase} 退出透视回到原视点`, Math.hypot(...x2.pos.map((v, i) => v - g0.pos[i])) < 0.5 && angle(x2.quat, g0.quat) < 0.5, `${x2.pos} vs ${g0.pos}`);
  check(`${phase} 退出透视标注恢复`, x2.labelsLayer && Object.keys(x2.labelsByCat).some((c) => c !== 'metrox'), JSON.stringify(x2.labelsByCat));
  const u1 = await step(`${phase}_进站U`, () => key('KeyU'), 4500);
  stationLum[phase] = u1.lum?.mean;
  check(`${phase} 站内隐藏全部地面标注`, !u1.labelsLayer && !u1.roadLayer && !u1.estateLayer, `地名层 ${u1.labelsLayer} 路名层 ${u1.roadLayer} 小区层 ${u1.estateLayer}`);
  check(`${phase} 站内画面不过曝且有层次`, u1.lum && u1.lum.mean > 60 && u1.lum.mean < 190 && u1.lum.std > 18, JSON.stringify(u1.lum));
  await step(`${phase}_站内前走2秒`, () => hold('KeyW', 2000), 1500);
  const u2 = await step(`${phase}_返回地面U`, () => key('KeyU'), 3500);
  check(`${phase} 返回地面回到进站前视点`, Math.hypot(...u2.pos.map((v, i) => v - x2.pos[i])) < 0.5 && angle(u2.quat, x2.quat) < 0.5 && u2.mode === x2.mode, `${u2.pos} ${u2.mode} vs ${x2.pos} ${x2.mode}`);
  check(`${phase} 返回地面标注恢复`, u2.labelsLayer && u2.roadLayer === x2.roadLayer && u2.estateLayer === x2.estateLayer, `地名层 ${u2.labelsLayer} 路名层 ${u2.roadLayer} 小区层 ${u2.estateLayer}`);
  check(`${phase} 返回地面曝光/泛光恢复`, u2.exposure === g0.exposure || Math.abs(u2.exposure - g0.exposure) < 0.02, `${u2.exposure} vs ${g0.exposure}；泛光 ${JSON.stringify(u2.bloom)}`);
}
check('站内明暗不随昼夜变化', stationLum['白天'] != null && Math.abs(stationLum['白天'] - stationLum['夜景']) < 12, JSON.stringify(stationLum));
const bad = result.filter((r) => r.err || r.errors.length || r.logs.some((l) => /pageerror|\[error\]/.test(l)));
check('全程无报错', !bad.length, bad.map((r) => `${r.step}: ${r.err || ''} ${r.errors.join(';')} ${r.logs.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 2).join(' | ')}`).join(' / '));
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ checks, steps: result }, null, 2));
const failed = checks.filter((c) => !c.ok);
console.log(`完成 ${result.length} 步，检查 ${checks.length} 项，失败 ${failed.length} 项`);
await browser.close();
await server.close();
process.exit(failed.length ? 2 : 0);
