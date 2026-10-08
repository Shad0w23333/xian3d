// 逐栋档案 · 南区（城墙以外、南门以南：南门外—南稍门、小寨、长安路南段/电视塔、曲江——大雁塔周边、曲江新区）。
// 依据：research/refs/dossiers/core_south.json（及 public.json 中落在本区的条目）的档案与照片
//       （scratchpad/dossier_core_south/photos/*），Overture/OSM 实测轮廓（public/data/dossier_fp.json），
//       Esri World Imagery z18/z19 卫星（本区影像楼身倾斜：屋面相对底座向东偏北移位，约 (0.65, 0.45) m/每米楼高，
//       由万众国际两座写字楼屋面与 OSM 底边、W 酒店东北角屋面与 OSM 角点三处互证，见 model_log_south.md）。
// 档案为 null 的数值不编：能从照片数层的按“层数 × 层高”估算并在 meta.notes 写“按照片数层”；
// 能从卫星量取的写“按卫星量取”；都做不到的保守处理并注明。
// 对照差异见 research/refs/dossiers/model_log_south.md。

const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * 局部坐标系：原点 (ox, oz)（世界坐标），u 轴方位角 a（度，东 = 0 逆时针，北 = 90），v 轴为 u 轴左侧（a + 90°）。
 * 返回 (u, v) => [x, z]（世界坐标）
 */
function frame(ox, oz, a) {
  const c = Math.cos(a * DEG), s = Math.sin(a * DEG);
  return (u, v) => [r2(ox + u * c - v * s), r2(oz - u * s - v * c)];
}
/** 局部坐标系中的矩形 [u0,u1]×[v0,v1] → 世界坐标扁平数组 */
function quad(F, u0, u1, v0, v1) {
  return [F(u0, v0), F(u1, v0), F(u1, v1), F(u0, v1)].flat();
}
/** 椭圆（世界坐标，a 为东西半轴、b 为南北半轴）→ 扁平数组 */
function ellipse(cx, cz, a, b, n = 64) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(r2(cx + a * Math.cos((i / n) * 2 * Math.PI)), r2(cz + b * Math.sin((i / n) * 2 * Math.PI)));
  return out;
}
/** 轴对齐矩形（世界坐标 x0..x1 × z0..z1）→ 扁平数组 */
function box(x0, z0, x1, z1) {
  return [x0, z0, x1, z0, x1, z1, x0, z1];
}
// 采光顶/穹顶玻璃（比默认 glassRoof 深，浅色屋面上看得出；同 demo.js）
const SKYLIGHT = { color: '#5f7a8c', metalness: 0.55, roughness: 0.15 };
// 唐风屋面：深灰筒瓦、夜间檐口金色轮廓灯
const TANG_ROOF = { color: '#4a4d52', roughness: 0.8, metalness: 0.1 };

// ═══════════════════════════ 曲江·西安 W 酒店 + 万众国际（W Five Park） ═══════════════════════════
// 档案 core_south.json#西安W酒店 / #万众国际（W Five Park）写字楼 A/B 座：旧模型（sky-data2 SPECIAL2.w）为三块“切角方盒 + 斜顶”，
// 照片（whotel_0/1/3/4、wanzhong_0/1/3/4）与卫星（Esri z19）证实：
//  · W 酒店平面为 L 形——西北翼（沿 10° 方向，自东北角向西伸出约 107 m）与南翼（自东北角向南偏东伸出约 87 m）在东北角汇合；
//    两翼都“逐层退台”：每层比下一层短一截，屋面自两翼末端向转角一级级升高（航拍 wanzhong_0 两翼屋面为一道道蓝色玻璃台阶，
//    卫星上两翼屋面是垂直于翼轴的一条条台阶线），从两翼夹角（西南）看就是“A 字形/金字塔”立面（wanzhong_1、whotel_1）；
//  · 两翼夹角处立一座白色竖向核心筒，高出两翼，顶上托“飞碟”圆盘（下部倒锥、边缘一圈灯环）；
//  · 东北角为满高体块，顶部东北角有一块大型 LED 屏（whotel_3 粉色屏）；
//  · 万众国际 A、B 两座写字楼在南侧，平面为不规则多边形，斜屋面（向南升高，whotel_0、wanzhong_0）；
//    “A/B 两座，总高 20 层，1–4 层商业、5–20 层办公，层高 4.2 m”（搜狐/安居客写字楼资料，WebSearch 汇总）。
// 轮廓：OSM w1370071044（Overture 88b073e6，= 旧 FP2.wsite）为整个综合体的底层轮廓：北边 (3764,6937)→(3870,6918) 即西北翼北立面，
//   东边 (3870,6918)→(3881,6985) 即南翼东立面；A 座西边 x≈3764、B 座东边 (3898,7085)→(3916,7167)。
// 高度：“385 间客房位于酒店 5 至 26 层”“大堂层高 17 米”（什么值得买/百会通酒店资料，WebSearch 汇总）→ 1–4 层（含 17 m 挑高大堂）按 20 m，
//   5–26 层 22 层 × 3.5 m → 97 m；核心筒 99 m，圆盘顶约 108.3 m（倒锥 + 薄檐口，厚度按照片 wanzhong_1 与层高比例）。旧 91.7 m 无出处，不再使用。
const WF = { tip: [3764.3, 6936.5], ne: [3870.1, 6917.8], ang: 10.0 }; // 西北翼北立面（OSM 北边）
const NW = frame(WF.tip[0], WF.tip[1], WF.ang); // u：自西端向东（0 → 107.4 m），v：北立面 0 → 南立面 −23 m
const SW_ = frame(WF.ne[0], WF.ne[1], WF.ang - 90); // u：自东北角向南（0 → 87 m），v：东立面 0 → 西立面 −28 m
const W_NW = { len: 107.4, w: 23, corner: 79.4, top: 59.4 }; // 西北翼：全长、宽、转角体块起点、顶层起点（u）
const W_S = { len: 87, w: 28, corner: 23, top: 38 }; // 南翼：全长、宽、转角体块终点、顶层终点（u）
const W_STY = { pattern: 'horizontalBands', tint: '#4d6c86', spd: '#c9d2d8', floorH: 3.5, colW: 2.2, spandrel: 0.24, mullW: 0.06, lit: 0.5 };
const W_FLOORS = 22; // 5–26 层
const W_BASE = 20; // 1–4 层（大堂、宴会）顶高
const W_FH = 3.5;
// 逐层退台：第 k 层（k = 0 → 5 层 … 21 → 26 层）；长立面每层内缩 0.12 m（避免上下层立面共面闪烁，22 层累计 2.6 m，几乎看不出）
const wSteps = [];
for (let k = 0; k < W_FLOORS; k++) {
  const ins = 0.12 * (k + 1), y0 = W_BASE + W_FH * k;
  const uNW = (W_NW.top * k) / (W_FLOORS - 1); // 西北翼第 k 层西端
  const uS = W_S.len - ((W_S.len - W_S.top) * k) / (W_FLOORS - 1); // 南翼第 k 层南端
  wSteps.push(
    { name: `nw${5 + k}`, pts: quad(NW, uNW, W_NW.corner + 0.3, -W_NW.w + ins, -ins), base: y0, top: y0 + W_FH, style: W_STY, roof: { mech: false, parapet: 1.1 } },
    { name: `s${5 + k}`, pts: quad(SW_, W_S.corner - 0.3, uS, -W_S.w + ins, -ins), base: y0, top: y0 + W_FH, style: W_STY, roof: { mech: false, parapet: 1.1 } },
  );
}
const wHotel = {
  id: 'w-xian',
  name: '西安W酒店',
  center: [3850, 6950],
  parts: [
    // 1–4 层（大堂、宴会厅）：两翼全长
    { name: 'nwBase', pts: quad(NW, 0, W_NW.corner + 0.3, -W_NW.w + 0.08, -0.08), base: 0, top: W_BASE, style: { ...W_STY, floorH: 5 }, roof: { mech: false } },
    { name: 'sBase', pts: quad(SW_, W_S.corner - 0.3, W_S.len, -W_S.w + 0.08, -0.08), base: 0, top: W_BASE, style: { ...W_STY, floorH: 5 }, roof: { mech: false } },
    // 东北角满高体块（两翼汇合处，顶部设备 + LED 屏）
    { name: 'corner', pts: quad(NW, W_NW.corner, W_NW.len, -W_NW.w, 0), base: 0, top: W_BASE + W_FH * W_FLOORS, style: W_STY, roof: { parapet: 1.4 } },
    ...wSteps,
    // 两翼夹角处的白色竖向核心筒（照片 wanzhong_1：白色竖框 + 玻璃），顶托飞碟圆盘（下部倒锥、边缘灯环）
    {
      name: 'core', shape: 'rect', size: [14, 14], at: [3839, 6955], rot: WF.ang, base: 0, top: 99,
      style: { pattern: 'verticalFins', tint: '#5d7488', spd: '#eef0f1', floorH: 3.5, colW: 1.6, spandrel: 0.1, mullW: 0.55, lit: 0.45 },
      roof: { mech: false },
      crown: [{
        type: 'disk', r: 13.2, h: 9.3, glow: '#aef4ff',
        profile: [[5, 0], [12.6, 5.6], [13.2, 6.3], [13.2, 8.1], [11.6, 8.9], [0, 9.3]], mat: { color: '#e4e7e9', metalness: 0.45, roughness: 0.35 },
      }],
    },
  ],
  signs: [
    { text: 'W', part: 'core', face: 'SW', y: 94, h: 7, color: '#ffffff', glow: '#ffffff' }, // 核心筒顶部朝西南（wanzhong_1、whotel_1）
    { text: 'W', part: 'nw26', face: 'S', near: 'E', y: 95.2, h: 3.3, color: '#ffffff' }, // 西北翼顶层内侧（wanzhong_3 左上角的 W）
  ],
  night: {
    // 每层退台边沿的青蓝色线条灯（档案 night：“每层横向线条灯，常为青蓝色”）
    outline: wSteps.map((p) => ({ part: p.name, color: '#34d6ff', w: 0.3, strength: 2.2 })),
    media: [{ part: 'corner', face: 'N', from: 86, to: 96.5, width: 24, shift: -2 }], // 东北角顶部大屏（whotel_3）
  },
  supersede: { keys: ['w'], names: ['西安W酒店', "W Xi'an", '万众国际W酒店'] },
  label: { text: '西安W酒店', y: 118 },
  meta: {
    dossier: 'core_south.json#西安W酒店',
    sources: [
      'OSM w1370071044（Overture 88b073e6，综合体底层轮廓）', 'Esri World Imagery z19（两翼台阶线、圆盘、东北角屋面）',
      'https://post.smzdm.com/p/and2z572/（客房位于 5–26 层）', 'https://www.1000meetings.com/venue/24844/（大堂层高 17 m）',
      'http://www.xbzk.com/doc_27071753.html（西北综合勘察设计研究院：万众国际—西安W酒店）', 'http://tuchong.com/1313/68935273/',
    ],
    photos: ['scratchpad/dossier_core_south/photos/whotel_0.jpg', 'whotel_1.jpg', 'whotel_3.jpg', 'whotel_4.jpg', 'wanzhong_0.jpg（2016 航拍，由西向东）', 'wanzhong_1.jpg', 'wanzhong_3.jpg'],
    confidence: 'medium（形体、平面）；medium-low（两翼长度 ±10 m、核心筒位置 ±8 m）',
    notes: '高度按资料层数：1–4 层 20 m（含 17 m 大堂）+ 5–26 层 22 × 3.5 m = 97 m；核心筒 99 m、圆盘顶 108.3 m（倒锥底 + 1.8 m 薄檐口，按照片 wanzhong_1/whotel_3 与层高比例）。'
      + '两翼长度与核心筒位置按卫星量取（屋面位置已扣除楼身倾斜 (0.65, 0.45)×高度），西北翼 107 m、南翼 87 m、宽 23/28 m，±10 m；'
      + '顶层起点（西北翼 59 m、南翼 38 m）按照片 wanzhong_1 顶层平段长度估算。照片中两翼外侧立面为竖直、内外两侧都有阳台。'
      + '夜景“W”图形与“W FIVE PARK”字样为媒体立面动态显示，不作为常亮招牌建模。',
  },
};

