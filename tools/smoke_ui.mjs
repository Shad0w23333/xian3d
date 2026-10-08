#!/usr/bin/env node
// 交互冒烟测试：模拟用户操作（预设视角、日夜、步行/环绕、地铁透视/入站、俯视、分类高亮、面板开关、画质切换），
// 每一步记录新增的控制台错误/页面异常，并截图。用法：node tools/smoke_ui.mjs [--out shots/smoke]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const a = process.argv.slice(2);
const outDir = path.resolve(root, a.includes('--out') ? a[a.indexOf('--out') + 1] : 'shots/smoke');
fs.mkdirSync(outDir, { recursive: true });
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 400)));
await page.goto(`http://127.0.0.1:${port}/?online=0`);
await page.waitForFunction(() => window.xian && (window.xian.ready || window.xian.fatal), null, { timeout: 300000, polling: 500 });
await page.waitForTimeout(3000);
const result = [];
let n = 0;
async function step(name, fn, wait = 2500) {
  const before = logs.length;
  let err = null;
  try { await fn(); } catch (e) { err = String(e).slice(0, 300); }
  await page.waitForTimeout(wait);
  const file = path.join(outDir, `${String(++n).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: file });
  const st = await page.evaluate(() => ({ mode: window.xian.controls?.mode, hours: +window.xian.sky.hours.toFixed(2), fps: +window.xian.fps.toFixed(0), calls: window.xian.renderer.info.render.calls }));
  const row = { step: name, file: path.relative(root, file), err, ...st, logs: logs.slice(before).filter((l) => !/willReadFrequently|Failed to load resource/.test(l)) };
  result.push(row);
  console.log(`${name.padEnd(26)} ${err ? '异常 ' + err : ''} 模式 ${st.mode} ${st.hours}h fps ${st.fps} calls ${st.calls} 新日志 ${row.logs.length}`);
}
const key = (k) => page.keyboard.press(k);
const hold = async (k, ms) => { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); };
const click = (sel) => page.click(sel, { timeout: 5000 });

await step('初始界面', async () => {});
for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) await step(`预设视角${d}`, () => key(`Digit${d}`), 5000);
await step('扩展视角Shift1', () => key('Shift+Digit1'), 5000);
await step('日夜切换N', () => key('KeyN'), 4000);
await step('日夜切换N回白天', () => key('KeyN'), 4000);
await step('回钟楼', () => key('Digit2'), 5000);
await step('步行模式G', () => key('KeyG'), 2000);
await step('步行前进W', () => hold('KeyW', 2500), 1500);
await step('步行跳跃空格', () => key('Space'), 1500);
await step('退出步行G', () => key('KeyG'), 1500);
await step('飞行前进W加速', async () => { await page.keyboard.down('ShiftLeft'); await hold('KeyW', 1500); await page.keyboard.up('ShiftLeft'); }, 1500);
await step('上升E', () => hold('KeyE', 1500), 1500);
await step('环绕模式O', () => key('KeyO'), 3000);
await step('退出环绕O', () => key('KeyO'), 1500);
await step('俯视V', () => key('KeyV'), 3000);
await step('俯视V回', () => key('KeyV'), 3000);
await step('分类高亮B', () => key('KeyB'), 3000);
await step('分类高亮B关', () => key('KeyB'), 2000);
await step('地铁透视X', () => key('KeyX'), 4000);
await step('地铁透视X关', () => key('KeyX'), 2500);
await step('进入地铁站U', () => key('KeyU'), 5000);
await step('地铁站内走W', () => hold('KeyW', 2000), 1500);
await step('返回地面U', () => key('KeyU'), 4000);
await step('标注L', () => key('KeyL'), 1500);
await step('小地图M', () => key('KeyM'), 1500);
await step('帮助H', () => key('KeyH'), 1500);
await step('关闭帮助H', () => key('KeyH'), 1000);
await step('时间+30分', () => key('BracketRight'), 3000);
await step('时间流逝T', () => key('KeyT'), 3000);
await step('时间流逝T关', () => key('KeyT'), 1000);
for (const q of ['0', '1', '3', '2']) await step(`画质${q}`, () => click(`.q[data-q="${q}"]`), 5000);
for (const l of ['l-traffic', 'l-buildings', 'l-roadnames', 'l-estates', 'l-metro', 'l-districts']) {
  await step(`图层关${l}`, async () => { const el = await page.$(`.${l}`); if (el) await el.click(); else throw new Error('找不到控件 ' + l); }, 2500);
  await step(`图层开${l}`, async () => { const el = await page.$(`.${l}`); if (el) await el.click(); }, 2000);
}
await step('白天按钮', () => click('.t-day'), 4000);
await step('夜景按钮', () => click('.t-night'), 4000);
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
const bad = result.filter((r) => r.err || r.logs.some((l) => /pageerror|\[error\]/.test(l)));
console.log(`完成 ${result.length} 步，有异常/报错的 ${bad.length} 步`);
for (const r of bad) console.log('  ', r.step, r.err || '', r.logs.filter((l) => /pageerror|\[error\]/.test(l)).slice(0, 3));
await browser.close();
await server.close();
