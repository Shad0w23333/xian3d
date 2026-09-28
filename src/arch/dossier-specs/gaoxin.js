// 高新区逐栋档案建模（research/refs/dossiers/gaoxin.json 56 条 + public.json 中落在高新区的条目）。
// 依据：档案条目（高度/层数出处、形体、立面、招牌、夜景）+ 档案照片（scratchpad/dossier_gaoxin/photos/）+ Commons 补充照片
//       + Overture/OSM 实测轮廓（public/data/dossier_fp.json）+ Esri 卫星（屋面按楼身倾斜改正，见各条 meta.notes）。
// 档案为 null 的数值没有编：按照片数层/比例估算、按卫星量取的都在 meta.notes 写明；实在没有依据的楼不建（维持现有模型），
// 在建/停工的按现状建（裸露结构 + 塔吊），不按设计全高。对照差异见 research/refs/dossiers/model_log_gaoxin.md。
// 坐标：世界系 X 东、Z 南（北 = −Z），原点钟楼；轮廓点列 [x0,z0,x1,z1,…]。

const D2R = Math.PI / 180;

/** 旋转矩形（世界坐标）：中心 (cx,cz)、沿 rot 方向长 L、垂直方向宽 W；rot 为地图角度（正东 = 0，逆时针，北 = 90） */
function rectPts(cx, cz, L, W, rot = 0) {
  const c = Math.cos(rot * D2R), s = Math.sin(rot * D2R);
  const T = (u, w) => [cx + u * c - w * s, cz - u * s - w * c];
  return [T(-L / 2, -W / 2), T(L / 2, -W / 2), T(L / 2, W / 2), T(-L / 2, W / 2)].flat();
}

/** 轴向矩形（西 x0、东 x1、北 zN、南 zS）在某一角切角 c 米：corner ∈ 'NW'|'NE'|'SE'|'SW'。
 *  始终返回 5 个点（NW→NE→SE→SW 顺序，切角处拆成两点），便于上下两层轮廓点数一致做放样 */
function cutRect(x0, x1, zN, zS, corner, c) {
  const P = { NW: [x0, zN], NE: [x1, zN], SE: [x1, zS], SW: [x0, zS] };
  const nxt = { NW: 'NE', NE: 'SE', SE: 'SW', SW: 'NW' }, prv = { NW: 'SW', NE: 'NW', SE: 'NE', SW: 'SE' };
  const out = [];
  for (const k of ['NW', 'NE', 'SE', 'SW']) {
    if (k !== corner) { out.push(...P[k]); continue; }
    const [x, z] = P[k], [ax, az] = P[prv[k]], [bx, bz] = P[nxt[k]];
    const la = Math.hypot(ax - x, az - z), lb = Math.hypot(bx - x, bz - z);
    out.push(x + ((ax - x) * c) / la, z + ((az - z) * c) / la, x + ((bx - x) * c) / lb, z + ((bz - z) * c) / lb);
  }
  return out;
}

/** 四角内凹（阴角缺口 d 米）的旋转矩形：12 点 */
function notchRect(cx, cz, L, W, rot, d) {
  const c = Math.cos(rot * D2R), s = Math.sin(rot * D2R);
  const T = (u, w) => [cx + u * c - w * s, cz - u * s - w * c];
  const hl = L / 2, hw = W / 2, out = [];
  const C = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]];
  for (let i = 0; i < 4; i++) {
    // 沿轮廓：角点前 d（来自上一角的边）→ 阴角内点 → 角点后 d（去下一角的边）
    const [cu, cw] = C[i], [pu, pw] = C[(i + 3) % 4], [nu, nw] = C[(i + 1) % 4];
    const lp = Math.hypot(pu - cu, pw - cw), ln = Math.hypot(nu - cu, nw - cw);
    const au = ((pu - cu) * d) / lp, aw = ((pw - cw) * d) / lp, bu = ((nu - cu) * d) / ln, bw = ((nw - cw) * d) / ln;
    out.push(...T(cu + au, cw + aw), ...T(cu + au + bu, cw + aw + bw), ...T(cu + bu, cw + bw));
  }
  return out;
}

/** “D”形（弹头形）平面：东端平直墙（x = xFlat，南北宽 2·hw），向西为半椭圆收到尖端 xTip；seg 段 */
function dShape(xFlat, xTip, zc, hw, seg = 16) {
  const a = xFlat - xTip, out = [xFlat, zc - hw, xFlat, zc + hw];
  for (let i = 1; i < seg; i++) {
    const t = Math.PI / 2 + (i / seg) * Math.PI; // 南端 → 西尖 → 北端
    out.push(xFlat + a * Math.cos(t), zc + hw * Math.sin(t));
  }
  return out;
}

// ═════════════════════════ 锦业路超高层群 ═════════════════════════

// ───── 1. 国瑞·西安金融中心（IFC）350 m ─────
// 轮廓 24e453f7（OSM w550214180）：54.1 × 55.3 m，边向约 −1.3°。照片 ifc_commons_1（2023-09 仰拍）、cm_24（晨雾剪影）、cm_01/cm_25：
// 方塔直上（远景 cm_24 看不出收分，档案“幅度无数据”→ 不收分），转角有竖向内凹；约每 13 层一道深色设备层带（可数 5–6 道）；
// 顶部先一圈内收深色凹槽，其上冠盒外挑（“帽檐”）；冠盒屋面直升机坪（档案：Esri 可见 H）。
const IFC = { cx: -5938.75, cz: 7383.0, L: 54.1, W: 55.3, rot: -1.3 };
const ifc = {
  id: 'ifc',
  name: '国瑞·西安金融中心',
  center: [IFC.cx, IFC.cz],
  parts: [
    {
      name: 'body', pts: notchRect(IFC.cx, IFC.cz, IFC.L, IFC.W, IFC.rot, 1.6), base: 0, top: 334,
      style: { pattern: 'curtain', tint: '#3e4f63', spd: '#2b3440', floorH: 4.45, colW: 1.4, spandrel: 0.16, mullW: 0.1, band: 13, lit: 0.42 },
      roof: { mech: false },
    },
    {
      name: 'groove', // 冠盒下的内收深色凹槽（照片约 1 层高）
      pts: notchRect(IFC.cx, IFC.cz, IFC.L - 3.6, IFC.W - 3.6, IFC.rot, 1.2), base: 334, top: 338.5,
      style: { pattern: 'grid', tint: '#141a20', spd: '#1c2229', floorH: 4.5, colW: 1.4, spandrel: 0.6, mullW: 0.2, lit: 0.05 },
      roof: { mech: false },
    },
    {
      name: 'crownBox', // 外挑冠盒（每边比塔身外挑约 0.6 m），玻璃同塔身
      pts: rectPts(IFC.cx, IFC.cz, IFC.L + 1.2, IFC.W + 1.2, IFC.rot), base: 338.5, top: 350,
      style: { pattern: 'curtain', tint: '#3e4f63', spd: '#2b3440', floorH: 3.8, colW: 1.4, spandrel: 0.1, mullW: 0.12, lit: 0.1 },
      roof: { mech: false, parapet: 1.0 },
      crown: [{ type: 'helipad', r: 15 }],
    },
  ],
  supersede: { keys: ['ifc'], names: ['IFC国瑞·西安金融中心', '国瑞西安国际金融中心', '国瑞·西安金融中心'] },
  meta: {
    dossier: 'gaoxin.json#0 国瑞·西安金融中心',
    sources: ['CTBUH 18932（350 m / 最高使用层 334 m / 75F）', 'zh.wikipedia 国瑞西安金融中心', 'OSM w550214180'],
    photos: ['dossier_gaoxin/photos/ifc_commons_1.jpg', 'cm_24.jpg', 'ssc_ifc_1.jpg', 'cm_01.jpg', 'cm_25.jpg'],
    confidence: 'high（高度/轮廓）；medium（冠盒分段）',
    notes: '塔冠 16 m = 350 − 334（档案）：凹槽 334–338.5、冠盒 338.5–350 按照片比例分；冠盒外挑 0.6 m、凹槽内收 1.8 m 按照片估。'
      + '转角内凹 1.6 m 按照片（ifc_commons_1 左侧转角的锯齿竖线）估；设备层带按档案“每 12–15 层一道”取 13 层。无招牌、无夜景资料。',
  },
};

