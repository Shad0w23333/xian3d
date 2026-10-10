#!/usr/bin/env node
// 道路属性人工更正（可重复运行，幂等）：public/data/roads.json 原地修改路宽 w / 车道数 l 等属性，不动几何。
// 要素按“路名 + 某个顶点落在给定点附近 + 方向（单行道走向）”匹配，不依赖要素下标（上游重建后下标会变）。
// 上游（roads_update.py / amap_fetch.py merge / roads_fix.mjs）重新生成 roads.json 后，与 roads_junctions.mjs 一起再跑一次。
// 用法：node tools/roads_attr_fix.mjs [--file public/data/roads.json] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { file: 'public/data/roads.json', dry: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') opt.file = args[++i];
  else if (args[i] === '--dry') opt.dry = true;
}

/**
 * 更正表：name 路名；near [x, z] 世界坐标（米）与 r 半径：要素须有顶点落在其中；dir [dx, dz] 可选：要素首→尾大致方向
 * （单行道区分上下行）；set：要写入的属性；why：依据。
 */
const FIXES = [
  {
    // 第二轮审查 P1：长安南路西邮雁塔校区段（南二环—雁南一路）北行一幅标成 2 车道 8 m，同名南行 4 车道 15 m，
    // 往南接续的北行段（2820）也是 4 车道 15 m、中线位置相同；离线影像 z18 量得该段两幅车行道各约 14.6~14.8 m。
    name: '长安南路', near: [-24, 5100], r: 60, dir: [0, -1], set: { w: 15, l: 4 },
    why: '北行与南行、与下游同名北行段一致（4 车道 15 m），影像核对',
  },
];

const file = path.resolve(root, opt.file);
const R = JSON.parse(fs.readFileSync(file, 'utf8'));
let changed = 0;
for (const fx of FIXES) {
  const hits = [];
  R.features.forEach((f, i) => {
    if ((f.n || '') !== fx.name || !f.p || f.p.length < 4) return;
    const p = f.p;
    let near = false;
    for (let k = 0; k < p.length; k += 2) if (Math.hypot(p[k] - fx.near[0], p[k + 1] - fx.near[1]) < fx.r) { near = true; break; }
    // 也认线段经过（长直段顶点稀）
    if (!near)
      for (let k = 0; k + 3 < p.length; k += 2) {
        const ax = p[k], az = p[k + 1], dx = p[k + 2] - ax, dz = p[k + 3] - az, l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((fx.near[0] - ax) * dx + (fx.near[1] - az) * dz) / l2));
        if (Math.hypot(ax + dx * t - fx.near[0], az + dz * t - fx.near[1]) < fx.r) { near = true; break; }
      }
    if (!near) return;
    if (fx.dir) {
      const dx = p[p.length - 2] - p[0], dz = p[p.length - 1] - p[1];
      if (dx * fx.dir[0] + dz * fx.dir[1] <= 0) return;
    }
    hits.push(i);
  });
  if (!hits.length) { console.warn(`[roads_attr_fix] 未匹配：${fx.name} @${fx.near}`); continue; }
  for (const i of hits) {
    const f = R.features[i];
    const before = Object.fromEntries(Object.keys(fx.set).map((k) => [k, f[k]]));
    let diff = false;
    for (const [k, v] of Object.entries(fx.set)) if (f[k] !== v) { f[k] = v; diff = true; }
    if (diff) changed++;
    console.log(`[roads_attr_fix] #${i} ${fx.name} ${JSON.stringify(before)} → ${JSON.stringify(fx.set)}${diff ? '' : '（已是目标值）'}：${fx.why}`);
  }
}
if (!opt.dry && changed) {
  fs.writeFileSync(file, JSON.stringify(R));
  console.log(`[roads_attr_fix] 写回 ${opt.file}，改动 ${changed} 条`);
} else console.log(`[roads_attr_fix] 无需写回（改动 ${changed} 条${opt.dry ? '，--dry' : ''}）`);
