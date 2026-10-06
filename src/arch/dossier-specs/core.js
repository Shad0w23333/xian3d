// 逐栋档案 · 明城墙以内 + 南门/南稍门一带（钟鼓楼、东西南北大街、解放路、骡马市、北大街、新城广场、永宁门内外）
// 依据：research/refs/dossiers/core_south.json（及 public.json 中落在本片的条目）逐条档案 + 照片
//       （scratchpad/dossier_core_south/photos/*），Overture/OSM 实测轮廓（public/data/dossier_fp.json），
//       Esri World Imagery z19 卫星（高楼屋面向东偏移约 0.37 m/每米楼高，塔楼落位 = 轮廓，不取屋面位置）。
// 原则：档案里为 null 的数值不编——能从照片数层就数层 × 合理层高（meta.notes 写“按照片数层”），能从卫星量取就量取，
//       都做不到就保守取实测轮廓 + 最低可信高度并注明。逐栋依据与照片对照差异见 research/refs/dossiers/model_log_core.md。
// 坐标：世界系 X 东、Z 南（北 = −Z），原点钟楼；pts 为世界坐标扁平数组。字段说明见 docs/DOSSIER_KIT.md。

// ───────────── 小工具 ─────────────
/** 轴对齐矩形（世界坐标 x0..x1, z0..z1） */
const R = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];
/** 局部框：中心 (cx,cz)，u 沿 rot（地图角度，逆时针自正东），w 为 u 的左侧（rot+90°）→ 世界坐标 */
const frame = (cx, cz, rot) => {
  const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
  return (u, w) => [+(cx + u * c - w * s).toFixed(2), +(cz - u * s - w * c).toFixed(2)];
};
/** 局部框里的矩形（u0..u1, w0..w1）→ 世界坐标扁平数组 */
const frect = (F, u0, w0, u1, w1) => [...F(u0, w0), ...F(u1, w0), ...F(u1, w1), ...F(u0, w1)];
/** 沿线段 a→b 等距排布 n 个点（两端各留 m 米），再沿外法线（地图 [东,北] 单位向量 out）外移 d 米 */
const along = (a, b, n, m, out = [0, 0], d = 0) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
  return Array.from({ length: n }, (_, i) => {
    const t = m + ((L - 2 * m) * i) / Math.max(1, n - 1);
    return [a[0] + ux * t + out[0] * d, a[1] + uz * t - out[1] * d];
  });
};
const TANG_RED = '#8e2a1f'; // 唐风红柱/额枋（档案 frame_color_hex，时代盛典、中环广场）
const TILE = { color: '#4d5156', roughness: 0.85, metalness: 0.1 }; // 深灰筒瓦屋面（照片）
const PHOTO = 'scratchpad/dossier_core_south/photos/';

// ───────────── 1) 开元商城（钟楼店） ─────────────
// 轮廓 30650632（OSM w1264364569，139×114 m，西北边为正对钟楼盘道的斜边）。卫星 z19：屋面上 3 个石材鼓形体量
// （西北斜边上两个 r≈13.6/12.4 m、东北角一个 r≈11 m）+ 中部一个带锥形玻璃采光顶的圆形中庭（r≈13.6 m）；
// 照片 kaiyuan_0/3：米黄石材 + 两三道青绿色玻璃横带、鼓形体量叠落，首层一圈红色圆柱柱廊，西北主入口上方金色“开元商城”。
const KY_NW = [[33.4, 112.0], [110.0, 34.9]]; // 西北斜边（朝钟楼）两端
const kaiyuan = {
  id: 'kaiyuan',
  name: '开元商城',
  fp: '30650632',
  parts: [
    {
      name: 'mall', // 主体 7 层（按照片数层 + 10.3 万 m² / 1.09 万 m² 轮廓推算），层高约 4.7 m
      fp: '30650632', base: 0, top: 33,
      style: { pattern: 'stoneWindows', tint: '#3f8f8a', spd: '#d8c7a6', floorH: 4.7, colW: 7, spandrel: 0.72, mullW: 0.35, lit: 0.5 },
      roof: { mech: false, parapet: 1.2 },
    },
    // 鼓形体量（卫星量取圆心/半径，±2 m）：高出主体约 1–1.5 层，顶部一圈石材檐带
    ...[['drumA', [70.6, 96.6], 13.6, 39], ['drumB', [102.7, 64.5], 12.4, 39], ['drumC', [152.0, 64.5], 11.0, 36.5]].map(([name, at, r, top], i) => ({
      name, shape: 'circle', size: [2 * r, 2 * r], at, base: 0, top,
      style: { pattern: 'stoneWindows', tint: '#3f8f8a', spd: '#d9c8a8', floorH: 4.7, colW: 5.5, spandrel: 0.66, mullW: 4.2, lit: 0.45, seed: 11 + i },
      roof: { mech: false, parapet: 1.0 },
    })),
    {
      name: 'atrium', // 中部圆形中庭：锥形玻璃采光顶（卫星可见同心圆肋）
      shape: 'circle', size: [27.2, 27.2], at: [106.0, 104.0], base: 0, top: 35,
      style: { pattern: 'stoneWindows', tint: '#3f8f8a', spd: '#d9c8a8', floorH: 4.7, colW: 5.5, spandrel: 0.7, mullW: 4.2, lit: 0.4 },
      roof: { mech: false, parapet: 0.8 },
      crown: [{ type: 'pyramid', inset: 1.2, h: 6, mat: { color: '#7fa3a8', metalness: 0.55, roughness: 0.15 } }],
    },
    // 首层红色圆柱柱廊（照片可见十余根，沿西北斜边外 2.5 m）
    ...along(KY_NW[0], KY_NW[1], 12, 8, [-0.709, 0.705], 2.5).map((at, i) => ({
      name: 'col' + i, kind: 'solid', shape: 'circle', size: [1.5, 1.5], at, base: 0, top: 9.5,
      mat: { color: '#b3261e', roughness: 0.5, glow: '#ff5a3a', glowNight: 0.9 },
    })),
  ],
  signs: [
    { text: '开元商城', part: 'mall', face: 'NW', y: 18.5, h: 5.2, color: '#d4a64a', serif: true }, // 西北主入口上方金色书法字
  ],
  bands: [{ part: 'drumA', levels: [36.2], h: 1.2, depth: 0.3, color: '#bfa988' }, { part: 'drumB', levels: [36.2], h: 1.2, depth: 0.3, color: '#bfa988' }],
  night: { floodlight: [{ part: 'mall', color: '#ffe0b0', strength: 0.34 }, { part: 'drumA', color: '#ffe0b0', strength: 0.3 }, { part: 'drumB', color: '#ffe0b0', strength: 0.3 }] },
  supersede: { keys: ['kaiyuan'], names: ['开元商城', '开元商城（钟楼店）', '开元商城(钟楼店)'] },
  meta: {
    dossier: 'core_south.json#开元商城（钟楼店）',
    sources: ['OSM w1264364569', 'https://m.book118.com/html/2017/0321/96314027.shtm（建筑面积约 10.3 万 m²）', 'https://sn.cri.cn/n/20240506/3a6ccecc-f866-2f34-1adc-a19a10be7926.html（7 层天台）', 'Esri World Imagery z19'],
    photos: [PHOTO + 'kaiyuan_0.jpg', 'kaiyuan_1.jpg', 'kaiyuan_3.jpg'],
    confidence: 'medium（形体/立面）；low（高度）',
    notes: '高度无公开数据：主体按照片数层（约 7 层）× 4.7 m → 33 m（10.3 万 m² ÷ 1.09 万 m² 轮廓 ≈ 9.5 层含地下，互证）；'
      + '鼓形体量按照片比主体高约 1–1.5 层 → 36.5–39 m；7 层天台照片视高与钟楼（36 m）顶相当，互证。鼓形位置/半径按卫星量取（±2 m）。'
      + '“中国结”装饰与红灯笼未建（尺度太小）。旧模型 sky-data mallSpecs kaiyuan（36 m 方盒）被替代。',
  },
};

// ───────────── 2) 西安钟楼饭店 ─────────────
// 轮廓 5a869da7（OSM w1290155887）：西北—东南斜向主楼（正对钟楼盘道，朝东北）+ 西端沿西大街的西翼、东南端沿南大街的南翼。
// 照片 belltowerhotel_0–3：7 层米褐色石材横向带窗，两端塔楼有竖向凸窗条，屋顶两端各一座玻璃塔屋 + 大出挑两层薄屋檐，
// 屋顶中部“鐘樓飯店 BELL TOWER HOTEL XIAN”字牌（白天深色、夜间金色）；中部入口石柱门廊。
const BT = frame(-80.2, 85.4, -43); // 主楼中线：u 朝东南，w 朝东北
const belltower = {
  id: 'belltower-hotel',
  name: '西安钟楼饭店',
  fp: '5a869da7',
  parts: [
    {
      name: 'body', // 7 层：首层约 4.7 m + 6 × 3.3 m = 24.5 m（按照片数层）
      fp: '5a869da7', base: 0, top: 24.5,
      style: { pattern: 'stoneWindows', tint: '#5d5a4e', spd: '#c8b594', floorH: 3.3, colW: 2.1, spandrel: 0.44, mullW: 0.45, lit: 0.55 },
      roof: { mech: false, parapet: 1.0 },
    },
    {
      name: 'arcade', // 首层石材方柱柱廊 + 商铺
      kind: 'facade', fp: '5a869da7', grow: 0.15, base: 0, top: 4.7,
      style: { pattern: 'stoneLit', tint: '#3d3a33', spd: '#bba786', floorH: 4.7, colW: 4.2, spandrel: 0.12, mullW: 1.1, lit: 0.85 },
    },
    // 两端玻璃塔屋 + 两层大出挑薄屋檐（照片 belltowerhotel_0/1）
    ...[['pavNW', -46], ['pavSE', 46]].map(([name, u]) => ({
      name, shape: 'rect', size: [14, 12], at: BT(u, -2), rot: -43, base: 24.5, top: 28.6,
      style: { pattern: 'curtain', tint: '#6b6450', spd: '#b9a88a', floorH: 4.1, colW: 1.6, spandrel: 0.1, mullW: 0.14, lit: 0.8 },
      roof: { mech: false, parapet: 0.3 },
      crown: [{ type: 'slab', ov: 2.8, h: 0.55, mat: '#d8cfbd', glow: '#ffcf7a' }, { type: 'slab', ov: 0.6, h: 0.8, mat: '#cfc6b3' }],
    })),
    { name: 'signbar', kind: 'solid', shape: 'rect', size: [30, 0.5], at: BT(0, 4), rot: -43, base: 24.5, top: 25.4, mat: '#3a3833' }, // 字牌支架
  ],
  signs: [
    // 照片为繁体“鐘樓飯店”（档案写作简体“钟楼饭店”）；白天深铜色、夜间金色发光
    { text: '鐘樓飯店', part: 'signbar', face: 'NE', y: 28.2, h: 3.4, color: '#b08a3a', serif: true },
    { text: 'BELL TOWER HOTEL XIAN', part: 'signbar', face: 'NE', y: 25.9, h: 0.95, color: '#b08a3a' },
    { text: '鐘樓飯店', part: 'body', face: 'NE', y: 6.2, h: 1.3, color: '#c9a646', serif: true }, // 主入口门楼额枋
  ],
  night: { floodlight: [{ part: 'body', color: '#ffc060', strength: 0.5 }] }, // 档案：整体暖黄色泛光
  supersede: { names: ['西安钟楼饭店', '钟楼饭店', '钟楼饭店城市航站楼（机场巴士乘车点）'] },
  meta: {
    dossier: 'core_south.json#西安钟楼饭店',
    sources: ['OSM w1290155887', 'https://k.sina.cn/article_7453483002_1bc431ffa0010158sg.html（一共七层）', 'https://hotels.ctrip.com/hotels/450319.html'],
    photos: [PHOTO + 'belltowerhotel_0.jpg', 'belltowerhotel_1.jpg', 'belltowerhotel_2.jpg', 'belltowerhotel_3.jpg'],
    confidence: 'medium',
    notes: '7 层（新浪实拍文）；高度无公开数据，按照片数层：首层约 4.7 m + 6 × 3.3 m → 24.5 m，塔屋 4.1 m + 两层挑檐 → 约 30 m。'
      + '塔屋 14×12 m 为档案照片目测（非实测），位置取主楼两端（西翼、南翼转折处）。字牌按照片写繁体。',
  },
};

// ───────────── 3) 西安市邮局钟楼支局办公楼（钟楼邮局） ─────────────
// 轮廓 27d72144（OSM w1465147501，height=18 / 6 层）：84×22 m 斜向长楼，主立面朝西南正对钟楼，中部外凸石柱门廊。
// 照片 youju_0/2（从钟楼广场看东北）：5 层米黄面砖，屋顶栏杆 + 金色小宝顶；两端体量略高、上覆出挑中式歇山屋顶，
// 端部再以低一层的体量收头；门廊上方绿色“中国邮政 CHINA POST”。
const YJ = frame(88.6, -82.1, -45.5); // u 朝东南，w 朝东北（主立面在 w≈−10.2，背立面 w≈12.1）
const YJ_ST = { pattern: 'stoneWindows', tint: '#4f5d5a', spd: '#d6c49c', floorH: 3.3, colW: 2.6, spandrel: 0.46, mullW: 1.0, lit: 0.5 };
const youju = {
  id: 'zhonglou-post',
  name: '钟楼邮局',
  center: [88.6, -82.1],
  parts: [
    { name: 'mid', pts: frect(YJ, -25, -10.2, 25, 12.1), base: 0, top: 16.5, style: YJ_ST, roof: { mech: false, parapet: 1.2 } },
    ...[['endNW', -32], ['endSE', 32]].map(([name, u]) => ({
      name, pts: frect(YJ, u - 7, -10.2, u + 7, 12.1), base: 0, top: 18.2, style: { ...YJ_ST, seed: 21 },
      crown: [{ type: 'cnhip', style: 'xieshan', ov: 1.6, h: 4.2, mat: TILE }],
    })),
    // 端部低一层收头（照片 youju_0 右端）
    ...[['tipNW', -43.5, -39], ['tipSE', 39, 43.5]].map(([name, u0, u1]) => ({
      name, pts: frect(YJ, u0, -8, u1, 10), base: 0, top: 13.2, style: YJ_ST, roof: { mech: false, parapet: 1.0 },
    })),
    { name: 'portico', pts: frect(YJ, -10.5, -14.8, 10.5, -10.2), base: 0, top: 8.5, style: { pattern: 'stoneLit', tint: '#3d4744', spd: '#d8c8a2', floorH: 8.5, colW: 3.5, spandrel: 0.1, mullW: 1.2, lit: 0.7 }, roof: { mech: false, parapet: 0.6 } },
  ],
  signs: [
    { text: '中国邮政 CHINA POST', part: 'portico', face: 'SW', y: 7.2, h: 1.6, color: '#0b7b3e' },
  ],
  supersede: { names: ['西安市邮局钟楼支局办公楼（钟楼邮局）', '钟楼邮局', '西安市邮局钟楼支局办公楼'] },
  site: ['27d72144-5344-42e9-aa26-349f121585fc'],
  meta: {
    dossier: 'core_south.json#西安市邮局钟楼支局办公楼（钟楼邮局）',
    sources: ['OSM w1465147501（height=18, building:levels=6）', 'https://commons.wikimedia.org/wiki/Category:Bell_Tower_Post_Office', 'http://www.sohu.com/a/34190622_114812'],
    photos: [PHOTO + 'youju_0.jpg', 'youju_1.jpg', 'youju_2.jpg'],
    confidence: 'medium',
    notes: '主体 5 层按照片数层（首层 3.3 m 起算）→ 16.5 m + 屋顶栏杆；两端歇山屋顶体量 18.2 m（OSM height=18）+ 屋顶 4.2 m。'
      + '长 84 m、进深 22 m 取 OSM 轮廓；两端体量宽 16 m、收头低一层为照片比例估计。屋顶金色小宝顶与旗杆未建。',
  },
};