// ───── 2/3. 西安绿地中心 A/B 座（“丝路之门”双塔）270 m ─────
// 中玻网：塔楼平面西南角（A 座）从 16 层开始切角，随高度逐渐变大，一直到带切面斜角的皇冠顶；单元板块错动（“龙鳞”）。
// 双塔几乎对称：A 座在丈八二路东（切西南角），B 座在路西（航拍 gl_9 切角朝东南，即都朝路口）。
// 顶部切角量：航拍 gl_9 放大（crop_gl9_A/B）两塔屋顶五边形的斜边约占南立面 1/4 → 约 12 m，与 A 座 OSM 轮廓 10×11.5 m 切角一致。
// A 座落位：OSM w986974316 外接矩形（56 × 42.8 m）；B 座：OSM w986974317 东段塔身块（49.7 × 44.3 m，西段为裙房）。
// 夜景：整幅 LED 媒体立面（竖梃/横梁线条灯），三角形切面侧边点杯灯向上照射形成竖向光束（中玻网）。
const GL_TOP = 261, GL_CUT0 = 72, GL_C = 12; // 屋面（冠屏底）、切角起始高度（16 层 × 约 4.5 m）、顶部切角
const glStyle = (seed) => ({ pattern: 'media', tint: '#4f7282', spd: '#9aa9b3', floorH: 4.5, colW: 1.5, spandrel: 0.24, mullW: 0.12, band: 14, lit: 0.34, seed });
function greenland(id, name, x0, x1, zN, zS, corner, seed, extra = {}) {
  return {
    id, name,
    center: [(x0 + x1) / 2, (zN + zS) / 2],
    parts: [
      { name: 'lower', kind: 'facade', pts: cutRect(x0, x1, zN, zS, corner, 0.2), base: 0, top: GL_CUT0, style: glStyle(seed) },
      {
        name: 'body', pts: cutRect(x0, x1, zN, zS, corner, 0.2), topPts: cutRect(x0, x1, zN, zS, corner, GL_C),
        base: GL_CUT0, top: GL_TOP, style: glStyle(seed + 1), roof: { mech: true },
        // 皇冠：沿五边形轮廓一圈约 2 层高的玻璃围屏（航拍：屏内为平屋面 + 设备），夜间冠顶泛光
        crown: [{ type: 'lantern', h: 9, color: '#bfe3ff', tint: '#3f6475', colW: 2.2 }],
      },
      ...(extra.parts || []),
    ],
    signs: extra.signs || [],
    night: {
      // 切面三角形两侧的上照光束（从冠顶两个切角端点向上）
      beams: [{ part: 'body', from: GL_TOP + 9, at: extra.beamAt, len: 160, w: 2.2, color: '#e6f0ff', strength: 0.55 }],
    },
    supersede: extra.supersede,
    meta: extra.meta,
  };
}
// 切角两端点（冠顶处）：A 座西南角、B 座东南角
const GLA = [-6130.3, -6074.3, 7157.8, 7200.6], GLB = [-6251.2, -6201.5, 7185.1, 7229.4];
const glA = greenland('glA', '西安绿地中心A座', ...GLA, 'SW', 21, {
  beamAt: [[GLA[0], GLA[3] - GL_C], [GLA[0] + GL_C, GLA[3]]],
  parts: [
    // 绿地缤纷荟（Overture 6821eb31 / OSM w550214182）：地下 1 层–地上 4 层购物中心
    {
      name: 'podium', kind: 'podium', fp: '6821eb31-4d77-47f5-8aa8-58ab8ce68926', base: 0, top: 22,
      style: { pattern: 'retail', tint: '#3d5260', spd: '#dfe3e6', floorH: 5.5, colW: 3.0, lit: 0.85 },
    },
  ],
  signs: [{ text: '绿地', part: 'body', face: 'S', near: 'E', y: 252, h: 7, color: '#f2c14e' }], // 冠部一角黄色标识（照片）
  supersede: { keys: ['glA'], names: ['绿地中心-A座', '西安绿地中心A座', '绿地缤纷荟'] },
  meta: {
    dossier: 'gaoxin.json#1 西安绿地中心A座',
    sources: ['https://m.glass.com.cn/glassnews/newsinfo_173426.html（切角、龙鳞幕墙、LED 点杯灯）', 'CTBUH 13781', 'OSM w986974316 / w550214182'],
    photos: ['dossier_gaoxin/photos/gl_9.jpg（航拍，双塔切角与屋顶）', 'gl_7.jpg（LED 夜景）', 'ssc_gl_1.jpg', 'ssc_maike_1.jpg（黄色标识）', 'cm_08.jpg'],
    confidence: 'high（高度/切角机制）；medium（顶部切角量、冠屏高度）',
    notes: '270 m 为冠顶；屋面 261 m + 冠部玻璃围屏 9 m（航拍约 2 层）。切角从 72 m（16 层 × 约 4.5 m）的 0.2 m 线性放样到屋面 12 m。'
      + '裙房 22 m 按“地上 4 层”× 约 5.5 m。LED 媒体立面用立面模式 1（竖梃/横梁线条灯动画）；“绿地中心”红字为 LED 屏显示内容，不作实体招牌。',
  },
});
const glB = greenland('glB', '西安绿地中心B座', ...GLB, 'SE', 23, {
  beamAt: [[GLB[1], GLB[3] - GL_C], [GLB[1] - GL_C, GLB[3]]],
  parts: [
    // OSM w986974317 整体轮廓（含西段裙房）；裙房高度无资料，与 A 座裙房同取 22 m
    {
      name: 'podium', kind: 'podium', fp: '06490310', base: 0, top: 22,
      style: { pattern: 'retail', tint: '#3d5260', spd: '#dfe3e6', floorH: 5.5, colW: 3.0, lit: 0.85 },
    },
  ],
  supersede: { keys: ['glB'], names: ['绿地中心-B座', '西安绿地中心B座（天安人寿中心）', '天安人寿中心'] },
  meta: {
    dossier: 'gaoxin.json#2 西安绿地中心B座（天安人寿中心）',
    sources: ['CTBUH 13782', 'OSM w986974317'],
    photos: ['dossier_gaoxin/photos/gl_9.jpg', 'crop_gl9_B（冠顶五边形，切角朝东南）'],
    confidence: 'medium',
    notes: '与 A 座同一设计：切角朝东南（航拍），放样参数同 A 座。塔身取 OSM 轮廓东段 49.7 × 44.3 m（西段为裙房），裙房高度无资料按 A 座 22 m。B 座招牌未查到。',
  },
});

// ───── 4. 中铁西安中心 230 m（塔冠字“新华保险”） ─────
// 轮廓 a4ab7eb6（40.1 × 40.7 m）；照片 crop_zt_top / ssc_ifc_1：四角竖向内凹切角，屋面以上一圈竖向玻璃肋围屏（约 3 层高），
// 西立面（面向拍摄者左侧）冠屏上白色“新华保险”（新华保险购置 21 层）。层高 4.2 m、大堂挑高 12 m（bang.cn）。
const ZT = { cx: -5806.3, cz: 7381.1, L: 40.1, W: 40.7, rot: 0.4 };
const ztzx = {
  id: 'ztzx',
  name: '中铁西安中心',
  center: [ZT.cx, ZT.cz],
  parts: [
    {
      name: 'body', pts: notchRect(ZT.cx, ZT.cz, ZT.L, ZT.W, ZT.rot, 1.8), base: 0, top: 216,
      style: { pattern: 'curtain', tint: '#6f8594', spd: '#8c9da9', floorH: 4.2, colW: 1.5, spandrel: 0.18, mullW: 0.1, lit: 0.4 },
      roof: { mech: false }, crown: [{ type: 'helipad', r: 11, lift: 0.6 }],
    },
    {
      name: 'screen', // 冠部竖向玻璃肋围屏（不亮窗）
      kind: 'facade', pts: notchRect(ZT.cx, ZT.cz, ZT.L, ZT.W, ZT.rot, 1.8), base: 216, top: 230,
      style: { pattern: 'verticalFins', tint: '#6b8392', spd: '#b8c6cf', floorH: 14, colW: 1.1, spandrel: 0, mullW: 0.42, lit: 0 },
    },
  ],
  signs: [{ text: '新华保险', part: 'screen', face: 'W', y: 223, h: 5.2, color: '#ffffff' }],
  supersede: { keys: ['ztzx'], names: ['中铁西安中心'] },
  meta: {
    dossier: 'gaoxin.json#3 中铁西安中心',
    sources: ['腾讯 2022 / kbgok / bang.cn（230 m、51F、层高 4.2 m、大堂 12 m）', 'CTBUH 22846（238 m 口径不同）', 'OSM w550214178'],
    photos: ['dossier_gaoxin/photos/crop_zt_top.jpg', 'ssc_ifc_1.jpg', 'cm_01.jpg'],
    confidence: 'high',
    notes: '屋面 216 m（12 + 49 × 4.2 ≈ 218，取 216）、玻璃肋围屏 216–230 m（照片约 3 层）；照片中四角围屏略高，未单独抬高。'
      + '招牌“新华保险”在照片中位于左侧（西）立面冠屏，白字；原模型“中国中铁”无依据。屋面直升机临时起降点（百科）→ 屏内停机坪。',
  },
};

