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
import { ArchBuilder, hall, multiStoreyTower, pavilion, corridor, roof, yardWall, balustrade, lantern, lanternPost, stoneLion, steps, glowQuad, latticePanel, eaveLights, getKit } from '../arch/chinese.js';
import { denseEavePagoda, danfengGate, ruinTerrace, columnBases, earthWall, whiteBlock, roofMaterials, NeutralSkyMaterial } from '../arch/heritage-parts.js';
import { pavedGround } from '../arch/landmark-ground.js';

const LEVELS = [[2, 0], [1, 260], [0, 750]];
const HIDE = 9000; // 超过此距离整组隐藏（远景由通用建筑/影像承担）

// 陕历博配色：灰瓦白墙、浅灰柱与斗拱
const PAL_SHANBO = {
  col: 0xd6d1c7, colBase: 0xc9c3b8, wall: 0xf0ece4, frame: 0x6a645c, door: 0x5a554e, lattice: 0x5e5850,
  dou: 0xcfc9be, gong: 0xcac4b8, ang: 0xcac4b8, armEnd: 0xe6e2da, panel: 0xeeeae2, rafter: 0xc8c2b6, rafterEnd: 0xe6e2da,
  flyEnd: 0xe6e2da, soffit: 0xbcb6aa, fascia: 0xcfc9bd, stone: 0xd9d4ca, gable: 0xeeeae2, boFeng: 0xcfc9bd, railing: 0xd6d1c7,
  beamRow: 3, plankRow: 3,
};
// 荐福寺殿宇瓦面：中性略暖的灰筒瓦
const TEMPLE_ROOF = { tile: 0x8f8b84, tube: 0x88847d, ridge: 0x54514c, glazed: false };
// 西安站屋面：中性灰瓦（'darkgray'/'gray' 在晴天天光下读成海军蓝）
const STATION_ROOF = { tile: 0xa3a09a, tube: 0x9c9993, ridge: 0x605d58, glazed: false };
// 西安站：灰瓦、深灰钢柱、浅灰斗拱
const PAL_STATION = {
  ...PAL_SHANBO, col: 0x8e8a84, frame: 0x55595c, dou: 0xb9b4aa, gong: 0xb3aea4, ang: 0xb3aea4, rafter: 0xa9a49a, soffit: 0xa6a196, fascia: 0xb3aea4,
};

// ───────────── 各地标构建函数（局部坐标，原点 = 地标中心，+Z 南） ─────────────