// ───────────── 4) 西安报话大楼 ─────────────
// L 形：转角主楼 ab7cab1c（OSM w1465146485，20×20 m，西北转角朝西华门十字）+ 南翼 62409ac1（67×24 m）+ 东翼 ad458cbf（45×20 m），
// 与 wiki“L 形平面转角处的主楼、东南两翼”一致（档案未定的 f9cc1f69 为西南另一栋高层，卫星长影来自它）。
// 照片 baohua_0/4/5：奶油色墙面竖窗，主楼 8 层（含地下室）→ 退进的方形钟楼（四面黑底白字大钟）→ 带小窗与角柱栏杆的塔顶层 → 天线。
const BH = { x: 126.1, z: -506.1 }; // 转角主楼中心（轮廓质心）
const BH_ST = { pattern: 'stoneWindows', tint: '#46515b', spd: '#eadfc6', floorH: 4.2, colW: 2.3, spandrel: 0.46, mullW: 1.05, lit: 0.5 };
const clockFaces = ['N', 'E', 'S', 'W'].map((f) => {
  const d = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[f];
  return { f, at: [BH.x + d[0] * 6.35, BH.z + d[1] * 6.35], rot: f === 'N' || f === 'S' ? 0 : 90 };
});
const baohua = {
  id: 'baohua',
  name: '西安报话大楼',
  center: [BH.x, BH.z],
  parts: [
    { name: 'tower', fp: 'ab7cab1c-4fa7-4712-b49e-ccfa42a2d5e4', base: 0, top: 36, style: BH_ST, roof: { mech: false, parapet: 1.2 } },
    { name: 'wingS', fp: '62409ac1-bb86-41ba-9cdd-59696f66d4b0', base: 0, top: 21, style: { ...BH_ST, seed: 31 }, roof: { mech: true, parapet: 1.0 } },
    { name: 'wingE', fp: 'ad458cbf-19bb-4339-86a0-ce47c9538148', base: 0, top: 21, style: { ...BH_ST, seed: 32 }, roof: { mech: false, parapet: 1.0 } },
    { name: 'clock', kind: 'solid', shape: 'rect', size: [12.4, 12.4], at: [BH.x, BH.z], base: 36, top: 50, mat: '#e8dcc0' },
    // 四面大钟：黑色钟盘（约 8 m 见方）
    ...clockFaces.map(({ f, at, rot }) => ({ name: 'dial' + f, kind: 'solid', shape: 'rect', size: [8.2, 0.4], at, rot, base: 38.6, top: 46.8, mat: '#141414' })),
    {
      name: 'lantern', shape: 'rect', size: [9.4, 9.4], at: [BH.x, BH.z], base: 50, top: 57,
      style: { pattern: 'stoneWindows', tint: '#46515b', spd: '#eadfc6', floorH: 3.5, colW: 1.6, spandrel: 0.4, mullW: 0.7, lit: 0.4 },
      roof: { mech: false },
      crown: [
        { type: 'parapet', h: 1.0 },
        { type: 'frame', h: 5.5, inset: 0.8, step: 3, post: 0.35, mat: 'white' }, // 塔顶角柱 + 栏杆（女儿墙由 buildTower 处理，不抬游标），顶 62.5 m
        { type: 'masts', y: 62.5, list: [[0, 0]], top: 71.8, r: 0.45 }, // 天线（网友实测 71.8 m）
      ],
    },
  ],
  signs: clockFaces.flatMap(({ f }) => [
    ['12', 0, 45.4], ['6', 0, 40.0], ['3', -3.0, 42.7], ['9', 3.0, 42.7],
  ].map(([t, sh, y]) => ({ text: t, part: 'dial' + f, face: f, y, h: 1.5, shift: sh, color: '#f2f2ee', minEdge: 1 }))),
  supersede: { names: ['西安报话大楼', '报话大楼'] },
  meta: {
    dossier: 'core_south.json#西安报话大楼',
    sources: ['https://zh.wikipedia.org/wiki/西安报话大楼（总高 62.5 m，主楼 8 层含地下室 + 顶部 2 层钟楼，两翼 6 层含地下室）', 'https://gaoloumi.cc/forum.php?mod=viewthread&tid=3301142（含天线 71.8 m）', 'OSM w1465146485 / w1465146575 / w1465146481'],
    photos: [PHOTO + 'baohua_0.jpg', 'baohua_3.jpg', 'baohua_4.jpg', 'baohua_5.jpg'],
    confidence: 'medium',
    notes: '轮廓：档案 overture_id 为 null，按 wiki“L 形、转角主楼朝西华门十字”与卫星对位到 ab7cab1c + 62409ac1 + ad458cbf。'
      + '分段高度按照片比例：主楼 7 层地上 × 4.2 m + 女儿墙 → 36 m；钟楼 36–50 m（钟盘约 8 m 见方，38.6–46.8 m）；塔顶层 50–57 m + 栏杆构架至 62.5 m（wiki 总高）；天线顶 71.8 m（网友实测）。'
      + '两翼 5 层地上 × 4.2 m → 21 m。钟面只做了 12/3/6/9 数字（指针未建）。',
  },
};

// ───────────── 5) 中环广场（原银泰百货钟楼店） ─────────────
// 轮廓 c4e942fe（OSM w1290155231，95×71 m），北临西大街。照片 zhonghuan_0–2：7 层浅粉米色石材主体，北立面两端高出主体的方形角楼
// （重檐唐风屋顶、竖排红色“中环广场”），正中较低的歇山门楼，主体屋面一圈檐口 + 青绿色玻璃采光顶；夜间檐口金色轮廓灯、角楼红色竖向霓虹。
const ZH_ST = { pattern: 'stoneWindows', tint: '#6f8fa0', spd: '#d9c3b2', floorH: 4.5, colW: 3.0, spandrel: 0.42, mullW: 1.2, lit: 0.55 };
const zhonghuan = {
  id: 'zhonghuan',
  name: '中环广场',
  fp: 'c4e942fe',
  parts: [
    {
      name: 'body', pts: R(-441, 55, -345, 114), base: 0, top: 32, style: ZH_ST, // 主体（北立面在角楼之间后退约 12 m，航拍 zhonghuan_2）
      crown: [{ type: 'eave', ov: 2.0, depth: 3.0, h: 1.8, mat: TILE }, { type: 'pyramid', inset: 16, h: 4.5, mat: { color: '#4f8f86', metalness: 0.5, roughness: 0.2 } }],
    },
    // 两座角楼：18×18 m，墙身至 40 m + 下檐，再上一层红柱外廊 + 歇山顶
    ...[['towerW', -432], ['towerE', -354]].flatMap(([name, x]) => [
      { name, shape: 'rect', size: [18, 18], at: [x, 52], base: 0, top: 40, style: { ...ZH_ST, seed: 41 }, crown: [{ type: 'eave', ov: 2.4, depth: 3.5, h: 2.0, mat: TILE }] },
      {
        name: name + 'Top', shape: 'rect', size: [12, 12], at: [x, 52], base: 40, top: 44.5,
        style: { pattern: 'grid', tint: '#3a2a24', spd: TANG_RED, floorH: 4.5, colW: 2.0, spandrel: 0.15, mullW: 0.4, lit: 0.6 },
        crown: [{ type: 'cnhip', style: 'xieshan', ov: 2.4, h: 5.2, mat: TILE }],
      },
    ]),
    { name: 'front', pts: R(-423, 43, -363, 55), base: 0, top: 11, style: { ...ZH_ST, pattern: 'retail', floorH: 5.5, spd: '#cdb7a5' }, crown: [{ type: 'eave', ov: 1.5, depth: 2.0, h: 1.2, mat: TILE }] },
    {
      name: 'gate', pts: R(-408, 43.5, -378, 55), base: 0, top: 16, // 正中歇山门楼
      style: { pattern: 'grid', tint: '#3d3430', spd: TANG_RED, floorH: 5.3, colW: 3.2, spandrel: 0.2, mullW: 0.7, lit: 0.7 },
      crown: [{ type: 'cnhip', style: 'xieshan', ov: 2.0, h: 5.0, mat: TILE }],
    },
  ],
  signs: [
    { text: '中环广场', part: 'towerW', face: 'N', y: 25, h: 13, color: '#e0322b', vertical: true },
    { text: '中环广场', part: 'towerE', face: 'N', y: 25, h: 13, color: '#e0322b', vertical: true },
    { text: '银泰百货', part: 'gate', face: 'N', y: 13.2, h: 2.0, color: '#e0322b' },
  ],
  bands: [{ part: 'body', levels: [30.2], h: 1.2, depth: 0.35, color: '#7a2a22' }], // 檐下红褐色斗拱与额枋
  night: {
    outline: [
      { part: 'body', color: '#ffc34a', y: 33.8, w: 0.4 },
      { part: 'towerW', color: '#ff2a2a', vertical: true, w: 0.4 }, { part: 'towerE', color: '#ff2a2a', vertical: true, w: 0.4 },
      { part: 'towerWTop', color: '#ffc34a', w: 0.35 }, { part: 'towerETop', color: '#ffc34a', w: 0.35 },
    ],
  },
  supersede: { names: ['中环广场', '中环广场（原银泰百货钟楼店）', '中环广场(西大街)', '银泰百货钟楼店'] },
  site: ['c4e942fe-d592-4a76-af3d-7769ab14e32a'],
  meta: {
    dossier: 'core_south.json#中环广场（原银泰百货钟楼店）',
    sources: ['OSM w1290155231', 'https://baike.so.com/doc/849259-897983.html（地上 7 层、地下 2 层）', 'http://www.bosiny.com/n/index.php?ac=article&at=read&did=862', 'https://commons.wikimedia.org/wiki/File:西安中环广场夜景.JPG'],
    photos: [PHOTO + 'zhonghuan_0.jpg', 'zhonghuan_1.jpg', 'zhonghuan_2.jpg'],
    confidence: 'medium',
    notes: '地上 7 层（360 百科）× 约 4.5 m → 32 m；角楼按照片比主体高约 2 层 → 墙身 40 m、上层 44.5 m、屋脊约 50 m。'
      + '角楼 18×18 m、门楼 30×12 m、北立面后退 12 m 均为照片（航拍 zhonghuan_2）比例估计。钟楼银泰已暂停营业（档案），门楼字牌按航拍保留。',
  },
};

