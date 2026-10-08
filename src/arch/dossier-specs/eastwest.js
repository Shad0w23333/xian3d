// 逐栋档案：东西两翼（浐灞、国际港务区、东郊、西咸新区、航天、长安）——research/refs/dossiers/east_west.json（63 栋）
// 与 public.json 中落在该范围的条目。字段说明见 docs/DOSSIER_KIT.md；照片 vs 模型差异见 research/refs/dossiers/model_log_eastwest.md。
//
// 取值原则（用户要求“不要主观臆断，按互联网真实信息和照片建模”）：
//   · 档案有出处的数值直接用（高度/层数/尺寸）；档案为 null 的不编：能从照片数层、按卫星（Esri World Imagery 2025-03）量取的注明方法与误差，
//     都做不到的楼跳过（见日志“未建条目”）。
//   · 卫星上高楼屋面向一侧偏移（楼身倾斜）：塔楼落位 = 屋面位置 − 倾斜位移；本片影像倾斜约 0.25–0.4 m/每米楼高（同幅影像内已知高度的楼标定），
//     各条 meta.notes 写明。
//   · 轮廓：Overture/OSM 实测（public/data/dossier_fp.json）优先；Overture 覆盖范围外（西咸新区西部）用 buildings.bin 轮廓或卫星量取。
// 坐标：世界系 X 东、Z 南（北 = −Z），原点钟楼；rot = 长边相对正东逆时针角（度）。

// —— 小工具（只生成轮廓数据，不做建模） ——
/** 轴对齐矩形 [x0,x1]×[z0,z1]，只把 round 里列出的角（'NW','NE','SE','SW'）倒圆 r 米；返回世界坐标扁平数组 */
function roundRect(x0, x1, z0, z1, r, round = ['NW', 'NE', 'SE', 'SW'], seg = 6) {
  // z0 为北边（数值小）、z1 为南边；各角 [角点 x, z, 圆心 x, z, 起止角]
  const out = [];
  const C = {
    NW: [x0, z0, x0 + r, z0 + r, Math.PI, 1.5 * Math.PI],
    NE: [x1, z0, x1 - r, z0 + r, 1.5 * Math.PI, 2 * Math.PI],
    SE: [x1, z1, x1 - r, z1 - r, 0, 0.5 * Math.PI],
    SW: [x0, z1, x0 + r, z1 - r, 0.5 * Math.PI, Math.PI],
  };
  for (const k of ['NW', 'NE', 'SE', 'SW']) {
    const [px, pz, cx, cz, a0, a1] = C[k];
    if (!round.includes(k)) { out.push(px, pz); continue; }
    for (let s = 0; s <= seg; s++) {
      const a = a0 + ((a1 - a0) * s) / seg;
      out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
    }
  }
  return out;
}

// ═══════════════════════════════ 浐灞 ═══════════════════════════════

// ───── 西安浐灞艾美酒店（147 m / 32F） ─────
// 轮廓 0cfdd00a（OSM w822908171，42×33 m）；裙房 90d746b9（OSM w822908170）。照片（commons “未央 在灞河西岸望半岛 01–03”，2022-05，自西向东拍，
// 左北右南）：圆角矩形平面的玻璃塔，北侧为通高“帆形”体量（白色边框 + 竖向竖梃，顶部斜切、北高南低），南侧为横向白色楼层线的体量，止于约 133 m；
// 两体量交界是一条 S 形曲线（模型按 4 段阶梯近似）；底部约 16 m（4–5 层）通体白色横带。卫星（z19）：屋面圆角、北高，与照片一致。
// 夜景（qq 20220702）：整栋 LED 媒体立面。原 sky-data2 meridien 的暖色塔冠与“LE MERIDIEN 艾美”楼顶字无依据，不建。
const MER = { x0: 6248.0, x1: 6290.2, zN: -8915.5, zS: -8882.1 };
const meridien = {
  id: 'meridien-chanba',
  name: '西安浐灞艾美酒店',
  fp: '0cfdd00a',
  parts: [
    {
      name: 'base', // 底部 4–5 层通体白色横带（照片 bandao_02）
      pts: roundRect(MER.x0, MER.x1, MER.zN, MER.zS, 7.5), base: 0, top: 16,
      style: { pattern: 'horizontalBands', tint: '#5f8497', spd: '#eeece6', floorH: 3.2, colW: 2.6, spandrel: 0.3, mullW: 0.06, lit: 0.6 },
      roof: { mech: false },
    },
    // 北侧“帆形”体量（白色边框 + 竖向竖梃玻璃）与南侧横向楼层线体量：交界是自下而上向南推移的 S 形曲线（照片 bandao_03：
    // 下部北体量约占 43–45%、上部约 73%），按 4 段阶梯近似；南体量止于约 133 m，北体量顶部北高南低斜切。
    ...[[16, 48, 0.45], [48, 82, 0.54], [82, 114, 0.63], [114, 133, 0.71]].flatMap(([b, t, f], i) => {
      const zc = MER.zN + f * (MER.zS - MER.zN);
      return [
        { name: 'sail' + i, pts: roundRect(MER.x0, MER.x1, MER.zN, zc, 7.5, ['NW', 'NE']), base: b, top: t, roof: { mech: false },
          style: { pattern: 'media', tint: '#86a9bb', spd: '#ebe9e2', floorH: 3.9, colW: 1.3, spandrel: 0.06, mullW: 0.24, lit: 0.45, seed: 60 } },
        { name: 'south' + i, pts: roundRect(MER.x0, MER.x1, zc, MER.zS, 7.5, ['SE', 'SW']), base: b, top: t, roof: { mech: false },
          style: { pattern: 'media', tint: '#6d93a8', spd: '#eeece6', floorH: 3.9, colW: 3.0, spandrel: 0.3, mullW: 0.05, lit: 0.5, seed: 61 },
          ...(t === 133 ? { crown: [{ type: 'parapet', h: 1.4 }] } : {}) },
      ];
    }),
    {
      name: 'sailTop', // 北体量 133 m 以上：顶部斜切（北 147 m、南约 137 m）
      pts: roundRect(MER.x0, MER.x1, MER.zN, MER.zN + 0.73 * (MER.zS - MER.zN), 7.5, ['NW', 'NE']), base: 133, top: 147,
      style: { pattern: 'media', tint: '#86a9bb', spd: '#ebe9e2', floorH: 3.9, colW: 1.3, spandrel: 0.06, mullW: 0.24, lit: 0.45, seed: 60 },
      crown: [{ type: 'slope', dir: 'N', drop: 10 }],
    },
    {
      name: 'podium', // 塔楼南侧裙房（约 3 层，白色横带 + 玻璃；照片 bandao_02 右侧）
      kind: 'podium', fp: '90d746b9-bcb4-4b98-b2c7-faaa11e96d5c', base: 0, top: 14,
      style: { pattern: 'horizontalBands', tint: '#5d7f92', spd: '#eceae4', floorH: 4.6, colW: 3.2, spandrel: 0.28, mullW: 0.08, lit: 0.65 },
      roofMat: { color: '#b8b6b0', roughness: 0.85 },
    },
  ],
  supersede: { keys: ['meridien'], names: ['西安浐灞艾美酒店', '浐灞艾美'] },
  meta: {
    dossier: 'east_west.json#西安浐灞艾美酒店',
    sources: ['https://m.ctrip.com/html5/hotel/hoteldetail/10710455.html（147 m）', 'https://www.expedia.com/Xian-Hotels-Le-Meridien-Xian-Chanba.h20388897.Hotel-Information（32-storey）',
      'https://commons.wikimedia.org/wiki/File:未央_在灞河西岸望半岛_01.jpg（及 02、03，2022-05-22）', 'https://news.qq.com/rain/a/20220702A09ZGL00（夜景）', 'Esri World Imagery 2025-03 z19'],
    photos: ['scratchpad/ew/photos/bandao_01.jpg', 'bandao_02.jpg', 'bandao_03.jpg', 'scratchpad/dossier_east_west/photos/chanba_riverfront_night_qq1.jpg'],
    confidence: 'medium（高度/层数 high；分段按照片比例）',
    notes: '147 m / 32F 用档案。分段按照片 bandao_03 比例（塔高 1130 px = 147 m）：底部横带段约 16 m；南侧体量顶约 133 m；北侧帆形体量顶斜切落差约 10 m。'
      + '南北分界实为 S 形曲线（下部约 43%、上部约 73%），按 45%→54%→63%→71% 四段阶梯近似。裙房高 14 m 按照片比例（约 3 层）。无楼顶字、无暖色塔冠。',
  },
};

