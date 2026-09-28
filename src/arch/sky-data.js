// skyline：西安现代地标清单（2026-09 调研；高度/层数以公开报道与 OSM height 标签为准）
// 资料：OSM（way 550214180 国瑞 350 m/75F、986974316/7 绿地中心 A/B 270 m/57F、550214178 中铁西安中心 230 m/51F、
//   1546339320 迈科中心 216 m/45F、985455592 君悦酒店 155 m/34F、1387164542 永利国际金融中心 212 m/46F、
//   772926961 永威时代中心 212 m/47F、969143238 延长石油科研中心 217 m、1284311588 陕西信息大厦 228 m/51F）；
//   搜狐/新浪 2025-12“国瑞西安金融中心投用 350 米，楼顶停机坪”；网易 2026-04“荣民中心 270 m，未央路东侧、
//   大明宫西站上盖、双银 Low-E 幕墙、顶部停机坪，2026 年中交付”；体育之窗 1 号楼 262 m（唐延路与科技八路东南角，三栋塔楼）；
//   “未央国际”99.6 m（凤城八路/未央路，台阶式立方体商业）；曲江国际会展中心已拆除（原址为华润万象城与工地），故不建。
// 平面位置用 Esri 卫星核对（research/refs/skyline/sat/*.jpg，satcheck.py 生成）。
import { FP } from './sky-footprints.js';
import * as G from './sky-geom.js';

const D = Math.PI / 180;
const obbRect = (poly, opt = {}) => {
  const o = G.obb(poly);
  return G.rect(o.cx, o.cz, o.w + (opt.grow || 0), o.d + (opt.grow || 0), o.rot, opt);
};

/** 片区（用于合批分组、LOD 与标注） */
export const DISTRICTS = [
  { id: 'gaoxin', name: '高新区 CBD', x: -5700, z: 6900, label: [-5960, 7390, 380] },
  { id: 'weiyang', name: '未央国际商圈', x: 200, z: -8200, label: [-40, -8700, 150] },
  { id: 'north', name: '西安北站', x: -780, z: -13000, label: [-780, -13011, 70] },
  { id: 'chanba', name: '浐灞·奥体', x: 8000, z: -10500 },
  { id: 'south', name: '小寨·曲江', x: -200, z: 5000 },
  { id: 'center', name: '钟楼', x: 0, z: 0 },
];

