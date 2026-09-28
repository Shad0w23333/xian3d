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
import { ArchBuilder, hall, multiStoreyTower, pavilion, corridor, roof, yardWall, balustrade, lantern, lanternPost, stoneLion, steps, glowQuad, latticePanel, eaveLights } from '../arch/chinese.js';
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
  b.cyl('paint', 0, 21.0, 0, 16.3, 16.3, 0.6, 40, 0x6e7176, { bottom: true }); // 檐环底面封口（原先敞口，环与鼓座之间 0.8 m 空隙可透视，整个穹顶悬空）
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
    for (const s of [1, -1]) for (let k = 0; k < 3; k++) lanternPost(b, s * (20 + k * 12), 0, 18.5, 5.5, { kind: 'palace', size: 1.0, yaw: s > 0 ? Math.PI : 0, arm: 0.75 });
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
    const yq = dy(1573 + x, -3130 + z) - dy(1573, -3130);
    earthWall(b, [s * 66, 10], [s * 94, 10], { h: 5.5 + Math.max(0, -yq) + 0.3, t: 7, y0: Math.min(0, yq) - 0.3 });
    earthWall(b, [s * 94, 10], [s * 94, 27], { h: 5.5 + Math.max(0, -yq) + 0.3, t: 7, y0: Math.min(0, yq) - 0.3 });
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
  // 长墙按 ≤ 30 m 分段、逐段贴地（原先整段取中点地面高，300 多米长的墙一头悬空一头埋地）
  const W = (x0, z0, x1, z1) => {
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / 30));
    const g0 = dy(1573, -3130);
    for (let i = 0; i < n; i++) {
      const ax = x0 + ((x1 - x0) * i) / n, az = z0 + ((z1 - z0) * i) / n, bx = x0 + ((x1 - x0) * (i + 1)) / n, bz = z0 + ((z1 - z0) * (i + 1)) / n;
      const ya = dy(1573 + ax, -3130 + az) - g0, yb = dy(1573 + bx, -3130 + bz) - g0, ym = dy(1573 + (ax + bx) / 2, -3130 + (az + bz) / 2) - g0;
      const lo = Math.min(ya, yb, ym), hi = Math.max(ya, yb, ym);
      earthWall(b, [ax, az], [bx, bz], { h: 1.8 + (hi - lo) + 0.3, t: 3.4, y0: lo - 0.3 });
    }
  };
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
  if (b.detail >= 1) for (const s of [1, -1]) for (let k = 0; k < 4; k++) lanternPost(b, s * (12 + k * 9), 0, 96, 3.4, { kind: 'palace', size: 0.8, yaw: s > 0 ? Math.PI : 0 });
  return { topY: 34, labelY: 42 };
}

/**
 * 台基补足：矩形 (x0..x1, z0..z1)（局部，未缩放）下方按地形最低点补一块石基直到 yTop，
 * 平整区羽化带里地面比台基低时，建筑不再悬空。
 */
function footing(b, env, x0, z0, x1, z1, yTop, col = 0xbdb6a8) {
  let lo = Infinity;
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++) lo = Math.min(lo, env.dy(x0 + ((x1 - x0) * i) / 6, z0 + ((z1 - z0) * j) / 6));
  b.box('stone', x0, Math.min(lo, 0) - 0.3, z0, x1, yTop - 0.01, z1, col, { skip: 'bottom' });
}