// ───────────── 6) 时代盛典大厦（原百盛购物中心西大街店） ─────────────
// 三块 OSM 轮廓：西段 B 座 1bfe6d11、中部 b6e35dbe（r17351237）、东段 C 座 138e0828，南临西大街。
// 照片 baisheng_2（西大街对面正拍）：对称构图——前排约 3 层灰色裙楼（两侧各一座红柱歇山亭坐在裙楼屋面上，正中红柱门楼），
// 后排两翼 6 层白色面砖 + 红色檐下阁楼层，中央主楼约 8 层白色 + 重檐庑殿顶（红柱、斗拱）。
const BS_W = { pattern: 'stoneWindows', tint: '#5d6b73', spd: '#e6e3dc', floorH: 4.0, colW: 3.0, spandrel: 0.5, mullW: 1.3, lit: 0.5 };
const BS_RED = { pattern: 'grid', tint: '#3a2a24', spd: TANG_RED, floorH: 4.0, colW: 2.2, spandrel: 0.2, mullW: 0.45, lit: 0.6 };
const BS_POD = { pattern: 'stoneWindows', tint: '#4c5a63', spd: '#c4c4be', floorH: 4.3, colW: 3.4, spandrel: 0.55, mullW: 1.4, lit: 0.6 };
const baisheng = {
  id: 'shidai-shengdian',
  name: '时代盛典大厦',
  center: [-736, -88],
  parts: [
    ...[['wingW', R(-804, -144, -755, -52)], ['wingE', R(-711, -129, -668, -52)]].flatMap(([name, pts]) => [
      { name, pts, base: 0, top: 24, style: BS_W, roof: { mech: false, parapet: 0.6 } },
      { name: name + 'Att', pts, grow: -2.5, base: 24, top: 27.5, style: BS_RED, roof: { mech: false, parapet: 0.3 }, crown: [{ type: 'eave', ov: 1.8, depth: 3, h: 1.3, mat: TILE }] },
    ]),
    // 北广济街（roads.json 中心线 x≈-732.5、路宽 8 m）从中部主楼与正中门楼底下穿过（影像：街口在门楼下进入楼内）：
    // 主楼、门楼在路面上方架空（base 6.5），两侧落地段托起，底面补石材顶板；footprint 让架空段仍算占地（排除区）
    { name: 'main', pts: R(-755, -129, -711, -54), base: 6.5, top: 31, footprint: true, style: { ...BS_W, seed: 51 }, roof: { mech: false, parapet: 0.3 }, crown: [{ type: 'eave', ov: 2.4, depth: 3.5, h: 1.8, mat: TILE }] },
    { name: 'mainW', pts: R(-755, -129, -737.5, -54), base: 0, top: 6.5, style: { ...BS_W, seed: 51 }, roof: { mech: false, parapet: 0 } },
    { name: 'mainE', pts: R(-727.5, -129, -711, -54), base: 0, top: 6.5, style: { ...BS_W, seed: 52 }, roof: { mech: false, parapet: 0 } },
    { name: 'passSoffit', kind: 'solid', mat: 'stone', pts: R(-737.5, -129, -727.5, -36), base: 6.1, top: 6.5 },
    { name: 'mainTop', pts: R(-750, -122, -716, -61), base: 31, top: 35, style: BS_RED, crown: [{ type: 'cnhip', style: 'wudian', ov: 2.6, h: 7, mat: TILE }] },
    ...[['podW', R(-804, -52, -755, -31)], ['podE', R(-711, -52, -668, -34)]].map(([name, pts]) => ({ name, pts, base: 0, top: 13, style: BS_POD, roof: { mech: false, parapet: 1.0 } })),
    // 裙楼屋面上的两座红柱歇山亭
    ...[['pavW', [-779.5, -42]], ['pavE', [-689.5, -43.5]]].map(([name, at]) => ({
      name, shape: 'rect', size: [24, 11], at, base: 13, top: 18, style: BS_RED, crown: [{ type: 'cnhip', style: 'xieshan', ov: 1.8, h: 4.2, mat: TILE }],
    })),
    { name: 'gate', pts: R(-746, -54, -720, -36), base: 6.5, top: 11, footprint: true, style: { ...BS_RED, floorH: 4.5, colW: 3.2, mullW: 0.9 }, crown: [{ type: 'cnhip', style: 'xieshan', ov: 1.6, h: 3.4, mat: TILE }] },
    { name: 'gateW', pts: R(-746, -54, -737.5, -36), base: 0, top: 6.5, style: { ...BS_RED, floorH: 5.5, colW: 3.2, mullW: 0.9 }, roof: { mech: false, parapet: 0 } },
    { name: 'gateE', pts: R(-727.5, -54, -720, -36), base: 0, top: 6.5, style: { ...BS_RED, floorH: 5.5, colW: 3.2, mullW: 0.9 }, roof: { mech: false, parapet: 0 } },
  ],
  bands: [
    { part: 'main', levels: [29.6], h: 1.2, depth: 0.3, color: '#7a2a22' }, { part: 'wingW', levels: [23], h: 0.8, depth: 0.25, color: '#7a2a22' }, { part: 'wingE', levels: [23], h: 0.8, depth: 0.25, color: '#7a2a22' },
  ],
  night: { outline: [{ part: 'mainTop', color: '#ff7a3a', w: 0.35 }, { part: 'wingWAtt', color: '#ff7a3a', w: 0.3 }, { part: 'wingEAtt', color: '#ff7a3a', w: 0.3 }, { part: 'main', color: '#ff7a3a', y: 31.4, w: 0.3 }] },
  supersede: { names: ['时代盛典大厦', '时代盛典大厦（原百盛购物中心西大街店）', '百盛购物中心西大街店', '时代盛典大厦B', '时代盛典大厦C'] },
  site: ['1bfe6d11-8486-4cb7-931a-de4d5cef4edd', '138e0828-662a-4b32-82f2-21bfb30cfeec'],
  meta: {
    dossier: 'core_south.json#时代盛典大厦（原百盛购物中心西大街店）',
    sources: ['OSM w1263122588 / r17351237 / w1263122585', 'http://www.sohu.com/a/277275416_351305（西大街百盛 2018 年底闭店）'],
    photos: [PHOTO + 'baisheng_2.jpg', 'baisheng_1.jpg'],
    confidence: 'low（高度）；medium（构图）',
    notes: '层数/高度无资料，全部按照片 baisheng_2（正立面，全宽 136 m 标尺约 0.2 m/px）量取：裙楼 13 m、两翼 24 m + 阁楼层至 27.5 m、中央主楼 31 m + 上层至 35 m + 庑殿顶（屋脊约 42 m）、裙楼屋面亭屋脊约 22 m。'
      + '“PARKSON 百盛”招牌：2018 年底闭店后现状未核实，未挂。',
  },
};

// ───────────── 7) 中大国际（南大街店） ─────────────
// 轮廓 7410a065（OSM w1290155440，东西 76 × 南北 42 m），东立面朝南大街。照片 zhongda_4（较新的黑色版本）：阶梯形轮廓——中部高、两侧略低，
// 黑色竖向密肋外皮，中央两根黑色圆柱夹入口与大屏，顶部白色“中大国际 ZHONGDA INTERNATIONAL”。
const ZD_ST = { pattern: 'verticalFins', tint: '#2d3033', spd: '#1c1d1f', floorH: 5.0, colW: 0.9, spandrel: 0.08, mullW: 0.36, lit: 0.35 };
const zhongda = {
  id: 'zhongda',
  name: '中大国际',
  fp: '7410a065',
  parts: [
    { name: 'body', fp: '7410a065', base: 0, top: 26.5, style: ZD_ST, roof: { mech: false, parapet: 0.8 } },
    { name: 'center', pts: R(-106, 594, -37.2, 611), base: 0, top: 31, style: { ...ZD_ST, seed: 61 }, roof: { mech: false, parapet: 0.8 } },
    ...[598.5, 606.5].map((z, i) => ({ name: 'col' + i, kind: 'solid', shape: 'circle', size: [2.2, 2.2], at: [-35.6, z], base: 0, top: 21.5, mat: { color: '#1a1b1d', metalness: 0.6, roughness: 0.3 } })),
  ],
  signs: [
    { text: '中大国际', part: 'center', face: 'E', y: 28.6, h: 2.6, color: '#ffffff', serif: true },
    { text: 'ZHONGDA INTERNATIONAL', part: 'center', face: 'E', y: 26.9, h: 0.6, color: '#ffffff' },
  ],
  night: { media: [{ part: 'center', face: 'E', from: 11, to: 19.5, width: 8 }] },
  supersede: { names: ['中大国际', '中大国际（南大街店）', '中大国际(南大街店)'] },
  meta: {
    dossier: 'core_south.json#中大国际（南大街店）',
    sources: ['OSM w1290155440', 'http://www.sohu.com/a/254086119_700421', 'http://news.winshang.com/html/066/8102.html'],
    photos: [PHOTO + 'zhongda_4.jpg', 'zhongda_0.jpg', 'zhongda_2.jpg'],
    confidence: 'low',
    notes: '层数/高度无资料：按照片数层（约 5–6 层商业，层高约 5 m）→ 两侧 26.5 m、中部 31 m；中部宽 17 m 为照片比例。'
      + '立面取较新的黑色竖肋版本（zhongda_4，棕铜色版本为较早照片）。',
  },
};

// ───────────── 8) 兴正元广场 ─────────────
// 轮廓 b6b34bea（OSM w1264363640，150×142 m 整街区），东大街/骡马市口。照片（360 图片 xzy_0/3/4/5/7 与档案照片）：
// 4–5 层商业体，深灰褐石材 + 金色竖向壁柱 + 广告画框 + 蓝色玻璃窗，屋顶红色“兴正元广场”字牌；西北角一座石材圆柱体（顶部圆环标识 + 玻璃雨棚）。
// 卫星 z19：街区内有玻璃采光顶内街（“风情街”），西北角圆形体量、两个角部小四坡顶亭。
const XZY_ST = { pattern: 'stoneWindows', tint: '#4b5561', spd: '#8a8177', floorH: 4.6, colW: 4.2, spandrel: 0.5, mullW: 1.6, lit: 0.55 };
const xingzhengyuan = {
  id: 'xingzhengyuan',
  name: '兴正元广场',
  fp: 'b6b34bea',
  parts: [
    { name: 'block', fp: 'b6b34bea', base: 0, top: 23, style: XZY_ST, roof: { mech: false, parapet: 1.2 } },
    {
      name: 'drum', shape: 'circle', size: [19, 19], at: [313, 31], base: 0, top: 30, // 西北角石材圆柱体（卫星 r≈9.5 m）
      style: { pattern: 'stoneWindows', tint: '#4b5561', spd: '#c9c0b0', floorH: 4.6, colW: 3.5, spandrel: 0.62, mullW: 2.4, lit: 0.4 },
      roof: { mech: false, parapet: 0.8 },
    },
  ],
  signs: [
    { text: '兴正元广场', part: 'block', face: 'N', y: 25.2, h: 3.0, color: '#c8102e' }, // 屋顶字牌（照片 xzy_3/4）
    { text: 'XINGZHENGYUAN PLAZA', part: 'block', face: 'N', y: 23.3, h: 0.8, color: '#c8102e' },
    { text: '兴正元广场', part: 'drum', face: ['N', 'W'], y: 27.2, h: 2.2, color: '#c8102e' },
  ],
  bands: [{ part: 'drum', levels: [25.6], h: 1.0, depth: 0.3, color: '#b08d3c' }],
  supersede: { names: ['兴正元广场', '兴正元广场(钟楼东大街)', '兴正元购物广场'] },
  meta: {
    dossier: 'core_south.json#兴正元广场',
    sources: ['OSM w1264363640', 'https://m.sohu.com/a/122879394_355339/', 'http://wangdehua1938.lofter.com/post/322ed8_81faeda', '360 图片搜索“西安兴正元广场 外景”（大众点评/西部网配图）'],
    photos: [PHOTO + 'xingzhengyuan_1.jpg', PHOTO + 'xingzhengyuan_5.jpg', 'scratchpad/core_agent/img/xzy.jpg'],
    confidence: 'low',
    notes: '层数/高度无资料：按照片数层（临街约 5 层 × 4.6 m）→ 23 m；西北角圆柱体按照片高出约 1.5 层 → 30 m，位置/半径按卫星量取（±2 m）。'
      + '轮廓为整街区外包（含内街），内街玻璃顶与金色“风情街”拱门未建。',
  },
};

// ───────────── 9) 群光广场（现“华侨印象”改造中） ─────────────
// 轮廓 540b5a6d（OSM w1465147499）：L 形——南段 113 m 宽临东大街，北段沿东侧向北。照片 qunguang_1/2：浅米灰石材方盒子约 5 层，
// 中式回纹/方格镂空窗板 + 大幅广告框，西南转角石材体量阶梯式升高、顶部竖向短肋（Art-Deco），转角顶部“Chicony 群光广场”。
const QG_ST = { pattern: 'stoneWindows', tint: '#3a3f45', spd: '#d7d1c4', floorH: 5.4, colW: 6.5, spandrel: 0.62, mullW: 4.6, lit: 0.4 };
const qunguang = {
  id: 'qunguang',
  name: '群光广场',
  fp: '540b5a6d',
  parts: [
    { name: 'mall', fp: '540b5a6d', base: 0, top: 27, style: QG_ST, roof: { mech: true, parapet: 1.2 } },
    { name: 'corner1', pts: R(689.5, -76, 713, -53), base: 0, top: 31, style: { ...QG_ST, seed: 71 }, roof: { mech: false, parapet: 0.8 } },
    {
      name: 'corner2', pts: R(692.5, -73, 710, -56), base: 31, top: 34.5, // 阶梯式抬高的转角 + 竖向短肋
      style: { pattern: 'verticalFins', tint: '#b8b0a2', spd: '#d7d1c4', floorH: 3.5, colW: 1.1, spandrel: 0.1, mullW: 0.5, lit: 0.2 },
      roof: { mech: false, parapet: 0.6 },
    },
  ],
  signs: [
    { text: 'Chicony 群光广场', part: 'corner1', face: ['S', 'W'], y: 28.4, h: 1.9, color: '#8c8c8c' },
  ],
  supersede: { names: ['群光广场', '群光广场（西安）', '华侨印象'] },
  meta: {
    dossier: 'core_south.json#群光广场（西安）',
    sources: ['OSM w1465147499', 'http://m.sohu.com/a/198950712_348957/（2017 开业）', 'http://mbd.baidu.com/newspage/data/dtlandingsuper?nid=dt_4013353377786742567（闲置、2025 更名华侨印象改造）'],
    photos: [PHOTO + 'qunguang_1.jpg', PHOTO + 'qunguang_2.jpg'],
    confidence: 'low',
    notes: '层数/高度无资料：按照片数层（约 5 层，层高约 5.4 m）→ 27 m；西南转角阶梯两级 31 / 34.5 m 按照片比例。转角位置取东大街 × 端履门路口（西南角）。'
      + '2025-09 起改造为“华侨印象”，改造后外观未取得照片，仍按改造前建模。',
  },
};

// ───────────── 10) 宏府大厦（北大街） ─────────────
// 轮廓 0ea538d2（OSM w461320500，105×71 m）为商场裙房（1–5 层，层高 4.5/4.2×3/5.1 → 22.2 m，西安楼盘网）。
// 塔楼：照片 hongfu2_3（北大街二府街口）：浅粉米色石材、竖排金色“宏府大厦”，中部最高、两侧阶梯式跌落，顶部挑檐；
// 卫星 z19：阶梯形白色屋面 x −61..−2、z −876..−844（楼身向东倾），改正倾斜（约 −26, −8 m）后落在裙房东半部。
const HF_ST = { pattern: 'stoneWindows', tint: '#4e5a63', spd: '#cdb8a6', floorH: 3.4, colW: 1.9, spandrel: 0.46, mullW: 0.7, lit: 0.5 };
const hongfu = {
  id: 'hongfu',
  name: '宏府大厦',
  fp: '0ea538d2',
  parts: [
    { name: 'podium', fp: '0ea538d2', base: 0, top: 22.2, style: { pattern: 'stoneWindows', tint: '#3f4b55', spd: '#c9b3a1', floorH: 4.4, colW: 3.2, spandrel: 0.35, mullW: 1.2, lit: 0.7 }, roof: { mech: false } },
    { name: 'towerW', pts: R(-88, -884, -72, -853), base: 0, top: 54, style: { ...HF_ST, seed: 81 }, crown: [{ type: 'slab', ov: 1.0, h: 0.8, mat: '#d8c6b4' }] },
    { name: 'towerC', pts: R(-72, -886, -46, -851), base: 0, top: 77, style: HF_ST, crown: [{ type: 'slab', ov: 1.4, h: 1.0, mat: '#d8c6b4' }] },
    { name: 'towerE', pts: R(-46, -882, -28, -855), base: 0, top: 62, style: { ...HF_ST, seed: 82 }, crown: [{ type: 'slab', ov: 1.0, h: 0.8, mat: '#d8c6b4' }] },
    { name: 'towerE2', pts: R(-28, -878, -18, -859), base: 0, top: 46, style: { ...HF_ST, seed: 83 }, roof: { mech: false } },
  ],
  signs: [{ text: '宏府大厦', part: 'towerC', face: 'E', y: 60, h: 14, color: '#c9a646', vertical: true, serif: true }],
  supersede: { names: ['宏府大厦', '宏府大厦（北大街）', '宏府大厦(北大街)'] },
  meta: {
    dossier: 'core_south.json#宏府大厦（北大街）',
    sources: ['OSM w461320500', 'https://m.loupan.com/xa/loupan/31264/info（商场层高）', 'https://xa.anjuke.com/community/view/912721', 'Esri World Imagery z19'],
    photos: [PHOTO + 'hongfu2_3.jpg', PHOTO + 'hongfu_2.jpg'],
    confidence: 'low',
    notes: '裙房 22.2 m 为公布层高累加（有出处）。塔楼层数/高度无资料：按照片 hongfu2_3 以裙房 22.2 m 为标尺量取（中部约 77 m、两侧 62 / 54 m、最低一级 46 m，±10%）；'
      + '塔楼平面位置按卫星屋面减去倾斜位移（±6 m）。landmarks2026 的 100 m 无出处，被替代。',
  },
};