/** 塔楼与裙房清单 */
export function towerSpecs() {
  const L = [];
  // ———————— 高新区 CBD（锦业路超高层集群） ————————
  L.push({
    key: 'ifc', name: 'IFC国瑞·西安金融中心',
    // 方塔微收分，75 层，每 15 层一道设备层；顶部 3 层“灯笼”框架塔冠 + 停机坪
    pts: obbRect(FP.ifc, { chamfer: 4.5 }), h: 350, taper: 0.9,
    tiers: [{ to: 0.94, inset: 0 }, { to: 1, inset: 1.4 }],
    crown: { h: 16, inset: -1.2, color: '#dbe8ff', colW: 3.2 },
    roof: { helipad: true, helipadY: 2.5 },
    style: { tint: '#2a3946', spd: '#36414a', floorH: 4.5, colW: 1.45, spandrel: 0.2, mullW: 0.1, band: 15, lit: 0.42, mode: 2, seed: 1 },
  });
  L.push({
    key: 'glA', name: '绿地中心-A座',
    // “丝路之门”双塔之一：270 m，57 层，逐渐收分，顶部斜切玻璃塔冠，金色“绿地”标志，夜间 LED 媒体幕墙
    pts: FP.glA, h: 270, taper: 0.8, slope: { dir: [1, 0.35], drop: 24 },
    crown: { h: 9, color: '#ffd79a', colW: 3 },
    style: { tint: '#6f879a', spd: '#96a2ac', floorH: 4.4, colW: 1.5, spandrel: 0.32, mullW: 0.12, band: 12, lit: 0.3, mode: 1, seed: 2 },
    signs: [{ text: '绿地', color: '#f2c14e', h: 8.5, faces: 2, y: 232 }],
  });
  L.push({
    key: 'glB', name: '绿地中心-B座',
    pts: G.rect(-6227, 7211, 50, 50, 0, { chamfer: 3 }), h: 270, taper: 0.8, slope: { dir: [-1, -0.35], drop: 24 },
    crown: { h: 9, color: '#ffd79a', colW: 3 },
    style: { tint: '#6f879a', spd: '#96a2ac', floorH: 4.4, colW: 1.5, spandrel: 0.32, mullW: 0.12, band: 12, lit: 0.3, mode: 1, seed: 3 },
    signs: [{ text: '绿地', color: '#f2c14e', h: 8.5, faces: 2, y: 232 }],
    podium: { pts: FP.glB, h: 22 },
  });
  L.push({
    key: 'ztzx', name: '中铁西安中心',
    pts: obbRect(FP.ztzx, { chamfer: 2 }), h: 230,
    tiers: [{ to: 0.9, inset: 0 }, { to: 1, inset: 1.5 }],
    crown: { h: 15, color: '#d6e6ff', colW: 2.4 },
    roof: { helipad: true, helipadY: 2 },
    style: { tint: '#2f4455', spd: '#2b343c', floorH: 4.3, colW: 1.5, spandrel: 0.22, band: 14, lit: 0.4, seed: 4 },
    signs: [{ text: '中国中铁', color: '#e8392c', h: 6, faces: 2 }],
  });
  L.push({
    key: 'mkT', name: '迈科中心',
    // 216 m：下部方格幕墙，中部竖向密肋并退台，顶部穿孔金属屏塔冠；顶部 Maike 字标
    pts: FP.mkT, h: 216,
    tiers: [{ to: 0.5, inset: 0 }, { to: 1, inset: 1.6, style: { colW: 1.15, spandrel: 0.1, mullW: 0.2 } }],
    crown: { h: 14, inset: 0.8, color: '#ffe8c8', colW: 1.6 },
    roof: { mech: false },
    style: { tint: '#3a5061', spd: '#44505a', floorH: 4.5, colW: 1.35, spandrel: 0.18, mullW: 0.16, lit: 0.4, seed: 5 },
    signs: [{ text: '迈科', color: '#ffffff', h: 7, faces: 2 }],
    podium: { pts: FP.mkP, h: 26, signs: [{ text: '迈科中心', h: 4, faces: 1 }] },
  });
  L.push({
    key: 'hyatt', name: '西安君悦酒店',
    pts: FP.hyatt, h: 155, crown: { h: 8, color: '#ffd9a8' },
    style: { tint: '#485861', spd: '#7a6d5c', floorH: 3.9, colW: 1.6, spandrel: 0.34, lit: 0.55, seed: 6 },
    signs: [{ text: '君悦酒店', color: '#f4e4c6', h: 4.6, faces: 1, serif: true }],
  });
  L.push({
    key: 'yongli', name: '陕西永利国际金融中心',
    pts: FP.yongli, h: 212, crown: { h: 10, color: '#e2ecff' },
    style: { tint: '#3c576b', spd: '#4d5964', floorH: 4.5, colW: 1.5, spandrel: 0.25, band: 12, lit: 0.36, seed: 7 },
  });
  L.push({
    key: 'yongwei', name: '永威·时代中心',
    pts: FP.yongwei, h: 212, crown: { h: 9, color: '#ffe3b8' }, roof: { helipad: true, helipadY: 2 },
    style: { tint: '#44607a', spd: '#56626c', floorH: 4.4, colW: 1.6, spandrel: 0.28, band: 13, lit: 0.36, mode: 2, seed: 8 },
  });
  L.push({
    key: 'ty1', name: '陕西国际体育之窗1号楼',
    // 262 m，圆角板式塔楼，整体水平白色遮阳百叶（十四运媒体中心）
    pts: G.rect(-5134, 6212, 72, 44, 0, { round: 16, seg: 5 }), h: 262,
    crown: { h: 12, color: '#e8f0ff', colW: 2.6 },
    roof: { helipad: true, helipadY: 2 },
    style: { tint: '#2d3d4a', spd: '#d9dcdc', floorH: 4.2, colW: 1.8, spandrel: 0.42, mullW: 0.08, lit: 0.34, mode: 3, seed: 9 },
    podium: { pts: FP.tyP, h: 22, signs: [{ text: '陕西国际体育之窗', h: 3.6, faces: 1 }] },
  });
  L.push({
    key: 'ty2', name: '陕西国际体育之窗2号楼',
    pts: G.rect(-5133, 6296, 60, 42, 0, { round: 14, seg: 5 }), h: 188,
    crown: { h: 8, color: '#e8f0ff', colW: 2.6 },
    style: { tint: '#2d3d4a', spd: '#d9dcdc', floorH: 4.2, colW: 1.8, spandrel: 0.42, mullW: 0.08, lit: 0.4, mode: 3, seed: 10 },
  });
  L.push({
    key: 'yc', name: '延长石油科研中心',
    // 西端船首形主塔 217 m + 东侧裙楼
    pts: [-5202, 5971, -5170, 5943, -5118, 5942, -5118, 6000, -5170, 5999], h: 217,
    crown: { h: 12, color: '#ffe0a8', colW: 2.4 },
    style: { tint: '#3b5c72', spd: '#6b7883', floorH: 4.3, colW: 1.5, spandrel: 0.26, band: 12, lit: 0.36, mode: 2, seed: 11 },
    signs: [{ text: '延长石油', color: '#ffffff', h: 6, faces: 2 }],
    podium: { pts: [-5118, 5940, -4968, 5940, -4968, 6002, -5118, 6002], h: 36 },
  });
  L.push({
    key: 'hsA', name: '禾盛京广中心-A座', pts: FP.hsA, h: 200, crown: { h: 8, color: '#dfe9ff' },
    style: { tint: '#476679', spd: '#5b6771', floorH: 4.2, colW: 1.5, spandrel: 0.28, band: 12, lit: 0.36, seed: 12 },
  });
  L.push({
    key: 'hsB', name: '禾盛京广中心-B座', pts: FP.hsB, h: 200, crown: { h: 8, color: '#dfe9ff' },
    style: { tint: '#476679', spd: '#5b6771', floorH: 4.2, colW: 1.5, spandrel: 0.28, band: 12, lit: 0.36, seed: 13 },
  });
  L.push({
    key: 'dxgc', name: '陕西电信广场', pts: FP.dxgc, h: 160, crown: { h: 7, color: '#cfe0ff' },
    style: { tint: '#3f5a70', spd: '#6e7881', floorH: 3.9, colW: 1.6, spandrel: 0.3, lit: 0.36, seed: 14 },
    signs: [{ text: '中国电信', color: '#3f7fe8', h: 5, faces: 2 }],
  });
  // ———————— 小寨：陕西信息大厦（228 m，含塔尖） ————————
  L.push({
    key: 'xinxi', name: '陕西信息大厦', pts: FP.xinxi, h: 188,
    tiers: [{ to: 0.8, inset: 0 }, { to: 0.92, inset: 1.6 }, { to: 1, inset: 3.2 }],
    roof: { mech: false, parapet: 1.2 },
    style: { tint: '#34566b', spd: '#b7ab98', floorH: 3.7, colW: 1.6, spandrel: 0.36, lit: 0.4, seed: 15 },
    pyramid: { h: 16, spire: 24 },
  });
  // ———————— 未央路：荣民金融中心（270 m） ————————
  // 落位：OSM w1370944673（Overture 2026-09，height=270，56×57 m 切角方形）质心 (94.7,−4703.7)；
  //   原推测位置 (140,−4862) 在其以北约 165 m（tools/check_coords.py 审计，research/refs/landmarks2026/towers_notes.md §2）
  L.push({
    key: 'rongmin', name: '荣民金融中心',
    pts: G.rect(95, -4704, 54, 54, 0, { chamfer: 3 }), h: 270,
    tiers: [{ to: 0.92, inset: 0 }, { to: 1, inset: 1 }],
    crown: { h: 12, color: '#e6f0ff', colW: 3 },
    roof: { helipad: true, helipadY: 2 },
    style: { tint: '#8599a7', spd: '#a4afb7', floorH: 4.4, colW: 1.5, spandrel: 0.26, band: 13, lit: 0.3, mode: 2, seed: 16 },
    podium: { pts: G.rect(95, -4706, 96, 72, 0), h: 20, signs: [{ text: '荣民金融中心', h: 3.4, faces: 1 }] },
  });
  // ———————— 未央路：西安环球贸易中心（凤城五路东南角）2 号楼 149.75 m 已建成；1 号楼 299.75 m 在建 ————————
  L.push({
    key: 'igc2', name: '西安环球贸易中心2号楼',
    pts: G.rect(157, -7665, 80, 36, 0, { chamfer: 2 }), h: 149.75, crown: { h: 8, color: '#e2ecff' },
    style: { tint: '#3d5a70', spd: '#56626c', floorH: 4.2, colW: 1.5, spandrel: 0.26, band: 12, lit: 0.36, mode: 2, seed: 18 },
  });
  // ———————— 曲江：西安华润国际文化商业中心（电视塔东侧四栋约 150 m 写字楼 + 西安万象城） ————————
  for (const [k, hh, sd] of [['crA', 147.6, 21], ['crB', 148.8, 22], ['crC', 151, 23], ['crD', 151, 24]]) L.push({
    key: k, name: '华润国际文化商业中心' + k.slice(2) + '座', pts: FP[k], h: hh, crown: { h: 8, color: '#e8f0ff', colW: 2.4 },
    tiers: [{ to: 0.93, inset: 0 }, { to: 1, inset: 1.2 }],
    style: { tint: '#50687a', spd: '#7d8993', floorH: 4.2, colW: 1.5, spandrel: 0.24, band: 11, lit: 0.36, mode: 2, seed: sd },
  });
  // ———————— 未央国际商圈（凤城八路—未央路，经开区） ————————
  L.push({
    key: 'wygj', name: '未央国际', pts: FP.wygjT, h: 99.6, crown: { h: 6, color: '#dfe9ff' },
    style: { tint: '#33475a', spd: '#39434c', floorH: 4.0, colW: 1.5, spandrel: 0.25, lit: 0.45, mode: 2, seed: 17 },
    signs: [{ text: '未央国际', color: '#ffffff', h: 4.2, faces: 2 }],
  });
  return L;
}

