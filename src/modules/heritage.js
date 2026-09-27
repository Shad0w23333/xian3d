// 历史文化地标：小雁塔（荐福寺、西安博物院）、大明宫国家遗址公园（丹凤门、含元殿/宣政殿/紫宸殿遗址、宫墙）、
// 陕西历史博物馆、西安站（北站房/南站房/高架候车室）、兴庆宫公园（沉香亭、花萼相辉楼）。
//
// 资料与核对（位置均以 OSM 建筑/POI + Esri 卫星图（research/refs/heritage/sat_*.jpg，带世界坐标网格）核对）：
//   · 小雁塔：唐景龙年间建，方形密檐砖塔，原 15 层，1556 年地震毁顶两层，现存 13 层、高 43.4 m；底层边长 11.38 m、
//     底层高 6.83 m，二层以上逐层递减、卷刹秀丽；叠涩出檐间以菱角牙子；方形台基砖表土心，高 3.2 m、边长 23.38 m。
//     塔心卫星 ≈ (-456, 2244)；荐福寺中轴 x≈-458，自南向北：山门—钟鼓楼—慈氏阁—大雄宝殿—藏经楼—小雁塔—白衣阁。
//     西安博物院（张锦秋，2007，“天圆地方”）≈ (-622, 2456)，方形主体约 78 m，中央圆形穹顶。
//   · 丹凤门遗址博物馆（张锦秋，2010）：门址东西 74.5 m、南北 33 m，五门道各宽 8.5 m、隔墙 3.8 m；全钢结构，
//     外装“从上到下淡棕黄色”，高约 33 m。卫星：屋面中心 ≈ (1582, -2430)，屋面约 83×44 m，两翼城墙总长约 220 m。
//   · 含元殿遗址（大台三层、龙尾道、东西翔鸾/栖凤二阁阙台）≈ (1573, -3130)；宣政殿 ≈ (1571, -3464)；紫宸殿 ≈ (1570, -3643)。
//   · 陕西历史博物馆（张锦秋，1991，“中央殿堂、四隅崇楼”，灰瓦白墙）卫星：主体 x 678~843、z 3849~4000，中心 ≈ (760, 3925)。
//   · 西安站：北站房（2021 改扩建，唐风重檐庑殿，面向大明宫丹凤门）卫星 ≈ (1450, -2232)，约 146×59 m；
//     高架候车室 z -2203~-2006；南站房（唐风）≈ (1455, -1976)。
//   · 兴庆宫公园：沉香亭（重檐四角攒尖，OSM (3533, 662)）；湖心南岸楼阁 ≈ (3365, 663)（花萼相辉楼式二层楼阁）。
import * as THREE from 'three';
import { ArchBuilder, hall, multiStoreyTower, pavilion, corridor, roof, yardWall, balustrade, lantern, stoneLion, steps, glowQuad } from '../arch/chinese.js';
import { denseEavePagoda, danfengGate, ruinTerrace, columnBases, earthWall, whiteBlock } from '../arch/heritage-parts.js';

const LEVELS = [[2, 0], [1, 260], [0, 750]];
const HIDE = 9000; // 超过此距离整组隐藏（远景由通用建筑/影像承担）

// 陕历博配色：灰瓦白墙、浅灰柱与斗拱
const PAL_SHANBO = {
  col: 0xd6d1c7, colBase: 0xc9c3b8, wall: 0xf0ece4, frame: 0x6a645c, door: 0x5a554e, lattice: 0x5e5850,
  dou: 0xcfc9be, gong: 0xcac4b8, ang: 0xcac4b8, armEnd: 0xe6e2da, panel: 0xeeeae2, rafter: 0xc8c2b6, rafterEnd: 0xe6e2da,
  flyEnd: 0xe6e2da, soffit: 0xbcb6aa, fascia: 0xcfc9bd, stone: 0xd9d4ca, gable: 0xeeeae2, boFeng: 0xcfc9bd, railing: 0xd6d1c7,
  beamRow: 3, plankRow: 3,
};
// 西安站：灰瓦、深灰钢柱、浅灰斗拱
const PAL_STATION = {
  ...PAL_SHANBO, col: 0x8e8a84, frame: 0x55595c, dou: 0xb9b4aa, gong: 0xb3aea4, ang: 0xb3aea4, rafter: 0xa9a49a, soffit: 0xa6a196, fascia: 0xb3aea4,
};

