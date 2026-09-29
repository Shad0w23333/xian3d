// 逐栋档案：地标补建（第二批）——盘点后发现缺失、或只有通用方盒 / 通用院落的西安知名地标。
// 档案：research/refs/dossiers/landmarks2.json（含出处 URL、照片来源页）；照片 vs 模型对照：research/refs/dossiers/model_log_landmarks2.md。
// 取值原则同其他片区：有出处的数值直接用；没有的按照片比例 / 数层、按卫星（Esri World Imagery）量取，均在 meta.notes 注明，
// 做不到的保守处理。卫星上高楼屋面随楼身倾斜偏移，落位以 Overture/OSM 底座轮廓为准。
// 坐标：世界系 X 东、Z 南（北 = −Z），原点钟楼；rot = 长边相对正东逆时针角（度）。字段说明见 docs/DOSSIER_KIT.md。

// ───────────── 小工具（只生成数据） ─────────────
const D2R = Math.PI / 180;
/** 连廊 / 复道：两点之间宽 w 的矩形轮廓（世界坐标扁平数组） */
function strip(a, b, w) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
  const nx = (-dz / L) * (w / 2), nz = (dx / L) * (w / 2);
  return [a[0] + nx, a[1] + nz, b[0] + nx, b[1] + nz, b[0] - nx, b[1] - nz, a[0] - nx, a[1] - nz];
}
/** 以 c 为原点、轴线朝 rot（度，地图角）的局部坐标 [沿轴, 垂直轴] → 世界坐标 */
function along(c, rot, u, v) {
  const a = rot * D2R;
  // 地图角 a：+u 方向 = (cos a, −sin a)（北 = −Z）；+v 为其左侧（逆时针 90°）
  return [c[0] + u * Math.cos(a) - v * Math.sin(a), c[1] - u * Math.sin(a) - v * Math.cos(a)];
}

// 常用材质
const ROOF_GRAY = { color: '#3e4449', roughness: 0.62, metalness: 0.15 }; // 深灰金属屋面（直立锁边）；金属度压低，避免反射天空发蓝（截图对照）
const ROOF_TILE = 'roofTile';
const EARTH = { color: '#b09669', roughness: 0.95 }; // 夯土色（米黄偏褐）石材 / 仿夯土涂料（截图对照后压深：原色在雾中发白）
const WHITE_STONE = { color: '#e6e2d8', roughness: 0.85 }; // 汉白玉色石材台基