// ───────────── 11) 凯爱大厦（A 座）+ 工商银行大楼（西华门十字西北角，档案同条） ─────────────
// 卫星 z19：西华门十字西北角 b705ee59（约 30×31 m，OSM w1263374780）上方 (−17,−612) 处可见四坡“帽子”屋面，
// 屋面相对底座东偏约 31 m（= 83 m × 0.37，楼身倾斜），即深蓝玻璃 + 帽形塔顶的工行大楼；其北侧 1f231ec3 为凯爱大厦 A 座。
// 照片 baohua_3 左侧：深蓝玻璃塔身（竖向白色细肋、转角阶梯凹进），塔顶宽大灰白挑檐平板 + 曲面四坡帽顶 + 塔尖；约 5 层浅色石材裙房，两座拱形入口，“ICBC 中国工商银行”。
const KA_ST = { pattern: 'verticalFins', tint: '#1d2a3a', spd: '#c9ccd0', floorH: 3.6, colW: 3.2, spandrel: 0.06, mullW: 0.18, lit: 0.45 };
const kaiai = {
  id: 'kaiai',
  name: '凯爱大厦',
  center: [-48, -645],
  parts: [
    {
      name: 'podium', fp: 'b705ee59-1580-4012-946e-331162c58aea', grow: 3.5, base: 0, top: 21, // 工行裙房（照片：塔身两侧各伸出约 3.5 m）
      style: { pattern: 'stoneWindows', tint: '#3e4854', spd: '#d9d6cf', floorH: 4.2, colW: 3.0, spandrel: 0.5, mullW: 1.4, lit: 0.6 },
      roof: { mech: false, parapet: 1.0 },
    },
    { name: 'tower', fp: 'b705ee59-1580-4012-946e-331162c58aea', base: 0, top: 77.3, style: KA_ST, roof: { mech: false, parapet: 0.4 } },
    { name: 'hatSlab', kind: 'solid', fp: 'b705ee59-1580-4012-946e-331162c58aea', grow: 3.2, base: 77.3, top: 79.4, mat: '#d9d6cf' }, // 宽大挑檐平板
    {
      name: 'hat', shape: 'rect', size: [22, 22], at: [-48.3, -622.5], base: 79.4, top: 79.6, style: KA_ST, roof: { mech: false, parapet: 0.1 },
      crown: [{ type: 'cnhip', style: 'zanjian', ov: 1.5, h: 3.4, lift: 0.9, fascia: 0.3, mat: '#c9c7c0', eaveMat: '#b8b6b0', finialMat: 'metal' }, { type: 'spire', top: 93.2 }],
    },
    {
      name: 'blockA', fp: '1f231ec3', base: 0, top: 43.2, // 凯爱大厦 A 座：地上 12 层、标准层高 3.6 m（房天下）
      style: { pattern: 'stoneWindows', tint: '#34414d', spd: '#d4d0c6', floorH: 3.6, colW: 2.2, spandrel: 0.45, mullW: 0.8, lit: 0.5 },
    },
  ],
  signs: [
    { text: 'ICBC 中国工商银行', part: 'podium', face: ['S', 'E'], y: 17.5, h: 1.8, color: '#c7000b' },
    { text: 'ICBC 中国工商银行', part: 'hatSlab', face: ['S', 'E'], y: 76.2, h: 1.3, color: '#c7000b' },
  ],
  supersede: { names: ['凯爱大厦', '凯爱大厦-A座', '凯爱大厦B座', 'Isola del Nord 意大利餐厅'] },
  meta: {
    dossier: 'core_south.json#凯爱大厦',
    sources: ['https://gaoloumi.cc/forum.php?mod=viewthread&tid=3301142（网友实测：深蓝楼体 77.3 m、白色楼顶 83 m、塔尖 93.2 m）', 'https://xian.esf.fang.com/loupan/office/3610006277/housedetail.htm（地上 12 层、层高 3.6 m）', 'OSM w1263374780 / w1263372913', 'Esri World Imagery z19'],
    photos: [PHOTO + 'baohua_3.jpg（左侧插图）'],
    confidence: 'low（归属）；medium（形体）',
    notes: '档案【矛盾】的解决：卫星上帽形屋面对应西华门十字西北角 b705ee59（OSM 名“Isola del Nord 意大利餐厅”，为底层商户名），倾斜位移与 83 m 楼高一致 → 深蓝工行大楼建在 b705ee59；'
      + '“地上 12 层 × 3.6 m”取作北侧 A 座（1f231ec3）43.2 m。塔顶：挑檐平板 77.3–79.4 m、帽顶至约 83 m、塔尖 93.2 m（网友实测）。裙房 21 m 按照片比例（约 5 层）。',
  },
};

// ───────────── 12) 交通银行陕西省分行大楼 ─────────────
// 轮廓 12eda0bf（OSM w1465146391，42×39 m，OSM height=20 明显偏低）。照片 jiaohang_2：白色面砖方塔、竖向长窗条，
// 上部逐级退台收分，四角凸出角柱顶端各一小尖塔，正面顶部蓝色“交通银行”；左侧低层裙房。
const JH_ST = { pattern: 'stoneWindows', tint: '#3e5566', spd: '#e7e5df', floorH: 3.6, colW: 2.0, spandrel: 0.5, mullW: 0.75, lit: 0.5 };
const jiaohang = {
  id: 'jiaohang',
  name: '交通银行陕西省分行',
  fp: '12eda0bf',
  parts: [
    {
      name: 'tower', fp: '12eda0bf', base: 0, top: 74.4, style: JH_ST,
      setbacks: [{ at: 60, inset: 2.2 }, { at: 67.5, inset: 4.6 }],
      roof: { mech: false, parapet: 1.0 },
      crown: [{ type: 'masts', list: [[-12.5, 12.5], [12.5, 12.5], [12.5, -12.5], [-12.5, -12.5]], top: 78.5, r: 0.7, beacon: false }],
    },
    ...[[-17.6, 18.6], [17.6, 18.6], [17.6, -18.6], [-17.6, -18.6]].map(([e, n], i) => ({ // 四角凸出角柱（至第一道退台上方）
      name: 'pier' + i, kind: 'solid', shape: 'rect', size: [4.2, 4.2], at: [66.9 + e, -623.8 - n], base: 0, top: 64, mat: '#e3e1db',
    })),
  ],
  signs: [{ text: '交通银行', part: 'tower', face: ['S', 'W'], y: 71.5, h: 2.6, color: '#1a4d9c' }],
  supersede: { names: ['交通银行陕西省分行大楼', '交通银行', '交通银行陕西省分行'] },
  meta: {
    dossier: 'core_south.json#交通银行陕西省分行大楼',
    sources: ['https://gaoloumi.cc/forum.php?mod=viewthread&tid=3301142（网友实测：不含塔尖 74.4 m，含四角塔尖 78.5 m）', 'OSM w1465146391', 'http://www.huitu.com/photo/show/20190726/091408471070.html'],
    photos: [PHOTO + 'jiaohang_2.jpg'],
    confidence: 'medium',
    notes: '总高 74.4 m / 塔尖 78.5 m 为网友仰角实测（非官方）；两道退台位置 60 / 67.5 m 与内缩量按照片比例估计；角柱 4.2 m 见方按照片比例。',
  },
};

// ───────────── 13) 皇城大厦（西安皇城海航酒店） ─────────────
// 新城广场南侧。卫星 z19 + 照片对位：塔楼为南北向板楼 81e1e765（OSM w1465146778，54.5×21 m）——照片 huangcheng_0（西北方向夜景）
// 左窄面（北面 21 m，约 5 开间）右宽面（西面 54.5 m，约 12 开间）与之吻合；北侧 bbdc244e 为临广场的低层裙楼（歇山坡顶，照片 huangcheng_4）。
// 照片：白/浅灰面砖方窗网格，屋顶四角各一座外挑亭式平顶（夜间暖光），顶部白色“皇城海航酒店 HNA HOTEL DOWNTOWN XIAN”，科技馆照片背景可见红色“HNA 海航”。
const HC_ST = { pattern: 'stoneWindows', tint: '#5c6770', spd: '#e4e2dc', floorH: 4.1, colW: 2.3, spandrel: 0.46, mullW: 0.9, lit: 0.55 };
const huangcheng = {
  id: 'huangcheng',
  name: '皇城大厦',
  center: [705.4, -373.6],
  parts: [
    { name: 'tower', fp: '81e1e765-ae03-48bc-94c3-d7c3ba595aea', base: 0, top: 70.4, style: HC_ST, roof: { mech: false, parapet: 1.2 } },
    // 四角亭式平顶：小玻璃亭 + 外挑薄平顶（夜间暖光）
    ...[[698.4, -397.6], [707.4, -397.6], [698.4, -349.6], [705.8, -349.6]].map((at, i) => ({
      name: 'kiosk' + i, shape: 'rect', size: [6, 6], at, base: 70.4, top: 73.4,
      style: { pattern: 'curtain', tint: '#6a6a60', spd: '#e4e2dc', floorH: 3, colW: 1.5, spandrel: 0.1, mullW: 0.15, lit: 0.9 }, roof: { mech: false, parapet: 0.2 },
      crown: [{ type: 'slab', ov: 1.6, h: 0.7, mat: '#e8e6e0', glow: '#ffd08a' }],
    })),
    { name: 'deck', shape: 'rect', size: [12, 10], at: [705.4, -373.6], base: 70.4, top: 74.5, style: HC_ST, roof: { mech: false, parapet: 0.8 }, crown: [{ type: 'spire', top: 82.9 }] }, // 屋顶中部方形平台 + 塔尖
    {
      name: 'annex', fp: 'bbdc244e-6d19-4e23-9fff-35a511dd68ed', base: 0, top: 21, // 临新城广场裙楼（照片 huangcheng_4：约 5 层 + 灰色歇山坡顶）
      style: { pattern: 'stoneWindows', tint: '#4d5860', spd: '#d8d2c4', floorH: 4.2, colW: 2.6, spandrel: 0.45, mullW: 1.0, lit: 0.55 },
      crown: [{ type: 'cnhip', style: 'xieshan', ov: 1.6, h: 4.2, mat: TILE }],
    },
  ],
  signs: [
    { text: '皇城海航酒店', part: 'tower', face: ['N', 'W'], y: 67.2, h: 2.6, color: '#ffffff' },
    { text: 'HNA HOTEL DOWNTOWN XIAN', part: 'tower', face: ['N', 'W'], y: 64.9, h: 0.9, color: '#ffffff' },
    { text: 'HNA 海航', part: 'tower', face: 'E', y: 66.5, h: 3.0, color: '#d71920' },
  ],
  night: { outline: [{ part: 'tower', color: '#fff0d0', w: 0.3 }] },
  supersede: { names: ['皇城大厦', '皇城大厦（西安皇城海航酒店）', '西安皇城海航酒店', '皇城海航酒店'] },
  meta: {
    dossier: 'core_south.json#皇城大厦（西安皇城海航酒店）',
    sources: ['https://gaoloumi.cc/forum.php?mod=viewthread&tid=3301142（网友实测：屋顶 70.4 m、塔尖 82.9 m）', 'http://hotel.elong.com/xian/42701032/（16 层）', 'OSM w1465146778 / w1465146675', 'Esri World Imagery z19', 'https://commons.wikimedia.org/wiki/File:陕西科技馆2017.jpg（背景可见 HNA 塔楼与角亭）'],
    photos: [PHOTO + 'huangcheng_0.jpg', PHOTO + 'huangcheng_4.jpg', 'scratchpad/core_agent/img/kjg.jpg'],
    confidence: 'medium',
    notes: '档案 overture_id 为 null；按卫星（塔楼西立面可见、屋面东偏）+ 照片宽窄面比对位到 81e1e765。16 层 / 屋顶 70.4 m / 塔尖 82.9 m 有出处；'
      + '四角亭 6×6 m + 挑檐、中部平台 12×10 m 为照片比例估计。裙楼 21 m + 歇山顶按照片数层（约 5 层）。bbdc244e 以南的其余分体未建（保留通用建筑）。',
  },
};