// ───── 西安锦江国际酒店（原中新凯宾斯基，5F） ─────
// 轮廓 081b2e98（OSM w272974619）：北侧弧形长翼（两端圆形角楼）+ 中轴南伸到南端圆形穹顶会议厅（卫星 z18）。屋面浅绿（卫星）。
// 夜景（qq 20220702）：整面 LED 媒体灯（按方位推断）。
const jinjiang = {
  id: 'jinjiang-chanba',
  name: '西安锦江国际酒店',
  fp: '081b2e98',
  parts: [
    {
      // 2026-10 审查 g8：原 media 立面白天是几百米长、窗户一模一样的方格墙（像写字楼/停车楼），屋面发青。
      // 改为度假酒店常见的米色涂料/石材墙 + 竖向壁柱分段（每 4.2 m 一窗、1.6 m 壁柱）、首层外廊柱（columns），屋面暖灰绿（卫星浅绿压低饱和）
      name: 'main', kind: 'podium', fp: '081b2e98', base: 0, top: 22.5,
      style: { pattern: 'stoneWindows', tint: '#34414b', spd: '#e0d6c4', floorH: 4.5, colW: 4.2, spandrel: 0.4, mullW: 1.6, lit: 0.55 },
      roofMat: { color: '#9aa392', roughness: 0.85 },
    },
    {
      name: 'hall', // 南端圆形会议厅 + 穹顶（卫星：直径约 44 m）；档案“五层穹顶会议厅”
      kind: 'podium', shape: 'circle', size: [44, 44], at: [6460.8, -8546.7], base: 0, top: 22.5,
      style: { pattern: 'stoneWindows', tint: '#34424c', spd: '#ddd5c6', floorH: 4.5, colW: 3.0, spandrel: 0.45, mullW: 1.2, lit: 0.55 },
      roofMat: { color: '#c9cbc6', roughness: 0.8 },
      crown: [{ type: 'dome', r: 19, h: 8, mat: { color: '#d8dbd6', roughness: 0.6, metalness: 0.2 } }],
    },
    ...[['turretW', 6342.2, -8712.0], ['turretE', 6574.4, -8589.6]].map(([name, x, z]) => ({
      name, // 弧形翼两端圆形角楼（卫星：直径约 18 m，高出屋面，顶部小穹顶）
      kind: 'podium', shape: 'circle', size: [18, 18], at: [x, z], base: 0, top: 26,
      style: { pattern: 'stoneWindows', tint: '#34424c', spd: '#ddd5c6', floorH: 4.5, colW: 2.4, spandrel: 0.45, mullW: 1.0, lit: 0.55 },
      roofMat: { color: '#9dbcae', roughness: 0.8 },
      crown: [{ type: 'dome', r: 7.5, h: 4, mat: { color: '#9dbcae', roughness: 0.7 } }],
    })),
  ],
  columns: [{ part: 'main', out: 2.2, step: 6.3, r: 0.36, from: 0, to: 5.0, mat: '#ece6d8' }], // 首层外廊柱（长边上，短碎边自动跳过）
  // 夜景：照片为檐口与立面的灯光线条 → 檐口一圈暖白线灯 + 墙脚投光（原整面 LED 线条立面白天不像酒店，改掉）
  night: { outline: [{ part: 'main', color: '#ffe2b0', w: 0.35, strength: 1.4 }], floodlight: [{ part: 'main', color: '#ffd9a0', strength: 0.18, fall: 2.0, spot: 8.4 }] },
  supersede: { keys: ['jinjiang'], names: ['西安锦江国际酒店', '锦江国际酒店', '西安锦江国际酒店（原西安中新凯宾斯基酒店）'] },
  meta: {
    dossier: 'east_west.json#西安锦江国际酒店（原西安中新凯宾斯基酒店）',
    sources: ['https://www.huodongjia.com/venue-077068085119077084069120.html（5 层）', 'https://news.qq.com/rain/a/20220702A09ZGL00（夜景）', 'Esri World Imagery 2025-03 z18'],
    photos: ['scratchpad/dossier_east_west/photos/chanba_riverfront_night_qq1.jpg', 'scratchpad/ew/sat/jinjiang.jpg'],
    confidence: 'low（层数有出处；米数按 5 层 × 约 4.5 m 推算）',
    notes: '高度米数未查到：按档案 5 层 × 约 4.5 m → 22.5 m。圆形会议厅与两端角楼位置、直径按卫星量取（±3 m）；角楼高出 3.5 m 与穹顶尺寸按卫星阴影/形态估计。'
      + '白天立面无照片，颜色取米色石材 + 竖向壁柱分段、首层外廊柱（2026-10 改：原整面 LED media 立面白天像写字楼）；夜间改为檐口线灯 + 墙脚投光。原 sky-data2 的“锦江国际酒店”招牌无依据，不建。',
  },
};

// ───── 欧亚国际 ICC 写字楼（27F） ─────
// 卫星 z19（icc19）：欧亚国际一期的主楼是一栋约 92×25 m、长轴约 19° 的板式塔楼，屋面向北偏移（可见南立面）；Overture 470bb3c6（ML，69×22）
// 描的是屋面。8 万 m² / 27 层 ≈ 3000 m²/层，与板楼 + 东侧附楼吻合。塔楼落位 = 屋面中心 (6349, −8084) 向南改正约 34 m（0.35 m/m × 97 m）。
const icc = {
  id: 'icc-oya',
  name: '欧亚国际 ICC',
  center: [6349, -8050],
  parts: [
    {
      name: 'slab', shape: 'round', shapeOpt: { r: 3 }, size: [92, 25], at: [6349, -8050], rot: 18.7, base: 0, top: 97.2,
      style: { pattern: 'media', tint: '#3e5667', spd: '#5f6a73', floorH: 3.6, colW: 1.5, spandrel: 0.26, mullW: 0.12, lit: 0.4 },
    },
  ],
  site: ['470bb3c6-269c-4a0a-af9c-f39f2b511d9e'], // 原 ML 屋面轮廓处的旧块（sky-data2 icc / buildings.bin 98 m 块）一并排除
  supersede: { keys: ['icc'], names: ['欧亚国际 ICC', '欧亚国际ICC'] },
  meta: {
    dossier: 'east_west.json#欧亚国际 ICC 写字楼（欧亚国际一期）',
    sources: ['https://xa.fang.anjuke.com/loupan/297590.html（27 层、标准层高 3.6 m、8 万 m²）', 'Esri World Imagery 2025-03 z19'],
    photos: ['scratchpad/ew/sat/icc19.jpg', 'scratchpad/dossier_east_west/photos/chanba_riverfront_night_qq1.jpg'],
    confidence: 'low',
    notes: '27 层 × 3.6 m = 97.2 m（档案层数与标准层高相乘；米数无直接出处）。平面 92×25 m、长轴 18.7° 按卫星屋面量取（±3 m）；落位按楼身倾斜改正（±10 m）。'
      + '夜间按河对岸照片为整栋 LED（media）。楼顶白色发光字不可读，不建。东侧较矮附楼、南侧其他塔楼身份未证实，不建。',
  },
};

// ───── 西安浐灞凯悦酒店（欧亚国际三期商业 4 号楼，约 100 m / 23F） ─────
// 卫星 z19（hyatt19b，2025-03）：欧亚大道 × 浐河西路西南角的方形塔（屋面约 53×49 m，白色厚檐），西立面可见逐段错出的白色厚板带——
// 与凯悦 newsroom“architecture draws inspiration from the ancient Chinese ritual of stacking stones”（叠石）一致；位置距档案推测点 (6458, −7833) 约 22 m。
// 塔楼落位：屋面中心 (6458.5, −7880.5) 向西南改正 (−5, +25) m。错台幅度按卫星约 1–2 m。
const HY = { x: 6453, z: -7855 };
const hyatt = {
  id: 'hyatt-chanba',
  name: '西安浐灞凯悦酒店',
  center: [HY.x, HY.z],
  parts: [
    ['b1', 0, 20, [52, 48], [0, 0]],
    ['b2', 20, 40, [50, 46], [1.5, -1]],
    ['b3', 40, 60, [51, 47], [-1.5, 1]],
    ['b4', 60, 80, [49, 45], [1, 1]],
    ['b5', 80, 100, [50, 46], [-0.5, -1.5]],
  ].map(([name, base, top, size, off], i) => ({
    name, shape: 'round', shapeOpt: { r: 7 }, size, offset: off, base, top, footprint: base === 0,
    style: { pattern: 'horizontalBands', tint: '#2f3b45', spd: '#e6e4de', floorH: 4.35, colW: 2.2, spandrel: 0.26, mullW: 0.06, lit: 0.55, seed: 70 + i },
    roof: { mech: top === 100 },
    crown: top === 100 ? [{ type: 'parapet', h: 2.2 }] : [],
  })),
  // 各段顶部的白色厚板（“石块”分界）
  bands: ['b1', 'b2', 'b3', 'b4'].map((part, i) => ({ part, levels: [19.4 + i * 20], h: 1.2, depth: 0.9, color: '#efeeea' })),
  supersede: { keys: ['hyatt'], names: ['西安浐灞凯悦酒店', '浐灞凯悦', '西安浐灞凯悦酒店（欧亚国际三期商业4号楼）'] },
  meta: {
    dossier: 'east_west.json#西安浐灞凯悦酒店（欧亚国际三期商业4号楼）',
    sources: ['https://newsroom.hyatt.com/HyattRegencyXianChanbaCelebratesOpening（叠石概念，310 间）', 'https://news.qq.com/rain/a/20250915A06PDO00', 'research/refs/chanba/notes.md（地上 23 层、约 100 m）', 'Esri World Imagery 2025-03 z19'],
    photos: ['scratchpad/ew/sat/hyatt19b.jpg', 'scratchpad/ew/sat/oya3.jpg'],
    confidence: 'low（身份按位置 + 叠石形态推断；高度用档案 100 m）',
    notes: '无实景照片。身份：该塔位于欧亚大道 × 浐河西路西南角、立面逐段错台，与“叠石”概念和档案推测坐标（±60 m）吻合；同地块另有两栋约 180 m 塔（源创）与一栋约 100 m 塔（LOFT）。'
      + '冲突：按同幅影像倾斜位移（源创 180 m 标定 0.34 m/m）此塔屋面位移约 25 m，折合约 70 m，低于档案 100 m；高度仍取档案值，差异记入日志。'
      + '平面 52×48 m 按卫星屋面；5 段 × 20 m 与错台幅度（1–2 m）按卫星立面近似。原 SPECIAL2.hyatt（4 段大角度旋转叠块 + 裙房）位置与造型均为推测，已替代。',
  },
};