// ═════════════════════════ 1. 陕西历史博物馆秦汉馆（西咸新区秦汉新城） ═════════════════════════
// 张锦秋院士主持设计，2024-05-18 开馆；建筑面积 39809 m²。7 座高台建筑按“北斗七星”布局，以架空复道相连；
// 展厅设在一层高台内，公共活动区设在高台上的“殿堂”中，外观取秦汉“高台榭、美宫室”；正门左右一对凌空“冀阙”与高台主殿遥对；南面水体象征“天汉”。
// 轮廓：Overture/OSM w1236884774–780（7 座高台，6 座 44×44 m 方台 + 主殿 83×63 m），整组轴线北偏西约 11°（方台 rot 11.3°）。
// 冀阙：Esri z19 卫星量取两座阙顶 ≈ 12 m 见方，位于 (−7623, −16283)、(−7571, −16291)。
// 高度无公开数据：按航拍照片比例估算（方台宽 44 m → 高台约 8.5 m、殿身约 7 m、重檐屋顶约 9 m，总高约 26 m；主殿三重檐约 36 m；冀阙约 21 m）。
// 照片：sn.cri.cn / sanqin.com / sohu 航拍（见 meta.photos）：米黄色收分高台 + 玻璃殿身 + 深灰金属重檐庑殿顶；复道为灰顶架空廊。
const QH_ROT = 11.3;
const QH_SIDE = [
  ['qhA', '3ab0b1f2-9d3d-41bc-89d1-c9bddc34977e', [-7744.7, -16418.3]], // 摇光（西南端）
  ['qhB', '0ffe3fb6-9bfd-4cb4-b3f0-b16975a0392a', [-7703.3, -16469.2]],
  ['qhC', '5e72a2c9-beeb-4d2d-8b55-250bc583a138', [-7567.1, -16496.7]],
  ['qhD', 'cfce68ef-1bc3-430e-b381-85776551c417', [-7510.0, -16465.8]],
  ['qhE', '1110529b-560b-4fa7-b0d4-44dd952bb13d', [-7478.2, -16531.3]],
  ['qhF', '922c5fa5-99d1-43f6-b97e-1fba00b86a26', [-7499.5, -16581.4]],
];
const QH_MAIN = [-7634.9, -16482.4];
const QH_HALL_STYLE = { pattern: 'curtain', tint: '#3c5566', spd: '#8b8f92', floorH: 7, colW: 3.6, spandrel: 0.08, mullW: 0.5, lit: 0.55 };
const qinhanSide = QH_SIDE.flatMap(([n, fp, c]) => [
  { name: n + 'tai', kind: 'solid', fp, base: 0, top: 8.5, taper: 0.95, mat: EARTH }, // 收分高台（展厅在内）
  {
    name: n, shape: 'rect', size: [27, 27], at: c, rot: QH_ROT, base: 8.5, top: 16, footprint: false, // 高台上的殿堂（玻璃殿身）
    style: QH_HALL_STYLE, roof: { mech: false },
    crown: [{ type: 'tangRoof', eave: 2.2, h: 7.5, curve: 0.25, lift: 0.5, base: 0.8, mat: ROOF_GRAY, ridgeMat: '#3e4348', double: { gap: 3.2, out: 6.5, h: 2.2 } }],
  },
]);
// 复道（架空连廊，灰色屋面）：沿北斗七星连线
const QH_LINKS = [['qhA', 'qhB'], ['qhB', 'main'], ['main', 'qhC'], ['qhC', 'qhD'], ['qhC', 'qhE'], ['qhE', 'qhF']];
const qhPos = (k) => (k === 'main' ? QH_MAIN : QH_SIDE.find((s) => s[0] === k)[2]);
const qinhan = {
  id: 'lm2-qinhan',
  name: '陕西历史博物馆秦汉馆',
  center: QH_MAIN,
  parts: [
    ...qinhanSide,
    { name: 'mainTai', kind: 'solid', fp: 'd87c658b-526b-44bc-b6e5-b39e53bb259f', base: 0, top: 11.5, taper: 0.96, mat: EARTH },
    { name: 'mainA', shape: 'rect', size: [52, 40], at: along(QH_MAIN, QH_ROT + 90, 4, 0), rot: QH_ROT, base: 11.5, top: 18.5, footprint: false,
      style: QH_HALL_STYLE, roof: { mech: false }, crown: [{ type: 'eave', ov: 5.5, depth: 3.5, h: 2.4, mat: ROOF_GRAY, eaveMat: '#3e4348' }] },
    { name: 'mainB', shape: 'rect', size: [42, 30], at: along(QH_MAIN, QH_ROT + 90, 4, 0), rot: QH_ROT, base: 18.5, top: 24, footprint: false,
      style: QH_HALL_STYLE, roof: { mech: false }, crown: [{ type: 'eave', ov: 4.5, depth: 3, h: 2.2, mat: ROOF_GRAY, eaveMat: '#3e4348' }] },
    { name: 'mainC', shape: 'rect', size: [32, 20], at: along(QH_MAIN, QH_ROT + 90, 4, 0), rot: QH_ROT, base: 24, top: 28, footprint: false,
      style: QH_HALL_STYLE, roof: { mech: false },
      crown: [{ type: 'tangRoof', eave: 3, h: 7, curve: 0.25, lift: 0.6, base: 0.8, mat: ROOF_GRAY, ridgeMat: '#3e4348' }] },
    // 复道：高台之间的架空廊（廊身 4.5–8 m，灰色平屋面挑檐）
    ...QH_LINKS.map(([a, b], i) => ({ name: 'fudao' + i, kind: 'solid', pts: strip(qhPos(a), qhPos(b), 7), base: 4.5, top: 8, footprint: false,
      mat: { color: '#9aa3a8', roughness: 0.4, metalness: 0.3 }, crown: [{ type: 'slab', ov: 0.8, h: 0.6, mat: ROOF_GRAY }] })),
    // 冀阙（正门一对）：收分阙身 + 两层出挑平顶
    ...[[-7623.1, -16282.6], [-7571.2, -16291.2]].flatMap((at, i) => [
      { name: 'que' + i, kind: 'solid', shape: 'rect', size: [15, 15], at, rot: QH_ROT, base: 0, top: 16, taper: 0.8, mat: EARTH,
        crown: [{ type: 'slab', ov: 2.2, h: 1.2, mat: EARTH }] },
      { name: 'queTop' + i, kind: 'solid', shape: 'rect', size: [10, 10], at, rot: QH_ROT, base: 17.2, top: 20, footprint: false, mat: EARTH,
        crown: [{ type: 'slab', ov: 1.8, h: 1.0, mat: EARTH }] },
    ]),
  ],
  signs: [{ text: '陕西历史博物馆秦汉馆', part: 'mainTai', face: 'S', y: 7, h: 2.2, color: '#5a4630' }],
  night: {
    floodlight: [
      { part: 'mainTai', color: '#ffd9a0', strength: 0.35 },
      ...QH_SIDE.map(([n]) => ({ part: n + 'tai', color: '#ffd9a0', strength: 0.3 })),
    ],
  },
  supersede: { names: ['陕西历史博物馆秦汉馆', '陕历博秦汉馆', '秦汉馆'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#陕西历史博物馆秦汉馆',
    sources: [
      'https://zh.wikipedia.org/zh-hans/陕西历史博物馆秦汉馆',
      'https://baike.baidu.com/item/陕西历史博物馆秦汉馆/62101249',
      'https://www.cscec.com.cn/xwzx_new/zqydt_new/202405/3787494.html',
      'http://www.news.cn/politics/20240518/4a00c0a1e8824758b6c4f2de26b51a02/c.html',
      'Overture building w1236884774–w1236884780（7 座高台轮廓）；Esri z19 卫星（冀阙落位）',
    ],
    photos: [
      'https://sn.cri.cn/n/20240124/3e4fd601-6793-338c-9b8a-7a8a990e72d6.html',
      'https://www.sanqin.com/2023-12/27/content_10513403.html',
      'http://www.sohu.com/a/681394339_100185418',
      'http://www.sohu.com/a/588611507_100185418',
    ],
    confidence: 'high（布局、轮廓）；low（高度，按照片比例估算）',
    notes: '7 座高台轮廓用 OSM 实测；殿身尺寸、各段高度无公开数据，按航拍照片比例估算：方台高约 8.5 m、殿身 27 m 见方、重檐庑殿顶（下檐外挑 6.5 m）；'
      + '主殿高台 11.5 m、三重檐（52×40 → 42×30 → 32×20 m），顶约 36 m。冀阙约 21 m（照片比例）。水面“天汉”由地表影像表现，不另建。',
  },
};

// ═════════════════════════ 2. 汉城湖大风阁 ═════════════════════════
// 汉城湖景区东南角（角楼叠翠片区）的标志性建筑，仿汉高台楼阁；主体高 63.3 m（西安市人民政府网“大风阁暨大风阁汉文化艺术博物馆建成对外开放”、
// 百度百科），地上 7 层、地下 2 层，建筑面积 9942 m²，钢骨混凝土框架。
// 轮廓：Overture/OSM w370290098（44.5×44.3 m，正南北）。卫星：塔顶随倾斜向东北偏移；南侧为大台阶。
// 照片（大众点评 / 图虫 / 视觉中国，见 meta.photos）：白色石材两层高台（南侧中央拱门 + 两侧折跑大台阶、汉白玉栏杆）；
// 台上塔身 6 层，逐层收分，每层深灰瓦腰檐 + 红色平座栏杆，墙身深褐红木色、挂红灯笼；顶层为庑殿顶（带小重檐）。
// 夜景：整栋金黄 / 橙红泛光，檐口金色轮廓灯。
const DF = [-2580.3, -4394.8];
const DF_WALL = { pattern: 'stoneWindows', spd: '#5e2d22', tint: '#2a211d', floorH: 6.5, colW: 2.8, spandrel: 0.32, mullW: 1.1, lit: 0.7 };
const DF_EAVE = { type: 'eave', ov: 3.2, depth: 2.2, h: 1.8, fascia: 0.55, mat: ROOF_TILE, eaveMat: '#3a2a22' };
// 塔身各层：[宽, 底, 顶]
const DF_STOREYS = [[30, 11, 19], [27, 19, 25.5], [25, 25.5, 32], [23, 32, 38.5], [21, 38.5, 45], [19, 45, 52]];
const dafengge = {
  id: 'lm2-dafengge',
  name: '汉城湖大风阁',
  fp: '9deb2d59-8a05-4bc5-ac88-7ce5f4370ab5',
  parts: [
    // 两层白石高台（下层外扩、上层即 OSM 轮廓）+ 南侧大台阶
    { name: 'tai1', kind: 'solid', shape: 'rect', size: [52, 50], at: [DF[0], DF[1] + 2], base: 0, top: 5.5, mat: WHITE_STONE, crown: [{ type: 'parapet', h: 1.1, mat: WHITE_STONE }] },
    { name: 'tai2', kind: 'solid', fp: '9deb2d59-8a05-4bc5-ac88-7ce5f4370ab5', base: 0, top: 11, mat: WHITE_STONE, crown: [{ type: 'parapet', h: 1.1, mat: WHITE_STONE }] },
    ...[[3, 1.8], [6, 3.6], [9, 5.5]].map(([dz, h], i) => ({ name: 'step' + i, kind: 'solid', shape: 'rect', size: [18, 3.2], at: [DF[0], DF[1] + 26 + 9 - dz], base: 0, top: h, mat: WHITE_STONE })),
    ...DF_STOREYS.map(([w, b, t], i) => ({
      name: 'f' + (i + 1), shape: 'rect', size: [w, w], at: DF, base: b, top: t, footprint: false,
      style: { ...DF_WALL, floorH: t - b, seed: 700 + i }, roof: { mech: false },
      crown: i < DF_STOREYS.length - 1
        ? [{ ...DF_EAVE, ov: i === 0 ? 4.5 : 3.2, depth: (w - DF_STOREYS[i + 1][0]) / 2 + 0.6 }]
        : [{ type: 'tangRoof', eave: 3.2, h: 8.8, curve: 0.45, lift: 1.0, base: 1.2, mat: ROOF_TILE, ridgeMat: '#2e2a27', double: { gap: 2.2, out: 3.6, h: 1.6 }, glow: '#ffc35a', strength: 2.2 }],
    })),
  ],
  // 平座栏杆（红色）：每层底部一圈
  bands: DF_STOREYS.slice(1).map(([w, b], i) => ({ part: 'f' + (i + 2), levels: [b + 1.0], h: 1.0, depth: 0.9, color: '#8e2b20', glow: '#ffb347', strength: 1.4 })),
  signs: [{ text: '大风阁', part: 'f1', face: 'S', y: 16.5, h: 2.4, color: '#e8c45a', bg: '#2a1c16' }],
  night: {
    floodlight: DF_STOREYS.map((_, i) => ({ part: 'f' + (i + 1), color: '#ffab3a', strength: 0.55 })).concat([{ part: 'tai2', color: '#ffe2b0', strength: 0.35 }]),
    outline: DF_STOREYS.slice(0, -1).map((_, i) => ({ part: 'f' + (i + 1), color: '#ffc35a', w: 0.35 })),
  },
  supersede: { names: ['汉城湖大风阁', '大风阁'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#汉城湖大风阁',
    sources: [
      'http://www.xatrm.com/tzggxasrmzfw/204140.jhtml',
      'https://baike.baidu.com/item/大风阁/4468043',
      'https://m.wenda.bendibao.com/tour/87448.shtm',
      'Overture building w370290098（大风阁，44.5×44.3 m）',
    ],
    photos: [
      'http://www.dianping.com/review/649029731',
      'http://tuchong.com/2486988/28962981/',
      'https://tuchong.com/1817474/15640837/',
      'http://souying8.tuchong.com/135517338/',
    ],
    confidence: 'high（高度、位置、形制）；medium（分层尺寸，按照片比例）',
    notes: '总高 63.3 m（顶层庑殿正脊）。高台两层按照片比例取 5.5 m / 11 m；塔身 6 层每层约 6.5–8 m、逐层收分 30→19 m（照片比例）；'
      + '腰檐外挑 3.2 m（首层 4.5 m）。原 landmarks2026 的 63.3 m 玻璃方盒（通用立面）被替代。',
  },
};

// ═════════════════════════ 3–4. 西安世博园：创意馆、自然馆（Plasma Studio，2011 世园会） ═════════════════════════
// Plasma Studio“Flowing Gardens”方案（e-architect / Dezeen / ArchDaily）：创意馆约 5000 m²，“三条平行体量”伸向锦绣湖面悬挑，
// 混凝土 + 本地青铜色金属；自然馆（温室）约 4000 m²，“半埋入山丘的巨型宝石”，马蹄形平面，折面玻璃“水晶洞穴”，两条坡道越过屋顶。
// 轮廓：OSM w254608593（创意馆）、w252885707（自然馆）；卫星 z19 描出创意馆三条体量的轴线（地图角约 57°，西南端伸向湖面）与自然馆马蹄形外缘。
// 高度无公开数据：按航拍照片比例估算（创意馆屋脊约 17–19 m；自然馆玻璃体最高约 11 m，由南端向两臂降低，半埋入土丘）。
const CY_BARS = [ // [西南端, 东北端, 宽, 脊高]（卫星 z19 量取）
  [[10535.0, -7187.0], [10581.5, -7256.7], 17, 16],
  [[10560.5, -7160.0], [10605.0, -7251.0], 21, 19],
  [[10584.0, -7154.0], [10629.7, -7222.9], 19, 17],
];
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const chuangyi = {
  id: 'lm2-expo-chuangyi',
  name: '世博园创意馆',
  fp: 'ae1aadde-86b0-4202-85d5-d599114bce2b',
  parts: [
    { name: 'base', fp: 'ae1aadde-86b0-4202-85d5-d599114bce2b', base: 0, top: 7, roof: { mech: false, parapet: 0.3 },
      style: { pattern: 'curtain', tint: '#2e3a41', spd: '#6e5b45', floorH: 3.5, colW: 2.2, spandrel: 0.1, mullW: 0.25, lit: 0.6 } },
    // 三条平行体量：青铜色金属折板屋面（底面矩形 → 缩短的屋脊）
    ...CY_BARS.map(([a, b, w, h], i) => ({
      name: 'bar' + i, kind: 'solid', pts: strip(a, b, w), topPts: strip(lerp2(a, b, 0.12), lerp2(a, b, 0.8), 1.2), base: 7, top: h, footprint: false,
      mat: { color: '#6a5e50', roughness: 0.55, metalness: 0.45 },
    })),
  ],
  signs: [{ text: '创意馆', part: 'base', face: 'SW', y: 5, h: 1.6, color: '#d9c7a0' }],
  night: { floodlight: [{ part: 'base', color: '#ffd9a8', strength: 0.35 }] },
  supersede: { names: ['世博园创意馆', '创意馆'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#世博园创意馆',
    sources: ['https://www.e-architect.com/china/flowing-gardens', 'https://www.dezeen.com/2011/05/20/the-creativity-pavilion-by-plasma-studio/',
      'https://world-architects.com/en/plasma-studio-sesto/project/international-horticultural-expo', 'Overture building w254608593（创意馆）'],
    photos: ['http://www1.xcar.com.cn/bbs/viewthread.php?tid=26364417', 'https://m.xa.bendibao.com/tour/133640.shtm'],
    confidence: 'medium（轮廓、体量走向）；low（高度，按照片比例）',
    notes: '三条体量的轴线与宽度按卫星 z19 量取（±2 m）；首层玻璃 7 m、折板屋面屋脊 16–19 m 为照片比例估算。原 landmarks2026 的 26 m 通用盒子被替代。',
  },
};
// 自然馆：马蹄形折面玻璃体（卫星 z19 描外缘，12 点简化）；玻璃面向内收 4.5 m 形成斜面，中部为土丘（不建）
const ZR_PTS = [10538, -6904, 10529.5, -6811, 10550.5, -6780.5, 10564, -6781.5, 10609.5, -6846, 10604, -6875, 10593.7, -6893, 10583.8, -6866,
  10566, -6815, 10556.6, -6829, 10551.7, -6862, 10546, -6885];
const ziran = {
  id: 'lm2-expo-ziran',
  name: '世博园自然馆',
  center: [10567, -6835],
  parts: [
    { name: 'glass', pts: ZR_PTS, topInset: 2.8, base: 0, top: 11, roof: { mech: false, parapet: 0.15 },
      style: { pattern: 'curtain', tint: '#86a6b3', spd: '#e7ecee', floorH: 3.2, colW: 2.8, spandrel: 0.04, mullW: 0.14, lit: 0.45 },
      crown: [{ type: 'slab', ov: 0.2, h: 0.25, mat: 'glassRoof' }] },
  ],
  signs: [{ text: '自然馆', part: 'glass', face: 'S', y: 3.5, h: 1.4, color: '#2f4a3a' }],
  night: { floodlight: [{ part: 'glass', color: '#bfe8ff', strength: 0.4 }] },
  supersede: { names: ['世博园自然馆', '自然馆 музей природы', '自然馆'] },
  site: ['2f0d3607-a358-4a98-8fc0-e9749f1b2ca8'],
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#世博园自然馆',
    sources: ['https://www.e-architect.com/china/flowing-gardens', 'Overture building w252885707（自然馆）', 'Esri z19 卫星（马蹄形外缘）'],
    photos: ['http://huaban.com/pins/1473538448/', 'http://you.ctrip.com/sight/xian7/52671.html', 'http://k.sina.com.cn/article_2810268711_pa7814c27027009apl.html'],
    confidence: 'medium（平面）；low（高度）',
    notes: '温室为“半埋入山丘”的折面玻璃体，最高处约 11 m（照片比例，南端最高、两臂向北埋入土丘）；模型用 2.8 m 收进的斜玻璃面近似折面（两臂最窄处约 8 m，收进过多会自交）。',
  },
};

// ═════════════════════════ 5. 西安半坡博物馆（浐河东岸，4A） ═════════════════════════
// 1958 年建成的新中国第一座史前遗址博物馆。照片（携程 / 美篇 / 大众点评，见 meta.photos）：
//   · 大门：两榀“人”字形交叉木构（粉褐色仿木石材），顶端交叉出头，横梁挂“西安半坡博物馆”金字，山花内有人面鱼纹；两侧为白墙门房，
//     檐下一道红黑彩陶纹饰带；大门面西，正对半坡路入口甬道（卫星：入口轴线 z≈−1500，甬道东端圆形水池 (9597, −1497)）。
//   · 遗址保护大厅：灰色毛石贴面，正立面顶部为弧形，前有大台阶（照片 02/06/08）；OSM w1512651327（83×79 m）。
// 高度无公开数据：大门按照片（门洞约 4 m 为尺）约 13.5 m、宽约 23 m；大厅墙身约 9.5 m + 弧形屋面（照片比例）。
const BP_GATE = [9528, -1500];
const BP_WOOD = { color: '#9d7f70', roughness: 0.85 }; // 粉褐色仿木石材
/** 斜梁（A 字形大门的一条腿）：底部中心 a、顶部中心 b（均为 [x,z]），截面 w×d，顶端离地 h */
const leg = (name, a, b, h, w = 1.3, d = 1.5) => ({
  name, kind: 'solid', pts: [a[0] - d / 2, a[1] - w / 2, a[0] + d / 2, a[1] - w / 2, a[0] + d / 2, a[1] + w / 2, a[0] - d / 2, a[1] + w / 2],
  topPts: [b[0] - d / 2, b[1] - w / 2, b[0] + d / 2, b[1] - w / 2, b[0] + d / 2, b[1] + w / 2, b[0] - d / 2, b[1] + w / 2],
  base: 0, top: h, mat: BP_WOOD, footprint: false,
});
const banpo = {
  id: 'lm2-banpo',
  name: '西安半坡博物馆',
  center: [9700, -1510],
  parts: [
    // 遗址保护大厅：灰色毛石墙 + 弧形屋面
    { name: 'hall', kind: 'solid', fp: '4b1b7f10-d32d-4148-acaa-96c9692d6976', base: 0, top: 9.5, mat: { color: '#8b908b', roughness: 0.95 },
      crown: [{ type: 'arch', h: 4.5, mat: { color: '#7c8286', roughness: 0.6, metalness: 0.2 } }] },
    { name: 'hallNE', kind: 'solid', fp: '9333bdc7-28ba-4532-813c-e6c83ef79308', base: 0, top: 8, mat: { color: '#8b908b', roughness: 0.95 },
      crown: [{ type: 'arch', h: 3, mat: { color: '#7c8286', roughness: 0.6, metalness: 0.2 } }] },
    // 陈列厅（前院北侧，中部半圆形）
    { name: 'exhibit', kind: 'podium', fp: 'a1116402-1059-48b3-8326-6d6b3e35831b', base: 0, top: 6.5,
      style: { pattern: 'stoneWindows', spd: '#e3dfd6', tint: '#39424a', floorH: 6.5, colW: 3.2, spandrel: 0.35, mullW: 1.2, lit: 0.5 }, roofMat: { color: '#9a9690', roughness: 0.9 } },
    // 大门：前后两榀 A 字交叉斜梁（南北跨，面西）
    ...[-3.5, 3.5].flatMap((dx, k) => [
      leg('legN' + k, [BP_GATE[0] + dx, BP_GATE[1] - 11.5], [BP_GATE[0] + dx, BP_GATE[1] + 2.6], 13.5),
      leg('legS' + k, [BP_GATE[0] + dx, BP_GATE[1] + 11.5], [BP_GATE[0] + dx, BP_GATE[1] - 2.6], 13.5),
    ]),
    // 横梁（挂门匾）+ 上横梁
    { name: 'beam', kind: 'solid', shape: 'rect', size: [9.5, 25], at: BP_GATE, base: 5.8, top: 7.2, mat: BP_WOOD, footprint: false },
    { name: 'beam2', kind: 'solid', shape: 'rect', size: [9.5, 13], at: BP_GATE, base: 8.9, top: 9.8, mat: BP_WOOD, footprint: false },
    // 山花：横梁以上的三角形板（人面鱼纹，深色）
    { name: 'gable', kind: 'solid', pts: [BP_GATE[0] - 0.3, BP_GATE[1] - 5.2, BP_GATE[0] + 0.3, BP_GATE[1] - 5.2, BP_GATE[0] + 0.3, BP_GATE[1] + 5.2, BP_GATE[0] - 0.3, BP_GATE[1] + 5.2],
      topPts: [BP_GATE[0] - 0.3, BP_GATE[1] - 0.3, BP_GATE[0] + 0.3, BP_GATE[1] - 0.3, BP_GATE[0] + 0.3, BP_GATE[1] + 0.3, BP_GATE[0] - 0.3, BP_GATE[1] + 0.3],
      base: 7.2, top: 11.6, mat: { color: '#6f5a4c', roughness: 0.9 }, footprint: false },
    // 两侧白墙门房
    ...[-1, 1].map((sg, i) => ({ name: 'lodge' + i, kind: 'solid', shape: 'rect', size: [7, 20], at: [BP_GATE[0] + 1, BP_GATE[1] + sg * 22], base: 0, top: 4.6,
      mat: { color: '#ecebe6', roughness: 0.9 }, crown: [{ type: 'slab', ov: 0.6, h: 0.5, mat: { color: '#9d7f70', roughness: 0.85 } }] })),
  ],
  bands: [0, 1].map((i) => ({ part: 'lodge' + i, levels: [3.6], h: 0.7, depth: 0.12, color: '#7a2f22' })), // 红黑彩陶纹饰带（简化为红褐色带）
  signs: [
    { text: '西安半坡博物馆', part: 'beam', face: 'W', y: 6.5, h: 1.1, color: '#e8c35a', serif: true },
    { text: '半坡遗址', part: 'hall', face: 'W', y: 8, h: 1.8, color: '#c9b27a', serif: true },
  ],
  night: { floodlight: [{ part: 'hall', color: '#ffe0b0', strength: 0.25 }, { part: 'beam', color: '#ffd08a', strength: 0.5 }] },
  supersede: { names: ['半坡博物馆', '西安半坡博物馆'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#西安半坡博物馆',
    sources: ['http://xa.bendibao.com/tour/2020810/ly77108.shtm（4A 名单）', 'Overture building w1512651327 / w1512651315', 'Esri z19 卫星（入口轴线、水池）'],
    photos: ['https://you.ctrip.com/sight/xian7/1409.html', 'https://www.meipian.cn/（西安半坡博物馆--李泓广）', 'http://www.dianping.com/（半坡遗址大厅）'],
    confidence: 'medium（形制、落位）；low（大门、大厅高度按照片比例）',
    notes: '大门位置按卫星入口轴线与路口推定（±5 m）；A 字交叉斜梁顶端约 13.5 m（以门洞约 4 m 为尺）、跨 23 m、两榀间距 7 m（照片比例）。'
      + '遗址大厅墙高 9.5 m + 弧形屋面 4.5 m（照片比例）。原 heritage26 通用院落（3 座仿古建筑，与实物不符）被替代。',
  },
};

// ═════════════════════════ 6. 易俗社文化街区（钟楼东北，西一路） ═════════════════════════
// 2021-09 开街，全国首个以秦腔为主题的文化街区：百年易俗社剧场（1917）、露天戏台、中国秦腔艺术博物馆、易俗社百年博物馆，
// 地下为“东邦哥”复古街区（澎湃新闻《丝路文明》特刊）。易俗大剧院已由 core.js 精建。
// 轮廓：OSM w1465147164（易俗社剧场）、w1465147132（百年博物馆）、戏台、w1465147345（秦腔艺术博物馆，屋面为白色筒拱）。
// 照片（见 meta.photos）：剧场正立面灰砖三层、绿琉璃瓦腰檐、蓝底金字“西安易俗社”匾、门前一对石狮；戏台为灰瓦歇山顶、朱红柱，台口朝南对广场。
const GREEN_TILE = { color: '#3f6b4f', roughness: 0.5, metalness: 0.1 };
const yisushe = {
  id: 'lm2-yisushe',
  name: '易俗社文化街区',
  center: [178, -200],
  parts: [
    { name: 'theatre', fp: 'e64e2f24-978a-43e7-a82a-154ba145e340', base: 0, top: 13, roof: { mech: false, parapet: 0.9 },
      style: { pattern: 'stoneWindows', spd: '#6e7072', tint: '#2e2622', floorH: 4.3, colW: 3.4, spandrel: 0.45, mullW: 1.4, lit: 0.6 },
      crown: [{ type: 'eave', y: 4.6, ov: 1.4, depth: 0.8, h: 0.9, fascia: 0.35, mat: GREEN_TILE, eaveMat: '#6b2a20' },
        { type: 'eave', y: 12.2, ov: 0.9, depth: 0.6, h: 0.7, fascia: 0.3, mat: GREEN_TILE, eaveMat: '#3a3a3a' }] },
    { name: 'museum100', fp: 'cb119cd0-e3ad-4698-9c17-05dc68f690cc', base: 0, top: 11, roof: { mech: false },
      style: { pattern: 'stoneWindows', spd: '#7b7c7c', tint: '#2d3034', floorH: 3.8, colW: 3.0, spandrel: 0.5, mullW: 1.2, lit: 0.55 },
      crown: [{ type: 'eave', ov: 1.2, depth: 1.2, h: 0.9, mat: ROOF_TILE }] },
    { name: 'stage', fp: 'd20e5109-6d94-4a8a-afc9-f303f7415087', base: 0, top: 7.5, roof: { mech: false },
      style: { pattern: 'stoneWindows', spd: '#8a2a20', tint: '#3a1a14', floorH: 7.5, colW: 4.5, spandrel: 0.2, mullW: 0.8, lit: 0.8 },
      crown: [{ type: 'cnhip', style: 'xieshan', h: 4.2, ov: 1.6, lift: 0.5 }] },
    { name: 'qinqiang', kind: 'podium', fp: '394c31da-6df3-4843-80fa-78edb780ab2f', base: 0, top: 12,
      style: { pattern: 'stoneWindows', spd: '#8a8a88', tint: '#2d3034', floorH: 4, colW: 3.2, spandrel: 0.55, mullW: 1.2, lit: 0.55 }, roofMat: { color: '#8f8f8c', roughness: 0.9 },
      // 东半部四条白色筒拱屋面（卫星）
      crown: [0, 1, 2, 3].map((k) => ({ type: 'arch', size: [30, 11], at: [226, -176 + k * 12.5], rot: 0, h: 3.2, mat: { color: '#e9e9e6', roughness: 0.5 } })) },
  ],
  signs: [
    { text: '西安易俗社', part: 'theatre', face: 'N', y: 10.6, h: 1.3, color: '#e8c35a', bg: '#1f3f8a' },
    { text: '中国秦腔艺术博物馆', part: 'qinqiang', face: 'W', y: 10, h: 1.2, color: '#f2efe8' },
  ],
  night: { floodlight: [{ part: 'theatre', color: '#ffd7a0', strength: 0.4 }, { part: 'stage', color: '#ffb866', strength: 0.5 }] },
  supersede: { names: ['易俗社剧场·易俗社文化街区', '易俗社剧场', '易俗社文化街区'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#易俗社文化街区',
    sources: ['https://www.thepaper.cn/newsDetail_forward_21770477', 'public/data/pois.json（易俗社剧场、易俗社百年博物馆、中国秦腔艺术博物馆）',
      'Overture building w1465147164 / w1465147132 / w1465147345 与“戏台”'],
    photos: ['https://www.sohu.com/（西安必打卡！易俗社文化街区全攻略）', 'http://www.vcg.com/（西安｜易俗社文化街区）', 'https://www.cnwest.com/（古都西安的又一张城市名片——易俗社文化街区）'],
    confidence: 'high（轮廓、构成）；medium（高度按照片数层：剧场 3 层约 13 m、戏台檐口 7.5 m）',
    notes: '剧场正立面朝北（西一路）。秦腔艺术博物馆东半部屋面按卫星为四条白色筒拱。原 heritage26 通用院落被替代；易俗大剧院保留 core.js 模型。',
  },
};

// ═════════════════════════ 7. 老钢厂设计创意产业园（原陕西钢厂，幸福林带东侧） ═════════════════════════
// 依托陕钢厂工业遗存改造（“设计创意”主题），与幸福林带一路之隔。照片（大众点评 / 人民日报 / 今日头条，见 meta.photos）：
// 灰砖 / 水泥长条厂房，屋脊上一道凸起的采光天窗（气楼）；入口红砖楼带镂空砖花墙、白色“老钢厂设计创意产业园 STEEL TIME IDEA PARK”字与楼顶“老钢厰”大字。
// 轮廓：OSM w1270261805 / w1270262006（8 号楼）/ w1270262051 / w1270260614 / w1270261032 / w1270261251（城东印象体验馆）。
// 高度无公开数据：厂房檐口按照片约 8–12 m、气楼再高 3.5 m（照片比例）。
const LG_WALL = { pattern: 'grid', spd: '#8e8a84', tint: '#3a4146', floorH: 6, colW: 6.5, spandrel: 0.55, mullW: 1.6, lit: 0.45 };
const LG_BRICK = { ...LG_WALL, spd: '#96503b', tint: '#2f2a28' };
const LG_ROOF = { color: '#6d6f70', roughness: 0.85 };
const LG_HALLS = [ // [名, 轮廓, 檐口, 气楼 [长, 宽, 地图角] | null, 立面, 质心]
  ['h8', 'c399b392-88ff-4b91-b17e-d126f039691a', 12, [88, 11, 90], LG_BRICK, [6882.9, 1427.6]],
  ['hN', 'e739b18b-5e7d-4e85-b138-3cf4f1e883cf', 12, [124, 12, 0], LG_WALL, [6776.1, 1349.9]],
  ['hW', '3d71c235-a8c9-4d1f-8887-7445320e7746', 11, [64, 9, 90], LG_WALL, [6728.9, 1418.5]],
  ['hS', '0cc4b6c7-75d9-4ad9-b41b-9dc1ea7ec484', 10, [80, 9, 0], LG_WALL, [6794.7, 1517.5]],
  ['hL', '677beedd-da0e-415e-af20-af9f2c77d37b', 8, null, LG_BRICK, null],
  ['hC', '26da56d0-f2c1-4a7b-bc40-141343c6f633', 9, null, LG_WALL, null],
];
const laogang = {
  id: 'lm2-laogang',
  name: '老钢厂设计创意产业园',
  center: [6800, 1430],
  parts: LG_HALLS.flatMap(([n, fp, h, mon, st, c]) => [
    { name: n, kind: 'podium', fp, base: 0, top: h, style: st, roofMat: LG_ROOF,
      crown: mon ? [] : [{ type: 'pubHip', ridge: 1, h: 2.2, eave: 0.6, mat: LG_ROOF, eaveMat: '#555555' }] },
    ...(mon ? [{ name: n + 'mon', shape: 'rect', size: [mon[0], mon[1]], at: c, rot: mon[2], base: h, top: h + 3.5, footprint: false, roof: { mech: false },
      style: { pattern: 'horizontalBands', tint: '#4a5a64', spd: '#8e8a84', floorH: 3.5, colW: 2.4, spandrel: 0.3, mullW: 0.2, lit: 0.5 },
      crown: [{ type: 'pubHip', ridge: 1, h: 1.4, eave: 1.0, mat: LG_ROOF, eaveMat: '#555555' }] }] : []),
  ]),
  signs: [
    { text: '老钢厂设计创意产业园', part: 'h8', face: 'W', near: 'S', y: 9.5, h: 1.6, color: '#f4f2ee' },
    { text: 'STEEL TIME IDEA PARK', part: 'h8', face: 'W', near: 'S', y: 7.9, h: 0.8, color: '#f4f2ee' },
    { text: '老钢厰', part: 'hN', face: 'S', near: 'E', y: 11, h: 2.4, color: '#dcdad4' },
  ],
  night: { floodlight: [{ part: 'h8', color: '#ffc68a', strength: 0.3 }] },
  supersede: { names: ['老钢厂设计创意产业园', '老钢厂设计创意园8号楼', '老钢厂设计创意园3号楼', '城东印象体验馆'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#老钢厂设计创意产业园',
    sources: ['https://news.qq.com/rain/a/20250113A0430F00', 'https://zhuanlan.zhihu.com/p/245248879', 'Overture building（OSM w1270261805 等 6 座厂房，名称“老钢厂设计创意园8号楼”）'],
    photos: ['http://www.dianping.com/（老钢厂设计创意产业园，照片 00/02/04/05）', 'http://www.people.com.cn/（人民日报：聚焦西安老旧厂区改造利用）', 'https://www.toutiao.com/（老厂房焕发新生机）'],
    confidence: 'medium（轮廓、屋面形式）；low（高度、招牌位置）',
    notes: '厂房檐口 8–12 m、屋脊气楼 3.5 m 均按照片比例估算；红砖入口楼的确切位置未能在卫星上确认，招牌按园区西侧主入口方向挂在 8 号楼西立面（低可信）。',
  },
};

// ═════════════════════════ 8. 陕西考古博物馆（长安区郭杜，2022 开馆） ═════════════════════════
// 全国首座以考古学为主题的博物馆。照片（小红书 / 抖音 / 百度，见 meta.photos）：米黄石材两层方形基座、正中入口上方金字“陕西考古博物馆”，
// 其上为逐层收进的三重深灰金属屋檐（最上为四坡顶 + 脊饰），檐间玻璃带窗；前有长桥（跨水面）与广场。
// 位置：Overture 覆盖范围外，Esri z18 卫星量取：基座约 86×89 m，中心 (−5914.5, 15650)，三重屋面依次约 67×72、46、32 m 见方。
// 高度无公开数据：按照片比例，基座 11 m、各层屋檐约 17 / 22.5 m，顶部屋脊约 33 m。
const KG = [-5914.5, 15650];
const KG_STONE = { pattern: 'stoneWindows', spd: '#dccfb3', tint: '#3a4248', floorH: 5.5, colW: 3.4, spandrel: 0.55, mullW: 1.4, lit: 0.5 };
const KG_GLASS = { pattern: 'curtain', tint: '#3d5566', spd: '#d8ccb2', floorH: 5.5, colW: 2.6, spandrel: 0.18, mullW: 0.5, lit: 0.55 };
const KG_EAVE = { type: 'eave', h: 1.6, fascia: 0.8, mat: ROOF_GRAY, eaveMat: '#2f3337' };
const kaogu = {
  id: 'lm2-kaogu',
  name: '陕西考古博物馆',
  center: KG,
  parts: [
    { name: 'plinth', shape: 'rect', size: [86, 89], at: KG, base: 0, top: 11, style: KG_STONE, roof: { mech: false, parapet: 1.0 } },
    { name: 'mid', shape: 'rect', size: [62, 64], at: KG, base: 11, top: 16.5, footprint: false, style: KG_GLASS, roof: { mech: false },
      crown: [{ ...KG_EAVE, ov: 4, depth: 7.5 }] },
    { name: 'up', shape: 'rect', size: [46, 46], at: KG, base: 16.5, top: 22, footprint: false, style: KG_GLASS, roof: { mech: false },
      crown: [{ ...KG_EAVE, ov: 4, depth: 8 }] },
    { name: 'top', shape: 'rect', size: [30, 30], at: KG, base: 22, top: 26, footprint: false, style: KG_GLASS, roof: { mech: false },
      crown: [{ type: 'tangRoof', eave: 4, h: 6.2, ridge: 0.25, curve: 0.2, lift: 0.4, base: 0.8, mat: ROOF_GRAY, ridgeMat: '#2f3337' }] },
  ],
  signs: [{ text: '陕西考古博物馆', part: 'plinth', face: 'S', y: 8.6, h: 2.0, color: '#b38a3e', serif: true }],
  night: { floodlight: [{ part: 'plinth', color: '#ffe2b8', strength: 0.35 }] },
  supersede: { names: ['陕西考古博物馆'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#陕西考古博物馆',
    sources: ['public/data/pois.json 陕西考古博物馆 (−5913, 15658)', 'Esri World Imagery z18（平面量取）', 'research/refs/landmarks2026/heritage.json#陕西考古博物馆'],
    photos: ['http://news.sohu.com/a/538544191_267106', 'http://www.xiaohongshu.com/discovery/item/62b01c22000000000102ec2d', 'http://www.douyin.com/note/7336381336485137673'],
    confidence: 'medium（平面按卫星）；low（高度按照片比例）',
    notes: '无 Overture 轮廓，平面按卫星量取（±3 m）。原 heritage26 通用单体（1 座仿古殿）被替代。',
  },
};

// ═════════════════════════ 9. 曲江竞技中心（电竞中心，Aedas，2022） ═════════════════════════
// 西北首座电竞主题综合场馆：建筑面积 77650 m²，万人座，钢框架 + 弦支穹顶，4 层看台；白色为主、银金点缀，
// 立面为钢化夹胶玻璃幕墙 + 铝镁锰屋面 + 金属装饰翅片，“芙蓉花心”层层弧形花瓣（gooood / 央广网）。
// 轮廓：OSM w1429172177（188×134 m 蛋形，长轴近东西，东端收尖）。高度无公开数据：按航拍照片比例，檐口约 24 m、穹顶约 33 m。
const dianjing = {
  id: 'lm2-dianjing',
  name: '曲江竞技中心',
  fp: 'd63d68de-f53d-4786-9a19-d8aad6435449',
  parts: [
    { name: 'base', fp: 'd63d68de-f53d-4786-9a19-d8aad6435449', base: 0, top: 8, roof: { mech: false, parapet: 0.2 },
      style: { pattern: 'curtain', tint: '#334a58', spd: '#e8e8e4', floorH: 4, colW: 2.2, spandrel: 0.12, mullW: 0.2, lit: 0.7 } },
    { name: 'shell', fp: 'd63d68de-f53d-4786-9a19-d8aad6435449', grow: 1.5, topScale: 0.93, base: 8, top: 24, footprint: false, roof: { mech: false, parapet: 0.2 },
      style: { pattern: 'horizontalBands', tint: '#8a9aa3', spd: '#f2f2ef', floorH: 2.6, colW: 3.2, spandrel: 0.62, mullW: 0.1, lit: 0.25 },
      crown: [{ type: 'dome', r: [84, 59], h: 9, mat: { color: '#f0f0ec', roughness: 0.4, metalness: 0.3 }, ring: false }] },
  ],
  bands: [{ part: 'shell', levels: [10, 14, 18, 22], wave: { amp: 2.2, len: 140, phase: 0.4 }, h: 0.5, depth: 0.5, color: '#e4e2dc', glow: '#9fd4ff', strength: 1.4 }],
  signs: [{ text: '曲江竞技中心', part: 'base', face: 'S', y: 6, h: 1.8, color: '#c9a45a' }],
  night: { floodlight: [{ part: 'shell', color: '#ff7a3c', strength: 0.45 }] },
  supersede: { names: ['曲江竞技中心（电竞中心）', '曲江竞技中心'] },
  meta: {
    category: 'sports',
    dossier: 'landmarks2.json#曲江竞技中心',
    sources: ['https://www.gooood.cn/xian-qujiang-sports-complex-by-aedas.htm', 'https://www.cnr.cn/sxpd/c/xty/20230106/t20230106_526116237.shtml', 'Overture building w1429172177（曲江竞技中心）'],
    photos: ['https://www.xiancn.com/content/2022-06/02/content_6571397.htm', 'http://www.sohu.com/a/630612525_121610241', 'http://www.sohu.com/a/701434673_121117480'],
    confidence: 'high（轮廓、形体、配色）；low（高度按照片比例）',
    notes: '首层玻璃 8 m，其上白色金属弧形“花瓣”外壳收分到 24 m（模型用 0.93 收分 + 波浪饰带近似层层花瓣），椭圆穹顶矢高 9 m。夜景（WETES 照片）外壳暖橙泛光。',
  },
};

// ═════════════════════════ 10. 大唐西市（金市广场西侧主楼群，4A） ═════════════════════════
// 唐长安西市遗址上的文化商业街区（大唐西市博物馆、丝绸之路风情街、金市广场）。照片（携程 / 国际在线 / 微信公众号，见 meta.photos）：
// 金市广场西侧主楼面东：白石高台 + 红色木构的唐风主殿（重檐），两侧方形高阙楼，以空中廊桥与主殿相连；南北两翼为 3–4 层唐风商业楼
// （白墙、朱红窗框与栏杆、深灰瓦）；广场上有圆形下沉广场与骆驼群雕。夜景：金色轮廓灯 + 暖光泛光。
// 轮廓：OSM w17405494（主楼 80.7×65.5 m）、w1267628564（北翼）、w1267628811（南翼）。阙楼、主殿位置按 Esri z19 卫星（屋面与阴影）量取。
// 高度无公开数据：按照片比例，主楼基座 12 m、阙楼约 30 m + 攒尖顶、主殿重檐屋脊约 35 m、两翼檐口约 16 m。
const XS_WALL = { pattern: 'stoneWindows', spd: '#e4ddd0', tint: '#6e2a20', floorH: 4.2, colW: 3.2, spandrel: 0.42, mullW: 1.0, lit: 0.7 };
const XS_RED = { pattern: 'stoneWindows', spd: '#8e2f24', tint: '#3a2a22', floorH: 4.2, colW: 3.0, spandrel: 0.3, mullW: 0.9, lit: 0.75 };
const XS_C = [-3592, 1454];
const xishi = {
  id: 'lm2-xishi',
  name: '大唐西市',
  center: XS_C,
  parts: [
    { name: 'main', kind: 'podium', fp: 'f4c72d77-82d2-4d52-a6a3-5f20e708eaea', base: 0, top: 12, style: XS_WALL, roofMat: { color: '#9a958d', roughness: 0.9 } },
    { name: 'hall', shape: 'rect', size: [30, 32], at: XS_C, base: 12, top: 21, footprint: false, style: XS_RED, roof: { mech: false },
      crown: [{ type: 'tangRoof', eave: 3, h: 8, curve: 0.45, lift: 1.0, base: 1.0, double: { gap: 3, out: 4, h: 1.8 }, glow: '#ffc35a', strength: 2 }] },
    ...[[-3566, 1428], [-3566, 1481]].map((at, i) => ({ name: 'que' + i, shape: 'rect', size: [14, 14], at, base: 0, top: 30, style: XS_WALL, roof: { mech: false },
      crown: [{ type: 'tangRoof', eave: 2.2, h: 5, ridge: 0, curve: 0.4, lift: 0.8, base: 0.8, glow: '#ffc35a', strength: 2 }] })),
    // 阙楼与主殿之间的空中廊桥（照片 03）
    ...[[[-3566, 1435], [-3578, 1446]], [[-3566, 1474], [-3578, 1462]]].map(([a, b], i) => ({ name: 'bridge' + i, kind: 'solid', pts: strip(a, b, 5), base: 17, top: 20.5, footprint: false,
      mat: { color: '#8e2f24', roughness: 0.7 }, crown: [{ type: 'slab', ov: 0.8, h: 0.6, mat: ROOF_TILE }] })),
    { name: 'wingN', fp: 'ba35b40d-d361-43c7-bd74-46677eac2a8e', base: 0, top: 16, style: XS_WALL, roof: { mech: false },
      crown: [{ type: 'eave', y: 8.4, ov: 1.6, depth: 1.2, h: 1.2, mat: ROOF_TILE }, { type: 'tangRoof', eave: 2, h: 4.5, curve: 0.4, lift: 0.7, base: 0.8, glow: '#ffc35a', strength: 1.8 }] },
    { name: 'wingS', fp: '96cbe3bd-36d3-4a36-8a68-4a840f339a5b', base: 0, top: 16, style: XS_WALL, roof: { mech: false },
      crown: [{ type: 'eave', y: 8.4, ov: 1.6, depth: 1.2, h: 1.2, mat: ROOF_TILE }, { type: 'tangRoof', eave: 2, h: 4.5, curve: 0.4, lift: 0.7, base: 0.8, glow: '#ffc35a', strength: 1.8 }] },
  ],
  signs: [{ text: '大唐西市', part: 'hall', face: 'E', y: 18.5, h: 2.2, color: '#e8c35a', bg: '#3a1c14' }],
  night: { floodlight: [{ part: 'main', color: '#ffc27a', strength: 0.45 }, { part: 'que0', color: '#ffc27a', strength: 0.4 }, { part: 'que1', color: '#ffc27a', strength: 0.4 }] },
  supersede: { names: ['大唐西市（含大唐西市博物馆）', '大唐西市'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#大唐西市',
    sources: ['http://xa.bendibao.com/tour/2020810/ly77108.shtm（4A：西安大唐西市文化景区）', 'public/data/pois.json 大唐西市 / 大唐西市博物馆',
      'Overture building w17405494（主楼）/ w1267628564 / w1267628811', 'Esri z19 卫星（阙楼、主殿落位）'],
    photos: ['http://www.chinanews.com.cn/（2017丝博会西安大唐西市分会场，国际在线）', 'https://mp.weixin.qq.com/（跟着外教游西安---畅游大唐西市!）', 'https://you.ctrip.com/（西安大唐西市）'],
    confidence: 'medium（构成、落位）；low（高度按照片比例）',
    notes: '只精建金市广场西侧主楼群（主殿 + 双阙 + 廊桥 + 南北翼楼）；大唐西市博物馆（北侧）及周边仿唐商业楼仍由通用建筑承担。原 heritage26 通用院落被替代。',
  },
};

// ═════════════════════════ 11. 西安国际会展中心（丝路国际展览中心，gmp，浐灞） ═════════════════════════
// gmp 设计（有方 archiposition / 国资委“天圆地方长安月”纪实）：鱼骨式展厅群，6 个展厅（2 个超大多功能厅净高 16 m、净展 16000 m²；
// 4 个标准厅净高 13 m、净展 10000 m²），均无柱；屋面为层层起伏的弧形条带（取意丝绸飘带 / 沙丘），石材墙身为稳重基座，超大门洞取意城门。
// 轮廓：OSM w808104180“西安国际会展中心展厅”（整组梳齿形外轮廓，930×356 m，主轴地图角 55°）；各展厅矩形由该轮廓的梳齿角点反算：
// 沿 −35.3° 方向 142–150 m、沿 54.7° 方向 98–194 m（超大厅）。卫星：各厅屋面为沿 −35° 方向的平行弧形条带（约 8–9 m 一条）。
// 高度无公开数据：按净高 13/16 m + 屋架，标准厅檐口取 19 m、超大厅 23 m，条带拱起 2.2 m；中央连廊 12 m。原 skyline SPECIAL.expo（通用筒拱盒子）被替代。
const EX_U = -35.3; // 屋面条带方向（地图角）
const EX_HALLS = [ // [名, 中心, 沿 U 长, 沿 V 宽, 檐口]
  ['H1', [8734.9, -8709.4], 144.7, 193.7, 23], ['H2', [8841.7, -8857.9], 149.6, 100.8, 19], ['H3', [8914.1, -8963.4], 150.3, 100.9, 19],
  ['H4', [8991.1, -9066.7], 147.8, 98.3, 19], ['H5', [8813.7, -9188.6], 146.2, 103.2, 19], ['H6', [8744.3, -9080.6], 145.5, 99.6, 19],
  ['H7', [8672.0, -8973.5], 142.1, 100.6, 19], ['H8', [8567.0, -8825.1], 147.5, 193.7, 23], ['H9', [8416.0, -8605.9], 140.0, 142.4, 21],
  ['H10', [8623.6, -8473.3], 150.7, 143.5, 21],
];
const EX_WALL = { pattern: 'stoneWindows', spd: '#e8e6e0', tint: '#46545e', floorH: 6.4, colW: 6, spandrel: 0.72, mullW: 1.4, lit: 0.45 };
const expoHalls = EX_HALLS.flatMap(([n, c, Lu, Lv, h]) => {
  const k = Math.round(Lv / 8.6), sw = Lv / k;
  return [{
    name: n, shape: 'rect', size: [Lu, Lv], at: c, rot: EX_U, base: 0, top: h, style: EX_WALL, roof: { mech: false, parapet: 0.4 },
    crown: Array.from({ length: k }, (_, i) => ({ type: 'arch', size: [Lu - 1.5, sw], at: along(c, EX_U, 0, -Lv / 2 + (i + 0.5) * sw), rot: EX_U, h: 2.2, seg: 10,
      mat: { color: '#e6e6e2', roughness: 0.45, metalness: 0.35 } })),
  }];
});
const expo = {
  id: 'lm2-expo-hall',
  name: '西安国际会展中心',
  center: [8700.4, -8833.5],
  parts: [
    { name: 'spine', kind: 'podium', fp: 'af8bdf53-15db-4fcc-b171-a8cd11e4c04a', grow: -1.5, base: 0, top: 12, // 内缩 1.5 m：避免与展厅外墙共面闪烁
      style: { pattern: 'curtain', tint: '#3e5a6a', spd: '#dcdcd8', floorH: 6, colW: 3, spandrel: 0.15, mullW: 0.3, lit: 0.7 }, roofMat: { color: '#b9b8b3', roughness: 0.8 } },
    ...expoHalls,
    { name: 'lobby', shape: 'rect', size: [94.7, 61.1], at: [8449.5, -8463.4], rot: EX_U, base: 0, top: 24, roof: { mech: true },
      style: { pattern: 'curtain', tint: '#3e5a6a', spd: '#c9cbcb', floorH: 6, colW: 3.2, spandrel: 0.1, mullW: 0.3, lit: 0.7 }, crown: [{ type: 'slab', ov: 3, h: 1.2, mat: '#a7a9aa' }] },
  ],
  signs: [{ text: '西安国际会展中心', part: 'H8', face: 'SW', y: 18, h: 3.2, color: '#5b6b78' }],
  night: { floodlight: [{ part: 'spine', color: '#dfeeff', strength: 0.35 }, ...['H1', 'H8'].map((p) => ({ part: p, color: '#fff2dc', strength: 0.25 }))] },
  supersede: { keys: ['expo'], names: ['西安国际会展中心展厅', '西安丝路国际展览中心（西安国际会展中心展厅）', '西安丝路国际展览中心'] },
  meta: {
    category: 'expo',
    dossier: 'landmarks2.json#西安国际会展中心',
    sources: ['https://www.archiposition.com/items/20200803031222', 'http://www.sasac.gov.cn/n2588025/n2641616/c14530534/content.html',
      'http://m.cnwest.com/xian/a/2020/03/23/18595972.html', 'Overture building w808104180（西安国际会展中心展厅）', 'Esri z18 卫星（屋面条带方向）'],
    photos: ['http://www.sohu.com/（gmp 新作：西安丝路国际会议中心 展览中心）', 'https://www.vcg.com/（西安丝路国际展览中心——大号会展）', 'http://ydyl.china.com.cn/2018-08/31/content_61216412.htm'],
    confidence: 'high（平面、屋面条带形式）；low（高度）',
    notes: '展厅矩形由 OSM 梳齿轮廓角点反算（±2 m）；西北端 H9/H10 与登录厅 lobby 的分界按卫星判读（±8 m）。檐口 19/21/23 m 为按净高推定，屋面条带拱起 2.2 m。',
  },
};

// ═════════════════════════ 12. 禾盛京广中心（高新唐延路 11 号，1# 200 m） ═════════════════════════
// 项目由 2 栋国际甲级写字楼 + 4 栋甲级写字楼 + 4 万 m² 商业（T11 购物中心）组成：1# 约 200 m / 41 层，2# 约 100 m / 24 层，
// 3#、4#、5# 约 100 m / 28 层，6# 约 100 m / 26 层；外立面纯玻璃幕墙，11 m 挑空大堂，4 m 层高（安居客 / 吉屋楼盘资料）。
// 1#（A 座）后被中国人寿收购，更名“西安国寿金融中心”。轮廓：OSM w988359467（A）/468（B）/470（D）等与 T11 商场 w988359466。
// 楼号对应：A=1#（OSM 标注 200 m / 41 层，与资料一致）；B=2#（OSM 亦标 200 m，与资料 100 m 不符，按资料）；C/D/E=3–5#、F=6#（按平面推定）。
// 原 landmarks2026 两座 200 m 通用塔落位有误（在商场屋面中部），此处按 OSM 塔楼轮廓重建。
const HS_GLASS = { pattern: 'verticalFins', tint: '#2c4f6e', spd: '#b8c4cc', floorH: 4.0, colW: 1.5, spandrel: 0.12, mullW: 0.22, lit: 0.45 };
const HS_GLASS2 = { ...HS_GLASS, tint: '#355d7c', colW: 1.8 };
const hesheng = {
  id: 'lm2-hesheng',
  name: '禾盛京广中心',
  fp: '0b974a7e-8018-4108-815b-9ccb119b0e74',
  parts: [
    { name: 'mall', kind: 'podium', fp: '0b974a7e-8018-4108-815b-9ccb119b0e74', base: 0, top: 24,
      style: { pattern: 'retail', tint: '#3a5566', spd: '#d8d6d0', floorH: 4.8, colW: 3.2, spandrel: 0.3, mullW: 0.3, lit: 0.8 }, roofMat: { color: '#9a9b98', roughness: 0.85 } },
    { name: 'A', fp: 'abb05683-2a73-42b1-b9ec-00a0011062f2', base: 0, top: 200, style: HS_GLASS, setbacks: [{ at: 188, inset: 1.8 }], crown: [{ type: 'parapet', h: 3.5 }] },
    { name: 'B', fp: '658c1eb3-1aed-45fd-978b-4eb6f9e56f0a', base: 0, top: 100, style: HS_GLASS2, crown: [{ type: 'parapet', h: 2.5 }] },
    { name: 'C', fp: '978c19a4-f0bb-4f91-8896-a7ada879305e', base: 0, top: 100, style: { ...HS_GLASS2, seed: 31 }, crown: [{ type: 'parapet', h: 2.5 }] },
    { name: 'D', fp: 'a3faa7c2-aeb9-4a4e-a415-bec2445c6f7d', base: 0, top: 100, style: { ...HS_GLASS2, seed: 32 }, crown: [{ type: 'parapet', h: 2.5 }] },
    { name: 'E', fp: '5a84323a-4032-43c2-9130-f957a215ddd7', base: 0, top: 100, style: { ...HS_GLASS2, seed: 33 }, crown: [{ type: 'parapet', h: 2.5 }] },
    { name: 'F', fp: '42e46c83-bb32-4531-9b20-3579b67794c3', base: 0, top: 96, style: { ...HS_GLASS2, seed: 34 }, crown: [{ type: 'parapet', h: 2.5 }] },
  ],
  signs: [{ text: '禾盛京广T11', part: 'mall', face: 'W', y: 20, h: 3, color: '#ffffff', glow: '#bfe3ff' }],
  night: { outline: [{ part: 'A', color: '#e8f2ff', w: 0.5, vertical: true }] },
  supersede: { names: ['禾盛京广中心A座', '禾盛京广中心B座', '禾盛京广T11购物中心', '禾盛京广中心-A座', '禾盛京广中心-B座'] },
  meta: {
    category: 'office',
    dossier: 'landmarks2.json#禾盛京广中心',
    sources: ['https://xa.fang.anjuke.com/loupan/251268.html', 'https://xa.jiwu.com/loupan/263622.html', 'https://baike.baidu.com/item/禾盛京广中心/23014933',
      'Overture building w988359466–w988359470（A–F 座、T11）'],
    photos: ['https://www.360xzl.com/（禾盛京广中心出租动态效果图）', 'http://www.dianping.com/（禾盛京广中心 LALA BLOCK 实景）', 'https://www.sohu.com/（中国人寿收购禾盛京广中心A栋 更名为西安国寿金融中心）'],
    confidence: 'high（落位、A 座高度）；medium（B–F 楼号对应与高度）',
    notes: 'A 座顶部 188 m 以上略收进 + 3.5 m 女儿墙（照片塔顶线脚）；T11 商场裙房 24 m（约 5 层）按照片估计。',
  },
};

// ═════════════════════════ 13. 西安丽思卡尔顿酒店（高新锦业路） ═════════════════════════
// 照片（携程 / 酒店官方，见 meta.photos）：约 22 层板式塔楼，中部白色方格窗立面，外包一圈深色玻璃“门框”（两侧竖向 + 顶部横向），
// 顶部挑出的黑色盒子上有白色“THE RITZ-CARLTON”招牌；底部为石材 + 玻璃裙楼。东南为同品牌公寓塔楼（不在本条）。
// 轮廓：OSM w929222953（塔楼 + 裙楼），塔楼按轮廓西北块（52×42 m，长边地图角 61°）内的板楼 50×24 m 布置。高度 100 m（landmarks2026 调研）。
const RZ = [-4560.9, 3961.7];
const ritz = {
  id: 'lm2-ritz',
  name: '西安丽思卡尔顿酒店',
  center: RZ,
  parts: [
    { name: 'podium', kind: 'podium', fp: 'd4301028-afd3-421f-be28-831ae31e4628', base: 0, top: 14,
      style: { pattern: 'stoneWindows', spd: '#d9d6cf', tint: '#2b3238', floorH: 4.6, colW: 3.2, spandrel: 0.38, mullW: 1.0, lit: 0.8 }, roofMat: { color: '#7d8b6c', roughness: 0.9 } },
    { name: 'frame', shape: 'rect', size: [50, 24], at: RZ, rot: 61.1, base: 0, top: 88, roof: { mech: false },
      style: { pattern: 'curtain', tint: '#1f2830', spd: '#2a2f33', floorH: 3.8, colW: 1.6, spandrel: 0.2, mullW: 0.2, lit: 0.35 } },
    { name: 'face', kind: 'facade', shape: 'rect', size: [38, 25], at: RZ, rot: 61.1, base: 14, top: 84, footprint: false,
      style: { pattern: 'stoneWindows', spd: '#ecebe7', tint: '#34414b', floorH: 3.6, colW: 3.4, spandrel: 0.45, mullW: 1.1, lit: 0.7 } },
    { name: 'cap', shape: 'rect', size: [54, 27], at: RZ, rot: 61.1, base: 88, top: 100, footprint: false, roof: { mech: false },
      style: { pattern: 'curtain', tint: '#15191d', spd: '#15191d', floorH: 6, colW: 3, spandrel: 0.6, mullW: 0.3, lit: 0.1 } },
  ],
  signs: [{ text: 'THE RITZ-CARLTON', part: 'cap', face: ['SW', 'NE'], y: 94, h: 3, color: '#ffffff', glow: '#ffffff' }],
  supersede: { names: ['西安丽思卡尔顿酒店'] },
  meta: {
    category: 'hotel',
    dossier: 'landmarks2.json#西安丽思卡尔顿酒店',
    sources: ['research/refs/landmarks2026/towers.json#西安丽思卡尔顿酒店（100 m）', 'Overture building w929222953（西安丽思卡尔顿酒店）'],
    photos: ['https://hotels.ctrip.com/（西安丽思卡尔顿酒店）', 'https://www.sohu.com/（凯悦集团…西安W、丽思卡尔顿、君悦）', 'https://you.ctrip.com/（独家探秘西安丽思卡尔顿酒店的10处惊艳打卡点）'],
    confidence: 'medium（形体、招牌）；low（塔楼在轮廓内的准确落位：卫星屋面受倾斜影响）',
    notes: '塔楼 50×24 m 按照片比例（正立面约 13 开间）；白色方格窗面 38 m 宽（两侧各 6 m 深色玻璃框），88–100 m 为出挑深色顶盒（照片）。原 landmarks2026 通用塔（占满整片轮廓）被替代。',
  },
};

// ═════════════════════════ 14. 西安香格里拉大酒店（高新科技路） ═════════════════════════
// 照片（携程 / 香格里拉官方，见 meta.photos）：约 17 层板楼，蓝色玻璃带窗 + 两端白色石材山墙（山墙竖排金字“香格里拉大酒店”），
// 塔前为唐风低层裙楼（朱柱、深灰瓦歇山顶），夜间顶部金色泛光。轮廓：OSM w28594595（塔楼 + 裙楼 124×113 m）。
// 板楼沿轮廓东北边（地图角 −28.7°，与 OSM 东北边一致）布置，进深 21 m（卫星量取，屋面受倾斜影响 ±4 m）。高度 75 m（landmarks2026 调研）。
const SL = [-4545.0, 2890.4];
const shangri = {
  id: 'lm2-shangrila-gaoxin',
  name: '西安香格里拉大酒店',
  center: SL,
  parts: [
    { name: 'podium', kind: 'podium', fp: 'e4efbe4b-7fbf-4883-a0cc-d395cde8e347', base: 0, top: 9,
      style: { pattern: 'stoneWindows', spd: '#8e2f24', tint: '#3a2a22', floorH: 4.5, colW: 3.6, spandrel: 0.3, mullW: 0.9, lit: 0.8 }, roofMat: ROOF_TILE,
      crown: [{ type: 'eave', ov: 1.8, depth: 3, h: 1.6, mat: ROOF_TILE }] },
    { name: 'slab', shape: 'rect', size: [100, 21], at: SL, rot: -28.7, base: 0, top: 75, roof: { mech: true },
      style: { pattern: 'horizontalBands', tint: '#2d5a86', spd: '#d9d7d0', floorH: 4.2, colW: 2.6, spandrel: 0.3, mullW: 0.1, lit: 0.55 } },
    ...[-1, 1].map((s, i) => ({ name: 'end' + i, kind: 'solid', shape: 'rect', size: [4, 23], at: along(SL, -28.7, s * 50, 0), rot: -28.7, base: 0, top: 77, mat: '#e7e3da', footprint: false })),
  ],
  signs: [ // 两端白色山墙上的竖排金字（照片 03）：山墙外法线沿板楼长轴（西北西 / 东南东）
    { text: '香格里拉大酒店', part: 'end0', face: 'WNW', vertical: true, y: 50, h: 22, minEdge: 10, color: '#d9b35a' },
    { text: '香格里拉大酒店', part: 'end1', face: 'ESE', vertical: true, y: 50, h: 22, minEdge: 10, color: '#d9b35a' },
  ],
  night: { floodlight: [{ part: 'slab', color: '#ffd27a', strength: 0.35, from: 60, to: 76 }] },
  supersede: { names: ['西安香格里拉大酒店（高新）', '西安香格里拉大酒店'] },
  meta: {
    category: 'hotel',
    dossier: 'landmarks2.json#西安香格里拉大酒店',
    sources: ['research/refs/landmarks2026/towers.json#西安香格里拉大酒店（高新）（75 m）', 'Overture building w28594595（西安香格里拉大酒店）', 'Esri z19 卫星'],
    photos: ['https://www.shangri-la.com/（西安香格里拉大酒店）', 'https://www.sohu.com/（国庆假期高新区楼体灯光秀闪亮中国红）', 'https://hotels.ctrip.com/（西安香格里拉大酒店）'],
    confidence: 'medium',
    notes: '原 landmarks2026 把整片 124×113 m 轮廓挤成 75 m 方盒，现改为沿东北边的板楼 + 唐风裙楼。',
  },
};

// ═════════════════════════ 15. 西安高新希尔顿酒店（高新锦业路 / 丈八一路） ═════════════════════════
// 照片（携程 / 搜狐，见 meta.photos）：约 26 层，米褐色石材 + 竖向蓝色玻璃带，塔顶外框发光；底层石材拱窗、黑色雨棚。
// 轮廓：OSM w1417902909（76×29 m 东西向板楼 + 东北角入口）。高度 90 m（landmarks2026 调研）。
const hilton = {
  id: 'lm2-hilton-gaoxin',
  name: '西安高新希尔顿酒店',
  fp: '72eea9e9-006e-43be-8dc3-ba5695a8c89d',
  parts: [
    { name: 'body', fp: '72eea9e9-006e-43be-8dc3-ba5695a8c89d', base: 0, top: 90, setbacks: [{ at: 84, inset: 1.2 }],
      style: { pattern: 'stoneWindows', spd: '#b39a82', tint: '#2f5578', floorH: 3.4, colW: 2.4, spandrel: 0.35, mullW: 0.9, lit: 0.6 },
      crown: [{ type: 'frame', h: 5, inset: 0.6, step: 5, glow: '#ffffff', color: '#9a8a78' }] },
  ],
  signs: [{ text: 'Hilton', part: 'body', face: ['S', 'N'], y: 86, h: 3, color: '#ffffff', glow: '#ffffff' }],
  supersede: { names: ['西安高新希尔顿酒店'] },
  meta: {
    category: 'hotel',
    dossier: 'landmarks2.json#西安高新希尔顿酒店',
    sources: ['research/refs/landmarks2026/towers.json#西安高新希尔顿酒店（90 m）', 'Overture building w1417902909（西安高新希尔顿酒店）'],
    photos: ['https://www.sohu.com/（揭秘高新首家希尔顿）', 'https://hotels.ctrip.com/（西安高新希尔顿酒店）'],
    confidence: 'medium',
    notes: '按 OSM 轮廓整体拉伸到 90 m，84 m 以上略收进 + 发光屋顶构架（夜景照片塔顶外框灯）。',
  },
};

// ═════════════════════════ 16. 曲江海洋极地公园（4A，雁南二路） ═════════════════════════
// 照片（携程 / 大众点评 / 景区官方，见 meta.photos）：海洋馆为蓝色外墙（海洋主题彩绘）+ 白色圆形主楼，屋面多座白色锥形张拉膜帐篷与白色网壳球顶；
// 极地馆为蓝色大体量 + 弧形钢结构屋面与大型白色膜结构入口。轮廓：OSM w1370069936（海洋馆）、w1370069957（极地馆）。
// 圆楼、膜帐篷、球顶位置按 Esri z19 卫星量取（±2 m）；高度无公开数据，按照片比例：外墙约 13–17 m、圆楼约 22 m、膜顶再高 8–14 m。
const HY_BLUE = { pattern: 'stoneWindows', spd: '#2f63a8', tint: '#1b2a3a', floorH: 4.5, colW: 4, spandrel: 0.62, mullW: 1.6, lit: 0.55 };
const MEMBRANE = { color: '#f4f4f2', roughness: 0.5 };
const tent = (name, at, w, base, h) => ({ name, kind: 'solid', shape: 'rect', size: [w, w], at, rot: 34.7, topScale: 0.06, base, top: base + h, mat: MEMBRANE, footprint: false });
const haiyang = {
  id: 'lm2-haiyang',
  name: '曲江海洋极地公园',
  center: [3105, 4920],
  parts: [
    { name: 'ocean', kind: 'podium', fp: '528e9787-028a-406d-9ff7-f803618bf307', base: 0, top: 13, style: HY_BLUE, roofMat: { color: '#b9b4a8', roughness: 0.9 } },
    { name: 'drum', shape: 'circle', size: [44, 44], at: [3095.2, 4873.1], base: 0, top: 22, roof: { mech: false, parapet: 0.8 },
      style: { pattern: 'stoneWindows', spd: '#e8edf1', tint: '#2a4a74', floorH: 4.4, colW: 3.2, spandrel: 0.5, mullW: 1.2, lit: 0.6 } },
    tent('tentA', [3064.3, 4866], 14, 13, 9), tent('tentB', [3060, 4881], 14, 13, 9), tent('tentC', [3065.5, 4912.6], 19, 13, 11),
    { name: 'domeE', kind: 'solid', shape: 'circle', size: [18, 18], at: [3133.4, 4899], base: 0, top: 3, mat: '#dfe3e6',
      crown: [{ type: 'dome', r: 8.6, h: 8, mat: { color: '#eef1f3', roughness: 0.4, metalness: 0.2 }, ring: false }] },
    { name: 'domeW', kind: 'solid', shape: 'circle', size: [18, 18], at: [3033.4, 4880.5], base: 0, top: 3, mat: '#dfe3e6',
      crown: [{ type: 'dome', r: 9, h: 8, mat: { color: '#3a78c8', roughness: 0.35, metalness: 0.2 }, ring: false }] },
    { name: 'polar', kind: 'podium', fp: '3cfcdec7-f5cb-45e4-900a-4cfa821627a0', base: 0, top: 17, style: HY_BLUE, roofMat: { color: '#c9ccce', roughness: 0.7 },
      crown: [{ type: 'arch', size: [110, 60], at: [3140, 4955], rot: 94.5, h: 8, mat: { color: '#c9cdd0', roughness: 0.45, metalness: 0.4 } }] },
    tent('tentP', [3098.9, 4958.3], 30, 17, 14),
  ],
  signs: [{ text: '曲江海洋极地公园', part: 'ocean', face: 'W', y: 10, h: 2.2, color: '#ffffff', bg: '#1f5fae' }],
  night: { floodlight: [{ part: 'drum', color: '#7fc8ff', strength: 0.45 }, { part: 'polar', color: '#6fb6ff', strength: 0.3 }] },
  supersede: { names: ['曲江海洋极地公园', '曲江海洋极地公园海洋馆', '曲江海洋极地公园极地馆'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#曲江海洋极地公园',
    sources: ['http://xa.bendibao.com/tour/2020810/ly77108.shtm（4A 名单）', 'Overture building w1370069936 / w1370069957', 'Esri z19 卫星（圆楼、膜帐篷、球顶落位）'],
    photos: ['https://you.ctrip.com/（西安曲江海洋极地公园）', 'http://www.dianping.com/（曲江海洋极地公园）', 'https://www.sohu.com/（2023曲江海洋极地公园游玩攻略）'],
    confidence: 'medium（落位、构成、配色）；low（高度）',
    notes: '原先只有通用楼块；现按轮廓建蓝色馆体 + 白色圆楼 + 锥形膜帐篷（四棱锥近似）+ 球顶。',
  },
};

// ═════════════════════════ 17. 天坛遗址公园·隋唐圜丘（雁塔区，明德门遗址以东） ═════════════════════════
// 隋开皇十年（590）始建、唐代沿用近 300 年的祭天圜丘：黄土夯筑的四重同心圆台，自下而上直径 52.45–53.15 / 40.04–40.89 / 28.35–28.48 /
// 19.74–20.59 m，最高 8.12 m；每层以 30° 间隔均设 12 陛（四层共 48 陛，象征十二时辰）（维基百科“圜丘遗址”、丝绸之路遗产数据库、腾讯新闻）。
// 轮廓：OSM w941637853“圜丘遗址”（圆，中心 (276.4, 6491.6)）。卫星 z19：12 条陛道放射状，正南（午陛）最宽。
// 原 heritage26 用 52.5 m 见方的方形台基表示，形制不符，现按四重圆台 + 48 陛重建。
const TT = [276.4, 6491.6];
const TT_R = [26.4, 20.23, 14.2, 10.08]; // 各层半径（取两端平均）
const TT_EARTH = { color: '#b09a78', roughness: 0.95 };
const TT_STEP = { color: '#c8b797', roughness: 0.9 };
const ttStairs = [];
for (let k = 0; k < 4; k++) {
  const r0 = TT_R[k], y0 = k * 2.03, y1 = (k + 1) * 2.03, d = 2.4;
  for (let i = 0; i < 12; i++) {
    const a = (i * 30 - 90) * D2R; // i=0 正南（午陛）
    const w = i === 0 ? 3.2 : 1.8, ux = Math.cos(a), uz = -Math.sin(a), px = -uz, pz = ux;
    const P = (r, s) => [TT[0] + ux * r + px * s * w / 2, TT[1] + uz * r + pz * s * w / 2];
    // 陛道楔体：底面 = 台外 d 米长的矩形，顶面收成台沿一条窄边（与底面同绕向，保证放样一一对应）
    const inA = P(r0 - 0.4, -1), inB = P(r0 - 0.4, 1), outA = P(r0 + d, -1), outB = P(r0 + d, 1), midA = P(r0 - 0.2, -1), midB = P(r0 - 0.2, 1);
    ttStairs.push({ name: `bi${k}_${i}`, kind: 'solid', pts: [...inA, ...outA, ...outB, ...inB], topPts: [...inA, ...midA, ...midB, ...inB],
      base: y0, top: y1, mat: TT_STEP, footprint: false });
  }
}
const tiantan = {
  id: 'lm2-tiantan',
  name: '隋唐圜丘（天坛遗址）',
  center: TT,
  parts: [
    ...TT_R.map((r, k) => ({ name: 'tier' + k, kind: 'solid', shape: 'circle', size: [r * 2, r * 2], shapeOpt: { seg: 72 }, at: TT, base: k === 0 ? 0 : k * 2.03 - 0.3, top: (k + 1) * 2.03,
      mat: TT_EARTH, footprint: k === 0 })),
    ...ttStairs,
  ],
  label: { text: '天坛遗址（隋唐圜丘）' },
  supersede: { names: ['天坛遗址公园（唐圜丘）', '圜丘遗址'] },
  meta: {
    category: 'heritage',
    dossier: 'landmarks2.json#天坛遗址公园（隋唐圜丘）',
    sources: ['https://zh.wikipedia.org/zh-hans/圜丘遗址', 'http://www.silkroads.org.cn/portal.php?mod=view&aid=26252', 'https://news.qq.com/rain/a/20211109A016HH00',
      'Overture building w941637853（圜丘遗址）', 'Esri z19 卫星（陛道方向）'],
    photos: ['https://www.whb.cn/zhuzhan/jjl/20180227/190445.html', 'http://www.silkroads.org.cn/portal.php?mod=view&aid=11888'],
    confidence: 'high（形制与尺寸有考古数据）',
    notes: '四层等高 2.03 m（总高 8.12 m）；陛道按每层外侧 2.4 m 长的斜坡楔体近似，午陛宽 3.2 m、其余 1.8 m（宽度按卫星估计）。',
  },
};

// ═════════════════════════ 18. 大明宫麟德殿遗址 ═════════════════════════
// 唐大明宫最大的宴会殿，前中后三殿相连，建于两层台基之上（复原模型：大明宫遗址博物馆）。现状为遗址保护展示：外圈灰色石铺下层台、
// 内部略高的草坪上层台（草坪上以柱础标示柱网），东西两侧有灰墙白顶的保护棚 / 台阶口（照片 03 航拍、卫星 z19）。
// 轮廓：OSM w899099874“麟德殿”（146×126 m）；上层台（64×101 m）、东西保护棚与台上夯土墙基条带按卫星 z19 量取（±1 m）。
// 高度无公开数据：下层台约 1.4 m、上层台约 3.1 m（照片比例）。heritage.js 注明麟德殿此前未建。
const LD = [1019.8, -3988.9];
const LD_STONE = { color: '#a8a69e', roughness: 0.95 };
const LD_EARTH = { color: '#8b6f4e', roughness: 0.95 };
const linde = {
  id: 'lm2-linde',
  name: '麟德殿遗址',
  fp: '98f66fe0-03c6-4686-8453-7afcbbe1af4a',
  parts: [
    { name: 'lower', kind: 'solid', fp: '98f66fe0-03c6-4686-8453-7afcbbe1af4a', base: 0, top: 1.4, mat: LD_STONE },
    { name: 'upper', kind: 'solid', shape: 'rect', size: [64, 101], at: LD, base: 1.4, top: 3.0, mat: LD_STONE, footprint: false },
    { name: 'lawn', kind: 'solid', shape: 'rect', size: [62.6, 99.6], at: LD, base: 3.0, top: 3.1, mat: 'grass', footprint: false },
    // 台上夯土墙基条带（三殿两侧廊墙、中殿围合）
    ...[[993, -3990, 5.6, 39.4], [1046.2, -3990, 6, 39.4], [993, -3954, 5, 18], [1046.2, -3954, 5, 18], [1027, -3997, 34, 3.5], [1027, -3975, 34, 3.5]].map(([x, z, w, d], i) => ({
      name: 'wall' + i, kind: 'solid', shape: 'rect', size: [w, d], at: [x, z], base: 3.0, top: 3.7, mat: LD_EARTH, footprint: false })),
    // 东西两侧保护棚（灰墙、白色平顶）
    { name: 'shedE', kind: 'solid', pts: [1054, -4013.5, 1082.6, -4013.5, 1082.6, -3978, 1076, -3978, 1076, -4004, 1054, -4004], base: 0, top: 4.2, mat: '#7f8285',
      crown: [{ type: 'slab', ov: 0.3, h: 0.35, mat: '#e9e9e6' }] },
    { name: 'shedW', kind: 'solid', pts: [957, -4031, 964, -4031, 964, -4006, 984, -4006, 984, -3996, 957, -3996], base: 0, top: 4.2, mat: '#7f8285',
      crown: [{ type: 'slab', ov: 0.3, h: 0.35, mat: '#e9e9e6' }] },
  ],
  supersede: { names: ['麟德殿'] },
  meta: {
    category: 'heritage',
    dossier: 'landmarks2.json#大明宫麟德殿遗址',
    sources: ['Overture building w899099874（麟德殿）', 'Esri z19 卫星', 'src/modules/heritage.js 注释（麟德殿、太液池、遗址博物馆未建）'],
    photos: ['https://gs.ctrip.com/html5/you/sight/xian7/1478176.html', 'http://baijiahao.baidu.com/s?id=1685677502942844440'],
    confidence: 'medium（平面按卫星与 OSM）；low（台高按照片）',
    notes: '只表现现状遗址展示（两层台基、草坪柱网区、墙基条带、保护棚），不做复原殿宇。',
  },
};

// ═════════════════════════ 19. 丝绸之路群雕（大庆路西端，唐长安开远门遗址） ═════════════════════════
// 马改户设计，1987 年落成：花岗岩（浅褐色）群雕长 55.9 m、宽 3 m，一队中外混合的驼队商旅——3 个唐人、3 个波斯人、14 匹骆驼、3 条狗、2 匹马，
// 位于大庆路与枣园东路三岔口的绿化带中央，驼队西行（百度百科 / 新浪旅游 / 西安网“丝路群雕：陕西人设计 陕西石头雕琢”）。
// 位置：POI 丝路群雕 (−6007, −1100)；Esri z19 卫星上群雕为东西向长条，x −6034 ~ −5981，z ≈ −1096。
// 高度无公开数据：按照片比例，基座约 0.9 m、驼峰约 5 m、骑者头顶约 6.8 m。雕像按“驼身 + 驼峰 + 颈首 + 骑者”的体块近似（远看成轮廓）。
const QX_GRANITE = { color: '#b8917b', roughness: 0.9 };
const QX_Z = -1096.4;
const qxParts = [{ name: 'plinth', kind: 'solid', shape: 'rect', size: [56, 4], at: [-6007.1, QX_Z], base: 0, top: 0.9, mat: QX_GRANITE }];
for (let i = 0; i < 14; i++) {
  const x = -6031 + i * 3.7 + (i % 2) * 0.4, z = QX_Z + (i % 3 - 1) * 0.5; // 驼队西行（头朝西）
  qxParts.push(
    { name: 'camel' + i, kind: 'solid', shape: 'rect', size: [3.3, 2.1], at: [x, z], base: 0.9, top: 3.6, taper: 0.85, mat: QX_GRANITE, footprint: false },
    { name: 'hump' + i, kind: 'solid', shape: 'rect', size: [1.8, 1.7], at: [x + 0.3, z], base: 3.6, top: 4.9, topScale: 0.45, mat: QX_GRANITE, footprint: false },
    { name: 'head' + i, kind: 'solid', shape: 'rect', size: [0.9, 0.9], at: [x - 2.0, z], base: 2.6, top: 5.1, topShift: [-0.6, 0], mat: QX_GRANITE, footprint: false },
  );
  if (i % 3 === 0) qxParts.push({ name: 'rider' + i, kind: 'solid', shape: 'rect', size: [0.9, 0.8], at: [x + 0.4, z], base: 4.6, top: 6.8, taper: 0.7, mat: QX_GRANITE, footprint: false });
}
for (let k = 0; k < 3; k++) qxParts.push({ name: 'walker' + k, kind: 'solid', shape: 'rect', size: [0.8, 0.8], at: [-6033.2 + k * 1.2, QX_Z + (k - 1) * 1.1], base: 0.9, top: 3.0, taper: 0.8, mat: QX_GRANITE, footprint: false });
const silkroadSculpture = {
  id: 'lm2-silkroad-sculpture',
  name: '丝绸之路群雕',
  center: [-6007.1, QX_Z],
  parts: qxParts,
  night: { floodlight: [{ part: 'plinth', color: '#ffd9a8', strength: 0.5, from: 0, to: 7 }] },
  supersede: { names: ['丝路群雕', '丝绸之路群雕'] },
  meta: {
    category: 'monument',
    dossier: 'landmarks2.json#丝绸之路群雕',
    sources: ['https://baike.baidu.com/item/丝绸之路群雕/10686112', 'https://lianhu.xiancity.cn/system/2023/08/10/031085227.shtml', 'http://travel.sina.com.cn/china/2014-10-31/1619283123_6.shtml',
      'public/data/pois.json 丝路群雕', 'Esri z19 卫星'],
    photos: ['http://www.dianping.com/review/619071010', 'http://www.dianping.com/review/913698260', 'https://news.hsw.cn/system/2024/0815/1774872.shtml'],
    confidence: 'high（位置、长宽）；low（高度与雕像细部，体块近似）',
    notes: '14 匹骆驼按等距排布、头朝西；每三匹一名骑者，西端 3 名步行者。狗、马未单独表现。',
  },
};

// ═════════════════════════ 20. 西安国际港站（铁路集装箱中心站）轨道式龙门吊群 ═════════════════════════
// 西北最大的国际物流枢纽站（中欧班列“长安号”始发）；标志性景观是横跨装卸线的红色轨道式集装箱龙门吊（照片：中国新闻网 / 国际在线“西安国际港站正式揭牌启用”）。
// 原 landmarks2026 把“西安国际港站”合成为 275×40 m、30 m 高的通用方盒，落在到发线轨道上（Esri 影像该处为股道与集装箱），现替代为龙门吊群。
// 龙门吊位置：Esri z17 卫星逐台判读（红色门架与阴影，±5 m），共 11 台；门架跨装卸线（长轴地图角约 79°，与股道 −11° 垂直），
// 跨度约 50 m、宽约 14 m；高度按照片比例约 22 m（主梁顶）。营业大厅楼（6 层）位置未能确认，不建。
const GZ_CRANES = [[10539, -16861], [10776, -16802], [10535, -16733], [10658, -16619], [10850, -16634], [10860, -16560], [11067, -16579], [11146, -16703],
  [11151, -16476], [11403, -16629], [11373, -16491]];
const GZ_RED = { color: '#c9332a', roughness: 0.55, metalness: 0.35 };
const GZ_ROT = 79;
const gantryParts = GZ_CRANES.flatMap((c, i) => {
  const legs = [[-24, -6], [-24, 6], [24, -6], [24, 6]].map(([u, v], k) => ({ name: `g${i}leg${k}`, kind: 'solid', shape: 'rect', size: [1.4, 1.6], at: along(c, GZ_ROT, u, v), rot: GZ_ROT,
    base: 0, top: 19.5, mat: GZ_RED, footprint: false }));
  const girders = [-6, 6].map((v, k) => ({ name: `g${i}girder${k}`, kind: 'solid', pts: strip(along(c, GZ_ROT, -30, v), along(c, GZ_ROT, 30, v), 1.8), base: 19.5, top: 22.5, mat: GZ_RED, footprint: false }));
  const sills = [-24, 24].map((u, k) => ({ name: `g${i}sill${k}`, kind: 'solid', pts: strip(along(c, GZ_ROT, u, -7), along(c, GZ_ROT, u, 7), 1.4), base: 0, top: 1.2, mat: GZ_RED, footprint: false }));
  const ties = [-24, 24].map((u, k) => ({ name: `g${i}tie${k}`, kind: 'solid', pts: strip(along(c, GZ_ROT, u, -7), along(c, GZ_ROT, u, 7), 1.2), base: 17.5, top: 19.5, mat: GZ_RED, footprint: false }));
  const trolley = { name: `g${i}trolley`, kind: 'solid', shape: 'rect', size: [7, 14.5], at: along(c, GZ_ROT, (i % 3 - 1) * 12, 0), rot: GZ_ROT, base: 20.5, top: 25, mat: '#e7e4dc', footprint: false };
  return [...legs, ...girders, ...sills, ...ties, trolley];
});
const gangzhan = {
  id: 'lm2-gangzhan-cranes',
  name: '西安国际港站',
  center: [10960, -16660],
  parts: gantryParts,
  label: { text: '西安国际港站', y: 32 },
  night: { floodlight: [{ part: 'g1girder0', color: '#ffffff', strength: 0.3, from: 0, to: 25 }] },
  supersede: { names: ['西安国际港站'] },
  meta: {
    category: 'station',
    dossier: 'landmarks2.json#西安国际港站',
    sources: ['https://www.chinanews.com.cn/（西安国际港站正式揭牌启用）', 'research/refs/landmarks2026/venues.json#西安国际港站', 'Esri World Imagery z17（龙门吊逐台判读）'],
    photos: ['https://www.chinanews.com.cn/（西安国际港站揭牌启用 西安港深度融入亚欧陆海贸易大通道）', 'https://news.cri.cn/（西安国际港站已成为西北地区最大国际物流枢纽中心站）'],
    confidence: 'medium（龙门吊位置与数量按卫星）；low（尺寸按照片比例）',
    notes: '只建龙门吊（红色门架 + 双主梁 + 小车）；股道与集装箱由影像与铁路模块表现。营业大厅楼位置未能确认，不建。',
  },
};

// ═════════════════════════ 21. 地铁 3 号线国际港务区站（高架站） ═════════════════════════
// landmarks2026 把“西安国际港务区管委会大楼（50 m）”落在了这里——实为地铁 3 号线高架车站（OSM w982182689“国际港务区”，122×27 m，
// 卫星：白色胶囊形拱顶 + 中部天窗，跨港务大道中央；西侧有人行天桥）。港务区管委会大楼实际位置未能确认，此处按实物重建高架站，旧方盒被替代。
// 西安地铁 3 号线高架站照片：钢拱肋 + 玻璃的拱形站棚（搜狐“西安地铁三号线是怎样炼成的”）。高度按照片比例：站厅层 6–11 m，拱顶约 19 m。
const GW = [8463.0, -11290.5];
const gwStation = {
  id: 'lm2-gwq-station',
  name: '国际港务区站',
  center: GW,
  parts: [
    ...[-48, -24, 0, 24, 48].flatMap((u, i) => [-7, 7].map((v, k) => ({ name: `pier${i}${k}`, kind: 'solid', shape: 'rect', size: [2.2, 2.2], at: along(GW, 82.8, u, v), rot: 82.8,
      base: 0, top: 6, mat: '#cfcfcb', footprint: false }))),
    { name: 'hall', shape: 'rect', size: [118, 24], at: GW, rot: 82.8, base: 6, top: 12, footprint: false, roof: { mech: false, parapet: 0.3 },
      style: { pattern: 'curtain', tint: '#3d5563', spd: '#dcdcd8', floorH: 6, colW: 2.4, spandrel: 0.35, mullW: 0.2, lit: 0.8 },
      crown: [{ type: 'arch', along: 'short', size: [118, 26], at: GW, rot: 82.8, h: 7, mat: { color: '#ebe8df', roughness: 0.5, metalness: 0.2 } },
        { type: 'arch', size: [104, 4], at: GW, rot: 82.8, h: 1.2, y: 18.6, mat: 'glassRoof' }] },
  ],
  label: false,
  site: ['215d63b0-f996-4d64-9771-d1df829adb1f'], // 站房 OSM 轮廓：让位通用建筑（buildings.bin 里该轮廓的通用楼块）
  supersede: { names: ['西安国际港务区管委会大楼', '国际港务区'] },
  meta: {
    category: 'station',
    dossier: 'landmarks2.json#地铁3号线国际港务区站',
    sources: ['Overture building w982182689（国际港务区）', 'public/data/metro.json 国际港务区站（3 号线，d=0 地面/高架）', 'Esri z18 卫星'],
    photos: ['http://www.sohu.com/a/101922694_401087（西安地铁三号线高架站拱形站棚）'],
    confidence: 'medium（位置、平面）；low（高度）',
    notes: '拱顶 arch 沿长边（along 默认长边，size 显式给出），中部玻璃天窗条；桥墩 5 对。',
  },
};

// ═════════════════════════ 22. 陕西奥体中心体育馆（高新唐延路南段，十四运场馆） ═════════════════════════
// 2018-06 开工、历时两年建成：建筑面积 72450 m²，地下 1 层、地上 3 层，观众席 7048 座；比赛馆 + 训练馆两部分，
// “银色屋面融合曲线平台”，钢结构双层 / 单层网壳；外形取意“丝绸之路起点上徐徐展开的丝带”；干挂石材（黄土高原气息）+ 玻璃幕墙（凤凰网陕西）。
// 轮廓：OSM r19396757“陕西奥体中心体育馆”（250×129 m，两个椭圆瓣：东为比赛馆、西为训练馆，中间连接处有椭圆开洞）。
// 高度无公开数据：按照片比例，石材基座约 10 m，比赛馆壳顶约 36 m、训练馆约 28 m。原 landmarks2026 为 32 m 通用方盒。
const STG_SILVER = { color: '#d9dcdf', roughness: 0.32, metalness: 0.6 };
const shengtiguan = {
  id: 'lm2-shaanxi-oly-gym',
  name: '陕西奥体中心体育馆',
  fp: 'b24cc210-cee2-46eb-9246-5e4527b5e6ad',
  parts: [
    { name: 'plinth', fp: 'b24cc210-cee2-46eb-9246-5e4527b5e6ad', base: 0, top: 10, roof: { mech: false, parapet: 0.1 },
      style: { pattern: 'stoneWindows', spd: '#cdb89a', tint: '#3a5566', floorH: 5, colW: 3.4, spandrel: 0.4, mullW: 0.8, lit: 0.7 },
      crown: [
        { type: 'dome', at: [-5470, 6236], r: [44, 38], h: 12, mat: STG_SILVER, ring: false },
        { type: 'dome', at: [-5483, 6232], r: [15, 25], h: 12.4, mat: { color: '#28323a', roughness: 0.2, metalness: 0.5 }, ring: false }, // 中部椭圆开洞（深色）
        { type: 'dome', at: [-5398, 6253], r: [52, 64], h: 26, mat: STG_SILVER, ring: false },
        { type: 'dome', at: [-5545, 6246], r: [52, 43], h: 18, mat: STG_SILVER, ring: false },
      ] },
  ],
  bands: [{ part: 'plinth', levels: [9.4], h: 0.6, depth: 0.8, color: '#e6e8ea', glow: '#bfe0ff', strength: 1.2 }],
  signs: [{ text: '陕西奥体中心体育馆', part: 'plinth', face: 'E', y: 7, h: 1.8, color: '#6e5a3e' }],
  night: { floodlight: [{ part: 'plinth', color: '#d8ecff', strength: 0.35 }] },
  supersede: { names: ['陕西奥体中心体育馆（陕西省体育馆·唐延路）', '陕西奥体中心体育馆'] },
  meta: {
    category: 'sports',
    dossier: 'landmarks2.json#陕西奥体中心体育馆',
    sources: ['https://sn.ifeng.com/a/20200701/14378330_0.shtml', 'https://archina.com/index.php?a=show&g=works&id=10286&m=index', 'Overture building r19396757（陕西奥体中心体育馆）'],
    photos: ['http://www.bilibili.com/video/av243736147', 'https://xian.qinfeng.gov.cn/info/1250/22930.htm', 'https://news.sina.com.cn/o/2020-08-29/doc-iivhvpwy3804790.shtml'],
    confidence: 'high（轮廓、形体、材质）；low（高度）',
    notes: '两瓣银色网壳用椭圆穹顶近似（比赛馆 104×128 m、矢高 26 m；训练馆 104×86 m、矢高 18 m），中间连接壳与椭圆开洞按卫星位置。',
  },
};

// ═════════════════════════ 23. 大明宫遗址博物馆（含元殿东北，覆土建筑） ═════════════════════════
// 唐大明宫国家遗址公园博物馆区（张锦秋团队设计）：为保护遗址景观，主体埋入地下、屋面覆土植草，地面只露出下沉入口坡道院、采光天窗与南侧入口廊。
// Esri z19 卫星：下沉坡道院 (1608–1634, −3327~−3296)、玻璃天窗 (1608–1625, −3276~−3264)、南侧入口廊（浅灰平屋面，1602–1671 × −3238~−3226）。
// 原 heritage26 在这里放了一座 80×120 m 的仿古殿（与实物不符，现场为草坡）。高度：入口廊约 4 m（照片比例），天窗高出草坡约 0.6 m。
const dmgMuseum = {
  id: 'lm2-dmg-museum',
  name: '大明宫遗址博物馆',
  center: [1630, -3280],
  parts: [
    { name: 'court', kind: 'solid', pts: [1608, -3327, 1634, -3327, 1634, -3296, 1608, -3296], base: 0, top: 0.15, mat: '#c9c6bf' },
    ...[[1607.5, -3327, 1608.3, -3296], [1633.7, -3327, 1634.5, -3296], [1607.5, -3296.8, 1634.5, -3296]].map(([x0, z0, x1, z1], i) => ({
      name: 'wall' + i, kind: 'solid', pts: [x0, z0, x1, z0, x1, z1, x0, z1], base: 0, top: 1.1, mat: '#b9b6ae', footprint: false })),
    { name: 'sky', kind: 'solid', pts: [1608, -3276, 1625, -3276, 1625, -3264, 1608, -3264], base: 0, top: 0.6, mat: 'glassRoof' },
    { name: 'entry', pts: [1601.6, -3238, 1670.7, -3238, 1670.7, -3226, 1601.6, -3226], base: 0, top: 4.2, roof: { mech: false, parapet: 0.3 },
      style: { pattern: 'curtain', tint: '#3b4b55', spd: '#bdbab2', floorH: 4.2, colW: 3, spandrel: 0.2, mullW: 0.4, lit: 0.7 } },
  ],
  signs: [{ text: '大明宫遗址博物馆', part: 'entry', face: 'S', y: 3.3, h: 0.9, color: '#5a4a36' }],
  supersede: { names: ['大明宫遗址博物馆', '大明宫遗址博物馆展览厅'] },
  meta: {
    category: 'culture',
    dossier: 'landmarks2.json#大明宫遗址博物馆',
    sources: ['http://m.sohu.com/a/165627789_737902（唐大明宫国家遗址公园博物馆区设计）', 'public/data/pois.json 大明宫遗址博物馆展览厅 (1600, −3269)', 'Esri z19 卫星'],
    photos: ['http://m.sohu.com/a/165627789_737902', 'http://m.sohu.com/a/159968333_796676'],
    confidence: 'medium（地面露出部分的位置）；low（高度）',
    notes: '覆土建筑只建地面可见部分；下沉院无法挖地形，用浅灰地坪 + 1.1 m 挡墙表示。',
  },
};

// ═════════════════════════ 24. 西安西站（原阿房宫站，西成客专） ═════════════════════════
// 2023-03 由“阿房宫站”更名为“西安西站”（华商网 / 陕西网）。航拍照片（陕西网“西安三座火车站正式更名”）：对称的站房——
// 两侧 2 层米黄石材柱廊裙房，中部高起的候车大厅，浅蓝灰色平顶四坡（盝顶式）金属屋面，屋面正中站名；站房面向东南站前广场，背后为站台雨棚与股道。
// Esri z19 卫星：大厅屋面 90×44 m（长边地图角 52°，与股道平行），中心 (−17544, −1144)；东北、西南两端各一低层附楼（约 32×28 m）。
// 高度无公开数据：按照片比例，裙房 10 m、大厅檐口 17 m、屋面矢高 4.5 m。原 landmarks2026 为 30 m 通用方盒。
const XZ_C = [-17544, -1144];
const XZ_STONE = { pattern: 'stoneWindows', spd: '#dccdb2', tint: '#35495a', floorH: 5, colW: 4.2, spandrel: 0.3, mullW: 1.2, lit: 0.7 };
const xizhan = {
  id: 'lm2-xian-west-station',
  name: '西安西站',
  center: XZ_C,
  parts: [
    { name: 'hall', shape: 'rect', size: [90, 44], at: XZ_C, rot: 52, base: 0, top: 17, roof: { mech: false },
      style: { ...XZ_STONE, floorH: 8.5, colW: 3.6, spandrel: 0.18 },
      crown: [{ type: 'pubHip', top: [64, 22], h: 4.5, eave: 2.4, mat: { color: '#a9b8c0', roughness: 0.45, metalness: 0.4 }, eaveMat: '#e7e3da' }] },
    { name: 'wingNE', shape: 'rect', size: [32, 28], at: along(XZ_C, 52, 60, 4), rot: 52, base: 0, top: 10, style: XZ_STONE, roof: { mech: true } },
    { name: 'wingSW', shape: 'rect', size: [30, 28], at: along(XZ_C, 52, -52, 5), rot: 52, base: 0, top: 10, style: XZ_STONE, roof: { mech: true } },
  ],
  columns: [{ part: 'hall', out: 3.2, step: 7.5, r: 0.55, from: 0, to: 12, mat: '#e4dccb' }],
  signs: [{ text: '西安西站', part: 'hall', face: 'SE', y: 15, h: 2.6, color: '#c8102e' }],
  night: { floodlight: [{ part: 'hall', color: '#ffe6c0', strength: 0.35 }] },
  supersede: { names: ['西安西站（原阿房宫站）', '西安西站'] },
  meta: {
    category: 'station',
    dossier: 'landmarks2.json#西安西站',
    sources: ['https://www.ishaanxi.com/c/2023/0301/2759496.shtml', 'http://news.hsw.cn/system/2023/0130/1580996.shtml', 'Esri World Imagery z19（屋面与附楼量取）'],
    photos: ['https://www.ishaanxi.com/c/2023/0301/2759496.shtml（航拍）', 'http://news.hsw.cn/system/2023/0130/1580996.shtml（站台）'],
    confidence: 'medium（平面、屋面形式）；low（高度）',
    notes: '站房面向东南（站前广场 POI (−17520, −1038)）；柱廊按裙房外 3.2 m、柱距 7.5 m 近似。站台雨棚未建。',
  },
};

// ═════════════════════════ 25. 西安绿地笔克国际会展中心（高新锦业路） ═════════════════════════
// 照片（航空之家 / 西安车展，见 meta.photos）：通高玻璃幕墙 + 竖向金属肋，屋檐为逐跨起伏的波浪形（每个展厅一段上拱的弧形屋面），
// 西端入口竖排“西安绿地笔克国际会展中心”字。平面示意图：自西向东 4 号–1 号四个展厅 + 东端大会堂 / 登录厅（斜切）。
// 轮廓：OSM“西安绿地笔克国际会展中心”（324×93 m）；卫星 z18：屋面按南北向分成 4 个约 54 m 宽的弧形跨（分缝 x ≈ −5641 / −5586 / −5532 / −5478）。
// 高度无公开数据：檐口约 20 m、弧顶再高 5 m（照片比例）。原 landmarks2026 为 26 m 通用盒子。
const bike = {
  id: 'lm2-greenland-pico',
  name: '西安绿地笔克国际会展中心',
  fp: '5f82b1d2-ba8d-4655-b243-824fda2f3051',
  parts: [
    { name: 'halls', fp: '5f82b1d2-ba8d-4655-b243-824fda2f3051', base: 0, top: 20, roof: { mech: false, parapet: 0.4 },
      style: { pattern: 'verticalFins', tint: '#3f5f75', spd: '#d9dde0', floorH: 5, colW: 3, spandrel: 0.1, mullW: 0.5, lit: 0.6 },
      crown: [-5673, -5613.5, -5559, -5505].map((x) => ({ type: 'arch', size: [86, 53], at: [x, 7470], rot: 90, h: 5, seg: 14,
        mat: { color: '#dfe2e4', roughness: 0.4, metalness: 0.45 } })) },
  ],
  signs: [{ text: '西安绿地笔克国际会展中心', part: 'halls', face: 'W', vertical: true, y: 11, h: 14, color: '#c8102e' }],
  night: { floodlight: [{ part: 'halls', color: '#e0f0ff', strength: 0.3 }] },
  supersede: { names: ['西安绿地笔克国际会展中心'] },
  meta: {
    category: 'expo',
    dossier: 'landmarks2.json#西安绿地笔克国际会展中心',
    sources: ['http://www.moxingyun.com/zhanguan/detail-351.html', 'Overture building（OSM“西安绿地笔克国际会展中心”）', 'Esri z18 卫星（屋面分跨）'],
    photos: ['http://www.pinbang.cn/news/show.php?itemid=3721', 'https://www.sohu.com/a/194727270_351301（展区平面示意图）'],
    confidence: 'medium（平面、分跨）；low（高度）',
    notes: '四个展厅各一段南北轴向的弧形屋面（跨 53 m、矢高 5 m）；东端斜切的大会堂部分为平屋面。',
  },
};

// ═════════════════════════ 26. 招商局丝路中心·北区（国际港务区，奥体中轴北翼） ═════════════════════════
// 招商蛇口开发，奥体中轴公园南北两翼“奥体之翼、中轴之门”；北区总高度 144 m / 31 层（搜狐焦点），层高 4.2 m；
// 效果图（房天下）：圆角玻璃塔楼 + 白色竖向线条、弧形商业裙房，两塔之间有连廊。
// 轮廓：OSM w1381177355–359（塔楼 3 座 + 北侧低层 2 座）。Esri z19：三座塔屋面随倾斜向北偏移，偏移量分别约 41 / 35 / 20 m；
// 以最高者 = 144 m 标定（约 0.28 m/米），另两座约 123 m、70 m（卫星倾斜估算，±10 m）。
// 原 landmarks2026“招商局丝路中心 北塔”（144 m 通用塔）被替代；南区（奥体中轴南翼）塔楼落位未能核实，本条不建。
const ZS_GLASS = { pattern: 'verticalFins', tint: '#6f93ad', spd: '#eef0f1', floorH: 4.2, colW: 1.6, spandrel: 0.08, mullW: 0.35, lit: 0.45 };
const zhaoshangN = {
  id: 'lm2-cmsk-silkroad-n',
  name: '招商局丝路中心',
  center: [8466, -12575],
  parts: [
    { name: 't1', fp: 'ab02e1fd-19cd-49fc-b46e-f233c60031c3', roundCorners: 4, base: 0, top: 144, style: ZS_GLASS, crown: [{ type: 'parapet', h: 3 }] },
    { name: 't2', fp: 'e1c5c273-05d8-4c94-aa16-4041c5b50922', roundCorners: 4, base: 0, top: 123, style: { ...ZS_GLASS, seed: 41 }, crown: [{ type: 'parapet', h: 3 }] },
    { name: 't3', fp: 'bc28c4f6-6c81-46c5-bec7-d51a357fa20a', roundCorners: 4, base: 0, top: 70, style: { ...ZS_GLASS, seed: 42 }, crown: [{ type: 'parapet', h: 2.5 }] },
    { name: 'podW', kind: 'podium', fp: '265f8bf7-cfac-4125-a5d0-dea426e49afa', base: 0, top: 18, style: { pattern: 'retail', tint: '#4b6272', spd: '#e8e8e6' }, roofMat: { color: '#9aa0a2', roughness: 0.8 } },
    { name: 'podC', kind: 'podium', fp: '8bc53c7f-cdaa-44b7-a123-672d937207ad', base: 0, top: 14, style: { pattern: 'retail', tint: '#4b6272', spd: '#e8e8e6' }, roofMat: { color: '#9aa0a2', roughness: 0.8 } },
  ],
  signs: [{ text: '招商局丝路中心', part: 't1', face: 'S', y: 138, h: 3.2, color: '#ffffff', glow: '#d8ecff' }],
  night: { outline: [{ part: 't1', color: '#e8f4ff', w: 0.45, vertical: true }, { part: 't2', color: '#e8f4ff', w: 0.45, vertical: true }] },
  // landmarks2026 另有“招商局丝路中心 南塔”（synth 合成落位 (8479, −12140)）：卫星上该处为住宅楼群，南翼地块 w1246792166 为带天窗的大型商业体，
  // 未见 144 m 塔楼——合成塔落位无依据，一并移除。
  supersede: { names: ['招商局丝路中心 北塔', '招商局丝路中心 南塔'] },
  meta: {
    category: 'office',
    dossier: 'landmarks2.json#招商局丝路中心（北区）',
    sources: ['https://www.sohu.com/a/882246443_121966444', 'https://m.focus.cn/xian/zixun/16d95fabb125821e.html', 'https://www.sunyat.com/shangyezongheti/319.html',
      'Overture building w1381177355–w1381177359', 'Esri z19 卫星（屋面倾斜偏移标定高度）'],
    photos: ['https://xian.newhouse.fang.com/2021-04-12/39329115.htm（效果图、总平面）', 'https://xian.news.fang.com/house/3610192266_22947499.htm'],
    confidence: 'high（落位、最高塔 144 m）；low（另两塔高度按卫星倾斜比例估算）',
    notes: '塔间连廊与弧形裙房未建（高度与位置无依据）。',
  },
};

export default [qinhan, dafengge, chuangyi, ziran, banpo, yisushe, laogang, kaogu, dianjing, xishi, expo, hesheng, ritz, shangri, hilton, haiyang, tiantan, linde, silkroadSculpture, gangzhan, gwStation, shengtiguan, dmgMuseum, xizhan, bike, zhaoshangN];
