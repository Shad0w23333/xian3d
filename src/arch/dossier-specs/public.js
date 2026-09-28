// 逐栋档案：公共建筑（学校、医院、政府机关、区级公共设施）。
// 档案：research/refs/dossiers/public.json（及与片区档案重复、但按分工归本文件的医院/高校/政府条目）。
// 分工：public.json 与片区档案重复的条目里，医院/高校/政府一律在本文件建；商场/酒店/写字楼/剧院/会展，以及落在片区商圈/地标范围内的
//       博物馆、图书馆、体育场（陕历博、省图两馆、省美术博物馆、省科技馆、西安美术馆、省体育场、奥体、城市运动公园体育馆、西安站站房等）
//       由片区文件建；西安博物院已由 heritage 模块精建（小雁塔院落）。每条 meta.category 写明类别，避免重复。
// 依据：档案条目 + 照片（Commons、档案 photos、按条目补充的新闻/官网照片，见各条 meta.photos；本机副本在
//       scratchpad/dossier_res/photos/pub、scratchpad/pub_agent/imgs）+ Esri / Google 卫星核对（scratchpad/pub_agent/sat）。
//       卫星上高楼屋面随楼身倾斜偏移，落位一律以 Overture/OSM 底座轮廓为准。
// 档案为 null 的数值没有编：按照片数层 × 层高、卫星量取、或 buildings.bin（已审计）兜底，均在 meta.notes 注明；做不到的写“保守处理”。
// 对照差异：research/refs/dossiers/model_log_public.md。字段说明：docs/DOSSIER_KIT.md。

// ───────────── 常用材质 / 立面（颜色取自照片目测，档案给了色值的以档案为准） ─────────────
const TILE_WHITE = { pattern: 'stoneWindows', spd: '#ecebe6', tint: '#5d7488', floorH: 3.9, colW: 2.4, spandrel: 0.45, mullW: 0.9, lit: 0.55 }; // 白色面砖 + 方窗（医院常见）
const STONE_BEIGE = { pattern: 'stoneWindows', spd: '#d8ccb6', tint: '#34414b', floorH: 4.0, colW: 2.6, spandrel: 0.42, mullW: 1.0, lit: 0.5 }; // 米黄石材 / 面砖
const TILE_GRAY = { color: '#5d6166', roughness: 0.8 }; // 深灰瓦 / 金属屋面（行政楼“大挑檐帽”）
const TILE_ORANGE = { color: '#c46a2b', roughness: 0.7 }; // 橙褐琉璃瓦（省政府屋顶亭阁、檐口）

// ═════════════════════════ 医院 ═════════════════════════