// ───────────── 14) 陕西奥罗国际大酒店 ─────────────
// 轮廓 d5f6ad4f（OSM w1465146768，南北 38.7 × 东西 24.3 m）。卫星 z19：半圆形环状挑檐（放射肋）屋面在轮廓东侧约 27 m（= 74 m × 0.37 倾斜），
// 半圆弧朝北；照片 aoluo_1（新城广场一侧向南看）：前（北）部为半圆柱弧面体、竖排绿色“奥罗国际大酒店”，后（南）部方塔略高，顶部圆环挑台 + 高耸格构天线。
// → 档案“南侧半圆 / 北侧方形”与卫星、照片相反，按卫星与照片取北半圆、南方塔。
const AL_ST = { pattern: 'stoneWindows', tint: '#6f7f8a', spd: '#eadbd4', floorH: 3.7, colW: 2.0, spandrel: 0.46, mullW: 0.8, lit: 0.55 };
const aoluo = {
  id: 'aoluo',
  name: '陕西奥罗国际大酒店',
  fp: 'd5f6ad4f',
  parts: [
    { name: 'south', pts: R(593.4, -377.6, 617.3, -350.9), base: 0, top: 74.1, style: AL_ST, roof: { mech: true, parapet: 1.2 } },
    {
      name: 'round', shape: 'circle', size: [23.9, 23.9], at: [605.35, -377.65], base: 0, top: 70.5,
      style: { pattern: 'stoneWindows', tint: '#6f7f8a', spd: '#eadbd4', floorH: 3.7, colW: 1.6, spandrel: 0.42, mullW: 0.55, lit: 0.55, seed: 92 },
      roof: { mech: false, parapet: 0.6 },
      crown: [
        { type: 'disk', r: 14.5, h: 1.2, rimH: 0.8, mat: '#e8e2dc', y: 70.5 }, // 圆环挑台（卫星可见放射肋）
        { type: 'masts', y: 71.7, list: [[0, 0]], top: 104, r: 1.3 }, // 格构天线（高度按照片比例：约屋顶以上 0.45 倍楼高）
      ],
    },
  ],
  signs: [{ text: '奥罗国际大酒店', part: 'round', face: 'N', y: 50, h: 22, color: '#2f7a3a', vertical: true }],
  supersede: { names: ['陕西奥罗国际大酒店', '奥罗国际大酒店'] },
  site: ['d5f6ad4f-d048-4f13-843e-a594de9459b1'],
  meta: {
    dossier: 'core_south.json#陕西奥罗国际大酒店',
    sources: ['https://gaoloumi.cc/forum.php?mod=viewthread&tid=3301142（网友实测：半圆部分 70.5 m、方形部分 74.1 m）', 'https://hotels.ctrip.com/hotels/467389.html', 'OSM w1465146768', 'Esri World Imagery z19'],
    photos: [PHOTO + 'aoluo_1.jpg'],
    confidence: 'medium（高度）；low（天线）',
    notes: '半圆（70.5 m）/ 方塔（74.1 m）两个高度有出处（网友实测）；朝向按卫星圆环屋面与照片改为“北半圆、南方塔”。'
      + '天线高度无资料：按照片 aoluo_1 比例（屋顶以上约 0.45 倍楼高）估 104 m，低置信。半圆直径取轮廓宽 23.9 m。',
  },
};

// ───────────── 15) 西安人民剧院 ─────────────
// 轮廓 a1cae4b8（OSM w1465146725，70×38 m），西立面朝北大街。照片（Commons 西安人民剧院_01、档案 renminjuyuan_1）：
// 对称门厅立面——四根红色圆柱门廊 + 青绿彩画额枋，上方灰色石质山花（卷草浮雕、红五星、“人民剧院”金字），两侧实墙满覆爬山虎。
const rmjy = {
  id: 'renmin-juyuan',
  name: '西安人民剧院',
  fp: 'a1cae4b8',
  parts: [
    { name: 'hall', fp: 'a1cae4b8', base: 0, top: 15, style: { pattern: 'stoneWindows', tint: '#3d4540', spd: '#cfc6b3', floorH: 5, colW: 6, spandrel: 0.75, mullW: 5, lit: 0.3 }, roof: { mech: false } },
    { name: 'ivyN', kind: 'solid', pts: R(59.0, -405, 60.4, -393.8), base: 0, top: 13.5, mat: { color: '#3f6b35', roughness: 0.95 } }, // 两侧爬山虎墙面
    { name: 'ivyS', kind: 'solid', pts: R(59.0, -378.2, 60.4, -370), base: 0, top: 13.5, mat: { color: '#3f6b35', roughness: 0.95 } },
    { name: 'pediment', kind: 'solid', pts: R(57.5, -393.2, 60.3, -378.8), base: 11.5, top: 17.5, mat: '#b7b1a6' }, // 灰色石质山花
    { name: 'lintel', kind: 'solid', pts: R(56.5, -393.2, 60.3, -378.8), base: 9.8, top: 11.5, mat: { color: '#2f7d78', roughness: 0.6 } }, // 青绿彩画额枋
    ...[-391.5, -387.8, -384.2, -380.5].map((z, i) => ({ name: 'col' + i, kind: 'solid', shape: 'circle', size: [1.3, 1.3], at: [57.4, z], base: 0, top: 9.8, mat: '#b3261e' })),
  ],
  signs: [
    { text: '人民剧院', part: 'pediment', face: 'W', y: 13.2, h: 1.4, color: '#c9a646', serif: true },
    { text: '★', part: 'pediment', face: 'W', y: 15.9, h: 1.3, color: '#d7261e' },
  ],
  supersede: { names: ['西安人民剧院', '人民剧院'] },
  meta: {
    dossier: 'core_south.json#西安人民剧院',
    sources: ['https://commons.wikimedia.org/wiki/Category:Xi\'an_People\'s_Theater', 'OSM w1465146725'],
    photos: [PHOTO + 'renminjuyuan_1.jpg'],
    confidence: 'medium（立面）；low（高度）',
    notes: '高度无资料：按照片门廊比例（红柱约 9.8 m、额枋 + 山花至约 17.5 m），剧场主体保守取 15 m（后部观众厅/舞台体量未见照片，未加高）。'
      + '档案照片 renminjuyuan_3–5 为“西安话剧院 新城剧场”，非本楼，未采用。',
  },
};

// ───────────── 16) 西安易俗大剧院 ─────────────
// 轮廓 3a3fa33b（OSM w1465147194，68×52 m）。照片 yisu_0/1：石材高台基 + 四周一圈通高深红褐色花岗岩方柱柱廊（柱头间金色装饰板），
// 柱后黑色玻璃，上覆大出挑平缓金色四坡屋顶（檐口厚重平直）；正面约 10 开间。
const YS = { x0: 194.2, x1: 260.1, z0: -242.8, z1: -192.4 };
const yisuCols = [
  ...Array.from({ length: 11 }, (_, i) => [YS.x0 + ((YS.x1 - YS.x0) * i) / 10, YS.z1]), // 南
  ...Array.from({ length: 11 }, (_, i) => [YS.x0 + ((YS.x1 - YS.x0) * i) / 10, YS.z0]), // 北
  ...Array.from({ length: 7 }, (_, i) => [YS.x0, YS.z0 + ((YS.z1 - YS.z0) * (i + 1)) / 8]), // 西
  ...Array.from({ length: 7 }, (_, i) => [YS.x1, YS.z0 + ((YS.z1 - YS.z0) * (i + 1)) / 8]), // 东
];
const yisu = {
  id: 'yisu-dajuyuan',
  name: '西安易俗大剧院',
  fp: '3a3fa33b',
  parts: [
    { name: 'plinth', kind: 'solid', fp: '3a3fa33b', grow: 1.5, base: 0, top: 1.8, mat: 'granite' },
    {
      name: 'hall', pts: R(YS.x0 + 3, YS.z0 + 3, YS.x1 - 3, YS.z1 - 3), base: 1.8, top: 17.5,
      style: { pattern: 'curtain', tint: '#1e2226', spd: '#2a2c2e', floorH: 5.2, colW: 2.2, spandrel: 0.12, mullW: 0.12, lit: 0.55 },
      roof: { mech: false, parapet: 0.2 },
    },
    { name: 'frieze', kind: 'solid', pts: R(YS.x0 - 0.8, YS.z0 - 0.8, YS.x1 + 0.8, YS.z1 + 0.8), base: 15.4, top: 17.5, mat: { color: '#b89245', metalness: 0.5, roughness: 0.4 } }, // 柱头金色装饰板
    ...yisuCols.map((at, i) => ({ name: 'col' + i, kind: 'solid', shape: 'rect', size: [1.5, 1.5], at, base: 1.8, top: 15.4, mat: { color: '#7a3b2e', roughness: 0.55 } })),
    {
      name: 'roofBase', shape: 'rect', size: [YS.x1 - YS.x0 + 1.6, YS.z1 - YS.z0 + 1.6], at: [(YS.x0 + YS.x1) / 2, (YS.z0 + YS.z1) / 2], base: 17.5, top: 17.6,
      style: { pattern: 'curtain', tint: '#1e2226' }, roof: { mech: false, parapet: 0.05 },
      crown: [{ type: 'cnhip', style: 'wudian', ov: 3.4, h: 3.6, lift: 0.3, fascia: 2.4, mat: { color: '#c9a54a', metalness: 0.55, roughness: 0.35 }, eaveMat: { color: '#b8923e', metalness: 0.5, roughness: 0.4 }, ridgeMat: { color: '#a8843a', metalness: 0.5, roughness: 0.4 }, chiwei: false }],
    },
  ],
  night: { floodlight: [{ part: 'hall', color: '#ffc97a', strength: 0.4 }] },
  supersede: { names: ['西安易俗大剧院', '易俗大剧院'] },
  meta: {
    dossier: 'core_south.json#西安易俗大剧院',
    sources: ['https://baike.so.com/doc/24714265-25619872.html（1993 落成、2002 重装）', 'OSM w1465147194', 'http://landscape.tuchong.com/69785454/'],
    photos: [PHOTO + 'yisu_0.jpg', PHOTO + 'yisu_1.jpg'],
    confidence: 'medium（形体）；low（高度）',
    notes: '高度无资料：按照片 yisu_0 比例（台基 1.8 m、柱廊约 13.6 m、金色装饰板 2 m、檐口 2.4 m、屋面坡高 3.6 m → 约 23.5 m）。'
      + '正面 10 开间（11 根柱）按照片；入口朝向档案待核实，未建大台阶。',
  },
};

// ───────────── 17) 陕西省人民政府办公大楼（新城大院） ─────────────
// 主楼 f85d1586（OSM w1465146336，180×21 m 长板楼 + 南侧门廊 + 北侧凸出），两翼 777661b5 / 0bb7f403（各约 52×38 m）。
// 照片 shengzhengfu_4/5（新城广场一侧）：约 12 层米黄面砖竖向窗网格，顶部通长橙褐色挑檐；屋顶东西两端各一座两层重檐庑殿式楼阁（橙褐屋面）；
// 两端约 6 层翼楼同样橙褐檐口；首层中部白色方柱门廊。
const SZF_ST = { pattern: 'stoneWindows', tint: '#4a4f55', spd: '#d8c59e', floorH: 3.6, colW: 2.0, spandrel: 0.46, mullW: 0.8, lit: 0.45 };
const TERRA = { color: '#b0561f', roughness: 0.8 }; // 橙褐色琉璃瓦（档案 frame_color_hex #b85a1e）
const shengzhengfu = {
  id: 'shaanxi-gov',
  name: '陕西省人民政府',
  fp: 'f85d1586',
  parts: [
    // 主楼板楼（轮廓 f85d1586 去掉南侧门廊凸出）；北侧小凸出为楼梯/核心筒，同高
    { name: 'main', pts: R(571.5, -686.7, 752.1, -664.6), base: 0, top: 43.2, style: SZF_ST, roof: { mech: false, parapet: 0.3 }, crown: [{ type: 'eave', ov: 1.8, depth: 2.4, h: 1.3, mat: TERRA }] },
    { name: 'core', pts: R(653, -696.3, 670.7, -686.5), base: 0, top: 43.2, style: { ...SZF_ST, seed: 104 }, roof: { mech: false, parapet: 0.3 } },
    ...[['pavW', 597], ['pavE', 727]].flatMap(([name, x]) => [
      { name, shape: 'rect', size: [26, 15], at: [x, -675.4], base: 43.2, top: 47.4, style: { ...SZF_ST, seed: 101 }, roof: { mech: false, parapet: 0.2 }, crown: [{ type: 'eave', ov: 2.0, depth: 3.0, h: 1.4, mat: TERRA }] },
      { name: name + 'Top', shape: 'rect', size: [18, 9.5], at: [x, -675.4], base: 47.4, top: 50.8, style: { ...SZF_ST, floorH: 3.4, seed: 102 }, crown: [{ type: 'cnhip', style: 'wudian', ov: 2.2, h: 4.6, mat: TERRA }] },
    ]),
    ...[['wingW', '777661b5-35a0-4437-abe2-a5eef7dc9f46'], ['wingE', '0bb7f403-7d85-4970-a4ea-bba23e51eaee']].map(([name, fp]) => ({ name, fp, base: 0, top: 21.6, style: { ...SZF_ST, seed: 103 }, roof: { mech: false, parapet: 0.3 }, crown: [{ type: 'eave', ov: 1.5, depth: 2.2, h: 1.2, mat: TERRA }] })),
    {
      name: 'portico', pts: R(634.4, -664.8, 688.4, -647.8), base: 0, top: 9.5, // 轮廓南侧凸出 = 朝新城广场的白色方柱门廊
      style: { pattern: 'stoneLit', tint: '#3a3f44', spd: '#f0ede6', floorH: 9.5, colW: 3.4, spandrel: 0.08, mullW: 1.3, lit: 0.6 },
      roof: { mech: false, parapet: 0.6 }, crown: [{ type: 'eave', ov: 1.0, depth: 1.5, h: 0.8, mat: TERRA }],
    },
  ],
  supersede: { names: ['陕西省人民政府', '陕西省人民政府办公大楼（新城大院）', '陕西省人民政府（新城大院办公楼）'] },
  meta: {
    dossier: 'core_south.json#陕西省人民政府办公大楼（新城大院）；public.json#陕西省人民政府（新城大院办公楼）',
    sources: ['OSM w1465146336 / w1465146326 / w1465146332', 'https://commons.wikimedia.org/wiki/Category:Shaanxi_Provincial_People\'s_Government'],
    photos: [PHOTO + 'shengzhengfu_4.jpg', PHOTO + 'shengzhengfu_5.jpg', PHOTO + 'shengzhengfu_1.jpg'],
    confidence: 'medium',
    notes: '高度无资料：主楼按照片数层（约 12 层 × 3.6 m）→ 43.2 m + 橙褐挑檐；两翼约 6 层 → 21.6 m（public.json 记 11 层，照片为 12 层窗）。轮廓南侧 54×17 m 凸出为门廊（9.5 m）。'
      + '屋顶楼阁（下层 26×15 m、上层 18×9.5 m + 庑殿顶，屋脊约 57 m）位置与尺寸按照片比例；档案提到的楼阁顶格构铁塔在 shengzhengfu_4 正面照中不可见（shengzhengfu_5 中疑为远处铁塔），未建。'
      + '北侧 1927 年“新城黄楼”由 heritage26 模块负责。',
  },
};

