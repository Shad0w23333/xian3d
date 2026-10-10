// 逐栋档案 · 第二轮修复补建（地标与历史街区一路，2026-10）
// 坐标：世界系 X 东、Z 南（北 = −Z），原点钟楼；pts 为世界坐标扁平数组。字段说明见 docs/DOSSIER_KIT.md。

// ───────────── 西安市百货大厦（南大街东侧） ─────────────
// 原由 landmarks2026 批量地标（malls lme7b8c242）生成：35 m 米色方盒 + 统一深蓝方窗，底层与上层同一窗格，看不出是钟楼南侧的仿古商场
// （审查 g5 st_bell_south）。离线影像 z19（x 24~97、z 390~481）：屋面为绿色屋顶平台 + 水箱设备，四角各一座约 11~12 m 见方的
// 黄琉璃四角攒尖亭（亭位已按楼高约 0.2 m/m 的东偏移回推）；钟楼周边限高仿古风貌——檐口一圈绿琉璃披檐。
// 首层 6 m 商场大玻璃 + 入口雨篷（南大街西立面），二层起石材墙 + 竖向窗。
const BH_PTS = [36.8, 397.1, 35.4, 395.5, 36.8, 394.3, 35.7, 391.1, 37.1, 389.7, 96.8, 393.0, 95.6, 477.6, 96.8, 477.7, 96.8, 481.5, 24.3, 480.9, 24.3, 396.4];
const BH_STONE = { pattern: 'stoneWindows', tint: '#33424c', spd: '#d9d0bf', floorH: 4.0, colW: 2.8, spandrel: 0.42, mullW: 1.05, lit: 0.55 };
const GREEN_TILE = { color: '#2f6b4f', roughness: 0.55, metalness: 0.15 }; // 绿琉璃
const YELLOW_TILE = { color: '#c99a2e', roughness: 0.5, metalness: 0.2 }; // 黄琉璃
const PAV_RED = { pattern: 'grid', tint: '#3a2a24', spd: '#8e2a1f', floorH: 4.0, colW: 2.2, spandrel: 0.2, mullW: 0.45, lit: 0.6 };
const baihuo = {
  id: 'xian-baihuo-dasha',
  name: '西安市百货大厦',
  center: [60.5, 435.5],
  parts: [
    { name: 'shop', pts: BH_PTS, base: 0, top: 6.2, style: { pattern: 'retail', tint: '#2f3c45', spd: '#cfc6b4', floorH: 6.2, colW: 3.6, spandrel: 0.22, mullW: 0.22, lit: 0.9 }, roof: { mech: false, parapet: 0 } },
    // 二层起：石材 + 竖向窗；顶部一圈绿琉璃披檐
    { name: 'main', pts: BH_PTS, base: 6.2, top: 33, style: BH_STONE, roof: { mech: false, parapet: 0.9 }, crown: [{ type: 'eave', ov: 1.6, depth: 2.6, h: 1.5, mat: GREEN_TILE, eaveMat: '#5a4a3c' }] },
    // 首层与二层之间的一道挑檐（雨篷，石材压顶）
    { name: 'canopy', kind: 'solid', mat: '#8e8a82', pts: [22.6, 398, 24.3, 398, 24.3, 479, 22.6, 479], base: 5.6, top: 6.3 },
    // 屋面四角黄琉璃攒尖亭（红柱，柱高 4 m）
    ...[['pavNW', [33.5, 401]], ['pavNE', [87.5, 400.5]], ['pavSW', [33.5, 471.5]], ['pavSE', [87.5, 471.5]]].map(([name, at]) => ({
      name, shape: 'rect', size: [10.5, 10.5], at, base: 33, top: 37,
      style: PAV_RED, roof: { mech: false, parapet: 0 },
      crown: [{ type: 'cnhip', style: 'zanjian', ov: 1.6, h: 4.6, lift: 0.9, mat: YELLOW_TILE, eaveMat: '#6b2a1f', finialMat: YELLOW_TILE }],
    })),
    // 屋顶平台：绿色防水面层（影像可见）
    { name: 'deck', kind: 'solid', mat: '#5d7f62', pts: [27.5, 400, 93.5, 403, 92.5, 476, 27.5, 476], base: 33, top: 33.12 },
  ],
  bands: [{ part: 'main', levels: [10.4], h: 0.6, depth: 0.25, color: '#b8ad99' }],
  signs: [{ text: '西安百货大厦', part: 'main', face: 'W', y: 28.5, h: 3.4, color: '#c8161d' }],
  night: { outline: ['pavNW', 'pavNE', 'pavSW', 'pavSE'].map((part) => ({ part, color: '#ffb05a', w: 0.25 })) },
  supersede: { names: ['西安市百货大厦', '西安百货大厦'], keys: ['lme7b8c242'] },
  meta: {
    dossier: 'landmarks2026.json malls lme7b8c242 西安市百货大厦',
    sources: ['landmarks2026（tools/build_landmarks2026.py，35 m）', '离线影像 z19（屋面绿色平台 + 四角黄琉璃攒尖亭）'],
    confidence: 'low（高度、立面）；medium（屋面亭位）',
    notes: '高度沿用 landmarks2026 的 35 m（约 8 层）；立面无照片，按南大街仿古整治的通行做法（石材墙 + 竖窗 + 绿琉璃披檐）建；四角亭位按影像量取（±2 m）。',
  },
};

export default [baihuo];