// ───── 源创中心双塔（欧亚国际三期·东区超高层，约 180 m）+ 约百米 LOFT 行政公馆 ─────
// 卫星 z18/z19（oya3、hyatt19）：凯悦以西一排三栋塔，屋面向北偏移 61/57/37 m（同幅影像），西两栋为超高层，东侧一栋约百米。
const OYA_STYLE = { pattern: 'curtain', tint: '#46525e', spd: '#6c7680', floorH: 4.2, colW: 1.5, spandrel: 0.24, mullW: 0.1, lit: 0.4 };
const yuanchuang = {
  id: 'yuanchuang-oya',
  name: '源创中心双塔',
  center: [6311, -7773],
  parts: [
    { name: 'towerW', shape: 'round', shapeOpt: { r: 5 }, size: [44, 40], at: [6278, -7787], base: 0, top: 180, style: { ...OYA_STYLE, seed: 81 }, crown: [{ type: 'parapet', h: 2.5 }] },
    { name: 'towerE', shape: 'round', shapeOpt: { r: 5 }, size: [44, 37], at: [6345, -7760], base: 0, top: 180, style: { ...OYA_STYLE, seed: 82 }, crown: [{ type: 'parapet', h: 2.5 }] },
  ],
  label: { text: '源创中心' },
  supersede: { names: ['源创中心（欧亚国际三期）超高层1', '源创中心（欧亚国际三期）超高层2', '源创中心'] },
  meta: {
    dossier: 'east_west.json#源创中心双塔（欧亚国际三期·东区超高层写字楼）',
    sources: ['https://news.qq.com/rain/a/20211123A0BN0G00（2 栋约 180 m、1 栋约百米 LOFT、凯悦）', 'https://house.leju.com/sx/121463/（灰色三银 Low-E 玻璃）', 'Esri World Imagery 2025-03 z18/z19'],
    photos: ['scratchpad/ew/sat/oya3.jpg', 'scratchpad/ew/sat/hyatt19.jpg'],
    confidence: 'low（高度为营销口径）',
    notes: '位置：卫星屋面 (6289,−7849)/(6356,−7815) 按楼身倾斜向南改正约 61/57 m、向西约 11 m；平面 44×40 / 44×37 m 按屋面量取（±3 m）。'
      + '高度 180 m 取档案（营销口径）；倾斜位移按同幅 0.34 m/m 折合约 177/163 m，东塔可能略低。立面灰色玻璃（楼盘资料“以灰色为主色调”）。',
  },
};
const oyaLoft = {
  id: 'oya-loft',
  name: '欧亚国际三期 LOFT 行政公馆',
  center: [6412, -7782],
  parts: [{
    name: 'tower', shape: 'round', shapeOpt: { r: 6 }, size: [47, 37], at: [6412, -7782], base: 0, top: 100,
    style: { pattern: 'curtain', tint: '#39454f', spd: '#5d6770', floorH: 4.3, colW: 1.6, spandrel: 0.22, mullW: 0.1, lit: 0.5 },
  }],
  bands: [{ part: 'tower', levels: [12.9, 25.8, 38.7, 51.6, 64.5, 77.4, 90.3], h: 1.0, depth: 0.5, color: '#e8e6e0' }], // 卫星：约每 3 层一道白色横带
  label: false,
  meta: {
    dossier: 'east_west.json#源创中心双塔（…“1 栋约百米 LOFT 行政公馆”）',
    sources: ['https://news.qq.com/rain/a/20211123A0BN0G00', 'Esri World Imagery 2025-03 z19'],
    photos: ['scratchpad/ew/sat/hyatt19.jpg'],
    confidence: 'low',
    notes: '档案源创条目正文提到“1 栋约百米 LOFT 行政公馆”；卫星上源创双塔以东一栋圆角方塔屋面位移 37 m（0.34 m/m → 约 106 m），按“约百米”取 100 m。'
      + '落位 = 屋面 (6419,−7818) 向南改正 37 m、向西 7 m；平面 47×37 m。身份按位置与高度推断。',
  },
};

// ───── 西安丝路国际会议中心（51.05 m，3F）及其东南—西北同形制会议楼 ─────
// 同济设计：正方形体量、1:4 立面；“上月牙”巨型白色挑檐（四角上扬、檐底内凹）、180 根白色悬挂钢柱（直径 0.6 m、高 30–45 m）立于玻璃幕墙前、
// “下月牙”白色弧带 + 内凹首层全玻璃；屋顶中部抬起方形体量，中心圆形天窗（archina 航拍 + 卫星）。层高 16/16/18.45 m。
function confSpec(id, name, fp, c, rot, size, extra = {}) {
  const [L, W] = size;
  const R = (d) => [L - 2 * d, W - 2 * d];
  return {
    id, name, fp, center: c,
    parts: [
      { name: 'ground', kind: 'podium', shape: 'rect', size: R(13), at: c, rot, base: 0, top: 5, // 内凹首层全玻璃
        style: { pattern: 'retail', tint: '#5a7589', spd: '#dfe4e8', floorH: 7, colW: 4.2, mullW: 0.14, spandrel: 0.08, lit: 0.9 } },
      { name: 'moonLow', kind: 'solid', mat: { color: '#f1f0ec', roughness: 0.5 }, shape: 'rect', size: R(7.5), at: c, rot, base: 5, top: 7.5, footprint: true }, // 下月牙
      { name: 'glass', shape: 'rect', size: R(9), at: c, rot, base: 7.5, top: 38,
        style: { pattern: 'curtain', tint: '#5f829c', spd: '#e3e8ec', floorH: 5.35, colW: 4.2, spandrel: 0.06, mullW: 0.08, lit: 0.6 },
        roof: { mech: false },
        crown: [{ type: 'flyEave', out: 9, h: 6, lift: 7, span: 0.5, step: 3, mat: { color: '#f3f2ee', roughness: 0.45 }, under: { color: '#e9e8e3', roughness: 0.6 }, glow: '#fff0d4', strength: 1.3 }] },
      { name: 'roofBox', kind: 'solid', mat: { color: '#ecebe6', roughness: 0.6 }, shape: 'rect', size: [L * 0.575, W * 0.575], at: c, rot, base: 38, top: 47,
        crown: [{ type: 'dome', r: 21, h: 2.6, mat: { color: '#6f8797', metalness: 0.55, roughness: 0.15 } }] }, // 抬起方形体量 + 圆形天窗
    ],
    // 180 根白色细钢柱（沿玻璃幕墙外 1.6 m，柱距 ≈ 周长 / 180）
    columns: [{ part: 'glass', out: 1.6, step: ((R(9)[0] + R(9)[1] + 6.4) * 2) / 180, r: 0.3, from: 7.5, to: 38, seg: 8, mat: { color: '#f4f4f1', roughness: 0.4, metalness: 0.2 } }],
    night: { outline: [{ part: 'moonLow', color: '#fff0d4', y: 7.3, w: 0.8, strength: 1.4 }] },
    site: [fp],
    flatten: true,
    ...extra,
  };
}
const CONF_C = [8818.7, -8287.9];
const silkConf = confSpec('silkroad-conf', '西安丝路国际会议中心', 'ba01644e', CONF_C, -34.6, [204.8, 208.6], {
  supersede: { keys: ['conf'], names: ['西安丝路国际会议中心', '丝路国际会议中心', '西安国际会展中心-会议楼'] },
  meta: {
    dossier: 'east_west.json#西安丝路国际会议中心',
    sources: ['http://www.tjad.cn/project/686（51.05 m，地上 3 层，层高 16/16/18.45 m，180 根钢柱）', 'http://www.archina.com/index.php?g=works&m=index&a=show&id=10649', 'OSM w808104181', 'Esri World Imagery 2025-03 z18'],
    photos: ['scratchpad/dossier_east_west/photos/silkroad_conf_archina1.jpg', 'silkroad_conf_archina2.jpg', 'silkroad_expo_aerial_archina3.jpg', 'scratchpad/ew/sat/conf0.jpg'],
    confidence: 'high',
    notes: '主体 51.05 m 取“上月牙”挑檐四角最高点：照片 archina1 中挑檐自各边中点向四角大幅上扬、檐底内凹，悬挂柱高 30–45 m。模型：内凹首层 0–5 m、下月牙白带 5–7.5 m、玻璃 + 柱 7.5–38 m（柱长 30.5 m），挑檐厚 6 m（中点顶 44 m）、四角上扬 7 m（角顶 51 m），起翘范围取整边（span 0.5）；抬起方形体量 38–47 m、边长约 0.575 × 外轮廓、圆形天窗直径约 42 m 按卫星量取。'
      + '180 根柱按周长均布（柱距约 4.3 m）。原 SPECIAL.conf（石材柱廊 + 30 m 平檐 + 圆鼓，rot 34.6°）替代；SPECIAL.conf 的另一座同形制会议楼一并按卫星重建（见 silkroad-conf-b）。',
  },
});
const silkConfB = confSpec('silkroad-conf-b', '丝路国际会议中心西南会议楼', '8c1b8466-a6f4-4fd8-ae93-1a70b3142087', [8147.7, -8743.5], -34, [212, 210], {
  label: false,
  meta: {
    dossier: 'east_west.json#西安丝路国际会议中心（同形制；本楼未入档案）',
    sources: ['OSM w1213509466（未命名，212×210 m）', 'Esri World Imagery 2025-03 z17（conf1.jpg）'],
    photos: ['scratchpad/ew/sat/conf1.jpg'],
    confidence: 'low（身份与高度未查到）',
    notes: '替代 SPECIAL.conf 时 key "conf" 会同时跳过它：卫星上该楼与丝路国际会议中心形制一致（白色上扬挑檐外环、抬起方形体量、中心圆形天窗），'
      + '故按同一构成重建；高度未查到，按同形制取与会议中心相同分段（记入日志待核）。',
  },
});