// ───────────── 18) 西安人民大厦 ─────────────
// 轮廓 49de22f5（OSM w1465146316，105×14 m 主楼 + 中部圆形凸出）。照片 renmindasha_4/5：约 7 层苏式古典对称长楼，浅灰米色，规则竖窗、檐口线脚；
// 中央为多层叠落的圆形鼓座 + 柱廊 + 穹顶，顶部旗杆。（landmarks2026 heritage 的同名条目由 heritage26 按排除区自动让位）
const RM_ST = { pattern: 'stoneWindows', tint: '#4f5a60', spd: '#d9d2c0', floorH: 3.8, colW: 2.2, spandrel: 0.46, mullW: 0.85, lit: 0.55 };
const RMX = 1084.2, RMZ = -665.5;
const renmindasha = {
  id: 'renmin-dasha',
  name: '西安人民大厦',
  fp: '49de22f5',
  parts: [
    { name: 'main', fp: '49de22f5', base: 0, top: 26.6, style: RM_ST, roof: { mech: false, parapet: 1.1 } },
    { name: 'core', shape: 'circle', size: [17, 17], at: [RMX, RMZ], base: 0, top: 30.4, style: { ...RM_ST, seed: 111 }, roof: { mech: false, parapet: 0.8 } },
    { name: 'drum1', shape: 'circle', size: [13, 13], at: [RMX, RMZ], base: 30.4, top: 35.2, style: { pattern: 'verticalFins', tint: '#3a4046', spd: '#e2dccd', floorH: 4.8, colW: 1.7, spandrel: 0.1, mullW: 0.75, lit: 0.5 }, roof: { mech: false, parapet: 0.6 } },
    {
      name: 'drum2', shape: 'circle', size: [9.4, 9.4], at: [RMX, RMZ], base: 35.2, top: 38.2, style: { ...RM_ST, floorH: 3, colW: 1.5, seed: 112 }, roof: { mech: false, parapet: 0.3 },
      crown: [{ type: 'dome', r: 4.7, h: 4.0, mat: '#cfc8b6', ring: false }, { type: 'spire', top: 48.5 }], // 穹顶 + 旗杆
    },
  ],
  supersede: { names: ['西安人民大厦', '西安豪华美居人民大厦', '索菲特人民大厦'] },
  meta: {
    dossier: 'core_south.json#西安人民大厦',
    sources: ['OSM w1465146316', 'http://map.baidu.com/place/56f2f696f911bdfd0aa8d4c9', 'https://finance.sina.com.cn/jjxw/2025-06-19/doc-infaqeru5279752.shtml'],
    photos: [PHOTO + 'renmindasha_4.jpg', PHOTO + 'renmindasha_5.jpg'],
    confidence: 'low（高度）；medium（构图）',
    notes: '高度无资料：按照片数层（两翼约 7 层 × 3.8 m）→ 26.6 m；中央圆体高出一层（30.4 m）→ 柱廊鼓座 35.2 m → 小鼓座 38.2 m → 穹顶约 42 m → 旗杆 48.5 m，均按照片比例。'
      + '中央圆体直径 17 m 取 OSM 轮廓中部凸出弧段外推。东楼（索菲特）等附属楼不在轮廓内，未建。',
  },
};

// ───────────── 19) 西安富力希尔顿酒店 ─────────────
// 轮廓 9c639c24（OSM w1465146444，东西 70.5 × 南北 89.6 m）。照片 hilton_fuli_0/1：约 10 层方正板式体量，深褐色石材竖向通高壁柱 + 玻璃窗，
// 顶部大出挑平屋檐（檐下密布短椽/格栅，夜间檐口下沿连续灯带），檐上白色“Hilton”；南侧入口玻璃金属大雨棚。
const hilton = {
  id: 'hilton-fuli',
  name: '西安富力希尔顿酒店',
  fp: '9c639c24',
  parts: [
    {
      name: 'body', fp: '9c639c24', base: 0, top: 36,
      style: { pattern: 'verticalFins', tint: '#3b3a36', spd: '#6f5d4b', floorH: 3.6, colW: 2.6, spandrel: 0.24, mullW: 0.95, lit: 0.6 },
      roof: { mech: false, parapet: 0.3 },
      crown: [{ type: 'slab', ov: 3.2, h: 1.4, mat: '#5a4a3c', glow: '#ffd08a' }],
    },
    { name: 'canopy', kind: 'solid', shape: 'rect', size: [28, 9], at: [1779, -566.5], base: 6.2, top: 7.1, mat: { color: '#3a3a38', metalness: 0.5, roughness: 0.4 } },
  ],
  signs: [
    { text: 'Hilton', part: 'body', face: ['W', 'S'], y: 39.4, h: 2.3, color: '#ffffff' },
    { text: '西安富力希尔顿酒店', part: 'canopy', face: 'S', y: 7.9, h: 0.9, color: '#ffffff' },
  ],
  night: { floodlight: [{ part: 'body', color: '#ffd9a0', strength: 0.45 }] }, // 壁柱暖白洗墙
  supersede: { names: ['西安富力希尔顿酒店', '希尔顿酒店', 'Hilton Xi\'an'] },
  meta: {
    dossier: 'core_south.json#西安富力希尔顿酒店',
    sources: ['OSM w1465146444', 'https://hotels.ctrip.com/hotel/371197.html', 'http://www.rfchina.com/mobile/product.aspx/product.aspx?pid=1048&type=15（309 间）'],
    photos: [PHOTO + 'hilton_fuli_0.jpg', PHOTO + 'hilton_fuli_1.jpg', PHOTO + 'hilton_fuli_2.jpg'],
    confidence: 'medium（形体）；low（高度）',
    notes: '层数/高度无资料：按照片数层（约 10 层 × 3.6 m）→ 36 m + 挑檐 1.4 m（外挑 3.2 m 按照片比例）。雨棚 28×9 m 按照片比例。',
  },
};

// ───────────── 20) 陕西科学技术馆（新城广场老馆） ─────────────
// 轮廓 c28be48e（OSM w1465146493，东西 55 × 南北 19 m）。照片 Commons“陕西科技馆2017”（北侧看南，右侧背景为皇城海航塔楼）：
// 白色面砖横向带窗长楼（约 8 层），西端塔楼（蓝色玻璃竖带）高出 3–4 层，顶部白色阶梯收头 + 红色“陕西科技馆”，最上为白色帆形尖顶。
const kejiguan = {
  id: 'kejiguan',
  name: '陕西科学技术馆',
  fp: 'c28be48e',
  parts: [
    { name: 'slab', fp: 'c28be48e', base: 0, top: 30, style: { pattern: 'horizontalBands', tint: '#4d6f8c', spd: '#eeeeea', floorH: 3.6, colW: 3, spandrel: 0.5, mullW: 0.05, lit: 0.5 }, roof: { mech: true, parapet: 1.0 } },
    { name: 'tower', pts: R(823.5, -505, 841, -486.3), base: 0, top: 44, style: { pattern: 'grid', tint: '#4d6f8c', spd: '#eeeeea', floorH: 3.6, colW: 1.6, spandrel: 0.3, mullW: 0.25, lit: 0.5 }, roof: { mech: false, parapet: 0.8 } },
    { name: 'towerTop', pts: R(826, -502.8, 838.5, -488.5), base: 44, top: 47.6, style: { pattern: 'stoneWindows', tint: '#4d6f8c', spd: '#f0f0ec', floorH: 3.6, colW: 1.8, spandrel: 0.45, mullW: 0.9, lit: 0.4 }, roof: { mech: false, parapet: 0.2 }, crown: [{ type: 'slab', ov: 0.9, h: 0.8, mat: '#f0f0ec' }] },
    { name: 'fin', shape: 'rect', size: [3.4, 3.4], at: [832.2, -495.6], base: 48.4, top: 48.6, style: { pattern: 'curtain', tint: '#f0f0ec' }, roof: { mech: false, parapet: 0.05 }, crown: [{ type: 'pyramid', inset: 0, h: 11.5, mat: '#f2f2ee' }] },
  ],
  signs: [{ text: '陕西科技馆', part: 'tower', face: 'N', y: 41.4, h: 2.4, color: '#d7261e' }],
  supersede: { names: ['陕西科学技术馆（新城广场馆）', '陕西科学技术馆（新城广场老馆）', '陕西科技馆', '陕西科学技术馆'] },
  meta: {
    dossier: 'core_south.json#陕西科学技术馆（新城广场馆）；public.json#陕西科学技术馆（新城广场老馆）',
    sources: ['https://commons.wikimedia.org/wiki/File:陕西科技馆2017.jpg', 'https://m.wenda.so.com/q/1532229195210212（1988 建成、9700 m²）', 'OSM w1465146493'],
    photos: ['scratchpad/core_agent/img/kjg.jpg（Commons 陕西科技馆2017）', PHOTO + 'kejiguan_3.jpg'],
    confidence: 'low（高度）；medium（形体）',
    notes: '“馆内共四层”指展厅层（层高大）；照片外立面可数约 8 道横向带窗 → 长楼 30 m（首层约 5 m + 7 × 3.6 m）；西端塔楼按照片高出约 4 层 → 44 m，'
      + '阶梯收头至约 48.4 m，帆形尖顶约 11.5 m（顶约 60 m），均按照片比例。塔楼位于西端（照片右侧、与背景皇城海航塔楼方位一致）。',
  },
};

// ───────────── 21) 民生百货（解放路店）/ 民生·JF103 ─────────────
// 轮廓 cf1cc837（OSM w1465146213，103×118 m），五路口东南。照片 minsheng_3 / minsheng2_2：米黄石材，西北转角为圆弧形通高玻璃幕墙 + 大玻璃雨棚，
// 转角顶部紫色“MINSUN 民生”；楼层导览图至 L5（圆角平面）。
const minsheng = {
  id: 'minsheng',
  name: '民生百货',
  fp: 'cf1cc837',
  parts: [
    { name: 'store', fp: 'cf1cc837', roundCorners: 6, base: 0, top: 30, style: { pattern: 'stoneWindows', tint: '#3e4a55', spd: '#dccfb6', floorH: 5.0, colW: 3.4, spandrel: 0.55, mullW: 1.6, lit: 0.55 }, roof: { mech: true, parapet: 1.2 } },
    { name: 'corner', shape: 'circle', size: [24, 24], at: [1505, -832], base: 0, top: 29, style: { pattern: 'curtain', tint: '#3f6f73', spd: '#d0d6d6', floorH: 5.0, colW: 1.8, spandrel: 0.12, mullW: 0.1, lit: 0.7 }, roof: { mech: false, parapet: 1.4 } },
    { name: 'canopy', kind: 'solid', shape: 'circle', size: [30, 30], at: [1505, -832], base: 7.2, top: 7.8, mat: { color: '#9fb4c2', metalness: 0.6, roughness: 0.2 } },
  ],
  signs: [{ text: 'MINSUN 民生', part: 'corner', face: 'NW', y: 26.6, h: 2.4, color: '#7a3b8f' }],
  supersede: { names: ['民生百货（解放路店）/ 民生·JF103', '西安民生百货(解放路店)', '民生百货', '民生·JF103'] },
  meta: {
    dossier: 'core_south.json#民生百货（解放路店）/ 民生·JF103',
    sources: ['OSM w1465146213', 'https://finance.sina.com.cn/jjxw/2025-02-17/doc-inekuruf6832393.shtml（2025-02 闭店改造）', 'http://m.winshang.com/news735906.html'],
    photos: [PHOTO + 'minsheng_3.jpg', PHOTO + 'minsheng2_2.jpg'],
    confidence: 'low',
    notes: '高度无资料：按照片数层（约 6 层 × 5 m）→ 30 m。转角玻璃圆弧体直径 24 m、雨棚为照片比例；转角取西北（地铁五路口站东南口、正对路口）。'
      + '2025 年改造为“民生·JF103”，改造后外立面未取得照片，按改造前建模。',
  },
};

// ───────────── 22) 万达广场（西安民乐园店） ─────────────
// 轮廓 59f97ca8（OSM r20056724，131×194 m）。照片 wanda_mly_0/1/4/5：浅灰金属板 + 玻璃大盒子，主入口为通高玻璃幕墙中庭（夜间通透），
// 顶部红黄色“万达广场 WANDA PLAZA”；卫星 z19：西侧（解放路）一条白色弧形屋面、东北角一座白色圆穹。
const wandaMly = {
  id: 'wanda-minleyuan',
  name: '万达广场（民乐园店）',
  fp: '59f97ca8',
  parts: [
    {
      name: 'mall', fp: '59f97ca8', base: 0, top: 28,
      style: { pattern: 'stoneWindows', tint: '#3a4650', spd: '#c9ccd0', floorH: 5.6, colW: 4.5, spandrel: 0.62, mullW: 3.2, lit: 0.6 },
      roof: { mech: true, parapet: 1.2 },
      crown: [{ type: 'dome', at: [1640, -1045], r: 8, h: 4, mat: '#e2e4e6' }, { type: 'arch', at: [1548, -905], size: [62, 26], rot: 90, h: 4.5, mat: '#dfe2e4' }],
    },
    { name: 'atrium', pts: R(1521.5, -935, 1540, -873), base: 0, top: 30, style: { pattern: 'curtain', tint: '#5d7584', spd: '#c9d2d8', floorH: 5, colW: 3.0, spandrel: 0.05, mullW: 0.18, lit: 0.95 }, roof: { mech: false, parapet: 0.8 } },
  ],
  signs: [
    { text: '万达广场', part: 'atrium', face: 'W', y: 31.6, h: 3.4, color: '#f1c24c' },
    { text: 'WANDA PLAZA', part: 'atrium', face: 'W', y: 29.3, h: 1.0, color: '#f1c24c' },
  ],
  supersede: { names: ['万达广场（西安民乐园店）', '万达广场(西安民乐园店)', '民乐园万达广场'] },
  meta: {
    dossier: 'core_south.json#万达广场（西安民乐园店）',
    sources: ['OSM r20056724', 'http://www.wanda.cn/2009/2009headlines_1219/4224.html', 'http://www.nipic.com/detail/huitu/20140805/002439411200.html', 'Esri World Imagery z19'],
    photos: [PHOTO + 'wanda_mly_4.jpg', PHOTO + 'wanda_mly_0.jpg', PHOTO + 'wanda_mly_5.jpg'],
    confidence: 'low',
    notes: '高度无资料：按照片数层（约 5 层 × 5.6 m）→ 28 m，玻璃中庭 30 m。玻璃中庭位置取西立面（解放路）、弧形屋面与东北角圆穹按卫星量取（±3 m）。'
      + '项目内公寓/住宅塔楼不在本轮廓内，未建。',
  },
};