// ───────────── 各地标构建函数（局部坐标，原点 = 地标中心，+Z 南） ─────────────

/** 小雁塔 + 荐福寺 + 西安博物院 */
function buildXiaoyanta(b, env) {
  const dy = env.dy; // (x,z) → 相对原点的地面高差
  const info = denseEavePagoda(b, { floors: 13, baseW: 11.38, firstH: 6.83, totalH: 40.2, topW: 0.5 });
  // 荐福寺中轴（明清官式，灰瓦朱柱）
  const M = { style: 'ming', roofColor: 'darkgray' };
  b.push(0, dy(0, -40), -40, 0);
  hall(b, { ...M, bays: 5, bayW: 3.6, depthBays: 3, colH: 3.8, roof: 'xieshan', front: 'center3', platformH: 0.8, plaque: '白衣閣' });
  b.pop();
  b.push(0, dy(0, 34), 34, 0);
  multiStoreyTower(b, { ...M, floors: 2, bays: 5, bayW: 3.5, depthBays: 3, colH: 3.6, roof: 'xieshan', platformH: 0.9, plaque: '藏經樓', balcony: 1.0 });
  b.pop();
  b.push(0, dy(0, 68), 68, 0);
  hall(b, { ...M, bays: 5, bayW: 4.2, centerW: 4.8, depthBays: 4, colH: 4.6, eaves: 1, roof: 'xieshan', platform: 'sumeru', platformH: 1.2, railing: false, steps: 'front', plaque: '大雄寶殿', front: 'center3' });
  b.pop();
  for (const s of [1, -1]) {
    b.push(s * 24, dy(s * 24, 68), 68, -s * Math.PI / 2);
    hall(b, { ...M, bays: 3, bayW: 3.6, depthBays: 2, colH: 3.4, roof: 'yingshan', platformH: 0.5, front: 'center1' });
    b.pop();
  }
  b.push(0, dy(0, 102), 102, 0);
  hall(b, { ...M, bays: 3, bayW: 4.0, depthBays: 3, colH: 4.0, eaves: 2, roof: 'xieshan', platformH: 0.9, plaque: '慈氏閣', front: 'center1' });
  b.pop();
  // 钟楼、鼓楼（砖台 + 方亭式楼）
  for (const [s, name] of [[1, '鼓樓'], [-1, '鐘樓']]) {
    b.push(s * 20, dy(s * 20, 128), 128, 0);
    hall(b, { ...M, bays: 1, bayW: 4.6, depthBays: 1, depthW: 4.6, colH: 3.4, roof: 'xieshan', platform: 'brick', platformH: 3.4, platformMargin: 1.6, steps: 'none', front: 'doors', back: 'doors', sides: 'doors', plaque: name, plaqueVertical: false });
    b.pop();
  }
  // 山门 + 院墙
  b.push(0, dy(0, 156), 156, 0);
  hall(b, { ...M, bays: 3, bayW: 4.2, depthBays: 2, colH: 4.0, roof: 'xieshan', front: 'gate', back: 'gate', sides: 'wall', platformH: 0.9, plaque: '荐福寺', plaqueVertical: false });
  stoneLion(b, -5.2, 0, 7.5, 0);
  stoneLion(b, 5.2, 0, 7.5, 0);
  b.pop();
  const wy = dy(0, 60);
  yardWall(b, [[-7, 160], [-42, 160], [-42, -58], [42, -58], [42, 160], [7, 160]], { h: 3.2, y0: wy, color: 0xa4382a });
  // 甬道
  b.box('stone', -2.2, wy - 0.3, 14, 2.2, wy + 0.08, 158, 0xbdb6a8, { skip: 'bottom' });
  // —— 西安博物院（天圆地方）：方形台座 + 方形主体 + 环形灰瓦檐 + 中央圆形穹顶 ——
  const mx = -166, mz = 212, my = dy(mx, mz);
  b.push(mx, my, mz, 0);
  b.box('stone', -40, -0.3, -40, 40, 4.0, 40, 0xcfcac0, { skip: 'bottom' });
  b.push(0, 0, 40, 0);
  steps(b, { w: 22, h: 4.0, y0: 0, color: 0xd6d0c4 });
  b.pop();
  if (b.detail >= 1) balustrade(b, [[-12, 4, 39.6], [-39.6, 4, 39.6], [-39.6, 4, -39.6], [39.6, 4, -39.6], [39.6, 4, 39.6], [12, 4, 39.6]], { kind: 'stone', h: 0.9, color: 0xd9d4ca });
  whiteBlock(b, { w: 58, d: 58, h: 9.5, y0: 4.0, floors: 2, bay: 5.2, seed: 11, color: 0xe9e5dc });
  roof(b, { type: 'band', w: 58, d: 58, top: 11, y: 13.9, overhang: 2.6, style: 'tang', color: 'darkgray' });
  b.cyl('plaster', 0, 13.5, 0, 15.5, 15.5, 7.5, 40, 0xece8e0);
  if (b.detail >= 1) {
    // 圆鼓座窗带
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      b.push(Math.sin(a) * 15.52, 0, Math.cos(a) * 15.52, a);
      glowQuad(b, -1.3, 1.3, 16.2, 19.6, 0, k % 3 ? 0.7 : 0.3, 0x3a4248);
      b.pop();
    }
  }
  b.cyl('paint', 0, 21.0, 0, 16.3, 16.3, 0.6, 40, 0x6e7176);
  const prof = [];
  for (let k = 0; k <= 10; k++) {
    const a = (k / 10) * (Math.PI / 2);
    prof.push([Math.max(0.01, 15.8 * Math.cos(a)), 21.6 + 5.5 * Math.sin(a)]);
  }
  b.lathe('metal', prof, 40, 0x8b9096);
  b.pop();
  return { topY: info.topY, labelY: info.topY + 6 };
}