// ───── 西安国际会议中心（世博园·圆桌会议楼，45.6 m） ─────
// 同济设计；效果图 + 航拍（qq 20200502）：深灰庑殿顶主楼（檐角起翘、鸱尾），平面“凹”字形，开口朝南（礼仪广场），前方两座方形攒尖亭式配楼。
// 卫星 z18（intlconf）：主楼屋面约 124×81 m、转角 9.3°；西南、东南两座约 40 m 见方的四坡顶配楼；中间为平顶门厅 + 种植屋面入口。
const IC_R = 9.3;
const IC_ROOF = { color: '#4a4f57', roughness: 0.75, metalness: 0.25 };
const IC_STONE = { pattern: 'stoneWindows', tint: '#34414b', spd: '#d8d1c2', floorH: 4.5, colW: 3.2, spandrel: 0.5, mullW: 1.4, lit: 0.5 };
const intlConf = {
  id: 'intl-conf-expo',
  name: '西安国际会议中心',
  fp: '72eae6e9',
  parts: [
    { name: 'plinth', kind: 'podium', shape: 'rect', size: [128, 84], at: [10280, -7514], rot: IC_R, base: 0, top: 8, style: IC_STONE, roofMat: '#bdb6a8' },
    { name: 'hall', shape: 'rect', size: [118, 74], at: [10280, -7514], rot: IC_R, base: 8, top: 26,
      style: { pattern: 'verticalFins', tint: '#3d4c57', spd: '#cfc8b8', floorH: 6, colW: 6.5, spandrel: 0.08, mullW: 1.5, lit: 0.6 },
      roof: { mech: false },
      crown: [{ type: 'wudian', h: 19.6, out: 5, lift: 1.8, mat: IC_ROOF }] },
    { name: 'front', kind: 'podium', shape: 'rect', size: [54, 32], at: [10286, -7466], rot: IC_R, base: 0, top: 14, style: IC_STONE, roofMat: '#8f8a80' },
    { name: 'entry', kind: 'podium', shape: 'rect', size: [34, 44], at: [10293, -7428], rot: IC_R, base: 0, top: 8, style: IC_STONE, roofMat: { color: '#6f8a5b', roughness: 0.9 } },
    ...[['pavSW', [10234, -7429]], ['pavSE', [10345, -7445]]].map(([name, at]) => ({
      name, shape: 'rect', size: [36, 36], at, rot: IC_R, base: 0, top: 12,
      style: { ...IC_STONE, floorH: 4 }, roof: { mech: false },
      crown: [{ type: 'wudian', h: 8, out: 3, lift: 1.1, ridge: 0.08, mat: IC_ROOF }],
    })),
  ],
  supersede: { names: ['西安国际会议中心（世博园西北角）', '西安国际会议中心', '西安国际会议中心（世博园·圆桌会议楼）'] },
  meta: {
    dossier: 'east_west.json#西安国际会议中心（世博园·圆桌会议楼）',
    sources: ['http://www.tjad.cn/project/805', 'https://news.qq.com/rain/a/20200502A0JQKG00（航拍 + 效果图；圆桌会议厅结构最高 26 m）', 'Esri World Imagery 2025-03 z18'],
    photos: ['scratchpad/dossier_east_west/photos/intl_conf_center_expo_qq1.jpg', 'intl_conf_center_expo_render_qq2.jpg', 'scratchpad/ew/sat/intlconf.jpg'],
    confidence: 'medium（形制）；low（45.6 m 为搜索摘要）',
    notes: '总高 45.6 m 取档案（摘要口径）：石材基座 8 m + 柱式中段至 26 m（“圆桌会议厅结构层高最高点 26 m”）+ 庑殿顶 19.6 m。'
      + '主楼/配楼/门厅位置与尺寸按卫星量取（±3 m），转角 9.3° 取 OSM 轮廓边向；配楼 12 m + 8 m 攒尖式四坡顶、门厅 14 m 按效果图比例。其余 5 栋配套会议楼（坡顶低层）未建。',
  },
};

// ───── 苏陕国际金融中心（烂尾双塔，拆降至 32 层） ─────
// 照片 sushan_ifc_qq1（2025 航拍，灞河在后）：两栋切角方塔，深蓝灰玻璃 + 竖向竖梃，幕墙未闭合：左塔（南）顶部约 6 层、右塔（北）顶部约 3 层为裸露混凝土框架；
// 两塔间 4–5 层裸框架裙房。卫星 z19（sushan19）：南塔屋面 (9845,−5772) 向东北偏移，改正后塔底 (9830,−5727)；北塔改正后 (9852,−5777)。
const SS_GLASS = { pattern: 'verticalFins', tint: '#3a5064', spd: '#7d8a95', floorH: 4.1, colW: 1.4, spandrel: 0.14, mullW: 0.22, lit: 0.02 };
const SS_FRAME = { pattern: 'stoneWindows', tint: '#16191c', spd: '#a19d94', floorH: 4.1, colW: 8, spandrel: 0.16, mullW: 0.9, lit: 0 };
const sushan = {
  id: 'sushan-ifc',
  name: '苏陕国际金融中心',
  center: [9841, -5752],
  parts: [
    { name: 'glassS', shape: 'chamfer', shapeOpt: { c: 5 }, size: [38, 38], at: [9830, -5727], rot: 18, base: 0, top: 106, style: SS_GLASS, roof: { mech: false } },
    { name: 'frameS', shape: 'chamfer', shapeOpt: { c: 5 }, size: [37.4, 37.4], at: [9830, -5727], rot: 18, base: 106, top: 131, style: SS_FRAME, roof: { mech: false } },
    { name: 'glassN', shape: 'chamfer', shapeOpt: { c: 5 }, size: [38, 38], at: [9853, -5778], rot: 18, base: 0, top: 119, style: SS_GLASS, roof: { mech: false } },
    { name: 'frameN', shape: 'chamfer', shapeOpt: { c: 5 }, size: [37.4, 37.4], at: [9853, -5778], rot: 18, base: 119, top: 131, style: SS_FRAME, roof: { mech: false } },
    { name: 'podium', kind: 'podium', shape: 'rect', size: [30, 50], at: [9841, -5752], rot: 66, base: 0, top: 18, style: { ...SS_FRAME, floorH: 4.5 }, roofMat: '#8d8a84' },
  ],
  supersede: { names: ['苏陕国际金融中心 塔1', '苏陕国际金融中心 塔2', '苏陕国际金融中心', '苏陕国际金融中心（烂尾双塔）'] },
  meta: {
    dossier: 'east_west.json#苏陕国际金融中心（烂尾双塔）',
    sources: ['https://news.qq.com/rain/a/20251213A05SQA00（拆降至 32 层、原规划 153.4 m）', 'Esri World Imagery 2025-03 z18/z19'],
    photos: ['scratchpad/dossier_east_west/photos/sushan_ifc_qq1.jpg', 'scratchpad/ew/sat/sushan19.jpg'],
    confidence: 'low（位置按卫星；高度按层数推算）',
    notes: '拆降后米数未查到：按原设计 153.4 m / 37 层的平均层高 4.15 m × 32 层 ≈ 131 m。平面约 38 m 见方切角（两塔中心距约 55 m，照片两塔间净距约 0.4–0.6 塔宽 → 塔宽不超过约 38 m；卫星屋面连同立面约 50 m 不可直接用）、转角 18° 按卫星屋面；塔底按倾斜（约 0.36 m/m）改正（±8 m）。'
      + '裸框架段：南塔顶部约 6 层、北塔顶部约 3 层（照片数层）；北塔中部竖向未闭合带未建。裙房 18 m 按照片数层（4–5 层裸框架，拍卖公告称 2 层裙房），位置按两塔之间估计。烂尾楼夜间不亮灯。',
  },
};