// ───── 5/6. 迈科中心（写字楼 216 m）+ 西安君悦酒店（165 m）+ 100 m 双层连桥 + 古铜斜交网格“门洞” + 裙楼 ─────
// 写字楼 cf5736dc：大圆角，浅灰蓝玻璃 + 竖向细肋，外缘一条银色金属带由顶部下折至连桥；顶部金/橙色“Maike”。
// 酒店 ecd24bf8：圆角板楼（长轴南北），象牙白横竖格构 + 玻璃窗，顶部“GRAND HYATT”，夜间塔顶紫色灯光（ssc_maike_2）。
// 连桥：“在高度 100 米位置由两层空中连桥连接”（腾讯 2022），连桥下为古铜/橙色斜交网格钢桁架门洞（ssc_maike_1/2）。
// 裙楼 6d7d6135（整个综合体轮廓 220 × 106 m）：首层通透玻璃 + 深色柱，上部古铜色竖向金属板（cm_20 言几又/茑屋书店）。
// 两塔斜边相对：写字楼西南斜边与酒店东北斜边之间约 12–15 m，连桥/门洞取两斜边中段围成的四边形（向两塔各伸入 1 m）。
const MK_BRIDGE = [-6081.6, 7419.9, -6090.4, 7397.7, -6101.6, 7420.2, -6092.0, 7432.6];
const maike = {
  id: 'maike',
  name: '迈科中心',
  center: [-6067, 7408],
  parts: [
    {
      name: 'office', fp: 'cf5736dc', roundCorners: 7, base: 0, top: 216,
      style: { pattern: 'verticalFins', tint: '#728083', spd: '#c9ccce', floorH: 4.4, colW: 1.4, spandrel: 0.12, mullW: 0.22, lit: 0.42 },
      roof: { mech: false, parapet: 1.6 },
    },
    {
      name: 'hotel', fp: 'ecd24bf8', roundCorners: 9, base: 0, top: 157,
      style: { pattern: 'horizontalBands', tint: '#3d4750', spd: '#e6e2d6', floorH: 4.3, colW: 2.2, spandrel: 0.36, mullW: 0.3, lit: 0.55 },
      roof: { mech: false },
      crown: [{ type: 'lantern', h: 8, color: '#a45cff', tint: '#4a4f5a', colW: 2.4 }], // 塔顶紫光（157–165 m）
    },
    {
      name: 'bridge', pts: MK_BRIDGE, base: 96, top: 106, // 两层空中连桥（屋顶花园，ssc_maike_3）
      style: { pattern: 'curtain', tint: '#50606a', spd: '#c9ccce', floorH: 5, colW: 1.6, spandrel: 0.14, lit: 0.6 },
      roof: { mech: false }, footprint: false,
    },
    { name: 'portal', kind: 'lattice', pts: MK_BRIDGE, base: 0, top: 96, lattice: { step: 7, rise: 9, w: 0.9, open: [0, 2] }, mat: { color: '#9a5a2e', metalness: 0.6, roughness: 0.45 } },
    { name: 'silverBand', kind: 'solid', shape: 'rect', size: [1.6, 1.4], at: [-6094.6, 7386.5], rot: 20, base: 100, top: 217.5, mat: { color: '#d7dadd', metalness: 0.8, roughness: 0.25 } },
    {
      name: 'podium', kind: 'podium', fp: '6d7d6135-22e9-4d4b-a2bb-d2a059a770a2', base: 0, top: 18,
      style: { pattern: 'verticalFins', tint: '#2b2622', spd: '#a4704a', floorH: 6, colW: 1.2, spandrel: 0.1, mullW: 0.5, lit: 0.7 },
      roofMat: { color: '#7d8a70', roughness: 0.85 },
    },
    {
      name: 'shopfront', kind: 'facade', fp: '6d7d6135-22e9-4d4b-a2bb-d2a059a770a2', grow: 0.15, base: 0, top: 6.5,
      style: { pattern: 'retail', tint: '#2c3238', spd: '#3a3f44', floorH: 6.5, colW: 3.6, spandrel: 0.1, mullW: 0.3, lit: 0.95 },
    },
  ],
  signs: [
    { text: 'Maike', part: 'office', face: ['N', 'E'], y: 208, h: 6.5, color: '#e0a030', serif: false },
    { text: 'GRAND HYATT', part: 'hotel', face: ['E', 'S'], y: 152, h: 3.4, color: '#ffffff', serif: true },
  ],
  bands: [{ part: 'office', levels: [213.5], h: 1.6, depth: 0.4, color: '#d7dadd' }], // 顶部银色金属带
  supersede: { keys: ['mkT'], names: ['迈科中心', '西安君悦酒店', '君悦酒店(迈科中心店)', '西安君悦酒店（迈科中心酒店塔）', '迈科中心（写字楼塔）'] },
  meta: {
    dossier: 'gaoxin.json#4 迈科中心（写字楼塔）、#5 西安君悦酒店（迈科中心酒店塔）',
    sources: ['腾讯 2022（写字楼 216 m、酒店 165 m、100 m 两层连桥）', 'CTBUH 18353 / 30225（215 m / 161 m）', 'OSM w1546339320 / w985455592 / w1221942315'],
    photos: ['dossier_gaoxin/photos/ssc_maike_1.jpg', 'ssc_maike_2.jpg', 'ssc_maike_3.jpg', 'cm_20.jpg', 'cm_03.jpg', 'ifc_commons_1.jpg（Maike 字）'],
    confidence: 'high（高度/构成）；medium（连桥与门洞平面、裙楼高度）',
    notes: '君悦取开发商口径 165 m（OSM 155.35、CTBUH 161；用户要求 161–165），屋面 157 + 紫色灯笼冠 8 m。连桥 96–106 m（“100 m 处两层”）。'
      + '裙楼 18 m 按照片数层（首层约 6.5 m 通高玻璃 + 上部古铜色板约 2 层）。连桥/门洞平面按两塔轮廓斜边围合（推断）；门洞斜交网格按照片间距约 7 m。'
      + '银色金属带按照片放在写字楼西南转角（面向酒店）100 m 以上 + 顶部一圈。原 sky-data 招牌“迈科”“君悦酒店”无依据，改为照片中的“Maike”“GRAND HYATT”。',
  },
};

// ───── 7. 永威·时代中心 212 m ─────
// 轮廓 3f0dc32d（67 × 64 m，含 5 层裙房）；SOM 设计，“外立面三节错开”；照片 cm_27：下段玻璃横线、中段密竖肋且外凸、上段内收，
// 顶部一圈格栅；cm_06：裙房屋顶沿口橙色“永威时代中心”大字。错位尺寸/分段高度无资料 → 按照片比例估。
const YW = '3f0dc32d';
const yongwei = {
  id: 'yongwei',
  name: '永威·时代中心',
  fp: YW,
  parts: [
    {
      name: 'podium', kind: 'podium', fp: YW, base: 0, top: 25,
      style: { pattern: 'retail', tint: '#34424e', spd: '#8e969c', floorH: 5, colW: 3.0, lit: 0.85 },
    },
    {
      name: 'seg1', kind: 'facade', fp: YW, grow: -4, base: 25, top: 80,
      style: { pattern: 'horizontalBands', tint: '#586977', spd: '#a9b3ba', floorH: 4.4, colW: 1.6, spandrel: 0.14, mullW: 0.08, lit: 0.4 },
    },
    {
      name: 'seg2', kind: 'facade', fp: YW, grow: -2.2, base: 80, top: 158,
      style: { pattern: 'verticalFins', tint: '#4b5c69', spd: '#7d8993', floorH: 4.4, colW: 1.1, spandrel: 0.1, mullW: 0.36, lit: 0.4 },
    },
    {
      name: 'seg3', fp: YW, grow: -4.8, base: 158, top: 208,
      style: { pattern: 'curtain', tint: '#586977', spd: '#8a959d', floorH: 4.4, colW: 1.5, spandrel: 0.16, mullW: 0.1, lit: 0.4 },
      roof: { mech: false }, crown: [{ type: 'frame', h: 4, inset: 0.3, step: 2.2, post: 0.35, mat: '#8d949a' }],
    },
  ],
  signs: [{ text: '永威时代中心', part: 'podium', face: 'N', y: 22.5, h: 4.2, color: '#e8741e' }],
  supersede: { keys: ['yongwei'], names: ['永威·时代中心'] },
  meta: {
    dossier: 'gaoxin.json#7 永威·时代中心',
    sources: ['腾讯 2022 / 搜狐 2017（212 m / 47F，1–5 层商业）', 'CTBUH 26563', 'OSM w772926961'],
    photos: ['dossier_gaoxin/photos/cm_06.jpg（裙房橙色大字）', 'cm_27.jpg（三节错位，推断为本楼）'],
    confidence: 'medium（高度/裙房）；low（分段）',
    notes: '塔楼净轮廓无资料：沿用 OSM 轮廓（与原模型相同），裙房 0–25 m（5 层 × 5 m）为全轮廓，塔身内缩 2.2–4.8 m；'
      + '三节分段 25–80 / 80–158 / 158–208 m 与“中段外凸、上段内收”按照片 cm_27 比例估（错位简化为统一内缩差）；顶部 4 m 格栅按照片。',
  },
};