/** 丹凤门（遗址保护展示建筑） */
function buildDanfeng(b) {
  const r = danfengGate(b, {});
  // 门前遗址广场：石狮一对、灯笼
  if (b.detail >= 1) {
    for (const s of [1, -1]) for (let k = 0; k < 3; k++) lantern(b, s * (20 + k * 12), 5.5, 18.5, { kind: 'palace', size: 1.0 });
  }
  return { topY: r.topY, labelY: r.topY + 5 };
}

/** 含元殿遗址 + 宣政殿/紫宸殿遗址 + 宫墙遗址 */
function buildHanyuan(b, env) {
  const dy = env.dy;
  // 含元殿大台（三层）：底台 130×70、二台 96×52、殿基 80×44；总高约 11.5 m
  const top = ruinTerrace(b, [{ w: 132, d: 72, h: 4.2, z: 0 }, { w: 98, d: 54, h: 4.0, z: -5 }, { w: 80, d: 44, h: 3.3, z: -7 }]);
  const xs = [], zs = [];
  for (let i = -5; i <= 5; i++) xs.push(i * 6.2);
  for (let j = 0; j < 4; j++) zs.push(-7 - 13.5 + j * 9);
  columnBases(b, xs, zs, top, { r: 0.85 });
  // 殿基顶面：示意性的夯土墙基残段
  if (b.detail >= 1) {
    earthWall(b, [-34, -27], [34, -27], { h: 0.9, t: 1.6, y0: top });
    earthWall(b, [-34, -27], [-34, 10], { h: 0.9, t: 1.6, y0: top });
    earthWall(b, [34, -27], [34, 10], { h: 0.9, t: 1.6, y0: top });
  }
  // 翔鸾阁、栖凤阁（三出阙阙台）
  for (const s of [1, -1]) {
    const x = s * 94, z = 40;
    b.push(x, dy(1573 + x, -3130 + z) - dy(1573, -3130), z, 0);
    ruinTerrace(b, [{ w: 30, d: 26, h: 5.2 }, { w: 22, d: 19, h: 4.0, x: -s * 2 }, { w: 14, d: 12, h: 3.0, x: -s * 3 }]);
    b.pop();
    // 飞廊夯土基（大台 → 阙台）
    earthWall(b, [s * 66, 10], [s * 94, 10], { h: 5.5, t: 7 });
    earthWall(b, [s * 94, 10], [s * 94, 27], { h: 5.5, t: 7 });
  }
  // 龙尾道：三条坡道自大台南缘下至广场
  for (const x of [-16, 0, 16]) {
    const w = x === 0 ? 7 : 5, z0 = 36, z1 = 112, h = 4.2;
    const c = 0x9f8d70;
    b.quad('stone', [x - w / 2, 0.05, z1], [x + w / 2, 0.05, z1], [x + w / 2, h, z0], [x - w / 2, h, z0], c);
    b.quad('plaster', [x + w / 2, 0, z1], [x + w / 2, 0, z0], [x + w / 2, h, z0], [x + w / 2, 0.05, z1], 0xa88d6c);
    b.quad('plaster', [x - w / 2, 0, z0], [x - w / 2, 0, z1], [x - w / 2, 0.05, z1], [x - w / 2, h, z0], 0xa88d6c);
    if (b.detail >= 1) {
      balustrade(b, [[x - w / 2 + 0.2, 0.05, z1], [x - w / 2 + 0.2, h, z0]], { kind: 'stone', h: 0.9, color: 0xc2b8a6 });
      balustrade(b, [[x + w / 2 - 0.2, 0.05, z1], [x + w / 2 - 0.2, h, z0]], { kind: 'stone', h: 0.9, color: 0xc2b8a6 });
    }
  }
  // 宣政殿、紫宸殿遗址（低台 + 础石）
  const site = (x, z, w, d, nx, nz, sp) => {
    const y = dy(1573 + x, -3130 + z) - dy(1573, -3130);
    b.push(x, y, z, 0);
    const t = ruinTerrace(b, [{ w, d, h: 1.4 }]);
    const cx = [], cz = [];
    for (let i = 0; i < nx; i++) cx.push((i - (nx - 1) / 2) * sp);
    for (let j = 0; j < nz; j++) cz.push((j - (nz - 1) / 2) * sp);
    columnBases(b, cx, cz, t, { r: 0.7 });
    b.pop();
  };
  site(-2, -334, 74, 40, 12, 5, 5.8);
  site(-3, -513, 54, 32, 9, 4, 5.8);
  // 宫墙遗址：宣政殿横墙、宣政—紫宸院落墙
  const W = (x0, z0, x1, z1) => earthWall(b, [x0, z0], [x1, z1], { h: 1.8, t: 3.4, y0: dy(1573 + (x0 + x1) / 2, -3130 + (z0 + z1) / 2) - dy(1573, -3130) });
  W(-373, -332, -40, -332);
  W(40, -332, 257, -332);
  W(-74, -492, -74, -356);
  W(65, -492, 65, -356);
  W(-74, -492, -12, -492);
  W(12, -492, 65, -492);
  return { topY: top, labelY: top + 14 };
}