// 万众国际 A/B 座（W Five Park 写字楼）+ 裙房：底层轮廓 = OSM w1370071044；塔楼多边形 = 卫星屋面 − 倾斜位移（屋面约 87 m：0.65×87, 0.45×87）
const wanzhong = {
  id: 'wanzhong',
  name: '万众国际',
  fp: '88b073e6-bd31-488f-a7c1-d5af31301d83',
  parts: [
    {
      name: 'podium', // W Five Park 商业裙房（写字楼 1–4 层商业；与 W 酒店 1–4 层连体），轮廓内缩 1.2 m 让出酒店与写字楼立面
      // 底层轮廓（OSM 整个综合体）把 W 酒店两翼 1–4 层（w-xian 的 nwBase/sBase，顶高 20 m）也包在里面：屋面压低到 18.7 m，
      // 连 1.2 m 女儿墙（19.9 m）一起藏进酒店底座体内，不再与酒店底座屋面共面闪烁、女儿墙也不再从酒店屋面上穿出来
      kind: 'podium', fp: '88b073e6-bd31-488f-a7c1-d5af31301d83', grow: -1.2, base: 0, top: 18.7,
      style: { pattern: 'retail', tint: '#2f3c47', spd: '#b4b8bc', floorH: 5, colW: 3.2, spandrel: 0.28, mullW: 0.2, lit: 0.85 },
    },
    {
      name: 'towerA', // A 座（西南）：屋面向南升高的斜顶（whotel_0 右侧楼、wanzhong_0 前景楼）
      pts: [3764, 7117, 3791, 7133.5, 3792, 7161, 3821, 7161, 3838, 7192, 3764, 7203.5], base: 0, top: 105,
      style: { pattern: 'horizontalBands', tint: '#5c7890', spd: '#c9d2d8', floorH: 4.2, colW: 2.4, spandrel: 0.26, mullW: 0.06, lit: 0.5 },
      crown: { type: 'slope', dir: 'S', drop: 18 },
    },
    {
      name: 'towerB', // B 座（东南）：西立面为斜向折面（卫星暗色斜带），屋面缓坡向南升高
      pts: [3830.6, 7159.9, 3865.1, 7106.9, 3888.6, 7086.6, 3912, 7171.1, 3842.9, 7189.6], base: 0, top: 95,
      style: { pattern: 'horizontalBands', tint: '#5c7890', spd: '#c9d2d8', floorH: 4.2, colW: 2.4, spandrel: 0.26, mullW: 0.06, lit: 0.5, seed: 91 },
      crown: { type: 'slope', dir: 'S', drop: 8 },
    },
  ],
  night: {
    outline: [{ part: 'towerA', color: '#8f7bff', y: 87, w: 0.4 }, { part: 'towerB', color: '#8f7bff', y: 87, w: 0.4 }], // 夜景紫/蓝色线条（whotel_4、wanzhong_4）
  },
  supersede: { keys: ['w'], names: ['万众国际', '万众国际A座', '万众国际B座', 'W Five Park', 'W FIVE PARK', '万众国际（W Five Park）写字楼 A/B 座'] },
  label: { text: '万众国际', y: 112 },
  meta: {
    dossier: 'core_south.json#万众国际（W Five Park）写字楼 A/B 座',
    sources: [
      'OSM w1370071044（Overture 88b073e6）', 'Esri World Imagery z19（A/B 屋面）',
      'https://m.sohu.com/a/824409237_121484367/（A、B 两座，总高 20 层，1–4 层商业、5–20 层办公）',
      'https://xa.youzuw.com/index.php?a=xiangxi&g=Mobile&id=538&m=Office（层高 4.2 m）', 'http://m.winshang.com/xm50805.html',
    ],
    photos: ['scratchpad/dossier_core_south/photos/wanzhong_0.jpg', 'whotel_0.jpg', 'whotel_4.jpg', 'wanzhong_4.jpg'],
    confidence: 'medium（层数、平面）；low（斜顶高差）',
    notes: '屋面 87 m = 1–4 层商业 20 m + 16 层 × 4.2 m（资料层数、层高）；斜顶高差（A 座 +18 m、B 座 +8 m）按照片 whotel_0 比例估算。'
      + '塔楼平面 = 卫星屋面多边形 − 楼身倾斜位移（0.65, 0.45）×87 m，所得 A 座西边、B 座东边与 OSM 底层轮廓吻合（±5–10 m）。'
      + '裙房 20 m 按“1–4 层商业”。航拍 wanzhong_0 中 A 座北立面、B 座西立面有逐层外挑/内收的折面，未建。',
  },
};

// ═══════════════════════════ 小寨 ═══════════════════════════
// 赛格国际购物中心：商场轮廓 5dfb5e1c（OSM r19420522，220×139）挖掉西南角塔楼，塔楼为 OSM 分体 3dda88da（72×25 南北向板楼，
// 西立面两端各凸出一个竖向玻璃筒——轮廓西边的两处 3 m 小凸出）。照片 saige_0/1/3/4（由西南看东北）：
// 转角深蓝玻璃板楼、两端通高玻璃筒；塔楼东南脚是一个蓝色玻璃圆筒（顶上红字“SAGA 赛格”，即轮廓西南角的圆弧）；
// 沿小寨东路的南立面为逐层退台的“山崖”绿化台地，挂着外挑玻璃盒子（夜间绿色洗墙光）。
// 高度：商场“地上 7 层”（高楼迷/百科），照片 7 层 × 约 5.4 m → 38 m；圆筒比台地高约 1–2 层 → 45 m；
// 塔楼无资料：照片 saige_3 中塔楼高约为圆筒的 2.2–2.4 倍、夜景 saige_4 可数约 26–28 层 → 取 100 m（按照片比例与数层）。
const SAIGE_FP = '5dfb5e1c-d051-4f6a-a088-5b2038187946';
// 2026-10 修正：原立面一色蓝玻璃方格（spandrel 0.35、tint 亮蓝），看不出“山崖台地”；改为深蓝灰玻璃 + 米灰石材层间带（窗槛墙加厚），
// 台地外沿加种植槽（绿篱）+ 立面顶部垂挂绿植带；南立面玻璃盒子贴着所在台地的墙面、坐在下一级台地屋面上（原来离墙 7 m / 悬空 2~9 m）。
const SAIGE_STY = { pattern: 'retail', tint: '#2b4760', spd: '#b7b0a3', floorH: 5.4, colW: 3.2, spandrel: 0.46, mullW: 0.35, lit: 0.7 };
// 南立面各级台地的墙面 z（轮廓最南点 4050.9 − 7k，再按 grow −0.15k 内缩）与台地屋面高度
const SG_FACE = [4050.9, 4043.75, 4036.6, 4029.45], SG_TOP = [14, 21, 28, 38];
const SG_GREEN = { color: '#4b6b37', roughness: 0.95, metalness: 0 };
const saige = {
  id: 'saige-xiaozhai',
  name: '赛格国际购物中心',
  fp: SAIGE_FP,
  parts: [
    { name: 'mall', kind: 'podium', fp: SAIGE_FP, base: 0, top: 14, style: SAIGE_STY, roofMat: { color: '#5d7d4a', roughness: 0.9 } },
    // 南立面逐层退台（台地绿化屋面）：每层把轮廓在南侧切掉约 7 m；另三面各内缩 0.15 m/层，避免上下层立面共面
    ...[[14, 21, 1], [21, 28, 2], [28, 38, 3]].map(([b, t, k]) => ({
      name: 'terrace' + k, kind: 'podium', fp: SAIGE_FP, cut: { face: 'S', by: 7 * k }, grow: -0.15 * k, base: b, top: t,
      style: { ...SAIGE_STY, seed: 20 + k }, roofMat: { color: '#5d7d4a', roughness: 0.9 },
    })),
    {
      name: 'drum', // 转角蓝色玻璃圆筒（轮廓西南角圆弧拟合：圆心 (57,4030)，半径约 21 m）
      shape: 'circle', size: [42, 42], at: [57, 4030], base: 0, top: 45,
      style: { pattern: 'curtain', tint: '#2f6ab0', spd: '#8fb2d6', floorH: 5.4, colW: 1.6, spandrel: 0.12, mullW: 0.08, lit: 0.6 },
      roof: { mech: false, parapet: 1.2 },
    },
    {
      name: 'tower', // 转角深蓝玻璃板楼（随机明暗像素分格）
      fp: '3dda88da-c836-440d-ae7c-64d3f7af3cb9', base: 0, top: 100,
      style: { pattern: 'curtain', tint: '#2f5f9a', spd: '#3a4f66', floorH: 3.85, colW: 1.5, spandrel: 0.18, mullW: 0.08, lit: 0.5 },
    },
    // 西立面两端通高竖向玻璃筒（夜景 saige_4 通体发亮）
    ...[['tubeN', 3969], ['tubeS', 4023]].map(([name, z], i) => ({
      name, shape: 'rect', size: [8, 9], at: [28, z], base: 0, top: 104,
      style: { pattern: 'verticalFins', tint: '#8fb9d8', spd: '#d8e6ee', floorH: 3.85, colW: 1.2, spandrel: 0.05, mullW: 0.16, lit: 0.95, seed: 60 + i },
      roof: { mech: false },
    })),
    // 南立面的外挑玻璃盒子（saige_0/1）：偶数号贴第 1 级台地墙面、坐在商场屋面（14 m）上，奇数号贴第 2 级台地墙面、坐在第 1 级台地屋面（21 m）上；
    // 盒子北端嵌进墙里 1.5 m，向南挑出 3 m（深 4.5 m），不压到台地外沿的种植槽
    ...[95, 122, 149, 176, 203].map((x, i) => {
      const k = 1 + (i % 2), zf = SG_FACE[k];
      return {
        name: 'box' + i, shape: 'rect', size: [8, 4.5], at: [x, zf + 0.75], base: SG_TOP[k - 1], top: SG_TOP[k - 1] + 5.6,
        style: { pattern: 'curtain', tint: '#cfe3ee', spd: '#e8eef2', floorH: 5.6, colW: 2, spandrel: 0.08, mullW: 0.12, lit: 0.95, seed: 70 + i },
        roof: { mech: false, parapet: 0.3 }, footprint: false,
      };
    }),
    // 台地外沿种植槽（绿篱高出女儿墙约 0.5 m、宽 1.1 m）：商场屋面与三级台地屋面的南沿，西端让开转角圆筒；
    // 商场屋面南沿在 x 184.6 以东退到 4049.0，那一段不放
    ...SG_TOP.map((top, k) => {
      const x1 = k === 0 ? 184 : 216;
      return {
        name: 'planter' + k, kind: 'solid', pts: [80, SG_FACE[k] - 1.6, x1, SG_FACE[k] - 1.6, x1, SG_FACE[k] - 0.5, 80, SG_FACE[k] - 0.5],
        base: top, top: top + 1.7, mat: SG_GREEN, footprint: false, sink: 0.3,
      };
    }),
    // 台地墙面顶部的垂挂绿植带（第 1~3 级墙面，墙顶以下 2.4 m）
    ...[1, 2, 3].map((k) => ({
      name: 'hang' + k, kind: 'solid', pts: [80, SG_FACE[k] + 0.05, 216, SG_FACE[k] + 0.05, 216, SG_FACE[k] + 0.4, 80, SG_FACE[k] + 0.4],
      base: SG_TOP[k] - 2.4, top: SG_TOP[k] - 0.1, mat: SG_GREEN, footprint: false, sink: 0,
    })),
  ],
  signs: [
    { text: 'SAGA 赛格', part: 'drum', face: ['S', 'W'], y: 42.8, h: 3.4, color: '#e0322b' },
    { text: 'SAGA 赛格国际购物中心', part: 'tower', face: 'W', y: 7.5, h: 1.9, color: '#e0322b' },
  ],
  night: {
    floodlight: [{ part: 'terrace1', color: '#46ff8a', strength: 0.22, to: 21 }, { part: 'terrace2', color: '#46ff8a', strength: 0.22 }],
  },
  supersede: { keys: ['saige'], names: ['赛格国际购物中心', '小寨赛格', 'SAGA 赛格', '赛格国际购物中心（小寨）'] },
  meta: {
    dossier: 'core_south.json#赛格国际购物中心（小寨）',
    sources: ['OSM r19420522（Overture 5dfb5e1c）、w1419576898（塔楼 3dda88da）', 'https://gaoloumi.cc/forum.php?mod=viewthread&tid=653066', 'http://m.winshang.com/xm18279.html（地上 7 层、地下 2 层）', 'Esri World Imagery z18'],
    photos: ['scratchpad/dossier_core_south/photos/saige_0.jpg', 'saige_1.jpg', 'saige_3.jpg', 'saige_4.jpg（夜景数层）'],
    confidence: 'medium（形体）；low（塔楼高度）',
    notes: '商场 38 m 按“地上 7 层”× 约 5.4 m（按照片数层）；台地分 3 级，每级南移约 7 m（按照片比例）；圆筒 45 m 按照片比台地高约 1–2 层。'
      + '塔楼高度无资料：按照片比例（约为圆筒 2.2–2.4 倍）与夜景数层（约 26–28 层）取 100 m。旧 sky-data saige（56 m 单一裙楼）作废。'
      + '塔楼立面对角斜线灯带、东侧 50.3 m 室外扶梯、商场东端两处小天井未建。'
      + '2026-10：玻璃盒子改为贴所在台地墙面、坐在下一级台地屋面上（原离墙 7 m、悬空 2~9 m）；台地外沿加种植槽 + 墙顶垂挂绿植带；立面改深蓝灰玻璃 + 米灰石材层间带。',
  },
};

