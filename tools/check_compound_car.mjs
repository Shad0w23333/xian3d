#!/usr/bin/env node
// 小区停放车辆几何自检：每个三角形的法线应朝外（与“面心 − 部件中心”同向）。
// 用法：node tools/check_compound_car.mjs（有朝内三角形时退出码 1）
import { carNear, carFar, checkCarWinding } from '../src/arch/compound-props.js';

let fail = 0;
for (const [name, g] of [['近景车 carNear', carNear()], ['远景车 carFar', carFar()]]) {
  const n = g.attributes.position.count / 3;
  const bad = checkCarWinding(g);
  console.log(`${name}：${n} 个三角形，朝内 ${bad} 个`);
  if (bad) fail++;
}
process.exit(fail ? 1 : 0);