/**
 * 西安站：北站房（2021 年启用，朝北）+ 高架候车室 + 南站房（1985 年，朝南）。
 * 资料（research/refs/dossiers/north_notes.md，照片 Wikimedia Commons 2023-10 / 2025-09）：
 *  · 北站房：OSM 轮廓 221×61 m、高 24 m；单檐大出檐缓坡屋顶（檐口一道暖黄轮廓灯，檐下深色格构），
 *    米色方柱列柱，柱间深色镂空格栅（夜间透光），正中一间玻璃门厅，上挂红色“西安站”字。
 *  · 南站房：142.8×52 m，檐高 18 m、顶高 27.7 m；米黄墙面、绿色琉璃瓦多重坡檐：中央候车大厅（通高竖窗）
 *    + 两翼三层楼（窗带 + 琉璃檐），首层通长琉璃披檐，入口朱柱门廊，屋顶正中红色“西安”二字。
 * 原模型：唐风重檐庑殿殿堂放大 3 倍（约 140 m 宽、深灰屋面）/ 放大 2 倍，与实物不符。
 */
function buildStation(b, env) {
  const BEIGE = 0xe4d8bf, DARK = 0x34322e;
  // —— 北站房（局部原点 = 站房中心，正面朝北 = -Z） ——
  const NW = 221, ND = 61; // 屋面外廓
  const CW = 211, CD = 51; // 柱中线（出檐 5 m）
  const colTop = 17.2, eaveY = 18.4;
  // 台基（按地形补足，平整区外的两端不悬空）
  footing(b, env, -NW / 2 + 2, -ND / 2 + 1, NW / 2 - 2, ND / 2 - 1, 0.6, 0xc9c3b6);
  // 内部体量（深色，退后 3.5 m）+ 夜间透光窗
  const iw = CW / 2 - 3.5, id = CD / 2 - 3.5;
  b.box('paint', -iw, 0.6, -id, iw, colTop, id, DARK, { skip: 'bottom' });
  // 列柱：前后各 17 根（间距 13.19 m）、两山各 4 根
  const n = 16, sp = CW / n;
  const col = (x, z) => b.box('plaster', x - 0.9, 0.6, z - 0.9, x + 0.9, colTop, z + 0.9, BEIGE, { skip: 'bottom' });
  for (let i = 0; i <= n; i++) for (const z of [-CD / 2, CD / 2]) col(-CW / 2 + i * sp, z);
  for (let j = 1; j < 4; j++) for (const x of [-CW / 2, CW / 2]) col(x, -CD / 2 + (j * CD) / 4);
  // 柱顶圈梁
  b.box('plaster', -CW / 2 - 0.9, colTop, -CD / 2 - 0.9, CW / 2 + 0.9, eaveY, -CD / 2 + 0.9, BEIGE, {});
  b.box('plaster', -CW / 2 - 0.9, colTop + 0.01, CD / 2 - 0.9, CW / 2 + 0.9, eaveY - 0.01, CD / 2 + 0.9, BEIGE, {});
  b.box('plaster', -CW / 2 - 0.9, colTop + 0.02, -CD / 2 + 0.9, -CW / 2 + 0.9, eaveY - 0.02, CD / 2 - 0.9, BEIGE, {});
  b.box('plaster', CW / 2 - 0.9, colTop + 0.02, -CD / 2 + 0.9, CW / 2 + 0.9, eaveY - 0.02, CD / 2 - 0.9, BEIGE, {});
  // 柱间镂空格栅（前后立面，正中三间为玻璃门厅）
  const hall0 = -1.5 * sp, hall1 = 1.5 * sp;
  if (b.detail >= 1)
    for (const [zf, yaw] of [[-id, Math.PI], [id, 0]])
      for (let i = 0; i < n; i++) {
        const x0 = -CW / 2 + i * sp + 1.2, x1 = x0 + sp - 2.4;
        if (zf < 0 && x1 > hall0 && x0 < hall1) continue;
        b.push(0, 0, zf, yaw);
        const xa = yaw ? -x1 : x0, xb = yaw ? -x0 : x1;
        latticePanel(b, xa, xb, 3.2, colTop - 1.0, { pattern: 3, cell: 0.9, color: 0x2a2826, lit: i % 3 ? 0.9 : 0.5, paper: 0x4a463e, z: 0.06 });
        b.pop();
      }
  // 玻璃门厅（凸出到柱列线）+ 红字
  b.box('hglass', hall0 + 1.0, 0.6, -CD / 2 + 0.2, hall1 - 1.0, colTop - 0.6, -id, 0xffffff, { skip: 'bottom' });
  if (b.detail >= 1) {
    b.push(0, 0, -CD / 2 + 0.15, Math.PI);
    b.plaque('西安站', 0, colTop - 4.2, 0, 16, 3.6, { bg: '#1c1e22', color: '#e8281c', border: '#1c1e22', serif: false });
    b.pop();
  }
  // 单檐缓坡四坡顶（大出檐 5 m），檐口暖黄轮廓灯
  const r = roof(b, { type: 'wudian', w: CW, d: CD, y: eaveY + 0.2, overhang: 5, pitch: 0.17, style: 'tang', color: 'darkgray', pal: PAL_STATION, ornament: 'none', beasts: 0, ridgeH: 0.6 });
  if (b.detail >= 1) eaveLights(b, { roofs: [r] }, { color: 0xffc46a, width: 0.14, ridges: false });

  // —— 高架候车室（跨线）：玻璃体 + 大屋面 ——
  b.box('hglass', -64, 9, 32, 64, 21, 222, 0xffffff, {}); // 底面封上：立柱顶住底板（原先无底面，从桥下可看穿、立柱也没有顶到任何东西）
  // 高架候车室立柱：柱脚按各自位置的地面高度下探（原先统一 y=0，平整区外的柱脚悬空）
  // （各级 LOD 都做：远景不做立柱时候车室整体悬空）
  for (let x = -60; x <= 60; x += 20) for (let z = 40; z <= 216; z += 22) b.box('paint', x - 0.8, Math.min(0, env.dy(x, z)) - 0.3, z - 0.8, x + 0.8, 9, z + 0.8, 0x9a9690, { skip: 'bottom' });
  b.push(0, 21, 127, 0, 4);
  roof(b, { type: 'wudian', w: 32.5, d: 48, y: 0.15, overhang: 0.9, style: 'tang', color: 'gray', pitch: 0.2 });
  b.pop();

  // —— 南站房（局部原点 (5, 256)，正面朝南 = +Z） ——
  const WALL = 0xeadcae, GREEN = 'green';
  b.push(5, 0, 256, 0);
  const SW = 142.8, SD = 52;
  const cw = 38, cd = 22; // 中央候车大厅半宽/半深（墙面）
  const ww = SW / 2 - 1.6, wd = 20; // 两翼外墙
  footing(b, { dy: (x, z) => env.dy(x + 5, z + 256) }, -ww, -wd, ww, wd, 0.3, 0xc9c3b6);
  // 中央大厅（墙高 18 m）
  b.box('plaster', -cw, 0.3, -cd, cw, 18, cd, WALL, { skip: 'bottom' });
  // 两翼三层楼（墙高 14.5 m）
  for (const s of [-1, 1]) b.box('plaster', s > 0 ? cw - 0.02 : -ww, 0.3, -wd, s > 0 ? ww : -cw + 0.02, 14.5, wd, WALL, { skip: 'bottom' });
  if (b.detail >= 1) {
    for (const [zf, yaw] of [[cd, 0], [-cd, Math.PI]]) {
      b.push(0, 0, zf, yaw);
      // 中央大厅通高竖窗 14 樘
      for (let k = 0; k < 14; k++) {
        const x = -cw + 3.2 + k * ((2 * cw - 6.4) / 13);
        b.box('paint', x - 1.05, 5.6, 0, x + 1.05, 16.6, 0.12, 0x5a5448, { skip: 'bottom' });
        glowQuad(b, x - 0.9, x + 0.9, 5.75, 16.45, 0.14, k % 4 ? 0.6 : 0.35, 0x39444c);
      }
      b.pop();
    }
    // 两翼窗带：三层 × 每翼 7 樘
    for (const s of [-1, 1])
      for (const [zf, yaw] of [[wd, 0], [-wd, Math.PI]]) {
        b.push(0, 0, zf, yaw);
        for (let fl = 0; fl < 3; fl++)
          for (let k = 0; k < 7; k++) {
            const xl = cw + 2.2 + k * ((ww - cw - 4.4) / 6);
            const x = yaw ? -s * xl : s * xl;
            const y0 = 6.8 + fl * 2.6;
            glowQuad(b, x - 0.75, x + 0.75, y0, y0 + 1.9, 0.03, (k + fl) % 3 ? 0.55 : 0.25, 0x39444c);
          }
        b.pop();
      }
  }
  // 屋顶：中央绿琉璃四坡顶（檐 18 m，顶约 27.7 m），两翼绿琉璃四坡顶
  const rc = roof(b, { type: 'wudian', w: 2 * cw, d: 2 * cd, y: 18.5, overhang: 2.2, pitch: 0.32, ridgeH: 0.9, style: 'ming', color: GREEN, ornament: 'wen', beasts: 5 });
  for (const s of [-1, 1]) {
    b.push(s * (cw + (ww - cw) / 2 + 0.6), 0, 0, 0);
    roof(b, { type: 'wudian', w: ww - cw - 1.2, d: 2 * wd, y: 14.9, overhang: 1.6, pitch: 0.3, style: 'ming', color: GREEN, ornament: 'none', beasts: 3 });
    b.pop();
  }
  // 首层琉璃披檐（檐下 5.2 m）：两翼贴翼楼墙面、中央贴大厅墙面，入口门廊处断开（不穿进门廊屋顶/大厅墙体）
  const PX = -18, PH = 8.5; // 门廊中心 x、披檐让开半宽
  const shed = (x0, x1, zf, yaw) => {
    if (x1 - x0 < 0.5) return;
    b.push(0, 0, zf, yaw);
    const a = yaw ? -x1 : x0, c = yaw ? -x0 : x1;
    b.prism('tileFlatGlazed', [[-0.05, 5.95], [-0.05, 5.7], [2.6, 5.1], [2.6, 5.35]], 'x', a, c, 0x2e7446);
    b.box('paint', a, 5.0, 2.55, c, 5.35, 2.72, 0x7a2a1e);
    b.pop();
  };
  for (const [zw, zc, yaw] of [[wd, cd, 0], [-wd, -cd, Math.PI]]) {
    shed(-ww, -cw, zw, yaw);
    shed(cw, ww, zw, yaw);
    if (yaw) shed(-cw, cw, zc, yaw);
    else {
      shed(-cw, PX - PH, zc, yaw);
      shed(PX + PH, cw, zc, yaw);
    }
  }
  // 入口朱柱门廊（绿琉璃歇山），偏西
  b.push(PX, 0, cd + 3.6, 0);
  hall(b, { style: 'ming', bays: 3, bayW: 4.2, depthBays: 1, depthW: 4.6, colH: 5.0, roof: 'xieshan', roofColor: 'green', platform: 'plain', platformH: 0.3, steps: 'none', front: 'open', back: 'open', sides: 'open' });
  b.pop();
  // 屋顶正中红色“西安”：立在正脊上（面朝南）
  if (b.detail >= 1) b.plaque('西安', 0, rc.ridgeY + 2.4, 0.35, 10, 4.2, { bg: '#eadcae', color: '#c4231a', border: '#eadcae' });
  b.pop();
  return { topY: 27.7, labelY: 32 };
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
    // 北站房 221×61 m、南站房 142.8×52 m（北站房原按 140 m 宽的放大殿堂建模，平整/排除范围随之扩大）
    flatten: [[-114, -36, 114, 36], [-72, 228, 82, 284]], excl: [[-112, -34, 112, 34], [-66, 30, 66, 224], [-70, 229, 80, 283]],
    lights: [[0, 3, -44, 0xffe4c0, 70, 120], [5, 3, 290, 0xffe4c0, 50, 100]],
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