/** 小雁塔 + 荐福寺 + 西安博物院 */
function buildXiaoyanta(b, env) {
  const dy = env.dy; // (x,z) → 相对原点的地面高差
  const info = denseEavePagoda(b, { floors: 13, baseW: 11.38, firstH: 6.83, totalH: 40.2, topW: 0.5 });
  // 荐福寺中轴（明清官式，灰瓦朱柱）：瓦面用中性略暖的灰（'darkgray' 偏蓝，天光下读成藏青），
  // 台基青灰砖 / 灰石（默认须弥座 0xe2ddd2 近白，像白塑料台座）
  const M = { style: 'ming', roofColor: TEMPLE_ROOF, platformColor: 0xa29d94, platformCap: 0x98938a };
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
    hall(b, { ...M, bays: 1, bayW: 4.6, depthBays: 1, depthW: 4.6, colH: 3.4, roof: 'xieshan', platform: 'brick', platformH: 3.4, platformMargin: 1.6, steps: 'none', front: 'doors', back: 'doors', sides: 'doors', plaque: name, plaqueVertical: false, platformColor: 0x6f6c67, platformCap: 0x88847c });
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
  // 甬道（青灰条石）
  b.box('stone', -2.2, wy - 0.3, 14, 2.2, wy + 0.08, 158, 0x9c978e, { skip: 'bottom' });
  // 院内草坪（甬道两侧、塔院两侧；古树由植被模块在草坪与院落空地上种，见 SITES.trees 的避让区）
  for (const s of [1, -1]) {
    for (const [a, c, z0, z1] of [[7, 36, 84, 118], [7, 36, 137, 151], [16, 37, -26, 24]]) {
      const x0 = s > 0 ? a : -c, x1 = s > 0 ? c : -a;
      b.box('hgrass', x0, wy - 0.3, z0, x1, wy + 0.05, z1, 0xffffff, { skip: 'bottom' });
    }
  }
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
  // 院落铺地：改由 SITES.paving 贴地花岗岩分格铺装（原先 0xcdc7bb 纯色石板，阳光下过曝成白板，审查 g6）
  // 前院草坪（卫星：前殿与南门之间、中轴甬道两侧各一块，花岗岩路缘 + 草坪）
  for (const sx of [-1, 1]) {
    const xa = sx * 9, xb = sx * 25, x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
    b.box('stone', x0 - 0.3, -0.2, 34.7, x1 + 0.3, 0.32, 55.3, 0xb9b4aa, { skip: 'bottom' });
    b.box('hgrass', x0, 0.2, 35, x1, 0.34, 55, 0xffffff, { skip: 'bottom' });
  }
  // 北侧附楼（现代平顶，办公库房：保留成排窗）
  b.push(0, 0, -100, 0);
  whiteBlock(b, { w: 96, d: 24, h: 13, floors: 3, seed: 5, winRate: 0.6, joints: 1.6 });
  b.pop();
  // 中央殿堂：两层白色台体 + 重檐庑殿（台体以素白实墙为主：少量窗 + 石材分缝）
  b.push(0, 0, -36, 0);
  whiteBlock(b, { w: 62, d: 44, h: 7.5, floors: 1, seed: 7, winRate: 0.15, joints: 1.5 });
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
      whiteBlock(b, { w: 30, d: 30, h: 9, floors: 1, seed: 20 + sx + sz * 3, winRate: 0.12, joints: 1.5 });
      b.push(0, 9, 0, 0);
      hall(b, { ...T, bays: 5, bayW: 4.3, depthBays: 5, depthW: 4.3, colH: 4.6, eaves: 2, roof: 'wudian', platform: 'plain', platformH: 0.4, steps: 'none', front: 'zhiling', back: 'zhiling', sides: 'zhiling' });
      b.pop();
      b.pop();
    }
  // 东西翼（南北向长楼，单檐庑殿）
  for (const s of [1, -1]) {
    b.push(s * 61, 0, 0, s * Math.PI / 2);
    // 局部正面朝院内（-X 侧 → 旋转后朝 ±X），长向沿局部 X
    whiteBlock(b, { w: 88, d: 26, h: 8, floors: 1, seed: 30 + s, winRate: 0.2, joints: 1.5 });
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
/**
 * 南广场的两处下沉采光井（影像：南站房与北城墙之间，x -64~-15 / 8~60、z 320~356）：花岗岩矮墙（浅色压顶 + 不锈钢扶手）
 * + 沿墙绿篱 + 双坡玻璃采光顶（映天光的玻璃 + 2.4 m × 3 m 铝合金分格 + 屋脊）。
 * 原先玻璃是不反光的暗青灰、竖梃 0.14 m，60 m 外读成两块深灰平板（审查 g5）。
 */
function lightWells(b, env) {
  for (const [x0, x1, z0, z1] of [[-64, -15, 320, 356], [8, 60, 319, 356]]) {
    const y = Math.max(env.dy(x0, z0), env.dy(x1, z0), env.dy(x0, z1), env.dy(x1, z1));
    const H = 0.95, t = 0.45;
    const WALL = 0xb9b3a8, CAP = 0xdcd7cc;
    // 矮墙（四边）+ 压顶
    b.box('stone', x0, y - 0.6, z0, x1, y + H, z0 + t, WALL, { skip: 'bottom', colors: { top: CAP } });
    b.box('stone', x0, y - 0.6, z1 - t, x1, y + H, z1, WALL, { skip: 'bottom', colors: { top: CAP } });
    b.box('stone', x0, y - 0.6, z0 + t, x0 + t, y + H, z1 - t, WALL, { skip: 'bottom', colors: { top: CAP } });
    b.box('stone', x1 - t, y - 0.6, z0 + t, x1, y + H, z1 - t, WALL, { skip: 'bottom', colors: { top: CAP } });
    if (b.detail >= 1) {
      // 不锈钢扶手：每 2 m 一根立杆 + 顶部扶手
      const rail = [[x0 + t / 2, z0 + t / 2], [x1 - t / 2, z0 + t / 2], [x1 - t / 2, z1 - t / 2], [x0 + t / 2, z1 - t / 2], [x0 + t / 2, z0 + t / 2]];
      b.sweep('metal', rail.map(([x, z]) => [x, y + H + 1.0, z]), [[-0.03, -0.03], [0.03, -0.03], [0.03, 0.03], [-0.03, 0.03]], 0xc8cacc, { caps: false });
      for (let k = 0; k < 4; k++) {
        const [ax, az] = rail[k], [bx, bz] = rail[k + 1];
        const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 2));
        for (let i = 0; i < n; i++) {
          const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n;
          b.box('metal', x - 0.025, y + H, z - 0.025, x + 0.025, y + H + 1.0, z + 0.025, 0xc8cacc);
        }
      }
    }
    // 墙内一圈绿篱
    b.box('hgrass', x0 + t, y - 0.3, z0 + t, x1 - t, y + H - 0.1, z0 + t + 1.2, 0xffffff, { skip: 'bottom' });
    b.box('hgrass', x0 + t, y - 0.3, z1 - t - 1.2, x1 - t, y + H - 0.1, z1 - t, 0xffffff, { skip: 'bottom' });
    // 双坡玻璃采光顶（中间高 0.6 m）：映天光的玻璃（hwell，夜间透出下沉空间的暖光）
    const gx0 = x0 + t + 1.2, gx1 = x1 - t - 1.2, gz0 = z0 + t + 1.2, gz1 = z1 - t - 1.2, zm = (gz0 + gz1) / 2;
    const R = 0.6;
    // （quad 法线 = (b−a)×(d−a)：先沿 z、再沿 x 才朝上；hglass 为单面材质）
    b.quad('hwell', [gx0, y + H, gz0], [gx0, y + H + R, zm], [gx1, y + H + R, zm], [gx1, y + H, gz0], 0xffffff);
    b.quad('hwell', [gx0, y + H + R, zm], [gx0, y + H, gz1], [gx1, y + H, gz1], [gx1, y + H + R, zm], 0xffffff);
    b.box('hcpaint', gx0, y - 0.3, gz0, gx1, y + H - 0.02, gz1, 0x3a3e42, { skip: 'bottom' });
    // 分格：沿 x 每 2.4 m 一道竖梃（两坡）、沿 z 每 3 m 一道横档；屋脊与四周边框
    const MC = 0x5c6164, mw = 0.13, mh = 0.09; // 深灰铝框（浅色框 + 蓝玻璃读成太阳能板）
    const ym = (z) => y + H + R * (1 - Math.abs(z - zm) / (zm - gz0));
    const nm = Math.max(4, Math.round((gx1 - gx0) / 2.4));
    for (let k = 0; k <= nm; k++) {
      const x = gx0 + ((gx1 - gx0) * k) / nm;
      for (const [za, zb] of [[gz0, zm], [zm, gz1]]) b.quad('hcpaint', [x - mw, ym(za) + mh, za], [x - mw, ym(zb) + mh, zb], [x + mw, ym(zb) + mh, zb], [x + mw, ym(za) + mh, za], MC);
    }
    const nzm = Math.max(2, Math.round((zm - gz0) / 3));
    for (let j = 0; j <= nzm; j++)
      for (const z of [gz0 + ((zm - gz0) * j) / nzm, gz1 - ((gz1 - zm) * j) / nzm]) b.quad('hcpaint', [gx0, ym(z) + mh, z - mw], [gx0, ym(z) + mh, z + mw], [gx1, ym(z) + mh, z + mw], [gx1, ym(z) + mh, z - mw], MC);
    b.box('hcpaint', gx0, y + H + R - 0.02, zm - 0.18, gx1, y + H + R + 0.16, zm + 0.18, MC, { skip: 'bottom' });
    b.box('hcpaint', gx0 - 0.2, y + H - 0.15, gz0 - 0.2, gx1 + 0.2, y + H + 0.08, gz0 + 0.1, MC, { skip: 'bottom' });
    b.box('hcpaint', gx0 - 0.2, y + H - 0.15, gz1 - 0.1, gx1 + 0.2, y + H + 0.08, gz1 + 0.2, MC, { skip: 'bottom' });
  }
}

