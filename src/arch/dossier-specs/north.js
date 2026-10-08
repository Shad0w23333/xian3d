// 城北逐栋档案建模：research/refs/dossiers/north.json 全部条目 + public.json 中落在未央 / 经开 / 北客站 / 大明宫 / 火车站北的条目。
// 依据：档案（高度/层数出处、照片、卫星）、Overture/OSM 实测轮廓（public/data/dossier_fp.json）、Esri 卫星（z18/z19）。
// 已由别处完成、这里不重复：大明宫万达（demo.js）、西安站北/南站房（heritage.js 按实测修正）。
// 档案为 null 的数值不编：能从照片数层的注明“按照片数层”；能从卫星量的注明“按卫星量取”；
//   卫星楼身倾斜换算：Esri 城北影像楼身向东（略偏南）倾倒，屋面相对底座的位移 ≈ k·楼高，
//   k 由市政府（照片数得 11 层）量得 0.42、环球贸易中心 2 号楼（149.75 m）量得约 0.35、第二长途电信大楼（168 m）约 0.33，取 0.35–0.42；
//   都做不到的写明“高度无出处”，取保守值。对照差异见 research/refs/dossiers/model_log_north.md。
// 坐标：世界系 X 东、Z 南（北 = −Z），原点钟楼；pts 为世界坐标扁平数组；offset:[东,北]；rot 为地图角（北 = 90）。

// ───────────── 小工具 ─────────────
/** 世界坐标矩形 [x0,x1]×[z0,z1] → 扁平轮廓 */
const rect = (x0, x1, z0, z1) => {
  const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(z0, z1), d = Math.max(z0, z1);
  return [a, c, b, c, b, d, a, d];
};
/** 体块：世界坐标矩形 */
const box = (name, x0, x1, z0, z1, base, top, extra = {}) => ({ name, pts: rect(x0, x1, z0, z1), base, top, ...extra });
/** 四坡顶/盝顶塔冠：覆盖世界坐标矩形 [x0,x1]×[z0,z1]，长边自动取向 */
const hip = (x0, x1, z0, z1, o = {}) => {
  const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
  return { type: 'hip', at: [(x0 + x1) / 2, (z0 + z1) / 2], size: w >= d ? [w, d] : [d, w], rot: w >= d ? 0 : 90, ...o };
};
const NOROOF = { mech: false, parapet: 0.3 }; // 坡屋顶下的体块：不要屋顶设备，女儿墙压低（被出檐盖住）

// ───────────── 西安行政中心一带的共同做法（市政府、市委/人大/政协、中医医院同期 2011 年建成，灰色金属缓坡四坡顶 + 深出檐） ─────────────
const GOV_ROOF = { color: '#7b8286', metalness: 0.55, roughness: 0.42 }; // 照片：浅灰金属屋面
const GOV_STONE = { pattern: 'stoneWindows', spd: '#dcdcd6', tint: '#3a4a5a', floorH: 4.0, colW: 3.3, spandrel: 0.42, mullW: 1.55, lit: 0.35 };
const GOV_BAND = { h: 3.6, depth: 0.14, color: '#27313a' }; // 檐下一圈深色玻璃带（顶层）