/** 陕西历史博物馆：中央殿堂、四隅崇楼、东西翼、南门、回廊 */
function buildShanbo(b) {
  const T = { style: 'tang', roofColor: 'darkgray', pal: PAL_SHANBO };
  // 院落铺地
  b.box('stone', -84, -0.3, -80, 84, 0.12, 92, 0xcdc7bb, { skip: 'bottom' });
  // 北侧附楼（现代平顶）
  b.push(0, 0, -100, 0);
  whiteBlock(b, { w: 96, d: 24, h: 13, floors: 3, seed: 5 });
  b.pop();
  // 中央殿堂：两层白色台体 + 重檐庑殿
  b.push(0, 0, -36, 0);
  whiteBlock(b, { w: 62, d: 44, h: 7.5, floors: 2, seed: 7 });
  b.push(0, 7.5, 0, 0, 1.25);
  hall(b, { ...T, bays: 9, bayW: 4.6, depthBays: 5, depthW: 4.4, colH: 5.4, eaves: 2, roof: 'wudian', platform: 'plain', platformH: 0.5, steps: 'none', front: 'tang', back: 'zhiling', sides: 'zhiling' });
  b.pop();
  b.pop();
  // 前殿（中央殿堂南侧的门殿）
  b.push(0, 0, 4, 0);
  hall(b, { ...T, bays: 7, bayW: 5.0, depthBays: 3, depthW: 4.6, colH: 5.6, roof: 'wudian', platform: 'brick', platformH: 1.2, front: 'tang', back: 'tang', sides: 'zhiling', plaque: '陕西历史博物馆', plaqueVertical: false, steps: 'front' });
  b.pop();
  // 四隅崇楼：方形白台 + 重檐庑殿
  for (const sx of [1, -1])
    for (const sz of [1, -1]) {
      b.push(sx * 60, 0, sz * 60, 0);
      whiteBlock(b, { w: 30, d: 30, h: 9, floors: 2, seed: 20 + sx + sz * 3 });
      b.push(0, 9, 0, 0);
      hall(b, { ...T, bays: 5, bayW: 4.3, depthBays: 5, depthW: 4.3, colH: 4.6, eaves: 2, roof: 'wudian', platform: 'plain', platformH: 0.4, steps: 'none', front: 'zhiling', back: 'zhiling', sides: 'zhiling' });
      b.pop();
      b.pop();
    }
  // 东西翼（南北向长楼，单檐庑殿）
  for (const s of [1, -1]) {
    b.push(s * 61, 0, 0, s * Math.PI / 2);
    // 局部正面朝院内（-X 侧 → 旋转后朝 ±X），长向沿局部 X
    whiteBlock(b, { w: 88, d: 26, h: 8, floors: 2, seed: 30 + s });
    b.push(0, 8, 0, 0);
    hall(b, { ...T, bays: 13, bayW: 5.8, depthBays: 3, depthW: 5.6, colH: 4.4, roof: 'wudian', platform: 'plain', platformH: 0.35, steps: 'none', front: 'zhiling', back: 'zhiling', sides: 'wall' });
    b.pop();
    b.pop();
  }
  // 南门 + 回廊
  b.push(0, 0, 80, 0);
  hall(b, { ...T, bays: 5, bayW: 5.2, centerW: 6.0, depthBays: 2, depthW: 5.0, colH: 5.2, roof: 'wudian', platform: 'brick', platformH: 1.0, front: 'tang', back: 'open', sides: 'wall', steps: 'frontback' });
  b.pop();
  corridor(b, [[-44, 80], [-15, 80]], { style: 'tang', w: 4, colH: 3.4, roof: 'xuanshan', roofColor: 'darkgray', pal: PAL_SHANBO });
  corridor(b, [[15, 80], [44, 80]], { style: 'tang', w: 4, colH: 3.4, roof: 'xuanshan', roofColor: 'darkgray', pal: PAL_SHANBO });
  // 门前广场灯笼柱
  if (b.detail >= 1) for (const s of [1, -1]) for (let k = 0; k < 4; k++) lantern(b, s * (12 + k * 9), 3.4, 96, { kind: 'palace', size: 0.8 });
  return { topY: 34, labelY: 42 };
}