/**
 * 西安站站台雨棚（2021 年改扩建后）：每座站台一片独立雨棚（卫星：x 1182~1384 / 1522~1736、z -2201~-2004 呈东西向条带），
 * 缓拱金属屋面（直立锁边板缝贴图）+ 屋脊采光带 + 檐口封边 + 站台中线一排 Y 形钢柱；股道上方留出约 5 m 天光缝。
 * 站台位置按 rail.json 股道求出（相邻股道间距 > 10 m 处为岛式站台），雨棚两端各取一次，跟随股道的微小斜度。
 * 原先两侧各一整块 180 m 见方的平板（低空看就是一块灰色占位平面，审查 g5/g6）。
 */
function canopies(b, env) {
  const rail = (env.data?.rail?.features || []).filter((f) => f.c === 0 && !f.t);
  const SX = env.sx, SZ = env.sz;
  // 世界 X 处的股道（局部 z，升序）
  const tracksAt = (X) => {
    const zs = [];
    for (const f of rail) {
      const p = f.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        if ((ax - X) * (bx - X) > 0 || ax === bx) continue;
        const z = az + ((bz - az) * (X - ax)) / (bx - ax) - SZ;
        if (z > 20 && z < 232) zs.push(z);
      }
    }
    return zs.sort((a, b) => a - b);
  };
  // 站台条带 [z 下沿, z 上沿]：岛式站台 = 相邻股道间距 > 10 m；北侧基本站台（北站房檐下 → 第一股道）、南侧基本站台（末股道 → 222）
  const strips = (X) => {
    const t = tracksAt(X);
    const out = [];
    if (!t.length) return out;
    if (t[0] > 36) out.push([31.5, t[0] - 0.4]);
    for (let i = 0; i + 1 < t.length; i++) if (t[i + 1] - t[i] > 10) out.push([t[i] + 0.25, t[i + 1] - 0.25]);
    if (t[t.length - 1] < 214) out.push([t[t.length - 1] + 0.4, 222]);
    return out;
  };
  const Y = 7.8, RISE = 0.85, NS = 6;
  for (const [x0, x1] of [[-262, -68], [74, 284]]) {
    const A = strips(SX + x0 + 3), B = strips(SX + x1 - 3);
    if (!A.length) continue;
    for (let k = 0; k < A.length; k++) {
      const a = A[k];
      // 另一端：取中心最近的条带
      const cA = (a[0] + a[1]) / 2;
      let bb = B[0];
      for (const q of B) if (Math.abs((q[0] + q[1]) / 2 - cA) < Math.abs((bb[0] + bb[1]) / 2 - cA)) bb = q;
      if (!bb || Math.abs((bb[0] + bb[1]) / 2 - cA) > 6) bb = a;
      const ym = Math.max(env.dy(x0, cA), env.dy(x1, cA), env.dy((x0 + x1) / 2, cA)) + Y;
      const w0 = a[1] - a[0];
      // 横截面：u∈[0,1] 从北檐到南檐，高度为抛物线拱
      const P = (x, end, u, dy = 0) => {
        const e = end ? bb : a;
        const z = e[0] + (e[1] - e[0]) * u;
        return [x, ym + RISE * 4 * u * (1 - u) * Math.min(1, w0 / 12) + dy, z];
      };
      const uv = (q) => [q[0], q[2]];
      for (let i = 0; i < NS; i++) {
        const u0 = i / NS, u1 = (i + 1) / NS;
        const ridge = i === NS / 2 - 1 || i === NS / 2;
        const q = [P(x0, 0, u0), P(x0, 0, u1), P(x1, 1, u1), P(x1, 1, u0)];
        // 屋面（朝上：从上看逆时针 = 北 → 南 → 东）
        b.quad(ridge && w0 > 9 ? 'hskylight' : 'hcanopy', q[0], q[1], q[2], q[3], 0xffffff, q.map(uv));
        // 底面（吊顶，浅灰铝板）
        const d = [P(x0, 0, u0, -0.32), P(x1, 1, u0, -0.32), P(x1, 1, u1, -0.32), P(x0, 0, u1, -0.32)];
        b.quad('hcpaint', d[0], d[1], d[2], d[3], 0xb4b2ac);
      }
      // 檐口封边（南北两条）与两端封板
      for (const u of [0, 1]) {
        const s = u ? 1 : -1;
        const o0 = P(x0, 0, u), o1 = P(x1, 1, u);
        const q = [[o0[0], o0[1] - 0.55, o0[2] + s * 0.04], [o1[0], o1[1] - 0.55, o1[2] + s * 0.04], [o1[0], o1[1] + 0.12, o1[2] + s * 0.04], [o0[0], o0[1] + 0.12, o0[2] + s * 0.04]];
        if (s > 0) b.quad('hcpaint', q[0], q[1], q[2], q[3], 0xd6d4ce);
        else b.quad('hcpaint', q[1], q[0], q[3], q[2], 0xd6d4ce);
      }
      for (const [xe, end, sx] of [[x0, 0, -1], [x1, 1, 1]]) {
        for (let i = 0; i < NS; i++) {
          const t0 = P(xe, end, i / NS), t1 = P(xe, end, (i + 1) / NS);
          const q = [[xe, t0[1] - 0.55, t0[2]], [xe, t1[1] - 0.55, t1[2]], [xe, t1[1] + 0.12, t1[2]], [xe, t0[1] + 0.12, t0[2]]];
          if (sx > 0) b.quad('hcpaint', q[1], q[0], q[3], q[2], 0xd6d4ce);
          else b.quad('hcpaint', q[0], q[1], q[2], q[3], 0xd6d4ce);
        }
      }
      // Y 形钢柱：沿站台中线每 21 m 一根（窄条带只立直柱）
      if (b.detail >= 1 || k % 2 === 0) {
        for (let x = x0 + 9; x <= x1 - 6; x += 21) {
          const t = (x - x0) / (x1 - x0);
          const zc = (a[0] + a[1]) / 2 + ((bb[0] + bb[1]) / 2 - (a[0] + a[1]) / 2) * t;
          const wz = (a[1] - a[0]) + ((bb[1] - bb[0]) - (a[1] - a[0])) * t;
          const g = Math.min(0, env.dy(x, zc)) - 0.3;
          const yk = ym - 1.9;
          b.box('hcpaint', x - 0.28, g, zc - 0.28, x + 0.28, yk, zc + 0.28, 0xc9c7c1, { skip: 'bottom' });
          if (wz > 9 && b.detail >= 1) {
            const arm = Math.min(4.6, wz * 0.32);
            for (const s of [-1, 1]) b.sweep('hcpaint', [[x, yk - 0.1, zc], [x, ym + 0.2, zc + s * arm]], [[-0.16, -0.16], [0.16, -0.16], [0.16, 0.16], [-0.16, 0.16]], 0xc9c7c1, { caps: true });
          }
        }
      }
    }
  }
}

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
  // 内侧玻璃幕墙（映天光；原先一个近黑方盒，柱间看着是黑洞，审查 g6）
  b.box('hglass', -iw, 0.6, -id, iw, colTop, id, 0xffffff, { skip: 'bottom' });
  b.box('paint', -iw + 0.3, colTop - 0.02, -id + 0.3, iw - 0.3, colTop + 0.4, id - 0.3, DARK, { skip: 'bottom' });
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
        latticePanel(b, xa, xb, 3.2, colTop - 1.0, { pattern: 3, cell: 0.9, color: 0x3c3a37, lit: i % 3 ? 0.9 : 0.5, paper: 0x6b7276, z: 0.06 });
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
  const r = roof(b, { type: 'wudian', w: CW, d: CD, y: eaveY + 0.2, overhang: 5, pitch: 0.17, style: 'tang', color: STATION_ROOF, pal: PAL_STATION, ornament: 'none', beasts: 0, ridgeH: 0.6 });
  if (b.detail >= 1) eaveLights(b, { roofs: [r] }, { color: 0xffc46a, width: 0.14, ridges: false });

  // —— 高架候车室（跨线）：玻璃体 + 大屋面 ——
  b.box('hglass', -64, 9, 32, 64, 21, 222, 0xffffff, {}); // 底面封上：立柱顶住底板（原先无底面，从桥下可看穿、立柱也没有顶到任何东西）
  // 幕墙分格：竖梃每 3 m、窗台横梁 + 檐口（原先四面一整块深色玻璃，像没有立面的方盒，审查 g5）
  {
    const MUL = 0xc4c6c4, fin = 0.22, dep = 0.35;
    const nx = Math.round(128 / (b.detail >= 1 ? 3.2 : 6.4)), nz = Math.round(190 / (b.detail >= 1 ? 3.2 : 6.4));
    for (let i = 0; i <= nx; i++) {
      const x = -64 + (128 * i) / nx;
      for (const z of [32, 222]) b.box('hcpaint', x - fin / 2, 9, z - dep / 2, x + fin / 2, 21, z + dep / 2, MUL, { skip: 'bottom' });
    }
    for (let j = 0; j <= nz; j++) {
      const z = 32 + (190 * j) / nz;
      for (const x of [-64, 64]) b.box('hcpaint', x - dep / 2, 9, z - fin / 2, x + dep / 2, 21, z + fin / 2, MUL, { skip: 'bottom' });
    }
    for (const y of [9, 15, 20.4]) {
      const hh = y === 20.4 ? 0.75 : 0.35;
      b.box('hcpaint', -64 - dep, y, 32 - dep, 64 + dep, y + hh, 32 + 0.02, MUL, {});
      b.box('hcpaint', -64 - dep, y, 222 - 0.02, 64 + dep, y + hh, 222 + dep, MUL, {});
      b.box('hcpaint', -64 - dep, y, 32, -64 + 0.02, y + hh, 222, MUL, {});
      b.box('hcpaint', 64 - 0.02, y, 32, 64 + dep, y + hh, 222, MUL, {});
    }
  }
  // 高架候车室立柱：柱脚按各自位置的地面高度下探（原先统一 y=0，平整区外的柱脚悬空）
  // （各级 LOD 都做：远景不做立柱时候车室整体悬空）
  for (let x = -60; x <= 60; x += 20) for (let z = 40; z <= 216; z += 22) b.box('hcpaint', x - 0.8, Math.min(0, env.dy(x, z)) - 0.3, z - 0.8, x + 0.8, 9, z + 0.8, 0x9a9690, { skip: 'bottom' });
  // 屋面：真实尺寸的平缓四坡顶（130×192 m，坡度 0.08，顶高约 26 m），无鸱吻。旧版把 32.5×48 m 的殿堂屋顶整体放大 4 倍，
  // 屋面高出南站房一大截、正吻变成十几米高的黑色尖刺（审查 g8）
  roof(b, { type: 'wudian', w: 128, d: 190, y: 21.15, overhang: 1.2, style: 'tang', color: STATION_ROOF, pitch: 0.08, ornament: 'none', beasts: 0, ridgeH: 0.5 });
  // —— 站台雨棚（高架候车室东西两侧，卫星：x 1208~1385 / 1522~1720、z -2193~-2013）：平屋面 + 天窗带 + 站台中线立柱 ——
  canopies(b, env);

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
        const top = yaw === 0 && (k === 6 || k === 7) ? 10.4 : 16.6; // 南立面正中两樘让出大钟
        b.box('paint', x - 1.05, 5.6, 0, x + 1.05, top, 0.12, 0x5a5448, { skip: 'bottom' });
        glowQuad(b, x - 0.9, x + 0.9, 5.75, top - 0.15, 0.14, k % 4 ? 0.6 : 0.35, 0x39444c);
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
  // 南广场下沉采光井（站房局部坐标）
  b.pop();
  lightWells(b, env);
  b.push(5, 0, 256, 0);
  // 南立面正中大钟（改扩建时保留）：白色钟面 + 深色钟框 + 时针分针
  if (b.detail >= 1) {
    const ring = (r, n = 28) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, 13.4 + Math.sin((i / n) * Math.PI * 2) * r]);
    b.prism('paint', ring(2.05), 'z', cd - 0.05, cd + 0.16, 0x3a3630);
    b.prism('plaster', ring(1.8), 'z', cd + 0.16, cd + 0.2, 0xf2efe6);
    b.box('paint', -0.09, 13.4, cd + 0.2, 0.09, 14.75, cd + 0.26, 0x1e1c1a); // 分针（指向 12）
    b.box('paint', 0, 13.31, cd + 0.2, 1.0, 13.49, cd + 0.26, 0x1e1c1a); // 时针（指向 3）
  }
  // “西安”大字的钢架底座：两根立柱 + 横梁，从正脊立起托住字（原先字悬在屋脊上方 0.65 m，像贴在后面的候车室上）
  if (b.detail >= 1) {
    const yr = rc.ridgeY, yb = rc.ridgeY + 0.75;
    for (const x of [-4.2, 4.2]) b.box('paint', x - 0.12, yr - 0.4, 0.15, x + 0.12, yb, 0.55, 0x3a3634, { skip: 'bottom' });
    b.box('paint', -5.6, yb - 0.18, 0.2, 5.6, yb, 0.5, 0x3a3634, {});
  }
  b.pop();
  // 屋顶正中红色“西安”大字：透明底、字高 5.5 m，立在正脊上（由 build 用文字牌生成，ArchBuilder 的匾额只能带底色）
  return { topY: 27.7, labelY: 32, signs: [{ text: '西安', x: 5, y: rc.ridgeY + 3.4, z: 256.4, h: 5.5, color: '#d8231a' }] };
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
    flatten: [[-50, -66, 50, 168], [-212, 166, -120, 258]], excl: [[-210, 168, -122, 256]],
    // 荐福寺院落与山门前院（南到荐福寺路北侧）：只让位通用建筑（山门前原有两三个无贴图的小方盒子）；
    // 院内允许植被模块按公园用地种古树（原先整院排除树木，院内一棵 3D 树都没有），由下面 trees 避让殿宇、甬道、塔院、院墙
    bexcl: [[-48, -64, 48, 166], [-46, 166, 46, 250]],
    trees: [
      [-20, -24, 20, 24], // 塔院（台基 23.4 m 见方）
      [-12, -49, 12, -31], [-12, 25, 12, 43], [-16, 56, 16, 80], [17, 60, 31, 76], [-31, 60, -17, 76], // 白衣阁、藏经楼、大雄宝殿、东西配殿
      [-11, 93, 11, 111], [14, 121, 26, 135], [-26, 121, -14, 135], [-11, 148, 11, 164], // 慈氏阁、钟鼓楼、山门
      [-6, -60, 6, 166], // 中轴甬道
      [-44, -60, -38, 162], [38, -60, 44, 162], [-44, -60, 44, -54], [-44, 156, 44, 162], // 院墙内侧
      [-14, 160, 14, 270], // 山门前中轴视廊：从荐福寺路朝北能看到山门与塔（审查 g7：两棵雪松 + 一棵大树把塔整个挡住）
    ],
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
    // 院落铺地：中灰花岗岩分格（反照率约 0.35），前院中轴甬道浅一档
    paving: [{ polys: [[[-84, -80], [84, -80], [84, 92], [-84, 92]]], tile: 1.0, color: '#b0aa9f', seed: 31 }, { polys: [[[-7, 14], [7, 14], [7, 80], [-7, 80]]], tile: 0.9, color: '#c6c0b4', seed: 32, lift: 0.1 }],
    // 前院草坪上的树（槐树）
    courtTrees: [[-21, 39], [-13, 45], [-21, 51], [21, 39], [13, 45], [21, 51]],
  },
  {
    id: 'station', label: '西安站', x: 1450, z: -2232, fn: buildStation,
    // 雨棚 / 采光井 / 幕墙分格的钢构铝框（hcpaint）不泛光；屋面不受泛光（upDim 0.95：原先候车室大屋面夜里一整块奶白）
    flood: { color: 0xffe4be, strength: 1.05, height: 40, top: 0.45, upDim: 0.95, byKey: { hcanopy: false, hskylight: false, hwell: false, hgrass: false, hcpaint: false } },
    // 北站房 221×61 m、南站房 142.8×52 m（北站房原按 140 m 宽的放大殿堂建模，平整/排除范围随之扩大）
    flatten: [[-114, -36, 114, 36], [-72, 228, 82, 284]], excl: [[-112, -34, 112, 34], [-66, 30, 66, 224], [-70, 229, 80, 283], [-390, 34, 272, 228], [-90, 283, 100, 360]],
    lights: [[0, 3, -44, 0xffe4c0, 70, 120], [5, 3, 290, 0xffe4c0, 50, 100]],
    // 南广场（南站房与北城墙之间，影像 x 1325~1665、z -1948~-1873）：浅米灰花岗岩分格铺装
    paving: [{ polys: [[[-125, 284], [215, 284], [215, 359], [-125, 359]]], tile: 1.2, color: '#bab4a8', seed: 23 }],
  },
  {
    id: 'xingqing', label: '兴庆宫公园', x: 3365, z: 663, fn: buildXingqing, flood: { color: 0xffc98a, strength: 1.5, height: 22, top: 0.5 },
    flatten: [[-22, -18, 22, 20], [150, -18, 186, 16]], excl: [[-20, -16, 20, 18], [152, -16, 184, 14]],
    lights: [[0, 2, 18, 0xffc890, 30, 60], [168, 3, 16, 0xffc890, 30, 60]],
  },
];