// ═════════════ 1) 西安市人民政府（行政中心办公楼群） ═════════════
// 档案 north.json#gov：真正的市政府在未央路以西 (−669,−9258)，OSM r18903162 对称院落 240×247 m；
// sky-data 的 SPECIAL.gov / FP.gov 实为未央路以东的市委/人大/政协院落与中医医院（见下两条）。
// 照片（Commons 2020-12-09，由南侧凤城八路看）：中部两座 U 形高楼 11 层（10 层石材方窗 + 顶层深色玻璃带）+ 灰色金属缓坡四坡顶深出檐；
//   四角 L 形翼楼 5 层（照片数得 3–4 排窗 + 顶层深色带，含被树挡住的首层）；gooood 航拍：南楼正中通高入口门框，中央圆形院落（圆鼓）。
// 卫星 z19（sat/n_govw.jpg）：屋面相对 OSM 墙线整体东移 ≈18.4 m（中楼）/ 9.0 m（翼楼），比值 2.04 与 11 层 / 5 层一致（→ k≈0.42）；
//   中楼为“盝顶”：四坡屋面围着一块放设备的平屋面，两端 U 形臂各自四坡。
const GX = -668.6, GZ = -9258.2; // 院落中心（OSM 外包中心，东西对称）
const govParts = [];
const govBands = [];
for (const [sx, sz, k] of [[-1, -1, 'NW'], [1, -1, 'NE'], [-1, 1, 'SW'], [1, 1, 'SE']]) {
  // 长臂（东西向，88×23 m）与短臂（南北向，23×60 m），组成 L 形；短臂坡顶延伸到长臂外缘，两片四坡顶在转角相交
  const xa = GX + sx * 32, xb = GX + sx * 120, za = GZ + sz * 100.2, zb = GZ + sz * 123.3;
  const xc = GX + sx * 97, zc = GZ + sz * 39.8;
  govParts.push(box('wing' + k + 'L', xa, xb, za, zb, 0, 21, { style: GOV_STONE, roof: NOROOF, crown: [hip(xa, xb, za, zb, { over: 3, h: 4.5, eave: 0.9, mat: GOV_ROOF })] }));
  govParts.push(box('wing' + k + 'S', xc, xb, zc, za, 0, 21, { style: GOV_STONE, roof: NOROOF, crown: [hip(xc, xb, zc, zb, { over: 3, h: 4.5, eave: 0.9, mat: GOV_ROOF })] }));
  govBands.push({ part: 'wing' + k + 'L', levels: [17.2], ...GOV_BAND }, { part: 'wing' + k + 'S', levels: [17.2], ...GOV_BAND });
}
// 中部两座 U 形楼：南楼开口朝北（院心），北楼开口朝南；基座条 39 m 深，两端臂宽 30 m，臂向院心再伸 14 m
for (const [sz, k] of [[1, 'S'], [-1, 'N']]) {
  const zo = GZ + sz * 68.0, zi = GZ + sz * 29.0, zt = GZ + sz * 14.9; // 外墙、基座条内墙、臂端
  const x0 = GX - 73.9, x1 = GX + 73.1;
  govParts.push(box('block' + k, x0, x1, zi, zo, 0, 44, {
    style: GOV_STONE, roof: NOROOF,
    crown: [hip(x0, x1, zi, zo, { over: 4, h: 7, eave: 1.1, flat: 0.55, mat: GOV_ROOF })],
  }));
  for (const [xa, xb, s] of [[x0, x0 + 30, 'W'], [x1 - 30, x1, 'E']]) {
    govParts.push(box('arm' + k + s, xa, xb, zt, zi, 0, 44, { style: GOV_STONE, roof: NOROOF, crown: [hip(xa, xb, zt, zo, { over: 4, h: 7, eave: 1.1, mat: GOV_ROOF })] }));
    govBands.push({ part: 'arm' + k + s, levels: [40.2], ...GOV_BAND });
  }
  govBands.push({ part: 'block' + k, levels: [40.2], ...GOV_BAND });
}
govParts.push(
  // 南楼正中通高入口门框（航拍：约 5–6 层高的深色玻璃门厅 + 石材门框）
  box('portal', GX - 8, GX + 8, GZ + 68.0, GZ + 70.4, 0, 23, { style: { pattern: 'curtain', tint: '#2a3642', spd: '#d8d6cf', floorH: 5.5, colW: 2.6, spandrel: 0.08, mullW: 0.35, lit: 0.6 }, roof: { mech: false, parapet: 1.2 } }),
  // 东西两侧连接楼（卫星：平屋面 + 屋顶设备，高度按卫星位移 ≈ 5 m → 约 3 层）与中楼之间的两层连廊
  box('linkW', GX - 116.6, GX - 100.6, GZ - 39.7, GZ + 39.7, 0, 13, { style: GOV_STONE }),
  box('linkE', GX + 100.4, GX + 116.3, GZ - 39.7, GZ + 39.7, 0, 13, { style: GOV_STONE }),
  box('corrNW', GX - 102.4, GX - 73.3, GZ - 39.6, GZ - 29.1, 0, 8, { style: GOV_STONE, roof: NOROOF }),
  box('corrSW', GX - 102.0, GX - 73.9, GZ + 29.7, GZ + 39.4, 0, 8, { style: GOV_STONE, roof: NOROOF }),
  box('corrNE', GX + 72.9, GX + 101.6, GZ - 39.8, GZ - 28.9, 0, 8, { style: GOV_STONE, roof: NOROOF }),
  box('corrSE', GX + 73.1, GX + 101.5, GZ + 29.0, GZ + 40.0, 0, 8, { style: GOV_STONE, roof: NOROOF }),
  // 两楼之间的一层基座（卫星：红褐色铺装屋面）与中央圆形院落（圆鼓，环形矮墙围着圆院）
  { name: 'court', kind: 'podium', pts: rect(GX - 56.3, GX + 55.9, GZ - 15.3, GZ + 14.9), base: 0, top: 6, style: { ...GOV_STONE, floorH: 6 }, roofMat: { color: '#9a5a48', roughness: 0.9 } },
  { name: 'drum', kind: 'podium', shape: 'ring', size: [30, 4], at: [GX, GZ], base: 6, top: 12, style: { pattern: 'stoneWindows', spd: '#9c7a66', tint: '#3a3230', floorH: 6, colW: 4, spandrel: 0.5, mullW: 2.2, lit: 0.3 }, roofMat: { color: '#6b4a3c', roughness: 0.8 } },
);
const gov = {
  id: 'n-gov', name: '西安市人民政府', center: [GX, GZ],
  parts: govParts, bands: govBands, site: ['7613d3a2-60de-46ee-b1e4-eaf1384bccf2'], clearance: 2,
  supersede: { names: ['西安市人民政府', '西安市人民政府（行政中心）', '西安市人民政府（行政中心）主楼', '西安市人民政府（西安市行政中心）', '西安市人民政府（行政中心办公楼群）'] },
  meta: {
    dossier: 'north.json#gov；public.json#西安市人民政府（西安市行政中心）',
    sources: ['OSM r18903162（外包 240×247 m，含内院）', 'https://zh.wikipedia.org/wiki/西安市人民政府（凤城八路109号）', 'https://www.shx.chinanews.com.cn/news/2023/0627/92591.html（2011-03 迁入）', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_north/photos/20201209_The_Building_of_Xi_an_Municipal_People_s_Government.jpg', 'scratchpad/dossier_north/art/gym2_02.jpg（gooood 航拍）', 'scratchpad/dossier_north/sat/n_govw.jpg'],
    confidence: 'medium（布局/形体）；medium（高度：按照片数层）',
    notes: '高度无公开数据：中楼按照片数得 11 层 × 4.0 m = 44 m 檐口，翼楼 5 层 = 21 m；卫星屋面位移比 18.4/9.0 = 2.04 与之吻合。'
      + '墙线按 OSM r18903162 外环；中楼盝顶、臂端四坡、翼楼 L 形两片四坡相交按卫星；坡高（中楼 7 m、翼楼 4.5 m）与出檐（4 m / 3 m）按照片比例估。'
      + '东西连接楼 13 m、连廊 8 m、中央基座 6 m 与圆鼓 12 m 按卫星位移与航拍估，误差 ±3 m。',
  },
};

// ═════════════ 2) 中共西安市委 / 市人大 / 市政协办公楼群（未央路以东，替代 SPECIAL.gov 的主体） ═════════════
// 档案 north.json#shiwei（low）：无街景照片，形体全部按卫星 z19（sat/n_sw19.jpg、n_rdz.jpg）+ OSM 分体轮廓；
// 高度按卫星屋面位移 ÷ k(0.42，同幅影像由市政府标定)：市委主楼 15.8 m → 约 38 m（9 层）；四周四栋 7.4 m → 约 17.6 m（4 层）；
//   人大/政协 H 形楼 7.8 m → 约 18.5 m；北侧三栋 7–8 m → 约 17–19 m；北侧会议楼（椭圆穹顶）13.6 m → 约 32 m。均 ±15%。
const SW_STONE = { ...GOV_STONE, spd: '#dedbd3' };
const hipParts = (list) => list.map(({ name, fp, r: [x0, x1, z0, z1], top, o }) => ({
  name, fp, base: 0, top, style: SW_STONE, roof: NOROOF, crown: [hip(x0, x1, z0, z1, { over: 2.5, h: top > 25 ? 6.5 : 4.5, eave: 0.9, mat: GOV_ROOF, ...(o || {}) })],
}));
const RDX = 146.9; // 政协 = 人大向东平移 146.9 m（两组镜像对称，OSM 质心差）
const shiwei = {
  id: 'n-shiwei', name: '中共西安市委 · 市人大 · 市政协', center: [650, -9230],
  parts: [
    // 市委：主楼（盝顶，屋面满铺设备）+ 南北各两栋四坡顶配楼 + 北侧礼堂式配楼
    ...hipParts([
      { name: 'swMain', fp: '82975243', r: [393.9, 541.3, -9222.4, -9185.5], top: 38, o: { over: 3.5, flat: 0.5 } },
      { name: 'swNW', fp: 'be619735', r: [356.3, 434.5, -9272.2, -9250.2], top: 17.6 },
      { name: 'swNE', fp: '361d05f9', r: [500.3, 578.5, -9272.5, -9250.8], top: 17.6 },
      { name: 'swSW', fp: 'b431b077', r: [356.3, 434.7, -9157.3, -9135.3], top: 17.6 },
      { name: 'swSE', fp: '50ee3766', r: [500.5, 578.7, -9157.4, -9135.6], top: 17.6 },
      { name: 'swHall', fp: 'd309916f', r: [407.6, 527.4, -9334.9, -9304.5], top: 13 },
    ]),
    { name: 'swAnnexW', fp: '72b4bf63', base: 0, top: 12, style: SW_STONE },
    { name: 'swAnnexN', fp: 'c902d6a8', base: 0, top: 12, style: SW_STONE },
    { name: 'swAnnexE', fp: '3c2b8bcf', base: 0, top: 12, style: SW_STONE },
    // 人大（H 形：东西两翼南北向四坡 + 中段盝顶）与北侧三栋
    { name: 'rdH', fp: '06058843', base: 0, top: 18.5, style: SW_STONE, roof: NOROOF,
      crown: [hip(642.7, 672.7, -9196, -9158, { over: 2.5, h: 4.5, eave: 0.9, mat: GOV_ROOF }), hip(738.5, 768.5, -9196, -9158, { over: 2.5, h: 4.5, eave: 0.9, mat: GOV_ROOF }),
        hip(672.7, 738.5, -9190, -9154, { over: 2.5, h: 5, eave: 0.9, flat: 0.5, mat: GOV_ROOF })] },
    { name: 'zxH', fp: '5a8632e1', base: 0, top: 18.5, style: SW_STONE, roof: NOROOF,
      crown: [hip(642.7 + RDX, 672.7 + RDX, -9196, -9158, { over: 2.5, h: 4.5, eave: 0.9, mat: GOV_ROOF }), hip(738.5 + RDX, 768.5 + RDX, -9196, -9158, { over: 2.5, h: 4.5, eave: 0.9, mat: GOV_ROOF }),
        hip(672.7 + RDX, 738.5 + RDX, -9190, -9154, { over: 2.5, h: 5, eave: 0.9, flat: 0.5, mat: GOV_ROOF })] },
    ...hipParts([
      { name: 'rdNW', fp: '9e23e49e', r: [642.5, 665.9, -9263.4, -9224.1], top: 17 },
      { name: 'rdN', fp: '44b3fad0', r: [669.5, 742.3, -9265.4, -9232.2], top: 19, o: { flat: 0.45 } },
      { name: 'rdNE', fp: 'aa8907ef', r: [745.7, 769.0, -9262.9, -9223.5], top: 17 },
      { name: 'zxNW', fp: 'e3022354', r: [789.4, 812.7, -9262.9, -9223.6], top: 17 },
      { name: 'zxN', fp: '0164051f', r: [816.2, 889.2, -9261.1, -9238.5], top: 19, o: { flat: 0.45 } },
      { name: 'zxNE', fp: 'f0644f96', r: [892.6, 916.2, -9262.9, -9223.5], top: 17 },
      // 政协以东、中医医院以西的三栋四坡顶板楼（名称未查到；原 SPECIAL.gov 内）：卫星位移约 6 m → 约 15 m
      { name: 'eastA', fp: '4edb87fb', r: [951.4, 1012.8, -9246.2, -9222.7], top: 15, o: { flat: 0.4 } },
      { name: 'eastB', fp: '78cefa7b', r: [951.3, 1012.3, -9201.0, -9179.3], top: 15, o: { flat: 0.4 } },
      { name: 'eastC', fp: 'f2c215ce', r: [951.5, 1005.5, -9157.9, -9137.2], top: 15, o: { flat: 0.4 } },
    ]),
    // 政协北侧会议楼：平屋面 + 屋顶椭圆穹顶（卫星）
    { name: 'hall', fp: 'f36d1dd0', base: 0, top: 32, style: { ...SW_STONE, floorH: 4.6, colW: 3.8 },
      crown: [{ type: 'dome', at: [872.5, -9331.5], r: [8.5, 6.5], h: 4.5, mat: { color: '#e9ebec', roughness: 0.5, metalness: 0.2 } }] },
  ],
  bands: [
    ...['swMain'].map((p) => ({ part: p, levels: [34.2], ...GOV_BAND })),
    ...['swNW', 'swNE', 'swSW', 'swSE', 'rdH', 'zxH', 'rdNW', 'rdN', 'rdNE', 'zxNW', 'zxN', 'zxNE'].map((p) => ({ part: p, levels: [14.4], ...GOV_BAND, h: 3.2 })),
  ],
  clearance: 2,
  supersede: { keys: ['gov'], names: ['中共西安市委', '西安市人大常委会', '西安市政协', '西安市委', '西安市人大', '西安市政协', '行政中心'] },
  meta: {
    dossier: 'north.json#shiwei',
    sources: ['OSM w1373231759 西安市委 / w1373231773 西安市人大 / w1373231774 西安市政协 及周边分体', 'Esri World Imagery z19（sat/n_sw19.jpg、n_rdz.jpg、n_tcm19.jpg）'],
    photos: ['scratchpad/dossier_north/sat/gov_east.jpg', 'scratchpad/dossier_north/sat/n_sw19.jpg', 'scratchpad/dossier_north/sat/n_rdz.jpg'],
    confidence: 'low（无街景照片）；medium（布局，按卫星）',
    notes: '替代 SPECIAL.gov（33 块轮廓按“行政中心”建成 16–42 m 石材坡顶楼）：其中市委/人大/政协/东侧三栋在本条，中医医院在 n-tcm，'
      + '凤城八路以南的 7 块住宅轮廓交还通用建筑（skyline.js 在 gov 被替代时不再为 SPECIAL.gov 登记排除区）。'
      + '高度无出处，全部按卫星屋面位移 ÷ k=0.42（同幅影像由市政府照片数层标定）换算，±15%；立面按同期市政府（照片）的浅灰石材方窗 + 檐下深色玻璃带类推，属推断。',
  },
};

// ═════════════ 3) 西安市中医医院（凤城八路院区） ═════════════
// 档案 north.json#tcm（low）：OSM r18917339（181×134 m）；卫星 z19（sat/n_tcm19.jpg）：北侧住院主楼（东西长条，屋面两座盝顶亭式体量）、
// 中部南北向长玻璃采光廊串起两侧三对带小天井的方楼；东南另有两栋平屋面楼（原 SPECIAL.gov 内）。
// 高度：主楼屋面位移 ≈ 17.5 m ÷ 0.42 → 约 42 m（按 10 层 + 屋顶亭）；方楼位移 ≈ 7 m → 约 17 m（4 层）；无出处，±15%。
const TCM_WALL = { pattern: 'stoneWindows', spd: '#e3ddd0', tint: '#34424e', floorH: 3.9, colW: 3.0, spandrel: 0.4, mullW: 1.3, lit: 0.55 };
const tcmBlocks = [];
for (const [zs, ze, r] of [[-9297, -9279, 1], [-9257, -9240, 2], [-9224, -9207, 3]]) {
  tcmBlocks.push({ name: 'blkW' + r, kind: 'podium', pts: rect(1031, 1062, zs, ze), base: 0, top: 17, style: { ...TCM_WALL, lit: 0.6 }, roofMat: { color: '#8b8a84', roughness: 0.9 } });
  tcmBlocks.push({ name: 'blkE' + r, kind: 'podium', pts: rect(1085, 1116, zs, ze), base: 0, top: 17, style: { ...TCM_WALL, lit: 0.6 }, roofMat: { color: '#8b8a84', roughness: 0.9 } });
}
const tcm = {
  id: 'n-tcm', name: '西安市中医医院', center: [1073.4, -9281.4],
  parts: [
    { name: 'base', kind: 'podium', fp: '63a197bc', base: 0, top: 5, style: { ...TCM_WALL, floorH: 5, lit: 0.7 }, roofMat: { color: '#9a9890', roughness: 0.9 } },
    { name: 'ward', pts: rect(981, 1163, -9333, -9313), base: 0, top: 40, style: TCM_WALL, roof: { mech: false, parapet: 1.2 } },
    { name: 'lobby', pts: rect(1020, 1105, -9339, -9333), base: 0, top: 12, style: { pattern: 'curtain', tint: '#3d5566', spd: '#d8d4cc', floorH: 4, colW: 2, spandrel: 0.1, lit: 0.7 } },
    // 屋顶两座盝顶亭式体量（2 层）
    { name: 'pavW', pts: rect(1031, 1067, -9331, -9315), base: 40, top: 47, style: TCM_WALL, roof: NOROOF, crown: [hip(1031, 1067, -9331, -9315, { over: 2.5, h: 5, flat: 0.45, eave: 0.8, mat: GOV_ROOF })] },
    { name: 'pavE', pts: rect(1083, 1118, -9331, -9315), base: 40, top: 47, style: TCM_WALL, roof: NOROOF, crown: [hip(1083, 1118, -9331, -9315, { over: 2.5, h: 5, flat: 0.45, eave: 0.8, mat: GOV_ROOF })] },
    // 南北向长玻璃采光廊（卫星：两坡玻璃屋面）
    { name: 'gallery', kind: 'podium', pts: rect(1062, 1085, -9300, -9202), base: 0, top: 16, style: { pattern: 'curtain', tint: '#4a6272', spd: '#d8d8d4', floorH: 4, colW: 2.2, spandrel: 0.1, lit: 0.8 },
      crown: [{ type: 'arch', at: [1073.5, -9251], size: [98, 23], rot: 90, h: 4, mat: { color: '#6f8796', metalness: 0.55, roughness: 0.15 } }] },
    ...tcmBlocks,
    // 东南两栋（原 SPECIAL.gov 内；卫星位移约 7 m → 约 17 m）
    { name: 'se1', fp: '2be5529c', base: 0, top: 17, style: TCM_WALL },
    { name: 'se2', fp: '14bc7731', base: 0, top: 16, style: TCM_WALL },
  ],
  clearance: 2,
  supersede: { names: ['西安市中医医院', '西安市中医医院（凤城八路院区）'] },
  meta: {
    dossier: 'north.json#tcm',
    sources: ['OSM r18917339', 'https://zh.wikipedia.org/wiki/市中医医院站', '凤城八路69号，建筑面积9.8万㎡（WebSearch 摘要）', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_north/sat/tcm.jpg', 'scratchpad/dossier_north/sat/n_tcm19.jpg'],
    confidence: 'low',
    notes: '无街景照片。形体按卫星（已按楼身倾斜西移改正）；高度按屋面位移 ÷ k=0.42 换算，无出处。档案 signage 为空，不挂字。',
  },
};

/** 圆角矩形（只倒指定角）：corners = {sw, se, nw, ne} 半径（米）；世界坐标 */
function roundedRect(x0, x1, z0, z1, corners = {}, seg = 10) {
  // 逆时针（地图）：西南 → 东南 → 东北 → 西北；世界 z 向南为正，南 = z1
  const P = [];
  const arc = (cx, cz, r, a0, a1) => { for (let i = 0; i <= seg; i++) { const a = a0 + ((a1 - a0) * i) / seg; P.push(cx + r * Math.cos(a), cz + r * Math.sin(a)); } };
  const { sw = 0, se = 0, ne = 0, nw = 0 } = corners;
  if (sw) arc(x0 + sw, z1 - sw, sw, Math.PI, Math.PI / 2); else P.push(x0, z1);
  if (se) arc(x1 - se, z1 - se, se, Math.PI / 2, 0); else P.push(x1, z1);
  if (ne) arc(x1 - ne, z0 + ne, ne, 0, -Math.PI / 2); else P.push(x1, z0);
  if (nw) arc(x0 + nw, z0 + nw, nw, -Math.PI / 2, -Math.PI); else P.push(x0, z0);
  return P;
}
/** 圆弧带（LED 弧形屏、弧形檐带）：圆心 (cx,cz)，内外半径 r0/r1，世界角 a0→a1（弧度，x 轴起、z 向南为正） */
function arcBand(cx, cz, r0, r1, a0, a1, seg = 14) {
  const P = [];
  for (let i = 0; i <= seg; i++) { const a = a0 + ((a1 - a0) * i) / seg; P.push(cx + r1 * Math.cos(a), cz + r1 * Math.sin(a)); }
  for (let i = seg; i >= 0; i--) { const a = a0 + ((a1 - a0) * i) / seg; P.push(cx + r0 * Math.cos(a), cz + r0 * Math.sin(a)); }
  return P;
}

// ═════════════ 4) 西安赛瑞喜来登大酒店（未央路 32 号） ═════════════
// 档案 north.json#sheraton：主楼 31 层（百科/酒店资料）；新古典米黄石材：转角宽壁柱 + 方窗网格，顶部三层拱窗段上下厚檐口，屋顶机房挂红橙色“S”；
// 低层 U 形翼楼（约 18–20 层，顶层拱窗 + 檐口）、裙房拱窗 + 入口小玻璃穹顶、拱形门廊红色 Sheraton。
// 照片 sheraton_00（日景）/04（夜景）/03（门廊）。主楼立面宽度：窗 4 列 + 两侧宽壁柱，按层高 3.3 m 与窗行距比例反推面宽约 23 m
//   → 主塔取 OSM w1267004711（993fd918，37×23 m，东西长），照片正面为其西侧 23 m 窄面（与“面宽 38 m”的 w1267005415 不符，后者取作中段翼楼）。
// 卫星 z19：最高屋面（带机房方盒）在 993fd918 以东约 40 m（楼身东倾 0.37 m/m × 110 m），与此一致。
const SH_STONE = { pattern: 'stoneWindows', spd: '#e6dcc6', tint: '#2f3b46', floorH: 3.3, colW: 4.6, spandrel: 0.42, mullW: 2.9, lit: 0.55 };
const SH_ARCH = { pattern: 'stoneWindows', spd: '#e8dfca', tint: '#2a3540', floorH: 5.1, colW: 7.4, spandrel: 0.16, mullW: 3.3, lit: 0.8 };
const shPil = (x0, x1, z0, z1) => ({ name: 'pil' + x0.toFixed(0) + z0.toFixed(0), kind: 'solid', mat: { color: '#e4d9c2', roughness: 0.75 }, pts: rect(x0, x1, z0, z1), base: 15, top: 97.6 });
const sheraton = {
  id: 'n-sheraton', name: '西安赛瑞喜来登大酒店', fp: '993fd918',
  parts: [
    { name: 'tower', fp: '993fd918', base: 0, top: 97.5, style: SH_STONE, roof: NOROOF },
    { name: 'crownSec', fp: '993fd918', base: 97.5, top: 108, style: SH_ARCH, roof: { mech: false, parapet: 1.6 } },
    // 转角宽壁柱（照片：四角通高石材壁柱，略凸出墙面）
    shPil(-53.3, -48.6, -3524.3, -3519.6), shPil(-20.0, -15.2, -3524.3, -3519.6), shPil(-53.3, -48.6, -3505.4, -3500.6), shPil(-20.0, -15.2, -3505.4, -3500.6),
    // 屋顶机房方盒（挂 S 标）
    { name: 'sbox', shape: 'rect', size: [14, 10], at: [-34.2, -3512.4], base: 108, top: 115, style: { ...SH_STONE, floorH: 3.5, colW: 7, mullW: 6.2 }, roof: { mech: false, parapet: 0.8 } },
    // 中段翼楼（照片：约 20 层，顶层一排拱窗）与南翼（约 18 层，西端为方塔形端头）
    { name: 'mid', fp: 'ec89f2e6', base: 0, top: 72, style: SH_STONE, roof: { mech: false, parapet: 1.4 } },
    { name: 'south', fp: '51ffa470', base: 0, top: 64, style: SH_STONE, roof: { mech: false, parapet: 1.4 } },
    // 裙房（3 层，首层大拱窗）+ 入口玻璃格构小穹顶（夜间白光）
    { name: 'podW', kind: 'podium', fp: 'e1042bca', base: 0, top: 15, style: { pattern: 'stoneWindows', spd: '#e3d8c1', tint: '#2d3a45', floorH: 7.5, colW: 7, spandrel: 0.2, mullW: 3.2, lit: 0.85 }, roofMat: { color: '#8f897c', roughness: 0.9 } },
    { name: 'podE', kind: 'podium', fp: 'ef378e57', base: 0, top: 15, style: { pattern: 'stoneWindows', spd: '#e3d8c1', tint: '#2d3a45', floorH: 7.5, colW: 7, spandrel: 0.2, mullW: 3.2, lit: 0.85 }, roofMat: { color: '#8f897c', roughness: 0.9 },
      crown: [{ type: 'dome', at: [-64, -3488], r: 6.5, h: 6.5, mat: { color: '#d9dde0', metalness: 0.4, roughness: 0.3, glow: '#fff1d6' }, glow: '#fff1d6' }] },
  ],
  signs: [
    { text: 'S', part: 'sbox', face: 'W', y: 111.5, h: 5.5, color: '#e8542c', glow: '#ff6a3a' }, // 屋顶机房外侧红橙色圆形 S 标（照片正面）
    { text: 'Sheraton', part: 'podW', face: 'W', y: 9, h: 2.6, color: '#d2232a', serif: true }, // 拱形门廊（照片 03）
  ],
  // 厚檐口：主楼 97.5 m / 108 m 两道、中段 64 / 72 m、南翼 64 m（夜间暖白勾勒）
  bands: [
    { part: 'tower', levels: [96.6], h: 1.0, depth: 0.7, color: '#e8dfca', glow: '#ffe7c0', strength: 1.6 },
    { part: 'crownSec', levels: [106.4], h: 1.3, depth: 0.9, color: '#e8dfca', glow: '#ffe7c0', strength: 1.6 },
    { part: 'mid', levels: [63.2, 70.6], h: 0.9, depth: 0.6, color: '#e8dfca', glow: '#ffe7c0', strength: 1.4 },
    { part: 'south', levels: [62.6], h: 0.9, depth: 0.6, color: '#e8dfca', glow: '#ffe7c0', strength: 1.4 },
    { part: 'podW', levels: [14], h: 0.8, depth: 0.5, color: '#e8dfca', glow: '#ffe7c0', strength: 1.2 },
  ],
  night: { floodlight: [{ part: 'tower', color: '#ffd9a8', strength: 0.42 }, { part: 'mid', color: '#ffd9a8', strength: 0.35 }, { part: 'south', color: '#ffd9a8', strength: 0.35 }] },
  supersede: { names: ['西安赛瑞喜来登大酒店', '喜来登大酒店', '西安喜来登大酒店'] },
  meta: {
    dossier: 'north.json#sheraton',
    sources: ['百科/酒店资料“主楼高31层，客房491间”（WebSearch 摘要）', 'OSM w1267004711 / w1267005415 / w1267005076 / w1267005140 / w1267005656', 'Esri World Imagery z19'],
    photos: ['scratchpad/dossier_north/art/sheraton_00.jpg', 'sheraton_03.jpg', 'sheraton_04.jpg'],
    confidence: 'medium',
    notes: '米数未查到：31 层按裙房 3 层 × 5 m + 客房 25 层 × 3.3 m + 顶部拱窗段 3 层 × 3.5 m = 108 m，机房方盒至 115 m（原 landmarks2026 “26 层 90 m / 37×23 方盒”）。'
      + '中段 20 层 72 m、南翼 18 层 64 m 按照片数层；各分体对应关系按照片正面宽度 + 卫星屋面位移推断（主塔=993fd918）。拱窗段用大窗洞立面近似半圆拱。',
  },
};

// ═════════════ 5) 龙首印象城（未央路 33 号，未央路 × 龙首北路东北角） ═════════════
// 档案 north.json#yxc_longshou：B1–L5（赢商网）；照片（Commons 2023-10 龙首原站 D 口）：西南转角大圆弧，银色冲孔铝板大块竖向分格，
// 顶部一圈弧形大 LED 屏，首层深色带 + 雨篷。轮廓 OSM w1370944996（南北 224 × 东西 95 m）直角，转角圆弧按照片（半径约 28 m，照片比例估）。
const YX = { x0: 65.8, x1: 161.3, z0: -3985.1, z1: -3761.6, r: 28 };
const yxc = {
  id: 'n-yxc-longshou', name: '龙首印象城', center: [113.5, -3873.3],
  parts: [
    { name: 'mall', kind: 'podium', pts: roundedRect(YX.x0, YX.x1, YX.z0, YX.z1, { sw: YX.r }), base: 0, top: 27,
      style: { pattern: 'stoneWindows', spd: '#b9bec2', tint: '#3b4a55', floorH: 5.2, colW: 6.0, spandrel: 0.86, mullW: 5.6, lit: 0.4 }, roofMat: { color: '#8e9092', roughness: 0.85 } },
    { name: 'shop', kind: 'facade', pts: roundedRect(YX.x0, YX.x1, YX.z0, YX.z1, { sw: YX.r }), grow: 0.2, base: 0, top: 5.5, style: { pattern: 'retail', tint: '#2a3238', spd: '#3a3f44', floorH: 5.5, colW: 3.2, spandrel: 0.1, mullW: 0.2, lit: 0.95 } },
    // 西南圆弧转角顶部通长弧形 LED 屏（约 20–27 m）
    { name: 'led', kind: 'facade', pts: arcBand(YX.x0 + YX.r, YX.z1 - YX.r, YX.r + 0.2, YX.r + 0.9, Math.PI * 0.5, Math.PI), base: 19, top: 27, style: { pattern: 'screen' } },
  ],
  bands: [{ part: 'mall', levels: [5.6], h: 0.6, depth: 1.8, color: '#3a3f44' }], // 首层雨篷
  supersede: { names: ['印象城(龙首店)', '龙首印象城'] },
  meta: {
    dossier: 'north.json#yxc_longshou',
    sources: ['OSM w1370944996', '赢商网 B1–L5、总建面 125,540㎡（WebSearch 摘要）'],
    photos: ['scratchpad/dossier_north/photos/Exit_D_of_LONGSHOUYUAN_Station_Xi_an_Metro_Oct_6_2023_.jpg', 'Exit_C_of_LONGSHOUYUAN_Station_Xi_an_Metro_Oct_6_2023_.jpg'],
    confidence: 'medium',
    notes: '高度未查到：5 层 × 5.2 m ≈ 27 m（原模型 32 m 无出处）。圆弧转角半径按照片比例估 28 m；其余三角照片未见，保持直角。冲孔铝板用浅银色大块实墙 + 细缝近似。',
  },
};

// ═════════════ 6) 荣民金融中心（270 m，大明宫西站上盖） ═════════════
// 档案 north.json#rongmin（high）：270 m / 58 层（CTBUH 57 层）、OSM w1370944673 height=270；轮廓 57×56 m 切角方形；
// 2024-04 施工照（igc_13）：方塔微收切角，无明显收分；完工后“双银 Low-E 幕墙、顶部停机坪”（网易 2026-04，landmarks2026 引）。
// 原 sky-data rongmin 放在 (140,−4862)，偏北约 160 m——本条按 OSM 轮廓落位并替代。
const rongmin = {
  id: 'n-rongmin', name: '荣民金融中心', fp: '1d086781',
  parts: [{
    name: 'tower', fp: '1d086781', base: 0, top: 263,
    style: { pattern: 'curtain', tint: '#8ea3b5', spd: '#b3bec7', floorH: 4.5, colW: 1.5, spandrel: 0.2, mullW: 0.12, band: 15, lit: 0.42 },
    roof: { mech: false }, crown: [{ type: 'parapet', h: 4.5 }, { type: 'helipad', r: 14, lift: 1.2 }],
  }],
  night: { outline: [{ part: 'tower', color: '#dfe9ff', w: 0.5 }] },
  supersede: { keys: ['rongmin'], names: ['荣民金融中心', '荣民中心'] },
  meta: {
    dossier: 'north.json#rongmin',
    sources: ['https://www.skyscrapercenter.com/building/rongmin-financial-center/34291', 'OSM w1370944673 height=270', '西部网 2024-05-16 / 网易 2026-04（landmarks2026 引）'],
    photos: ['scratchpad/dossier_north/art/igc_12.jpg（2023-08 施工）', 'art/igc_13.jpg（2024-04 施工）'],
    confidence: 'high（高度/轮廓）；low（塔冠：完工照未见）',
    notes: '屋面 263 m + 玻璃女儿墙 4.5 m + 停机坪 → 顶 ≈ 270 m。幕墙颜色按文字“双银 Low-E”取浅银蓝；完工后的塔冠造型无照片，按文字只做停机坪。',
  },
};

// ═════════════ 7) 利君V时代（凤城一路 6 号） ═════════════
// 档案 north.json#lijun（low）：OSM r18889791 轮廓 80×30 m（标 height=140，无出处）；有租网/搜狐“近百米”“A/B 两栋百米高层 + 裙楼”，层高 4.2 m。
// 卫星 z19（sat/n_z_lj.jpg）：屋面（约 42×75 m，中间一块天井）在 OSM 轮廓以东约 41 m（楼身东倾），41 ÷ 0.38 ≈ 108 m，与“近百米”吻合；
//   屋面宽 42 m 大于 OSM 的 30 m → 塔身按屋面宽度取 42 m（西缘与 OSM 对齐）。
const lijun = {
  id: 'n-lijun', name: '利君V时代', center: [88, -5982.5],
  parts: [
    { name: 'tower', pts: rect(67, 109, -6020, -5945), base: 0, top: 101, style: { pattern: 'curtain', tint: '#4f5d68', spd: '#8d979f', floorH: 4.2, colW: 1.5, spandrel: 0.24, mullW: 0.14, lit: 0.4 } },
    { name: 'podium', kind: 'podium', fp: '1b4aaaac', base: 0, top: 14, style: { pattern: 'retail', tint: '#34424c', spd: '#9aa3aa' } },
  ],
  supersede: { names: ['利君V时代'] },
  meta: {
    dossier: 'north.json#lijun', sources: ['OSM r18889791', 'https://youzuw.com/index.php?a=xiangxi&g=Mobile&id=219&m=Office', 'https://www.sohu.com/a/910559718_121484367'],
    photos: ['scratchpad/dossier_north/sat/lijun.jpg', 'sat/n_z_lj.jpg'], confidence: 'low',
    notes: '高度：“近百米”+ 卫星位移换算约 108 m → 取 101 m（24 层 × 4.2 m）；原 landmarks2026 140 m 仅凭 OSM 标签。A/B 两栋 OSM 只有一块，卫星屋面为一整块带天井的屋面，按一栋建。无外观照片，立面按文字“灰色 Low-E 玻璃幕墙”。',
  },
};

// ═════════════ 8) 西安城北客运站（北二环西段 9 号） ═════════════
// 档案 north.json#chengbei_bus（low）：OSM w1371869014 L 形；卫星 z19（sat/n_z_cb.jpg）：北侧东西长条主楼 + 东端北伸一翼（深色屋面），
// 南侧一层浅色大屋面候车厅，北面大巴停车场。高度无出处：北侧阴影宽约 8–10 m、屋面位移不可辨 → 按 4 层估 16 m（原模型 30 m 无出处）。
const chengbei = {
  id: 'n-chengbei-bus', name: '西安城北客运站', fp: '457d93c1',
  parts: [
    { name: 'hall', kind: 'podium', fp: '457d93c1', base: 0, top: 7, style: { pattern: 'retail', tint: '#3a4a56', spd: '#d4d2cc', floorH: 7, lit: 0.8 }, roofMat: { color: '#c9c6bf', roughness: 0.9 } },
    { name: 'main', pts: rect(-586, -450, -5736, -5705), base: 0, top: 16, style: { pattern: 'stoneWindows', spd: '#d9d6cf', tint: '#34424c', floorH: 4, colW: 3, spandrel: 0.4, mullW: 1.2, lit: 0.5 } },
    { name: 'wingE', pts: rect(-491, -455, -5754, -5736), base: 0, top: 16, style: { pattern: 'stoneWindows', spd: '#d9d6cf', tint: '#34424c', floorH: 4, colW: 3, spandrel: 0.4, mullW: 1.2, lit: 0.5 } },
  ],
  supersede: { names: ['西安城北客运站'] },
  meta: { dossier: 'north.json#chengbei_bus', sources: ['OSM w1371869014', 'http://xa.bendibao.com（北二环路西段9号）'], photos: ['scratchpad/dossier_north/sat/n_z_cb.jpg'], confidence: 'low',
    notes: '无照片；形体按卫星，高度按阴影估（±5 m）。档案 signage 为空，不挂字。' },
};

// ═════════════ 9) 天地时代广场（未央大道 × 凤城二路东北角） ═════════════
// 档案 north.json#tiandi（low）：“楼层 28 层”（tdsdgc.cn），3 栋、总建面 14.3 万㎡；B 座 OSM w1372722173、A 座 w1372721281。
// 卫星 z19（sat/n_z_td.jpg）：B 座屋面（约 40×25 m）与 A 座屋面均在 OSM 轮廓以东约 40–42 m → 40 ÷ 0.38 ≈ 105–110 m，与 28 层吻合。
const tiandi = {
  id: 'n-tiandi', name: '天地时代广场', fp: '7743f793',
  parts: [
    { name: 'podB', kind: 'podium', fp: '7743f793', base: 0, top: 18, style: { pattern: 'retail', tint: '#34424c', spd: '#b8b2a8' } },
    { name: 'towerB', pts: rect(80.6, 120.6, -6646, -6619), base: 0, top: 108, style: { pattern: 'curtain', tint: '#3f5a6c', spd: '#6c7780', floorH: 3.85, colW: 1.5, spandrel: 0.28, lit: 0.42 } },
    { name: 'towerA', fp: 'f2f29540', base: 0, top: 104, style: { pattern: 'grid', tint: '#3a4a56', spd: '#c4beb3', floorH: 3.7, colW: 2.2, spandrel: 0.38, lit: 0.5 } },
  ],
  supersede: { names: ['天地时代广场', '天地时代广场-A座', '天地时代广场-B座'] },
  meta: { dossier: 'north.json#tiandi', sources: ['tdsdgc.cn（楼层28层）', 'OSM w1372722173 / w1372721281'], photos: ['scratchpad/dossier_north/sat/n_z_td.jpg'], confidence: 'low',
    notes: '28 层 × 3.85 m ≈ 108 m（B 座）；A 座未见层数，按卫星位移与 B 座相近取 104 m。塔身落位按卫星屋面减倾斜位移。无外观照片，幕墙颜色为推断。' },
};

// ═════════════ 10) 第二长途电信大楼（“中国电信大厦”，未央路 142 号） ═════════════
// WebSearch（百度百科“电信大厦”摘要）：西安第二长途电信大楼，1999 年建成，总高 168.00 m，33 层；张家堡数据中心（未央路 142 号第二长途枢纽楼）31 层、机房层高 ≥4.2 m。
// OSM w1372140211（1680b939）：北部五边形塔身（北端尖角、东北斜边）+ 南部裙房。卫星 z19（sat/n_z_tel.jpg）：屋面为约 30×26 m 的方形，
//   外缘一圈锯齿状构架（档案“东侧方框状屋顶构架”），比五边形底座小很多 → 上部收成方塔；屋面相对底座东移约 50 m（168 m × 0.3）。
const TEL = { pattern: 'grid', tint: '#34495a', spd: '#c9c7c0', floorH: 4.3, colW: 1.8, spandrel: 0.34, mullW: 0.4, lit: 0.45 };
const telecom = {
  id: 'n-telecom', name: '第二长途电信大楼（中国电信大厦）', center: [-62, -7400],
  parts: [
    { name: 'base', pts: [-89.6, -7383.3, -89.6, -7421.8, -84.9, -7421.6, -71.9, -7434.9, -58.6, -7421.7, -53.7, -7421.7, -53.7, -7417.1, -20.9, -7383.9], base: 0, top: 58, style: TEL },
    { name: 'podium', kind: 'podium', pts: [-97.9, -7359.9, -67.7, -7359.9, -67.7, -7383.3, -27.2, -7383.3, -27.2, -7341.6, -104.9, -7341.4, -104.9, -7359.0], base: 0, top: 20, style: { pattern: 'stoneWindows', spd: '#d0ccc2', tint: '#33434f', floorH: 5, colW: 3, spandrel: 0.4, mullW: 1.2, lit: 0.6 } },
    { name: 'shaft', shape: 'chamfer', size: [33, 30], at: [-66, -7404], shapeOpt: { c: 4 }, base: 0, top: 158, style: TEL, roof: { mech: false, parapet: 1.2 },
      crown: [{ type: 'frame', h: 8, inset: -0.8, step: 3, post: 0.7, mat: '#b9bcbe' }, { type: 'masts', y: 158, list: [[0, 0]], top: 175, r: 0.5 }] },
  ],
  supersede: { names: ['中国电信大厦（未央路）', '中国电信大厦', '电信大厦'] },
  meta: {
    dossier: 'north.json#telecom（高度补自 WebSearch）',
    sources: ['百度百科“电信大厦”（WebSearch 摘要：第二长途电信大楼 1999 年建成，总高 168.00 m，33 层）', 'https://www.fenghuoyunji.com/data_5.html（张家堡数据中心：未央路142号第二长途枢纽楼 31 层）', 'OSM w1372140211'],
    photos: ['scratchpad/dossier_north/sat/telecom.jpg', 'sat/n_z_tel.jpg'], confidence: 'medium（高度）；low（分段）',
    notes: '168 m 按塔顶构架顶计：塔身 158 m + 锯齿构架 8 m（避雷针另计）；下部五边形塔座 58 m、上部方塔 33×30 m 的分段高度照片未见，按卫星屋面尺寸推断。'
      + '楼顶字无照片依据，不建。原 landmarks2026 按 80 m 估，偏低一倍。',
  },
};

// ═════════════ 11) 中登大厦 A/B 座（未央路 × 凤城四路西南角） ═════════════
// 档案 north.json#zhongdeng（low）：city8“中登大厦30层”、官网地址“A座24层”→ A 座 ≥30 层；OSM A 座 w1372140237、B 座 w1372140234（十字形平面）。
// 卫星 z19（sat/n_z_zd.jpg）：A 座屋面东移约 37 m（→ ≈100 m，与 30 层 × 3.3 m 一致），B 座十字形屋面东移约 32 m（→ ≈85 m）。
const zhongdeng = {
  id: 'n-zhongdeng', name: '中登大厦', fp: '6df57bbf',
  parts: [
    { name: 'A', fp: '6df57bbf', base: 0, top: 100, style: { pattern: 'grid', tint: '#3b5264', spd: '#b9b5ad', floorH: 3.3, colW: 1.8, spandrel: 0.35, lit: 0.45 } },
    { name: 'B', fp: 'c1c0aeae', base: 0, top: 85, style: { pattern: 'grid', tint: '#3b5264', spd: '#b9b5ad', floorH: 3.3, colW: 1.8, spandrel: 0.35, lit: 0.45 } },
  ],
  supersede: { names: ['中登大厦', '中登大厦-A座', '中登大厦-B座'] },
  meta: { dossier: 'north.json#zhongdeng', sources: ['city8 地址条目（中登大厦30层）', 'OSM w1372140237 / w1372140234'], photos: ['scratchpad/dossier_north/sat/n_z_zd.jpg'], confidence: 'low',
    notes: 'A 座 30 层 × 3.3 m ≈ 100 m；B 座层数未查到，按卫星位移 32 m ÷ 0.38 ≈ 85 m。无外观照片，立面为推断。' },
};

// ═════════════ 12) 长庆油田公司机关大楼（OSM：长庆大厦） ═════════════
// 档案 north.json#changqing（low）：OSM w1372721748 向北凸的弧形板楼（外包 118×59 m）+ 东南白色平屋面体量（中间嵌椭圆屋顶）。
// 高度无出处：卫星上北侧投影长（>55 m）、属高层，但塔顶屋面与倾斜位移在影像中无法分辨 → 暂取 60 m（约 15 层），±20 m。
const changqing = {
  id: 'n-changqing', name: '长庆油田公司机关大楼', fp: '601ce4ef',
  parts: [
    { name: 'arc', fp: '601ce4ef', base: 0, top: 60, style: { pattern: 'grid', tint: '#3a5468', spd: '#cfc9bd', floorH: 3.9, colW: 1.8, spandrel: 0.32, lit: 0.45 } },
    { name: 'east', kind: 'podium', pts: rect(158, 205, -7231, -7203), base: 0, top: 14, style: { pattern: 'stoneWindows', spd: '#e8e6e0', tint: '#34424c' }, roofMat: { color: '#e4e2dc', roughness: 0.8 },
      crown: [{ type: 'dome', at: [182, -7217], r: [9, 5], h: 2.2, mat: { color: '#a56a4e', roughness: 0.6 } }] },
  ],
  supersede: { names: ['长庆大厦', '长庆油田公司机关大楼'] },
  meta: { dossier: 'north.json#changqing', sources: ['OSM w1372721748（长庆大厦）', 'city8：长庆油田公司位于未央路与凤城四路十字东北'], photos: ['scratchpad/dossier_north/sat/changqing.jpg', 'sat/n_z_cq.jpg'], confidence: 'low',
    notes: '高度无出处（60 m 为保守取值，待照片核对）；东南体量 14 m 与椭圆屋顶按卫星。' },
};

// ═════════════ 13) 长庆苏里格大厦（凤城四路 73 号） ═════════════
// 档案 north.json#suligs（low）：OSM w1418071545 东西向板楼 + 西端方形塔。卫星 z19（sat/n_z_sl.jpg）：方塔屋面（切角方形、屋顶一圈方环构架 + 中央机房）
//   东移约 34 m → 34 ÷ 0.38 ≈ 90 m；东段为低层长条（屋面位移不明显，约 4 层）。
const suligs = {
  id: 'n-suligs', name: '长庆苏里格大厦', center: [-975, -7553],
  parts: [
    { name: 'tower', shape: 'chamfer', size: [35, 36], at: [-991.6, -7553.6], shapeOpt: { c: 3.5 }, base: 0, top: 86, style: { pattern: 'grid', tint: '#3d586c', spd: '#c8c4bb', floorH: 3.8, colW: 1.8, spandrel: 0.32, lit: 0.45 },
      roof: { mech: false, parapet: 1.2 }, crown: [{ type: 'frame', h: 4, inset: 4.5, step: 3.5, post: 0.6, mat: '#c7c9ca' }] },
    { name: 'wing', pts: rect(-974, -912.2, -7558.2, -7542), base: 0, top: 16, style: { pattern: 'stoneWindows', spd: '#d6d2c9', tint: '#34424c', floorH: 4, colW: 3, spandrel: 0.4, mullW: 1.2 } },
  ],
  supersede: { names: ['长庆苏里格大厦'] },
  meta: { dossier: 'north.json#suligs', sources: ['OSM w1418071545', '360 地图（凤城四路73号）'], photos: ['scratchpad/dossier_north/sat/n_z_sl.jpg'], confidence: 'low',
    notes: '高度按卫星位移 34 m ÷ 0.38 ≈ 90 m（屋面 86 m + 构架 4 m），与原 landmarks2026 估值相同但现有依据；无外观照片。' },
};

// ═════════════ 14) 西安环球贸易中心 1 号楼（在建）/ 2 号楼 ═════════════
// 档案 north.json#igc1 / igc2：1 号楼规划 62 层 299.75 m，2012 年开工多次停工，2025-08 中建四局进场、2026-06“已复工建设”，截至 2026-09 未见封顶报道；
// 2 号楼 29 层 149.75 m、2019 年底封顶、深色玻璃幕墙 + 横向层间带，塔顶一圈构架（工地照 igc_08 远景）。
// 卫星 z19（sat/n_igc.jpg，约 2019–2020 年影像）：2 号楼屋面（约 61×36 m，带格构构架）在 OSM w1372721581（e1212432）以东约 52 m
//   → 2 号楼实际在 e1212432 上（原模型放在屋面位置 (157,−7665)，偏东约 60 m）；1 号楼工地核心筒的倾斜影子显示塔基约在 (112,−7752)。
// 1 号楼按现状（工地照 igc_08：核心筒出地面二十余层 + 塔吊，外框只有低区钢结构）建：核心筒 118 m、低区裸框架 24 m、塔吊。
const igc1 = {
  id: 'n-igc1', name: '西安环球贸易中心1号楼（在建）', center: [112, -7752],
  parts: [
    { name: 'frame', shape: 'chamfer', size: [52, 52], at: [112, -7752], shapeOpt: { c: 3 }, base: 0, top: 24,
      style: { pattern: 'stoneWindows', tint: '#15181b', spd: '#9c988f', floorH: 4.2, colW: 8.5, spandrel: 0.16, mullW: 0.9, lit: 0 }, roof: { mech: false, parapet: 0.4 } },
    { name: 'core', kind: 'solid', mat: { color: '#a19d95', roughness: 0.9 }, shape: 'rect', size: [24, 22], at: [112, -7752], base: 0, top: 118,
      crown: [{ type: 'crane', offset: [16, 15], top: 150, jib: 58, rot: -20, counter: 18 }] },
  ],
  supersede: { keys: ['igc1'], names: ['西安环球贸易中心1号楼'] },
  meta: {
    dossier: 'north.json#igc1',
    sources: ['https://news.qq.com/rain/a/20240514A018SB00', 'https://news.qq.com/rain/a/20260627A03BYT00'],
    photos: ['scratchpad/dossier_north/art/igc_08.jpg'], confidence: 'medium（状态）；low（现高度与落位）',
    notes: '当前实际高度未查到：核心筒 118 m 按工地照与 2 号楼（149.75 m）比例估（约 0.8 倍）；落位按卫星核心筒倾斜影子反推，±15 m。原 SPECIAL.igc1 为“幕墙到 64 m、楼板到 128 m”的在建样式，与照片（只有核心筒）不符。',
  },
};
const igc2 = {
  id: 'n-igc2', name: '西安环球贸易中心2号楼（环贸晶樽）', center: [96, -7659],
  parts: [
    { name: 'podium', kind: 'podium', fp: 'e1212432', base: 0, top: 16, style: { pattern: 'retail', tint: '#2f3a44', spd: '#6d7780' } },
    { name: 'tower', pts: rect(66, 127, -7677, -7641), base: 0, top: 144,
      style: { pattern: 'horizontalBands', tint: '#4a5866', spd: '#5c6670', floorH: 4.9, colW: 1.6, spandrel: 0.3, mullW: 0.08, lit: 0.4 }, roof: { mech: false, parapet: 1.2 },
      crown: [{ type: 'frame', h: 5.75, inset: 0.4, step: 3.2, post: 0.5, mat: '#8a9197' }] },
  ],
  supersede: { keys: ['igc2'], names: ['西安环球贸易中心2号楼'] },
  meta: {
    dossier: 'north.json#igc2', sources: ['腾讯新闻 2024-12-16（149.75 m）/ 2024-05、2026-06（29 层）'], photos: ['scratchpad/dossier_north/art/igc_08.jpg（左侧塔）', 'sat/n_igc.jpg'],
    confidence: 'medium',
    notes: '屋面 144 m + 塔顶构架 5.75 m = 149.75 m；平面 61×36 m 按卫星屋面量取、按倾斜位移（52 m ÷ 149.75 ≈ 0.35 m/m）西移落位到 OSM e1212432 上。层间横带明显 → 横带立面。',
  },
};

// ═════════════ 15) 世纪金花 New Block（赛高店，凤城五路十字西南角） ═════════════
// 档案 north.json#jinhua_nb：OSM w1372140129（东西 206×南北 86 m）；2023-01 焕新：A/B 两馆间“峡谷街区”——香槟金/古铜曲线挑板 + 玻璃栏板、白色树状柱、金色“New Block”字。
// 高度未查到：照片 jinhua_15 峡谷两侧约 5 层 → 5 × 5.2 ≈ 26 m（原 landmarks2026 32 m 无出处）。峡谷位置照片/卫星未能定位，只在北立面挂字。
const jinhua = {
  id: 'n-jinhua-nb', name: '世纪金花 New Block', fp: 'ab5385f3',
  parts: [{ name: 'mall', kind: 'podium', fp: 'ab5385f3', base: 0, top: 26, style: { pattern: 'retail', tint: '#3a4148', spd: '#c9b59c', floorH: 5.2, colW: 3.4, spandrel: 0.38, lit: 0.85 }, roofMat: { color: '#8e8a82', roughness: 0.9 } }],
  // 曲线挑板（古铜色）：按层起伏的水平金属带
  bands: [{ part: 'mall', levels: [5.4, 10.6, 15.8, 21], wave: { amp: 0.9, len: 60, phase: 1.2 }, h: 0.45, depth: 1.2, color: '#a8876a', glow: '#ffd9a0', strength: 1.1 }],
  signs: [{ text: 'New Block', part: 'mall', face: 'N', y: 22.5, h: 3.4, color: '#d9b36a' }],
  supersede: { names: ['世纪金花赛高购物中心', '世纪金花 New Block', '世纪金花New Block'] },
  meta: { dossier: 'north.json#jinhua_nb', sources: ['OSM w1372140129', 'https://news.qq.com/rain/a/20260627A03BYT00', '中国日报网 2023-05 照片'], photos: ['scratchpad/dossier_north/art/jinhua_15.jpg'], confidence: 'medium（外观）；low（高度）',
    notes: '26 m 按照片数层；“New Block”金色字按档案 signage（峡谷入口上方），具体立面未确认，放北立面（凤城五路）。' },
};

// ═════════════ 16) 天朗·经开中心（明光路 55 号） ═════════════
// 档案 north.json#tianlang：29 层（tljkzx.cn）；OSM w1418071423 北部高层 + 南部低层裙房。卫星 z19：塔身屋面东移约 43 m（→ ≈113 m，与 29 层吻合）。
const tianlang = {
  id: 'n-tianlang', name: '天朗·经开中心', fp: '655d9f55',
  parts: [
    { name: 'podium', kind: 'podium', fp: '655d9f55', base: 0, top: 18, style: { pattern: 'retail', tint: '#34424c', spd: '#bdb7ac' } },
    { name: 'tower', pts: rect(-1553, -1511, -7953, -7920), base: 0, top: 110, style: { pattern: 'curtain', tint: '#3e5a6e', spd: '#6c7882', floorH: 3.8, colW: 1.5, spandrel: 0.26, lit: 0.42 } },
  ],
  supersede: { names: ['天朗·经开中心'] },
  meta: { dossier: 'north.json#tianlang', sources: ['tljkzx.cn（29层，甲级）', 'OSM w1418071423'], photos: ['scratchpad/dossier_north/sat/tianlang.jpg', 'sat/n_z_tl.jpg'], confidence: 'low',
    notes: '29 层 × 3.8 m ≈ 110 m（原 landmarks2026 100 m 无出处）；塔身 42×33 m 按卫星屋面减倾斜位移；无外观照片。' },
};

// ═════════════ 17) 西安市未央区人民政府（public.json） ═════════════
// public.json：Overture 轮廓 40×21 m（OSM w1264995048），无照片；CMAB 数据集高度 12.6 m（public.json local_data）。
const weiyangGov = {
  id: 'n-weiyang-gov', name: '西安市未央区人民政府', fp: 'e6742d2b',
  parts: [{ name: 'main', fp: 'e6742d2b', base: 0, top: 12.6, style: { pattern: 'stoneWindows', spd: '#dcd8cf', tint: '#34424c', floorH: 4.2, colW: 3, spandrel: 0.42, mullW: 1.3, lit: 0.4 } }],
  supersede: { names: ['西安市未央区人民政府'] },
  meta: { dossier: 'public.json#西安市未央区人民政府', sources: ['OSM w1264995048', 'CMAB 西安（Zhang et al. 2025）12.6 m'], photos: [], confidence: 'low', notes: '仅坐标与轮廓可信；高度用 CMAB 数据集值（3 层左右）。' },
};

// ═════════════ 18) 未央国际（写字楼）——已精建（sky-data2 wygjT + wy168a–d），只改档案证实的错误 ═════════════
// 档案 north.json#wygj（high）+ ArchDaily 照片 wygj_1（由北向南：左为东立面、右为北立面）/ wygj_5（北立面图）：
//   ✘ 原塔顶 5 m 发光玻璃塔冠 → 照片为平顶、玻璃幕墙直接收边；✘ 原深灰玻璃 #3a4148 → 浅蓝镜面玻璃 #9fb7cc；
//   ✘ 原“未央国际”两面 → 只在北立面顶部靠东；＋ 北立面东段成列深色凹槽（双层通高共享空间）；＋ 裙房北立面红色霓虹“CUB GROCERY”。
// 三角形平面与落位沿用 sky-data2 的 WYGJ_TOWER（调研 §3.3），退台裙房 wy168a–d 不动。
const WYGJ_TOWER = [-78, -8637, -22, -8633, -20, -8584];
const wygj = {
  id: 'n-wygj-tower', name: '未央国际', center: [-40, -8618],
  parts: [
    { name: 'tower', pts: WYGJ_TOWER, base: 0, top: 99.6, roof: { mech: false, parapet: 1.0 },
      style: { pattern: 'curtain', tint: '#9fb7cc', spd: '#c6ced6', floorH: 3.9, colW: 1.5, spandrel: 0.14, mullW: 0.07, lit: 0.45 } },
    // 北立面东段成列深色凹槽（照片 wygj_1：每两层一个通高共享空间，逐层错位；这里合成一条深色竖带）
    { name: 'recess', kind: 'solid', mat: { color: '#1c232a', roughness: 0.4, metalness: 0.4 }, shape: 'rect', size: [7, 1.1], rot: -4.1, at: [-31.5, -8634.1], base: 12, top: 74 },
  ],
  signs: [
    { text: '未央国际', part: 'tower', face: 'N', near: 'E', margin: 2, y: 94, h: 5.2, color: '#ffffff' },
    { text: 'CUB GROCERY', part: null, at: [-86, -8635.9], face: 'N', y: 13.5, h: 2.0, color: '#e8453c', glow: '#ff5a4a' }, // 裙房北立面红色霓虹（wy168 由 skyline 建）
  ],
  clearance: 0.5,
  supersede: { keys: ['wygjT'] },
  meta: {
    dossier: 'north.json#wygj',
    sources: ['陕西建筑业协会：25 层、99.6 m', 'https://www.archdaily.cn/cn/992137/xi-an-wei-yang-guo-ji-dujian-zhu'],
    photos: ['scratchpad/dossier_north/art/wygj/wygj_1.jpg', 'wygj_0.jpg', 'wygj_5.jpg（北立面图）', 'art/cdxdg_03.jpg'],
    confidence: 'high',
    notes: '只替代塔楼（wygjT）；裙房 We Young 168（wy168a–d）保留原精建。“CUB GROCERY”用独立字牌挂在原裙房北立面（dossier-kit 新增 part:null + at）。',
  },
};

// ═════════════ 19) 未央国际中心（凤城七路 × 未央路东南角） ═════════════
// 档案 north.json#wygjzx：地上 16 层（1–5 层商业、6–16 层办公），OSM w1373232106（56×22 m，notes 认为轮廓不全）。
const wygjzx = {
  id: 'n-wygjzx', name: '未央国际中心', fp: '44be2520',
  parts: [
    { name: 'tower', fp: '44be2520', base: 0, top: 67, style: { pattern: 'grid', tint: '#3f5a70', spd: '#7a848c', floorH: 3.8, colW: 1.6, spandrel: 0.3, lit: 0.4 } },
    { name: 'shops', kind: 'facade', fp: '44be2520', grow: 0.15, base: 0, top: 25, style: { pattern: 'retail', tint: '#2f3a44', spd: '#8a9299', floorH: 5, lit: 0.9 } },
  ],
  supersede: { keys: ['wygjzx'], names: ['未央国际中心'] },
  meta: { dossier: 'north.json#wygjzx', sources: ['百度百科（weiyang/notes.md 引）：地上16层'], photos: ['scratchpad/dossier_north/sat/wygjzx.jpg'], confidence: 'medium',
    notes: '米数未查到：5 层商业 × 5 m + 11 层办公 × 3.8 m ≈ 67 m。无外观照片，立面为推断。' },
};

// ═════════════ 20) CityOn 熙地港（未央路 170 号，凤城七路 × 未央路西北角） ═════════════
// 档案 north.json#xidigang：塔博曼新闻稿 seven-level（6F 影院）；照片 cdxdg_03（中国日报网 2023-07，东南方航拍）：
//   米白/浅驼色横向条带实墙（窄竖向窗缝），东南圆弧转角为蓝色网格玻璃体量（逐层退台、露台绿植），顶部一道白色弧形檐带上“CITY”白字“ON”金字；
//   南立面中段嵌竖向玻璃盒；黄昏时横向分缝处暖色线灯。卫星：屋面 8–9 个白色椭圆采光顶、中部较大椭圆穹顶；东南部浅色矩形高出体量（影院盒子）。
const XDG_C = { x: -64, z: -8741, r: 23 }; // 东南玻璃圆角体量（卫星/照片读图）
const xidigang = {
  id: 'n-xidigang', name: 'CityOn熙地港', fp: 'f11bb986',
  parts: [
    { name: 'mall', kind: 'podium', fp: 'f11bb986', base: 0, top: 34,
      style: { pattern: 'stoneWindows', spd: '#d8c9ae', tint: '#3b4650', floorH: 4.85, colW: 7.5, spandrel: 0.12, mullW: 6.9, lit: 0.6 }, roofMat: { color: '#6f7479', roughness: 0.85 },
      crown: [[-137, -8855, 11, 7], [-149, -8806, 11, 11], [-100, -8791, 9, 7], [-176, -8848, 8, 6], [-166, -8822, 7, 7], [-187, -8791, 8, 6], [-155, -8769, 9, 6], [-118, -8767, 8, 6]]
        .map(([x, z, rx, rz], i) => ({ type: 'dome', at: [x, z], r: [rx, rz], h: i === 1 ? 6.5 : 3.2, mat: { color: '#eef0f0', roughness: 0.35, metalness: 0.15 }, ring: false })) },
    { name: 'corner', shape: 'circle', size: [2 * XDG_C.r, 2 * XDG_C.r], at: [XDG_C.x, XDG_C.z], base: 0, top: 31, setbacks: [{ at: 22, inset: 1.5 }, { at: 27, inset: 3 }],
      style: { pattern: 'grid', tint: '#4f7ea8', spd: '#d9d4c8', floorH: 4.85, colW: 2.4, spandrel: 0.12, mullW: 0.18, lit: 0.8 }, roof: { mech: false, parapet: 1.1 } },
    // 顶部弧形檐带（照片：约 1.5 层高的暖灰/米色弧形实墙带，上挂 CITY 白字、ON 金字）
    { name: 'eave', kind: 'solid', mat: { color: '#c9c2b5', roughness: 0.7 }, pts: arcBand(XDG_C.x, XDG_C.z, XDG_C.r - 1, XDG_C.r + 1.2, -0.15, Math.PI * 0.62), base: 29.5, top: 37 },
    { name: 'glassbox', shape: 'rect', size: [16, 3], at: [-140, -8712.2], base: 0, top: 34, style: { pattern: 'grid', tint: '#4f7ea8', spd: '#d9d4c8', floorH: 4.85, colW: 2, spandrel: 0.1, lit: 0.8 }, roof: { mech: false, parapet: 0.6 } },
    { name: 'cinema', shape: 'rect', size: [53, 26], at: [-88.5, -8731], base: 34, top: 41, style: { pattern: 'stoneWindows', spd: '#d4d0c6', tint: '#3b4650', floorH: 7, colW: 9, spandrel: 0.9, mullW: 8.8, lit: 0.1 }, roof: { mech: true, parapet: 0.8 } },
  ],
  // 照片（东南航拍）：CITY 在左（偏南）、ON 在右（偏东）且更高更大；弧面上按方向各贴一块
  signs: [{ text: 'CITY', part: 'eave', face: -62, y: 32.6, h: 3.6, color: '#ffffff', glow: '#ffffff' }, { text: 'ON', part: 'eave', face: -24, y: 34.6, h: 4.4, color: '#e0b23c', glow: '#ffc94a' }],
  bands: [{ part: 'mall', levels: [9.7, 14.5, 19.4, 24.2, 29.1], h: 0.25, depth: 0.12, color: '#c9b99c', glow: '#ffc27a', strength: 1.6 }],
  supersede: { keys: ['xidigang'], names: ['CityOn熙地港（西安）购物中心', 'CityOn熙地港', '熙地港'] },
  meta: {
    dossier: 'north.json#xidigang',
    sources: ['OSM w1372139894', '塔博曼新闻稿 seven-level（weiyang/notes.md）', 'http://shx.chinadaily.com.cn/a/202307/21/WS64b9d1d3a3109d7585e45cc9.html'],
    photos: ['scratchpad/dossier_north/art/cdxdg_03.jpg', 'sat/xidigang.jpg', 'sat/n_xdg.jpg'], confidence: 'medium',
    notes: '高度未查到：7 层 × 4.85 m ≈ 34 m（与原模型相同，现有照片层数依据）；影院盒高出 7 m 按卫星位移估。椭圆采光顶位置沿用 sky-data2 的卫星量取值。'
      + '原招牌“CityOn熙地港”挂在东南斜切面与东立面；照片为东南圆弧转角檐带上的“CITY”（白）“ON”（金，略高），按弧面方向分贴两块。',
  },
};

// ═════════════ 21) 西安大融城 IMIX PARK（凤城七路 × 未央路东北角） ═════════════
// 档案 north.json#darongcheng：B1–5F（赢商网）；OSM w1373232024 西北角外凸大圆弧；卫星：浅色弧形屋面带沿西北圆弧；
// 立面只有 2018 年夜景效果图（沿弧线连续玻璃幕墙 + 横向线条）；招牌位置未确认（只有草坪红色落地字）→ 立面不挂字。
const darongcheng = {
  id: 'n-darongcheng', name: '西安大融城', fp: '2d48acd6',
  // 2026-10 审查 g2/g8：原 horizontalBands 立面每层通长带形窗、屋面光秃，像立体停车楼。改为商业综合体做法：
  // 浅色金属板实墙为主（窗槛墙 0.7、窄竖窗），首层通透店面（facade 罩面），西北弧面主立面保留铝板横带灯；屋顶设备屏风 + 女儿墙。
  parts: [
    { name: 'mall', kind: 'podium', fp: '2d48acd6', base: 0, top: 28, style: { pattern: 'grid', tint: '#3e4f5c', spd: '#d3cfc6', floorH: 5.6, colW: 4.8, spandrel: 0.7, mullW: 0.5, lit: 0.6 }, roofMat: { color: '#8a8b88', roughness: 0.9 },
      crown: [{ type: 'frame', h: 3.5, inset: 18, step: 4, post: 0.35, mat: 'metal' }] },
    { name: 'shop', kind: 'facade', fp: '2d48acd6', grow: 0.15, base: 0, top: 6.5, style: { pattern: 'retail', tint: '#33424c', spd: '#5c5852', floorH: 6.5, colW: 3.6, spandrel: 0.1, lit: 0.85 } },
  ],
  bands: [{ part: 'mall', levels: [11.2, 16.8, 22.4], h: 0.5, depth: 0.25, color: '#dcd8ce', glow: '#e6f0ff', strength: 1.0 }],
  signs: [{ text: '西安大融城', part: 'mall', face: 'NW', y: 24.5, h: 4.2, color: '#d8322f' }], // 主招牌：商场名（品牌红），位置按西北弧面主立面推定（未核实）
  supersede: { keys: ['darongcheng'], names: ['西安大融城 IMIX PARK', '西安大融城', '大融城'] },
  meta: { dossier: 'north.json#darongcheng', sources: ['OSM w1373232024', '赢商网 B1–5F（notes.md 引）'], photos: ['scratchpad/dossier_north/art/drc_01.jpg（效果图）', 'drc_05.jpg'], confidence: 'medium（轮廓）；low（立面）',
    notes: '高度未查到：5 层 × 5.6 m = 28 m。立面按效果图（玻璃 + 横向线条），实景未见；2026-10 按审查改为金属板实墙 + 首层店面 + 屋顶设备，'
      + '补西北弧面“西安大融城”主招牌（商场名有出处，位置为推定）。' },
};

// ═════════════ 22) 西安经开洲际酒店（凤城八路 120 号） ═════════════
// 档案 north.json#ihg：地上 22 层（中国经济网 2019-12-19）；照片 ihg_00（主立面）/ cdxdg_06（由北向南）：板楼，中部通高蓝色玻璃竖带略高出两翼、
//   顶端金色 IHG 圆形标；两翼错缝方窗（浅灰框），约 4–5 层处深色横向转换带；首层门廊 INTERCONTINENTAL 金属字。
// 卫星 z19（sat/n_ehb19.jpg）：两块白色屋面（中间以玻璃带隔开）在 OSM d9307621 以东约 42 m → 塔身落位西移 42 m，约 50×40 m。
const IHG_WALL = { pattern: 'stoneWindows', spd: '#9fb2c6', tint: '#34506d', floorH: 3.9, colW: 3.4, spandrel: 0.3, mullW: 1.4, lit: 0.6 };
const ihg = {
  id: 'n-ihg', name: '西安经开洲际酒店', center: [-181, -8925],
  parts: [
    { name: 'podium', kind: 'podium', fp: 'd9307621', base: 0, top: 12, style: { pattern: 'retail', tint: '#2d343a', spd: '#5a534c', floorH: 6, lit: 0.85 }, roofMat: { color: '#7c7a76', roughness: 0.9 } },
    { name: 'tower', pts: rect(-206, -156, -8945, -8905), base: 0, top: 86, style: IHG_WALL },
    { name: 'glass', pts: rect(-188, -174, -8947, -8943), base: 0, top: 90, style: { pattern: 'curtain', tint: '#5b86b5', spd: '#c4c9cf', floorH: 3.9, colW: 1.6, spandrel: 0.08, mullW: 0.1, lit: 0.55 }, roof: { mech: false, parapet: 0.8 } },
  ],
  bands: [{ part: 'tower', levels: [16.5], h: 3.6, depth: 0.2, color: '#2b3238' }],
  signs: [
    { text: 'IHG', part: 'glass', face: 'N', y: 87.5, h: 2.6, color: '#c8a45a' },
    { text: 'INTERCONTINENTAL', part: 'tower', face: 'S', y: 83, h: 2.8, color: '#ffffff' },
    { text: 'INTERCONTINENTAL', part: 'podium', face: 'N', y: 6, h: 1.4, color: '#c8a45a' },
  ],
  supersede: { keys: ['ihg'], names: ['西安经开洲际酒店'] },
  meta: {
    dossier: 'north.json#ihg', sources: ['http://cen.ce.cn/more/201912/19/t20191219_33934184.shtml（22 层）', 'https://www.aliseochina.com/project/西安经开洲际酒店'],
    photos: ['scratchpad/dossier_north/art/ihg_00.jpg', 'art/cdxdg_06.jpg', 'sat/n_ehb19.jpg'], confidence: 'medium',
    notes: '米数未查到：22 层按照片立面宽高比（面宽约 50 m）与层数估 86 m，玻璃竖带高出 4 m。玻璃竖带所在立面按 cdxdg_06（北望南）判为北立面；另一立面白字位置按档案“另一立面顶部”放南立面。',
  },
};

// ═════════════ 23) EHB 企业总部大厦（赛高城市广场 2 号楼） ═════════════
// 档案 north.json#ehb：160 m / 35 层；照片 cdxdg_03、行政中心站 D 口（Commons）、cdxdg_06：蓝绿玻璃幕墙 + 竖线条；
//   每个立面偏中部一条竖向 LED 媒体带（黄昏为红/粉、蓝白色）；约 1/2 高度与底部各一道浅色横带；顶部一圈玻璃幕墙高出屋面（通透女儿墙），
//   顶部横带上白色“EHB 企业总部大厦”。轮廓：Overture ML 3b75c2fe（约 50×36 m）。
const ehb = {
  id: 'n-ehb', name: 'EHB 企业总部大厦', center: [-145, -8980.5],
  parts: [{
    name: 'tower', pts: rect(-169.9, -120.1, -8998.7, -8962.4), base: 0, top: 152,
    style: { pattern: 'verticalFins', tint: '#2f6f7a', spd: '#6d8f96', floorH: 4.34, colW: 1.5, spandrel: 0.14, mullW: 0.22, lit: 0.4 },
    crown: [{ type: 'lantern', h: 8, color: '#9fd4dc', tint: '#2f6f7a', colW: 1.5 }],
  }],
  bands: [{ part: 'tower', levels: [18, 78], h: 3.2, depth: 0.25, color: '#c9d3d6' }],
  night: {
    media: ['S', 'E', 'N', 'W'].map((f, i) => ({ part: 'tower', face: f, from: 22, to: 148, width: 13, shift: i % 2 ? -7 : -9, pattern: 'media', tint: '#2f6f7a', spd: '#6d8f96' })),
  },
  signs: [{ text: 'EHB 企业总部大厦', part: 'tower', face: ['S', 'E'], y: 156.5, h: 3.4, color: '#ffffff' }],
  supersede: { keys: ['ehb'], names: ['EHB 企业总部大厦', 'EHB企业总部大厦'] },
  meta: {
    dossier: 'north.json#ehb', sources: ['sgehb.com（weiyang/notes.md 引）：160 m，35 层'],
    photos: ['scratchpad/dossier_north/art/cdxdg_03.jpg', 'art/cdxdg_06.jpg', 'photos/Exit_D_of_XINGZHENGZHONGXIN_Station_Xi_an_Metro_Apr_25_2023_.jpg'], confidence: 'medium',
    notes: '屋面 152 m + 玻璃女儿墙 8 m = 160 m；平面沿用 ML 轮廓（原模型 48×46 m 与之同位）。媒体带宽约立面 1/3、偏向转角（照片），用 LED 线条媒体面板（白天为玻璃色，夜间彩色动画）。'
      + '落位：卫星影像（约 2019–2020）在 ML 轮廓处为广场，可能早于建成；照片中 EHB 在熙地港东南角正北、洲际以东，与 ML 位置一致，保留。',
  },
};

// ═════════════ 24/25) 旭辉中心 A/B 座（凤城七路北，档案“推测”对应） ═════════════
// 档案 north.json#xuhuiA/B：23 层（xuhuizhongxin.cn；另说约 20 层）；卫星 z19（sat/n_z_xh.jpg）：两座塔屋面均东移约 40 m（→ ≈100 m），
//   A 座（南，b959f171）屋面约 55×42 m、满铺网格状设备架；B 座（北，6d1ae36e）为西侧两角切角的塔身（约 42×55 m）。
const XH = { pattern: 'curtain', tint: '#44606f', spd: '#6b7680', floorH: 4.2, colW: 1.5, spandrel: 0.28, mullW: 0.12, lit: 0.4 };
const xuhuiA = {
  id: 'n-xuhuiA', name: '旭辉中心A座', fp: 'b959f171',
  parts: [
    { name: 'podium', kind: 'podium', fp: 'b959f171', base: 0, top: 14, style: { pattern: 'retail', tint: '#34424c', spd: '#9aa3aa' } },
    { name: 'tower', pts: rect(-410, -355, -8765, -8723), base: 0, top: 97, style: XH, roof: { mech: false, parapet: 1.2 }, crown: [{ type: 'frame', h: 4, inset: 3, step: 4, post: 0.5, mat: '#8d949a' }] },
  ],
  supersede: { keys: ['xuhuiA'], names: ['旭辉中心A座'] },
  meta: { dossier: 'north.json#xuhuiA', sources: ['xuhuizhongxin.cn（23 层）'], photos: ['scratchpad/dossier_north/sat/n_z_xh.jpg'], confidence: 'low',
    notes: '23 层 × 4.2 m ≈ 97 m（卫星位移 40 m ÷ 0.4 ≈ 100 m 相符）；塔身按屋面尺寸西移 40 m 落位。无外观照片。' },
};
const xuhuiB = {
  id: 'n-xuhuiB', name: '旭辉中心B座', fp: '6d1ae36e',
  parts: [
    { name: 'podium', kind: 'podium', fp: '6d1ae36e', base: 0, top: 14, style: { pattern: 'retail', tint: '#34424c', spd: '#9aa3aa' } },
    { name: 'tower', shape: 'chamfer', size: [55, 42], rot: 90, at: [-361, -8824.5], shapeOpt: { c: 7 }, base: 0, top: 97, style: XH, roof: { mech: false, parapet: 1.2 }, crown: [{ type: 'frame', h: 4, inset: 3, step: 4, post: 0.5, mat: '#8d949a' }] },
  ],
  supersede: { keys: ['xuhuiB'], names: ['旭辉中心B座'] },
  meta: { dossier: 'north.json#xuhuiB', sources: ['xuhuizhongxin.cn（23 层）'], photos: ['scratchpad/dossier_north/sat/n_z_xh.jpg'], confidence: 'low',
    notes: '同 A 座；塔身切角按卫星屋面轮廓。' },
};

// ═════════════ 26) 智选假日酒店（西安经开店，熙地港西南角） ═════════════
// 档案 north.json#zhixuan：OSM w969670628（南北 35×东西 20 m）；照片 cdxdg_03：浅灰白墙面 + 规整方窗，熙地港屋面以上可数约 23 排窗，
//   顶部女儿墙外侧绿色 Holiday Inn Express 标志 + 白字。南立面与熙地港南立面齐平 → 被遮挡部分约为商场高度 34 m。
const zhixuan = {
  id: 'n-zhixuan', name: '智选假日酒店（西安经开店）', fp: 'b65b4041',
  parts: [{ name: 'tower', fp: 'b65b4041', base: 0, top: 100, style: { pattern: 'stoneWindows', spd: '#dfe1e2', tint: '#3a4550', floorH: 3.2, colW: 2.9, spandrel: 0.36, mullW: 1.3, lit: 0.6 },
    roof: { mech: false }, crown: [{ type: 'parapet', h: 3.2, mat: '#26364a' }] }],
  signs: [{ text: 'Holiday Inn Express', part: 'tower', face: 'E', y: 101.6, h: 2.4, color: '#6cc04a' }],
  supersede: { keys: ['zhixuan'], names: ['智选假日酒店（经开店）', '智选假日酒店（西安经开店）'] },
  meta: { dossier: 'north.json#zhixuan', sources: ['OSM w969670628', '256 间客房（WebSearch 摘要）'], photos: ['scratchpad/dossier_north/art/cdxdg_03.jpg'], confidence: 'low',
    notes: '总层数未查到：熙地港屋面以上数得约 23 排窗 × 3.2 m ≈ 74 m + 下部 34 m → 约 100–108 m，取 100 m（原模型 56 m 明显偏低）。可能为办公 + 酒店合用塔楼。' },
};

// ═════════════ 27) 西北国金中心（NIFC）主塔 + 办公板楼 ═════════════
// 档案 north.json#nifc（low）：三期主塔 210 m / 50 层（另说 205 m），JW 万豪 25–37 层、38 层空中大堂；与汉神购物广场连为一体；
//   卫星：八角形屋顶平台 + 中央 H 停机坪，屋面在 (−922,−8718)；效果图：主塔顶部双弧“角”形收顶；办公板楼蓝玻璃 + 白竖鳍，顶部“NIFC 西北国金中心”。
// 塔基：该幅影像楼身向东南倾（汉神屋面相对轮廓亦东南移），西北侧立面可见；按 0.45 m/m × 200 m 沿东南方向回推 → 塔基中心约 (−985,−8781)，±25 m。
// 办公板楼：卫星（sat/n_nifcN.jpg）汉神以北三块东西向板楼屋面（约 60×26 m），西移约 30–35 m 落位；高度按资料“一期约 90 m/25 层、二期约 110 m/35 层”分配（对应关系未确认）。
const NF = { pattern: 'horizontalBands', tint: '#6d8ea8', spd: '#c9d3dc', floorH: 4.1, colW: 1.6, spandrel: 0.18, mullW: 0.08, lit: 0.45 };
const NS = { pattern: 'verticalFins', tint: '#3c6e9e', spd: '#eef1f3', floorH: 3.6, colW: 1.8, spandrel: 0.12, mullW: 0.45, lit: 0.45 };
const nifc = {
  id: 'n-nifc', name: '西北国金中心', center: [-985, -8781],
  parts: [
    { name: 'tower', shape: 'round', size: [50, 40], at: [-985, -8781], shapeOpt: { r: 7 }, base: 0, top: 196, style: NF, roof: { mech: false, parapet: 1.0 },
      crown: [{ type: 'helipad', r: 12, lift: 1.5 }] },
    // 顶部双弧“角”：东西两端各一片收分的玻璃翼（效果图）
    { name: 'hornW', shape: 'rect', size: [10, 36], at: [-1004, -8781], base: 196, top: 210, taper: 0.35, style: { ...NF, pattern: 'crownGlass', spd: '#dfe9ff' }, roof: { mech: false, parapet: 0.4 } },
    { name: 'hornE', shape: 'rect', size: [10, 36], at: [-966, -8781], base: 196, top: 210, taper: 0.35, style: { ...NF, pattern: 'crownGlass', spd: '#dfe9ff' }, roof: { mech: false, parapet: 0.4 } },
    { name: 'slab1', pts: rect(-975, -913, -9036, -9009), base: 0, top: 110, style: NS },
    { name: 'slab2', pts: rect(-968, -906, -8953, -8925), base: 0, top: 90, style: NS },
    { name: 'slab3', pts: rect(-962, -900, -8871, -8845), base: 0, top: 90, style: NS },
  ],
  signs: [{ text: 'NIFC 西北国金中心', part: 'slab2', face: 'S', y: 86, h: 3.2, color: '#c0c6cc' }],
  supersede: { names: ['西北国金中心A座', '西北国金中心', '西北国金中心主塔'] },
  meta: {
    dossier: 'north.json#nifc', sources: ['http://xianbld.com/index.php?m=Product&a=show&id=48', 'WebSearch 摘要（三期 210 m/50 层；一期 90 m/25 层；二期 110 m/35 层）', 'justxa“210米进度贴”'],
    photos: ['scratchpad/dossier_north/art/nifc_565c06a5e1ca2.jpg（效果图）', 'art/nifc2_01.jpg（办公板楼实景）', 'sat/nifc_zoom.jpg', 'sat/n_nifc.jpg', 'sat/n_nifcN.jpg'],
    confidence: 'low',
    notes: '原 landmarks2026 把“西北国金中心A座”放在 (−1024,−8973) 的住宅小区内，改到卫星停机坪塔顶回推的塔基。主塔平面 50×40 m 按效果图宽高比；顶部“角”形收顶按效果图（建成照未见）。'
      + '三块板楼的高度与一/二期对应关系未确认；“NIFC 西北国金中心”字所在立面按实景照为长立面顶部。',
  },
};

// ═════════════ 28) 汉神购物广场（文景店，凤城八路 168 号） ═════════════
// 档案 north.json#hanshen：OSM w1418071114；设计院照片：白/银铝板方盒 + 水平红色细线（夜间红光），入口红色竖向 logo 带与橙红格纹面板，“汉神购物广场”。
const hanshen = {
  id: 'n-hanshen', name: '汉神购物广场（文景店）', fp: '53291cb1',
  parts: [
    { name: 'mall', kind: 'podium', fp: '53291cb1', base: 0, top: 30, style: { pattern: 'stoneWindows', spd: '#dfe2e4', tint: '#5d7a94', floorH: 6, colW: 8, spandrel: 0.72, mullW: 1.2, lit: 0.8 }, roofMat: { color: '#8a8d90', roughness: 0.85 } },
    { name: 'logo', kind: 'solid', mat: { color: '#c8161d', roughness: 0.5, glow: '#ff2a2a', glowNight: 1.6 }, shape: 'rect', size: [9, 1.2], at: [-955, -8721.2], base: 6, top: 29 },
  ],
  bands: [{ part: 'mall', levels: [12.2, 24.2], h: 0.45, depth: 0.2, color: '#b8161d', glow: '#ff2020', strength: 2.4 }],
  signs: [{ text: '汉神购物广场', part: 'mall', face: 'S', y: 21, h: 2.6, color: '#c8161d' }],
  supersede: { names: ['汉神购物广场(文景店)', '汉神购物广场（文景店）', '汉神购物广场'] },
  meta: { dossier: 'north.json#hanshen', sources: ['OSM w1418071114', 'http://xianbld.com/index.php?m=Product&a=show&id=48', '凤凰网 2014-12-18'], photos: ['scratchpad/dossier_north/art/nifc_565c06b144915.jpg', 'nifc_565c0708c771b.jpg（夜景）'], confidence: 'medium',
    notes: '高度未查到：照片约 5 层（首层大玻璃 + 4 层铝板实墙）× 6 m ≈ 30 m。红色竖带与字的立面按照片（正对凤城八路一侧）放南立面，东西位置为推断。' },
};

// ═════════════ 29) 西安地铁大厦（凤城八路 126 号地铁控制大厦） ═════════════
// 档案 north.json#metro_bldg：OSM w1372139871（85×73 m 回字形）；照片 cdxdg_06：白色石材通高竖向壁柱 + 深色竖条窗，深灰缓坡四坡大屋顶深出檐；
// 卫星 z19（sat/n_z_mt.jpg）：屋面为盝顶（四坡围合中央方形浅蓝玻璃采光顶），相对 OSM 东移约 20–24 m → 约 50–60 m；照片与洲际（22 层）比例约 45 m → 取檐口 50 m。
const metroBldg = {
  id: 'n-metro-bldg', name: '西安地铁大厦', fp: '409c07dd',
  parts: [{
    name: 'main', kind: 'podium', fp: '409c07dd', base: 0, top: 50,
    style: { pattern: 'verticalFins', tint: '#3b4d5e', spd: '#e4e4e0', floorH: 4.2, colW: 2.6, spandrel: 0.06, mullW: 1.3, lit: 0.45 },
    crown: [hip(-308.5, -223.6, -9019.3, -8946.1, { over: 4.5, h: 10, eave: 1.6, flat: 0.42, mat: { color: '#4d5257', metalness: 0.5, roughness: 0.45 } }),
      { type: 'arch', at: [-266, -8982.7], size: [44, 36], rot: 0, h: 1.6, y: 55.8, mat: { color: '#7fa6bd', metalness: 0.5, roughness: 0.15 } }],
  }],
  supersede: { names: ['西安地铁大厦', '西安地铁控制大厦'] },
  meta: { dossier: 'north.json#metro_bldg', sources: ['OSM w1372139871', 'city8（凤城八路126号地铁控制大厦）'], photos: ['scratchpad/dossier_north/art/cdxdg_06.jpg', 'sat/n_z_mt.jpg'], confidence: 'low',
    notes: '高度无出处：卫星位移与照片比例两种估法 45–60 m，取 50 m（约 12 层）。竖条窗无法数层。' },
};

// ═════════════ 30) 保亿隆基中心（凤城八路 136 号） ═════════════
// 档案 north.json#baoyi：地上 13 层（1–2 商业、3–12 办公、13 设备层）；OSM r18903163 回字形（带内院）。
const baoyi = {
  id: 'n-baoyi', name: '保亿隆基中心', fp: '3a056439',
  parts: [{ name: 'main', kind: 'podium', fp: '3a056439', holes: 'fp', base: 0, top: 52, style: { pattern: 'grid', tint: '#3d5467', spd: '#8d969d', floorH: 3.9, colW: 1.7, spandrel: 0.3, lit: 0.45 }, roofMat: { color: '#7b7e80', roughness: 0.85 } }],
  bands: [{ part: 'main', levels: [0.2], h: 9.6, depth: 0.1, color: '#2d363d' }], // 1–2 层商业深色玻璃基座
  supersede: { names: ['保亿隆基中心'] },
  meta: { dossier: 'north.json#baoyi', sources: ['百度百科（weiyang/notes.md 引）：地上13层'], photos: ['scratchpad/dossier_north/sat/baoyi.jpg'], confidence: 'medium（层数）；low（立面）',
    notes: '2 层商业 × 5 m + 10 层办公 × 3.9 m + 设备层 3 m ≈ 52 m。无外观照片。' },
};

// ═════════════ 31) 西安市体育馆（城市运动公园体育馆，未央路 168 号） ═════════════
// 档案 north.json#gym：1999 年竣工、7597 座；WebSearch（本地宝/百科）：馆高 34 米；OSM w1372139804 切角正方形（八边形，约 102×102 m，边与正南北成 45°）；
//   卫星 + 航拍：浅蓝灰色四坡锥形屋面，四周一圈外露白色空间桁架/拱架高出屋檐；2019 年内部改造“外观不改动”。
const gym = {
  id: 'n-gym', name: '西安市体育馆', fp: '83b7b97c',
  parts: [{ name: 'hall', fp: '83b7b97c', base: 0, top: 18, style: { pattern: 'grid', tint: '#4e6576', spd: '#ecebe6', floorH: 6, colW: 4.5, spandrel: 0.5, mullW: 0.6, lit: 0.6 },
    roof: { mech: false, parapet: 0.5 },
    crown: [{ type: 'pyramid', h: 16, inset: -1.5, mat: { color: '#9fb3c2', metalness: 0.4, roughness: 0.4 } }, { type: 'frame', y: 18, h: 6, inset: -3.5, step: 6, post: 0.9, mat: '#f0f0f0' }] }],
  supersede: { names: ['西安城市运动公园体育馆（西安市体育馆）', '西安市体育馆', '西安城市运动公园体育馆'] },
  meta: { dossier: 'north.json#gym；public.json#西安城市运动公园体育馆', sources: ['OSM w1372139804', '陕西省体育局 2020-12（7597 座，外观不改动）', 'http://xa.bendibao.com/xiuxian/2016823/62288.shtm / 百度百科（WebSearch 摘要：馆高 34 米，按法国波城体育馆图纸建造）'],
    photos: ['scratchpad/dossier_north/art/gym2_02.jpg', 'sat/gym.jpg'], confidence: 'medium',
    notes: '总高 34 m（本地宝/百科摘要“馆高34米”）：檐口 18 m + 锥顶 16 m；檐口与锥顶的分配、外圈桁架高出檐口 6 m 按航拍比例估。原 landmarks2026 为 34 m 平盒。' },
};

// ═════════════ 32) 西安市第三医院（西北大学附属医院，凤城三路 10 号） ═════════════
// 档案 north.json#third_hosp：东院门诊医技楼 5 层（OSM r18911053，146×138 m）、西院住院楼 13 层（卫星：西侧东西长条高层 OSM w1372721951）；
// 卫星（sat/n_third.jpg）：门诊楼南侧大扇形玻璃采光屋面、中部南北向玻璃采光带；两楼之间架空连廊，连廊上一个圆环形构筑物。
const H3 = { pattern: 'stoneWindows', spd: '#e6e2da', tint: '#34495a', floorH: 4.4, colW: 3.2, spandrel: 0.38, mullW: 1.2, lit: 0.6 };
const GLASS_ROOF = { color: '#7f9fb2', metalness: 0.55, roughness: 0.15 };
const thirdHosp = {
  id: 'n-third-hosp', name: '西安市第三医院', fp: '37c17aee',
  parts: [
    { name: 'opd', kind: 'podium', fp: '37c17aee', base: 0, top: 22, style: H3, roofMat: { color: '#8f918f', roughness: 0.85 },
      crown: [{ type: 'dome', at: [1562, -6823], r: [40, 16], h: 4.5, mat: GLASS_ROOF, ring: false }, { type: 'arch', at: [1562, -6878], size: [86, 20], rot: 90, h: 3, mat: GLASS_ROOF }] },
    { name: 'ward', fp: '1c3e4608', base: 0, top: 50, style: { ...H3, floorH: 3.8 } },
    { name: 'bridge', pts: rect(1452, 1478, -6905, -6895), base: 14, top: 22, style: { pattern: 'curtain', tint: '#4a6272', spd: '#d8d8d4', floorH: 4, lit: 0.7 }, roof: { mech: false, parapet: 0.8 } },
    { name: 'ring', kind: 'podium', shape: 'ring', size: [32, 3], at: [1463.5, -6893.5], base: 14, top: 22, style: { pattern: 'curtain', tint: '#4a6272', spd: '#e6e6e2', floorH: 4, lit: 0.6 } },
  ],
  supersede: { names: ['西安市第三医院', '西安市第三医院（西北大学附属医院）'] },
  meta: { dossier: 'north.json#third_hosp；public.json#西安市第三医院', sources: ['西安市卫健委等（WebSearch 摘要）：门诊医技楼 5 层、住院楼 13 层', 'OSM r18911053 / w1372721951'],
    photos: ['scratchpad/dossier_north/sat/third_hosp.jpg', 'sat/n_third.jpg'], confidence: 'medium（层数）；low（立面）',
    notes: '米数未查到：门诊 5 层 × 4.4 m = 22 m，住院 13 层 × 3.8 m ≈ 50 m；扇形玻璃屋面、采光带、连廊圆环按卫星读图（圆环高度与连廊同，推断）。无外观照片。' },
};

// ═════════════ 33) 首创禧悦里（文景路 × 凤城十二路东北角） ═════════════
const xiyueli = {
  id: 'n-xiyueli', name: '首创禧悦里', fp: '5ee2f30b',
  parts: [{ name: 'mall', kind: 'podium', fp: '5ee2f30b', base: 0, top: 22, style: { pattern: 'retail', tint: '#3a4650', spd: '#c8c2b6', floorH: 5.5, colW: 3.2, spandrel: 0.32, lit: 0.9 }, roofMat: { color: '#838580', roughness: 0.85 } }],
  supersede: { names: ['首创禧悦里'] },
  meta: { dossier: 'north.json#xiyueli', sources: ['赢商网（WebSearch 摘要）：地上4层、地下1层商业', 'OSM w969740652'], photos: ['scratchpad/dossier_north/sat/xiyueli.jpg'], confidence: 'medium',
    notes: '米数未查到：4 层 × 5.5 m = 22 m（与原模型同）。西南角弧形退台广场未建（卫星可见，层次不明）。无外观照片。' },
};

// ═════════════ 34) 富尔顿国际财富中心（文景路 188 号） ═════════════
// 档案 north.json#fulton：25 层、2015-05 竣工、标准层高 3.6 m、1–5 层商业；南北长条裙房 OSM w1418364406 + A/B/C 三座方塔（各约 30×31 m）。
const FUL = { pattern: 'grid', tint: '#3e586b', spd: '#9aa3aa', floorH: 3.6, colW: 1.6, spandrel: 0.3, lit: 0.45 };
const fulton = {
  id: 'n-fulton', name: '富尔顿国际财富中心', fp: 'abf6c9fd',
  parts: [
    { name: 'podium', kind: 'podium', fp: 'abf6c9fd', base: 0, top: 22.5, style: { pattern: 'retail', tint: '#34424c', spd: '#a8a39a', floorH: 4.5 } },
    { name: 'A', fp: 'c397559a', base: 0, top: 94.5, style: FUL },
    { name: 'B', fp: '08734a9d', base: 0, top: 94.5, style: FUL },
    { name: 'C', fp: '82f820b6', base: 0, top: 94.5, style: FUL },
  ],
  supersede: { names: ['富尔顿国际财富中心'] },
  meta: { dossier: 'north.json#fulton', sources: ['fedgjzx.cn（25 层、标准层高 3.6 m）', 'OSM w1418364406 / w969755622–4'], photos: ['scratchpad/dossier_north/sat/fulton.jpg'], confidence: 'medium',
    notes: '5 层商业 × 4.5 m + 20 层办公 × 3.6 m = 94.5 m。无外观照片，幕墙颜色为推断。' },
};

// ═════════════ 35) 西安经济技术开发区管委会（OSM 标注楼） ═════════════
// 档案 north.json#jkq_gwh（low）：OSM w1418364353 南北向板楼（88×36 m）；卫星 z19（sat/n_z_jkq.jpg）：西立面可见约 30 m 宽（楼身东倾）→ 30 ÷ 0.38 ≈ 80 m。
const jkqGwh = {
  id: 'n-jkq-gwh', name: '西安经济技术开发区管委会', fp: '17227471',
  parts: [{ name: 'slab', fp: '17227471', base: 0, top: 78, style: { pattern: 'stoneWindows', spd: '#d8d6d0', tint: '#33475a', floorH: 3.9, colW: 2.4, spandrel: 0.36, mullW: 1.0, lit: 0.45 }, roof: { mech: true, parapet: 1.6 } }],
  supersede: { names: ['西安经济技术开发区管委会'] },
  meta: { dossier: 'north.json#jkq_gwh', sources: ['OSM w1418364353'], photos: ['scratchpad/dossier_north/sat/n_z_jkq.jpg'], confidence: 'low',
    notes: '高度无出处，按卫星位移估约 78–80 m（±15%）。是否即管委会办公楼未核实（注册地址凤城九路 66 号，办公地址明光路 166 号）。' },
};

// ═════════════ 36) 西安北站（2011 年启用） ═════════════
// 档案 north.json#beizhan（high）+ public.json：站房总高 43.6 m、建筑面积 17.1 万㎡；OSM w250712078 外包 531×454 m（长轴约 −73°）。
// 照片（bz_north_01、Xi_an_North_Railway_Station、cn_0fe664bd）：深灰金属大四坡顶 + 白色宽大挑檐，檐下白色树状钢柱、玻璃幕墙、米色石材基座（横向分缝 + 小窗），
//   红色“西安北站”立于南/北檐口上方屋面；卫星（sat/beizhan.jpg）：主屋顶屋脊一列 11 个梭形天窗（白色梭形 + 中间玻璃带），两侧成排站台雨棚。
// 原 SPECIAL.north（平屋面 + 12 个菱形采光顶）形体大体正确但屋面为平板、天窗数不对 → 替代。站房中心、宽 192 m、长 533 m 沿用其卫星量取值。
const BZ = { cx: -780, cz: -13011, rot: -73.2 }; // 长轴地图方位（北偏西约 17°）
const bzU = [Math.cos(16.8 * Math.PI / 180), -Math.sin(16.8 * Math.PI / 180)]; // 短轴 u（世界 dx,dz）
const bzV = [Math.cos(106.8 * Math.PI / 180), -Math.sin(106.8 * Math.PI / 180)]; // 长轴 v（北端方向）
const bzAt = (u, v) => [BZ.cx + u * bzU[0] + v * bzV[0], BZ.cz + u * bzU[1] + v * bzV[1]];
const bzParts = [
  { name: 'base', shape: 'rect', size: [533, 192], rot: BZ.rot, at: [BZ.cx, BZ.cz], base: 0, top: 12,
    style: { pattern: 'stoneWindows', spd: '#d9c9a6', tint: '#3a4650', floorH: 3.0, colW: 6, spandrel: 0.72, mullW: 4.6, lit: 0.6 }, roof: { mech: false, parapet: 0.3 } },
  { name: 'hall', shape: 'rect', size: [533, 192], rot: BZ.rot, at: [BZ.cx, BZ.cz], base: 12, top: 29,
    style: { pattern: 'retail', tint: '#6e8596', spd: '#e8e8e8', floorH: 17, colW: 4.5, spandrel: 0.06, mullW: 0.3, lit: 0.85 }, roof: NOROOF,
    crown: [
      // 屋面金属度 0.55 → 0.3：天光反射发白（2026-10 审查 g8）
      { type: 'hip', over: 12, eave: 2.6, h: 12, ridge: 400, mat: { color: '#4b5156', metalness: 0.3, roughness: 0.55 }, eaveMat: { color: '#eceeee', roughness: 0.5, metalness: 0.2 }, soffit: '#f2f2f0', glow: '#ffe6b8', glowBase: '#eceeee' },
      // 屋脊 11 个梭形天窗（卫星：约 47 m 间距，横跨屋脊约 120 m 长、34 m 宽）：原为白色椭球（凸出屋面 9.5 m，从低处看连成一条白色大穹顶），
      // 改为贴两坡屋面铺的梭形玻璃带（白框 + 中间玻璃，最多高出屋面约 1.5 m）；屋脊离地 43.6 m、坡度 12 m / 108 m
      ...Array.from({ length: 11 }, (_, k) => ({ type: 'ridgeLens', at: bzAt(0, -235 + k * 47), rot: 16.8, L: 120, W: 34, ridgeY: 43.6, fall: 12 / 108, bulge: 1.2 })),
    ] },
];
// 檐下树状钢柱（照片：沿南北立面一排白色 Y 形柱，这里用直柱 + 斜撑近似为白色细柱）
for (const s of [-1, 1]) for (let k = 0; k < 9; k++) {
  const [x, z] = bzAt((k - 4) * 21, s * (266.5 + 8));
  bzParts.push({ name: `col${s}${k}`, kind: 'solid', mat: { color: '#f0f0ee', roughness: 0.5 }, shape: 'rect', size: [1.6, 1.6], at: [x, z], base: 0, top: 31.5 });
}
// 两侧站台雨棚（高约 14 m，11 跨，每跨一道筒拱玻璃采光带）+ 支柱
for (const s of [-1, 1]) {
  const [x, z] = bzAt(s * 169, 0);
  // footprint：雨棚下是站台与股道，通用建筑（CMAB 把雨棚识别成的“楼”）与树木要让位
  bzParts.push({ name: 'canopy' + (s > 0 ? 'E' : 'W'), kind: 'solid', mat: { color: '#dcdedf', roughness: 0.6, metalness: 0.2 }, shape: 'rect', size: [493, 128], rot: BZ.rot, at: [x, z], base: 13, top: 14.4, footprint: true,
    crown: Array.from({ length: 11 }, (_, k) => ({ type: 'arch', at: bzAt(s * 169, -493 / 2 + (k + 0.5) * (493 / 11)), size: [120, 22], rot: 16.8, h: 2.2, mat: { color: '#9fb4c2', metalness: 0.55, roughness: 0.15 } })) });
  for (let k = 0; k < 11; k++) for (const du of [-42, 0, 42]) {
    const [cx, cz] = bzAt(s * 169 + du, -493 / 2 + (k + 0.5) * (493 / 11));
    bzParts.push({ name: `cp${s}${k}${du}`, kind: 'solid', mat: { color: '#b9bdc0', roughness: 0.5, metalness: 0.4 }, shape: 'rect', size: [1.2, 1.2], at: [cx, cz], base: 0, top: 13 });
  }
}
const beizhan = {
  id: 'n-beizhan', name: '西安北站', center: [BZ.cx, BZ.cz], flatten: true,
  parts: bzParts,
  signs: [
    // 照片 beizhan_south.jpg：四个巨大的红色“西安北站”立在南/北屋面坡上（原 8 m 字高远看只是挑檐上一行小字）→ 字高 13 m，字底落在檐口屋面上
    { text: '西安北站', part: 'hall', face: 106.8, out: 9, y: 38.8, h: 13, color: '#d8322f', serif: true, weight: 900 },
    { text: '西安北站', part: 'hall', face: -73.2, out: 9, y: 38.8, h: 13, color: '#d8322f', serif: true, weight: 900 },
  ],
  supersede: { keys: ['north'], names: ['西安北站'] },
  label: { priority: 2 },
  meta: {
    dossier: 'north.json#beizhan；public.json#西安北站', sources: ['https://zh.wikipedia.org/wiki/西安北站', '站房总高 43.6 m（public.json 引中国铁路/百度百科摘要）', 'OSM w250712078'],
    photos: ['scratchpad/dossier_north/photos/bz_north_01.jpg', 'photos/Xi_an_North_Railway_Station.jpg', 'sat/beizhan.jpg'], confidence: 'high（形体/总高）；medium（分段）',
    notes: '分段：石材基座 12 m、玻璃大厅至檐下 29 m、白色挑檐（出檐 12 m、厚 2.6 m）、深灰四坡顶坡高 12 m → 屋脊约 43.6 m；梭形天窗 11 个（原模型 12 个）按卫星。'
      + '树状柱简化为直柱（Y 形分叉未建）。雨棚 14 m 与支柱按原模型卫星量取值。',
  },
};

// ═════════════ 37) 大华·1935（太华南路，原长安大华纺织厂） ═════════════
// 档案 north.json#dahua1935：保留老厂房，成排锯齿形采光窗屋顶（灰蓝色屋面板），部分红褐色坡屋面；卫星（sat/n_dahua.jpg）：
//   锯齿脊线沿厂房长轴（东西向、偏 −10°）排列，采光面朝北；东侧两栋为红褐色屋面。高度未查到（“多为 1–2 层大跨”）。
const DH_WALL = { pattern: 'stoneWindows', spd: '#b3aca2', tint: '#3a4148', floorH: 4.5, colW: 4.5, spandrel: 0.5, mullW: 2.4, lit: 0.6 };
const dhShed = ({ name, fp, L, W, cx, cz, top, roofColor }) => ({
  name, fp, kind: 'podium', base: 0, top, style: DH_WALL, roofMat: { color: roofColor, roughness: 0.85 },
  crown: [{ type: 'sawtooth', size: [W, L], rot: 80, at: [cx, cz], n: Math.round(W / 7), h: 3.2, face: 'N', mat: { color: roofColor, roughness: 0.8 }, glass: { color: '#6b7f8c', metalness: 0.5, roughness: 0.2, glow: '#ffd9a0' } }],
});
const dahua = {
  id: 'n-dahua1935', name: '大华·1935', fp: '7f1137d1',
  parts: [
    dhShed({ name: 'main', fp: '7f1137d1', L: 124, W: 70, cx: 2450.6, cz: -2776.4, top: 9, roofColor: '#7d8c96' }),
    dhShed({ name: 'north', fp: 'c0cd1143', L: 120, W: 77, cx: 2580.2, cz: -2748.9, top: 9, roofColor: '#7d8c96' }),
    dhShed({ name: 'sw', fp: '08abf0cf', L: 72, W: 60, cx: 2436.0, cz: -2857.2, top: 9, roofColor: '#7d8c96' }),
    dhShed({ name: 'se', fp: 'cbe08676', L: 46, W: 44, cx: 2499.6, cz: -2833.2, top: 8, roofColor: '#9a5a42' }),
    dhShed({ name: 'east', fp: 'b7b9fd03', L: 110, W: 64, cx: 2598.7, cz: -2826.6, top: 8, roofColor: '#9a5a42' }),
  ],
  supersede: { names: ['大华·1935', '大华1935'] },
  meta: { dossier: 'north.json#dahua1935', sources: ['OSM w1265034389 等', 'archina id=5009（ECADI）', 'leju / 163 JRSVSK1D04198EVR'], photos: ['scratchpad/dossier_north/sat/dahua1935.jpg', 'sat/n_dahua.jpg'], confidence: 'medium（形体）；low（高度/墙色）',
    notes: '高度无出处：老纺织厂单层大跨，檐口 8–9 m + 锯齿 3.2 m 为保守估值；锯齿朝向与屋面颜色按卫星；砖墙颜色无照片，外墙用中性灰（不臆造红砖）。' },
};

// ═════════════ 38) 龙湖西安未央天街（徐家湾，2024-12-31 开业） ═════════════
// 档案 north.json#tianjie：单体 1 栋，地上 6 层局部 7 层（腾讯新闻/央广网）；无 OSM 轮廓，卫星量得 106×214 m、西北/西南角大斜切（±5 m）；
//   开业照：灰银色铝板层叠横向百叶带 + 玻璃幕墙；屋面南部六边形玻璃天窗、中部一条窄长采光带；“月光星河”夜晚立面（点状灯光）。
const TJ = { x: 3547.5, z: -9506.8 };
const tianjie = {
  id: 'n-tianjie', name: '龙湖西安未央天街', center: [TJ.x, TJ.z],
  parts: [{
    name: 'mall', kind: 'podium', shape: 'chamfer', size: [214, 106], rot: 90, at: [TJ.x, TJ.z], shapeOpt: { c: 18 }, base: 0, top: 33,
    style: { pattern: 'louver', tint: '#3f4c56', spd: '#a9adb1', floorH: 1.8, colW: 4.0, spandrel: 0.55, mullW: 0.05, lit: 0.8 }, roofMat: { color: '#7c7f82', roughness: 0.85 },
    crown: [{ type: 'dome', at: [TJ.x, TJ.z + 62], r: 16, h: 3.5, mat: GLASS_ROOF, seg: 6, ring: false }, { type: 'arch', at: [TJ.x, TJ.z - 10], size: [110, 8], rot: 90, h: 2.2, mat: GLASS_ROOF }],
  }],
  night: { floodlight: [{ part: 'mall', color: '#cfe0ff', strength: 0.35, from: 6, to: 33 }] },
  supersede: { names: ['龙湖西安未央天街', '未央天街'] },
  meta: { dossier: 'north.json#tianjie', sources: ['https://news.qq.com/rain/a/20241227A0A9B800', 'cnr 2024-12-27', 'winshang news730319'], photos: ['scratchpad/dossier_north/art/tianjie_01.jpg', 'sat/tianjie.jpg'], confidence: 'medium',
    notes: '米数未查到：6 层 × 5.5 m = 33 m（局部 7 层未单列）。轮廓按卫星女儿墙量取，切角 18 m 读图。“月光星河”点状灯光用冷白泛光近似。' },
};

// ═════════════ 39) 三府湾客运站（火车站东侧） ═════════════
// 档案 north.json#sanfuwan（low）：OSM 外包 121×48 m 东西向长条站房，平屋面 + 设备；卫星 z19（sat/n_z_sfw.jpg）：北侧阴影窄、屋面相对墙线几乎无位移 → 低层；
//   东段屋面一道东西向亮脊（疑筒拱）。高度无出处，按 3 层估 12 m（原模型 30 m 无出处，偏高）。
const sanfuwan = {
  id: 'n-sanfuwan', name: '三府湾客运站', fp: 'fed6d868',
  parts: [{ name: 'hall', kind: 'podium', fp: 'fed6d868', base: 0, top: 12, style: { pattern: 'retail', tint: '#3a4a56', spd: '#cfccc4', floorH: 6, lit: 0.8 }, roofMat: { color: '#8c8f90', roughness: 0.85 },
    crown: [{ type: 'arch', at: [2702, -2056], size: [37, 28], rot: 0, h: 3, mat: { color: '#c9ccce', metalness: 0.4, roughness: 0.4 } }] }],
  supersede: { names: ['三府湾客运站'] },
  meta: { dossier: 'north.json#sanfuwan', sources: ['OSM w1265034055 等'], photos: ['scratchpad/dossier_north/sat/sanfuwan.jpg', 'sat/n_z_sfw.jpg'], confidence: 'low', notes: '无照片；高度按卫星阴影/位移判断为低层（±4 m）。' },
};

// ═════════════ 40) 西安市中级人民法院（public.json） ═════════════
// public.json：OSM w1409622325（124×79 m），CMAB 14.2 m；卫星（sat/n_court.jpg）：东西长条主楼 + 北侧圆形大厅（穹顶），屋面相对墙线位移很小（低层）。
const court = {
  id: 'n-court', name: '西安市中级人民法院', fp: '72ae5589',
  parts: [{ name: 'main', fp: '72ae5589', base: 0, top: 16, style: { pattern: 'stoneWindows', spd: '#dcd8ce', tint: '#34424c', floorH: 4.0, colW: 3.0, spandrel: 0.42, mullW: 1.3, lit: 0.4 }, roof: { mech: false, parapet: 1.4 },
    crown: [{ type: 'dome', at: [3687.5, -5782], r: 19, h: 9, mat: { color: '#c9ccce', metalness: 0.35, roughness: 0.4 } }] }],
  supersede: { names: ['西安市中级人民法院'] },
  meta: { dossier: 'public.json#西安市中级人民法院', sources: ['OSM w1409622325', 'CMAB 14.2 m（public.json local_data）'], photos: ['scratchpad/dossier_north/sat/n_court.jpg'], confidence: 'low',
    notes: '无照片。高度：CMAB 14.2 m（该数据集对多层建筑略偏低）取 16 m（4 层）；北侧圆厅穹顶按卫星。北侧四栋高层是否属法院未核实，不纳入。' },
};

// ═════════════ 41) 长安大学渭水校区逸夫图书馆（public.json） ═════════════
// public.json：主体地上 13 层、约 4.5 万㎡（长安大学官网“建筑地标”）；OSM w1091739070（105×60 m，转角约 20°）+ 两侧弧形低层翼楼环抱南侧半圆广场；
//   Commons 照片（2007/2011）：中部通高蓝灰玻璃幕墙 + 两侧浅灰石材实墙框；楼顶红色“长安大学”书法字。
const chdLib = {
  id: 'n-chd-library', name: '长安大学渭水校区逸夫图书馆', fp: '42e588d3',
  parts: [
    { name: 'main', fp: '42e588d3', base: 0, top: 55, style: { pattern: 'stoneWindows', spd: '#c9c7c2', tint: '#3c5874', floorH: 4.2, colW: 3.2, spandrel: 0.36, mullW: 1.4, lit: 0.55 } },
    { name: 'wings', kind: 'podium', fp: 'c2a124db', base: 0, top: 18, style: { pattern: 'stoneWindows', spd: '#c9c7c2', tint: '#3c5874', floorH: 4.5, colW: 3.0, spandrel: 0.4, mullW: 1.2, lit: 0.6 } },
  ],
  night: { media: [{ part: 'main', face: 'S', from: 6, to: 52, width: 34, pattern: 'curtain', tint: '#3c5874', spd: '#9aa0a4', style: { floorH: 4.2, colW: 1.6, spandrel: 0.12, mullW: 0.12, lit: 0.6, mode: 0 } }] },
  signs: [{ text: '长安大学', part: 'main', face: 'S', y: 59, h: 6, color: '#c0282d', serif: true }],
  supersede: { names: ['长安大学渭水校区逸夫图书馆', '长安大学·渭水校区 逸夫图书馆'] },
  meta: { dossier: 'public.json#长安大学渭水校区逸夫图书馆', sources: ['https://www.chd.edu.cn/xxgk/cdyx1/jzdb.htm（主体地上13层）', 'OSM w1091739070 / c2a124db'], photos: ['https://commons.wikimedia.org/wiki/File:ChdUniversityLibrary.jpg（本次限流未下载，按档案文字）'],
    confidence: 'medium',
    notes: '13 层 × 4.2 m ≈ 55 m；中部通高玻璃带用立面嵌板（白天为玻璃幕墙）表示；弧形翼楼高度无出处，按卫星低层估 18 m。楼顶字为档案 signage 的屋顶红色书法字，立在南立面顶上方。' },
};


// ═════════════ 北站南广场西侧：鹏瑞利国际健康商旅城西地块（2017 年封顶后停工，计划 2026 年底复工） ═════════════
// 审查 g8 P0：这里是四栋超高层，通用建筑只建成 6~7 层砖楼（CMAB 高度 12.6~26 m）。
// 资料：新闻（经开区留言回复、网易号、腾讯新闻）只给出“西地块 2017 年封顶、1# 酒店、2#/3# 办公、4# 酒店、5# 商业楼及地下车库，
// 总建面约 36.1 万 m²”，查不到高度与层数。轮廓用 CMAB 四个塔楼底面（buildings.bin #220101~#220104，其中 #220101 原被当成
// 12.6 m 的大块，其实是对角放置的第四栋板楼）。高度按谷歌影像中屋面相对底面的倾倒量（约 60 m）与同期影像中的
// 中登大厦 A 座（100 m，倾倒约 70 m）比对估算，取 95 m（约 26 层），误差可能 ±20 m。裙房范围按影像中塔楼之间的浅色屋面量取。
// 停工多年：幕墙已挂、内部空置，夜间不亮灯。
const PRL_STYLE = { pattern: 'grid', tint: '#1d2a36', spd: '#5f6870', floorH: 3.6, colW: 1.5, spandrel: 0.18, mullW: 0.08, lit: 0.0 };
const pengruili = {
  id: 'n-pengruili', name: '鹏瑞利国际健康商旅城（在建）', center: [-840, -12550],
  parts: [
    { name: 'podium', kind: 'podium', pts: [-915, -12676, -776, -12681, -747, -12548, -752, -12424, -905, -12419, -915, -12548], base: 0, top: 22,
      style: { pattern: 'retail', tint: '#2a3540', spd: '#9a9890', floorH: 5.5, colW: 4, spandrel: 0.35, lit: 0.0 }, roofMat: { color: '#8f8a80', roughness: 0.9 } },
    { name: 'T1', pts: [-822.9, -12514.9, -841.3, -12524.3, -844.9, -12527.0, -846.9, -12534.4, -845.0, -12539.3, -840.8, -12542.8, -834.3, -12542.3, -811.7, -12530.9, -805.0, -12533.1, -793.7, -12555.4, -788.6, -12560.2, -782.7, -12561.3, -777.0, -12558.6, -773.8, -12554.8, -774.6, -12547.3, -787.4, -12519.4, -778.8, -12494.3, -777.9, -12487.7, -779.4, -12480.8, -784.1, -12474.9, -790.4, -12471.0, -798.9, -12470.7, -807.1, -12474.0, -811.5, -12479.7],
      base: 0, top: 95, style: PRL_STYLE, roof: { mech: true, parapet: 1.5 } },
    { name: 'T2', pts: [-877.2, -12451.4, -895.3, -12511.1, -895.8, -12514.8, -894.1, -12517.7, -889.5, -12520.9, -885.8, -12521.3, -882.4, -12520.9, -879.6, -12518.8, -878.2, -12516.3, -860.0, -12456.6, -859.9, -12452.9, -861.1, -12449.6, -863.4, -12447.2, -866.3, -12445.9, -869.6, -12445.8, -873.0, -12446.7, -875.5, -12448.4],
      base: 0, top: 95, style: PRL_STYLE, roof: { mech: true, parapet: 1.5 } },
    { name: 'T3', pts: [-904.4, -12545.4, -922.5, -12605.1, -922.9, -12608.8, -921.3, -12611.7, -916.7, -12614.9, -913.0, -12615.3, -909.6, -12614.9, -906.8, -12612.8, -905.4, -12610.3, -887.2, -12550.6, -887.1, -12546.9, -888.3, -12543.6, -890.6, -12541.2, -893.5, -12539.9, -896.8, -12539.8, -900.2, -12540.7, -902.7, -12542.4],
      base: 0, top: 95, style: PRL_STYLE, roof: { mech: true, parapet: 1.5 } },
    { name: 'T4', pts: [-896.2, -12647.6, -842.3, -12664.5, -836.6, -12662.8, -833.4, -12658.6, -833.7, -12653.3, -837.5, -12649.4, -891.4, -12632.5, -896.3, -12633.6, -900.1, -12638.3, -899.9, -12643.8],
      base: 0, top: 95, style: PRL_STYLE, roof: { mech: true, parapet: 1.5 } },
  ],
  label: false,
  meta: {
    dossier: '（无档案条目；审查 g8 P0 补建）',
    sources: ['https://www.163.com/dy/article/L3MMN763055616ZA.html', 'https://news.qq.com/rain/a/20230420A014W200', 'https://news.qq.com/rain/a/20240307A09YN000',
      'CMAB 轮廓（buildings.bin #220101~#220104）', '谷歌卫星 z18（屋面倾倒量）'],
    photos: [], confidence: 'low（高度）；medium（轮廓、栋数）',
    notes: '高度 95 m 为影像倾倒量估算（与同期影像中 100 m 的中登大厦 A 座比对），±20 m；无外观照片，立面按影像中的深色玻璃幕墙推断。裙房 22 m 按常见 4 层商业估。',
  },
};

export default [pengruili, gov, shiwei, tcm, sheraton, yxc, rongmin, lijun, chengbei, tiandi, telecom, zhongdeng, changqing, suligs, igc1, igc2, jinhua, tianlang, weiyangGov,
  wygj, wygjzx, xidigang, darongcheng, ihg, ehb, xuhuiA, xuhuiB, zhixuan, nifc, hanshen, metroBldg, baoyi, gym,
  thirdHosp, xiyueli, fulton, jkqGwh, beizhan, dahua, tianjie, sanfuwan, court];
// 去重：长安大学逸夫图书馆归 public.js（高校类由公共建筑片负责）