const DMGWD = [2310.3, -6115.9, 2310.3, -6151.6, 2307.9, -6151.6, 2310.0, -6319.0, 2310.2, -6319.8, 2329.0, -6319.8, 2329.2, -6364.8,
  2339.2, -6364.8, 2339.2, -6365.6, 2434.8, -6364.6, 2440.3, -6359.0, 2440.3, -6222.9, 2441.9, -6222.9, 2442.1, -6219.9, 2442.3, -6196.3,
  2440.5, -6196.3, 2440.1, -6081.8, 2432.0, -6073.5, 2338.6, -6071.8, 2322.8, -6115.7];

/** 商场/裙房类（只有裙房） */
export function mallSpecs() {
  return [
    { key: 'wygjS1', d: 'weiyang', pts: FP.wygjS1, h: 24, style: { tint: '#3b4a57', spd: '#c9c2b6' } },
    { key: 'wygjS2', d: 'weiyang', pts: FP.wygjS2, h: 36, style: { tint: '#3b4a57', spd: '#c9c2b6' } },
    { key: 'xidigang', d: 'weiyang', pts: FP.xidigang, h: 26, signs: [{ text: 'CITYON熙地港', h: 5.5, faces: 2 }],
      domes: [[-137, -8855, 11, 7], [-149, -8806, 11, 11], [-100, -8791, 9, 7], [-176, -8848, 8, 6], [-166, -8822, 7, 7], [-187, -8791, 8, 6], [-155, -8769, 9, 6], [-118, -8767, 8, 6], [-87, -8773, 6, 5]] },
    { key: 'darongcheng', d: 'weiyang', pts: FP.darongcheng, h: 26, signs: [{ text: '大融城', h: 6, faces: 2 }] },
    // 大明宫万达广场：换用 OSM w1409622148（Overture 2026-09，294×134 m 整体轮廓，质心 (2377,−6219)）；
    //   旧 FP.dmgwd 只有北半部（7105 m²，质心偏北 88 m，交并比 0.19）
    { key: 'dmgwd', d: 'weiyang', pts: DMGWD, h: 26, signs: [{ text: '万达广场', h: 6.5, faces: 2, color: '#f1c24c' }] },
    { key: 'saige', d: 'south', pts: FP.saige, h: 56, led: true, signs: [{ text: '赛格国际购物中心', h: 5.5, faces: 1 }], style: { tint: '#34414b', spd: '#cfc9bd', floorH: 5.6 } },
    { key: 'mixc', d: 'south', pts: FP.mixc, h: 24, signs: [{ text: '万象城', h: 6, faces: 2 }] },
    { key: 'kaiyuan', d: 'center', pts: FP.kaiyuan, h: 36, signs: [{ text: '开元商城', h: 5, faces: 2, color: '#e33a2c' }], style: { tint: '#3a4650', spd: '#d8d0c0' } },
  ];
}

export const SPECIAL = {
  tv: { cx: -50, cz: 7052, basePts: FP.tvbase },
  changan: { cx: 10366, cz: -6940, rot: 45 * D },
  aoti: { stadium: { cx: 6965, cz: -13052 }, arena: { cx: 7330, cz: -12805, r: 105 }, aqua: { cx: 7460, cz: -13160, w: 130, d: 100, rot: 0 } },
  north: { cx: -780, cz: -13011, rot: -16.8 * D, w: 192, L: 533 },
  conf: [
    { cx: 8812, cz: -8300, side: 210, rot: 30 * D, name: '丝路国际会议中心' },
    { cx: 8147, cz: -8743, side: 200, rot: 32 * D },
  ],
  igc1: { pts: G.rect(140, -7752, 52, 52, 0, { chamfer: 3 }), facadeTo: 64, slabTo: 128, coreTo: 140 },
  expo: FP.expo,
  gov: FP.gov,
};