/** 院内小乔木（实例化：树干 + 两团树冠），pts 为世界坐标，y 为地面高 */
function courtTrees(ctx, pts, y) {
  const n = pts.length;
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.8, 6).translate(0, 1.4, 0);
  const crownGeo = new THREE.IcosahedronGeometry(2.4, 1).scale(1.15, 0.85, 1.15).translate(0, 4.4, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3c30, roughness: 0.95 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x50763c, roughness: 0.9, flatShading: true });
  const t = new THREE.InstancedMesh(trunkGeo, trunkMat, n), c = new THREE.InstancedMesh(crownGeo, crownMat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  pts.forEach(([x, z], i) => {
    const k = 0.85 + ((i * 37) % 11) / 30;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.9);
    m.compose(p.set(x, y, z), q, sc.set(k, k, k));
    t.setMatrixAt(i, m);
    c.setMatrixAt(i, m);
    c.setColorAt(i, col.setHSL(0.25 + ((i * 13) % 7) / 220, 0.36, 0.28 + ((i * 7) % 5) / 70));
  });
  for (const o of [t, c]) {
    o.castShadow = o.receiveShadow = true;
    o.computeBoundingSphere();
  }
  t.name = '院内树干';
  c.name = '院内树冠';
  return [t, c];
}

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
      for (const r of s.bexcl || []) ctx.exclusions.add({ points: rectPts(s.x, s.z, r) }, { buildings: true, trees: false, roads: false });
      for (const r of s.trees || []) ctx.exclusions.add({ points: rectPts(s.x, s.z, r) }, { buildings: false, trees: true, roads: false });
    }
  },
  async build(ctx) {
    const root = new THREE.Group();
    root.name = 'heritage';
    ctx.scene.add(root);
    const glass = new THREE.MeshStandardMaterial({ color: 0x6d7f8c, metalness: 0.75, roughness: 0.12, emissive: 0xffd6a0, emissiveIntensity: 0, vertexColors: true });
    // 站台雨棚屋面：浅灰金属板（天光去蓝，免得整片读成淡蓝塑料板）
    // 直立锁边金属屋面：板宽 0.6 m 的板缝（UV = 局部米坐标，板缝沿南北向，垂直于站台）
    const seam = (() => {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 8;
      const g = c.getContext('2d');
      g.fillStyle = '#d2cfc8';
      g.fillRect(0, 0, 128, 8);
      for (let i = 0; i < 4; i++) {
        g.fillStyle = 'rgba(70,68,64,0.55)';
        g.fillRect(i * 32, 0, 2, 8);
        g.fillStyle = 'rgba(255,255,255,0.45)';
        g.fillRect(i * 32 + 2, 0, 2, 8);
        g.fillStyle = `rgba(0,0,0,${0.02 + (i % 3) * 0.015})`;
        g.fillRect(i * 32 + 4, 0, 28, 8);
      }
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / 2.4, 1 / 2.4);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    })();
    const canopy = new NeutralSkyMaterial({ color: 0xf4f2ec, map: seam, metalness: 0.25, roughness: 0.48 });
    // 下沉采光井玻璃：与站房玻璃同质感，夜间只透出微弱暖光（共用 hglass 时夜里两块白板）
    const wellGlass = glass.clone();
    wellGlass.name = 'heritage.wellGlass';
    ctx.night.register(wellGlass, { day: 0, night: 0.16 });
    canopy.name = 'heritage.canopy';
    // 采光顶玻璃：浅灰绿、低金属度（原 hglass 反射天空成一整块深蓝）
    const skylight = new NeutralSkyMaterial({ color: 0x9fb0b0, metalness: 0.15, roughness: 0.22, vertexColors: true, side: THREE.DoubleSide });
    skylight.name = 'heritage.skylight';
    glass.name = 'heritage.glass';
    const glassSeen = new Set();
    const report = {};
    const objs = [];
    const t0 = performance.now();
    for (const s of SITES) {
      const ts = performance.now();
      try {
        const h0 = this.h?.[s.id] ?? ctx.terrain.heightAt(s.x, s.z);
        const env = { dy: (x, z) => (Math.abs(x) < 5000 && Math.abs(z) < 5000 && Math.hypot(x, z) < 600 ? ctx.terrain.heightAt(s.x + x, s.z + z) - h0 : ctx.terrain.heightAt(x, z) - h0), data: ctx.data, sx: s.x, sz: s.z };
        // dy 约定：小坐标（|x|,|z| < 600）视为局部偏移；否则视为世界坐标
        let info = null;
        const lod = new THREE.LOD();
        for (const [detail, dist] of LEVELS) {
          const b = new ArchBuilder(ctx, { detail, style: 'tang', name: s.id });
          const r = s.fn(b, env);
          info = info || r;
          const g = b.build({ flood: { ...s.flood, baseY: h0 + 0.5 }, name: s.id + '@' + detail, materials: { hglass: glass, hwell: wellGlass, hgrass: ctx.mats.get('grass'), hcanopy: canopy, hskylight: skylight, hcpaint: getKit(ctx).mat('paint'), ...roofMaterials(ctx) } });
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
        // 地面铺装（世界坐标多边形；原先是贴地卫星影像，烘焙的车辆/白线/污渍一眼可辨）
        for (const pv of s.paving || []) {
          const polys = pv.polys.map((poly) => poly.map(([x, z]) => [s.x + x, s.z + z]));
          root.add(pavedGround(ctx, polys, { tile: pv.tile ?? 1.2, color: pv.color ?? '#b8b2a6', seed: pv.seed ?? 21, night: 0.1, lift: pv.lift ?? 0.06, bias: pv.lift ? 0.0009 : 0.0006, name: s.label + '·铺装' }));
        }
        if (s.courtTrees) for (const m of courtTrees(ctx, s.courtTrees.map(([x, z]) => [s.x + x, s.z + z]), h0 + 0.34)) root.add(m);
        objs.push(lod);
        if (s.label) ctx.labels.add(s.label, new THREE.Vector3(s.x, h0 + (info?.labelY ?? 30), s.z), { category: 'landmark', priority: 3, maxDist: 6000 });
        // 透明底大字（站房屋脊上的“西安”等）：面朝 +Z（南）
        for (const sg of info?.signs || []) {
          const m = ctx.sign(sg.text, { height: sg.h, color: sg.color, serif: false, weight: 700, size: 160, padding: 0.06, emissive: 1.2, emissiveDay: 0.05 });
          m.position.set(s.x + sg.x, h0 + sg.y, s.z + sg.z);
          m.name = 'heritage-sign:' + sg.text;
          root.add(m);
        }
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