// ───────────── 23) 西安悦荟广场（MOSAIC） ─────────────
// 轮廓 94eff4d9（OSM w1465146733，东西 100 × 南北 130 m），东新街与解放路十字东南角，西北转角切角。地上 8 层（资料）。
// 照片 yuehui_1/3/4：方正大盒子，深色（或银白）穿孔金属外皮上满布圆点“像素”，多块 LED 大屏，首层通透；顶部两侧角部青绿色“悦荟 MOSAIC”。
const yuehui = {
  id: 'yuehui',
  name: '西安悦荟广场',
  fp: '94eff4d9',
  parts: [
    { name: 'box', fp: '94eff4d9', base: 0, top: 38, style: { pattern: 'stoneWindows', tint: '#2e3a44', spd: '#34383e', floorH: 1.6, colW: 1.4, spandrel: 0.72, mullW: 1.1, lit: 0.55 }, roof: { mech: true, parapet: 1.2 } },
    { name: 'ground', kind: 'facade', fp: '94eff4d9', grow: 0.2, base: 0, top: 7, style: { pattern: 'retail', tint: '#2e3a44', spd: '#9aa0a6', floorH: 7, colW: 3.5, spandrel: 0.1, lit: 0.95 } },
  ],
  signs: [
    { text: '悦荟 MOSAIC', part: 'box', face: 'N', near: 'W', y: 35, h: 3, color: '#35d0c0' },
    { text: '悦荟 MOSAIC', part: 'box', face: 'W', near: 'N', y: 35, h: 3, color: '#35d0c0' },
  ],
  night: { media: [{ part: 'box', face: 'N', from: 12, to: 24, width: 22, shift: 18 }, { part: 'box', face: 'W', from: 14, to: 26, width: 18, shift: -25 }] },
  supersede: { names: ['西安悦荟广场（MOSAIC）', '西安悦荟广场(解放路)', '西安悦荟广场', '悦荟广场'] },
  meta: {
    dossier: 'core_south.json#西安悦荟广场（MOSAIC）',
    sources: ['OSM w1465146733', 'http://m.sohu.com/a/255362882_532418', 'https://xian.focus.cn/zixun/f60f30518fae007b.html（地上 8 层、地下 3 层）'],
    photos: [PHOTO + 'yuehui_1.jpg', PHOTO + 'yuehui_3.jpg', PHOTO + 'yuehui_4.jpg'],
    confidence: 'medium',
    notes: '地上 8 层有出处；层高无资料 → 首层约 7 m + 7 × 4.4 m ≈ 38 m（按照片比例）。圆点像素外皮用密集小窗洞近似（夜间亮点）；LED 屏位置按照片 yuehui_1。',
  },
};

// ───────────── 24) 陕西省中医医院 ─────────────
// 轮廓 75fd3a44（OSM w1263103970，Overture 名“住院楼”）。照片 zhongyi_0/2/4/5 与 Commons 陕西省中医医院_01：门诊楼约 5 层浅灰面砖，
// 中部通高蓝灰玻璃幕墙竖带 + 玻璃雨棚入口，屋顶红色“陕西省中医医院”，左侧竖排红字“门诊 Clinic”。（zhongyi_1 为带塔顶的新楼效果图，未建成，不采用）
const ZY_ST = { pattern: 'stoneWindows', tint: '#50606c', spd: '#d9d6cf', floorH: 4.0, colW: 2.4, spandrel: 0.45, mullW: 0.9, lit: 0.6 };
const zhongyi = {
  id: 'shaanxi-tcm-hospital',
  name: '陕西省中医医院',
  fp: '75fd3a44',
  parts: [
    // 轮廓按卫星拆成三块：东侧东西向条楼（门诊楼，5 层）、中部南北向高层（住院楼，卫星上西立面可见、北侧长影）、西端附楼
    { name: 'clinic', pts: R(-214, -466.5, -126.4, -441.6), base: 0, top: 20, style: ZY_ST, roof: { mech: true, parapet: 1.2 } },
    { name: 'glassBand', pts: R(-176, -442.6, -164, -441.2), base: 0, top: 20.5, style: { pattern: 'curtain', tint: '#50606c', spd: '#9aa4ab', floorH: 4.0, colW: 1.5, spandrel: 0.1, mullW: 0.12, lit: 0.6 }, roof: { mech: false, parapet: 0.3 } },
    { name: 'ward', pts: R(-239, -514, -214, -441.5), base: 0, top: 40, style: { ...ZY_ST, spd: '#d9cfbd', floorH: 3.8, seed: 131 }, roof: { mech: true, parapet: 1.2 } },
    { name: 'west', pts: R(-269.5, -512.5, -239, -491.8), base: 0, top: 20, style: { ...ZY_ST, seed: 132 }, roof: { mech: false, parapet: 1.0 } },
  ],
  signs: [
    { text: '陕西省中医医院', part: 'clinic', face: 'S', y: 22.6, h: 2.8, color: '#d7261e' },
    { text: '门诊', part: 'clinic', face: 'S', near: 'W', y: 13, h: 5, color: '#d7261e', vertical: true },
  ],
  supersede: { names: ['陕西省中医医院', '住院楼'] },
  meta: {
    dossier: 'core_south.json#陕西省中医医院；public.json#陕西省中医医院',
    sources: ['https://commons.wikimedia.org/wiki/Category:Hospitals_in_Xi\'an', 'OSM w1263103970'],
    photos: [PHOTO + 'zhongyi_0.jpg', PHOTO + 'zhongyi_2.jpg', 'scratchpad/core_agent/img/zy1.jpg'],
    confidence: 'low',
    notes: '门诊楼按照片数层（约 5 层 × 4 m）→ 20 m；住院楼按档案“约 10 层”（照片计数）× 3.8 m + 女儿墙 → 40 m，位置按卫星（轮廓中部南北向高层：西立面可见、北侧长影）。'
      + '轮廓拆分与门诊楼朝南为卫星推断，低置信；西端附楼无资料，按 5 层 20 m。',
  },
};

// ───────────── 25) 西安市中心医院（西五路院区） ─────────────
// 主楼 dfec9343（OSM w1465144409，南北 53 × 东西 29 m）+ 东南裙楼 bb6f1842。照片 Commons 西安市中心医院_2023-09-28：
// 板楼一端为半圆形凸出端头（白色面砖与蓝色玻璃横向带窗交替），顶部红色“西安市中心医院”；前方约 5 层白色裙楼（绿色窗框、转角圆弧）。
const zhongxin = {
  id: 'xian-central-hospital',
  name: '西安市中心医院',
  fp: 'dfec9343',
  parts: [
    { name: 'main', fp: 'dfec9343', base: 0, top: 45.5, style: { pattern: 'stoneWindows', tint: '#5d7fa6', spd: '#e2ddd2', floorH: 3.5, colW: 2.0, spandrel: 0.45, mullW: 0.8, lit: 0.55 }, roof: { mech: true, parapet: 1.2 } },
    { name: 'roundEnd', shape: 'circle', size: [29, 29], at: [56.3, -1452.5], base: 0, top: 45.5, style: { pattern: 'horizontalBands', tint: '#3f6fa8', spd: '#ecebe6', floorH: 3.5, colW: 3, spandrel: 0.45, mullW: 0.05, lit: 0.55 }, roof: { mech: false, parapet: 1.2 } },
    { name: 'annex', fp: 'bb6f1842', roundCorners: 5, base: 0, top: 18.5, style: { pattern: 'stoneWindows', tint: '#3f6b4a', spd: '#ecebe6', floorH: 3.7, colW: 2.2, spandrel: 0.45, mullW: 0.9, lit: 0.55 }, roof: { mech: false, parapet: 1.0 } },
  ],
  signs: [
    { text: '西安市中心医院', part: 'main', face: ['E', 'S'], y: 47.8, h: 2.6, color: '#d0262b' },
    { text: '西安交通大学附属西安市中心医院', part: 'roundEnd', face: 'SE', y: 30, h: 26, color: '#b3261e', vertical: true },
  ],
  supersede: { names: ['西安市中心医院（西安交通大学附属西安市中心医院）', '西安市中心医院（西五路院区）', '西安市中心医院'] },
  meta: {
    dossier: 'core_south.json#西安市中心医院；public.json#西安市中心医院（西五路院区）',
    sources: ['https://commons.wikimedia.org/wiki/File:西安市中心医院_2023-09-28.jpg', 'OSM w1465144409 / w1465144644'],
    photos: ['scratchpad/core_agent/img/zxyy.jpg（Commons 2023-09-28）'],
    confidence: 'low',
    notes: '两份档案层数不一（约 11 层 / 约 15–16 层）；本次按同一照片重新数层：圆端约 13 道带窗 → 13 层 × 3.5 m = 45.5 m。'
      + '半圆端头取主楼南端（照片中位于左侧、裙楼在右前）；OSM 轮廓为矩形，半圆端按轮廓宽 29 m 外加。裙楼按照片 5 层 → 18.5 m。',
  },
};

// ───────────── 26) 华侨城·长安国际中心（含王府井百货永宁门店） ─────────────
// 裙楼 3786683c（OSM w391322276，83×126 m）+ 2×2 四座玻璃塔楼（OSM 分体 863b36ab 西北 / 87701acc 东北 / a873ff83 西南 / 3bccb574 东南）。
// 照片 changan_gj_0/2/3：深蓝灰反射玻璃方塔，北侧两座较低（顶挂“HSBC 汇丰”“BEA 东亚银行”），南侧较高，最高一座顶挂“华侨城·长安国际”；裙楼玻璃 + 石材（王府井百货）。
const CA_ST = { pattern: 'curtain', tint: '#3a5570', spd: '#8a9aa6', floorH: 4.2, colW: 1.5, spandrel: 0.2, mullW: 0.1, lit: 0.5 };
const changan = {
  id: 'changan-guoji',
  name: '华侨城·长安国际中心',
  fp: '3786683c',
  parts: [
    { name: 'podium', fp: '3786683c', base: 0, top: 24, style: { pattern: 'retail', tint: '#3a4650', spd: '#b9b1a3', floorH: 6, colW: 3.0, spandrel: 0.25, lit: 0.9 }, roof: { mech: false } },
    { name: 'towerNW', fp: '863b36ab', base: 0, top: 54.6, style: { ...CA_ST, seed: 121 } },
    { name: 'towerNE', fp: '87701acc', base: 0, top: 54.6, style: { ...CA_ST, seed: 122 } },
    { name: 'towerSW', fp: 'a873ff83', base: 0, top: 54.6, style: { ...CA_ST, seed: 123 } },
    { name: 'towerSE', fp: '3bccb574', base: 0, top: 54.6, style: { ...CA_ST, seed: 124 } },
  ],
  signs: [
    { text: 'CAKG', part: 'towerNW', face: 'N', y: 51.8, h: 2.6, color: '#ffffff' }, // 照片 changan_gj_2（北立面）
    { text: '长安控股', part: 'towerNE', face: 'N', y: 51.8, h: 2.6, color: '#ffffff' },
    { text: 'HSBC 汇丰', part: 'towerNW', face: 'W', y: 51.8, h: 2.6, color: '#db0011' }, // 照片 changan_gj_0（西立面：左 HSBC、右 BEA）
    { text: 'BEA 东亚银行', part: 'towerSW', face: 'W', y: 51.8, h: 2.2, color: '#c8102e' },
    { text: '王府井百货', part: 'podium', face: 'E', y: 18, h: 2.6, color: '#8a6a3a', serif: true },
  ],
  supersede: { names: ['华侨城·长安国际中心（含王府井百货永宁门店）', '王府井百货(永宁门店)', '西安王府井百货(永宁门店)'] },
  meta: {
    dossier: 'core_south.json#华侨城·长安国际中心（含王府井百货永宁门店）',
    sources: ['OSM w391322276 / w1284311033 / w1284310733 / w1284311171 / w1284311095', 'http://www.163.com/dy/article/FCDBFTQQ0517NTNF.html（总层高 22 层）', 'https://www.yxdc.top/xa/xzl_28217'],
    photos: [PHOTO + 'changan_gj_0.jpg', PHOTO + 'changan_gj_2.jpg', PHOTO + 'changan_gj_3.jpg'],
    confidence: 'medium',
    notes: '四塔均约 13 层：照片 changan_gj_2（城墙上向南正拍）前两塔可数约 13 层（含 3–4 层商业裙楼），卫星 z19 四塔屋面倾斜位移 20–22 m ÷ 0.38 m/m ≈ 54–57 m，互证 → 13 × 4.2 m = 54.6 m。'
      + '档案“总层高 22 层”与照片中四塔之间后方居中的高塔（顶挂“华侨城·长安国际”）对应——它不在 2×2 四塔之内（位于组团以南），不在本轮廓，未建、也未替代任何条目；'
      + 'buildings.bin 原先把四塔按 22 层给到 92.4 m，本次按照片与卫星改正。裙楼 24 m 按照片数层（约 4 层商业）。changan_gj_4（南关正街石材双塔）为另一项目，未采用。'
  },
};

