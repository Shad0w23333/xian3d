// 逐栋档案示范：3 栋被档案证实“现有模型造型错误”的楼（docs/DOSSIER_KIT.md 的范例）。
// 依据：research/refs/dossiers/core_south.json（陕西信息大厦、西安SKP）、north.json（大明宫万达广场）及其照片，
//       Overture/OSM 实测轮廓（public/data/dossier_fp.json），Esri 卫星（屋面位置按楼身倾斜改正，见各条 meta.notes）。
// 档案里为 null 的数值没有编：要么由照片数层 / 卫星量取估算并在 meta.notes 注明“按照片数层”“按卫星量取”，要么保守处理。
// 对照差异见 research/refs/dossiers/model_log.md。

// ───────────── a) 陕西信息大厦（西安皇冠假日酒店） ─────────────
// 轮廓 0b5e905d（OSM w1284311588，height=228 / levels=51）：半径约 21.4 m 的圆 + 西北、东南两端各伸出约 8 m 的“耳朵”（宽约 5.4 m）；
// 卫星（楼身向东南倾倒，可见西北立面）与照片（xinxi_0/1/4）互证：圆柱形深蓝玻璃塔身，西北、东南两道白色石材端墙贯通全高，
// 顶部退进玻璃圆筒 + 薄圆盘屋顶（卫星可见直升机坪“H”），两根桅杆立在端墙顶；底部约 7 层米色石材基座。没有四棱锥顶。
const XX = -654.3, XZ = 3174.4, XR = 21.4; // 塔身圆心（世界坐标）与半径：由 OSM 轮廓圆弧点最小二乘拟合
const xinxi = {
  id: 'xinxi',
  name: '陕西信息大厦',
  center: [XX, XZ],
  parts: [
    {
      name: 'plinth', // 米色石材基座（照片 xinxi_1 底部约 7 层窗洞，含入口雨棚层）
      shape: 'circle', size: [2 * XR + 1, 2 * XR + 1], at: [XX, XZ], base: 0, top: 26,
      style: { pattern: 'stoneWindows', spd: '#e3dccd', tint: '#34414b', floorH: 3.7, colW: 2.8, spandrel: 0.42, mullW: 1.1, lit: 0.55 },
      roof: { mech: false },
    },
    {
      name: 'body', // 深蓝玻璃塔身 + 每层白色横带（档案 facade：#23507e / #e6e6e6，“弧面密集白色横带”）
      shape: 'circle', size: [2 * XR, 2 * XR], at: [XX, XZ], base: 26, top: 180,
      style: { pattern: 'horizontalBands', tint: '#153a63', spd: '#e6e6e6', floorH: 3.6, colW: 1.8, spandrel: 0.2, mullW: 0.05, lit: 0.42 },
      roof: { mech: false },
    },
    {
      name: 'cornice', // 玻璃塔身顶部的白色环带（照片 xinxi_1 顶部）
      kind: 'solid', mat: { color: '#e9e6df', roughness: 0.7 },
      shape: 'circle', size: [2 * XR + 0.6, 2 * XR + 0.6], at: [XX, XZ], base: 177.4, top: 180.8,
    },
    {
      name: 'fins', // 西北—东南两道白色石材端墙：一整片贯穿塔身，只有两端伸出圆外（轮廓“耳朵”：离圆心 28–30 m，宽约 5.4 m）
      kind: 'solid', mat: { color: '#dcd8cf', roughness: 0.8 },
      shape: 'rect', size: [59, 5.4], at: [XX, XZ], rot: -45, base: 0, top: 190,
    },
    {
      name: 'drum', // 顶部退进的玻璃圆筒（照片：比塔身略收，几道横向分格）
      shape: 'circle', size: [2 * XR - 5, 2 * XR - 5], at: [XX, XZ], base: 180.8, top: 194,
      style: { pattern: 'curtain', tint: '#2e5d8c', spd: '#cfd8e0', floorH: 3.4, colW: 2.2, spandrel: 0.12, mullW: 0.07, lit: 0.55 },
      roof: { mech: false },
      crown: [
        { type: 'disk', r: XR - 0.4, h: 1.8, rimH: 0.8 }, // 薄圆盘屋顶（略挑出圆筒）
        { type: 'helipad', r: 11 }, // 卫星可见“H”（档案 notes：西部首个楼顶直升机停机坪）
        // 两根桅杆立在两道端墙顶（离圆心约 20 m）；照片间高低不一致，按等高、顶端 228 m（OSM height）处理
        { type: 'masts', y: 190, list: [[-14.1, 14.1], [14.1, -14.1]], top: 228, r: 0.55 },
      ],
    },
    {
      name: 'crowne', // 皇冠假日酒店裙楼（Overture 60562511 / OSM w1284311475），绿色屋面上有白色“CROWNE PLAZA”大字（卫星）
      kind: 'podium', fp: '60562511', base: 0, top: 24,
      style: { pattern: 'stoneWindows', spd: '#e3dccd', tint: '#34414b', floorH: 4.0, colW: 3.0, spandrel: 0.42, mullW: 1.0, lit: 0.6 },
      roofMat: { color: '#6f8a5b', roughness: 0.85 },
    },
  ],
  signs: [
    { text: '中信银行', part: 'drum', face: ['N', 'SW'], y: 190.6, h: 3.2, color: '#c8102e' }, // 照片 xinxi_0（西南）、xinxi_4（北）
    { text: 'CROWNE PLAZA', part: 'crowne', face: 'roof', at: [-643.5, 3075], rot: 0, h: 7, maxW: 56, color: '#f4f4f0' }, // 卫星屋面字（已按楼高改正倾斜）
    { text: 'CROWNE PLAZA 西安皇冠假日酒店', part: 'crowne', face: 'W', y: 17, h: 2.4, color: '#d24fb7' }, // 档案：入口上方石材墙，夜间粉紫色；朝向“朝北/西 待核实”
  ],
  night: {
    // 档案 night：“弧面沿横向带布置蓝色 LED 线条灯（夜景照片呈蓝色竖向渐变光带）”——横带线灯由立面模式 3 提供，这里加蓝色自下而上渐变光幕
    floodlight: [{ part: 'body', color: '#3f7dff', strength: 0.32 }],
  },
  supersede: { keys: ['xinxi'], names: ['陕西信息大厦', '西安皇冠假日酒店', '陕西信息大厦（西安皇冠假日酒店）'] },
  meta: {
    dossier: 'core_south.json#陕西信息大厦（西安皇冠假日酒店）',
    sources: [
      'OSM w1284311588（height=228, levels=51）', 'OSM w1284311475 西安皇冠假日酒店',
      'https://gaoloumi.cc/forum.php?mod=viewthread&tid=640957', 'https://k.sina.cn/article_6098802318_16b84568e001001j99.html',
      'https://dfz.shaanxi.gov.cn/zslm/sxsq/tssq/201302/t20130222_2622487.html', 'Esri World Imagery z19（屋面 H、圆盘、端墙位置）',
    ],
    photos: ['scratchpad/dossier_core_south/photos/xinxi_0.jpg', 'xinxi_1.jpg', 'xinxi_4crop.jpg', 'https://l.b2b168.com/2021/11/18/15/202111181516137666064.png', 'http://pic.huitu.com/pic/20170624/269706_20170624000906462010_0.jpg'],
    confidence: 'high（高度/层数/轮廓）；medium（分段高度）',
    notes: '228 m 按桅杆顶处理（OSM height=228；照片 xinxi_1 中桅杆约为屋顶以上 17–20% 楼高，若 228 m 为屋顶则桅杆将达 270 m，与“西安第一高楼 228 m”说法不符）。'
      + '分段高度按照片比例估算：石材基座 26 m（约 7 层）、玻璃塔身至 180 m、白色环带 177–181 m、圆筒 181–194 m、圆盘 194–196 m、端墙顶 190 m。'
      + '裙楼 24 m 按照片数层（约 6 层）。端墙位置取 OSM 轮廓的西北/东南“耳朵”，与卫星屋面、照片三方一致。',
  },
};