// ───── 8. 天朗·秦商国际中心 1 号楼（217 m）+ 2 号楼“锦里”（100 m） ─────
// 楼书：1 号楼在地块东侧、紧挨丈八一路，2 号楼在西；低区标准层 52.65 × 34.3 m、高区（26–48 层）52.0 × 33.0 m，层高 4 m。
// OSM w1387164542（标“永利 212 m”，87 × 31 m，东西向）恰为 52.65 + 约 34 m：判为 1、2 号楼合轮廓 → 1 号楼取东段，2 号楼取西段。
// 效果图：蓝色玻璃 + 白色竖向肋，竖肋伸出屋面成开敞格栅冠；东立面顶部金色会徽 +“秦商总会”。
const QS_X1 = -5768.5, QS_Z = 7520.75;
const qinshang = {
  id: 'qinshang',
  name: '天朗·秦商国际中心',
  center: [QS_X1 - 26.3, QS_Z],
  parts: [
    {
      name: 'low', pts: rectPts(QS_X1 - 26.325, QS_Z, 52.65, 34.3, 0), base: 0, top: 104,
      style: { pattern: 'verticalFins', tint: '#34506c', spd: '#e8ecef', floorH: 4.0, colW: 1.8, spandrel: 0.12, mullW: 0.3, lit: 0.45 },
      roof: { mech: false },
    },
    {
      name: 'high', pts: rectPts(QS_X1 - 26.325, QS_Z, 52.0, 33.0, 0), base: 104, top: 204,
      style: { pattern: 'verticalFins', tint: '#34506c', spd: '#e8ecef', floorH: 4.0, colW: 1.8, spandrel: 0.12, mullW: 0.3, lit: 0.45 },
      roof: { mech: true }, crown: [{ type: 'frame', h: 13, inset: 0, step: 1.8, post: 0.45, mat: '#e8ecef' }],
    },
    {
      name: 'jinli', pts: rectPts(-5840, QS_Z, 30, 30.6, 0), base: 0, top: 100,
      style: { pattern: 'curtain', tint: '#3a5068', spd: '#c9d2d9', floorH: 3.2, colW: 1.6, spandrel: 0.2, mullW: 0.14, lit: 0.55 },
    },
  ],
  signs: [{ text: '秦商总会', part: 'high', face: 'E', y: 196, h: 5, color: '#c9a24a', serif: true }],
  supersede: { names: ['秦商国际中心（天朗·秦商国际总部大厦）1号楼', '天朗·秦商国际中心 1号楼', '秦商国际中心'] },
  meta: {
    dossier: 'gaoxin.json#8 天朗·秦商国际中心 1号楼',
    sources: ['CTBUH 42878（217 m / 50F）', '高楼迷 tid=3232799（办公 50 层 220 m + 公寓 31 层 100 m）', '楼书 m.focus.cn（标准层平面、层高 4 m、区位图）', 'OSM w1387164542'],
    photos: ['dossier_gaoxin/photos/qs_5.jpg（效果图）', 'qs_7.jpg / qs_1.jpg（平面）', 'qs_6c.jpg（区位图）', 'qq0902_08.jpg（2023-08 施工）'],
    confidence: 'medium',
    notes: '平面按楼书；落位：OSM w1387164542 轮廓（87 × 31 m）东段（东缘 −5768.5），CTBUH 点在其北约 50 m（CTBUH 坐标常有此量级偏差）。'
      + '低/高区分界 104 m（25 层 × 4 m + 首层）、屋面 204 m、格栅冠 204–217 m 按效果图（完工照片未取得）。'
      + '2 号楼“锦里”31 层 100 m（高楼迷首帖），轮廓取 OSM 西段 30 × 30.6 m（推断）。',
  },
};

// ───── 9. 泰信大厦 214 m ─────
// CTBUH 点（锦业一路 6 号，永利西侧）；2023-08 施工照片 qq0902_09：约半高处一圈外挑水平檐口，下段深蓝玻璃 + 浅色竖线，上段略内收；
// 效果图：顶部约两层通高玻璃围合（屋顶花园）。规划口径 199.9 m（屋面）+ 塔冠 → 214 m。
const TX = { cx: -5904, cz: 7654, s: 42 };
const taixin = {
  id: 'taixin',
  name: '泰信大厦',
  center: [TX.cx, TX.cz],
  parts: [
    {
      name: 'lower', kind: 'facade', pts: rectPts(TX.cx, TX.cz, TX.s, TX.s, 0), base: 0, top: 92,
      style: { pattern: 'verticalFins', tint: '#1f3950', spd: '#d8dde0', floorH: 5.4, colW: 1.5, spandrel: 0.08, mullW: 0.3, lit: 0.45 },
    },
    { name: 'ledge', kind: 'solid', pts: rectPts(TX.cx, TX.cz, TX.s + 3, TX.s + 3, 0), base: 92, top: 93.8, mat: { color: '#d8dde0', roughness: 0.5 }, footprint: false },
    {
      name: 'upper', pts: rectPts(TX.cx + 0.8, TX.cz, TX.s - 1.6, TX.s - 1.6, 0), base: 93.8, top: 200,
      style: { pattern: 'verticalFins', tint: '#1f3950', spd: '#c7cfd4', floorH: 5.4, colW: 1.5, spandrel: 0.1, mullW: 0.24, lit: 0.45 },
      roof: { mech: false },
    },
    {
      name: 'crown', kind: 'facade', pts: rectPts(TX.cx + 0.8, TX.cz, TX.s - 1.6, TX.s - 1.6, 0), base: 200, top: 214,
      style: { pattern: 'curtain', tint: '#5d7a90', spd: '#d8dde0', floorH: 7, colW: 3.0, spandrel: 0, mullW: 0.2, lit: 0.2 },
    },
  ],
  supersede: { names: ['泰信大厦'] },
  meta: {
    dossier: 'gaoxin.json#9 泰信大厦',
    sources: ['网易 2023“214 米！泰信大厦喜封金顶”', 'CTBUH 41675（214 m / 37F）', '腾讯 2022/2023（规划 199.9 m）'],
    photos: ['dossier_gaoxin/photos/qq0902_09.jpg（2023-08 施工）', 'ssc_taixin_1.jpg（效果图）'],
    confidence: 'medium（高度/分段）；low（平面）',
    notes: 'Overture 无轮廓：落位取 CTBUH 点（±20 m）；平面 42 × 42 m 按照片 qq0902_09 宽高比估（下段宽约为 200 m 屋面高的 0.21）。'
      + '檐口 92 m（照片约 45% 高度）、上段左侧内收约 1.6 m（照片）；屋面 199.9 → 200 m，顶部玻璃围合 200–214 m（效果图约两层通高）。37 层对应平均层高约 5.4 m。',
  },
};

// ───── 10. 中投国际 A 座（24 层）/ B 座（27 层）+ 1–4 层商业裙楼 ─────
const ztgj = {
  id: 'zhongtou',
  name: '中投国际',
  fp: 'd016a9a7',
  parts: [
    { name: 'podium', kind: 'podium', fp: 'd016a9a7', base: 0, top: 20, style: { pattern: 'retail', tint: '#34424e', spd: '#cfc7b6', floorH: 5, colW: 3.0, lit: 0.8 } },
    { name: 'A', fp: 'a7fcc24b', base: 0, top: 98, style: { pattern: 'stoneWindows', tint: '#34414b', spd: '#d6c8ad', floorH: 3.9, colW: 2.0, spandrel: 0.3, mullW: 0.7, lit: 0.5 } },
    { name: 'B', fp: 'fb56c456', base: 0, top: 110, style: { pattern: 'stoneWindows', tint: '#34414b', spd: '#d6c8ad', floorH: 3.9, colW: 2.0, spandrel: 0.3, mullW: 0.7, lit: 0.5 } },
  ],
  supersede: { names: ['中投国际A座', '中投国际', '中投国际（A座/B座）'] },
  meta: {
    dossier: 'gaoxin.json#10 中投国际（A座/B座）',
    sources: ['搜索摘要（房产站/百度百科）：A 座 24 层、B 座 27 层、1–4 层商业', 'OSM w772926963 / w772926962 / w986974308'],
    photos: [],
    confidence: 'low',
    notes: '高度无资料：按层数 × 约 3.9 m + 首层（A 98 m、B 110 m），裙楼 4 层 × 5 m = 20 m。立面无确认照片，取米色石材 + 窗（cm_25 疑似本楼，未确认，只作参考）。原 landmarks2026“110 m/26F”无出处。',
  },
};

