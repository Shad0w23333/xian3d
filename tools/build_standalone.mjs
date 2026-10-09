#!/usr/bin/env node
// 生成“单文件离线版”：把 JS/CSS 全部内联，并把 public/data 下的数据以 base64 嵌入，
// 得到一个可以直接双击（file://）打开的 HTML。
// 用法：node tools/build_standalone.mjs [--out dist-standalone/西安3D.html] [--skip img_core.jpg,img_wall.jpg]
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStandaloneData } from './standalone-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const out = path.resolve(root, get('--out', 'dist-standalone/西安3D-离线单文件版.html'));
// 默认跳过体积大的高清底图（联网时会自动使用在线高清卫星影像）
const skip = new Set(get('--skip', 'img_core.jpg,img_wall.jpg,img_qujiang.jpg').split(',').filter(Boolean));
const tmp = path.join(root, '.standalone-build');

console.log('① Vite 构建（单包模式）……');
await build({
  root,
  base: './',
  logLevel: 'warn',
  publicDir: false,
  build: {
    outDir: tmp,
    emptyOutDir: true,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { codeSplitting: false } },
  },
  worker: { format: 'es' },
});

let html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
const assets = path.join(tmp, 'assets');

// 内联 CSS
html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/([^"]+)"[^>]*>/g, (_, f) => {
  const css = fs.readFileSync(path.join(assets, f), 'utf8');
  return `<style>\n${css}\n</style>`;
});
// 取出模块脚本，稍后放到数据之后
let mainJs = '';
html = html.replace(/<script type="module" crossorigin src="\.\/assets\/([^"]+)"><\/script>/g, (_, f) => {
  mainJs += fs.readFileSync(path.join(assets, f), 'utf8');
  return '';
});
if (!mainJs) throw new Error('没有找到入口脚本');
const leftover = fs.readdirSync(assets).filter((f) => f.endsWith('.js') && !mainJs.includes(f));
if (leftover.length > 1) console.warn('⚠ 以下 JS 块未被内联（可能是 Worker 未使用 ?worker&inline）：', leftover);

console.log('② 嵌入数据……');
const dataDir = path.join(root, 'public', 'data');
const { embed, total } = readStandaloneData(dataDir, {
  skip,
  onFile: (f, size) => console.log(`   ${f.padEnd(26)} ${(size / 1048576).toFixed(2)} MB`),
});
// meta.json 里去掉被跳过的底图
if (embed['meta.json']) {
  const meta = JSON.parse(Buffer.from(embed['meta.json'], 'base64').toString('utf8'));
  meta.imagery = (meta.imagery || []).filter((m) => !skip.has(m.file));
  embed['meta.json'] = Buffer.from(JSON.stringify(meta)).toString('base64');
}
const dataScript = `<script>window.__XIAN3D_EMBED__=${JSON.stringify(embed)};</script>`;
const mainScript = `<script type="module">\n${mainJs.replace(/<\/script/gi, '<\\/script')}\n</script>`;
// 注意用函数形式替换，避免 JS 里的 $& / $' 被当成替换模式
html = html.replace('</body>', () => `${dataScript}\n${mainScript}\n</body>`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`③ 完成：${out}（${(fs.statSync(out).size / 1048576).toFixed(1)} MB，嵌入数据原始 ${(total / 1048576).toFixed(1)} MB）`);
