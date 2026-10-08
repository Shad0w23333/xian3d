#!/usr/bin/env node
// 全城街道设施（streetfurniture 模块）的数据生成：src/arch/furniture-data.js
//   1) 公交站：OSM highway=bus_stop / public_transport=platform（带 bus=yes）节点（data-src/osm/pois__geofabrik.json，
//      tools/fetch_geofabrik.py 的产物），核心区外扩 300 m；站名 + 途经线路（network 标签，约四分之一的站有）+ shelter 标签。
//   2) 路名拼音：核心区主次干道（trunk/primary/secondary/tertiary）路名用到的汉字 → 拼音（无声调）。
//      用 macOS 系统转写（CFStringTransform Mandarin→Latin，按词取音），再统计成“单字 → 读音”表；
//      西安地名里的多音字按本地读法覆盖（长 cháng、堡 bǔ（张家堡 Zhangjiabu）、重 chóng、什 shí（五道什字））。
// 用法：node tools/build_furniture_data.mjs   （需要 macOS 的 swift；没有时拼音表沿用旧文件）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { project } from '../src/core/geo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'src/arch/furniture-data.js');
const pa = project(108.84, 34.35), pb = project(109.06, 34.17);
const M = 300;
const inCore = (x, z) => x > pa.x - M && x < pb.x + M && z > pa.z - M && z < pb.z + M;

// ---------- 公交站 ----------
const src = JSON.parse(fs.readFileSync(path.join(root, 'data-src/osm/pois__geofabrik.json'), 'utf8'));
const names = [], nameIdx = new Map(), routes = [''], routeIdx = new Map([['', 0]]);
const rows = [];
const seen = [];
for (const e of src.elements) {
  const t = e.tags || {};
  if (e.type !== 'node' || !t.name) continue;
  if (!(t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes'))) continue;
  const p = project(e.lon, e.lat);
  if (!inCore(p.x, p.z)) continue;
  const n = t.name.replace(/[（(].*?[）)]/g, '').replace(/公交站$/, '').trim();
  if (!n || [...n].length > 12) continue;
  // 同名 6 m 内（同一站台重复标注）去重
  if (seen.some((s) => s.n === n && Math.hypot(s.x - p.x, s.z - p.z) < 6)) continue;
  seen.push({ n, x: p.x, z: p.z });
  if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
  // 线路：“204路，225路，环山旅游2号线” → “204 225 环山2”
  let r = (t.route_ref || t.network || '')
    .split(/[，,;；、\s]+/)
    .map((s) => s.replace(/路$/, '').replace(/旅游(\d+)号线/, '$1').trim())
    .filter((s) => s && [...s].length <= 6)
    .slice(0, 8)
    .join(' ');
  if (!routeIdx.has(r)) { routeIdx.set(r, routes.length); routes.push(r); }
  rows.push(Math.round(p.x * 10), Math.round(p.z * 10), nameIdx.get(n), routeIdx.get(r), t.shelter === 'yes' ? 1 : t.shelter === 'no' ? 2 : 0);
}
console.log(`公交站 ${rows.length / 5}，站名 ${names.length}，线路串 ${routes.length}`);

// ---------- 路名拼音（单字表） ----------
const roads = JSON.parse(fs.readFileSync(path.join(root, 'public/data/roads.json'), 'utf8'));
const roadNames = new Set();
for (const f of roads.features) {
  if (!f.n || f.c < 1 || f.c > 4 || !f.p) continue;
  for (let i = 0; i < f.p.length; i += 2) if (inCore(f.p[i], f.p[i + 1])) { roadNames.add(f.n); break; }
}
const OVERRIDE = { 长: 'chang', 堡: 'bu', 重: 'chong', 曲: 'qu', 乐: 'le', 朝: 'chao', 行: 'xing', 大: 'da', 都: 'du', 什: 'shi' };
let charMap = null;
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'furn-py-'));
  const inF = path.join(tmp, 'names.json'), outF = path.join(tmp, 'py.json'), sw = path.join(tmp, 'py.swift');
  fs.writeFileSync(inF, JSON.stringify([...roadNames]));
  fs.writeFileSync(
    sw,
    `import Foundation
let a = CommandLine.arguments
let names = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[1]))) as! [String]
var out: [String: String] = [:]
for n in names { let s = NSMutableString(string: n); CFStringTransform(s, nil, kCFStringTransformMandarinLatin, false); CFStringTransform(s, nil, kCFStringTransformStripDiacritics, false); out[n] = s as String }
try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]).write(to: URL(fileURLWithPath: a[2]))
`
  );
  execFileSync('swift', [sw, inF, outF], { stdio: 'inherit' });
  const raw = JSON.parse(fs.readFileSync(outF, 'utf8'));
  const cnt = new Map();
  for (const [n, py] of Object.entries(raw)) {
    const ch = [...n], sy = py.trim().split(/\s+/);
    if (ch.length !== sy.length) continue;
    ch.forEach((c, i) => {
      if (!/[一-鿿]/.test(c) || !/^[a-z]+$/.test(sy[i])) return;
      const m = cnt.get(c) || new Map();
      m.set(sy[i], (m.get(sy[i]) || 0) + 1);
      cnt.set(c, m);
    });
  }
  charMap = {};
  for (const [c, m] of cnt) charMap[c] = [...m].sort((a, b) => b[1] - a[1])[0][0];
  Object.assign(charMap, OVERRIDE);
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.warn('拼音转写失败（需要 macOS swift），沿用旧表：', e.message);
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const m = /export const PY = '([^']*)'/.exec(old);
  if (m) {
    charMap = {};
    for (const it of m[1].matchAll(/([一-鿿])([a-z]+)/g)) charMap[it[1]] = it[2];
  }
}
const py = Object.entries(charMap || {})
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([c, s]) => c + s)
  .join('');
console.log(`拼音单字 ${Object.keys(charMap || {}).length}`);

const js = `// 自动生成（tools/build_furniture_data.mjs），请勿手改。
// 公交站：OpenStreetMap（© OpenStreetMap contributors）highway=bus_stop / public_transport=platform 节点，核心区外扩 300 m。
// BUS：每站 5 个整数 [x×10, z×10（世界坐标分米）, 站名下标, 线路串下标, shelter 标签（0 无 1 yes 2 no）]
export const BUS_NAMES = ${JSON.stringify(names)};
export const BUS_ROUTES = ${JSON.stringify(routes)};
export const BUS = [${rows.join(',')}];
// 路名拼音单字表（“字拼音”连写，无声调）：核心区主次干道路名用字，西安地名多音字已按本地读法覆盖
export const PY = '${py}';
`;
fs.writeFileSync(OUT, js);
console.log(`写出 ${path.relative(root, OUT)}（${(js.length / 1024).toFixed(0)} KB）`);