// ───── 11. 西安安达仕酒店（迈科）：停工在约 20 层的钢框架 ─────
const andaz = {
  id: 'andaz',
  name: '西安安达仕酒店（停工）',
  center: [-6634, 7655],
  parts: [
    {
      name: 'frame', pts: rectPts(-6634, 7655, 40, 40, 0), base: 0, top: 84,
      style: { pattern: 'openFrame', floorH: 4.2 }, roof: { mech: false },
      crown: [{ type: 'crane', offset: [24, 10], top: 128, jib: 55, rot: 200 }],
    },
  ],
  label: { text: '安达仕酒店（停工）' },
  supersede: { names: ['西安安达仕酒店（迈科）', '西安安达仕酒店（迈科·在建停工）'] },
  meta: {
    dossier: 'gaoxin.json#11 西安安达仕酒店（迈科·在建停工）',
    sources: ['高楼迷 tid=3137852（设计 224.7 / 247.4 m、50F）', '腾讯 2023（2022-05 主体约 20 层后停滞）'],
    photos: [],
    confidence: 'medium（现状）；low（平面）',
    notes: '按现状建：约 20 层 × 4.2 m = 84 m 裸露钢框架 + 塔吊，不按设计 247.4 m。落位 CTBUH 点，平面 40 × 40 m 按卫星可见结构范围估（±10 m）。2026 年状态未查到。',
  },
};

// ───── 12. 锦业时代 C 区·D5 大道 C1#：核心筒停在地上 6–7 层（查封至 2029） ─────
const d5c1 = {
  id: 'd5c1',
  name: 'D5大道C1#（停工）',
  center: [-6236, 7368],
  parts: [
    { name: 'core', pts: rectPts(-6236, 7368, 36, 32, 0), base: 0, top: 27, style: { pattern: 'openFrame', floorH: 4.2, spd: '#8a6d55', tint: '#1a1715' }, roof: { mech: false } },
  ],
  label: false,
  meta: {
    dossier: 'gaoxin.json#12 锦业时代C区·D5大道 C1#超高层（停工）',
    sources: ['高楼迷 tid=3212660', '腾讯 2023（核心筒钢结构仅到地上 6–7 层且锈蚀）'],
    photos: ['dossier_gaoxin/photos/qq0902_05.jpg（2023-08 停工现场）', 'qq0902_06.jpg'],
    confidence: 'medium（现状）；low（平面）',
    notes: '按现状建 27 m（6–7 层）锈色钢框架，不按设计 240.1 m；落位按卫星可见的锈色钢结构（约 36 × 32 m，CTBUH 点附近）。C2# LOFT（112 m）平面与落位无法确定，未建。',
  },
};

// ───── 13. 西安环贸中心（ICC）写字楼 163.1 m + 西安高新区万豪酒店 86 m ─────
// 规划 149.9 m、最高点 163.1 m（塔冠/停机坪 13.2 m）；顶层停机坪（赢商/澎湃）；照片 icc_6：写字楼方正、蓝玻璃 + 白色竖向细肋，
// 顶部橙色越秀/ICC 标识；酒店宽板楼（竖向浅色肋），楼顶一角红色万豪标识。
const icc = {
  id: 'icc',
  name: '西安环贸中心（ICC）',
  center: [-6975, 7372],
  parts: [
    {
      name: 'office', pts: rectPts(-6975, 7372, 50, 46, 0), base: 0, top: 149.9,
      style: { pattern: 'verticalFins', tint: '#4d7396', spd: '#e6eaee', floorH: 4.2, colW: 1.5, spandrel: 0.1, mullW: 0.22, lit: 0.45 },
      roof: { mech: false },
    },
    {
      name: 'crown', kind: 'facade', pts: rectPts(-6975, 7372, 50, 46, 0), base: 149.9, top: 163.1,
      style: { pattern: 'verticalFins', tint: '#5a7f9f', spd: '#e6eaee', floorH: 13.2, colW: 1.5, spandrel: 0, mullW: 0.3, lit: 0 },
      crown: [{ type: 'helipad', r: 11 }], // 卫星圆形停机坪（半径约 11 m）
    },
    {
      name: 'hotel', pts: rectPts(-6915, 7397, 60, 28, 0), base: 0, top: 86,
      style: { pattern: 'verticalFins', tint: '#3e5566', spd: '#dcd8cf', floorH: 3.8, colW: 1.4, spandrel: 0.2, mullW: 0.36, lit: 0.55 },
    },
  ],
  signs: [
    { text: 'ICC', part: 'crown', face: ['N', 'W'], y: 157, h: 6, color: '#f08a24' },
    { text: '万豪', part: 'hotel', face: 'N', near: 'E', y: 82, h: 3.6, color: '#c8102e' },
  ],
  supersede: { names: ['西安ICC环贸中心 主塔', 'ICC环贸中心写字楼', '西安ICC环贸中心 万豪酒店楼', 'ICC环贸中心酒店', '西安环贸中心（ICC）写字楼', '西安高新区万豪酒店（ICC 酒店楼）'] },
  meta: {
    dossier: 'gaoxin.json#14 西安环贸中心（ICC）写字楼、#15 西安高新区万豪酒店（ICC 酒店楼）',
    sources: ['澎湃 2024 / 赢商 2024-06（163.1 m 写字楼、86 m 酒店、顶层停机坪）', '腾讯 2022 工地公示（规划 149.9 m、最高点 163.1 m）', '观点网 2025-09 开业'],
    photos: ['dossier_gaoxin/photos/icc_6.jpg（开业宣传照）', 'icc_4.jpg（施工航拍）'],
    confidence: 'medium（高度）；low（平面落位）',
    notes: '无 Overture 轮廓：写字楼按卫星（z19）上带圆形停机坪的屋面落位与量取（约 50 × 46 m，±8 m），酒店取其东南约 60 × 28 m 的屋面（±10 m）。'
      + '替代 landmarks2026 中重复的两座 163 m 塔与两座酒店。招牌只写照片可辨的“ICC”（橙）与“万豪”（红）位置，越秀标识图形未建。',
  },
};

// ───── 14. 西港国际大厦（招商银行大厦）218 m ─────
// 轮廓 ae28aa6a（44.9 × 34.6 m，长轴北偏东约 29°）；照片 cm_17 / Commons “Westen Port International”：塔身微收分，
// 四角多级内凹切角，底部约 5 层石材基座 + 竖向长窗，每面中部方格玻璃、转角浅色竖向实体条带，约 1/2 高处一道深色设备层，
// 顶部高出屋面的实墙冠，转角红色招商银行标识。
const XG = { cx: -3880.5, cz: 2167.3, L: 44.9, W: 34.6, rot: 60.8 };
const xigang = {
  id: 'xigang',
  name: '西港国际大厦',
  center: [XG.cx, XG.cz],
  parts: [
    {
      name: 'base', kind: 'solid', shape: 'chamfer', size: [XG.L + 2, XG.W + 2], shapeOpt: { c: 5 }, at: [XG.cx, XG.cz], rot: XG.rot, base: 0, top: 22,
      mat: { color: '#9aa3a6', roughness: 0.75 },
    },
    {
      name: 'body', shape: 'chamfer', size: [XG.L, XG.W], shapeOpt: { c: 5 }, at: [XG.cx, XG.cz], rot: XG.rot, base: 0, top: 205, taper: 0.93,
      style: { pattern: 'grid', tint: '#445169', spd: '#a1aeb2', floorH: 4.3, colW: 1.7, spandrel: 0.34, mullW: 0.5, band: 23, lit: 0.45 },
      roof: { mech: false },
    },
    {
      name: 'crown', kind: 'solid', shape: 'chamfer', size: [XG.L * 0.93 - 1, XG.W * 0.93 - 1], shapeOpt: { c: 4.6 }, at: [XG.cx, XG.cz], rot: XG.rot,
      base: 205, top: 218, mat: { color: '#a1aeb2', roughness: 0.6, metalness: 0.3 },
    },
  ],
  signs: [{ text: '招商银行', part: 'crown', face: ['SW', 'NE'], y: 212, h: 4.2, color: '#c8161d' }],
  supersede: { names: ['西港国际大厦（招商银行大厦）', '招商银行大厦', '西港国际大厦'] },
  meta: {
    dossier: 'gaoxin.json#34 西港国际大厦（招商银行大厦）',
    sources: ['豆瓣转华春监理 / kbgok / bang.cn（218 m、48F）', 'CTBUH 1300', 'OSM w991636994'],
    photos: ['dossier_gaoxin/photos/cm_17.jpg', 'Commons: Westen Port International,xi\'an,CHINA - panoramio.jpg（gx/cm_new_3.jpg）'],
    confidence: 'high（高度/轮廓）；medium（收分量、塔冠）',
    notes: '屋面 205 m + 实墙冠 13 m = 218 m（冠高按照片约 3 层）；收分 0.93 按照片估（仰拍透视，幅度不确定）；'
      + '石材基座 22 m 按照片约 5 层；“多级内凹切角”简化为 5 m 切角；设备层按“约 1/2 高”取每 23 层一道。',
  },
};