// ───────────── 27) 西安合生汇（原世纪金花·珠江时代广场） ─────────────
// 商场 14a753d7（OSM w1291043602“南门合生汇”）+ 玻璃塔楼 846fb5bb（OSM w1291042684“珠江时代广场”）。
// 照片 hehui_1/5：约 5 层米金色方格纹饰面板方盒子，后方深蓝灰玻璃塔楼顶挂“珠江地产”；卫星：塔楼屋面东偏约 23 m（→ 约 62 m）。
const hehui = {
  id: 'hehui',
  name: '西安合生汇',
  fp: '14a753d7',
  parts: [
    { name: 'mall', fp: '14a753d7', base: 0, top: 28, style: { pattern: 'stoneWindows', tint: '#4a5c6c', spd: '#cdb68a', floorH: 2.8, colW: 2.8, spandrel: 0.7, mullW: 2.1, lit: 0.5 }, roof: { mech: true, parapet: 1.2 } },
    { name: 'tower', fp: '846fb5bb', base: 0, top: 62, style: { pattern: 'curtain', tint: '#3e4d5a', spd: '#6f7a84', floorH: 4.2, colW: 1.6, spandrel: 0.2, mullW: 0.1, lit: 0.5 } },
  ],
  signs: [
    { text: '合生汇', part: 'mall', face: ['N', 'W'], y: 25.2, h: 3.2, color: '#c9a646' },
    { text: '珠江地产', part: 'tower', face: 'W', y: 58.5, h: 2.4, color: '#ffffff' },
  ],
  supersede: { names: ['西安合生汇（原世纪金花·珠江时代广场）', '南门合生汇', '西安合生汇', '珠江时代广场', '世纪金花珠江时代广场'] },
  meta: {
    dossier: 'core_south.json#西安合生汇（原世纪金花·珠江时代广场）',
    sources: ['OSM w1291043602 / w1291042684', 'http://m.winshang.com/news707957.html（B1–L5，2022-11-30 开业）', 'Esri World Imagery z19'],
    photos: [PHOTO + 'hehui_1.jpg', PHOTO + 'hehui_5.jpg'],
    confidence: 'low',
    notes: '档案 overture_id 为 null，按 OSM 名称对位。商场 L1–L5 按照片与资料 5 层 × 约 5.6 m → 28 m；塔楼层数无资料：卫星屋面倾斜位移约 23 m ÷ 0.37 ≈ 62 m（±8 m），与照片（约为商场 2.2 倍）一致。'
      + '照片为 2022 年改造前外观（改造后未取得清晰照片）。',
  },
};

// ───────────── 28) 西安金花豪生国际大酒店 ─────────────
// 轮廓 7cae1c50（OSM w1284310797，106×90 m 整体）。照片 haosheng_0（环城南路一侧向南看）：左侧板楼（金色玻璃通高竖带、顶部半圆拱形收头、竖排酒店名），
// 左前约 8 层金色玻璃圆筒（飞碟形圆盘屋顶），右侧银灰横向带窗圆柱高塔（金色竖条、顶部一圈放射状尖肋 + 桅杆）；灰色石材裙楼。
// 卫星 z19 改正倾斜后：圆塔底座约 (−345, 1001)、板楼约 x −331..−290 / z 1046..1061（屋面为东西向筒拱）、金色圆筒约 (−263, 1061)（轮廓东端圆弧）。
const haosheng = {
  id: 'jinhua-haosheng',
  name: '西安金花豪生国际大酒店',
  fp: '7cae1c50',
  parts: [
    { name: 'podium', fp: '7cae1c50', base: 0, top: 14, style: { pattern: 'stoneWindows', tint: '#2f363c', spd: '#8e949a', floorH: 4.6, colW: 3.0, spandrel: 0.35, mullW: 1.0, lit: 0.6 }, roof: { mech: false } },
    {
      name: 'slab', pts: R(-331, 1046, -290, 1061), base: 0, top: 71.4, style: { pattern: 'horizontalBands', tint: '#6d7780', spd: '#9aa0a6', floorH: 3.4, colW: 3, spandrel: 0.4, mullW: 0.05, lit: 0.55 },
      roof: { mech: false, parapet: 0.3 }, crown: [{ type: 'arch', h: 7.5, mat: { color: '#b9bec4', metalness: 0.6, roughness: 0.3 } }],
    },
    { name: 'band', pts: R(-316, 1044.8, -305, 1062.2), base: 0, top: 71.4, style: { pattern: 'curtain', tint: '#b8963e', spd: '#c9a54a', floorH: 3.4, colW: 1.4, spandrel: 0.1, mullW: 0.1, lit: 0.6 }, roof: { mech: false, parapet: 0.2 } }, // 金色玻璃通高竖带
    {
      name: 'round', shape: 'circle', size: [26, 26], at: [-345, 1001], base: 0, top: 75, style: { pattern: 'horizontalBands', tint: '#b8963e', spd: '#a3a8ad', floorH: 3.4, colW: 4, spandrel: 0.55, mullW: 0.05, lit: 0.5 },
      roof: { mech: false, parapet: 0.6 },
      crown: [{ type: 'frame', h: 5, inset: -0.6, step: 2.2, post: 0.45, mat: 'metal' }, { type: 'masts', list: [[0, 0]], top: 86, r: 0.5 }], // 放射状尖肋环（简化为一圈立柱）+ 桅杆
    },
    { name: 'drum', shape: 'circle', size: [16, 16], at: [-263.5, 1061.5], base: 0, top: 30, style: { pattern: 'curtain', tint: '#b8963e', spd: '#c9a54a', floorH: 3.6, colW: 1.6, spandrel: 0.12, mullW: 0.1, lit: 0.6 }, roof: { mech: false }, crown: [{ type: 'disk', r: 11.5, h: 1.8, rimH: 0.9, mat: '#d8d4cc' }] },
  ],
  signs: [{ text: '金花豪生国际大酒店', part: 'band', face: 'N', y: 44, h: 30, color: '#e8e8e8', vertical: true }],
  supersede: { names: ['西安金花豪生国际大酒店', '金花豪生国际大酒店', '金花豪生国际大酒店(环城南路店)'] },
  meta: {
    dossier: 'core_south.json#西安金花豪生国际大酒店',
    sources: ['https://hotels.ctrip.com/hotels/420030.html（21 层）', 'https://www.hotelincn.com/29636', 'OSM w1284310797', 'Esri World Imagery z19'],
    photos: [PHOTO + 'haosheng_0.jpg'],
    confidence: 'low',
    notes: '21 层有出处：板楼 21 × 3.4 m = 71.4 m + 筒拱收头约 7.5 m。圆塔、金色圆筒高度无资料：圆塔按卫星屋面倾斜位移约 31 m ÷ 0.38 ≈ 80 m（含尖肋环）→ 塔身 75 m + 尖肋环 5 m、桅杆至 86 m（照片与板楼约等高，互证）；圆筒按照片约 8 层 → 30 m。'
      + '三个体量位置按卫星屋面减去倾斜位移（±6 m）；裙楼 14 m 按照片约 3 层。右侧圆塔是否属酒店本体档案未核实（同一 OSM 轮廓内，按轮廓一并建）。',
  },
};

// ───────────── 29) 中贸广场（南稍门） ─────────────
// 轮廓 15894f53（OSM w1284311133，南北 101 × 东西 35 m）：卫星上为低矮商业裙楼（屋面绿化），东侧一列为住宅高层（另有轮廓，保留通用建筑）。
// 照片 zhongmao3_3（夜景）：深色玻璃 + 石材裙楼，入口折线形钢构玻璃雨棚，檐口一道绿色轮廓灯，白色“中贸广场”。
const zhongmao = {
  id: 'zhongmao',
  name: '中贸广场',
  fp: '15894f53',
  parts: [
    { name: 'podium', kind: 'podium', fp: '15894f53', base: 0, top: 15, style: { pattern: 'stoneWindows', tint: '#2a3138', spd: '#5e6266', floorH: 5, colW: 3.2, spandrel: 0.3, mullW: 1.0, lit: 0.8 }, roofMat: { color: '#5d7a4a', roughness: 0.9 } },
  ],
  signs: [{ text: '中贸广场', part: 'podium', face: 'E', y: 12.6, h: 2.2, color: '#ffffff' }],
  night: { outline: [{ part: 'podium', color: '#3cff7a', w: 0.35 }] },
  supersede: { names: ['中贸广场（南稍门）', '中贸广场', '中贸城市生活广场'] },
  meta: {
    dossier: 'core_south.json#中贸广场（南稍门）',
    sources: ['OSM w1284311133', 'http://news.winshang.com/html/065/2779.html', 'https://www.anjuke.com/xa/cm314275/'],
    photos: [PHOTO + 'zhongmao3_3.jpg'],
    confidence: 'low',
    notes: '卫星核对：15894f53 为屋面绿化的低层商业裙楼，并非塔楼；按照片数层约 3 层 × 5 m → 15 m。landmarks2026“中贸广场（南稍门）”100 m 塔楼无出处，被替代；'
      + '真实住宅塔楼（东侧 f97c7ac8 等）不在本轮廓内，由通用建筑表达。',
  },
};

// ───────────── 30) 西安市妇幼保健院（西大街） ─────────────
// 轮廓 b9abe57c（OSM w1263109032，62×50 m）。照片 Commons 西安市妇幼保健院_2023-09-28：西大街统一仿古风貌——灰色石材墙面 + 方窗，
// 入口上方深灰筒瓦坡檐与金色字匾“西安市妇幼保健院”。
const fuyou = {
  id: 'xian-mch',
  name: '西安市妇幼保健院',
  fp: 'b9abe57c',
  parts: [
    { name: 'main', fp: 'b9abe57c', base: 0, top: 14.2, style: { pattern: 'stoneWindows', tint: '#3c4448', spd: '#b9b4ab', floorH: 3.6, colW: 2.6, spandrel: 0.5, mullW: 1.2, lit: 0.5 }, crown: [{ type: 'eave', ov: 1.2, depth: 1.8, h: 1.1, mat: TILE }] },
  ],
  signs: [{ text: '西安市妇幼保健院', part: 'main', face: 'S', y: 4.4, h: 0.9, color: '#c8a45a', bg: '#1d2426' }],
  supersede: { names: ['西安市妇幼保健院'] },
  meta: {
    dossier: 'public.json#西安市妇幼保健院',
    sources: ['OSM w1263109032', 'https://commons.wikimedia.org/wiki/File:西安市妇幼保健院_2023-09-28_01.jpg'],
    photos: ['scratchpad/core_agent/img/fy.jpg'],
    confidence: 'low（高度）；medium（立面）',
    notes: '高度无资料，照片只见下部 3 层：保守取实测 CMAB 14.2 m（档案 local_data）+ 仿古瓦檐。',
  },
};

// ───────────── 31) 西安市新城区人民政府 ─────────────
// 轮廓 8111cdfa（OSM w1465145886，59×31 m，对应为推断）。照片 Commons 西安市新城区人民政府（拍摄点在楼西南）：
// 米黄面砖两翼（外挑空调板）+ 中部通高蓝色玻璃幕墙竖向中庭，首层红柱 + 红色琉璃瓦坡檐门廊、挂红灯笼。
const xinchengqu = {
  id: 'xincheng-district-gov',
  name: '西安市新城区人民政府',
  fp: '8111cdfa',
  parts: [
    { name: 'main', fp: '8111cdfa', base: 0, top: 28, style: { pattern: 'stoneWindows', tint: '#4d5a66', spd: '#d9bf9a', floorH: 3.5, colW: 2.2, spandrel: 0.46, mullW: 0.9, lit: 0.5 }, roof: { mech: true, parapet: 1.2 } },
    { name: 'glass', pts: R(1302.5, -891, 1321.5, -856.4), base: 0, top: 29.5, style: { pattern: 'curtain', tint: '#5a86b8', spd: '#b8b8b8', floorH: 3.5, colW: 1.5, spandrel: 0.15, mullW: 0.12, lit: 0.6 }, roof: { mech: false, parapet: 0.6 } },
    {
      name: 'porch', pts: R(1298, -856.6, 1326, -850.5), base: 0, top: 5.2, style: { pattern: 'grid', tint: '#3a2a24', spd: '#a8291e', floorH: 5.2, colW: 3.4, spandrel: 0.12, mullW: 0.8, lit: 0.8 },
      crown: [{ type: 'cnhip', style: 'xieshan', ov: 1.2, h: 2.0, mat: { color: '#b8321e', roughness: 0.6 } }],
    },
  ],
  supersede: { names: ['西安市新城区人民政府', '新城区人民政府'] },
  meta: {
    dossier: 'public.json#西安市新城区人民政府',
    sources: ['https://commons.wikimedia.org/wiki/File:西安市新城区人民政府.jpg', 'OSM w1465145886'],
    photos: ['scratchpad/core_agent/img/xcq.jpg'],
    confidence: 'low',
    notes: '高度无资料：照片可数约 8 层（顶部出画）→ 8 × 3.5 m = 28 m（下限）。中庭玻璃带宽 19 m、门廊 28 m 为照片比例；门廊朝南（照片拍摄点在楼西南）。',
  },
};

// ───────────── 32) 西安市汽车站（火车站西广场） ─────────────
// 轮廓 edcd6ba2（OSM w1465143088，119×33 m）。照片 Commons 西安汽车站_01（夜景）：屋顶红色发光字“西安汽车站”，立面细节不清。
const qichezhan = {
  id: 'xian-bus-station',
  name: '西安市汽车站',
  fp: 'edcd6ba2',
  parts: [
    { name: 'hall', fp: 'edcd6ba2', base: 0, top: 12.6, style: { pattern: 'retail', tint: '#3a4650', spd: '#c9c4b8', floorH: 6.3, colW: 3.4, spandrel: 0.3, lit: 0.85 }, roof: { mech: false } },
    { name: 'signbar', kind: 'solid', shape: 'rect', size: [30, 0.4], at: [1352.3, -1782], base: 12.6, top: 13.4, mat: '#3a3833' },
  ],
  signs: [{ text: '西安汽车站', part: 'signbar', face: 'N', y: 15.6, h: 3.2, color: '#e8322c' }],
  supersede: { names: ['西安市汽车站（火车站西广场）', '西安市汽车站', '西安汽车站'] },
  meta: {
    dossier: 'public.json#西安市汽车站（火车站西广场）',
    sources: ['OSM w1465143088', 'https://commons.wikimedia.org/wiki/File:西安火车站广场附近·西安汽车站_01.jpg'],
    photos: ['scratchpad/core_agent/img/qcz.jpg'],
    confidence: 'low（形体）；medium（招牌）',
    notes: '高度无资料、照片为夜景：保守取实测 CMAB 12.6 m（档案 local_data）；屋顶红色“西安汽车站”朝北（火车站广场）。',
  },
};

export default [
  kaiyuan, belltower, youju, baohua, zhonghuan, baisheng, zhongda, xingzhengyuan, qunguang, hongfu, kaiai, jiaohang,
  huangcheng, aoluo, rmjy, yisu, renmindasha, hilton, kejiguan, minsheng, wandaMly, yuehui, zhongyi, hehui, haosheng, zhongmao, qichezhan,
  // 华侨城·长安国际中心由 south.js 负责（照片 changan_gj_2/3：后排挂“华侨城·长安国际”的塔明显高于前排，south 的前低后高更符合照片）
];
// 去重：省政府、市中心医院、市妇幼、新城区政府归 public.js（医院/政府类由公共建筑片负责）