// ───────────── b) 西安SKP（陕投·SKP） ─────────────
// 商场轮廓 810b42f0（OSM w605107430，245×117 m）；办公塔楼用轮廓内三块 OSM 分体（卫星核对：三块屋面向东南偏移 30–36 m，
// 与楼身倾斜一致，偏移前的底座正好是这三块）：北楼 0b688043（挂“西安SKP”）、中间连接体 94b7a06b、南楼 e92b43d1（挂“陕投集团”、屋顶构架）。
// 照片 skp_1（从西侧长安北路看东，左北右南）：左塔、中间低一截的连接体、右塔（带屋顶构架），前面是约 5–6 层的黑色裙楼。
const skp = {
  id: 'skp',
  name: '西安SKP',
  fp: '810b42f0',
  parts: [
    {
      name: 'mall', // 商场（B 栋 6 层）：黑色金属/石材“超长盒子”，四角圆润；大面实墙、零星窗洞
      kind: 'podium', fp: '810b42f0', roundCorners: 9, base: 0, top: 30,
      style: { pattern: 'stoneWindows', tint: '#0f1418', spd: '#17181a', floorH: 5.0, colW: 6.0, spandrel: 0.78, mullW: 3.6, lit: 0.35 },
      roofMat: { color: '#3c4044', roughness: 0.85 },
    },
    {
      name: 'shopfront', // 首层通透橱窗（档案 facade.notes）
      kind: 'facade', fp: '810b42f0', roundCorners: 9, grow: 0.15, base: 0, top: 6,
      style: { pattern: 'retail', tint: '#2c3238', spd: '#b08a4a', floorH: 6, colW: 4.0, spandrel: 0.12, mullW: 0.22, lit: 0.95 },
    },
    {
      name: 'towerN', // 北塔（A 栋，19 层）：深色玻璃网格幕墙，顶部两面挂粉色“西安SKP”
      fp: '0b688043', base: 0, top: 81,
      style: { pattern: 'grid', tint: '#1f2a33', spd: '#262d33', floorH: 4.2, colW: 1.5, spandrel: 0.24, mullW: 0.12, lit: 0.55 },
    },
    {
      name: 'link', // 中间连接体（照片：比两塔低约 5 层）
      fp: '94b7a06b', base: 0, top: 60,
      style: { pattern: 'grid', tint: '#1f2a33', spd: '#262d33', floorH: 4.2, colW: 1.5, spandrel: 0.24, mullW: 0.12, lit: 0.6 },
    },
    {
      name: 'towerS', // 南塔（19 层）：顶挂“陕投集团”，屋顶一层高的通透构架（夜间橙色灯）
      fp: 'e92b43d1', base: 0, top: 81,
      style: { pattern: 'grid', tint: '#1f2a33', spd: '#262d33', floorH: 4.2, colW: 1.5, spandrel: 0.24, mullW: 0.12, lit: 0.55 },
      roof: { mech: false },
      crown: [{ type: 'frame', h: 5, inset: 0.6, step: 4.5, post: 0.45, glow: '#ff9a3c', color: '#6d7074', strength: 1.2 }],
    },
  ],
  signs: [
    { text: '西安SKP', part: 'towerN', face: ['W', 'N'], y: 77, h: 4.2, color: '#e36cc9' },
    { text: '陕投集团', part: 'towerS', face: 'W', y: 77, h: 3.6, color: '#ff9a4a' },
    { text: '西安SKP', part: 'mall', face: 'N', near: 'W', y: 25.5, h: 5, color: '#e36cc9' }, // 裙楼西北角顶部（朝永宁门）
    { text: '西安SKP', part: 'mall', face: 'W', near: 'N', y: 25.5, h: 5, color: '#e36cc9' }, // 朝长安北路
  ],
  // 裙楼外立面金色细线灯：水平线条间夹 S 形过渡（照片 skp_0/2/3），用 5 道缓慢起伏的线近似
  bands: [{ part: 'mall', levels: [6.5, 11.5, 16.5, 21.5, 27.5], wave: { amp: 1.3, len: 88, phase: 1.7 }, h: 0.22, depth: 0.18, color: '#9c8458', glow: '#ffc978', strength: 2.2 }],
  night: {
    outline: [{ part: 'towerN', color: '#ff9a3c', w: 0.6 }], // 照片 skp_2：北塔女儿墙一圈橙色灯
  },
  supersede: { names: ['西安SKP', 'SKP西安', '陕投·SKP'] },
  meta: {
    dossier: 'core_south.json#西安SKP',
    sources: ['OSM w605107430 西安SKP；w1291044424 / w1291044345 / w1291044939（塔楼分体）', 'https://www.jiemian.com/article/2210976.html', 'https://zhidao.baidu.com/question/1838631243216373780.html（A栋19层、B栋6层）', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_core_south/photos/skp_0.jpg', 'skp_1.jpg', 'skp_2.jpg', 'skp_3.jpg'],
    confidence: 'medium',
    notes: '高度均无公开数据：塔楼 19 层取“A栋19层”（百度知道转述百科），照片 skp_1 裙楼以上可数约 14 层，层高按 4.2 m → 81 m；'
      + '连接体按照片比两塔低约 5 层 → 60 m；裙楼 6 层（“B栋6层”）× 约 5 m → 30 m。塔楼落位按卫星屋面减去楼身倾斜（约 0.38 m/m，由信息大厦同幅影像标定）。'
      + '档案里“裙楼屋顶北侧白色大字 西安skp”实为 skp_3 视频标题叠字，不建模。',
  },
};

// ───────────── c) 大明宫万达广场 ─────────────
// 商场轮廓 09a279fb（OSM w1409622148，南北 294 × 东西 134 m）。卫星（dossier_north/sat/wanda.jpg）屋面上：北端东西向双板楼（两块屋面，
// 各约 42×19 m，间隔约 19 m）+ 西半部南北一列 3 栋约 38×38 m 方塔；屋面中轴偏东一条约 10 m 宽玻璃采光带，两端各一个直径约 30 m 的圆形玻璃穹顶。
// 楼身向东倾（可见西立面），塔楼底座 = 卫星屋面 −(31, 10) m（西立面宽度量得）。效果图 wanda_08：双板楼白色竖肋、三塔银灰玻璃竖肋，
// 裙房白色横向波浪铝板带；夜景 wanda_01：塔楼 LED 网格满铺彩色变化，红色“万达广场 WANDA PLAZA”。
const WT = { w: 38, top: 99 };
const SKYLIGHT = { color: '#5f7a8c', metalness: 0.55, roughness: 0.15 }; // 采光带/穹顶玻璃（比默认 glassRoof 深，浅色屋面上看得出）
const wanda = {
  id: 'wanda-daminggong',
  name: '大明宫万达广场',
  fp: '09a279fb',
  parts: [
    {
      name: 'mall', kind: 'podium', fp: '09a279fb', base: 0, top: 27,
      style: { pattern: 'louver', tint: '#4f5d68', spd: '#e6e8ea', floorH: 2.7, colW: 4.0, spandrel: 0.5, mullW: 0.04, lit: 0.7 },
      roofMat: { color: '#b9b2a4', roughness: 0.9 },
      crown: [
        { type: 'arch', at: [2396.5, -6221], size: [166, 10], rot: 90, h: 3.5, mat: SKYLIGHT }, // 玻璃采光中轴（南北向）
        { type: 'dome', at: [2395.3, -6318], r: 15, h: 6.5, mat: SKYLIGHT }, // 北端圆穹顶
        { type: 'dome', at: [2396.0, -6126], r: 14.5, h: 6.5, mat: SKYLIGHT }, // 南端圆穹顶
      ],
    },
    // 西半部三栋写字楼（银灰玻璃 + 竖肋；夜间 LED 网格）
    ...[['officeN', -6290.4], ['officeM', -6211.0], ['officeS', -6131.0]].map(([name, z], i) => ({
      name, shape: 'rect', size: [WT.w, WT.w], at: [2338.5, z], base: 0, top: WT.top,
      style: { pattern: 'media', tint: '#6b8494', spd: '#c5ccd2', floorH: 3.9, colW: 1.5, spandrel: 0.12, mullW: 0.22, lit: 0.45, seed: 40 + i },
    })),
    // 北端双板楼（公寓，白色竖肋）
    ...[['aptW', 2360.8], ['aptE', 2421.6]].map(([name, x], i) => ({
      name, shape: 'rect', size: [42, 19], at: [x, -6352.5], base: 0, top: WT.top,
      style: { pattern: 'verticalFins', tint: '#2d3a45', spd: '#e9edf0', floorH: 3.0, colW: 1.4, spandrel: 0.18, mullW: 0.45, lit: 0.55, seed: 50 + i },
    })),
  ],
  signs: [
    { text: '万达广场 WANDA PLAZA', part: 'mall', face: 'W', near: 'S', y: 22, h: 4.2, color: '#e02a26' }, // 裙房转角高位（夜景照）
    { text: '万达广场', part: 'mall', face: 'S', y: 22, h: 4.2, color: '#e02a26' },
    { text: '万达广场', part: 'officeS', face: 'W', y: 94, h: 4.2, color: '#e02a26' }, // 效果图：最南一栋塔顶红色字
  ],
  // 裙房白色横向波浪铝板带（夜间内透 LED）
  bands: [{ part: 'mall', levels: [7, 12.5, 18, 23.5], wave: { amp: 1.2, len: 70, phase: 1.1 }, h: 0.9, depth: 0.5, color: '#e6e8ea', glow: '#bcd8ff', strength: 1.1 }],
  supersede: { keys: ['dmgwd'], names: ['大明宫万达广场', '西安大明宫万达广场'] },
  meta: {
    dossier: 'north.json#wanda',
    sources: ['OSM w1409622148', 'https://www.vsszan.com/t-356508.html（J2厚华 设计作品页：效果图/夜景）', 'http://m.linkshop.com/article/news/272503', 'Esri World Imagery（dossier_north/sat/wanda.jpg）'],
    photos: ['scratchpad/dossier_north/sat/wanda.jpg', 'scratchpad/dossier_north/art/wanda_08.jpg', 'scratchpad/dossier_north/art/wanda_01.jpg'],
    confidence: 'medium（布局）；low（高度）',
    notes: '层数/高度无资料：写字楼按档案 height_source 提到的“地上24层”× 约 4.1 m → 99 m（裙房 5 层按 5.4 m）；双板楼无层数，按效果图与写字楼等高。'
      + '裙房 27 m 按照片数层（约 5 层）。塔楼/穹顶/采光带位置按卫星量取（±5 m），已按楼身倾斜改正。档案写“4 栋塔楼”，卫星与效果图为北端双板楼（两块体量）+ 三方塔。',
  },
};

export default [xinxi, skp, wanda];