// ───── 西安浐灞万象汇（地上 5 层） ─────
// 轮廓 46d30957（OSM w1246792166，L 形）。照片：浅灰/暖灰金属板大盒子、檐口转角斜切、上部墙面几道深色短缝线；主立面中段深灰菱形肌理金属板、两侧米色平板，
// 中上部嵌 LED 广告屏，首层通长玻璃；“mixc 万象汇”“万象汇”招牌。
const mixone = {
  id: 'mixone-chanba',
  name: '西安浐灞万象汇',
  fp: '46d30957',
  parts: [
    { name: 'mall', kind: 'podium', fp: '46d30957', base: 0, top: 27,
      style: { pattern: 'stoneWindows', tint: '#2d343a', spd: '#d3cabd', floorH: 5.4, colW: 7, spandrel: 0.78, mullW: 3.2, lit: 0.35 },
      roofMat: { color: '#b3aea4', roughness: 0.85 } },
    { name: 'shopfront', kind: 'facade', fp: '46d30957', grow: 0.15, base: 0, top: 6,
      style: { pattern: 'retail', tint: '#3a4650', spd: '#9aa0a6', floorH: 6, colW: 4.0, spandrel: 0.12, mullW: 0.2, lit: 0.9 } },
  ],
  signs: [
    { text: '万象汇', part: 'mall', face: 'N', y: 23.5, h: 5, color: '#2b2b2b' },
    { text: 'mixc 万象汇', part: 'mall', face: 'W', near: 'N', y: 23.5, h: 4.2, color: '#2b2b2b' },
  ],
  night: { media: [{ part: 'mall', face: 'N', from: 11, to: 19, width: 26, shift: -50 }] },
  supersede: { names: ['西安浐灞万象汇(华润)', '西安浐灞万象汇'] },
  meta: {
    dossier: 'east_west.json#西安浐灞万象汇',
    sources: ['https://news.qq.com/rain/a/20260913A08OSS00（地下 2 + 地上 5 层）', 'https://news.qq.com/rain/a/20260529A04TLJ00', 'https://news.qq.com/rain/a/20260905A04K9L00'],
    photos: ['scratchpad/dossier_east_west/photos/chanba_mixone_qq1.jpg', 'chanba_mixone_qq2.jpg', 'scratchpad/ew/sat/mixone.jpg'],
    confidence: 'medium',
    notes: '高度米数未查到：按档案地上 5 层 × 约 5.4 m → 27 m。立面按照片：米色/暖灰金属板为主、首层通长玻璃；中段深灰菱形肌理无法用立面参数表达，未建。'
      + '招牌：照片未能确定朝向，“万象汇”放在北立面（面向主干道）、“mixc 万象汇”放在西立面北端，颜色按照片深灰（mixc 的 c 为红色，单色图集无法表达）。',
  },
};

// ───── 长安乐·一带一路文化艺术中心 ─────
// 卫星 z18/z19：五个“埙形”白色壳体（4 个椭圆 + 南端 1 个弧形体）+ 一个小玻璃圆筒，东侧弧形玻璃顶大厅 + 白色弧墙；壳体顶为图案化屋面。
// 照片（央广网/中新网 2023-10）：白色曲面壳体（细横向分缝）、左后方带水平环带的玻璃圆柱体量。
const CAY_SHELL = { pattern: 'louver', tint: '#cfd4d6', spd: '#f1f1ed', floorH: 1.4, colW: 6, spandrel: 0.82, mullW: 0.02, lit: 0.12 };
const CAY_ROOF = { color: '#d9d2c2', roughness: 0.9 };
const changanyue = {
  id: 'changanyue',
  name: '长安乐·一带一路文化艺术中心',
  fp: '07dd61df',
  parts: [
    { name: 'opera', kind: 'podium', shape: 'ellipse', size: [130, 100], at: [6420.3, -12434.7], rot: 39, base: 0, top: 32, style: CAY_SHELL, roofMat: CAY_ROOF },
    { name: 'concert', kind: 'podium', shape: 'ellipse', size: [92, 72], at: [6408.4, -12534.5], rot: -29, base: 0, top: 27, style: CAY_SHELL, roofMat: CAY_ROOF },
    { name: 'multi', kind: 'podium', shape: 'ellipse', size: [70, 46], at: [6444, -12586.4], rot: 120, base: 0, top: 24, style: CAY_SHELL, roofMat: CAY_ROOF },
    { name: 'cinema', kind: 'podium', shape: 'ellipse', size: [73, 45], at: [6496.9, -12609.1], rot: 57, base: 0, top: 22, style: CAY_SHELL, roofMat: CAY_ROOF },
    { name: 'mediaCenter', kind: 'podium', shape: 'arcSlab', size: [120, 34], shapeOpt: { sag: 18 }, at: [6514.6, -12352], rot: 146, base: 0, top: 18, style: CAY_SHELL, roofMat: CAY_ROOF },
    { name: 'drum', shape: 'circle', size: [22, 22], at: [6477.6, -12543.5], base: 0, top: 24,
      style: { pattern: 'horizontalBands', tint: '#5f7d90', spd: '#e8e8e4', floorH: 4, colW: 2.4, spandrel: 0.35, lit: 0.6 }, roof: { mech: false } },
    { name: 'lobby', kind: 'podium', shape: 'arcSlab', size: [223, 26], shapeOpt: { sag: 30 }, at: [6510, -12508], rot: -95, base: 0, top: 15,
      style: { pattern: 'curtain', tint: '#50697b', spd: '#e6e6e2', floorH: 5, colW: 3, spandrel: 0.08, lit: 0.8 }, roofMat: { color: '#5f7a8c', metalness: 0.55, roughness: 0.15 } },
  ],
  site: ['07dd61df'],
  supersede: { names: ['长安乐·一带一路文化艺术中心', '长安乐'] },
  meta: {
    dossier: 'east_west.json#长安乐·一带一路文化艺术中心',
    sources: ['https://www.shx.chinanews.com.cn/news/2023/1016/94669.html（五体：歌剧院/音乐厅/多功能厅/电影院/传媒中心，14.4 万 m²）', 'https://news.qq.com/rain/a/20250124A05ILO00', 'Esri World Imagery 2025-03 z18/z19'],
    photos: ['scratchpad/dossier_east_west/photos/changanyue_cnr1.jpg', 'scratchpad/ew/photos/cay_news2.jpg', 'scratchpad/ew/sat/changanyue.jpg', 'cay_s.jpg', 'cay_n.jpg'],
    confidence: 'medium（平面）；low（高度）',
    notes: '各壳体椭圆中心/长短轴/转角按卫星量取（±3 m）。高度未查到：按卫星阴影（同幅影像游泳跳水馆 30.15 m 阴影标定）与照片比例估计，歌剧院 32 m、音乐厅 27 m、'
      + '多功能厅 24 m、电影院 22 m、传媒中心 18 m、大厅 15 m（±6 m）。壳体实为倾斜的蛋形曲面，按竖直椭圆柱近似。五体与功能的对应按规模推断。广场地面立式标识未建（位置未查到）。',
  },
};

// ───── 长安云（一带一路城市展示体验中心） ─────
// 轮廓 08a08cd1（OSM w1091085198，406×103 m）。照片 changanyun_cnr1（隔灞河自西向东，左北右南）：极长的白/银色水平细条纹金属体，悬浮于内凹玻璃首层之上，
// 北端抬起成“云头”；卫星：北段白色雕塑屋面、中段白色连接、南段种植屋面 + 椭圆天窗。连桥提升至 32 m（摘要）。
const YUN_BODY = { pattern: 'louver', tint: '#d5dadc', spd: '#f2f3f2', floorH: 1.2, colW: 6, spandrel: 0.8, mullW: 0.02, lit: 0.15 };
const changanyun = {
  id: 'changanyun',
  name: '长安云',
  fp: '08a08cd1',
  parts: [
    { name: 'glassBase', kind: 'facade', fp: '08a08cd1', grow: -4, base: 0, top: 7,
      style: { pattern: 'retail', tint: '#4d6577', spd: '#c8cdd1', floorH: 7, colW: 3.6, spandrel: 0.06, mullW: 0.14, lit: 0.85 } },
    { name: 'head', pts: [6500.7, -13835.0, 6514.3, -13895.1, 6514.8, -13903.9, 6513.2, -13911.5, 6501.5, -13940.8, 6494.2, -13944.8, 6415.4, -13926.0, 6409.8, -13919.2, 6420.3, -13830.0, 6500.6, -13830.0],
      base: 7, top: 32, style: YUN_BODY, crown: [{ type: 'slope', dir: 'N', drop: 11 }] },
    { name: 'mid', kind: 'podium', pts: [6454.6, -13732.9, 6448.0, -13744.4, 6435.9, -13787.1, 6438.1, -13800.5, 6447.6, -13815.9, 6460.2, -13820.2, 6484.7, -13811.0, 6494.4, -13815.8, 6500.4, -13824.5, 6500.6, -13830.0, 6420.3, -13830.0, 6427.6, -13720.0, 6463.8, -13720.0],
      base: 7, top: 21, style: YUN_BODY, roofMat: { color: '#e9eae8', roughness: 0.6 } },
    { name: 'south', kind: 'podium', pts: [6430.1, -13681.5, 6436.1, -13625.5, 6457.8, -13539.4, 6461.7, -13537.2, 6500.2, -13534.6, 6505.0, -13535.9, 6506.1, -13540.2, 6512.8, -13642.9, 6512.5, -13655.8, 6509.5, -13669.1, 6502.2, -13684.3, 6485.6, -13699.0, 6471.3, -13709.4, 6463.8, -13720.0, 6427.6, -13720.0],
      base: 7, top: 21, style: YUN_BODY, roofMat: { color: '#71895c', roughness: 0.9 },
      crown: [{ type: 'dome', at: [6472, -13668], r: [14, 20], h: 1.5, mat: { color: '#5f7a8c', metalness: 0.55, roughness: 0.15 } }] },
  ],
  site: ['08a08cd1'],
  supersede: { names: ['长安云（西安科技馆·西安城市规划馆）', '长安云', '西安科技馆 / 陕西（西安）科技馆新馆（长安云南馆）', '西安城市规划馆（长安云北馆）'] },
  meta: {
    dossier: 'east_west.json#长安云（一带一路城市展示体验中心）',
    sources: ['https://news.qq.com/rain/a/20250124A05ILO00', '人民网/西部网摘要：连桥提升至 32 m 高空', 'OSM w1091085198', 'Esri World Imagery 2025-03 z17'],
    photos: ['scratchpad/dossier_east_west/photos/changanyun_cnr1.jpg', 'scratchpad/ew/sat/changanyun.jpg'],
    confidence: 'medium（形体）；low（高度）',
    notes: '整体高度未查到：以“连桥 32 m”为标尺按照片比例（北端云头 75 px、主体 49 px、玻璃首层约 7 m）→ 云头顶 32 m、主体 21 m。北/中/南三段按卫星屋面分界（z −13830 / −13720）切 OSM 轮廓；'
      + '北端云头为雕塑曲面，按北高南低斜顶（落差 11 m）近似；南段种植屋面、椭圆天窗按卫星。空中连桥餐厅等细部未建。',
  },
};

