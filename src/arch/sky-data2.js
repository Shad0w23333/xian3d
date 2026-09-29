// skyline：2026-09 地标更新（用户反馈“建筑过时/失真”）——未央国际商圈、曲江 W 酒店·万众国际、浐灞欧亚大道两岸。
// 调研：research/refs/weiyang/notes.md、research/refs/qujiang/notes_2026.md、research/refs/chanba/notes.md
// 轮廓：src/arch/sky-footprints2.js（tools/extract_fp2.py 从 Overture 2026-09-23 / OSM 提取）；标【推测】的数值见调研笔记
import * as G from './sky-geom.js';
import { FP2 } from './sky-footprints2.js';

const D = Math.PI / 180;
const F = (...a) => a.filter((i) => i >= 0); // 招牌朝向（找不到合适的边时跳过）

/** 被本文件取代的旧定义（sky-data.js 的 key） */
export const SUPERSEDED = new Set(['wygj', 'wygjS1', 'wygjS2', 'xidigang', 'darongcheng']);

/** 多边形中外法线最接近 (dx,dz) 且较长的边下标（招牌朝向用；多边形会先经 G.ccw）；skip：跳过的边下标集合 */
export function faceTowards(pts, dx, dz, minL = 12, skip = null) {
  const p = G.ccw(pts), n = p.length / 2, dl = Math.hypot(dx, dz);
  let best = -1, bs = -1e9;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = p[j * 2] - p[i * 2], ez = p[j * 2 + 1] - p[i * 2 + 1], L = Math.hypot(ex, ez);
    if (L < minL || skip?.has(i)) continue;
    const nx = ez / L, nz = -ex / L;
    const s = (nx * dx + nz * dz) / dl + L / 400;
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

/** 外法线与 (dx,dz) 夹角 < 45°、长度 ≥ minL 的边中，中点离 (px,pz) 最近的边下标（招牌要挂在某个入口旁时用；多边形先经 G.ccw） */
export function faceNear(pts, dx, dz, px, pz, minL = 6) {
  const p = G.ccw(pts), n = p.length / 2, dl = Math.hypot(dx, dz);
  let best = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = p[j * 2] - p[i * 2], ez = p[j * 2 + 1] - p[i * 2 + 1], L = Math.hypot(ex, ez);
    if (L < minL || (ez * dx - ex * dz) / (L * dl) < Math.SQRT1_2) continue;
    const d = Math.hypot((p[i * 2] + p[j * 2]) / 2 - px, (p[i * 2 + 1] + p[j * 2 + 1]) / 2 - pz);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// 未央国际：三角形塔楼（直角在地块东北，斜边朝西南内院）【推测落位，调研 §3.3】
const WYGJ_TOWER = [-78, -8637, -22, -8633, -20, -8584];

// We Young 168 退台（调研 §3.4：各层露台围着内院逐层后退，“向上张开”）：由 FP2.wygj / FP2.wygj_holes 用 shapely 离线求得
//   ——外轮廓 buffer(-6 / -12, 斜接) 再扣掉内院 buffer(+3 / +6)，开运算去细碎片后简化（G.inset 的简单斜接遇东北角缺口会自交）。
//   FP2 的未央国际轮廓若重新提取，需同步重算这几组坐标。
const WY168_T2 = [-51.1, -8618.9, -50.5, -8619.5, -42.7, -8613.9, -31.9, -8624.5, -27.2, -8624.5, -24.5, -8611.2, -24.7, -8587.6, -117.4, -8587.3, -117.6, -8590.9, -118.6, -8591, -118.6, -8615.1, -120.4, -8615.1, -120.6, -8627.2, -112.2, -8635.6, -53.1, -8635.6, -53.3, -8627.2, -74.4, -8626.2, -87.1, -8618.7, -96.6, -8608.8, -81.8, -8594.4, -66, -8594.6, -46.6, -8614.2];
const WY168_T3 = [
  [-100.9, -8608.8, -85.1, -8593.4, -111.7, -8593.3, -111.8, -8596.5, -112.6, -8596.5, -112.6, -8621.1, -114.5, -8621.1, -114.5, -8624.7, -109.7, -8629.6, -74.5, -8629.6, -88.9, -8621.1],
  [-31.7, -8616.3, -30.5, -8610.7, -30.7, -8593.6, -62.9, -8593.5, -47, -8609.5, -42.2, -8606],
];
// 庭院主入口：东北角 45° V 形缺口（调研 §3.2 (−47,−8625)(−43,−8622)(−34,−8631)；§3.5 招牌“在路口入口处”）
const WY168_GATE = [-40, -8626];

/** 同一栋楼的多块招牌依次取朝向：已被前面招牌占用的边不再选（否则两块字叠在同一面上 z-fighting） */
function facePicker(pts) {
  const used = new Set();
  return (dx, dz, minL = 12) => {
    const i = faceTowards(pts, dx, dz, minL, used);
    if (i >= 0) used.add(i);
    return i;
  };
}

// 凯悦（欧亚国际三期商业 4 号楼）：“叠石流水”——4 块圆角体块逐段错位微旋转叠起，总高约 100 m【推测造型，调研 §2】
export const HYATT = { cx: 6458, cz: -7833, blocks: [
  { w: 56, d: 32, h: 24, dx: 0, dz: 0, rot: 28 },
  { w: 52, d: 30, h: 26, dx: 2.5, dz: -1.5, rot: 33 },
  { w: 50, d: 29, h: 25, dx: -1.5, dz: 1.5, rot: 24 },
  { w: 46, d: 27, h: 25, dx: 1.5, dz: -1, rot: 30 },
], podium: { w: 96, d: 64, h: 22, dx: 6, dz: 18, rot: 28 } };

export function towerSpecs2() {
  const L = [];
  // ———————— 未央国际商圈（未央路 × 凤城七路 / 凤城八路） ————————
  L.push({
    key: 'wygjT', name: '未央国际', d: 'weiyang',
    // 25F / 99.6 m，镜面灰幕墙，三角形平面（DU 建筑，2020 竣工）
    pts: WYGJ_TOWER, h: 99.6, crown: { h: 5, color: '#dfe6ee', colW: 2.2 },
    style: { tint: '#3a4148', spd: '#4a5158', floorH: 3.9, colW: 1.5, spandrel: 0.2, mullW: 0.08, lit: 0.42, mode: 2, seed: 101 },
    signs: [{ text: '未央国际', color: '#ffffff', h: 4.4, faces: 2 }],
  });
  L.push({
    key: 'ihg', name: '西安经开洲际酒店', d: 'weiyang',
    // 22F 约 95 m【推测】，2019-12 开业
    pts: FP2.ihg, h: 95, crown: { h: 6, color: '#ffe2b8' },
    style: { tint: '#3d4a55', spd: '#b9ad9a', floorH: 3.7, colW: 1.7, spandrel: 0.36, lit: 0.55, seed: 102 },
    signs: [{ text: '洲际酒店', color: '#f4e4c6', h: 4.6, faces: 2, serif: true }],
  });
  L.push({
    key: 'ehb', name: 'EHB 企业总部大厦', d: 'weiyang',
    // 160 m / 35F，全玻璃 Low-E 幕墙（赛高城市广场 2 号楼），标准层约 50×50 m
    pts: G.rect(-144, -8979, 48, 46, 0, { chamfer: 2.5 }), h: 160, crown: { h: 9, color: '#e2ecff', colW: 2.6 },
    style: { tint: '#4d6576', spd: '#5b6771', floorH: 4.3, colW: 1.5, spandrel: 0.24, band: 12, lit: 0.36, mode: 2, seed: 103 },
    signs: [{ text: 'EHB', color: '#ffffff', h: 7, faces: 2 }],
  });
  for (const [k, hh, sd] of [['xuhuiA', 88, 104], ['xuhuiB', 86, 105]]) L.push({
    key: k, name: '旭辉中心' + k.slice(-1) + '座', d: 'weiyang', pts: FP2[k], h: hh, crown: { h: 5, color: '#e6eef8' },
    style: { tint: '#44606f', spd: '#6b7680', floorH: 3.9, colW: 1.5, spandrel: 0.28, lit: 0.38, seed: sd },
  });
  L.push({
    key: 'zhixuan', name: '智选假日酒店（经开店）', d: 'weiyang', pts: FP2.zhixuan, h: 56,
    style: { tint: '#3c4750', spd: '#c9bda8', floorH: 3.3, colW: 2.2, spandrel: 0.4, lit: 0.55, mode: 7, seed: 106 },
    signs: [{ text: '智选假日', color: '#7bd3ff', h: 3, faces: 1 }],
  });
  L.push({
    key: 'wygjzx', name: '未央国际中心', d: 'weiyang', pts: FP2.wygjzx, h: 68,
    style: { tint: '#3f5a70', spd: '#7a848c', floorH: 3.9, colW: 1.6, spandrel: 0.3, lit: 0.36, seed: 107 },
  });
  // ———————— 浐灞：欧亚大道两岸 ————————
  L.push({
    key: 'meridien', name: '西安浐灞艾美酒店', d: 'chanba',
    // 147 m / 32F，2017-11 开业；两河交汇半岛尖端，蓝灰玻璃幕墙、转角全玻璃
    // 原 11 m 暖色塔冠与“LE MERIDIEN 艾美”楼顶字均无照片/文字依据（research/refs/dossiers/east_west.json）：去掉，平顶
    pts: FP2.meridienT, h: 147,
    style: { tint: '#3b5566', spd: '#8e9aa4', floorH: 4.0, colW: 1.5, spandrel: 0.22, mullW: 0.1, lit: 0.5, seed: 111 },
    podium: { pts: FP2.meridienP, h: 18, style: { tint: '#35414b', spd: '#c9c2b6' } },
  });
  L.push({
    key: 'icc', name: '欧亚国际 ICC', d: 'chanba',
    // 欧亚国际一期 27F 办公（楼盘资料：27 层、标准层高 3.6 m；米数无出处，原 120 m 为推测）：27×3.6 ≈ 97 m + 屋顶 → 98 m
    pts: FP2.icc, h: 98, crown: { h: 6, color: '#dfe9ff' },
    style: { tint: '#3e5667', spd: '#5f6a73', floorH: 4.1, colW: 1.5, spandrel: 0.26, lit: 0.38, mode: 2, seed: 112 },
    signs: [{ text: '欧亚国际', color: '#ffffff', h: 4.6, faces: 2 }],
  });
  return L;
}

export function mallSpecs2() {
  const xdg = FP2.xidigang, drc = FP2.darongcheng, wy = FP2.wygj;
  const fx = facePicker(xdg), fd = facePicker(drc);
  return [
    // 熙地港：塔博曼设计“全钢式”商业，B1+L1–L6（6F 影院），檐口约 34 m【推测】；东南斜切面朝路口为主入口
    { key: 'xidigang', d: 'weiyang', pts: xdg, h: 34,
      style: { tint: '#4c5c68', spd: '#c9c6bf', floorH: 5.6, colW: 3.4, spandrel: 0.42 },
      signs: [{ text: 'CityOn熙地港', h: 6.5, faces: F(fx(1, 1, 30), fx(1, 0)) }, { text: '熙地港', h: 5, faces: F(fx(0, 1)) }],
      domes: [[-137, -8855, 11, 7], [-149, -8806, 11, 11], [-100, -8791, 9, 7], [-176, -8848, 8, 6], [-166, -8822, 7, 7], [-187, -8791, 8, 6], [-155, -8769, 9, 6], [-118, -8767, 8, 6]] },
    // 大融城 IMIX PARK：B1–5F，约 30 m；西北角半径约 70 m 的外凸弧面为主立面（玻璃幕墙 + 横向铝板带）
    { key: 'darongcheng', d: 'weiyang', pts: drc, h: 30,
      style: { tint: '#43586a', spd: '#d6d2c8', floorH: 5.6, colW: 2.6, spandrel: 0.36 },
      signs: [{ text: '大融城 IMIX PARK', h: 5.5, faces: F(fd(-1, -0.8, 20)) }, { text: '大融城', h: 5.5, faces: F(fd(0, 1), fd(-1, 0, 30)) }] },
    // 未央国际 · We Young 168 退台商业庭院（4~6 层，逐层后退的白色曲面栏板）；底层带内院（屋面挖空、院内立面朝内）
    { key: 'wy168a', d: 'weiyang', pts: wy, holes: FP2.wygj_holes, h: 9, style: { tint: '#3b4a57', spd: '#e6e3dc', floorH: 4.5 } },
    { key: 'wy168b', d: 'weiyang', pts: WY168_T2, h: 17, style: { tint: '#3b4a57', spd: '#e6e3dc', floorH: 4.2 } },
    { key: 'wy168c', d: 'weiyang', pts: WY168_T3[0], h: 24, style: { tint: '#3b4a57', spd: '#e6e3dc', floorH: 4.2 } },
    // 招牌挂在东北块朝西北、正对入口缺口的那面墙（约 14.7 m）；同块更长的西北向边（22.6 m）是内院墙面，不在入口处
    { key: 'wy168d', d: 'weiyang', pts: WY168_T3[1], h: 24, style: { tint: '#3b4a57', spd: '#e6e3dc', floorH: 4.2 },
      signs: [{ text: 'WE YOUNG 168', h: 2.6, faces: F(faceNear(WY168_T3[1], -1, -1, ...WY168_GATE)) }] },
    // 锦江国际酒店（原凯宾斯基，欧亚经济论坛永久会址）：三翼曲线形 5 层（huodongjia 场地资料；米数未查到，按 5 层推 24 m）；中部穹顶会议厅
    { key: 'jinjiang', d: 'chanba', pts: FP2.jinjiang, h: 24,
      style: { mode: 7, tint: '#34424c', spd: '#d8cfbf', floorH: 4.6, colW: 2.4, spandrel: 0.45 },
      signs: [{ text: '锦江国际酒店', h: 3.2, faces: 1, color: '#f4e4c6' }],
      domes: [[6469, -8625, 16, 9]] },
  ];
}

export const SPECIAL2 = {
  // 曲江·万众国际（WFive Park）+ 西安 W 酒店：C 形连体裙房（开口朝西北湖面）+ 三栋“下大上小、斜面收成尖”的塔楼（“山”字形）
  w: {
    site: FP2.wsite, podiumH: 24,
    towers: [
      { key: 'wHotel', name: '西安W酒店', pts: G.rect(3874, 6972, 58, 50, -10 * D, { chamfer: 3 }), h: 91.7, sign: 'W' },
      { key: 'wOfficeA', name: '万众国际A座', pts: G.rect(3802, 7150, 62, 50, -8 * D, { chamfer: 3 }), h: 96 },
      { key: 'wOfficeB', name: '万众国际B座', pts: G.rect(3884, 7128, 60, 50, -8 * D, { chamfer: 3 }), h: 96 },
    ],
    court: [3809, 7022], // 中心庭园（塔尖朝外）
  },
  hyatt: HYATT,
  // 灞河 2 号桥（浐灞二号桥，“彩虹桥”）：独塔双索面拱形斜塔斜拉桥，塔高 78 m，主跨 145 m，82 根索，夜间彩虹灯
  //   a/b 取 roads.json 两幅单向桥面（各宽 8 m、中心相距约 10 m）的中线；deckHalf：索面锚点离中线距离，
  //   贴着渲染出的桥面外缘（中线 ±8.7~9.1 m，实桥宽 29.6 m 但路网只有两幅 8 m 车行道）
  rainbow: { a: [6938.0, -8310.3], b: [7263.9, -8699.4], t: 0.4, archH: 78, archHalf: 19, tilt: 13 * D, cables: 41, span: 145, back: 105, deckHalf: 9.4 },
  // 浐灞 1 号桥（“蝴蝶桥”，欧亚大道跨浐河）：80 m 主跨，两片拱肋各向外倾 20°；a/b 同样取两幅桥面中线，
  //   拱脚/吊杆落在桥面外缘（中线 ±8.3~9.0 m）
  butterfly: { a: [6523.7, -7975.7], b: [6638.1, -8047.7], span: 80, rise: 17, half: 9.4, lean: 20 * D },
  // “后海”东岸灞河东路：观景步道 + 后海星光汇夜市（约 1.5 km 摊位灯串）；摊位沿真实道路（road）向河一侧偏 offset，
  //   a→b 只限定路段范围（直线与道路中段相差近 200 m，会落进东侧锦绣湖）
  houhai: { a: [7301, -8775], b: [6371, -10006], offset: -24, road: '灞河东路' },
};

/** SPECIAL2 占地多边形（prepare 排除区） */
/** 特殊地标占地（排除区用）；live.w / live.hyatt = false 表示该地标已被逐栋档案替代、不再建 */
export function special2Footprints(live = {}) {
  const S = SPECIAL2, out = [];
  if (live.w !== false) {
    out.push(G.ccw(S.w.site));
    for (const t of S.w.towers) out.push(G.ccw(t.pts));
  }
  const H = S.hyatt;
  if (live.hyatt !== false) out.push(G.rect(H.cx + H.podium.dx, H.cz + H.podium.dz, H.podium.w + 6, H.podium.d + 6, H.podium.rot * D));
  return out;
}