// ───── 15. 都市之门（西安高新区管委会）四座弧形板楼 64.2 m ─────
// 四座 OSM 轮廓围成一个大圆环（卫星 sat_dsm），每座为内凹弧形板楼：大面积浅蓝灰玻璃幕墙 + 两端浅米色石材实墙端头（略高出，照片 cm_12/cm_21）；
// A 座石材端头顶部红色“西安高新”标识，各座端墙顶部金色 A/B/C/D 字母。端头体块取各轮廓沿长轴两端 16 m。
const DSM_GLASS = { pattern: 'curtain', tint: '#7d8f96', spd: '#b9c1c3', floorH: 3.2, colW: 1.5, spandrel: 0.24, mullW: 0.14, lit: 0.5 };
const DSM_STONE = { pattern: 'stoneWindows', tint: '#2f3a42', spd: '#c9c0ad', floorH: 3.2, colW: 3.2, spandrel: 0.5, mullW: 2.0, lit: 0.35 };
function dsm(key, fp, ends, letter, signFaces, extraSigns = []) {
  return {
    id: 'dsm' + key,
    name: '都市之门' + key + '座',
    fp,
    parts: [
      { name: 'body', fp, base: 0, top: 64.2, style: DSM_GLASS, roof: { mech: true } },
      { name: 'endLo', pts: ends[0], base: 0, top: 67.5, style: DSM_STONE, roof: { mech: false }, grow: 0.3 },
      { name: 'endHi', pts: ends[1], base: 0, top: 67.5, style: DSM_STONE, roof: { mech: false }, grow: 0.3 },
    ],
    signs: [{ text: letter, part: 'endHi', face: signFaces, y: 64.5, h: 4, color: '#c9a24a' }, ...extraSigns],
    supersede: { names: ['都市之门写字楼-' + key + '座'] },
    meta: {
      dossier: 'gaoxin.json#20 都市之门（西安高新区管委会）',
      sources: ['OSM w1370699186 / w1370699187 / w1370699031 / w1370699032（levels=20）', '网易 2020（2009 年管委会迁入都市之门）'],
      photos: ['dossier_gaoxin/photos/cm_21.jpg', 'cm_12.jpg'],
      confidence: 'medium',
      notes: '64.2 m 为本地 skyline.json 按 20 层推得（非公开资料），沿用；石材端头高出 3.3 m 按照片（“端部石材墙体略高出”）估。'
        + '端头体块 = 轮廓沿最小外接矩形长轴两端各 16 m（卫星上两端为浅色屋面块）。',
    },
  };
}
const dsmA = dsm('A', '656a894d', [
  [-5366.8, 7074.1, -5373.8, 7106.5, -5367.1, 7108.7, -5350.8, 7078.2],
  [-5293.3, 7146.2, -5275.1, 7123.9, -5266.9, 7111.4, -5279.8, 7101.5, -5300.0, 7139.5],
], 'A', 'E', [{ text: '西安高新', part: 'endLo', face: 'W', y: 62.5, h: 3.6, color: '#c8161d' }]);
const dsmB = dsm('B', 'db1a54c8', [
  [-5527.8, 7128.0, -5509.2, 7146.4, -5504.2, 7141.6, -5524.5, 7105.4, -5537.5, 7114.8],
  [-5428.9, 7106.4, -5434.9, 7074.2, -5435.2, 7073.9, -5451.3, 7077.6, -5434.1, 7108.4],
], 'B', 'E');
const dsmC = dsm('C', '7e80bfe8', [
  [-5509.1, 6932.9, -5528.3, 6955.8, -5535.7, 6967.3, -5523.1, 6978.0, -5504.2, 6938.3],
  [-5435.9, 7007.5, -5428.8, 6975.5, -5436.8, 6972.2, -5451.6, 7003.2],
], 'C', 'E');
const dsmD = dsm('D', 'bc7c1566', [
  [-5267.0, 6969.7, -5294.7, 6934.6, -5300.9, 6941.9, -5280.0, 6979.2],
  [-5366.0, 7007.9, -5350.1, 7003.5, -5367.3, 6972.8, -5373.8, 6975.2],
], 'D', 'W');

// ═════════════════════════ 唐延路 ═════════════════════════

// ───── 16. 陕西国际体育之窗：1 号楼 262 m + 南塔 + 4 层围合式裙房 ─────
// 卫星（Esri z19，sat_ty19/ty19w）两座圆角板塔的屋面与西立面（水平白色遮阳百叶）都清楚：楼身明显向东倾（本幅影像约 0.65 m/m）。
// 北塔屋面 (−5055…−5002, 6184…6230)，西立面起点 −5212（+ 裙房高度的倾斜）→ 底座 (−5225…−5172)，与 OSM 裙房轮廓西缘（−5231）吻合，
// CTBUH 1 号楼点 (−5177, 6234) 就在其南缘 → 北塔 = 1 号楼。南塔屋面 (−5125…−5074, 6272…6316)，底座西缘在裙房轮廓西缘 −5189 →
// 倾斜位移约 64 m，按同一倾率换算高约 100 m。第三座塔（3 号楼）在影像上未能辨认，未建。
const ty = {
  id: 'tiyuzhichuang',
  name: '陕西国际体育之窗',
  fp: '2eecb7da',
  parts: [
    {
      name: 'podium', kind: 'podium', fp: '2eecb7da', base: 0, top: 22,
      style: { pattern: 'retail', tint: '#34424e', spd: '#d9dcdc', floorH: 5.5, colW: 3.0, lit: 0.85 },
    },
    {
      name: 'tower1', shape: 'round', size: [53, 46], shapeOpt: { r: 8 }, at: [-5198.5, 6207], base: 0, top: 262,
      style: { pattern: 'horizontalBands', tint: '#2d3d4a', spd: '#d9dcdc', floorH: 4.2, colW: 1.8, spandrel: 0.42, mullW: 0.08, lit: 0.34 },
      roof: { mech: true },
    },
    {
      name: 'tower2', shape: 'round', size: [51, 44], shapeOpt: { r: 8 }, at: [-5164.5, 6294], base: 0, top: 100,
      style: { pattern: 'horizontalBands', tint: '#2d3d4a', spd: '#d9dcdc', floorH: 4.2, colW: 1.8, spandrel: 0.42, mullW: 0.08, lit: 0.45 },
      roof: { mech: true },
    },
  ],
  supersede: { keys: ['ty1', 'ty2'], names: ['陕西国际体育之窗1号楼', '陕西国际体育之窗2号楼', 'DT51(陕西国际体育之窗·NMC中心)', '陕西国际体育之窗', '陕西国际体育之窗-2号楼'] },
  meta: {
    dossier: 'gaoxin.json#21 陕西国际体育之窗 1号楼、#22 DT51',
    sources: ['陕旅集团 / bang.cn（1 号楼 262 m，三栋塔楼 + 四层围合式裙房）', 'CTBUH 41652', 'OSM w985094940', 'Esri World Imagery z19'],
    photos: ['gx/sat_ty19.jpg、sat_ty19w.jpg（卫星：屋面、西立面百叶）'],
    confidence: 'medium（1 号楼）；low（南塔高度）',
    notes: '两塔平面按卫星屋面量取（北 53 × 46、南 51 × 44 m，圆角约 8 m），底座 = 屋面 − 倾斜位移（见上）；南塔约 100 m 为倾斜位移换算（±15 m），'
      + 'landmarks/sky-data 的“2 号楼 188 m”无出处。裙房 22 m 按 4 层 × 5.5 m。立面水平白色遮阳百叶（卫星可见，与原 sky-data 描述一致）。'
      + 'Overture“2号楼”dba3f8ee 落在北塔倾斜立面上，为误描，不用。',
  },
};