// ───── 长安书院（西安图书馆长安书院馆区） ─────
// 轮廓 88c147d3（OSM w1209021929，南北约 330 m）：沙漏形平面，中间一道南北向通缝把东西两半分开（卫星）。照片 changan_academy_cnr1：
// 深灰金属大屋面、檐口薄而上翘，檐下白色细高“郁金香”柱，通高玻璃幕墙 + 竖向铝竖梃，中缝为架空通道。
const SHU_GLASS = { pattern: 'verticalFins', tint: '#58788e', spd: '#c9cfd4', floorH: 4.75, colW: 1.6, spandrel: 0.06, mullW: 0.18, lit: 0.7 };
const SHU_EAVE = { type: 'flyEave', out: 9, h: 3.2, lift: 3, span: 0.3, step: 6, mat: { color: '#8e9398', roughness: 0.55, metalness: 0.35 }, under: { color: '#9ea2a6', roughness: 0.6 } };
const academy = {
  id: 'changan-academy',
  name: '长安书院',
  fp: '88c147d3',
  parts: [
    { name: 'west', pts: [5452.1, -13300.8, 5426.5, -13312.0, 5423.1, -13314.1, 5425.9, -13272.4, 5425.7, -13234.7, 5423.3, -13182.3, 5414.8, -13130.8, 5404.3, -13087.0, 5393.0, -13056.2, 5378.5, -13023.8, 5376.0, -13019.7, 5393.0, -13021.0, 5429.1, -13021.2, 5457.3, -13019.0, 5468.0, -13017.4, 5468.0, -13295.1],
      base: 0, top: 19, style: SHU_GLASS, roof: { mech: false }, crown: [SHU_EAVE] },
    { name: 'east', pts: [5498.0, -13011.4, 5524.4, -13003.9, 5557.4, -12992.0, 5551.5, -13003.1, 5538.4, -13033.9, 5528.0, -13074.0, 5523.8, -13101.0, 5522.9, -13123.9, 5524.8, -13164.4, 5527.2, -13189.2, 5533.6, -13213.8, 5543.9, -13244.8, 5556.0, -13272.7, 5568.8, -13296.5, 5553.3, -13292.2, 5530.2, -13288.4, 5505.5, -13287.5, 5498.0, -13288.3],
      base: 0, top: 19, style: SHU_GLASS, roof: { mech: false }, crown: [SHU_EAVE] },
  ],
  // 中缝架空通道里的白色郁金香柱（照片：柱顶外扩，支撑两侧大屋面）
  columns: [{ part: 'west', at: Array.from({ length: 15 }, (_, i) => [5483, -13290 + i * 20]), r: 0.8, rTop: 3.2, from: 0, to: 19, seg: 14, mat: { color: '#f2f2ef', roughness: 0.45 } }],
  site: ['88c147d3'],
  supersede: { names: ['长安书院（西安图书馆长安书院馆区）', '长安书院'] },
  meta: {
    dossier: 'east_west.json#长安书院（西安图书馆长安书院馆区）',
    sources: ['https://news.qq.com/rain/a/20250124A05ILO00', 'OSM w1209021929', 'Esri World Imagery 2025-03 z17'],
    photos: ['scratchpad/dossier_east_west/photos/changan_academy_cnr1.jpg', 'scratchpad/ew/sat/academy.jpg'],
    confidence: 'medium（形体）；low（高度）',
    notes: '高度未查到：按照片以人高 1.7 m 标定（柱高约 14.5–19 m、屋檐上沿约 23 m，±3 m）→ 玻璃体 19 m + 屋面 3.2 m + 檐口上翘 3 m。'
      + '东西两半 = OSM 轮廓按卫星中缝（x 5477–5489）切开后内缩 9 m（屋面出挑 9 m 回到原轮廓）。A–D 四馆的分隔、中部连廊未建。地面立式“長安書院”字未建。',
  },
};

// ═══════════════════════════════ 东郊 ═══════════════════════════════

// ───── 西安东站（2026-06 投用） ─────
// 报道：屋盖“山脊组合造型”斜交空间管桁架，长 400 m、宽 293 m，主桁架跨度 89 m，屋面最高与最低点高差 11 m，桁架提升至 33 m；屋面菱形错落；
// 立面“W”形连续拱（五组），盛唐木金色 + 科技白。照片 east_station_p1（西立面，背景白鹿原）：三个大拱、屋顶红色“西安东站”大字。
// 轨道南北向（rail.json），站房横跨轨道：屋盖 400 m 取东西向、293 m 取南北向（与 OSM 轮廓 392×376 m 的东西向外包吻合）。
const ES = { x: 10725, z: 5064 };
const eastStation = {
  id: 'xian-east-station',
  name: '西安东站',
  center: [ES.x, ES.z],
  parts: [
    { name: 'hall', shape: 'rect', size: [380, 273], at: [ES.x, ES.z], base: 0, top: 30,
      style: { pattern: 'verticalFins', tint: '#4f6577', spd: '#c7a469', floorH: 6, colW: 3.6, spandrel: 0.06, mullW: 0.35, lit: 0.75 }, roof: { mech: false } },
    { name: 'roof', kind: 'solid', mat: { color: '#e8e9ea', roughness: 0.45, metalness: 0.35 }, shape: 'rect', size: [400, 293], at: [ES.x, ES.z], base: 30, top: 33.5 },
    // 屋面菱形隆起单元（“山脊”），中间最高（高差 11 m）
    ...[[-150, 7], [-75, 9], [0, 10.5], [75, 9], [150, 7]].map(([dx, h], i) => ({
      name: 'ridge' + i, kind: 'solid', mat: { color: '#e8e9ea', roughness: 0.45, metalness: 0.35 },
      shape: 'rect', size: i === 2 ? [66, 66] : [54, 54], at: [ES.x + dx, ES.z], rot: 45, base: 33.5, top: 33.8,
      crown: [{ type: 'pyramid', h, inset: 0, mat: { color: '#dfe2e4', roughness: 0.4, metalness: 0.4 } }],
    })),
  ],
  bands: [{ part: 'roof', levels: [30.2], h: 3.2, depth: 1.2, color: '#f4f4f2', glow: '#e8f0ff', strength: 0.8 }], // 白色檐口封边（夜间白光）
  signs: [
    { text: '西安东站', part: 'roof', face: 'W', y: 38.5, h: 8, color: '#d42a2a', out: 0.2 },
    { text: "XI'AN DONG RAILWAY STATION", part: 'roof', face: 'W', y: 34.6, h: 1.6, color: '#d42a2a', out: 0.4 },
  ],
  flatten: true,
  supersede: { names: ['西安东站'] },
  meta: {
    dossier: 'east_west.json#西安东站',
    sources: ['https://www.stdaily.com/web/gdxw/2025-10/27/content_421899.html（400×293 m、高差 11 m、33 m 提升）', 'https://news.hsw.cn/system/2026/0615/1937089.shtml（五组连续拱、木金色+白）', 'http://sn.people.com.cn/n2/2026/0615/c226647-41611398.html', 'public/data/rail.json（轨道南北向）'],
    photos: ['scratchpad/dossier_east_west/photos/east_station_p1.jpg', 'east_station_p2.jpg', 'east_station_p3.jpg'],
    confidence: 'medium',
    notes: '屋盖 400×293 m、檐口约 33 m（桁架提升高度）、屋脊最高约 44 m（高差 11 m）用报道数值；中心取 OSM 轮廓中心。站房主体 30 m 以下为木金色竖梃玻璃幕墙。'
      + '“W”形五组连续拱与扇形格栅、高架落客平台、站台雨棚未建；屋面菱形单元按五个菱锥近似（位置/大小按照片 p2 示意）。卫星影像为施工期，未用于形体。',
  },
};

// ═══════════════════════════════ 西咸新区 ═══════════════════════════════