// ───── 西京医院（空军军医大学第一附属医院）：住院二部 + 门诊弧形主楼群 ─────
// 住院二部（2020 启用）：5 层裙楼 25b169f2 连接南北两座东西向板楼（北楼 20 层 de5f7efc、南楼 19 层 38bb39c5，中联西北院通稿）。
// Esri z19 核对：两塔屋面相对 OSM 轮廓向东偏约 32 m（楼身倾斜，可见西立面），OSM 轮廓即底座。
// 照片（西京医院官网“住院二部大楼启用仪式”、HCD 设计文章效果图）：两座白色板楼，白色竖向框 + 深色窗；裙楼玻璃幕墙 + 白框，
// 裙楼上红色“住院二部”字，裙楼屋面绿化屋顶花园。效果图上塔顶有直升机坪，卫星屋面未见，不建。
// 门诊弧形主楼群 96b28c39：环绕北侧圆形广场的弧形楼 + 南侧曲面门诊楼（照片 xijing_8：米黄石材 + 蓝绿玻璃横向带窗约 7 层，
// 屋顶红色“西京医院 XIJING HOSPITAL”）。按 z = −1292 把 OSM 轮廓切成北（弧形楼）南（门诊楼）两块分别给高度。
const xijing = {
  id: 'pub-xijing',
  name: '西京医院',
  fp: '25b169f2',
  parts: [
    {
      name: 'podium', kind: 'podium', fp: '25b169f2', base: 0, top: 24,
      style: { pattern: 'grid', tint: '#2f4a5e', spd: '#e8e8e4', floorH: 4.8, colW: 2.2, spandrel: 0.22, mullW: 0.3, lit: 0.7 },
      roofMat: { color: '#7f9a6c', roughness: 0.9 }, // 屋顶花园
    },
    {
      name: 'towerN', fp: 'de5f7efc', base: 0, top: 83,
      style: { pattern: 'verticalFins', tint: '#3a5266', spd: '#eeeeea', floorH: 3.9, colW: 1.8, spandrel: 0.3, mullW: 0.42, lit: 0.6 },
    },
    {
      name: 'towerS', fp: '38bb39c5', base: 0, top: 79,
      style: { pattern: 'verticalFins', tint: '#3a5266', spd: '#eeeeea', floorH: 3.9, colW: 1.8, spandrel: 0.3, mullW: 0.42, lit: 0.6 },
    },
    {
      name: 'wardArc', kind: 'podium', base: 0, top: 40, // 环绕圆形广场的弧形楼（96b28c39 北半）
      pts: [3794.5, -1300.3, 3800.3, -1302.0, 3815.5, -1309.7, 3817.8, -1311.9, 3816.2, -1314.8, 3823.2, -1320.1, 3821.0, -1324.5, 3826.4, -1328.6, 3831.7, -1334.9, 3829.5, -1336.8, 3831.7, -1340.0, 3822.6, -1346.2, 3818.4, -1341.6, 3814.2, -1344.4, 3810.6, -1340.1, 3801.4, -1349.7, 3796.0, -1345.2, 3789.6, -1341.3, 3782.2, -1338.6, 3779.7, -1345.3, 3774.9, -1344.2, 3767.1, -1344.2, 3762.2, -1345.5, 3761.1, -1337.8, 3753.5, -1340.1, 3741.6, -1347.2, 3732.7, -1337.0, 3728.4, -1341.3, 3724.7, -1336.8, 3721.5, -1339.4, 3712.8, -1333.4, 3714.1, -1331.3, 3712.4, -1329.6, 3723.5, -1318.9, 3722.1, -1315.8, 3729.6, -1310.9, 3728.4, -1307.8, 3730.7, -1306.0, 3743.9, -1300.2, 3751.5, -1298.2, 3751.7, -1292.0, 3794.9, -1292.0],
      style: { pattern: 'horizontalBands', tint: '#3f6a78', spd: '#d9c9a8', floorH: 3.9, colW: 3.0, spandrel: 0.42, mullW: 0.06, lit: 0.6 },
      roofMat: { color: '#b8b0a2', roughness: 0.9 },
    },
    {
      name: 'opd', kind: 'podium', base: 0, top: 30, // 南侧曲面门诊楼（96b28c39 南半）
      pts: [3751.8, -1289.3, 3753.4, -1283.9, 3752.5, -1276.0, 3752.9, -1267.0, 3760.5, -1267.3, 3761.1, -1256.1, 3759.3, -1252.4, 3751.2, -1250.9, 3748.1, -1265.1, 3718.4, -1257.9, 3712.4, -1257.4, 3710.8, -1255.8, 3716.1, -1241.6, 3735.0, -1247.5, 3739.2, -1228.8, 3719.1, -1222.4, 3710.3, -1222.2, 3711.9, -1217.9, 3709.8, -1216.8, 3713.9, -1209.8, 3720.3, -1207.3, 3742.6, -1214.9, 3751.4, -1216.7, 3752.8, -1207.3, 3762.4, -1209.2, 3763.3, -1203.2, 3792.3, -1204.5, 3792.8, -1210.6, 3801.5, -1210.3, 3802.5, -1219.1, 3815.0, -1217.4, 3833.6, -1212.5, 3837.0, -1221.6, 3843.1, -1219.8, 3842.8, -1228.3, 3834.7, -1229.4, 3816.2, -1233.4, 3817.2, -1239.6, 3814.9, -1240.1, 3816.7, -1251.0, 3835.8, -1247.0, 3839.5, -1262.6, 3831.2, -1261.4, 3801.5, -1265.8, 3799.9, -1253.1, 3789.4, -1253.9, 3789.8, -1269.5, 3796.0, -1269.5, 3794.9, -1292.0, 3751.7, -1292.0],
      style: { pattern: 'horizontalBands', tint: '#3f7a8a', spd: '#d9c9a8', floorH: 4.2, colW: 3.0, spandrel: 0.42, mullW: 0.06, lit: 0.65 },
      roofMat: { color: '#b8b0a2', roughness: 0.9 },
    },
  ],
  signs: [
    { text: '住院二部', part: 'podium', face: 'E', y: 19, h: 3.4, color: '#d0262b' },
    { text: '西京医院 XIJING HOSPITAL', part: 'opd', face: 'S', y: 32.6, h: 4.6, color: '#d0262b' },
  ],
  supersede: { names: ['西京医院（空军军医大学第一附属医院）', '西京医院住院二部'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#西京医院（空军军医大学第一附属医院）',
    sources: ['https://www.sinomach.com.cn/xwzx/zgsdt/2020_qydt/202010/t20201001_254259.html（南楼19层、北楼20层、裙楼5层）',
      'http://www.fmmu.edu.cn/news/info/1004/169121.htm（住院二部启用照片）', 'http://hcd.zhuyitai.com/journals/hcd/article/f6f97eaaa3b2440bb424bdbdf082b3ef（效果图）',
      'OSM w1266651327 / w1266651617 / w1266651492 / w1266651258', 'Esri World Imagery z19'],
    photos: ['scratchpad/pub_agent/imgs/xijing_0.jpg（效果图）', 'xijing_1.jpg', 'xijing_14.jpg', 'xijing_8.jpg（门诊楼）', 'scratchpad/pub_agent/sat/xj3.jpg'],
    confidence: 'medium（住院二部体块/层数）；low（门诊楼群高度）',
    notes: '米制高度无资料：裙楼 5 层 × 4.8 m = 24 m；北楼 24 + 15 × 3.9 ≈ 83 m（20 层）、南楼 ≈ 79 m（19 层），按资料层数 × 层高。'
      + '门诊楼 30 m 按照片数层（约 7 层 × 4.2 m）；北侧弧形楼 40 m 按卫星阴影量取（与住院二部阴影比例对照，约 10 层，±5 m）。',
  },
};

// ───── 西安交通大学第一附属医院（雁塔西路院区） ─────
// 门急诊大楼 3622261a（OSM 名称，地上 5 层，丁香园/健康界）：回字形 + 4 个内天井。
// 高层住院楼 2c60ad1f（127×32 m 东西向长板）：南侧航拍照片 jd1_3（门急诊楼在前，住院楼在后，屋顶红色“交大一附院”立字）。
// 住院楼立面：两端白色面砖方窗，中段深灰窗间墙 + 挑板（竖向分格），中轴一道玻璃竖带。
// 外科大楼（13 层，2023 投用）：档案推断的 99a9a52a 是若干旧平房拼成的细长多臂轮廓，影像均早于竣工，底座无法确认 → 不建。
const jd1 = {
  id: 'pub-jd1',
  name: '西安交通大学第一附属医院',
  fp: '3622261a',
  parts: [
    {
      name: 'opd', kind: 'podium', fp: '3622261a', holes: 'fp', base: 0, top: 24,
      style: { ...TILE_WHITE, spd: '#eeeeea', tint: '#6d7d88', floorH: 4.8, colW: 3.0 },
      roofMat: { color: '#c4c2bc', roughness: 0.9 },
    },
    {
      name: 'ward', fp: '2c60ad1f-aa27-4a6a-b019-145989062537', base: 0, top: 84,
      style: { pattern: 'verticalFins', tint: '#55636e', spd: '#e4e4e0', floorH: 3.8, colW: 1.6, spandrel: 0.32, mullW: 0.5, lit: 0.6 },
    },
  ],
  signs: [
    { text: '交大一附院', part: 'ward', face: 'S', y: 87.5, h: 5.5, color: '#d7261e' }, // 屋顶立字（航拍照片 jd1_3）
    { text: '门诊部', part: 'opd', face: 'S', y: 25.8, h: 3.0, color: '#d7261e' }, // 门急诊楼屋顶红字（同一照片）
  ],
  supersede: { names: ['西安交通大学第一附属医院（雁塔西路院区）', '交大一附院'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#西安交通大学第一附属医院（雁塔西路院区）（与 core_south.json 重复，按分工在此建）',
    sources: ['https://y.dxy.cn/hospital/52/915875.html（门急诊楼地上5层）', 'https://www.cn-healthcare.com/articlewm/20231027/wap-content-1615965.html（外科大楼13层）',
      'OSM r19307911 / w1411003683', 'Google / Esri 卫星 z19'],
    photos: ['scratchpad/pub_agent/imgs/jd1_3.jpg（南侧航拍）', 'scratchpad/pub_agent/crop_jd1.jpg（住院楼数层）', 'jd1_0.jpg（外科大楼）'],
    confidence: 'medium',
    notes: '门急诊楼 5 层 × 4.8 m = 24 m（资料层数）。住院楼层数无资料：按照片数层——门急诊楼屋面以上露出约 20 层、被遮挡约 2 层 → 约 22 层 × 3.8 m ≈ 84 m'
      + '（core_south 档案粗计约 20 层）。外科大楼无可信底座轮廓，未建（由通用建筑表达）。',
  },
};

// ───── 西安交通大学第二附属医院（西五路院区，“西北医院”） ─────
// 主楼 ec87f3a4（108×46 m）：照片 jd2b_4（丁香园）为米白面砖 + 规则方窗板楼，约 12 层，中段顶部退进 2 层、屋顶红色“西北医院”；
// 两端为深色/蓝色玻璃幕墙竖段；照片 jd2b_7、jd2_4：入口大雨棚上红色“西安交通大学第二附属医院”中英文大字。Google 卫星主楼北侧长阴影。
const jd2 = {
  id: 'pub-jd2',
  name: '西安交通大学第二附属医院',
  fp: 'ec87f3a4',
  parts: [
    { name: 'main', fp: 'ec87f3a4', base: 0, top: 46, style: { ...TILE_WHITE, spd: '#dcd6ca', tint: '#44525e', floorH: 3.8, colW: 2.3 } },
    {
      name: 'glassW', kind: 'facade', shape: 'rect', size: [12, 35.4], at: [338, -1252.7], base: 0, top: 46, // 西端玻璃竖段（照片左端深色玻璃）
      style: { pattern: 'curtain', tint: '#2f4f6e', spd: '#8fa0ae', floorH: 3.8, colW: 1.5, spandrel: 0.15, mullW: 0.08, lit: 0.55 },
    },
    {
      name: 'glassE', kind: 'facade', shape: 'rect', size: [14, 36], at: [434, -1253], base: 0, top: 46, // 东端玻璃幕墙竖段
      style: { pattern: 'horizontalBands', tint: '#3d6a93', spd: '#9fb3c4', floorH: 3.8, colW: 1.8, spandrel: 0.2, mullW: 0.08, lit: 0.55 },
    },
    { name: 'pent', shape: 'rect', size: [36, 24], at: [386, -1258], base: 46, top: 53.5, style: { ...TILE_WHITE, spd: '#dcd6ca', tint: '#44525e', floorH: 3.8 } }, // 中段退进 2 层
  ],
  signs: [
    { text: '西北医院', part: 'pent', face: 'S', y: 56, h: 3.6, color: '#c8161d' },
    { text: '西安交通大学第二附属医院', part: 'main', face: 'S', y: 7.5, h: 2.4, color: '#d0262b' },
  ],
  supersede: { names: ['西安交通大学第二附属医院（西五路院区）', '西北医院'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#西安交通大学第二附属医院（西五路院区）',
    sources: ['http://www.2yuan.xjtu.edu.cn/defsyy/', 'http://yyh.dxy.cn/article/729248（主楼照片）', 'http://health.hsw.cn/system/2021/0104/79066.shtml（入口照片）', 'OSM w1465145182', 'Google 卫星 z19'],
    photos: ['scratchpad/pub_agent/imgs/jd2b_4.jpg', 'jd2b_7.jpg', 'jd2_4.jpg'],
    confidence: 'low（轮廓与照片对应为推断）；medium（外观）',
    notes: '层数无资料：按照片数层约 12 层 × 3.8 m ≈ 46 m，中段顶部退进约 2 层至 53.5 m。玻璃竖段位置按照片左右端与轮廓两端对应（未核实拍摄方向）。'
      + '入口左侧另有一座更高的蓝色横带玻璃塔（jd2b_7），无法在轮廓中定位，未建。',
  },
};

// ───── 陕西省人民医院（友谊西路院区）高层住院楼 ─────
// 北部高层 a3ece8f4（58×33 m，北立面阶梯状轮廓）：照片 srmyy_13/16（院方官网、点评）为对称高层——中段蓝灰玻璃横带、顶部红色“陕西省人民医院”，
// 两侧各一道更高的米白石材竖塔（顶部两层通高玻璃），最外两翼再低一截。buildings.bin 76.5 m（审计后）。
// 其南侧 b50242bd 为多层裙房（屋面天窗，东侧弧形入口），卫星可见。
const SRM_STONE = { pattern: 'stoneWindows', spd: '#e6e1d6', tint: '#35506a', floorH: 3.4, colW: 2.6, spandrel: 0.5, mullW: 1.0, lit: 0.55 };
const srmyy = {
  id: 'pub-srmyy',
  name: '陕西省人民医院',
  fp: 'a3ece8f4',
  parts: [
    // 按 OSM 轮廓阶梯拆成：外翼 ×2（68 m）、竖塔 ×2（76.5 m）、中段（71 m）
    { name: 'wingW', shape: 'rect', size: [6.8, 18.7], at: [-1469.4, 2097.65], base: 0, top: 68, style: SRM_STONE },
    { name: 'wingE', shape: 'rect', size: [6.6, 18.2], at: [-1417.7, 2098.1], base: 0, top: 68, style: SRM_STONE },
    { name: 'pylonW', shape: 'rect', size: [7.8, 23.5], at: [-1462.1, 2095.25], base: 0, top: 76.5, style: SRM_STONE },
    { name: 'pylonE', shape: 'rect', size: [8.0, 23.1], at: [-1425.0, 2095.65], base: 0, top: 76.5, style: SRM_STONE },
    {
      name: 'mid', base: 0, top: 71,
      pts: [-1458.2, 2076.7, -1450.6, 2074.8, -1443.7, 2073.8, -1429.0, 2076.9, -1429.0, 2107.1, -1458.0, 2107.0],
      style: { pattern: 'grid', tint: '#35628f', spd: '#e6e1d6', floorH: 3.4, colW: 2.2, spandrel: 0.3, mullW: 0.3, lit: 0.6 },
    },
    {
      name: 'podium', kind: 'podium', fp: 'b50242bd', holes: 'fp', base: 0, top: 14.2,
      style: { ...TILE_WHITE, spd: '#e6e1d6', floorH: 4.7, colW: 3.0 }, roofMat: { color: '#b9b6ae', roughness: 0.9 },
    },
  ],
  signs: [{ text: '陕西省人民医院', part: 'mid', face: 'N', y: 69.5, h: 2.6, color: '#c8161d' }],
  supersede: { names: ['陕西省人民医院'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#陕西省人民医院',
    sources: ['https://www.spph-sx.com/info/1072/49673.htm（院方照片）', 'https://www.cityhui.com/shop/94835.html', 'OSM w1267270425 / r17401798', 'buildings.bin（76.5 m）', 'Google 卫星 z19'],
    photos: ['scratchpad/pub_agent/imgs/srmyy_13.jpg', 'srmyy_16.jpg', 'scratchpad/pub_agent/cnt_srm2.jpg（数层）', 'scratchpad/pub_agent/sat/srm.jpg'],
    confidence: 'medium',
    notes: '竖塔顶 76.5 m 取 buildings.bin（审计后，与照片约 22 层相符）；中段、外翼按照片比例（中段顶为竖塔的 0.92、外翼 0.89）→ 71 m、68 m。'
      + '分段位置按 OSM 轮廓的阶梯（中段 x −1466…−1421，竖塔为其两侧 8 m 条带）。立字朝北（院落北侧为友谊西路入口，按轮廓阶梯面判断，未核实）。'
      + '裙房 b50242bd 高度无资料，取 buildings.bin 14.2 m 兜底。南部 71f6bac6 高层无照片，未建。',
  },
};

// ───── 西安市中心医院（北大街东侧） ─────
// 主楼 dfec9343（29×53 m 南北向）：照片（Commons 2023-09-28，西南侧仰拍）白色面砖 + 蓝色横向带窗；南端为弧形玻璃凸窗（逐层弧面），
// 西南角为带凹阳台的楼梯竖塔（竖排红字“西安交通大学附属西安市中心医院”）；屋顶东侧一个圆筒，上立红色“西安市中心医院”与红十字；
// 前部约 5 层白色面砖裙楼 bb6f1842，绿色窗框、转角圆弧。卫星屋面东侧可见圆弧形构筑物。
const ZX_TOWER = (() => {
  const p = [41.6, -1500.2, 71.0, -1500.2, 71.0, -1457.5];
  for (let k = 1; k < 12; k++) { const a = (k / 12) * Math.PI; p.push(60.5 + 10.5 * Math.cos(a), -1457.5 + 10.5 * Math.sin(a)); } // 南端弧形凸窗（向南凸）
  p.push(50.0, -1457.5, 50.0, -1462.0, 41.6, -1462.0);
  return p;
})();
const zxyy = {
  id: 'pub-zxyy',
  name: '西安市中心医院',
  fp: 'dfec9343',
  parts: [
    { name: 'tower', pts: ZX_TOWER, base: 0, top: 56, style: { pattern: 'horizontalBands', tint: '#3f6fa8', spd: '#e6e2d8', floorH: 3.5, colW: 2.6, spandrel: 0.48, mullW: 0.06, lit: 0.55 } },
    { name: 'stair', shape: 'rect', size: [8.4, 15], at: [45.8, -1454.5], base: 0, top: 58, style: { pattern: 'stoneWindows', spd: '#e8e4da', tint: '#2a2f33', floorH: 3.5, colW: 4.2, spandrel: 0.55, mullW: 2.4, lit: 0.2 } },
    { name: 'drum', shape: 'circle', size: [12, 12], at: [64, -1472], base: 56, top: 62, style: { pattern: 'stoneWindows', spd: '#eeeeea', tint: '#6b7c8a', floorH: 3.0, colW: 2.2, spandrel: 0.6, mullW: 1.2, lit: 0.3 }, roof: { mech: false } },
    {
      name: 'wing', kind: 'podium', fp: 'bb6f1842', roundCorners: 6, base: 0, top: 20,
      style: { pattern: 'stoneWindows', spd: '#ecebe6', tint: '#3f7a5a', floorH: 4.0, colW: 2.6, spandrel: 0.45, mullW: 1.0, lit: 0.55 },
      roofMat: { color: '#c9c6bf', roughness: 0.9 },
    },
  ],
  signs: [{ text: '西安市中心医院', part: 'drum', face: 'SW', y: 64, h: 3.0, color: '#d0262b' }],
  supersede: { names: ['西安市中心医院（西五路院区）', '西安市中心医院（西安交通大学附属西安市中心医院）'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#西安市中心医院（西五路院区）（core_south.json 同名条目按分工在此建）',
    sources: ['https://commons.wikimedia.org/wiki/File:西安市中心医院_2023-09-28.jpg', 'OSM w1465144409 / w1465144644', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安市中心医院_西五路院区__0.jpg', 'scratchpad/pub_agent/sat/g05.jpg'],
    confidence: 'low（层数）；medium（外观）',
    notes: '层数两档案不一致（public 计 15–16 层、core_south 计约 11 层）：本条按照片重新数楼梯竖塔的凹阳台约 16 层 × 3.5 m = 56 m。'
      + 'OSM 轮廓为矩形，照片南端为逐层弧形凸窗 → 南端用半径 10.5 m 的半圆代替矩形东南角；楼梯竖塔 8.4×15 m 放西南角。'
      + '圆筒位置按卫星屋面圆弧构筑物，高 6 m 按照片比例。裙楼 5 层 × 4.0 m = 20 m（照片数层）。竖排红字与红十字未建（招牌库只支持横排）。',
  },
};

// ───── 西安市红会医院（友谊东路院区）1 号楼 ─────
// 照片 honghui_5（凤凰网陕西，东南高处俯拍）：约 6 层白色裙楼在前，其后白色高层塔楼（方窗网格、深色窗，塔身四周一圈深色竖框），顶上红色“红会医院”。
// Google z19：塔楼屋面相对 OSM 轮廓 07516da2（61×28 m）向东偏约 24 m、向北约 8 m（楼身倾斜，可见西立面）→ 塔楼底座为 07516da2；
// OSM“西安市红会医院-1号楼”35b93ebf 为包在塔楼南、东两侧的 L 形裙楼。
const honghui = {
  id: 'pub-honghui',
  name: '西安市红会医院',
  fp: '35b93ebf',
  parts: [
    {
      name: 'podium', kind: 'podium', fp: '35b93ebf', base: 0, top: 24,
      style: { ...TILE_WHITE, spd: '#e8e7e2', tint: '#4b5d6a', floorH: 4.0, colW: 2.2 }, roofMat: { color: '#b3b0a8', roughness: 0.9 },
    },
    { name: 'tower', fp: '07516da2-19b3-45f2-a64d-b5925a5e9ab4', base: 0, top: 60, style: { pattern: 'stoneWindows', spd: '#e3e2dc', tint: '#2f5a5a', floorH: 3.7, colW: 3.0, spandrel: 0.5, mullW: 1.2, lit: 0.55 } },
  ],
  signs: [{ text: '红会医院', part: 'tower', face: 'S', y: 63, h: 4.2, color: '#d0262b' }],
  supersede: { names: ['西安市红会医院（友谊东路院区）', '西安市红会医院', '西安市红会医院-1号楼'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#西安市红会医院（友谊东路院区）',
    sources: ['http://sn.ifeng.com/a/20190102/7137087_0.shtml（照片）', 'OSM w1291043362（西安市红会医院-1号楼）/ w1291044701', 'Google 卫星 z19'],
    photos: ['scratchpad/pub_agent/imgs/honghui_5.jpg', 'scratchpad/pub_agent/cnt_hh.jpg（数层）', 'scratchpad/pub_agent/sat/hh2.jpg'],
    confidence: 'medium（体块）；low（层数）',
    notes: '层数无资料：按照片数层——塔楼露出裙楼约 10 层 + 裙楼约 6 层 → 约 16 层 × 3.7 m ≈ 60 m（与 Google 影像屋面偏移 25 m、倾斜比约 0.42 相符）；'
      + '裙楼 6 层 × 4.0 m = 24 m。3 号楼 af0c46fa 无照片，未建。',
  },
};

// ───── 西安市儿童医院（西举院巷院区） ─────
// OSM r17688742（187×89 m，含 4 个天井）。Google z19：中部偏南为灰色四坡顶门诊大厅（屋面檐口可见“西安市儿童医院”字），
// 西半部为屋顶花园 + 庭院，东半部两座板楼（屋面太阳能板，四周一圈灰色挑檐）。照片 etyy_18（西安市卫健委）：两层玻璃门厅 + 浅坡大屋顶，
// 门厅上红色“西安市儿童医院 XI'AN CHILDREN'S HOSPITAL”；etyy_17：门厅右后方约 5 层白色楼（带中式亭阁屋顶）。
const etyy = {
  id: 'pub-etyy',
  name: '西安市儿童医院',
  fp: '4b65f8cb',
  parts: [
    {
      name: 'base', kind: 'podium', fp: '4b65f8cb', holes: 'fp', base: 0, top: 9,
      style: { ...TILE_WHITE, spd: '#e9e7e1', floorH: 3.6 }, roofMat: { color: '#7f9a6c', roughness: 0.9 }, // 西侧屋顶花园
    },
    {
      name: 'east', shape: 'rect', size: [61.6, 60], at: [-1794, -245.5], base: 0, top: 20,
      style: { ...TILE_WHITE, spd: '#eeede8', floorH: 4.0 }, roof: { mech: false },
      crown: [{ type: 'hip', top: [56, 53], h: 2.2, eave: 1.6, mat: '#8c9094' }],
    },
    {
      name: 'hall', shape: 'rect', size: [47, 33], at: [-1851.5, -249.5], base: 0, top: 9.4,
      style: { pattern: 'retail', tint: '#3d5566', spd: '#e8e8e4', floorH: 4.5, colW: 3.0, spandrel: 0.15, mullW: 0.2, lit: 0.85 }, roof: { mech: false },
      crown: [{ type: 'hip', h: 5, eave: 2.0, ridge: 0.45, mat: TILE_GRAY }],
    },
  ],
  signs: [{ text: '西安市儿童医院', part: 'hall', face: 'S', y: 7.6, h: 2.2, color: '#d0262b' }],
  supersede: { names: ['西安市儿童医院（西举院巷院区）', '西安市儿童医院'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#西安市儿童医院（西举院巷院区）',
    sources: ['https://xawjw.xa.gov.cn/xxgk/zzjg/zsjg/6124694af8fd1c0bdc4a1b53.html（门厅照片）', 'OSM r17688742', 'Google 卫星 z19'],
    photos: ['scratchpad/pub_agent/imgs/etyy_18.jpg', 'etyy_17.jpg', 'scratchpad/pub_agent/sat/et.jpg'],
    confidence: 'low（高度）；medium（布局）',
    notes: '门厅、东楼位置按卫星量取（±3 m）。高度无资料：院区其余部分（西侧屋顶花园楼）按门厅同高 9 m 保守处理（buildings.bin 14.2 m 会盖住门厅）；东楼 20 m 按照片数层（约 5 层）；'
      + '门厅 9 m 按照片约 2 层，坡屋面矢高 5 m 按照片比例。东楼顶的中式亭阁未建。',
  },
};

// ───── 西安市妇幼保健院（西大街北侧） ─────
// 照片（Commons 2023-09-28 ×2）：西大街统一仿古风貌——灰色石材墙 + 首层红褐面砖/石柱，入口深色石框、金字匾“西安市妇幼保健院”，
// 入口与檐口为深灰筒瓦坡檐。卫星屋面四周可见深灰坡檐。
const fybj = {
  id: 'pub-fybj',
  name: '西安市妇幼保健院',
  fp: 'b9abe57c',
  parts: [{
    name: 'main', fp: 'b9abe57c', base: 0, top: 14.2, roof: { mech: false },
    style: { pattern: 'stoneWindows', spd: '#bdb8ae', tint: '#39434a', floorH: 3.6, colW: 3.2, spandrel: 0.45, mullW: 1.4, lit: 0.5 },
    crown: [{ type: 'hip', top: [58, 43], h: 1.8, eave: 1.3, mat: TILE_GRAY }],
  }],
  bands: [{ part: 'main', levels: [4.6], h: 0.6, depth: 0.35, color: '#6b3a2c' }], // 首层红褐面砖段顶线
  signs: [{ text: '西安市妇幼保健院', part: 'main', face: 'S', y: 4.2, h: 1.3, color: '#c8a45a', bg: '#23324f', fill: 0.35 }],
  supersede: { names: ['西安市妇幼保健院'] },
  meta: {
    category: 'hospital',
    dossier: 'public.json#西安市妇幼保健院',
    sources: ['https://commons.wikimedia.org/wiki/File:西安市妇幼保健院_2023-09-28_01.jpg', 'https://commons.wikimedia.org/wiki/File:西安市妇幼保健院_2023-09-28_02.jpg', 'OSM w1263109032', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安市妇幼保健院_0.jpg', '西安市妇幼保健院_1.jpg', 'scratchpad/pub_agent/sat/g10.jpg'],
    confidence: 'low（高度）；medium（外观）',
    notes: '高度无资料，照片只拍到下部 3 层：取 buildings.bin 14.2 m 兜底；屋顶坡檐矢高 1.8 m 按照片比例。入口金字匾位置按“临西大街”朝南。',
  },
};

// ═════════════════════════ 政府机关 ═════════════════════════

// ───── 陕西省人民政府（新城大院办公楼） ─────
// OSM w1465146336“陕西省人民政府”（180×48 m，北侧中部楼梯间凸出、南侧中部门廊凸出）。照片（Commons 2023-09-29 ×2、panoramio）：
// 对称长板楼，米黄/浅驼色面砖 + 规则竖窗，约 10 层标准层 + 2 层高的中央柱廊门廊；檐口一圈橙褐色挑檐；屋顶两端各一座橙褐琉璃瓦重檐亭阁
// （照片中只有两端两座，档案写的“中央一座”照片未见）。不是 3 层“黄楼”（heritage.json 名称错套）。
const shengzf = {
  id: 'pub-shengzf',
  name: '陕西省人民政府',
  fp: 'f85d1586',
  parts: [
    {
      name: 'slab', base: 0, top: 42, roof: { mech: false },
      pts: [646.5, -664.9, 571.5, -667.1, 571.7, -686.7, 587.2, -686.5, 587.2, -683.7, 621.2, -683.2, 621.3, -686.5, 652.8, -686.1, 653.0, -696.3, 670.7, -696.0, 670.5, -685.7, 702.7, -685.2, 702.6, -682.0, 736.5, -681.5, 736.6, -684.5, 752.1, -684.3, 751.8, -664.4, 676.1, -665.4],
      style: { pattern: 'stoneWindows', spd: '#d8c3a0', tint: '#3a434a', floorH: 3.5, colW: 2.2, spandrel: 0.5, mullW: 1.0, lit: 0.5 },
      crown: [{ type: 'hip', size: [181.5, 20.5], at: [661.8, -675.5], rot: -0.76, top: [180, 19], h: 1.2, eave: 1.6, mat: TILE_ORANGE, eaveMat: '#8a4a26' }],
    },
    {
      name: 'portico', kind: 'podium', base: 0, top: 9.5, // 中央柱廊门廊（2 层高）
      pts: [676.1, -665.4, 676.0, -656.7, 688.4, -656.5, 688.3, -647.8, 634.4, -648.6, 634.5, -657.7, 646.4, -657.6, 646.5, -664.9],
      style: { pattern: 'stoneWindows', spd: '#e2d8c4', tint: '#2a2f33', floorH: 9.5, colW: 4.5, spandrel: 0.12, mullW: 1.6, lit: 0.6 },
      roofMat: { color: '#b9ad98', roughness: 0.9 },
    },
    // 屋顶两端重檐亭阁（照片：位于两端约 1/7 处）
    ...[['pavW', 597, -676.4], ['pavE', 727, -674.6]].map(([name, x, z]) => ({
      name, shape: 'rect', size: [20, 13], at: [x, z], rot: -0.76, base: 42, top: 46.5, roof: { mech: false },
      style: { pattern: 'stoneWindows', spd: '#d8c3a0', tint: '#2a2f33', floorH: 4.5, colW: 2.6, spandrel: 0.3, mullW: 0.8, lit: 0.5 },
      crown: [{ type: 'hip', top: [16, 9], h: 1.8, eave: 2.4, mat: TILE_ORANGE, eaveMat: '#8a4a26' }, { type: 'hip', size: [14, 8], rot: -0.76, h: 4.2, eave: 1.6, ridge: 0.45, mat: TILE_ORANGE, eaveMat: '#8a4a26' }],
    })),
  ],
  supersede: { names: ['陕西省人民政府（新城大院办公楼）', '陕西省人民政府办公大楼（新城大院）', '陕西省人民政府'] },
  meta: {
    category: 'government',
    dossier: 'public.json#陕西省人民政府（新城大院办公楼）（与 core_south.json 重复，按分工在此建）',
    sources: ['OSM w1465146336', 'https://commons.wikimedia.org/wiki/File:陕西省人民政府_2023-09-29_01.jpg', 'https://commons.wikimedia.org/wiki/File:陕西省人民政府_2023-09-29_02.jpg', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/陕西省人民政府_新城大院办公楼__0.jpg', '__1.jpg', '__2.jpg', 'scratchpad/pub_agent/sat/sgov.jpg'],
    confidence: 'medium',
    notes: '高度无资料（CMAB 14.2 m 明显偏低）：按照片数层约 12 层（10 层标准层 + 2 层门廊层）× 3.5 m = 42 m；门廊 9.5 m。'
      + '亭阁位置按照片（Commons 远景正立面，距两端约 14%），尺寸 20×13 m、重檐矢高按照片比例；中央亭阁照片未见，不建。'
      + 'research/refs/landmarks2026/heritage.json 把“黄楼（省政府主楼，18 m/3 层）”套在同一轮廓上（名称错套；该条未进入 public 数据，场景中不生成）。',
  },
};

// ───── 西安市人民政府（西安市行政中心，凤城八路 109 号） ─────
// OSM r18903162（247×240 m 对称院落）。照片（Commons 20201209，从南侧凤城八路俯拍）：前排两段约 4 层的翼楼（中间为中轴入口），
// 后面两座约 11 层高楼；全部为浅灰白石材 + 方窗网格，顶上是外挑很大的深灰“大挑檐帽”（平顶四坡）。
// Google z19：中央区块（x −742…−596、z −9326…−9190）南北两条东西向长屋面（屋面随楼身东偏约 25 m，可见西立面阴影）= 两座高楼。
const shizf = {
  id: 'pub-shizf',
  name: '西安市人民政府',
  fp: '7613d3a2',
  parts: [
    {
      name: 'base', kind: 'podium', fp: '7613d3a2', holes: 'fp', base: 0, top: 20,
      style: { pattern: 'stoneWindows', spd: '#e3e3df', tint: '#2f3b44', floorH: 4.6, colW: 3.4, spandrel: 0.5, mullW: 1.4, lit: 0.5 },
      roofMat: { color: '#7d8388', roughness: 0.8 },
    },
    ...[['towerN', -9308.8], ['towerS', -9207.2]].map(([name, z]) => ({
      name, shape: 'rect', size: [145, 33], at: [-669, z], base: 0, top: 46, roof: { mech: false },
      style: { pattern: 'stoneWindows', spd: '#e3e3df', tint: '#2f3b44', floorH: 3.9, colW: 3.2, spandrel: 0.5, mullW: 1.4, lit: 0.5 },
      crown: [{ type: 'hip', top: [140, 28], h: 3.2, eave: 3.0, mat: TILE_GRAY, eaveMat: '#3a3f44' }],
    })),
  ],
  bands: [{ part: 'base', levels: [19.3], h: 1.4, depth: 2.2, color: '#4a5056' }], // 翼楼深灰挑檐
  supersede: { names: ['西安市人民政府（西安市行政中心）', '西安市人民政府（行政中心办公楼群）', '西安市人民政府', '西安市行政中心'] },
  meta: {
    category: 'government',
    dossier: 'public.json#西安市人民政府（西安市行政中心）（与 north.json 重复，按分工在此建）',
    sources: ['OSM r18903162', "https://commons.wikimedia.org/wiki/File:20201209_The_Building_of_Xi'an_Municipal_People's_Government.jpg", 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安市人民政府_西安市行政中心__0.jpg', 'scratchpad/pub_agent/crop_szf.jpg', 'scratchpad/pub_agent/sat/szfz.jpg'],
    confidence: 'medium（院落/翼楼）；low（高楼分段）',
    notes: '高度无资料：翼楼 20 m 按照片数层（约 4 层 × 4.6 m + 挑檐）；两座高楼 46 m 按照片数层（约 11 层 × 3.9 m + 檐帽）。'
      + '高楼位置按卫星屋面（已按东偏倾斜改正）与轮廓中央区块南北两缘；照片中高楼之间有低一截的连接段，未分段建。'
      + '注：sky-special 的 SPECIAL.gov（key gov）是未央路以东的市委/人大/政协院落，不是本楼，不替代。',
  },
};

// ───── 西安市新城区人民政府 ─────
// OSM w1465145886（59×31 m 矩形）。照片（Commons）：约 7 层米黄面砖两翼（挑出空调板），中部通高蓝色玻璃竖向中庭，
// 顶部一圈红褐色坡檐，入口为红褐琉璃瓦雨棚（门廊上红色标语）。
const xcq = {
  id: 'pub-xinchengqu',
  name: '西安市新城区人民政府',
  fp: '8111cdfa',
  parts: [
    { name: 'main', fp: '8111cdfa', base: 0, top: 27, roof: { mech: false }, style: { pattern: 'stoneWindows', spd: '#d9bf9a', tint: '#3a4650', floorH: 3.8, colW: 2.6, spandrel: 0.45, mullW: 1.1, lit: 0.5 },
      crown: [{ type: 'hip', top: [58, 30], h: 1.4, eave: 1.2, mat: '#9a4f2c' }] },
    { name: 'atrium', kind: 'facade', shape: 'rect', size: [15, 2], at: [1311.7, -857.6], rot: 2.5, base: 0, top: 27, style: { pattern: 'curtain', tint: '#3f6fa8', spd: '#b8c2cc', floorH: 3.8, colW: 1.6, spandrel: 0.1, mullW: 0.1, lit: 0.6 } },
  ],
  supersede: { names: ['西安市新城区人民政府'] },
  meta: {
    category: 'government',
    dossier: 'public.json#西安市新城区人民政府',
    sources: ['https://commons.wikimedia.org/wiki/File:西安市新城区人民政府.jpg', 'OSM w1465145886'],
    photos: ['scratchpad/dossier_res/photos/pub/西安市新城区人民政府_0.jpg'],
    confidence: 'low',
    notes: '轮廓对应为推断（档案）。高度无资料：按照片数层约 7 层 × 3.8 m ≈ 27 m。玻璃中庭放南立面正中——朝向按“坐北朝南”，未核实。',
  },
};

// ───── 西安市长安区人民政府（韦曲） ─────
// OSM w275396702“西安市长安区人民政府”（191×38 m 弧形，两端向南弯，凹面朝南）。照片 caq_5（百家号）：凹弧形蓝色玻璃幕墙办公楼，
// 约 9 层；正中一座高出两层的石材“门”形框（两侧墩柱 + 顶部横梁，框内为竖向格栅），弧楼两端各有石材端墙。
const CA_C = [-3674, 11170], CA_R = -3.3;
const caq = {
  id: 'pub-changanqu',
  name: '西安市长安区人民政府',
  fp: '40a23315',
  parts: [
    { name: 'arc', fp: '40a23315', base: 0, top: 34, style: { pattern: 'curtain', tint: '#3c6a9a', spd: '#cfd5da', floorH: 3.8, colW: 1.8, spandrel: 0.18, mullW: 0.14, lit: 0.55 } },
    ...[-1, 1].map((s, i) => ({
      name: 'pier' + i, kind: 'solid', mat: '#d9d6ce', shape: 'rect', size: [10, 24], rot: CA_R,
      at: [CA_C[0] + s * 20 * Math.cos(CA_R * Math.PI / 180), CA_C[1] - s * 20 * Math.sin(CA_R * Math.PI / 180)], base: 0, top: 41.5,
    })),
    { name: 'lintel', kind: 'solid', mat: '#d9d6ce', shape: 'rect', size: [50, 24], rot: CA_R, at: CA_C, base: 34, top: 41.5, footprint: false },
  ],
  supersede: { names: ['西安市长安区人民政府'] },
  meta: {
    category: 'government',
    dossier: 'public.json#西安市长安区人民政府（与 east_west.json 重复，按分工在此建）',
    sources: ['OSM w275396702', 'https://baijiahao.baidu.com/s?id=1577858635017433123（照片）'],
    photos: ['scratchpad/pub_agent/imgs/caq_5.jpg'],
    confidence: 'medium（形体）；low（高度）',
    notes: '高度无资料（buildings.bin 10 m 明显偏低）：按照片数层约 9 层 × 3.8 m ≈ 34 m；中央门框高出约 2 层 → 41.5 m，宽约 50 m（照片比例），'
      + '位置取弧楼正中（弧线切向 −3.3°）。',
  },
};

// ───── 陕西大会堂（丈八北路陕西宾馆内） ─────
// 没有 Overture 轮廓（OSM w1417904093 把东北侧相邻建筑一起圈进）。Google z19 量取：外圈深灰坡屋面约 142×143 m（中心 −7015.5, 6290.5），
// 中部浅色平屋顶约 83×76 m（采光带 + 太阳能板）。百度百科摘要：四面柱廊，每面 8 根直径 2.4 m、高 10 余米的廊柱。
const DHT = [-7015.5, 6290.5];
const DHT_COL = [];
for (let k = 0; k < 8; k++) {
  const u = -56 + k * 16;
  DHT_COL.push([DHT[0] + u, DHT[1] - 66.5], [DHT[0] + u, DHT[1] + 66.5], [DHT[0] - 67.5, DHT[1] + u], [DHT[0] + 67.5, DHT[1] + u]);
}
const dht = {
  id: 'pub-dahuitang',
  name: '陕西大会堂',
  center: DHT,
  parts: [
    {
      name: 'hall', shape: 'rect', size: [128, 128], at: DHT, base: 0, top: 14, roof: { mech: false },
      style: { pattern: 'stoneWindows', spd: '#d7d2c6', tint: '#2d3439', floorH: 7, colW: 4.0, spandrel: 0.35, mullW: 1.6, lit: 0.6 },
      crown: [{ type: 'hip', top: [86, 80], h: 8, eave: 7, mat: TILE_GRAY, eaveMat: '#3a3f44' }],
    },
    { name: 'core', shape: 'rect', size: [82, 76], at: DHT, base: 0, top: 24, roof: { mech: true }, style: { pattern: 'stoneWindows', spd: '#d7d2c6', tint: '#2d3439', floorH: 6, colW: 4.0, spandrel: 0.5, mullW: 1.6, lit: 0.5 } },
    ...DHT_COL.map((at, i) => ({ name: 'col' + i, kind: 'solid', mat: '#e8e4dc', shape: 'circle', size: [2.4, 2.4], shapeOpt: { seg: 12 }, at, base: 0, top: 13.2 })),
  ],
  supersede: { names: ['陕西大会堂'] },
  meta: {
    category: 'government',
    dossier: 'public.json#陕西大会堂',
    sources: ['https://baike.baidu.com/item/陕西大会堂（四面柱廊，经档案搜索摘要）', 'public/data/pois.json 陕西大会堂', 'Google 卫星 z19（外圈与中部屋面量取）'],
    photos: ['scratchpad/pub_agent/sat/dht.jpg', 'scratchpad/pub_agent/imgs/dht_17.jpg', 'dht_3.jpg'],
    confidence: 'medium（平面）；low（高度）',
    notes: '平面按卫星量取（±3 m）。高度无资料，保守处理：柱高按“10 余米”取 13.2 m，檐口 14 m，外圈坡屋面矢高 8 m、中部平顶体量 24 m'
      + '（北侧阴影明显长于外圈檐口，确有高起的中部体量；具体高度未能标定）。柱廊每面 8 根、间距 16 m 均布。',
  },
};

// ═════════════════════════ 高校 ═════════════════════════

// ───── 西安交通大学钱学森图书馆 ─────
// 轮廓 cafc0ed6（OSM w263624481）同时包含北楼（1961，“山”字形 4 层 + 南侧 5 层书库）与南楼（1991，II 段地上 11 层 + 机房水箱 2 层，
// 两翼 I、III 段 3 层）——交大官网、西安市地方志。按轮廓切分（北楼 z<1352、书库、南楼）。
// 航拍照片（Commons“西交兴庆之俯瞰钱学森图书馆”，自北向南，远处秦岭）：北楼对称、中部红色立柱门廊；南楼中部塔身两侧逐级退台（三级），
// 顶部为略窄的机房层；两翼为绿化屋面。米黄/浅粉灰面砖 + 竖向窗。
const QX = 3369.5, QZ = 1421;
const LIB_TILE = { pattern: 'stoneWindows', spd: '#d6cabb', tint: '#2f3d4f', floorH: 4.1, colW: 2.6, spandrel: 0.42, mullW: 0.95, lit: 0.6 };
const qxslib = {
  id: 'pub-xjtu-qxslib',
  name: '钱学森图书馆',
  fp: 'cafc0ed6',
  parts: [
    {
      name: 'north', kind: 'podium', base: 0, top: 19, // 北楼 4 层（1961 苏式，层高按约 4.7 m）
      pts: [3390.7, 1351.6, 3377.8, 1351.4, 3377.1, 1329.1, 3421.3, 1329.9, 3421.8, 1347.3, 3433.0, 1347.3, 3433.2, 1323.0, 3427.1, 1322.9, 3427.1, 1307.1, 3316.0, 1306.0, 3316.1, 1322.3, 3309.2, 1322.3, 3309.3, 1347.8, 3324.0, 1347.9, 3324.0, 1329.9, 3363.5, 1329.4, 3363.6, 1352.0],
      style: { ...LIB_TILE, spd: '#cfc8bc', floorH: 4.7, colW: 3.2 },
      roofMat: { color: '#8e8f8c', roughness: 0.9 },
    },
    {
      name: 'stack', kind: 'podium', base: 0, top: 20, // 北楼南侧 5 层书库 + 中部连廊
      pts: [3363.6, 1352.0, 3390.7, 1352.0, 3391.0, 1366.0, 3377.2, 1365.5, 3377.4, 1395.8, 3363.5, 1395.5],
      style: { ...LIB_TILE, spd: '#cfc8bc', floorH: 4.0 },
      roofMat: { color: '#8e8f8c', roughness: 0.9 },
    },
    {
      name: 'wings', kind: 'podium', base: 0, top: 14, // 南楼两翼 3 层（绿化屋面）
      pts: [3315.8, 1408.6, 3337.3, 1408.1, 3351.9, 1395.7, 3363.5, 1395.5, 3363.3, 1408.9, 3349.4, 1409.1, 3334.5, 1424.3, 3333.9, 1433.0, 3359.5, 1433.0, 3354.9, 1439.5, 3344.9, 1439.5, 3344.9, 1450.5, 3395.8, 1450.7, 3395.8, 1439.2, 3385.7, 1438.8, 3380.0, 1432.7, 3402.5, 1433.0, 3402.7, 1424.2, 3388.9, 1410.1, 3376.7, 1409.3, 3376.9, 1395.8, 3389.1, 1396.5, 3403.8, 1407.4, 3425.4, 1407.9, 3413.1, 1394.0, 3328.3, 1394.0],
      style: LIB_TILE,
      roofMat: { color: '#6f8a5b', roughness: 0.9 },
    },
    // 南楼 II 段：三级退台（照片自北看：两侧在约 5 层、8 层处各退一级，中部塔身通高 11 层）
    { name: 'tier1', shape: 'rect', size: [66, 44], at: [QX, QZ], base: 0, top: 22, style: LIB_TILE },
    { name: 'tier2', shape: 'rect', size: [54, 40], at: [QX, QZ], base: 0, top: 34, style: LIB_TILE },
    { name: 'tier3', shape: 'rect', size: [38, 36], at: [QX, QZ], base: 0, top: 46, style: LIB_TILE },
    { name: 'cap', shape: 'rect', size: [24, 18], at: [QX, QZ], base: 46, top: 54, style: { ...LIB_TILE, colW: 3.4 }, roof: { mech: false } }, // 机房、水箱 2 层
  ],
  signs: [
    { text: '钱学森图书馆', part: 'tier1', face: 'S', y: 11, h: 3.4, color: '#2b2a28', weight: 700, serif: true }, // 深色书法立体字（Commons 照片）
  ],
  supersede: { names: ['西安交通大学钱学森图书馆', '西安交通大学·兴庆校区 钱学森图书馆'] },
  meta: {
    category: 'university',
    dossier: 'public.json#西安交通大学钱学森图书馆',
    sources: ['https://www.xjtu.edu.cn/tsda/qxstsg.htm', 'https://xadfz.xa.gov.cn/xadq/rwxa/645c431cf8fd1c1a702b73ee.html', 'OSM w263624481', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安交通大学钱学森图书馆_2.jpg（航拍，自北向南）', '西安交通大学钱学森图书馆_0.jpg（入口字）'],
    confidence: 'high（层数/年代）；medium（退台尺寸）',
    notes: '层高无资料：北楼 4 层 × 4.7 m ≈ 19 m、书库 5 层 × 4 m = 20 m、两翼 3 层 ≈ 14 m、塔身 11 层 × 4.2 m ≈ 46 m、机房水箱 2 层至 54 m。'
      + '退台位置按照片数层（两侧在第 5、8 层处退台），退台宽度按卫星屋面量取（±3 m）。航拍中塔后方带钟面与镂空方框的高塔是主楼 E 座，不属于图书馆。',
  },
};

// ───── 西安交通大学兴庆校区 教学主楼群（A–E 座） ─────
// 教学主楼群为南北中轴线上最后建设的项目：占地 5300 ㎡、总高 107.45 m；A–D 座为多层讲堂（均不超过 24 m），E 座为高层科研办公（百度百科“西安交通大学主楼群”）。
// Overture 命名轮廓：A 座 d26120ca、B 座 808288f0、C 座 e53ad41a、D 座 05572c84、E 座 9db78d67；档案条目的 9d91e9f6 为 A、B 之间的中部门厅（北侧带台阶平台）。
// 照片（Commons Zhulou xjtu.jpg；钱学森图书馆航拍远景）：E 座为方塔，四角石材墩柱通高，顶部为镂空“门框”（墩柱 + 顶部横梁，中间透空），
// 墩柱之间为深色玻璃竖向窗带，北立面中部有钟面；底部为米黄石材低层讲堂。
const EX = 3368.8, EZ = 1650.7, EW = 40.5, ED = 37.8;
const E_STONE = { color: '#d8d0c2', roughness: 0.75 };
const xjtuMain = {
  id: 'pub-xjtu-main',
  name: '西安交通大学主楼',
  center: [EX, EZ],
  parts: [
    {
      name: 'eBody', shape: 'rect', size: [EW - 6, ED - 6], at: [EX, EZ], base: 0, top: 88, // 墩柱之间的玻璃塔身
      style: { pattern: 'verticalFins', tint: '#3d4a55', spd: '#cfc6b6', floorH: 4.0, colW: 2.2, spandrel: 0.2, mullW: 0.5, lit: 0.55 },
      roof: { mech: true },
    },
    // 四角石材墩柱（通高至 107.45 m）
    ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz], i) => ({
      name: 'pier' + i, kind: 'solid', mat: E_STONE, shape: 'rect', size: [8, 8], at: [EX + sx * (EW / 2 - 4), EZ + sz * (ED / 2 - 4)], base: 0, top: 107.45,
    })),
    // 顶部横梁（镂空门框的上框）
    { name: 'lintelN', kind: 'solid', mat: E_STONE, shape: 'rect', size: [EW, 5], at: [EX, EZ - ED / 2 + 2.5], base: 100.5, top: 107.45, footprint: false },
    { name: 'lintelS', kind: 'solid', mat: E_STONE, shape: 'rect', size: [EW, 5], at: [EX, EZ + ED / 2 - 2.5], base: 100.5, top: 107.45, footprint: false },
    { name: 'lintelW', kind: 'solid', mat: E_STONE, shape: 'rect', size: [5, ED], at: [EX - EW / 2 + 2.5, EZ], base: 100.5, top: 107.45, footprint: false },
    { name: 'lintelE', kind: 'solid', mat: E_STONE, shape: 'rect', size: [5, ED], at: [EX + EW / 2 - 2.5, EZ], base: 100.5, top: 107.45, footprint: false },
    // A–D 座讲堂（≤24 m，按照片约 5 层）
    ...[['A', 'd26120ca-aa68-4745-a43d-443a80646d7d'], ['B', '808288f0-6804-4848-bf9e-a568e4d94985'], ['C', 'e53ad41a-8a61-4e34-b775-cd8bb066000e'], ['D', '05572c84-6cb2-4d56-8dd2-22a754d89ffa']].map(([n, fp]) => ({
      name: 'hall' + n, kind: 'podium', fp, base: 0, top: 22,
      style: { ...STONE_BEIGE, spd: '#d8d0c2', floorH: 4.4, colW: 3.0, spandrel: 0.5 },
      roofMat: { color: '#9a978f', roughness: 0.9 },
    })),
    {
      name: 'lobby', kind: 'podium', fp: '9d91e9f6', base: 0, top: 9, // 中部门厅 + 北侧台阶平台
      style: { ...STONE_BEIGE, spd: '#d8d0c2', floorH: 4.5, colW: 3.0 },
      roofMat: { color: '#b3aea3', roughness: 0.9 },
    },
  ],
  supersede: { names: ['西安交通大学兴庆校区主楼群（中心楼·主楼A–G座）', '西安交通大学·兴庆校区 主楼E座', '西安交通大学·兴庆校区 主楼A座', '西安交通大学·兴庆校区 主楼B座', '西安交通大学·兴庆校区 主楼C座', '西安交通大学·兴庆校区 主楼D座'] },
  meta: {
    category: 'university',
    dossier: 'public.json#西安交通大学兴庆校区主楼群（中心楼·主楼A–G座）',
    sources: ['https://baike.baidu.com/item/西安交通大学主楼群/18451101（总高107.45 m，A–D座≤24 m，经 WebSearch 摘要）', 'OSM w263624057–w263624061（主楼A–E座命名）/ w264595812', 'Google / Esri 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安交通大学兴庆校区主楼群_中心楼_主楼A_G座__2.jpg', 'scratchpad/pub_agent/crop_qxs.jpg（钱图航拍远景中的 E 座北立面）'],
    confidence: 'high（总高）；medium（分段）',
    notes: 'E 座 107.45 m 为墩柱/门框顶；玻璃塔身顶 88 m、横梁 100.5–107.45 m 按照片比例估（门框透空约占塔高 1/6）。'
      + 'A–D 座按“不超过 24 m”取 22 m（照片约 5 层）；中部门厅 9 m 按卫星判读为 2 层低体量（保守）。钟面未建。',
  },
};

// ───── 西安交通大学 腾飞塔（兴庆校区北门内中轴） ─────
// 照片（360 图片检索 tft 一组 20 余张，均为同一视角的校园中轴）：方锥形石材方尖塔，上部开竖向通透槽、顶端白色展翅飞鸟雕塑，
// 塔脚坐落一尊白色人像雕塑；北门广场红色“工”字形台座（卫星）。Esri z19：塔脚 (3366, 1208)，塔影向西北。
const tengfei = {
  id: 'pub-xjtu-tengfei',
  name: '腾飞塔',
  center: [3366, 1208],
  parts: [
    { name: 'plinth', kind: 'solid', mat: '#9a5a4a', shape: 'rect', size: [7, 7], at: [3366, 1208], base: 0, top: 1.2 },
    { name: 'shaft', kind: 'solid', mat: { color: '#d8c6ae', roughness: 0.75 }, shape: 'rect', size: [3.4, 3.4], at: [3366, 1208], base: 1.2, top: 24.5, taper: 0.42 },
    { name: 'bird', kind: 'solid', mat: '#f2f0ea', shape: 'triangle', size: [3.2, 1.6], shapeOpt: { apex: 0.2 }, at: [3366, 1208], rot: 90, base: 24.5, top: 27, footprint: false },
  ],
  label: { text: '腾飞塔', priority: 1.2 },
  meta: {
    category: 'university',
    dossier: '（public.json 未收录；用户点名的交大标志物）',
    sources: ['https://www.meet99.com/jingdian-xiAnjiaotongdaxue-26836.html（塔顶鸟形白色雕塑）', 'https://baike.baidu.com/item/腾飞塔/65535785（经 WebSearch 摘要：“中央塔体高约15米”，与照片比例不符，未采用）', 'Esri World Imagery z18/z19（塔影）'],
    photos: ['scratchpad/pub_agent/imgs/tft.jpg（检索拼版）', 'scratchpad/pub_agent/sat/tft3.jpg', 'scratchpad/pub_agent/sat/tcal.jpg'],
    confidence: 'low（高度）',
    notes: '高度无可靠资料：按 Esri 影像塔影 22.6 m、以同幅影像中主楼 E 座（107.45 m）的影长比约 0.82 标定 → 约 27 m（含顶端雕塑，±5 m）。'
      + '百科摘要的“中央塔体约 15 米”可能只指塔身中段，照片中塔高远超 4 层的中心楼，未采用。塔身截面 3.4 m、收分 0.42 按照片比例；上部通透槽未建。',
  },
};

// ───── 西北工业大学友谊校区图书馆 ─────
// 院落式组合：北翼 adf3dc0e、南翼 fc34603b（OSM levels 5）、西侧入口体量 f3470557（OSM“西北工业大学 图书馆”，西面卫星可见一道外凸弧墙）、
// 东侧圆形体量 0d19355c（OSM levels 5，卫星为圆厅 + 放射座椅）；中间为下沉庭院。照片（Commons 2024-09-15）：米黄石材实墙 +
// 蓝绿玻璃竖向窗带，中部为凹弧形通高玻璃面，入口上方竖排“图书馆”匾。
const XG_STYLE = { pattern: 'stoneWindows', spd: '#d8cdb8', tint: '#4f7f9a', floorH: 4.2, colW: 3.0, spandrel: 0.35, mullW: 1.6, lit: 0.6 };
const xgdlib = {
  id: 'pub-nwpu-lib',
  name: '西北工业大学图书馆',
  fp: 'f3470557',
  parts: [
    { name: 'west', fp: 'f3470557', base: 0, top: 21, style: { ...XG_STYLE, pattern: 'verticalFins', spd: '#d8cdb8', colW: 2.2, mullW: 0.9, spandrel: 0.2 } },
    { name: 'north', fp: 'adf3dc0e', base: 0, top: 21, style: XG_STYLE },
    { name: 'south', fp: 'fc34603b', base: 0, top: 21, style: XG_STYLE },
    { name: 'east', fp: '0d19355c-a4da-41fc-91ba-8528d3fa3c36', base: 0, top: 21, style: { ...XG_STYLE, pattern: 'curtain', tint: '#4f7f9a', spd: '#d8cdb8', colW: 1.6, mullW: 0.2 } },
  ],
  supersede: { names: ['西北工业大学友谊校区图书馆', '西北工业大学·友谊校区 西北工业大学 图书馆'] },
  meta: {
    category: 'university',
    dossier: 'public.json#西北工业大学友谊校区图书馆',
    sources: ['OSM w1267628278 / w1267628912 / w1267629927 / w1267628708（building:levels=5）', 'https://commons.wikimedia.org/wiki/File:西北工业大学友谊校区图书馆.jpg', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西北工业大学友谊校区图书馆_0.jpg', 'scratchpad/pub_agent/sat/xgd.jpg'],
    confidence: 'medium',
    notes: '层数取 OSM building:levels=5，层高按 4.2 m → 21 m（米制高度无资料）。竖排“图书馆”匾未建（招牌库只支持横排）；西侧外凸弧墙、圆厅放射座椅未建。',
  },
};

// ───── 西北大学（太白校区）：博物馆 + 北门门楼 ─────
// 照片（Commons 2014，自城墙向南）：博物馆 f5862b1f 为白色石材方盒，大面实墙、上部小窗，东北角内凹通高玻璃入口，北立面顶部黑字“西北大学博物馆”+ 红色校徽；
// 其东侧校门为灰瓦歇山门楼（通透三开间），后面是约 11 层白色主楼。卫星 z19：门楼屋面约 16×16 m，两侧各一圆形花坛。
const nwu = {
  id: 'pub-nwu',
  name: '西北大学博物馆',
  fp: 'f5862b1f',
  parts: [
    {
      name: 'museum', kind: 'podium', fp: 'f5862b1f', base: 0, top: 17,
      style: { pattern: 'stoneWindows', spd: '#e2e0da', tint: '#2f4a44', floorH: 4.2, colW: 6.0, spandrel: 0.75, mullW: 4.2, lit: 0.35 },
      roofMat: { color: '#c9c6bf', roughness: 0.9 },
    },
    // 北门门楼：8 根柱 + 额枋 + 歇山灰瓦顶（柱网 16×12 m）
    ...[[-6, -4.5], [-2, -4.5], [2, -4.5], [6, -4.5], [-6, 4.5], [-2, 4.5], [2, 4.5], [6, 4.5]].map(([u, w], i) => ({
      name: 'gcol' + i, kind: 'solid', mat: '#7b2b22', shape: 'rect', size: [0.9, 0.9], at: [-1860 + u, 987 + w], base: 0, top: 6.8,
    })),
    {
      name: 'gbeam', kind: 'solid', mat: '#5a3a30', shape: 'rect', size: [14, 11], at: [-1860, 987], base: 6.8, top: 7.8, footprint: false,
      crown: [{ type: 'hip', h: 4.2, eave: 2.2, ridge: 0.55, mat: TILE_GRAY }],
    },
  ],
  signs: [{ text: '西北大学博物馆', part: 'museum', face: 'N', near: 'E', y: 14, h: 2.4, color: '#2b2b2b', serif: true }],
  supersede: { names: ['西北大学博物馆（太白校区）', '西北大学·太白校区 西北大学博物馆', '西北大学博物馆'] },
  meta: {
    category: 'university',
    dossier: 'public.json#西北大学博物馆（太白校区）',
    sources: ['https://commons.wikimedia.org/wiki/File:Museum_of_Northwest_University.JPG', 'https://commons.wikimedia.org/wiki/File:Northwest_University_Taibai_Campus.JPG', 'OSM w1283517931', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西北大学太白校区_大门_博物馆__0.jpg', '西北大学太白校区_大门_博物馆__1.jpg', 'scratchpad/pub_agent/imgs/xbdx.jpg', 'scratchpad/pub_agent/sat/xbdx.jpg'],
    confidence: 'medium（外观）；low（高度）',
    notes: '博物馆高度无资料（CMAB 12.6 m）：按照片约 4 层 × 4.2 m ≈ 17 m（与停在北侧的轿车对比）。门楼位置/屋面尺寸按卫星量取（±2 m），'
      + '柱高 6.8 m、屋面矢高 4.2 m 按照片比例。门楼后面的 11 层主楼（Overture 13178ca7）不在档案内，未建。',
  },
};

// ───── 长安大学渭水校区逸夫图书馆 ─────
// 主楼 42e588d3（OSM“逸夫图书馆”，长轴 20°）+ 环抱南侧半圆广场的弧形裙楼 c2a124db（OSM“图书馆教学楼”，levels 2）。
// 照片（Commons ChdUniversityLibrary、Chang'an University Gate）：主楼正面中部通高蓝灰玻璃幕墙、两侧浅灰石材实墙框，楼顶红色书法“长安大学”；
// 弧形裙楼为低层玻璃廊。长安大学官网：主体地上 13 层、约 4.5 万㎡。
const cdlib = {
  id: 'pub-chd-lib',
  name: '长安大学逸夫图书馆',
  fp: '42e588d3',
  parts: [
    { name: 'main', fp: '42e588d3', base: 0, top: 52, style: { pattern: 'grid', tint: '#3c5874', spd: '#c9c7c2', floorH: 4.0, colW: 2.0, spandrel: 0.22, mullW: 0.35, lit: 0.6 } },
    {
      name: 'arc', kind: 'podium', fp: 'c2a124db', base: 0, top: 9,
      style: { pattern: 'retail', tint: '#4a6478', spd: '#c9c7c2', floorH: 4.5, colW: 3.0, spandrel: 0.2, mullW: 0.3, lit: 0.8 }, roofMat: { color: '#8e8c86', roughness: 0.85 },
    },
  ],
  signs: [{ text: '长安大学', part: 'main', face: 'SSE', y: 56, h: 6, color: '#c0282d', serif: true }],
  supersede: { names: ['长安大学渭水校区逸夫图书馆', '逸夫图书馆'] },
  meta: {
    category: 'university',
    dossier: 'public.json#长安大学渭水校区逸夫图书馆',
    sources: ['长安大学官网“建筑地标”（地上13层，经档案检索摘要）', "https://commons.wikimedia.org/wiki/File:ChdUniversityLibrary.jpg", 'OSM w1091739070 / w1194050476', 'buildings.bin（52 m，flags 实测位）', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/长安大学渭水校区逸夫图书馆_0.jpg', '长安大学渭水校区逸夫图书馆_1.jpg', 'scratchpad/pub_agent/sat/cd.jpg'],
    confidence: 'medium',
    notes: '主楼高 52 m 取 buildings.bin（带实测标记，与 13 层 × 4 m 相符）。弧形裙楼 2 层（OSM levels）× 4.5 m = 9 m（buildings.bin 6.2 m 偏低，照片约为主楼 1/5）。'
      + '屋顶字朝向南侧半圆广场（SSE）。',
  },
};

// ───── 陕西师范大学雁塔校区图书馆（1950 年代） ─────
// OSM w1409939791“图书馆”（南北向 115×27 m，两端带翼）。卫星：深灰坡屋面长楼。照片（360 图片检索 sdtsg 一组）：红褐砖墙 + 浅色石材线脚，
// 满墙爬山虎，对称立面、中部入口，3 层。
const SNNU_BRICK = { pattern: 'stoneWindows', spd: '#8e4f3f', tint: '#34414b', floorH: 4.6, colW: 3.0, spandrel: 0.5, mullW: 1.4, lit: 0.55 };
const sdlib = {
  id: 'pub-snnu-lib',
  name: '陕西师范大学图书馆',
  fp: 'd908ba9a',
  parts: [
    { name: 'mid', shape: 'rect', size: [66.4, 20.3], at: [297.9, 6260.6], rot: 90, base: 0, top: 14, style: SNNU_BRICK, roof: { mech: false }, crown: [{ type: 'hip', h: 6, eave: 1.2, mat: TILE_GRAY }] },
    { name: 'wingN', shape: 'rect', size: [27.3, 24.1], at: [294.3, 6215.5], base: 0, top: 14, style: SNNU_BRICK, roof: { mech: false }, crown: [{ type: 'hip', h: 6, eave: 1.2, mat: TILE_GRAY }] },
    { name: 'wingS', shape: 'rect', size: [25.1, 24.8], at: [293.8, 6306.1], base: 0, top: 14, style: SNNU_BRICK, roof: { mech: false }, crown: [{ type: 'hip', h: 6, eave: 1.2, mat: TILE_GRAY }] },
  ],
  supersede: { names: ['陕西师范大学雁塔校区图书馆'] },
  meta: {
    category: 'university',
    dossier: 'public.json#陕西师范大学雁塔校区图书馆',
    sources: ['OSM w1409939791', 'research/refs/landmarks2026 venues.json（3 层）', 'Google 卫星 z19'],
    photos: ['scratchpad/pub_agent/imgs/sdtsg.jpg（检索拼版：9、10、12、13、21 号为该楼）', 'scratchpad/pub_agent/sat/g28.jpg'],
    confidence: 'low（照片与轮廓对应为推断）',
    notes: '3 层（档案）× 4.6 m ≈ 14 m 檐口；四坡灰瓦矢高 6 m 按卫星屋面宽度与常见坡度（约 30°）估。三段体块按 OSM 轮廓拆分。',
  },
};

// ───── 西安建筑科技大学雁塔校区图书馆 ─────
// OSM r17610788“图书馆”（building:levels 5，三翼放射形围合中心庭院，含 2 个内环）。没有能与轮廓确认对应的外观照片 → 保守处理。
const xjdlib = {
  id: 'pub-xauat-lib',
  name: '西安建筑科技大学图书馆',
  fp: 'ba729f70',
  parts: [{ name: 'main', kind: 'podium', fp: 'ba729f70', holes: 'fp', base: 0, top: 21, style: { ...STONE_BEIGE, spd: '#cfc6b6', floorH: 4.2 }, roofMat: { color: '#9a978f', roughness: 0.9 } }],
  supersede: { names: ['西安建筑科技大学雁塔校区图书馆', '西安建筑科技大学·雁塔校区 图书馆'] },
  meta: {
    category: 'university',
    dossier: 'public.json#西安建筑科技大学雁塔校区图书馆',
    sources: ['OSM r17610788（building:levels=5）', 'Google 卫星 z19'],
    photos: ['scratchpad/pub_agent/sat/g30.jpg'],
    confidence: 'low（外观）',
    notes: '5 层（OSM levels）× 4.2 m = 21 m；外观无可确认照片，立面按米灰石材保守处理（buildings.bin 12.6 m 偏低）。',
  },
};

// ───── 西安电子科技大学北校区大礼堂 ─────
// OSM w1413302029“西安电子科技大学-大礼堂”（81×45 m，长轴 62°）。卫星：深灰双坡屋面。无照片 → 保守处理。
const xdlt = {
  id: 'pub-xidian-hall',
  name: '西安电子科技大学大礼堂',
  fp: '821a501f',
  parts: [{
    name: 'hall', fp: '821a501f', base: 0, top: 9, style: { ...STONE_BEIGE, spd: '#cbc3b4', floorH: 4.5, colW: 4.0 },
    crown: [{ type: 'hip', h: 6, eave: 1.0, ridge: 0.92, mat: TILE_GRAY }],
  }],
  supersede: { names: ['西安电子科技大学北校区大礼堂', '西安电子科技大学·北校区（太白南路） 西安电子科技大学-大礼堂'] },
  meta: {
    category: 'university',
    dossier: 'public.json#西安电子科技大学北校区大礼堂',
    sources: ['OSM w1413302029', 'Google 卫星 z19'],
    photos: ['scratchpad/pub_agent/sat/g26.jpg'],
    confidence: 'low',
    notes: '檐高取 buildings.bin 9 m 兜底；双坡屋面（ridge 0.92 近似硬山）矢高 6 m 按卫星屋脊与常见礼堂坡度估。立面无照片，保守处理。',
  },
};

// ═════════════════════════ 区级公共设施：博物馆 / 体育场 / 客运站 ═════════════════════════

// ───── 陕西自然博物馆（陕西科技馆新馆 · 球幕） ─────
// OSM w254328024（131×46 m，南北向）：北端为外径 38 m 的银灰色三角网格玻璃球（球幕影院 18 m，馆方/地方志），南部为 3 层展馆（中间天井）。
// 照片（Commons 2025-11-13）：球体坐在一层高的石材门厅之后，门厅上“陕西自然博物馆”题字。卫星：球心约在轮廓北端 (−40, 6875)。
const zrbwg = {
  id: 'pub-shaanxi-natural-museum',
  name: '陕西自然博物馆',
  fp: '719faa0f',
  parts: [
    {
      name: 'hall', kind: 'podium', base: 0, top: 15, // 南部 3 层展馆
      pts: [-16.6, 6984.0, -28.7, 6984.1, -28.9, 6959.1, -50.4, 6959.2, -50.2, 6984.4, -62.7, 6984.5, -63.3, 6897, -17.3, 6897],
      style: { pattern: 'stoneWindows', spd: '#c8c0b0', tint: '#3c4a55', floorH: 5.0, colW: 4.0, spandrel: 0.55, mullW: 2.0, lit: 0.5 },
      roofMat: { color: '#a8a296', roughness: 0.9 },
    },
    {
      name: 'lobby', kind: 'podium', base: 0, top: 6, // 球体下的一层门厅（照片）
      pts: [-63.8, 6854.0, -17.6, 6853.6, -17.3, 6897, -63.3, 6897],
      style: { pattern: 'stoneWindows', spd: '#c8c0b0', tint: '#2f3b44', floorH: 6, colW: 4.0, spandrel: 0.3, mullW: 1.4, lit: 0.6 },
      roofMat: { color: '#a8a296', roughness: 0.9 },
      crown: [{ type: 'sphere', r: 19, cy: 19, at: [-40.2, 6875.5], mat: { color: '#9aa3aa', metalness: 0.65, roughness: 0.18 }, ribs: 18, ribMat: '#3c3f42' }],
    },
  ],
  signs: [{ text: '陕西自然博物馆', part: 'lobby', face: 'N', y: 4.6, h: 1.6, color: '#3a3a36', serif: true }],
  supersede: { names: ['陕西自然博物馆'] },
  meta: {
    category: 'culture',
    dossier: 'public.json#陕西自然博物馆',
    sources: ['OSM w254328024', '陕西自然博物馆官网 / 地方志（球体外径 38 m，经档案检索摘要）', 'https://commons.wikimedia.org/wiki/File:陕西自然博物馆.jpg', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/陕西自然博物馆_0.jpg', 'scratchpad/pub_agent/sat/g37.jpg'],
    confidence: 'high（球径）；medium（展馆）',
    notes: '球径 38 m（资料），球底落地、球心离地 19 m；展馆 3 层（档案）× 5 m = 15 m；门厅 6 m 按照片。球心位置按卫星量取（±2 m）。'
      + '门厅题字朝向按照片（门前为道路与停车场，推断朝北，未核实）。档案所述“月牙形自然馆”与 OSM 矩形轮廓不符，按轮廓建。',
  },
};

// ───── 西安市人民体育场（东新街北侧） ─────
// OSM r6848524（212×157 m 椭圆环，内环为场地）。卫星：环形看台满铺黄色座椅，西侧主看台为矩形楼。照片（Commons 北门）只有门楼。
const rmtyc = {
  id: 'pub-renmin-stadium',
  name: '西安市人民体育场',
  fp: '2d12a9ed',
  parts: [{
    name: 'stands', kind: 'podium', fp: '2d12a9ed', holes: 'fp', base: 0, top: 12.6,
    style: { pattern: 'stoneWindows', spd: '#d8d4c8', tint: '#3a444c', floorH: 4.2, colW: 5.0, spandrel: 0.6, mullW: 3.0, lit: 0.4 },
    roofMat: { color: '#d9b23a', roughness: 0.8 }, // 黄色看台座椅（卫星）
  }],
  supersede: { names: ['西安市人民体育场'] },
  meta: {
    category: 'sports',
    dossier: 'public.json#西安市人民体育场',
    sources: ['OSM r6848524', 'https://commons.wikimedia.org/wiki/File:西安市人民体育场北门.jpg', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安市人民体育场_0.jpg', 'scratchpad/pub_agent/sat/g45.jpg'],
    confidence: 'medium（平面）；low（高度）',
    notes: '看台高度无资料：取 buildings.bin 12.6 m 兜底，看台面做成平屋面并用黄色表示座椅。北门门楼（深灰弧顶门楣 + 方柱、金字“西安市人民体育场”）'
      + '照片无法确定落位，未建。',
  },
};

// ───── 西安城南客运站 ─────
// OSM w360836368“西安城南客运站”（141×39 m 矩形）。照片（Commons 2019）：米黄/土黄色外墙，上部一道横带，屋顶红色“西安城南客运站”
// 与英文“XI'AN CHENGNAN COACH STATION”，中部屋顶一段深色体量；卫星：北侧为旅客广场/停车场，南侧为发车位 + 白色膜结构雨棚。
const csky = {
  id: 'pub-chengnan-coach',
  name: '西安城南客运站',
  fp: '5a28856a',
  parts: [
    { name: 'main', fp: '5a28856a', base: 0, top: 12.6, style: { pattern: 'stoneWindows', spd: '#d9ab6c', tint: '#3a4650', floorH: 5.5, colW: 3.6, spandrel: 0.45, mullW: 1.2, lit: 0.6 } },
    { name: 'box', shape: 'rect', size: [22, 18], at: [-829, 8236.5], base: 12.6, top: 16.5, style: { pattern: 'grid', tint: '#2a3036', spd: '#2d3136', floorH: 3.9, colW: 2.0, spandrel: 0.5, mullW: 0.3, lit: 0.3 }, roof: { mech: false } },
  ],
  bands: [{ part: 'main', levels: [10.2], h: 1.4, depth: 0.3, color: '#b8864a' }],
  signs: [
    { text: '西安城南客运站', part: 'main', face: 'N', near: 'W', y: 15.2, h: 3.2, color: '#c8102e' },
    { text: "XI'AN CHENGNAN COACH STATION", part: 'main', face: 'N', near: 'W', y: 13.1, h: 1.0, color: '#c8102e' },
  ],
  supersede: { names: ['西安城南客运站'] },
  meta: {
    category: 'station',
    dossier: 'public.json#西安城南客运站',
    sources: ['OSM w360836368', 'https://commons.wikimedia.org/wiki/File:雁塔_西安城南客运站.jpg', 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安城南客运站_0.jpg', 'scratchpad/pub_agent/sat/g49.jpg'],
    confidence: 'medium（外观）；low（高度）',
    notes: '高度无资料：取 buildings.bin 12.6 m 兜底（照片约 2 层高大空间）；屋顶深色体量 22×18 m、高 4 m 按照片比例与卫星。字在北立面西段（照片）。',
  },
};

// ───── 西安汽车站（火车站西广场） ─────
// OSM w1465143088“西安市汽车站”（119×33 m）。照片（Commons 夜景）：两层站房，西段为仿唐坡檐，屋顶红色发光字“西安汽车站”，面向北侧广场。
const xaqcz = {
  id: 'pub-xian-bus-station',
  name: '西安汽车站',
  fp: 'edcd6ba2',
  parts: [{ name: 'main', fp: 'edcd6ba2', base: 0, top: 12.6, style: { pattern: 'retail', tint: '#3a4652', spd: '#cfc6b4', floorH: 6.0, colW: 3.4, spandrel: 0.35, mullW: 0.6, lit: 0.85 } }],
  signs: [{ text: '西安汽车站', part: 'main', face: 'N', y: 15.4, h: 3.4, color: '#e8322c', glow: '#ff4a3a' }],
  supersede: { names: ['西安市汽车站（火车站西广场）', '西安汽车站', '西安市汽车站'] },
  meta: {
    category: 'station',
    dossier: 'public.json#西安市汽车站（火车站西广场）',
    sources: ['OSM w1465143088', "https://commons.wikimedia.org/wiki/Category:Xi'an_Bus_Station", 'Google 卫星 z19'],
    photos: ['scratchpad/dossier_res/photos/pub/西安市汽车站_火车站西广场__0.jpg', '西安市汽车站_火车站西广场__1.jpg', 'scratchpad/pub_agent/sat/g52.jpg'],
    confidence: 'low（高度）；medium（招牌）',
    notes: '高度无资料：取 buildings.bin 12.6 m 兜底（照片约 2 层）。西段仿唐坡檐细部未建。',
  },
};

export default [
  xijing, jd1, jd2, srmyy, zxyy, honghui, etyy, fybj,
  shengzf, shizf, xcq, caq, dht,
  qxslib, xjtuMain, tengfei, xgdlib, nwu, cdlib, sdlib, xjdlib, xdlt,
  zrbwg, rmtyc, csky, xaqcz,
];