/** 西安站：北站房（朝北）+ 高架候车室 + 南站房（朝南） */
function buildStation(b) {
  // 北站房：唐风重檐庑殿（放大 3 倍的比例模型，保持构件比例），正面朝北
  b.push(0, 0, 0, Math.PI, 3);
  const n = hall(b, { style: 'tang', bays: 13, bayW: 3.6, depthBays: 4, depthW: 3.3, colH: 4.4, eaves: 2, roof: 'wudian', roofColor: 'darkgray', pal: PAL_STATION, platform: 'plain', platformH: 0.35, steps: 'none', front: 'open', back: 'open', sides: 'open', plaque: '西安站', plaqueVertical: false });
  // 柱网内玻璃幕墙
  const gw = n.W / 2 - 0.9, gd = n.D / 2 - 0.9;
  b.box('hglass', -gw, n.platformTop, -gd, gw, n.colTop - 0.5, gd, 0xffffff, { skip: 'bottom' });
  b.pop();
  // 高架候车室（跨线）：玻璃体 + 大屋面
  b.box('hglass', -64, 9, 32, 64, 21, 222, 0xffffff, { skip: 'bottom' });
  if (b.detail >= 1) for (let x = -60; x <= 60; x += 20) for (let z = 40; z <= 216; z += 22) b.box('paint', x - 0.8, 0, z - 0.8, x + 0.8, 9, z + 0.8, 0x9a9690, { skip: 'bottom' });
  b.push(0, 21, 127, 0, 4);
  roof(b, { type: 'wudian', w: 32.5, d: 48, y: 0.15, overhang: 0.9, style: 'tang', color: 'gray', pitch: 0.2 });
  b.pop();
  // 南站房：唐风中央重檐 + 两翼单檐，朝南
  b.push(5, 0, 256, 0, 2);
  const s = hall(b, { style: 'tang', bays: 9, bayW: 3.4, depthBays: 4, depthW: 3.2, colH: 4.2, eaves: 2, roof: 'wudian', roofColor: 'darkgray', pal: PAL_STATION, platform: 'plain', platformH: 0.4, steps: 'front', front: 'tang', back: 'zhiling', sides: 'zhiling', plaque: '西安', plaqueVertical: false });
  for (const sx of [1, -1]) {
    b.push(sx * 27, 0, 1.5, 0);
    hall(b, { style: 'tang', bays: 5, bayW: 3.2, depthBays: 3, depthW: 3.0, colH: 3.6, roof: 'wudian', roofColor: 'darkgray', pal: PAL_STATION, platform: 'plain', platformH: 0.4, steps: 'none', front: 'zhiling', back: 'wall', sides: 'wall' });
    b.pop();
  }
  b.pop();
  return { topY: n.topY * 3, labelY: n.topY * 3 + 6, south: s };
}