// ───── 中国国际丝路中心大厦（停工：核心筒约 300 m / 61 层，外框钢构 40 余层，幕墙 15 层） ─────
// 照片 silkroad_center_qq2/qq4（2025-05）：方形平面（四角凹槽）、底部约 15 层深色玻璃、其上裸露钢框 + 楼板至约 40 余层，顶部蓝色爬模/防护屏，
// 核心筒继续升至约 300 m，顶部两台动臂塔吊。卫星 z19（2025-03）：核心筒顶、钢框顶向北偏移，塔底约 (−15975, 195)，钢框外包约 64 m 见方。
const SC = { x: -15975, z: 195 };
const silkCenter = {
  id: 'silkroad-center-xixian',
  name: '中国国际丝路中心大厦',
  center: [SC.x, SC.z],
  parts: [
    { name: 'glass', shape: 'chamfer', shapeOpt: { c: 7 }, size: [64, 64], at: [SC.x, SC.z], base: 0, top: 74,
      style: { pattern: 'grid', tint: '#2a3d50', spd: '#394a5b', floorH: 4.9, colW: 1.6, spandrel: 0.22, mullW: 0.14, lit: 0.08 }, roof: { mech: false } },
    { name: 'frame', shape: 'chamfer', shapeOpt: { c: 7 }, size: [63.4, 63.4], at: [SC.x, SC.z], base: 74, top: 198,
      style: { pattern: 'stoneWindows', tint: '#15181b', spd: '#8e9195', floorH: 4.9, colW: 7, spandrel: 0.16, mullW: 0.7, lit: 0 }, roof: { mech: false } },
    { name: 'screen', kind: 'solid', mat: { color: '#2f6fd0', roughness: 0.6 }, shape: 'chamfer', shapeOpt: { c: 7 }, size: [65.6, 65.6], at: [SC.x, SC.z], base: 198, top: 213 },
    { name: 'core', kind: 'solid', mat: { color: '#a9a59c', roughness: 0.9 }, shape: 'rect', size: [32, 32], at: [SC.x, SC.z], base: 213, top: 292 },
    { name: 'platform', kind: 'solid', mat: { color: '#56606a', roughness: 0.7 }, shape: 'rect', size: [36, 36], at: [SC.x, SC.z], base: 292, top: 300,
      crown: [
        { type: 'luffCrane', offset: [-9, 7], top: 325, jib: 48, luff: 62, rot: 150 },
        { type: 'luffCrane', offset: [9, -7], top: 322, jib: 48, luff: 58, rot: -20 },
      ] },
  ],
  // buildings.bin 172341（CMAB 局部块被旧修正误设为 300 m，实为南侧一排约 76 m 高层之一）：替代旧 synth 塔后会重新出现，一并排除
  site: [[-16045, 250, -15997, 250, -15997, 290, -16045, 290]],
  supersede: { names: ['中国国际丝路中心大厦（绿地）', '中国国际丝路中心大厦'] },
  meta: {
    dossier: 'east_west.json#中国国际丝路中心大厦',
    sources: ['https://news.qq.com/rain/a/20250528A084CH00（2024-03：核心筒 61 层约 300 m、钢构 40 余层、幕墙 15 层）', 'https://news.qq.com/rain/a/20230831A051C600', 'Esri World Imagery 2025-03 z17/z19'],
    photos: ['scratchpad/dossier_east_west/photos/silkroad_center_qq1.jpg', 'silkroad_center_qq2.jpg', 'silkroad_center_qq4.jpg', 'scratchpad/ew/sat/silkcenter19.jpg'],
    confidence: 'medium',
    notes: '按现状建（停工，无塔冠）：核心筒顶 300 m（61 层 → 平均 4.92 m/层）；幕墙 15 层 ≈ 74 m；钢框 + 楼板至约 40 余层 ≈ 198 m（照片 qq2 以 300 m 标定为 213 m 处的蓝色爬模顶，±10 m）；'
      + '蓝色爬模 198–213 m；核心筒 32 m 见方、顶部 8 m 平台与两台动臂塔吊（臂仰角约 60°）按照片比例。平面 64 m 切角（照片“四角凹槽”）按卫星钢框外包；塔底按倾斜（约 0.35 m/m）改正（±15 m）。'
      + '档案点 (−16021, 270) 为 buildings.bin 局部块位置，实际塔位在其北约 80 m 的工地内。',
  },
};

// ───── 西安国际足球中心（6 万座，总高 63.9 m，长 299.6 m、宽 254.5 m） ─────
// 卫星 + buildings.bin 200509：屋盖为圆角矩形 250×296 m（南北长），中心 (−15965, −2472)——档案坐标（pois 点）偏东约 85 m。屋盖中部椭圆开口约 89×111 m。
// 照片 football_c2（B 门正面）：白色薄屋盖大幅外挑、轮廓“双峰”（两端隆起、中部下凹），屋盖下暗红树状立柱、深灰多道水平挑板看台；
// football_c3（2023-02 施工末期侧面）：屋面自外缘向开口帐篷式隆起。维基：“下方上圆”马鞍形，北侧最大悬挑 36 m。
const FB_ROOF = [-16089.8, -2608.9, -16088.9, -2613.2, -16086.4, -2616.5, -16082.3, -2618.9, -16076.7, -2619.5, -15853.9, -2620.1, -15845.2, -2616.1, -15842.3, -2611.5, -15841.5, -2606.7, -15839.9, -2335.8, -15840.8, -2330.3, -15843.8, -2327.1, -15852.5, -2324.1, -15858.6, -2324.0, -16080.9, -2324.9, -16086.9, -2327.9, -16089.1, -2335.6];
const FB_C = [-15965, -2472];
const football = {
  id: 'xian-intl-football',
  name: '西安国际足球中心',
  center: FB_C,
  parts: [
    { name: 'bowl', kind: 'podium', pts: FB_ROOF, grow: -26, roundCorners: 22, base: 0, top: 34,
      holes: [[...Array(48)].flatMap((_, i) => { const a = (i / 48) * Math.PI * 2; return [FB_C[0] + 38 * Math.cos(a), FB_C[1] - 55 * Math.sin(a)]; })],
      style: { pattern: 'louver', tint: '#23282e', spd: '#3b4148', floorH: 5.6, colW: 5, spandrel: 0.55, mullW: 0.05, lit: 0.55 },
      roofMat: { color: '#5b6e84', roughness: 0.8 },
      crown: [{ type: 'saddleRoof', grow: 26, y: 34, open: { size: [111, 89], at: FB_C, rot: 90 }, rim: 58, amp: 6, axis: 0, h: 2, power: 1.8, n: 144, rings: 12,
        mat: { color: '#efeeea', roughness: 0.45, metalness: 0.2 }, under: { color: '#e4e2dd', roughness: 0.6, glow: '#a37cff', glowNight: 0.35 } }] },
    { name: 'pitch', kind: 'solid', mat: { color: '#3f7a3a', roughness: 0.95 }, shape: 'ellipse', size: [76, 110], at: FB_C, base: 0, top: 0.4 },
  ],
  columns: [{ part: 'bowl', out: 7, step: 18, r: 1.3, rTop: 2.6, from: 0, to: 33, seg: 10, mat: { color: '#6b2a2a', roughness: 0.6 } }],
  label: { y: 72 },
  flatten: true,
  supersede: { names: ['西安国际足球中心', '西安国际足球中心体育场'] },
  meta: {
    dossier: 'east_west.json#西安国际足球中心',
    sources: ['扎哈事务所项目资料（总高 63.9 m，299.6×254.5 m）', 'https://zh.wikipedia.org/wiki/西安国际足球中心（马鞍形、北侧 36 m 悬挑）', 'buildings.bin 200509（屋盖轮廓）', 'Esri World Imagery 2025-03 z17'],
    photos: ['scratchpad/dossier_east_west/photos/football_c2.jpg', 'football_c1.jpg', 'scratchpad/ew/photos/football_c3.jpg', 'scratchpad/ew/sat/football.jpg'],
    confidence: 'high（总尺寸）；medium（剖面）',
    notes: '屋盖外轮廓取 buildings.bin 200509（250×296 m，与档案 254.5×299.6 m 吻合），中心按卫星改正。屋盖最高 63.9 m：内缘平均 58 m、马鞍半幅 6 m（高点在东西两侧长看台上方，'
      + '按马鞍形体育场常规与照片 c2“双峰”推断方向），外缘檐口 34 m（照片 c3 约为最高点一半，±5 m）。看台外缘按屋盖内缩 26 m（悬挑 26–36 m）。开口 89×111 m 按卫星。'
      + '暗红树状柱按柱距 18 m 近似；夜间内膜紫光（照片 c1）以罩棚底面弱紫光表示。外立面动态云彩灯光未建。',
  },
};

// ───── 华润国际广场 T1（西咸万象城超高层，187 m / 41F） ─────
// 卫星 z18（mixc_xx18）：万象城东南端大方塔，屋面约 52×47 m 向北偏移约 63 m（187 m → 0.34 m/m）；改正后塔底中心 (−10701, −3353)，
// 与 OSM“华润国际广场大厦”局部轮廓 f01da034（49×16 m）位置吻合。标准层约 2000 m²（摘要）≈ 46 m 见方。
const crT1 = {
  id: 'crland-t1-xixian',
  name: '华润国际广场T1',
  center: [-10701, -3353],
  parts: [{
    name: 'tower', shape: 'chamfer', shapeOpt: { c: 3 }, size: [48, 45], at: [-10701, -3353], base: 0, top: 187,
    style: { pattern: 'verticalFins', tint: '#4a6072', spd: '#c6ccd1', floorH: 4.4, colW: 1.4, spandrel: 0.16, mullW: 0.28, lit: 0.42 },
    crown: [{ type: 'parapet', h: 3 }],
  }],
  supersede: { names: ['华润国际广场T1', '华润国际广场大厦', '华润国际广场 T1（西咸万象城超高层）'] },
  meta: {
    dossier: 'east_west.json#华润国际广场 T1（西咸万象城超高层）',
    sources: ['百度百科“华润国际广场”摘要（187 m T1）', '搜狗百科摘要（41 层超高层办公）', 'OSM w969242842', 'Esri World Imagery 2025-03 z18'],
    photos: ['scratchpad/ew/sat/mixc_xx18.jpg'],
    confidence: 'low（高度为摘要口径；位置 medium）',
    notes: '187 m / 41F 取档案。平面 48×45 m 按卫星屋面（±3 m）与标准层 2000 m² 互证；落位按倾斜改正（±8 m）。立面无照片：卫星可见竖向浅色线条，按浅灰竖肋玻璃处理。'
      + '万象城商业裙房（4 层）轮廓：Overture af5df361 为整块地块，卫星上商业体沿斜街的真实边界无法可靠描出，本轮不重建，保留旧模型。',
  },
};