// 金莎国际购物广场：商场 9f8d120c（OSM w1409909548，南北 120 × 东西 59）+ 裙楼上两栋塔楼（OSM 分体 21ad0645 北、b4ea78af 南）。
// 照片 jinsha_0/jinsha2_0：欧式古典米黄石材裙楼（首层拱券、壁柱）；jinsha2_1：灰绿面砖塔楼、顶部阶梯形收头；效果图 jinsha2_3：两塔一高一低。
// 高度：裙楼“地上 7 层”（百科）× 5 m → 35 m；塔楼无资料：卫星屋面相对 OSM 底座东移约 57 m、北移约 35 m，按本区倾斜 (0.65, 0.45) → 约 80–88 m，
// 效果图南塔更高 → 北塔 82 m、南塔 90 m（按卫星量取 + 照片比例）。
const jinsha = {
  id: 'jinsha-xiaozhai',
  name: '金莎国际购物广场',
  fp: '9f8d120c-b944-48a4-af8c-057acae6a8ef',
  parts: [
    {
      name: 'mall', kind: 'podium', fp: '9f8d120c-b944-48a4-af8c-057acae6a8ef', base: 0, top: 35,
      style: { pattern: 'stoneWindows', tint: '#3f5a66', spd: '#d4c39e', floorH: 5, colW: 3.6, spandrel: 0.4, mullW: 1.4, lit: 0.6 },
    },
    ...[['towerN', '21ad0645-55ed-4b64-a2c0-e90a5e4b78a3', 82], ['towerS', 'b4ea78af-eec8-43c1-b860-d9e96c23dcf9', 90]].map(([name, fp, top], i) => ({
      name, fp, grow: -0.4, base: 35, top,
      setbacks: [{ at: top - 7, inset: 2.5 }, { at: top - 3.5, inset: 5 }], // 顶部阶梯形收头
      style: { pattern: 'stoneWindows', tint: '#3f5a66', spd: '#8d9a8e', floorH: 3.2, colW: 2.6, spandrel: 0.45, mullW: 1.1, lit: 0.55, seed: 80 + i },
      roof: { parapet: 1.2 },
    })),
  ],
  signs: [{ text: '金莎国际购物广场', part: 'mall', face: 'W', y: 30, h: 3.6, color: '#c9a646' }],
  night: { outline: [{ part: 'towerN', color: '#ffc24a', w: 0.4 }, { part: 'towerS', color: '#ffc24a', w: 0.4 }] }, // 效果图：顶部金色轮廓灯
  supersede: { names: ['金莎国际购物广场', '金莎国际', '小寨金莎国际', '金莎国际广场', '金莎国际购物广场（小寨）'] },
  meta: {
    dossier: 'core_south.json#金莎国际购物广场（小寨）',
    sources: ['OSM w1409909548（Overture 9f8d120c）、w259864500（21ad0645）、w278225008（b4ea78af）', 'https://baike.baidu.com/item/西安小寨金莎国际广场/7336370（地上 7 层）', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_core_south/photos/jinsha_0.jpg', 'jinsha2_0.jpg', 'jinsha2_1.jpg', 'jinsha2_3.jpg（效果图）'],
    confidence: 'low（塔楼高度）；medium（裙楼）',
    notes: '裙楼 35 m 按“地上 7 层”× 5 m；塔楼高度按卫星量取（屋面位移 ÷ 倾斜率，±8 m）与效果图高低关系，北 82 m、南 90 m；顶部两级退台按照片“阶梯形收头”。',
  },
};

// 银泰城（小寨店）：OSM w1419576379（57401636，96×88），“地上十层”（WebSearch 汇总）。航拍 yintai_xz_3：方盒体量，大面为暖木色竖向格栅饰面，
// 另一面白墙 + 转角竖向玻璃体，屋顶设备层。卫星屋面相对底座东移约 38 m → 约 58 m，与 10 层 × 5.5 m 吻合 → 55 m。
const yintaiXZ = {
  id: 'intime-xiaozhai',
  name: '银泰城(小寨店)',
  fp: '57401636-14e3-4836-8ce3-068eea1eed21',
  parts: [
    {
      name: 'mall', kind: 'podium', fp: '57401636-14e3-4836-8ce3-068eea1eed21', base: 0, top: 55,
      style: { pattern: 'verticalFins', tint: '#5a6c78', spd: '#b08050', floorH: 5.5, colW: 1.3, spandrel: 0.55, mullW: 0.5, lit: 0.55 },
      crown: [{ type: 'frame', h: 4.5, inset: 10, step: 5, post: 0.4, mat: 'metal' }], // 屋顶设备层屏风
    },
    {
      name: 'shop', kind: 'facade', fp: '57401636-14e3-4836-8ce3-068eea1eed21', grow: 0.15, base: 0, top: 10,
      style: { pattern: 'retail', tint: '#3a4650', spd: '#e0ddd6', floorH: 5, colW: 3.2, lit: 0.95 },
    },
  ],
  signs: [{ text: '银泰城', part: 'mall', face: ['S', 'E'], near: 'E', y: 50, h: 4.2, color: '#c8102e' }],
  supersede: { names: ['银泰城(小寨店)', '银泰城（小寨店）', '小寨银泰城'] },
  meta: {
    dossier: 'core_south.json#银泰城（小寨店）',
    sources: ['OSM w1419576379（Overture 57401636）', 'https://gs.ctrip.com/html5/you/shops/7/1374214.html（地上十层）', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_core_south/photos/yintai_xz_3.jpg'],
    confidence: 'low（只有 1 张航拍）',
    notes: '55 m 按资料 10 层 × 5.5 m，与卫星屋面位移（约 38 m ÷ 0.65）一致；木色格栅与白墙分面无法从单张航拍判定朝向，统一用木色竖向格栅立面；转角玻璃体未单独建。',
  },
};

// 凯德广场·新地城：OSM w1409909198（64bf188c，114×86）。照片 kaide_0：约 6 层商场，立面为多条水平波浪形铝板带叠成（夜间下沿暖白线灯），
// 竖向玻璃盒子 + 淡黄色光带竖体量，顶层蓝色玻璃盒；入口前独立“凯德广场”立牌。高度按照片数层（约 6 层 × 5.5 m）→ 33 m。
const kaide = {
  id: 'capitamall-xindicheng',
  name: '凯德广场·新地城',
  fp: '64bf188c-9aac-4930-81e1-ee75da2684e6',
  parts: [{
    name: 'mall', kind: 'podium', fp: '64bf188c-9aac-4930-81e1-ee75da2684e6', base: 0, top: 33,
    style: { pattern: 'louver', tint: '#2a3c55', spd: '#d8d2c8', floorH: 2.8, colW: 4.0, spandrel: 0.5, mullW: 0.05, lit: 0.75 },
  }],
  bands: [{ part: 'mall', levels: [7, 12.5, 18, 23.5, 29], wave: { amp: 1.2, len: 62, phase: 1.3 }, h: 0.9, depth: 0.45, color: '#c9c4bb', glow: '#ffd9a0', strength: 1.6 }],
  signs: [{ text: '凯德广场', part: 'mall', face: ['W', 'S'], y: 29.5, h: 4, color: '#ffffff', glow: '#9fd0ff' }],
  supersede: { names: ['凯德广场(新地城店)', '凯德广场·新地城', '凯德广场（新地城店）'] },
  meta: {
    dossier: 'core_south.json#凯德广场·新地城',
    sources: ['OSM w1409909198（Overture 64bf188c）', 'https://www.capitaland.com/cn/zh/lease/offices-listing/capitamallxindicheng-copy-copy.html'],
    photos: ['scratchpad/dossier_core_south/photos/kaide_0.jpg'],
    confidence: 'low',
    notes: '33 m 按照片数层（约 6 层 × 5.5 m）；波浪铝板带 5 道（照片），夜间暖白线灯；照片中的竖向玻璃盒、顶层蓝色玻璃盒与配套写字楼（西塔 20 层）方位无法确定，未建；招牌朝向按主街方向推定（W、S）。',
  },
};

// ═══════════════════════════ 大雁塔周边 · 大唐不夜城 ═══════════════════════════
// 曲江银泰城：A 馆（OSM w1346634427，5fc5f88e，49×58，不夜城步行街西侧）+ B 馆（OSM r18470701，af6118b1，52×235，步行街东侧长条）。
// 照片 yintai_qj_0/4：A 馆为方盒体量上覆唐风深灰大屋顶（庑殿挑檐），上部木色方格镂空花格屏、下部玻璃店面（ZARA）；
// 卫星 z19：A 馆屋面为深灰四坡顶、正脊南北向且较长（约为长边的 60%）。yintai_qj_3（夜景）：B 馆为白色石材竖分格立面 + 大幅 LED 屏，
// 顶上退进一条唐风屋顶长廊（红色斗拱/柱廊、金色檐口线灯）。高度无资料：A 馆按照片约 4 层 × 5.5 m → 22 m；B 馆 4 层 24 m + 顶层长廊 6 m。
const yintaiQJ = {
  id: 'intime-qujiang',
  name: '曲江银泰城',
  fp: '5fc5f88e-2cc2-46c6-b44d-8d831d0f489d',
  parts: [
    {
      name: 'boxA', kind: 'podium', fp: '5fc5f88e-2cc2-46c6-b44d-8d831d0f489d', base: 0, top: 22,
      style: { pattern: 'grid', tint: '#6b7780', spd: '#9c7a4f', floorH: 3.2, colW: 1.6, spandrel: 0.55, mullW: 0.5, lit: 0.75 },
      // 檐口金色线灯：默认强度 2.4 远看是一道很粗的金线（g10 审查），减到 0.9
      crown: { type: 'tangRoof', eave: 3.5, h: 9, ridge: 0.62, mat: TANG_ROOF, glow: '#ffc36b', strength: 0.9 },
    },
    {
      name: 'shopA', kind: 'facade', fp: '5fc5f88e-2cc2-46c6-b44d-8d831d0f489d', grow: 0.15, base: 0, top: 7.5,
      style: { pattern: 'retail', tint: '#3a4650', spd: '#9c7a4f', floorH: 7.5, colW: 3.4, spandrel: 0.1, mullW: 0.25, lit: 0.95 },
    },
    {
      // 白色石材竖向分格（夜景照片 yintai_qj_3）：原 stoneWindows 4.8 m 层高方窗格像普通写字楼 → 1 m 宽石材竖肋 + 1.2 m 窄长玻璃、6 m 一道细横带
      name: 'boxB', kind: 'podium', fp: 'af6118b1-4400-47af-9080-7ac94655cf37', holes: 'fp', base: 0, top: 24,
      style: { pattern: 'stoneWindows', tint: '#56636c', spd: '#e8e3da', floorH: 6, colW: 2.2, spandrel: 0.1, mullW: 1.0, lit: 0.45 },
    },
    {
      // B 馆顶层唐风长廊，沿长轴居中：原来是一整块红色竖肋立面 + 红色泛光 + 白色亮窗（远看是扁平红带加白竖条），
      // 改为退进的木格栅暖光内廊（芯体 192×10 m）+ 外圈红色圆柱柱廊（columns，柱距 4.4 m）+ 深灰瓦庑殿顶（出檐盖过柱廊）
      name: 'galleryB',
      shape: 'rect', size: [192, 10], at: [1632, 5828], rot: 90, base: 24, top: 30,
      style: { pattern: 'grid', tint: '#4a3426', spd: '#6b3a26', floorH: 6, colW: 1.4, spandrel: 0.14, mullW: 0.35, lit: 0.35 },
      roof: { mech: false, parapet: 0.3 },
      crown: { type: 'tangRoof', eave: 4.2, h: 5.5, mat: TANG_ROOF, glow: '#ffc36b', strength: 0.8 },
    },
  ],
  columns: [{ part: 'galleryB', out: 2.6, step: 4.4, r: 0.38, from: 24, to: 30.2, mat: { color: '#8e2a1f', roughness: 0.6, metalness: 0.05, glow: '#ff5a32', glowNight: 0.35 } }],
  bands: [{ part: 'galleryB', levels: [30.2], h: 0.9, depth: 2.95, color: '#7a2418' }], // 柱头额枋一圈（接檐下）
  signs: [
    { text: '银泰城', part: 'boxA', face: ['E', 'S'], y: 17.5, h: 3.4, color: '#ffffff' },
    { text: 'INTIME CITY', part: 'boxA', face: 'E', y: 14.6, h: 1.4, color: '#ffffff' },
  ],
  night: {
    // 柱廊：柱身红色微光 + 内廊暖光透出（原 0.4 强度的红色光幕整块铺满长廊，看不出屋顶形体）
    floodlight: [{ part: 'galleryB', color: '#ff5a32', strength: 0.12, fall: 1.2, offset: 2.9 }],
    media: [{ part: 'boxB', face: 'W', from: 6, to: 19, width: 26, shift: -45 }, { part: 'boxB', face: 'W', from: 6, to: 19, width: 26, shift: 45 }],
  },
  supersede: { names: ['曲江银泰城(A馆+B馆)', '曲江银泰城（A馆+B馆）', '西安曲江银泰', '银泰百货曲江店', '银泰城A馆', '银泰城B馆'] },
  meta: {
    dossier: 'core_south.json#曲江银泰城（A馆+B馆）',
    sources: ['OSM w1346634427（A 馆 5fc5f88e）、r18470701（B 馆 af6118b1）', 'https://m.winshang.com/news633478.html', 'https://you.ctrip.com/shopping/xian7/2091010.html', 'Esri World Imagery z19（A 馆四坡顶）'],
    photos: ['scratchpad/dossier_core_south/photos/yintai_qj_0.jpg', 'yintai_qj_3.jpg（B 馆夜景）', 'yintai_qj_4.jpg（A 馆）'],
    confidence: 'medium（形体）；low（高度）',
    notes: '高度无资料：A 馆 22 m、B 馆 24 m 按照片数层（约 4 层）；屋顶高度按照片比例（A 馆屋面约为墙身 40%）。B 馆顶层长廊的平面范围按夜景照片推定为沿长轴居中、宽约 16 m，±5 m。'
      + 'A 馆北侧 OSM 017ac0f7/dbe8e51c 等附属体量不在档案条目内，未改动。'
      + '2026-10：B 馆立面改为石材竖肋 + 窄长玻璃；顶层长廊改为退进的木格栅内廊 + 外圈红柱（柱距 4.4 m）+ 额枋 + 庑殿顶，去掉整块红色光幕；LED 屏换成有画面与字幕的内容、亮度压到泛光阈值附近；A 馆檐口灯带减弱。',
  },
};

// 西安大悦城（曲江）：OSM r19371131（08923485，166×108），“地上 4 层、地下 2 层”。效果图 joycity_1：长条盒子，白色 U 型玻璃立面，
// 顶部一圈厚重的唐风深色挑檐（两道檐），卫星上屋面周边一圈深色坡檐、中央大采光顶。→ 盝顶式挑檐（檐口一圈坡面 + 平屋面）+ 下檐。
const joycity = {
  id: 'joycity-qujiang',
  name: '西安大悦城（曲江）',
  fp: '08923485-dd2a-45d6-841c-718430bb605e',
  parts: [{
    name: 'mall', kind: 'podium', fp: '08923485-dd2a-45d6-841c-718430bb605e', base: 0, top: 24,
    style: { pattern: 'verticalFins', tint: '#dfe6ea', spd: '#e8ebec', floorH: 6, colW: 0.9, spandrel: 0.15, mullW: 0.12, lit: 0.7 },
    crown: [
      { type: 'tangRoof', eave: 4, band: 11, h: 4.5, curve: 0.2, mat: TANG_ROOF, glow: '#ffd28a', double: { gap: 5.5, out: 3.5, h: 2 } },
      { type: 'dome', at: [1387, 4740], r: [27, 19], h: 3, mat: SKYLIGHT, ring: false, y: 29.6 }, // 中央采光顶（卫星）
    ],
  }],
  supersede: { names: ['西安曲江大悦城', '西安大悦城（曲江）', '曲江大悦城'] },
  meta: {
    dossier: 'core_south.json#西安大悦城（曲江）',
    sources: ['OSM r19371131（Overture 08923485）', 'http://news.winshang.com/html/064/6914.html', 'https://m.xa.bendibao.com/xiuxian/66115.shtm（地上 4 层）', 'Esri World Imagery z18'],
    photos: ['scratchpad/dossier_core_south/photos/joycity_1.jpg（效果图）'],
    confidence: 'low',
    notes: '24 m 按“地上 4 层”× 6 m；挑檐形制按效果图与卫星（周边深色坡檐、中央采光顶），坡檐宽 11 m、高 4.5 m 与下檐为照片比例估计。'
      + '档案另一张照片 joycity_0（红色折板外立面）为其他城市的大悦城，未采用。主入口钻石切割玻璃体位置不明，未建。',
  },
};

// 西安金地广场（曲江）：OSM w1370070764（e600a090，210×80，西立面为曲线）。照片 jindi_0：古铜/棕色竖肋金属板大盒子 + 转角通高玻璃幕墙体量，
// 屋顶玻璃立方体上立“金地广场”彩色标志；卫星 z18：屋面三处椭圆形蓝色采光顶，屋面相对底座东移约 18 m（≈ 27 m 高）。
const jindi = {
  id: 'gemdale-qujiang',
  name: '西安金地广场（曲江）',
  fp: 'e600a090-733a-4ef1-adfb-add9bd9fc849',
  parts: [
    {
      name: 'mall', kind: 'podium', fp: 'e600a090-733a-4ef1-adfb-add9bd9fc849', base: 0, top: 27,
      style: { pattern: 'verticalFins', tint: '#6d8494', spd: '#7b6552', floorH: 5.4, colW: 1.0, spandrel: 0.3, mullW: 0.4, lit: 0.6 },
      crown: [ // 屋面三处椭圆采光顶（卫星量取，已扣除倾斜）
        { type: 'dome', at: [3803.5, 6212], r: [11, 14.5], h: 2.2, mat: SKYLIGHT, ring: false },
        { type: 'dome', at: [3809.5, 6267], r: [17.5, 35], h: 3, mat: SKYLIGHT, ring: false },
        { type: 'dome', at: [3790.5, 6325], r: [8.5, 16], h: 2, mat: SKYLIGHT, ring: false },
      ],
    },
    {
      name: 'cube', // 屋顶玻璃立方体标志塔（西北入口转角上方）
      shape: 'rect', size: [14, 14], at: [3786, 6200], base: 27, top: 39,
      style: { pattern: 'curtain', tint: '#9fc3d6', spd: '#dfe8ee', floorH: 4, colW: 2, spandrel: 0.05, mullW: 0.1, lit: 0.85 },
      roof: { mech: false, parapet: 0.4 },
    },
  ],
  signs: [{ text: '金地广场', part: 'cube', face: ['W', 'N'], y: 33, h: 3.2, color: '#e4007f' }],
  supersede: { names: ['西安金地广场(曲江)', '西安金地广场（曲江）', '西安金地广场', '曲江金地广场'] },
  meta: {
    dossier: 'core_south.json#西安金地广场（曲江）',
    sources: ['OSM w1370070764（Overture e600a090）', 'http://m.winshang.com/xm19397.html', 'Esri World Imagery z18（屋面采光顶、倾斜位移）'],
    photos: ['scratchpad/dossier_core_south/photos/jindi_0.jpg'],
    confidence: 'medium（轮廓、立面）；low（高度、立方体位置）',
    notes: '27 m 按卫星屋面位移（约 18 m ÷ 0.65）与照片约 5 层吻合；屋顶玻璃立方体按照片在入口转角上方，推定为西北角（曲江池东路 × 曲江池北路路口），±15 m。',
  },
};

// 龙湖西安曲江天街：OSM w1370886142（19c447dd，358×58 南北长条，Overture num_floors=4）。照片 tianjie_0：银色竖向细肋金属体量 + 玻璃门厅，
// 上部暖灰色编织纹金属饰面，“天街”彩色标识。2023 年外立面改造。
const tianjie = {
  id: 'paradisewalk-qujiang',
  name: '龙湖西安曲江天街',
  fp: '19c447dd-feb2-4bb0-923e-60730f9c28c1',
  parts: [{
    name: 'mall', kind: 'podium', fp: '19c447dd-feb2-4bb0-923e-60730f9c28c1', base: 0, top: 20,
    style: { pattern: 'verticalFins', tint: '#5c6d78', spd: '#c7c9cc', floorH: 5, colW: 0.9, spandrel: 0.35, mullW: 0.3, lit: 0.75 },
  }],
  signs: [{ text: '天街 Paradise Walk', part: 'mall', face: 'E', near: 'N', y: 16, h: 2.8, color: '#8a3fa0' }],
  supersede: { names: ['龙湖西安曲江天街', '龙湖西安曲江天街（原曲江星悦荟）', '曲江天街', '曲江星悦荟'] },
  meta: {
    dossier: 'core_south.json#龙湖西安曲江天街（原曲江星悦荟）',
    sources: ['OSM w1370886142（Overture 19c447dd，num_floors=4）', 'https://news.qq.com/rain/a/20231215A028XD00'],
    photos: ['scratchpad/dossier_core_south/photos/tianjie_0.jpg'],
    confidence: 'medium（轮廓、层数）；low（入口位置）',
    notes: '20 m = 4 层 × 5 m；立面按改造后照片（银色竖肋 + 暖灰金属）；主入口与“天街”标识位置按照片推定在东侧街面北段。',
  },
};

// 曼蒂广场（长安十二时辰）：OSM w1345440293（13956d9c，204×73）。照片 mandi_1：约 4–5 层深灰色石材方正体量，竖向长窗，局部架空跨越通道，
// 首层斜切玻璃入口；mandi_0：入口大玻璃幕墙上“曼蒂广场 MANDY PLAZA”。高度按照片数层（约 5 层）→ 22 m。
const mandi = {
  id: 'mandy-plaza',
  name: '曼蒂广场',
  fp: '13956d9c-88bc-4955-b2c1-09f2e6944980',
  parts: [{
    name: 'mall', kind: 'podium', fp: '13956d9c-88bc-4955-b2c1-09f2e6944980', base: 0, top: 22,
    style: { pattern: 'stoneWindows', tint: '#3a4046', spd: '#6c6a67', floorH: 4.4, colW: 2.2, spandrel: 0.55, mullW: 1.4, lit: 0.6 },
  }],
  signs: [{ text: '曼蒂广场 MANDY PLAZA', part: 'mall', face: 'W', y: 17, h: 2.6, color: '#ffffff' }],
  supersede: { names: ['曼蒂广场(曲江)', '曼蒂广场（曲江）', '曼蒂广场', '曼蒂广场（长安十二时辰主题街区）'] },
  meta: {
    dossier: 'core_south.json#曼蒂广场（长安十二时辰主题街区）',
    sources: ['OSM w1345440293（Overture 13956d9c）', 'http://www.as-arch.com/project/post/40462', 'http://news.cnwest.com/xian/a/2022/04/28/20552876.html'],
    photos: ['scratchpad/dossier_core_south/photos/mandi_0.jpg', 'mandi_1.jpg'],
    confidence: 'low',
    notes: '22 m 按照片数层（约 5 层 × 4.4 m）；架空通道与斜切入口未建；招牌朝向按照片（入口朝不夜城一侧）推定为西。',
  },
};

// 西安威斯汀大酒店（如恩设计）：档案无 overture_id；卫星 z19 与 OSM 分体核对，酒店为慈恩路南侧一组深灰坡屋顶体块围合的院落
// （中央长条水院，westin_2），北侧沿街为通长木色竖格栅柱廊 + 深远出挑的薄平檐（westin_3/4/5），两端深灰实墙体块嵌竖向窄窗（夜间红光）。
// “整座建筑共五层”/“地下两层、地上四层” → 地上 4 层 × 4.2 m ≈ 17 m；坡屋顶按卫星（深灰四坡顶）。
const WESTIN_BLOCKS = [
  ['n1', '0c918eb3-343e-49ca-a3e9-15fee38ebc64'], ['n2', 'fdec23bc-d30e-4de9-8ea0-f56673a546e6'], ['n3', '64121e8c-7655-4146-9b5f-3ea6c11203f2'],
  ['w', '6335c578-385b-49e6-8eff-9f9847d21f2d'], ['c', '38105fd1-c40e-4ef0-b297-f10773a0655a'],
  ['s2', '58e3f8dc-5404-43d1-a985-a7ef2c859e33'], ['s3', '3f7e8a50-4fda-4b50-83b5-58377f84e96f'], ['e', 'aaf7b707-4282-4d43-a553-8208cac4ff29'],
];
const westin = {
  id: 'westin-xian',
  name: '西安威斯汀大酒店',
  center: [1395, 4984],
  parts: [
    ...WESTIN_BLOCKS.map(([name, fp], i) => ({
      name, fp, base: 0, top: 17,
      style: { pattern: 'stoneWindows', tint: '#2e2e2e', spd: '#3b3d40', floorH: 4.2, colW: 3.0, spandrel: 0.4, mullW: 2.1, lit: 0.55, seed: 100 + i },
      roof: { mech: false, parapet: 0.3 },
      crown: { type: 'tangRoof', eave: 1.6, h: 5, curve: 0, lift: 0, base: 0.4, mat: '#3d4045', ridgeMat: '#2f3134', glow: name.startsWith('n') ? '#ffc36b' : undefined },
    })),
    // 北侧沿街木色竖格栅柱廊 + 薄平挑檐（westin_3/4）
    {
      name: 'colonnade', kind: 'facade', pts: box(1340, 4923.5, 1470, 4927.5), base: 0, top: 11,
      style: { pattern: 'verticalFins', tint: '#2a2622', spd: '#8b6a45', floorH: 11, colW: 0.55, spandrel: 0, mullW: 0.32, lit: 0.8 },
    },
    { name: 'canopy', kind: 'solid', pts: box(1332, 4919, 1478, 4930), base: 11, top: 11.6, mat: { color: '#2f3033', roughness: 0.6 } },
  ],
  signs: [
    { text: 'WESTIN', part: 'colonnade', face: 'N', y: 9, h: 1.8, color: '#ffffff' },
    { text: '威斯汀大酒店', part: 'colonnade', face: 'N', y: 3.4, h: 1.2, color: '#ffffff' },
  ],
  night: {
    floodlight: [{ part: 'n1', color: '#ff2a2a', strength: 0.45 }, { part: 'n3', color: '#ff2a2a', strength: 0.45 }, { part: 'w', color: '#ff2a2a', strength: 0.35 }], // 窄窗红光
    outline: [{ part: 'canopy', color: '#ffc36b', y: 11.6, w: 0.25 }],
  },
  supersede: { names: ['西安威斯汀大酒店', '西安威斯汀大酒店（威斯汀博物馆酒店）', "The Westin Xi'an", '西安威斯汀博物馆酒店'] },
  meta: {
    dossier: 'core_south.json#西安威斯汀大酒店（威斯汀博物馆酒店）',
    sources: ['OSM w1345440278/w1345440402/w1345440589/w1345440551/w1345440179/w1345439902/w1345439938/w1345440420（院落各体块）', 'https://neriandhu.com/zn/works/xian-westin-hotel-museum-', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_core_south/photos/westin_2.jpg（水院）', 'westin_3.jpg', 'westin_4.jpg', 'westin_5.jpg'],
    confidence: 'medium（布局、形制）；low（高度）',
    notes: '地上 4 层按资料，层高 4.2 m → 17 m；坡屋顶高 5 m、出檐 1.6 m 按照片比例；体块取卫星上深灰坡屋顶对应的 8 块 OSM 分体（院落东侧的曲江艺术博物馆 8e9232a9 未纳入）。'
      + '北侧柱廊与挑檐的位置按照片（沿慈恩路）推定，长度 130 m ±15 m。旧 landmarks2026 的“2014 年开业”与百科“2012 年 1 月”不符（档案 notes）。',
  },
};

// 西安曲江希尔顿嘉悦里酒店（Canopy by Hilton）：档案 overture_id 0309150b（38×17）只是南侧入口体量；卫星 z19 显示其北侧 OSM“锦绣唐朝”（8c819bf3）
// 为带中央玻璃采光中庭、东西两翼四坡顶的主楼，与照片 hilton_qj_0/3/5（四层回廊 + 玻璃采光顶中庭）一致 → 主楼 + 入口体量一起建。
// 照片 hilton_qj_4：竖向磨砂玻璃屏板立面、层叠唐风深灰瓦屋顶（屋角起翘、挂红灯笼）、深色挑檐入口。
const canopy = {
  id: 'canopy-qujiang',
  name: '西安曲江希尔顿嘉悦里酒店',
  fp: '0309150b-c4c6-4ebc-8435-cdb25d051bf8',
  parts: [
    {
      name: 'main', kind: 'podium', fp: '8c819bf3-d411-47fc-b25f-0aa36652bd5a', grow: -0.3, base: 0, top: 16,
      style: { pattern: 'verticalFins', tint: '#d7dde0', spd: '#4a3a2e', floorH: 4, colW: 1.4, spandrel: 0.1, mullW: 0.25, lit: 0.7 },
      crown: { type: 'pyramid', h: 3, inset: 19, mat: SKYLIGHT }, // 中央玻璃采光中庭顶
    },
    ...[['wingW', '75e3e309-534e-483d-9e86-0ce579147de8'], ['wingE', 'baf5c098-474f-4b0e-87fb-133a363557cb']].map(([name, fp], i) => ({
      name, fp, base: 0, top: 16,
      style: { pattern: 'verticalFins', tint: '#d7dde0', spd: '#4a3a2e', floorH: 4, colW: 1.4, spandrel: 0.1, mullW: 0.25, lit: 0.7, seed: 110 + i },
      roof: { mech: false, parapet: 0.3 },
      crown: { type: 'tangRoof', eave: 2, h: 6.5, mat: TANG_ROOF, glow: '#ffc36b' },
    })),
    {
      name: 'entrance', fp: '0309150b-c4c6-4ebc-8435-cdb25d051bf8', base: 0, top: 9,
      style: { pattern: 'verticalFins', tint: '#d7dde0', spd: '#4a3a2e', floorH: 4.5, colW: 1.4, spandrel: 0.1, mullW: 0.25, lit: 0.8, seed: 115 },
      roof: { mech: false, parapet: 0.3 },
      crown: { type: 'tangRoof', eave: 2.6, h: 4.5, mat: TANG_ROOF, glow: '#ffc36b', double: { gap: 3.2, out: 3, h: 1.6 } },
    },
  ],
  signs: [{ text: 'canopy 西安曲江希尔顿嘉悦里酒店', part: 'entrance', face: 'S', y: 2.2, h: 1.1, color: '#e57a2e', bg: '#111111' }],
  supersede: { names: ['西安曲江希尔顿嘉悦里酒店', '希尔顿嘉悦里酒店', "Canopy by Hilton Xi'an Qujiang", '锦绣唐朝'] },
  meta: {
    dossier: 'core_south.json#西安曲江希尔顿嘉悦里酒店',
    sources: ['OSM w1345440060（入口 0309150b）、w1345440349（主楼 8c819bf3）、w1345440346/w1345440025（两翼）', 'http://news.hsw.cn/system/2021/1001/1377740.shtml', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_core_south/photos/hilton_qj_0.jpg（中庭）', 'hilton_qj_3.jpg', 'hilton_qj_4.jpg（外观）'],
    confidence: 'medium（形制）；low（高度）',
    notes: '主楼 16 m 按中庭照片约 4 层 × 4 m；入口体量 9 m 约 2 层；屋顶高度、出檐按照片比例。“锦绣唐朝”为 OSM 旧名，按卫星与中庭照片判定为同一建筑。',
  },
};

// 西安豪享来温德姆至尊酒店：档案 overture_id 3f91e525（29×19）只是中央一块；卫星 z18 显示酒店为南北对称的整组建筑：北、南两翼（OSM 531333bb、398d6ed4，
// 各 70×53、内含小院）+ 东西连接体（4601a7de、3deeacf8）+ 中央体块（aaa0ca2f），四个外角为 18 m 见方的角楼（5b88aefa/1d9bf421/86043a6d/ed81bec0）。
// 照片 wyndham_0/1/4：米黄色石材竖向壁柱立面约 9 层，屋顶中央一座较大、四角各一座较小的唐风歇山顶楼阁（夜间金色轮廓灯）。
const WYN_STY = { pattern: 'stoneLit', tint: '#3c4652', spd: '#d8c7a4', floorH: 3.7, colW: 2.2, spandrel: 0.4, mullW: 1.0, lit: 0.6 };
const wyndham = {
  id: 'wyndham-qujiang',
  name: '西安豪享来温德姆至尊酒店',
  center: [1714, 5958],
  parts: [
    ...[['wingN', '531333bb-d699-4487-b91e-c0360880ae4d'], ['wingS', '398d6ed4-bfb9-454d-a10b-c125e0a15883'], ['linkW', '4601a7de-12eb-4fb8-be2c-220398961030'],
      ['linkE', '3deeacf8-7f8b-418b-a5a1-2be2a997d81f'], ['core', 'aaa0ca2f-7da2-48d9-af8b-7436514170f2']].map(([name, fp], i) => ({
      name, kind: 'podium', fp, base: 0, top: 33, style: { ...WYN_STY, seed: 120 + i }, roofMat: { color: '#3f6aa6', roughness: 0.7 }, // 卫星：蓝色屋面
    })),
    ...[['pavNW', '5b88aefa-b089-40a9-8641-0fc568473b40'], ['pavNE', '1d9bf421-ac96-4679-86dd-da5f14a6845a'], ['pavSW', '86043a6d-c9fe-41cf-a5ba-be508d7b9323'],
      ['pavSE', 'ed81bec0-b855-4222-bd32-e11141ca077d']].map(([name, fp], i) => ({
      name, fp, grow: -2, base: 33, top: 37.5,
      style: { pattern: 'verticalFins', tint: '#3c4652', spd: '#b8472e', floorH: 4.5, colW: 2.2, spandrel: 0.1, mullW: 0.6, lit: 0.7, seed: 130 + i },
      roof: { mech: false, parapet: 0.3 },
      crown: { type: 'tangRoof', eave: 2.2, h: 4.5, mat: TANG_ROOF, glow: '#ffc36b' },
    })),
    {
      name: 'pavC', shape: 'rect', size: [30, 20], at: [1713.8, 5958.1], rot: 90, base: 33, top: 39,
      style: { pattern: 'verticalFins', tint: '#3c4652', spd: '#b8472e', floorH: 6, colW: 2.4, spandrel: 0.1, mullW: 0.6, lit: 0.7, seed: 135 },
      roof: { mech: false, parapet: 0.3 },
      crown: { type: 'tangRoof', eave: 3, h: 6.5, mat: TANG_ROOF, glow: '#ffc36b', double: { gap: 3.5, out: 3, h: 1.8 } },
    },
  ],
  signs: [{ text: 'WYNDHAM GRAND', part: 'wingS', face: 'S', near: 'W', y: 2.6, h: 1.3, color: '#ffffff' }],
  supersede: { names: ['西安豪享来温德姆至尊酒店', '豪享来温德姆至尊酒店', "Wyndham Grand Xi'an South", '温德姆至尊'] },
  meta: {
    dossier: 'core_south.json#西安豪享来温德姆至尊酒店',
    sources: ['OSM w1346632871（3f91e525）及周边同组 w1346632868/72/76/66、r18470706、角楼 w1346632914/49/57/58', 'Esri World Imagery z18（对称布局、蓝色屋面、四角角楼）', 'http://www.sohu.com/a/199068137_621890'],
    photos: ['scratchpad/dossier_core_south/photos/wyndham_0.jpg', 'wyndham_1.jpg', 'wyndham_4.jpg'],
    confidence: 'medium（布局）；low（高度）',
    notes: '33 m 按照片数层（约 9 层 × 3.7 m）；屋顶楼阁高度按照片比例（中央楼阁重檐，屋面约 6.5 m；角楼约 4.5 m）；角楼平面取 OSM 18 m 见方分体内缩 2 m。',
  },
};

// ═══════════════════════════ 长安路（南二环—小寨）文体建筑 ═══════════════════════════
// 陕西省体育场（朱雀体育场）：OSM r17606811（14b0cd4a，南北 294 × 东西 204 椭圆）。照片 tiyuchang_0/2/3/5：椭圆看台碗，
// 外皮银灰色斜向菱形格栅 + 中部一道红色水平波浪饰带；东、西主看台上方白色平挑罩棚（西侧较大、外沿红字“陕西省体育场”），南北弯道无顶；
// 看台座椅红/橙色。卫星 z18：田径场内沿约 104 × 178 m，罩棚各约 40 × 140 m。高度无资料：外壳约 28 m、罩棚顶约 35 m，
// 按照片比例（以背景陕西信息大厦 196 m 屋面为尺度，±8 m）。看台用三级椭圆环台阶近似（顶面红色为座椅）。
const ST = { cx: -449, cz: 2997 };
const STADIUM_SKIN = { pattern: 'grid', tint: '#8f969c', spd: '#b8bcc0', floorH: 3.2, colW: 2.2, spandrel: 0.55, mullW: 0.35, lit: 0.3 };
const stadium = {
  id: 'shaanxi-stadium',
  name: '陕西省体育场',
  fp: '14b0cd4a-e305-4bfd-a79a-5be2422a3611',
  center: [ST.cx, ST.cz],
  parts: [
    ...[[70, 112, 52, 91, 6], [86, 130, 67, 108, 15], [102, 147, 83, 126, 28]].map(([a, b, ha, hb, top], i) => ({
      name: 't' + (i + 1), kind: 'podium', pts: ellipse(ST.cx, ST.cz, a, b), holes: [ellipse(ST.cx, ST.cz, ha, hb)], base: 0, top,
      style: { ...STADIUM_SKIN, seed: 140 + i }, roofMat: { color: '#c8452c', roughness: 0.85 }, // 顶面 = 红色座椅
    })),
    // 东、西主看台后部结构 + 白色平挑罩棚（按卫星量取；此处影像条带倾斜很小——同幅美术博物馆圆鼓屋面与 OSM 轮廓重合——未做倾斜改正，±5 m）
    { name: 'standW', pts: box(-551, 2944, -531, 3084), base: 0, top: 34, style: { ...STADIUM_SKIN, seed: 150 }, roof: { mech: false, parapet: 0.3 } },
    { name: 'standE', pts: box(-352, 2940, -334, 3080), base: 0, top: 33, style: { ...STADIUM_SKIN, seed: 151 }, roof: { mech: false, parapet: 0.3 } },
    { name: 'canopyW', kind: 'solid', pts: box(-552, 2942, -508, 3086), base: 34, top: 35.6, mat: { color: '#eeeeea', roughness: 0.55 } },
    { name: 'canopyE', kind: 'solid', pts: box(-374, 2936, -330, 3080), base: 33, top: 34.6, mat: { color: '#eeeeea', roughness: 0.55 } },
  ],
  bands: [{ part: 't3', levels: [14], wave: { amp: 4, len: 160, phase: 0.6 }, h: 2.2, depth: 0.4, color: '#c8322a' }], // 红色水平波浪饰带
  signs: [{ text: '陕西省体育场', part: 'canopyW', face: 'W', y: 34.8, h: 1.4, color: '#d7261e' }],
  supersede: { names: ['陕西省体育场（“圣朱雀”）', '陕西省体育场', '陕西省体育场（朱雀体育场）', '朱雀体育场', '圣朱雀'] },
  meta: {
    dossier: 'core_south.json#陕西省体育场（朱雀体育场）；public.json#陕西省体育场',
    sources: ['OSM r17606811（Overture 14b0cd4a）', 'https://zh.wikipedia.org/wiki/陕西省体育场', 'https://new.qq.com/omn/20200720/20200720A0VM0I00.html（2018–2020 改造）', 'Esri World Imagery z18'],
    photos: ['scratchpad/dossier_core_south/photos/tiyuchang_0.jpg', 'tiyuchang_2.jpg', 'tiyuchang_3.jpg', 'tiyuchang_5.jpg'],
    confidence: 'medium（平面、形制）；low（高度）',
    notes: '外壳 28 m、罩棚 34–35.6 m 按照片比例估计（±8 m）；看台用三级椭圆环台阶近似（内沿 52×91 m → 外沿 102×147 m 半轴，按卫星量取）。'
      + '菱形斜格栅用明框网格立面近似；照片西北侧“奥林匹克大厦”两座带蓝色圆形装饰的塔楼不在本条目内。',
  },
};

// 陕西省图书馆（长安北路主馆，张锦秋）：OSM r17606810（928a0ecd，130×81，含内院）。档案：照片不足以判读整体形体；
// 卫星 z19：西半部为围合内院的回字形楼，中部一块较高体量（屋面有条形采光顶），东南角为 1/4 圆玻璃转角（轮廓 r≈20.5 m 圆弧），
// 其外为弧形门廊（Commons 照片：巨大圆柱与弧形挑梁组成的米黄色石材门廊）。高度：建筑面积 4.7 万 m² ÷ 轮廓 7040 m² ≈ 6.7 层 → 主体 28 m、中部 36 m。
const library = {
  id: 'shaanxi-library',
  name: '陕西省图书馆',
  fp: '928a0ecd-24bb-49c1-8d19-3402c1f74e70',
  parts: [
    {
      name: 'main', kind: 'podium', fp: '928a0ecd-24bb-49c1-8d19-3402c1f74e70', holes: 'fp', base: 0, top: 28,
      style: { pattern: 'stoneWindows', tint: '#3e4a52', spd: '#d8ccb4', floorH: 4.2, colW: 2.6, spandrel: 0.45, mullW: 1.0, lit: 0.6 },
    },
    {
      name: 'center', shape: 'rect', size: [46, 42], at: [-126, 3097], base: 0, top: 36,
      style: { pattern: 'stoneWindows', tint: '#3e4a52', spd: '#d8ccb4', floorH: 4.2, colW: 2.6, spandrel: 0.45, mullW: 1.0, lit: 0.6, seed: 160 },
      roof: { mech: false, parapet: 1.2 },
      crown: [{ type: 'arch', along: 'short', h: 2.5, mat: SKYLIGHT }],
    },
    {
      name: 'lobby', // 东南角 1/4 圆玻璃转角（圆心、半径由 OSM 轮廓圆弧拟合）
      shape: 'circle', size: [41, 41], at: [-112, 3095], cut: [{ face: 'W', by: 20.5 }, { face: 'N', by: 20.5 }], grow: 0.3, base: 0, top: 22,
      style: { pattern: 'curtain', tint: '#6e97b3', spd: '#d8ccb4', floorH: 4.4, colW: 1.8, spandrel: 0.1, mullW: 0.1, lit: 0.8 },
      roof: { mech: false, parapet: 0.8 },
    },
  ],
  supersede: { names: ['陕西省图书馆（长安北路主馆）', '陕西省图书馆', '陕西省图书馆（长安路馆区）', '陕图'] },
  meta: {
    dossier: 'core_south.json#陕西省图书馆（长安路馆区）；public.json#陕西省图书馆（长安北路主馆）',
    sources: ['OSM r17606810（Overture 928a0ecd）', 'https://zh.wikipedia.org/wiki/陕西省图书馆（建筑面积 4.7 万 m²）', 'Esri World Imagery z19'],
    photos: ['Commons Category:Shaanxi_Library（陕西省图书馆_5：门廊）'],
    confidence: 'low（高度、中部体量范围）；medium（轮廓）',
    notes: '高度无资料：按建筑面积 ÷ 轮廓面积 ≈ 6.7 层推算主体 28 m、中部 36 m（±6 m）；中部体量范围按卫星屋面量取（±5 m）。'
      + '入口弧形石材门廊（巨大圆柱 + 弧形挑梁）的尺寸无照片可量，未建。',
  },
};

// 陕西省美术博物馆（张锦秋，2000）：OSM w1284311239（54592e86，约 57 m 直径的圆鼓）。照片 tushuguan_1（档案美术博物馆照片）：
// 大半径圆筒，米黄色石材横向分缝、实墙为主，首层拱形窗洞，顶部一道檐口线脚；卫星：屋面中央一圈圆形采光。
// 高度按照片比例（鼓高约为直径的 0.45）→ 26 m。
const artMuseum = {
  id: 'shaanxi-art-museum',
  name: '陕西省美术博物馆',
  fp: '54592e86-74f1-49a0-87c3-8e79dc19e788',
  parts: [{
    name: 'drum', fp: '54592e86-74f1-49a0-87c3-8e79dc19e788', base: 0, top: 26,
    style: { pattern: 'stoneWindows', tint: '#3e4a52', spd: '#d2c3a5', floorH: 5.2, colW: 5.0, spandrel: 0.82, mullW: 4.2, lit: 0.35 },
    roof: { mech: false, parapet: 1.6 },
    crown: [{ type: 'dome', r: 9, h: 3.5, mat: SKYLIGHT, ring: false }],
  }],
  bands: [{ part: 'drum', levels: [22.6, 5.6], h: 0.7, depth: 0.5, color: '#c9b999' }], // 檐口线脚、首层线脚
  signs: [{ text: '陕西省美术博物馆', part: 'drum', face: 'NE', y: 17, h: 2.2, color: '#4a4036' }, { text: 'SHAANXI PROVINCE ART MUSEUM', part: 'drum', face: 'NE', y: 14.9, h: 0.9, color: '#4a4036' }],
  supersede: { names: ['陕西省美术博物馆'] },
  meta: {
    dossier: 'core_south.json#陕西省美术博物馆；public.json#陕西省美术博物馆',
    sources: ['OSM w1284311239（Overture 54592e86）', 'https://zh.wikipedia.org/wiki/陕西省美术博物馆', 'Esri World Imagery z18'],
    photos: ['scratchpad/dossier_core_south/photos/tushuguan_1.jpg'],
    confidence: 'medium（形体）；low（高度）',
    notes: '26 m 按照片比例（鼓高 ÷ 直径 ≈ 0.45）；入口朝东北（长安北路）按档案 podium.entrance；首层拱形窗洞未单独建。',
  },
};

// ═══════════════════════════ 曲江新区其他公建 ═══════════════════════════
// 曲江国际会议中心：OSM w254474161（79dacabd，187×89）。档案照片（航拍，背景电视塔）归属存疑（档案 confidence low）；
// 本次以卫星 z19 为准：屋面为南北向多跨筒拱金属屋面（东部三跨较高）+ 西部两道条形玻璃采光带。高度无资料，保守取西部 18 m、东部大厅 24 m。
const conference = {
  id: 'qujiang-conference',
  name: '曲江国际会议中心',
  fp: '79dacabd-9426-4bd4-b5a8-6215fdd4163c',
  parts: [
    {
      name: 'hall', kind: 'podium', fp: '79dacabd-9426-4bd4-b5a8-6215fdd4163c', base: 0, top: 18,
      style: { pattern: 'grid', tint: '#6d8494', spd: '#d9d6ce', floorH: 6, colW: 3.0, spandrel: 0.3, mullW: 0.3, lit: 0.6 },
      roofMat: { color: '#d4d6d6', roughness: 0.6, metalness: 0.3 },
      crown: [
        { type: 'arch', at: [703.5, 7298], size: [36, 7], rot: 90, h: 1.2, mat: SKYLIGHT },
        { type: 'arch', at: [737, 7298], size: [36, 7], rot: 90, h: 1.2, mat: SKYLIGHT },
      ],
    },
    {
      name: 'hallE', pts: box(745, 7270, 840, 7348), base: 0, top: 24,
      style: { pattern: 'grid', tint: '#6d8494', spd: '#d9d6ce', floorH: 6, colW: 3.0, spandrel: 0.3, mullW: 0.3, lit: 0.6, seed: 170 },
      roof: { mech: false, parapet: 0.6 },
      crown: [ // 三跨南北向筒拱（卫星量取）
        { type: 'arch', at: [759, 7309], size: [76, 25], rot: 90, h: 5, mat: { color: '#d4d6d6', roughness: 0.5, metalness: 0.4 } },
        { type: 'arch', at: [785.5, 7309], size: [76, 27], rot: 90, h: 6, mat: { color: '#d4d6d6', roughness: 0.5, metalness: 0.4 } },
        { type: 'arch', at: [818, 7309], size: [76, 35], rot: 90, h: 6.5, mat: { color: '#d4d6d6', roughness: 0.5, metalness: 0.4 } },
      ],
    },
  ],
  supersede: { names: ['曲江国际会议中心', '西安曲江国际会议中心'] },
  meta: {
    dossier: 'core_south.json#曲江国际会议中心',
    sources: ['OSM w254474161（Overture 79dacabd）', 'Esri World Imagery z19（筒拱屋面、采光带）'],
    photos: ['scratchpad/dossier_core_south/photos/huiyi_2.jpg（归属存疑，未采用其唐风屋顶）'],
    confidence: 'low',
    notes: '档案照片 huiyi_2（唐风浅灰屋顶）与卫星屋面（多跨筒拱 + 采光带）不符，按卫星建；高度无资料，保守取 18/24 m，筒拱矢高按卫星阴影比例 5–6.5 m。',
  },
};

// 西安广电大剧院（西安广播电视台·曲江）：OSM r17385274（3b79bb19，71×63）。照片 xagdzx_1/3：不规则多面体“水晶”体量，三角形分格玻璃，
// 上半蓝色、下半黄色（夜间整体紫光），背后深色方盒（舞台塔），盒顶红字“西安广电大剧院”；卫星 z19：水晶在西、方盒（OSM 9c916795）在东。
// 高度无资料：按照片比例，水晶约 20 m（腰部最宽）、方盒 24 m。
const XT = { at: [2643, 5970] };
const xaTheater = {
  id: 'xa-broadcast-theater',
  name: '西安广电大剧院',
  fp: '3b79bb19-1a91-4be5-b1a0-cade01534c1a',
  parts: [
    {
      name: 'crystalLow', shape: 'chamfer', size: [42, 52], shapeOpt: { c: 9 }, at: XT.at, base: 0, top: 9, taper: 1.14,
      style: { pattern: 'grid', tint: '#e8b93a', spd: '#dcdcdc', floorH: 4.5, colW: 3.4, spandrel: 0.06, mullW: 0.2, lit: 0.9 },
      roof: { mech: false, parapet: 0.2 },
    },
    {
      name: 'crystalUp', shape: 'chamfer', size: [47.9, 59.3], shapeOpt: { c: 10.3 }, at: XT.at, base: 9, top: 20, taper: 0.76,
      style: { pattern: 'grid', tint: '#4a5fbf', spd: '#dcdcdc', floorH: 5.5, colW: 3.4, spandrel: 0.06, mullW: 0.2, lit: 0.9, seed: 175 },
      roof: { mech: false, parapet: 0.3 },
    },
    {
      name: 'box', fp: '9c916795-2d3a-45e3-99c0-a0dd139bdbc0', base: 0, top: 24,
      style: { pattern: 'grid', tint: '#2e3338', spd: '#3a3f44', floorH: 4, colW: 3, spandrel: 0.7, mullW: 1.2, lit: 0.3 },
      roof: { parapet: 1 },
    },
  ],
  signs: [{ text: '西安广电大剧院', part: 'box', face: 'W', y: 22.4, h: 2.6, color: '#d7261e' }],
  night: { floodlight: [{ part: 'crystalLow', color: '#7a4dff', strength: 0.55 }, { part: 'crystalUp', color: '#7a4dff', strength: 0.55 }] },
  supersede: { names: ['西安广电大剧院', '西安广电大剧院（西安广播电视台·曲江）', '广电大剧院'] },
  meta: {
    dossier: 'core_south.json#西安广电大剧院（西安广播电视台·曲江）',
    sources: ['OSM r17385274（Overture 3b79bb19）、w1266043151（方盒 9c916795）', 'https://www.nipic.com/detail/huitu/20190414/091920733140.html', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_core_south/photos/xagdzx_1.jpg', 'xagdzx_3.jpg（夜景）'],
    confidence: 'low（高度）；medium（形制）',
    notes: '水晶体用上下两段反向收分的切角多边形近似（腰部 9 m 处最宽），三角分格用明框网格近似；高度按照片比例（水晶约为方盒的 0.8）。',
  },
};

// 陕西广电大剧院（长安中路，陕西广播电视中心院内）：OSM r19307924（e171d077，南北 110 × 东西 85）。照片 gdjuyuan_0：
// 弧形/椭圆剧场体量，外立面 3–4 道水平玻璃带与深色窗间墙，坐在折线形混凝土基座上，顶部红字“广电大剧院”；后部深色方盒（舞台塔）。
// 卫星 z18：北半部为深色平屋面方盒、南半部为圆弧形体量（已扣除倾斜）。高度按照片比例：基座 10 m、椭圆体 24 m、方盒 30 m。
const sxTheater = {
  id: 'sx-broadcast-theater',
  name: '陕西广电大剧院',
  fp: 'e171d077-20ff-4734-a097-2724663287e9',
  parts: [
    {
      name: 'base', kind: 'podium', fp: 'e171d077-20ff-4734-a097-2724663287e9', base: 0, top: 10,
      style: { pattern: 'stoneWindows', tint: '#3a4046', spd: '#9a9894', floorH: 5, colW: 3.2, spandrel: 0.6, mullW: 1.6, lit: 0.5 },
    },
    {
      name: 'oval', shape: 'ellipse', size: [64, 62], at: [-128, 5415], base: 10, top: 24,
      style: { pattern: 'horizontalBands', tint: '#5d6c73', spd: '#4a4d50', floorH: 3.5, colW: 3.0, spandrel: 0.45, mullW: 0.05, lit: 0.7 },
      roof: { mech: false, parapet: 1.0 },
    },
    {
      name: 'fly', pts: box(-168, 5340, -94, 5379), base: 0, top: 30,
      style: { pattern: 'grid', tint: '#2e3338', spd: '#35393d', floorH: 5, colW: 3, spandrel: 0.75, mullW: 1.4, lit: 0.25 },
    },
  ],
  signs: [{ text: '广电大剧院', part: 'oval', face: 'N', y: 26, h: 3.4, color: '#d7261e' }],
  supersede: { names: ['陕西广电大剧院', '陕西广播电视台大剧院'] },
  meta: {
    dossier: 'core_south.json#陕西广电大剧院',
    sources: ['OSM r19307924（Overture e171d077）', 'http://www.douyin.com/note/7508187355842350375', 'Esri World Imagery z18'],
    photos: ['scratchpad/dossier_core_south/photos/gdjuyuan_0.jpg'],
    confidence: 'low',
    notes: '高度无资料，按照片比例（椭圆体约 4 道横向玻璃带、坐在约 2 层高的基座上；方盒略高于椭圆体）；椭圆体与方盒位置按卫星量取（±8 m）。'
      + '同院的“陕西省广播电视中心编播大楼（106 m）”档案无照片、坐标 35 m 内卫星上也找不到对应高楼，未建。',
  },
};

// ═══════════════════════════ 南门外 · 南稍门 ═══════════════════════════
// 华侨城·长安国际中心（含王府井百货永宁门店）：OSM w391322276（3786683c，126×82）裙楼 + 4 个约 42×30 m 塔楼分体（2×2）。
// 照片 changan_gj_2（由北侧永宁门广场向南）：前排两座约 12 层玻璃塔（顶部“CAKG”“长安控股”），后排居中最高一座挂“华侨城·长安国际”（约 22 层），
// 中间为抬高的入口平台；changan_gj_0：塔顶“HSBC 汇丰”“BEA 东亚银行”红字；首层 GUCCI/Zegna/PRADA 等店面。
// 高度：项目“总层高 22 层”（网易/安居客）→ 后排 22 层 × 4.2 m ≈ 92 m；前排按照片数层约 12 层 → 50 m；裙楼 3 层 → 14 m。
// 夜景（2026-10 修正）：原 curtain 按 4.5 m 一组随机亮灯、暗处玻璃死黑，远看像二维码 → office：整层成片的冷白办公灯 + 玻璃反射城市天光的深蓝灰底色。
const CAG_STY = { pattern: 'office', tint: '#3a5570', spd: '#7d8c98', floorH: 4.2, colW: 1.5, spandrel: 0.2, mullW: 0.08, lit: 0.5 };
const changanIntl = {
  id: 'changan-intl-center',
  name: '华侨城·长安国际中心',
  fp: '3786683c-f19c-40b1-aa94-2f58501926ef',
  parts: [
    {
      // 裙楼原 lit 0.9 + 窗槛墙 0.2：夜里一整圈通亮白带过曝；王府井百货裙楼石材为主、橱窗为辅 → 窗槛墙加大、亮灯率减半
      name: 'podium', kind: 'podium', fp: '3786683c-f19c-40b1-aa94-2f58501926ef', grow: -0.3, base: 0, top: 14,
      style: { pattern: 'retail', tint: '#2f3c47', spd: '#8a6a3a', floorH: 4.7, colW: 3.4, spandrel: 0.42, mullW: 0.3, lit: 0.5 },
    },
    ...[['towerNW', '863b36ab-8f97-4b3d-b5be-a85a75b7edc8', 50], ['towerNE', '87701acc-5de8-4e9f-9615-6169277ac741', 50],
      ['towerSW', 'a873ff83-f19a-4ec1-acbb-2219f883213d', 92], ['towerSE', '3bccb574-22c2-4629-a877-9574ff9fe749', 92]].map(([name, fp, top], i) => ({
      name, fp, base: 0, top, style: { ...CAG_STY, seed: 180 + i }, roof: { parapet: 1.6 },
    })),
  ],
  signs: [
    { text: '华侨城·长安国际', part: 'towerSE', face: 'N', y: 88.5, h: 3.2, color: '#ffffff' },
    { text: 'CAKG', part: 'towerNW', face: 'N', y: 47, h: 2.6, color: '#ffffff' },
    { text: '长安控股', part: 'towerNE', face: 'N', y: 47, h: 2.6, color: '#ffffff' },
    { text: 'HSBC 汇丰', part: 'towerNW', face: 'W', y: 47, h: 2.6, color: '#db0011' },
    { text: 'BEA 东亚银行', part: 'towerSW', face: 'W', y: 88.5, h: 2.8, color: '#c8102e' },
    { text: '王府井百货', part: 'podium', face: 'E', y: 9, h: 2.2, color: '#8a6a3a' },
  ],
  supersede: { names: ['王府井百货(永宁门店)', '华侨城·长安国际中心', '长安国际中心', '华侨城长安国际', '西安王府井百货(永宁门店)', '长安国际中心（南关正街）'] },
  meta: {
    dossier: 'core_south.json#华侨城·长安国际中心（含王府井百货永宁门店）',
    sources: ['OSM w391322276（3786683c）及塔楼分体 w1284311033/w1284310733/w1284311171/w1284311095', 'http://www.163.com/dy/article/FCDBFTQQ0517NTNF.html（总层高 22 层）'],
    photos: ['scratchpad/dossier_core_south/photos/changan_gj_0.jpg', 'changan_gj_2.jpg', 'changan_gj_3.jpg'],
    confidence: 'medium（布局）；low（各塔高度）',
    notes: '“总层高 22 层”取为后排两塔；前排两塔按照片数层约 12 层 × 4.2 m；裙楼 14 m 按照片约 3 层。HSBC/BEA 字牌所在塔与朝向按照片推定。'
      + 'landmarks2026 把“长安国际中心”放在南关正街的另一处坐标，档案已核实应为此处四塔组团。',
  },
};

// 西安合生汇（原世纪金花·珠江时代广场）：档案无 overture_id；OSM“南门合生汇”（14a753d7，南北 102 × 东西 60）即商场本体，
// 东侧“珠江时代广场”（846fb5bb，71×22）为照片 hehui_1/5 中商场后方的深色玻璃塔楼（顶挂“珠江地产”）。
// 商场“B1–L5”（赢商网）→ 5 层 × 5.4 m = 27 m，米金色方格纹饰面；塔楼无层数资料，按照片比例约为商场的 2 倍 → 55 m。
const hehui = {
  id: 'hehui-nanmen',
  name: '西安合生汇',
  fp: '14a753d7-d6d7-42f8-8bfb-d81d1bd15adf',
  parts: [
    {
      name: 'mall', kind: 'podium', fp: '14a753d7-d6d7-42f8-8bfb-d81d1bd15adf', base: 0, top: 27,
      style: { pattern: 'grid', tint: '#4a5c6c', spd: '#cdb68a', floorH: 2.7, colW: 2.7, spandrel: 0.62, mullW: 0.62, lit: 0.55 },
    },
    {
      name: 'tower', fp: '846fb5bb-292b-48af-b935-58c3281dc054', base: 0, top: 55,
      style: { pattern: 'curtain', tint: '#4a5c6c', spd: '#5c6a76', floorH: 4.0, colW: 1.5, spandrel: 0.2, mullW: 0.1, lit: 0.5 },
    },
  ],
  signs: [
    { text: '合生汇', part: 'mall', face: 'N', y: 23, h: 4, color: '#c9a646' },
    { text: '珠江地产', part: 'tower', face: 'N', y: 51.5, h: 2.4, color: '#ffffff' },
  ],
  supersede: { names: ['西安合生汇', '西安合生汇（原世纪金花·珠江时代广场）', '南门合生汇', '珠江时代广场', '世纪金花珠江时代广场店'] },
  meta: {
    dossier: 'core_south.json#西安合生汇（原世纪金花·珠江时代广场）',
    sources: ['OSM w1291043602（南门合生汇 14a753d7）、w1291042684（珠江时代广场 846fb5bb）', 'http://m.winshang.com/news707957.html（B1–L5）'],
    photos: ['scratchpad/dossier_core_south/photos/hehui_1.jpg', 'hehui_5.jpg'],
    confidence: 'low',
    notes: '商场 27 m 按“地上 5 层”× 5.4 m；塔楼 55 m 按照片比例（±15 m）；照片为 2022 改造前外观（CENTURY GINWA），改造后立面未取得清晰照片，招牌按改造后名称。',
  },
};

// 西安金花豪生国际大酒店：OSM w1284310797（7cae1c50，106×90，整组）。照片 haosheng_0（酒店宣传图）：板式塔楼（中部通高金色玻璃竖带、两侧灰色、
// 顶部半圆拱形收头，21 层）；左前方约 8 层金色玻璃圆筒，顶为外挑“飞碟”圆盘；右侧银灰横向带窗圆柱高塔，顶部一圈放射状尖肋 + 桅杆；灰色石材裙楼。
// 卫星 z18：北侧椭圆环形屋顶（圆筒飞碟顶）、东南白色圆顶（圆柱塔）、中部板楼。21 层 × 3.8 m ≈ 80 m；圆筒 32 m；圆柱塔按照片约为板楼 0.9 倍 → 72 m。
const haosheng = {
  id: 'howard-johnson-ginwa',
  name: '西安金花豪生国际大酒店',
  fp: '7cae1c50-b6d6-4191-9228-fe523d3d807a',
  parts: [
    {
      name: 'podium', kind: 'podium', fp: '7cae1c50-b6d6-4191-9228-fe523d3d807a', base: 0, top: 16,
      style: { pattern: 'stoneWindows', tint: '#2f3a42', spd: '#8e949a', floorH: 5.3, colW: 3.0, spandrel: 0.4, mullW: 1.0, lit: 0.7 },
    },
    {
      name: 'slab', shape: 'rect', size: [42, 22], at: [-318, 1046], base: 0, top: 80,
      style: { pattern: 'curtain', tint: '#b8963e', spd: '#9aa0a6', floorH: 3.8, colW: 1.8, spandrel: 0.3, mullW: 0.3, lit: 0.55 },
      roof: { mech: false },
      crown: [{ type: 'arch', along: 'short', h: 9, mat: { color: '#9aa0a6', metalness: 0.5, roughness: 0.4 } }], // 宽面上的半圆拱形收头（拱轴垂直宽面）
    },
    {
      name: 'drum', shape: 'circle', size: [30, 30], at: [-322, 1012], base: 0, top: 32,
      style: { pattern: 'curtain', tint: '#b8963e', spd: '#d7c08a', floorH: 4, colW: 1.6, spandrel: 0.15, mullW: 0.1, lit: 0.6 },
      roof: { mech: false },
      crown: [{ type: 'disk', r: 23, h: 3, rimH: 1.2, mat: { color: '#c9b27a', metalness: 0.6, roughness: 0.35 } }], // 飞碟圆盘顶
    },
    {
      name: 'rotunda', shape: 'circle', size: [26, 26], at: [-280, 1058], base: 0, top: 72,
      style: { pattern: 'horizontalBands', tint: '#8e949a', spd: '#c8ccd0', floorH: 3.6, colW: 2.2, spandrel: 0.35, mullW: 0.3, lit: 0.5 },
      roof: { mech: false },
      crown: [
        { type: 'frame', h: 6, inset: -1.5, step: 2.2, post: 0.35, mat: 'metal' }, // 放射状尖肋环（近似）
        { type: 'spire', len: 16 },
      ],
    },
  ],
  signs: [{ text: '金花豪生国际大酒店', part: 'slab', face: 'N', y: 70, h: 3, color: '#e8e8e8' }, { text: 'Howard Johnson', part: 'podium', face: 'N', y: 12, h: 2, color: '#ffffff' }],
  supersede: { names: ['西安金花豪生国际大酒店', '金花豪生国际大酒店(环城南路店)', '金花豪生'] },
  meta: {
    dossier: 'core_south.json#西安金花豪生国际大酒店',
    sources: ['OSM w1284310797（Overture 7cae1c50）', 'https://hotels.ctrip.com/hotels/420030.html（楼高 21 层）', 'Esri World Imagery z18'],
    photos: ['scratchpad/dossier_core_south/photos/haosheng_0.jpg'],
    confidence: 'low',
    notes: '板楼 80 m 按“21 层”× 3.8 m；圆筒 32 m、圆柱塔 72 m 按照片比例；三者位置按卫星屋顶形状推定（±10 m）。板楼“竖排店名”改为横排（招牌库不支持竖排）。'
      + '档案注：右侧圆柱塔是否属酒店本体未核实，但其屋顶在 OSM 整组轮廓内，一并建。',
  },
};

// ═══════════════════════════ 长安路南段 · 雁塔西路 ═══════════════════════════
// 西安交通大学第一附属医院（雁塔西路院区）：门急诊大楼 OSM r19307911（3622261a，149×86，含 6 个内院）+ 北侧住院高层板楼（OSM w1411003683，2c60ad1f，127×32）。
// 照片 yifuyuan_5：白色面砖板式高层，两端略凸出，屋顶立红色“交大一附院”大字；前部多层白色门诊楼顶有“门诊部”字。
// 高层按照片数层约 20 层 × 3.9 m ≈ 78 m；门诊楼约 5 层 × 4.4 m = 22 m。
const yifuyuan = {
  id: 'xjtu-hospital-1',
  name: '西安交通大学第一附属医院',
  fp: '3622261a-9377-4070-aac9-f1e1e580ff62',
  parts: [
    {
      name: 'ward', fp: '2c60ad1f-aa27-4a6a-b019-145989062537', base: 0, top: 78,
      style: { pattern: 'stoneWindows', tint: '#6d7d88', spd: '#eeeeea', floorH: 3.9, colW: 2.4, spandrel: 0.5, mullW: 1.0, lit: 0.6 },
      roof: { parapet: 1.4 },
    },
    {
      name: 'clinic', kind: 'podium', fp: '3622261a-9377-4070-aac9-f1e1e580ff62', holes: 'fp', base: 0, top: 22,
      style: { pattern: 'stoneWindows', tint: '#6d7d88', spd: '#eeeeea', floorH: 4.4, colW: 2.6, spandrel: 0.45, mullW: 1.0, lit: 0.65 },
    },
  ],
  signs: [
    { text: '交大一附院', part: 'ward', face: 'S', y: 82, h: 5, color: '#d7261e' }, // 屋顶大字（立在女儿墙上）
    { text: '门诊部', part: 'clinic', face: 'S', y: 19.5, h: 2.6, color: '#d7261e' },
  ],
  supersede: { names: ['西安交通大学第一附属医院（雁塔西路院区）', '西安交通大学医学院第一附属医院-门急诊大楼', '交大一附院'] },
  meta: {
    dossier: 'core_south.json#西安交通大学第一附属医院（雁塔西路院区）；public.json#西安交通大学第一附属医院（雁塔西路院区）',
    sources: ['OSM r19307911（3622261a）、w1411003683（2c60ad1f）', 'https://www.xjtu.edu.cn/info/1058/5539.htm', 'Esri World Imagery z18（北侧长条高层板楼，南立面可见）'],
    photos: ['scratchpad/dossier_core_south/photos/yifuyuan_5.jpg'],
    confidence: 'low（高度）；medium（形体）',
    notes: '住院高层 78 m 按照片数层（约 20 层）；门诊楼 22 m 按照片约 5 层；高层板楼对应 OSM 2c60ad1f 按卫星（北侧长条、南立面宽，为高层）判定。',
  },
};

// 陕西自然博物馆（2008）：OSM w254328024（719faa0f，南北 130 × 东西 46）。档案：外径 38 m 的球体科技馆（内有 18 m 球幕影院）+ 3 层自然馆，
// 球体为银灰三角分格网壳、下有 1 层石材裙房（Commons 2025-11-13 照片）；卫星 z18：球体在北端，南侧为带内院的低层馆舍。
// 档案写“月牙形自然馆”，卫星与 OSM 轮廓为矩形，按轮廓建。
const natMuseum = {
  id: 'shaanxi-natural-museum',
  name: '陕西自然博物馆',
  fp: '719faa0f-78cd-4ff2-82ff-7c5bf29c39d2',
  parts: [
    {
      name: 'hall', kind: 'podium', fp: '719faa0f-78cd-4ff2-82ff-7c5bf29c39d2', cut: { face: 'N', by: 42 }, base: 0, top: 15,
      style: { pattern: 'stoneWindows', tint: '#3e4a52', spd: '#c8c0b0', floorH: 5, colW: 3.0, spandrel: 0.5, mullW: 1.2, lit: 0.55 },
    },
    {
      name: 'plinth', shape: 'circle', size: [44, 44], at: [-42, 6901], base: 0, top: 6,
      style: { pattern: 'stoneWindows', tint: '#3e4a52', spd: '#c8c0b0', floorH: 6, colW: 3.0, spandrel: 0.5, mullW: 1.2, lit: 0.6 },
      roof: { mech: false, parapet: 0.6 },
      crown: [{ type: 'dome', full: true, r: 19, h: 38, y: 4, mat: { color: '#9aa3aa', metalness: 0.6, roughness: 0.3 }, ring: false }],
    },
  ],
  supersede: { names: ['陕西自然博物馆'] },
  meta: {
    dossier: 'public.json#陕西自然博物馆',
    sources: ['OSM w254328024（Overture 719faa0f）', 'https://zh.wikipedia.org/wiki/陕西自然博物馆（球体外径 38 m）', 'https://www.sxnm.net/', 'Esri World Imagery z18'],
    photos: ['Commons 2025-11-13 照片（档案目视）'],
    confidence: 'medium（球体）；low（馆舍高度）',
    notes: '球体外径 38 m 按资料；球底埋入 1 层石材裙房（6 m）约 2 m；自然馆“三层”× 5 m = 15 m；“月牙形”平面未能在卫星/轮廓上核实，按 OSM 矩形轮廓建。',
  },
};

// 西安城南客运站：OSM w360836368（5a28856a，东西 141 × 南北 39）。档案：米黄/土黄色外墙上部横带，屋顶红字“西安城南客运站 XI'AN CHENGNAN COACH STATION”；
// 卫星 z18：屋面三处内天井、北缘有字牌。高度无资料，保守取 20 m（约 4 层）。
const chengnan = {
  id: 'chengnan-coach-station',
  name: '西安城南客运站',
  fp: '5a28856a-89cd-415b-ac3b-241a0fca7a00',
  parts: [{
    name: 'station', kind: 'podium', fp: '5a28856a-89cd-415b-ac3b-241a0fca7a00', base: 0, top: 20,
    style: { pattern: 'stoneWindows', tint: '#3c4652', spd: '#d9ab6c', floorH: 5, colW: 3.0, spandrel: 0.45, mullW: 1.0, lit: 0.7 },
  }],
  signs: [
    { text: '西安城南客运站', part: 'station', face: 'N', y: 22.5, h: 3.6, color: '#c8102e' },
    { text: "XI'AN CHENGNAN COACH STATION", part: 'station', face: 'N', y: 20.4, h: 1.2, color: '#c8102e' },
  ],
  supersede: { names: ['西安城南客运站'] },
  meta: {
    dossier: 'public.json#西安城南客运站',
    sources: ['OSM w360836368（Overture 5a28856a）', 'https://zh.wikipedia.org/wiki/西安城南客运站', 'Esri World Imagery z18'],
    photos: ['Commons 2019 远景照片（档案目视）'],
    confidence: 'low（高度）',
    notes: '高度无资料，保守取 20 m；屋顶字牌朝北（卫星北缘字牌）。',
  },
};

export default [wHotel, wanzhong, saige, jinsha, yintaiXZ, kaide, yintaiQJ, joycity, jindi, tianjie, mandi, westin, canopy, wyndham,
  stadium, library, artMuseum, conference, xaTheater, sxTheater, changanIntl, chengnan];
// 去重：交大一附院、陕西自然博物馆归 public.js（医院/公共设施类由公共建筑片负责）
// 合生汇、金花豪生由 core.js 负责（两份做法接近，core 的塔高用卫星位移标定），此处不导出以免重复建模