/** 兴庆宫公园：沉香亭（重檐四角攒尖）+ 花萼相辉楼式二层楼阁 */
function buildXingqing(b, env) {
  const dy = env.dy;
  // 沉香亭（相对原点 +168, 0）
  b.push(168, dy(3533, 662) - dy(3365, 663), -1, 0);
  b.box('stone', -14, -0.3, -14, 14, 2.4, 14, 0xcfc9bd, { skip: 'bottom' });
  b.push(0, 0, 14, 0);
  steps(b, { w: 5, h: 2.4, y0: 0 });
  b.pop();
  if (b.detail >= 1) balustrade(b, [[3, 2.4, 13.7], [13.7, 2.4, 13.7], [13.7, 2.4, -13.7], [-13.7, 2.4, -13.7], [-13.7, 2.4, 13.7], [-3, 2.4, 13.7]], { kind: 'stone', h: 0.9 });
  pavilion(b, { sides: 4, size: 9, colH: 4.4, eaves: 2, roofColor: 'green', style: 'ming', y0: 2.4, platformH: 0.6, finial: { h: 2.0, gold: true } });
  b.pop();
  // 湖南岸楼阁：二层，重檐歇山
  multiStoreyTower(b, { style: 'tang', floors: 2, bays: 5, bayW: 4.4, depthBays: 3, depthW: 4.2, colH: 4.4, roof: 'xieshan', topEaves: 1, roofColor: 'darkgray', platform: 'brick', platformH: 1.6, plaque: '花萼相輝樓', balcony: 1.3 });
  return { topY: 22, labelY: 26 };
}