// ───── 西安西咸吾悦广场 ─────
// 卫星 z18：商场本体为圆角矩形约 205×106 m（x −11434…−11229，z 595…702），屋面有蓝色弯曲玻璃采光带与红色曲线构件；
// Overture 51dcba42 另含北侧塔楼裙房，本轮只建商场本体。照片 xixian_wuyue_c1：转角大圆弧，银灰铝板横向曲线分层 + 弯曲深蓝灰玻璃带，
// 顶部弧形女儿墙上“wuyue 吾悦广场”深蓝色字，入口上方约 2 层高 LED 大屏，可数约 6 个楼层带。
const wuyue = {
  id: 'wuyue-xixian',
  name: '西安西咸吾悦广场',
  center: [-11331.5, 648.3],
  parts: [
    { name: 'mall', kind: 'podium', shape: 'round', shapeOpt: { r: 32, seg: 10 }, size: [205, 106], at: [-11331.5, 648.3], base: 0, top: 30,
      style: { pattern: 'louver', tint: '#3c5566', spd: '#c5c9cc', floorH: 5, colW: 5, spandrel: 0.62, mullW: 0.03, lit: 0.6 },
      roofMat: { color: '#aeb0ae', roughness: 0.85 },
      crown: [{ type: 'arch', at: [-11315, 660], size: [120, 12], rot: 8, h: 2.5, mat: { color: '#7fa6c4', metalness: 0.5, roughness: 0.15 } }] },
    { name: 'shopfront', kind: 'facade', shape: 'round', shapeOpt: { r: 32, seg: 10 }, size: [205.3, 106.3], at: [-11331.5, 648.3], base: 0, top: 6,
      style: { pattern: 'retail', tint: '#3a4650', spd: '#b7bcc0', floorH: 6, colW: 3.6, spandrel: 0.12, mullW: 0.2, lit: 0.9 } },
  ],
  bands: [{ part: 'mall', levels: [11, 18.5, 25], wave: { amp: 1.1, len: 120, phase: 1.3 }, h: 0.6, depth: 0.6, color: '#d9dcdf' }], // 横向曲线铝板分层
  signs: [
    { text: 'wuyue 吾悦广场', part: 'mall', face: 'S', near: 'E', y: 27, h: 4.5, color: '#1f3b73' },
    { text: 'wuyue 吾悦广场', part: 'mall', face: 'E', near: 'S', y: 27, h: 4.5, color: '#1f3b73' },
  ],
  night: { media: [{ part: 'mall', face: 'S', from: 8, to: 16, width: 26, shift: 70 }] },
  supersede: { names: ['西安西咸吾悦广场'] },
  meta: {
    dossier: 'east_west.json#西安西咸吾悦广场',
    sources: ['https://commons.wikimedia.org/wiki/File:Xi%27an_Xixian_Wuyue_Plaza_near_Epanggongnan_Station,_Feb_27_2023.jpg', 'OSM w997678837', 'Esri World Imagery 2025-03 z18'],
    photos: ['scratchpad/dossier_east_west/photos/xixian_wuyue_c1.jpg', 'scratchpad/ew/sat/wuyue_xx.jpg'],
    confidence: 'medium',
    notes: '高度未查到：照片可数约 6 个楼层带 × 约 5 m → 30 m。商场平面按卫星量取（±3 m），四角圆弧半径约 32 m。招牌为照片所见深蓝色字（malls.json 记红色 #E60012，与照片不符，按照片）；'
      + '照片转角推断为东南角（长立面在左 = 南立面），招牌放在东南转角两侧。屋面蓝色弯曲采光带以一道筒拱近似，红色曲线构件未建。',
  },
};

// ───── 秦汉新城兰池大厦（主塔 23F、副塔 13F） ─────
// 轮廓 63c32b18（OSM w737718900，118×54 m）：卫星 z18 屋面三块——东块最高、西块与中间块较低（屋面向北偏移 25 / 17 / 15 m）。
// 东块 = 主塔（23F），西 + 中 = 副塔（13F）。
const lanchi = {
  id: 'lanchi-qinhan',
  name: '秦汉新城兰池大厦',
  fp: '63c32b18',
  parts: [
    { name: 'main', pts: [-8338.0, -14994.0, -8335.2, -14983.3, -8289.6, -14995.0, -8299.9, -15035.3, -8343.0, -15024.2, -8343.0, -14992.7], base: 0, top: 97,
      style: { pattern: 'verticalFins', tint: '#4b5a66', spd: '#b9b0a2', floorH: 4.2, colW: 1.8, spandrel: 0.2, mullW: 0.45, lit: 0.45 } },
    { name: 'annex', pts: [-8343.2, -15024.1, -8346.3, -15036.3, -8392.0, -15024.6, -8394.4, -15033.7, -8410.8, -15029.5, -8397.7, -14978.6, -8343.0, -14992.7], base: 0, top: 55,
      style: { pattern: 'verticalFins', tint: '#4b5a66', spd: '#b9b0a2', floorH: 4.2, colW: 1.8, spandrel: 0.2, mullW: 0.45, lit: 0.45 } },
  ],
  supersede: { names: ['秦汉新城兰池大厦', '兰池大厦'] },
  meta: {
    dossier: 'east_west.json#秦汉新城兰池大厦',
    sources: ['深圳鹏清设计官网（主塔 23 层、副塔 13 层、地下 2 层）', 'OSM w737718900', 'Esri World Imagery 2025-03 z18'],
    photos: ['scratchpad/ew/sat/lanchi.jpg'],
    confidence: 'low（层数有出处；分体与米数按卫星）',
    notes: '米数未查到：按卫星屋面倾斜位移（东块 25 m、西/中 15–17 m，比例与 23:13 层相符）取层高约 4.2 m → 主塔 97 m、副塔 55 m（±10 m）。'
      + '主/副塔在轮廓内的分界按卫星屋面分块（x ≈ −8343）。立面无照片：设计概念“秦砖、古塔”，按暖灰竖肋 + 玻璃处理。原 towers.json 100 m（估计）替代。',
  },
};

// ═══════════════════════════════ 航天 ═══════════════════════════════

// ───── 陕铁大厦（99.8 m / 23F，东长安街 × 神舟四路西北角） ─────
// 卫星 z19（shaantie19，2025-03）：路口西北街坊东侧一栋方塔，屋面向东北偏移、可见西/南立面，改正后塔底约 (2452, 11531)，约 40 m 见方
// （标准层 1580–1650 m²）。旧 landmarks2026 把它放在其西侧的 5e076029（实为金属坡屋面大厅，无高层立面），buildings.bin 81438 在该处被旧修正设为 99.8 m——一并排除。
const shaantie = {
  id: 'shaantie-hangtian',
  name: '陕铁大厦',
  center: [2452, 11531],
  parts: [{
    name: 'tower', shape: 'chamfer', shapeOpt: { c: 2 }, size: [40, 40], at: [2452, 11531], base: 0, top: 99.8,
    style: { pattern: 'curtain', tint: '#50697c', spd: '#8a96a0', floorH: 4.2, colW: 1.5, spandrel: 0.22, mullW: 0.1, lit: 0.45 },
    crown: [{ type: 'parapet', h: 2 }],
  }],
  site: ['5e076029-d67b-4241-abf9-861cf206ed41'],
  clearance: 1.5,
  supersede: { names: ['陕铁大厦'] },
  meta: {
    dossier: 'east_west.json#陕铁大厦',
    sources: ['https://m.sych100.com/h-nd-2071.html（99.8 m、23 层、标准层高 4.2 m、东长安街与神舟四路十字西北角）', 'Esri World Imagery 2025-03 z18/z19'],
    photos: ['scratchpad/ew/sat/shaantie19.jpg', 'scratchpad/ew/sat/shaantie17.jpg'],
    confidence: 'low（数值为招商稿；塔位按卫星推断）',
    notes: '99.8 m / 23F 取档案。塔位：路口西北街坊内唯一可见高层立面的楼，屋面按倾斜（约 0.38 m/m）改正（±10 m）；百度地图另记“神舟三路陕铁大厦”，与招商稿“神舟四路西北角”不一致，按招商稿 + 卫星。'
      + '5e076029（54×45 m 金属屋面大厅）处 buildings.bin 81438 被旧修正误设为 99.8 m，作为 site 排除（该大厅本身未重建，留待 buildings.bin 修正）。立面双银 Low-E 玻璃（文字），无照片。',
  },
};

export default [meridien, jinjiang, icc, hyatt, yuanchuang, oyaLoft, silkConf, silkConfB, intlConf, sushan, mixone, changanyue, changanyun, academy, eastStation, silkCenter, football, crT1, wuyue, lanchi, shaantie];