// ───── 17. 延长石油科研中心（217.6 m，楼顶“秦农银行”） ─────
// 澎湃/中建西北院：主楼 46 层，建筑高度 195.45 m，塔冠总高 217.60 m，“标准层平面布置呈椭圆形”，东侧近 180 m 瀑布式幕墙。
// 卫星（sat_yc19）塔顶为“弹头”形：西端尖、东端平直（平直端即东侧瀑布幕墙），宽约 50 m、长约 72 m，屋面有 H 停机坪；
// 楼身向东倾约 0.38 m/m（塔顶西尖 −5122 与 OSM 轮廓西端 −5202 相差 80 m）→ 底座 x −5205…−5133。
// Commons “Headquarters of Qinnong Bank & Yanchang Oil, Jan 27 2024”（= 仓库 yanchang.jpg）：同一弹头/椭圆塔身，白色逐层波浪横带，
// 顶边波浪形，塔顶红色“秦农银行”；前方同风格的较低一栋即轮廓东段（卫星东段屋面位移约 25 m → 约 65 m 高）。
const yc = {
  id: 'yanchang',
  name: '延长石油科研中心',
  center: [-5169, 5968],
  parts: [
    {
      name: 'tower', pts: dShape(-5133, -5205, 5968, 25), base: 0, top: 195.45,
      style: { pattern: 'horizontalBands', tint: '#5d7686', spd: '#eceeee', floorH: 4.2, colW: 2.4, spandrel: 0.38, mullW: 0.06, lit: 0.42 },
      roof: { mech: false }, // 屋面 H 停机坪在塔冠围屏内（卫星可见），从外面看不到，不建
    },
    {
      name: 'crown', kind: 'facade', pts: dShape(-5133, -5205, 5968, 25), base: 195.45, top: 217.6,
      style: { pattern: 'horizontalBands', tint: '#6b8494', spd: '#eceeee', floorH: 4.4, colW: 2.4, spandrel: 0.55, mullW: 0.06, lit: 0.05 },
    },
    {
      name: 'east', pts: [-5133, 5941.6, -4967.1, 5939.4, -4966.1, 6001.5, -5133, 6000.2], base: 0, top: 65,
      style: { pattern: 'horizontalBands', tint: '#5d7686', spd: '#eceeee', floorH: 4.2, colW: 2.4, spandrel: 0.38, mullW: 0.06, lit: 0.5 },
    },
  ],
  signs: [{ text: '秦农银行', part: 'crown', face: 'S', near: 'W', y: 209, h: 5.5, color: '#d8404a' }],
  supersede: { keys: ['yc'], names: ['延长石油科研中心'] },
  meta: {
    dossier: 'gaoxin.json#23 延长石油科研中心',
    sources: ['https://www.thepaper.cn/newsDetail_forward_5437062（195.45 / 217.60 m、46F、椭圆平面、瀑布幕墙）', 'CTBUH 18218', 'OSM w969143238', 'Esri World Imagery z19'],
    photos: ['Commons: Headquarters of Qinnong Bank & Yanchang Oil, Jan 27 2024.jpg（gx/cm_new_0.jpg；即 research/refs/skyline/yanchang.jpg）', 'dossier_gaoxin/photos/ssc_yc_1.jpg（NBBJ 效果图）', 'gx/sat_yc19.jpg'],
    confidence: 'high（高度）；medium（平面/落位）；medium（招牌：Commons 标题与形体吻合）',
    notes: '塔身平面按卫星塔顶量取（东端平直 50 m、向西半椭圆长 72 m），底座按倾斜改正；塔冠 195.45–217.6 m 为延续波浪横带的围屏（照片顶边波浪未做起伏）。'
      + '东段按 OSM 轮廓东部，高约 65 m 为卫星位移换算（±15 m），原模型“36 m 裙楼”无出处。招牌由原“延长石油”（无照片）改为照片中的红色“秦农银行”。',
  },
};

// ═════════════════════════ 商场 ═════════════════════════

// ───── 18. 益田假日里购物中心：地上 4 层盒子式购物中心 + 外街；路口古铜色导视立柱 ─────
const yitian = {
  id: 'yitian',
  name: '益田假日里购物中心',
  fp: '1d5901f2',
  parts: [
    {
      name: 'mall', kind: 'podium', fp: '1d5901f2', base: 0, top: 22,
      style: { pattern: 'retail', tint: '#3a4650', spd: '#c9c1b2', floorH: 5.5, colW: 3.2, lit: 0.9 },
    },
    // 路口古铜色立柱导视牌（ifc_commons_1 前景，锦业路与丈八一路路口一侧）：约 12 m 高
    { name: 'pylon', kind: 'solid', shape: 'rect', size: [3.2, 1.2], at: [-5880, 7229], rot: 0, base: 0, top: 12, mat: { color: '#6e4a2e', metalness: 0.5, roughness: 0.5 } },
  ],
  signs: [
    { text: '益田假日里', part: 'pylon', face: 'S', y: 10.2, h: 0.9, fill: 0.9, color: '#ffffff' },
    { text: '益田假日里', part: 'mall', face: 'S', near: 'E', y: 19, h: 3.6, color: '#ffffff' },
  ],
  supersede: { names: ['益田假日里购物中心'] },
  meta: {
    dossier: 'gaoxin.json#18 益田假日里购物中心',
    sources: ['商策网/赢商（地上 4 层、地下 2 层，8.4 万㎡，2019 年底开业）', 'OSM w550214181'],
    photos: ['dossier_gaoxin/photos/ifc_commons_1.jpg（路口导视立柱）'],
    confidence: 'medium（体量）；low（高度）',
    notes: '高度无资料：按地上 4 层 × 约 5.5 m = 22 m。立面无照片（只见导视立柱），取通用商业玻璃立面；立柱位置取轮廓东南角外侧（推断）。',
  },
};

// ───── 19. 立丰城 LE CITY：购物中心 + 2 栋 140 m LOFT（宣传图标注） ─────
// 开业照片 lfc_1：两栋 LOFT 玻璃塔一前一后立在裙楼上，裙楼米灰色石材/金属板 + 玻璃盒体，立面嵌大型 LED 屏，玻璃盒上“立丰城 LE CITY”。
// 宣传鸟瞰图 lfc_8：“140 米超高层 LOFT”、“100 米写字楼”。两栋 LOFT 取轮廓内南北一线的两块 OSM 分体（w985081491 / w985081492），
// 与照片“一前一后”一致；100 m 写字楼的位置未能确定，未建。
const lifeng = {
  id: 'lifengcheng',
  name: '立丰城 LE CITY',
  fp: 'eafbdaae',
  clearance: 0.5,
  parts: [
    {
      name: 'mall', kind: 'podium', fp: 'eafbdaae', base: 0, top: 33,
      style: { pattern: 'stoneWindows', tint: '#2f3c46', spd: '#cfcac0', floorH: 5.5, colW: 4.2, spandrel: 0.5, mullW: 2.2, lit: 0.6 },
    },
    {
      name: 'shopfront', kind: 'facade', fp: 'eafbdaae', grow: 0.15, base: 0, top: 11,
      style: { pattern: 'retail', tint: '#2c3238', spd: '#9aa0a5', floorH: 5.5, colW: 3.6, spandrel: 0.12, mullW: 0.25, lit: 0.95 },
    },
    {
      name: 'loftN', fp: '305250d6-4c9f-47d5-9873-1b31ee45c37d', base: 0, top: 140,
      style: { pattern: 'grid', tint: '#4a74a4', spd: '#dfe6ec', floorH: 3.6, colW: 1.5, spandrel: 0.18, mullW: 0.3, lit: 0.55 },
    },
    {
      name: 'loftS', fp: '139144f7-2700-409a-8efc-dc56bfc703fe', base: 0, top: 140,
      style: { pattern: 'grid', tint: '#4a74a4', spd: '#dfe6ec', floorH: 3.6, colW: 1.5, spandrel: 0.18, mullW: 0.3, lit: 0.55 },
    },
  ],
  signs: [{ text: '立丰城 LE CITY', part: 'mall', face: 'S', near: 'E', y: 28, h: 4.2, color: '#ffffff' }],
  night: { media: [{ part: 'mall', face: 'S', from: 12, to: 30, width: 22, shift: -30 }] },
  supersede: { names: ['立丰城LECITY', '立丰城 LE CITY'] },
  meta: {
    dossier: 'gaoxin.json#43 立丰城 LE CITY',
    sources: ['https://www.sohu.com/a/433242466_210938（2020-11-20 开业，B1–7 层）', '宣传鸟瞰图（140 m LOFT、100 m 写字楼）', 'OSM w1370699089 / w985081491 / w985081492'],
    photos: ['dossier_gaoxin/photos/lfc_1.jpg', 'lfc_3.jpg', 'lfc_8.jpg'],
    confidence: 'medium（商场）；low（塔楼落位）',
    notes: '商场高度无资料：照片约 6 层 + 玻璃盒，按 33 m 估；首层 0–11 m 通透橱窗。LOFT 塔 140 m 按宣传图标注，落位取 OSM 分体（原模型在同位置为 78.7 m 塔块）；'
      + '卫星上这两处也可能是中庭采光顶（未能排除），见 model_log_gaoxin.md。LED 屏位置按照片放在南立面东段。',
  },
};

// ═════════════════════════ 文化 / 会展 ═════════════════════════