// ───────────── 地标表 ─────────────
const SITES = [
  {
    id: 'xiaoyanta', label: '小雁塔', x: -456, z: 2244, fn: buildXiaoyanta, flood: { color: 0xffc98a, strength: 1.7, height: 46, top: 0.55 },
    flatten: [[-50, -66, 50, 168], [-212, 166, -120, 258]], excl: [[-48, -64, 48, 166], [-210, 168, -122, 256]],
    lights: [[0, 3.5, 16, 0xffc890, 60, 90], [0, 3.5, -16, 0xffc890, 40, 70], [-166, 8, 250, 0xffe0b0, 30, 70]],
  },
  {
    id: 'danfeng', label: '丹凤门', x: 1582, z: -2430, fn: buildDanfeng, flood: { color: 0xffcf96, strength: 1.5, height: 34, top: 0.5 },
    flatten: [[-115, -24, 115, 30]], excl: [[-112, -22, 112, 22]],
    lights: [[0, 1, 30, 0xffd4a0, 80, 120], [-60, 1, 22, 0xffd4a0, 40, 80], [60, 1, 22, 0xffd4a0, 40, 80]],
  },
  {
    id: 'hanyuan', label: '含元殿遗址', x: 1573, z: -3130, fn: buildHanyuan, flood: { color: 0xffc27a, strength: 1.2, height: 14, top: 0.6 },
    flatten: [[-112, -40, 112, 118]], excl: [[-110, -38, 110, 60], [-80, -540, 70, -310]], trees: [[-110, -38, 110, 115]],
    lights: [[0, 12, 25, 0xffc890, 40, 90]],
  },
  {
    id: 'shanbo', label: '陕西历史博物馆', x: 760, z: 3925, fn: buildShanbo, flood: { color: 0xfff0dc, strength: 1.3, height: 34, top: 0.45 },
    flatten: [[-88, -116, 88, 100]], excl: [[-86, -114, 86, 98]],
    lights: [[0, 2, 60, 0xfff0d8, 60, 100], [0, 8, 30, 0xfff0d8, 40, 80]],
  },
  {
    id: 'station', label: '西安站', x: 1450, z: -2232, fn: buildStation, flood: { color: 0xffe4be, strength: 1.2, height: 40, top: 0.5 },
    flatten: [[-80, -40, 80, 30], [-60, 238, 70, 276]], excl: [[-76, -36, 76, 28], [-66, 30, 66, 224], [-56, 240, 66, 274]],
    lights: [[0, 3, -40, 0xffe4c0, 70, 120], [5, 3, 285, 0xffe4c0, 50, 100]],
  },
  {
    id: 'xingqing', label: '兴庆宫公园', x: 3365, z: 663, fn: buildXingqing, flood: { color: 0xffc98a, strength: 1.5, height: 22, top: 0.5 },
    flatten: [[-22, -18, 22, 20], [150, -18, 186, 16]], excl: [[-20, -16, 20, 18], [152, -16, 184, 14]],
    lights: [[0, 2, 18, 0xffc890, 30, 60], [168, 3, 16, 0xffc890, 30, 60]],
  },
];

function rectPts(x, z, r) {
  return [x + r[0], z + r[1], x + r[2], z + r[1], x + r[2], z + r[3], x + r[0], z + r[3]];
}

export default {
  id: 'heritage',
  name: '历史文化地标（小雁塔、大明宫、陕历博、西安站、兴庆宫）',
  prepare(ctx) {
    this.h = {};
    for (const s of SITES) {
      let h0 = null;
      s.flatten.forEach((r, i) => {
        const h = ctx.terrain.addFlatten({ points: rectPts(s.x, s.z, r), height: null, feather: 24 });
        if (i === 0) h0 = h;
      });
      this.h[s.id] = h0;
      for (const r of s.excl) ctx.exclusions.add({ points: rectPts(s.x, s.z, r) }, { buildings: true, trees: true, roads: false });
      for (const r of s.trees || []) ctx.exclusions.add({ points: rectPts(s.x, s.z, r) }, { buildings: false, trees: true, roads: false });
    }
  },
  async build(ctx) {
    const root = new THREE.Group();
    root.name = 'heritage';
    ctx.scene.add(root);
    const glass = new THREE.MeshStandardMaterial({ color: 0x6d7f8c, metalness: 0.75, roughness: 0.12, emissive: 0xffd6a0, emissiveIntensity: 0, vertexColors: true });
    glass.name = 'heritage.glass';
    const glassSeen = new Set();
    const report = {};
    const objs = [];
    const t0 = performance.now();
    for (const s of SITES) {
      const ts = performance.now();
      try {
        const h0 = this.h?.[s.id] ?? ctx.terrain.heightAt(s.x, s.z);
        const env = { dy: (x, z) => (Math.abs(x) < 5000 && Math.abs(z) < 5000 && Math.hypot(x, z) < 600 ? ctx.terrain.heightAt(s.x + x, s.z + z) - h0 : ctx.terrain.heightAt(x, z) - h0) };
        // dy 约定：小坐标（|x|,|z| < 600）视为局部偏移；否则视为世界坐标
        let info = null;
        const lod = new THREE.LOD();
        for (const [detail, dist] of LEVELS) {
          const b = new ArchBuilder(ctx, { detail, style: 'tang', name: s.id });
          const r = s.fn(b, env);
          info = info || r;
          const g = b.build({ flood: { ...s.flood, baseY: h0 + 0.5 }, name: s.id + '@' + detail, materials: { hglass: glass } });
          g.traverse((m) => {
            if (m.isMesh && m.name === 'hglass' && !glassSeen.has(m.material)) {
              glassSeen.add(m.material);
              ctx.night.register(m.material, { day: 0, night: 0.55 });
            }
          });
          lod.addLevel(g, dist);
        }
        lod.addLevel(new THREE.Object3D(), HIDE);
        lod.position.set(s.x, h0, s.z);
        lod.name = 'heritage:' + s.id;
        root.add(lod);
        objs.push(lod);
        if (s.label) ctx.labels.add(s.label, new THREE.Vector3(s.x, h0 + (info?.labelY ?? 30), s.z), { category: 'landmark', priority: 3, maxDist: 6000 });
        for (const [lx, ly, lz, col, intensity, dist] of s.lights || [])
          ctx.lights.add({ position: new THREE.Vector3(s.x + lx, h0 + ly, s.z + lz), color: col, intensity, distance: dist, nightOnly: true, priority: 2 });
        let meshes = 0, tris = 0;
        lod.levels[0].object.traverse((m) => {
          if (!m.isMesh) return;
          meshes++;
          const g = m.geometry;
          tris += (g.index ? g.index.count : g.attributes.position.count) / 3 * (m.isInstancedMesh ? m.count : 1);
        });
        report[s.id] = { meshes, tris: Math.round(tris), ms: Math.round(performance.now() - ts) };
      } catch (e) {
        console.error('[heritage] ' + s.id + ' 构建失败', e);
      }
    }
    report.totalMs = Math.round(performance.now() - t0);
    console.warn('[heritage] ' + JSON.stringify(report));
    if (typeof window !== 'undefined') window.__heritage = report;
    return {
      update() {},
      setLayer(name, on) {
        if (name === 'heritage' || name === 'landmarks') root.visible = on;
      },
      dispose() {
        ctx.scene.remove(root);
      },
    };
  },
};