// ───── 20. 陕西省图书馆高新馆 ─────
// 卫星（sat_lib）：中央主馆约 100 × 95 m（深灰四坡大屋顶，中央采光天窗），四角附楼（各带四坡顶），两翼竖向石柱廊；南向入口。
// 照片 cm_26：宽大石阶高台；中央 5 开间红褐色密竖格栅 + 正中方形金色徽标，两侧米黄石材实墙，极缓坡唐风庑殿大屋顶、出檐深远，檐下红褐色横带。
const LIB_STONE = { pattern: 'stoneWindows', tint: '#3a3a36', spd: '#d8c8a8', floorH: 4.5, colW: 3.4, spandrel: 0.6, mullW: 2.4, lit: 0.35 };
const LIB_ROOF = { color: '#4f555b', metalness: 0.55, roughness: 0.45 };
const library = {
  id: 'shengtu-gaoxin',
  name: '陕西省图书馆高新馆',
  fp: '56529b11',
  parts: [
    { name: 'platform', kind: 'solid', fp: '56529b11', base: 0, top: 6, mat: { color: '#cdbf9f', roughness: 0.85 } },
    {
      name: 'hall', pts: rectPts(-10385, 5152.5, 100, 95, 0), base: 6, top: 29, style: LIB_STONE, roof: { mech: false, parapet: 0.4 },
      crown: [{ type: 'pyramid', h: 9, inset: -4.5, mat: LIB_ROOF }],
    },
    { name: 'eave', kind: 'solid', pts: rectPts(-10385, 5152.5, 108, 103, 0), base: 26.8, top: 29.0, mat: { color: '#7a3f2a', roughness: 0.7 }, footprint: false },
    { name: 'grille', kind: 'facade', pts: rectPts(-10385, 5200.6, 42, 1.4, 0), base: 6, top: 26.8, style: { pattern: 'verticalFins', tint: '#2a1d17', spd: '#8a4a30', floorH: 20.8, colW: 0.9, spandrel: 0, mullW: 0.42, lit: 0.6 }, footprint: false },
    ...[['nw', -10470, 5128], ['sw', -10470, 5178], ['ne', -10305, 5128], ['se', -10305, 5178]].map(([k, x, z]) => ({
      name: 'wing_' + k, pts: rectPts(x, z, 50, 44, 0), base: 6, top: 23, style: LIB_STONE, roof: { mech: false, parapet: 0.4 },
      crown: [{ type: 'pyramid', h: 4.5, inset: -2.5, mat: LIB_ROOF }],
    })),
  ],
  signs: [{ text: '陕西省图书馆', part: 'platform', face: 'S', y: 3, h: 2.2, color: '#c9a24a', serif: true }],
  supersede: { names: ['陕西省图书馆高新馆', '陕西省图书馆高新馆（新馆）'] },
  meta: {
    dossier: 'gaoxin.json#46 陕西省图书馆高新馆（新馆）；public.json#33',
    sources: ['高楼迷 tid=3301581（2022-04 开放、8.19 万㎡）', 'OSM r17832823', 'Esri World Imagery z18'],
    photos: ['dossier_gaoxin/photos/cm_26.jpg（Commons Shaanxi Library New Building）', 'gx/sat_lib.jpg'],
    confidence: 'medium',
    notes: '高度无资料：按照片比例估（入口处人高 1.7 m ≈ 12 px → 0.14 m/px）：高台约 6 m、主馆檐口约 29 m、两翼约 23 m；主馆四坡顶 9 m（极缓坡）、出檐 4.5 m。'
      + '平面按卫星（主馆 100 × 95 m，四角附楼各约 50 × 44 m）。格栅 5 开间约 42 m 宽。台前卧石“陕西省图书馆”以高台南面字代替。',
  },
};

// ───── 21. 西安高新国际会议中心（23.79 m） ─────
// 前次调研（sxjzy）：23.79 m、方正体量上覆南北向悬挑大屋面；卫星（sat_conf）：浅色大屋面盖满轮廓并向东挑出。
const conf = {
  id: 'gaoxin-conf',
  name: '西安高新国际会议中心',
  fp: '0c722ea0',
  parts: [
    { name: 'hall', fp: '0c722ea0', grow: -3, base: 0, top: 21.8, style: { pattern: 'curtain', tint: '#56646c', spd: '#d8d8d2', floorH: 5.5, colW: 2.4, spandrel: 0.2, lit: 0.5 }, roof: { mech: false } },
    { name: 'roof', kind: 'solid', fp: '0c722ea0', grow: 1.5, base: 21.8, top: 23.79, mat: { color: '#e4e2dc', roughness: 0.6 }, footprint: false },
  ],
  supersede: { names: ['西安高新国际会议中心'] },
  meta: {
    dossier: 'gaoxin.json#47 西安高新国际会议中心',
    sources: ['https://www.sxjzy.org/h-nd-20609.html（23.79 m）', 'OSM w996109766'],
    photos: ['gx/sat_conf.jpg（卫星）'],
    confidence: 'low',
    notes: '23.79 m 为大屋面顶；屋面板 2 m 厚、墙体内缩 3 m 表示悬挑（卫星屋面盖满轮廓）。“南北向上升”的屋面坡度方向未能确认，按平屋面处理。',
  },
};

// ───── 22. 西安大剧院（未来之瞳）：王澍设计，2025-09 开放 ─────
// 卫星（sat_djy / djy18）：大湖（未来之瞳）西岸、湖心圆岛西侧一组放射状长条体量（约 10 条，宽 20–30 m、长 60–190 m），
// 照片 djy_00/02/05：连绵起伏的坡屋面（山体意象），墙面青绿/湖蓝琉璃砖与灰石横向混砌，底部灰色基座。
// 体量按卫星逐条量取（±5 m），坡屋面方向按照片（向湖一侧高、外侧低的斜墙）；高度无资料 → 按照片比例估。
const DJY_WALL = { pattern: 'stoneWindows', tint: '#243038', spd: '#659281', floorH: 3.0, colW: 9, spandrel: 0.85, mullW: 5, lit: 0.15 };
const DJY_BARS = [
  // [西端 x, 西端 z, 东端 x, 东端 z, 宽, 高, 坡降]（Esri z19 sat_djy19 逐条量取，±5 m）
  [-11050, 13465, -10895, 13446, 16, 22, 10],
  [-11090, 13497, -10890, 13484, 22, 28, 14],
  [-11080, 13520, -10890, 13516, 18, 26, 12],
  [-11090, 13549, -10938, 13547, 20, 24, 12],
  [-11080, 13580, -10865, 13576, 18, 26, 12],
  [-11055, 13604, -10905, 13600, 18, 22, 10],
  [-11065, 13622, -10880, 13617, 18, 24, 12],
  [-11050, 13648, -10960, 13640, 18, 18, 8],
];
const djy = {
  id: 'xian-grand-theatre',
  name: '西安大剧院',
  center: [-10990, 13550],
  parts: DJY_BARS.map(([xa, za, xb, zb, w, h], i) => {
    const L = Math.hypot(xb - xa, zb - za), rot = -Math.atan2(zb - za, xb - xa) / D2R;
    return {
      name: 'bar' + i, pts: rectPts((xa + xb) / 2, (za + zb) / 2, L, w, rot), base: 0, top: h,
      style: { ...DJY_WALL, seed: 70 + i }, roof: { mech: false },
      crown: [{ type: 'slope', dir: 'E', drop: DJY_BARS[i][6] }],
    };
  }),
  signs: [{ text: '西安大剧院', part: 'bar2', face: 'W', y: 6, h: 3, color: '#e8e4d8', serif: true }],
  flatten: false,
  supersede: { names: ['西安大剧院（高新·未来之瞳）', '西安大剧院（未来之瞳）'] },
  meta: {
    dossier: 'gaoxin.json#49 西安大剧院（未来之瞳）',
    sources: ['腾讯 2024-12 / 陕西日报 2025-09（王澍设计，19.4 万㎡，2025-09-27 开放）', 'Esri World Imagery z17/z18（sat_djy、sat_djy18）'],
    photos: ['dossier_gaoxin/photos/djy_00.jpg', 'djy_02.jpg', 'djy_05.jpg', 'djy_08.jpg'],
    confidence: 'medium（布局）；low（高度）',
    notes: '无 OSM 轮廓：8 条主要体量按卫星逐条量取（±5 m），湖心圆岛与湖面未建（水系由 water 模块负责）。'
      + '高度无资料：按照片 djy_00（湖面倒影全景）坡屋面高低约 16–28 m 估；坡屋面向湖（东）抬高按照片 djy_02 的斜墙方向。',
  },
};

export default [ifc, glA, glB, ztzx, maike, yongwei, qinshang, taixin, ztgj, andaz, d5c1, icc, xigang, dsmA, dsmB, dsmC, dsmD, ty, yc, yitian, lifeng, library, conf, djy];
