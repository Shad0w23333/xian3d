// 电视塔东侧华润两座综合体：西安万象城（华润国际文化商业中心 / 西安 CCBD，雁展路南）与西安万象天地（雁展路北）。
// 调研：research/refs/mixc/notes.md（每个数值的来源与可信度标记都在那里）；几何：src/arch/mixc.js。
// 要点（均有来源）：
//   · 万象城 2024-12-09 开业；规划公示 137.911 亩、总建面 56.54 万㎡；四塔 A 147.6 / B 148.8 / C 150.95 / D 150.95 m（OSM 层数 33/32/37/37）；
//     裙楼与“生命之树”由 Heatherwick Studio 设计：10 万多片釉面陶板包裹立柱与曲梁，屋檐“翼角飞檐”；树从地下一层起算 57 m，56 个花瓣平台。
//   · 万象天地 2021-07-17 开业，雁展路 1111 号，一期约 10 万㎡，“街区 + Mall”：集中式商场 + 形态各异的独栋围合街巷，圆形广场。
//     街区内 8 栋高层的楼高没有公开资料，用卫星双视差估算（见笔记第 1 节表格，标【视差】）。
// 轮廓：Overture 2026-09（OSM）逐块实测轮廓（way 号见 FP 注释），世界坐标 X 东、Z 南。
import * as THREE from 'three';
import * as G from '../arch/sky-geom.js';
import { createFacadeMaterial } from '../arch/sky-facade.js';
import { SignAtlas, Beacons, solidMats, Batcher } from '../arch/sky-towers.js';
import * as MX from '../arch/mixc.js';

/** 有贴图的材质自动套“米制”UV（贴图自带 UV 的除外；与 skyline 的 SBatcher 相同） */
class SBatcher extends Batcher {
  add(g, m, mtx = null, o = {}) {
    if (m.map && !m.userData.ownUV && !o.worldUV) o = { ...o, worldUV: 1 };
    return super.add(g, m, mtx, o);
  }
}

// ───────────── OSM 轮廓（tools/geo.py project 后的世界坐标，已去共线点） ─────────────
const FP = {
  A: [152.7, 6946.2, 152.7, 6995.7, 196.0, 6995.7, 196.0, 6946.2], // w1344060603
  B: [194.6, 7117.3, 152.7, 7117.3, 152.7, 7166.4, 194.6, 7166.4], // w1344060011
  C: [260.7, 7226.9, 260.7, 7222.0, 265.1, 7222.0, 265.1, 7205.2, 260.7, 7205.2, 260.7, 7200.3, 245.4, 7200.3, 245.4, 7198.4, 223.5, 7198.4, 223.5, 7200.3, 208.1, 7200.3, 208.1, 7205.2, 203.8, 7205.2, 203.8, 7222.0, 208.1, 7222.0, 208.1, 7226.9, 223.5, 7226.9, 223.5, 7228.8, 245.4, 7228.8, 245.4, 7226.9], // w1344060344
  D: [203.8, 6895.7, 203.8, 6912.5, 208.1, 6912.5, 208.1, 6917.4, 223.5, 6917.4, 223.5, 6919.3, 245.4, 6919.3, 245.4, 6917.4, 260.7, 6917.4, 260.7, 6912.5, 265.1, 6912.5, 265.1, 6895.7, 260.7, 6895.7, 260.7, 6890.8, 245.4, 6890.8, 245.4, 6888.9, 223.5, 6888.9, 223.5, 6890.8, 208.1, 6890.8, 208.1, 6895.7], // w1344060508
  n1: [191.6, 6884.7, 164.8, 6884.7, 164.8, 6900.7, 185.0, 6900.7, 185.0, 6916.9, 191.6, 6916.9], // w1344060583
  n2: [147.3, 6889.9, 147.3, 6916.8, 156.4, 6916.8, 156.4, 6900.7, 164.8, 6900.7, 164.8, 6889.9], // w1344060476
  n3: [156.4, 6900.7, 156.4, 6946.2, 185.0, 6946.2, 185.0, 6900.7], // w1344060374
  n4: [143.1, 6916.8, 143.1, 6954.5, 152.7, 6954.5, 152.7, 6946.2, 156.4, 6946.2, 156.4, 6916.8], // w1344060071
  w1: [200.3, 7041.8, 200.3, 6988.7, 196.0, 6988.7, 196.0, 6995.7, 169.4, 6995.7, 169.4, 7041.8], // w1344060049
  w2: [169.4, 7117.3, 194.6, 7117.3, 194.6, 7132.1, 200.3, 7132.1, 200.3, 7069.3, 169.4, 7069.3], // w1344059922
  w3: [160.5, 7166.4, 160.5, 7194.6, 191.4, 7194.6, 191.4, 7166.4], // w1344060305
  w4: [156.2, 7199.8, 169.3, 7199.8, 169.3, 7194.6, 160.5, 7194.6, 160.5, 7166.4, 156.2, 7166.4], // w1344060016
  w5: [160.3, 7199.8, 160.3, 7218.5, 178.2, 7218.5, 178.2, 7212.9, 169.3, 7212.9, 169.3, 7199.8], // w1344060345
  w6: [205.5, 7222.0, 203.8, 7222.0, 203.8, 7212.9, 178.2, 7212.9, 178.2, 7223.9, 205.5, 7223.9], // w1344060018
  ent: [188.2, 7069.3, 192.6, 7069.3, 192.6, 7041.8, 188.2, 7041.8], // w1344059981
  m1: [226.0, 6943.2, 226.0, 6986.2, 247.8, 6986.2, 247.8, 6943.2], // w1344059983
  m2: [256.0, 6920.8, 245.4, 6920.8, 245.4, 6943.2, 247.8, 6943.2, 247.8, 6948.9, 256.0, 6948.9], // w1344059979
  m3: [256.0, 6948.5, 256.0, 6948.9, 247.8, 6948.9, 247.8, 6975.3, 257.0, 6975.3, 257.0, 6997.3, 264.8, 6997.3, 264.8, 6948.5], // w1344060548
  m4: [257.0, 7018.8, 257.0, 6975.3, 247.8, 6975.3, 247.8, 6986.2, 230.1, 6986.2, 230.1, 7018.8], // w1344060116
  m5: [230.1, 7118.2, 257.0, 7118.2, 257.0, 7092.5, 230.1, 7092.5], // w1344060587
  m6: [226.0, 7173.0, 269.8, 7173.0, 269.8, 7118.2, 226.0, 7118.2], // w1344060394
  ring: [247.4, 7039.2, 247.4, 7018.8, 242.2, 7018.8, 242.2, 7036.0, 220.9, 7036.0, 220.9, 7075.2, 242.2, 7075.2, 242.2, 7092.5, 247.4, 7092.5, 247.4, 7072.1, 245.4, 7070.1, 226.0, 7070.1, 226.0, 7041.1, 245.4, 7041.1], // w1344060539
  e1: [324.5, 6874.8, 299.5, 6874.8, 299.5, 6906.5, 324.5, 6906.5], // w1344059840
  e2: [328.0, 6890.0, 324.5, 6890.0, 324.5, 6906.5, 306.7, 6906.5, 306.7, 6916.5, 319.3, 6916.5, 319.3, 6925.1, 328.0, 6925.1], // w1344059839
  e3: [319.3, 6916.5, 299.5, 6916.5, 299.5, 6946.9, 319.3, 6946.9], // w1344059838
  e4: [328.1, 6946.9, 292.0, 6946.9, 292.0, 6986.5, 328.1, 6986.5], // w1344059836
  e5: [319.2, 6986.5, 299.4, 6986.5, 299.4, 7018.3, 319.2, 7018.3], // w1344059834
  e6: [328.0, 7007.2, 319.2, 7007.2, 319.2, 7018.3, 305.9, 7018.3, 305.9, 7029.2, 328.0, 7029.2], // w1344059833
  e7: [322.2, 7092.8, 327.0, 7092.8, 327.0, 7104.1, 328.7, 7104.1, 328.7, 7076.6, 314.5, 7076.6, 314.5, 7079.4, 319.6, 7084.5, 324.2, 7079.9, 327.1, 7079.9, 327.1, 7084.2, 322.2, 7089.2], // w1344060211
  e8: [327.0, 7130.4, 327.0, 7092.8, 291.4, 7092.8, 291.4, 7112.0, 269.8, 7112.0, 269.8, 7105.7, 257.0, 7105.7, 257.0, 7118.2, 269.8, 7118.2, 269.8, 7126.8, 287.3, 7126.8, 287.3, 7118.3, 316.6, 7118.3, 316.6, 7130.4], // r18444593
  e9: [311.4, 7162.5, 316.6, 7162.5, 316.6, 7118.3, 287.3, 7118.3, 287.3, 7146.1, 311.4, 7146.1], // w1344060155
  e10: [285.0, 7146.1, 285.0, 7189.1, 311.4, 7189.1, 311.4, 7146.1], // w1344060440
  e11: [274.1, 7197.7, 274.1, 7215.9, 305.0, 7215.9, 305.0, 7189.1, 286.5, 7189.1, 286.5, 7197.7], // w1344059852
  k28: [391.9, 6706.1, 403.2, 6713.3, 407.5, 6707.4, 411.5, 6686.9, 409.4, 6686.8, 409.1, 6675.9, 410.7, 6675.9, 410.7, 6670.5, 419.7, 6658.2, 418.0, 6656.7, 420.6, 6653.5, 417.3, 6647.5, 417.0, 6644.4, 414.4, 6644.0, 414.6, 6640.3, 415.6, 6637.4, 417.9, 6632.9, 420.3, 6634.9, 423.7, 6631.0, 427.2, 6628.1, 436.4, 6623.2, 436.1, 6620.2, 441.3, 6618.9, 449.3, 6618.2, 449.5, 6621.3, 456.1, 6621.7, 460.5, 6622.9, 467.0, 6626.9, 469.7, 6631.4, 471.0, 6634.4, 470.6, 6637.1, 467.2, 6639.4, 465.3, 6642.4, 464.9, 6644.5, 465.7, 6647.8, 467.2, 6650.1, 469.5, 6652.3, 471.4, 6653.3, 473.9, 6653.5, 476.5, 6652.7, 479.6, 6673.0, 548.0, 6674.0, 549.6, 6601.0, 547.9, 6601.0, 548.3, 6584.8, 386.7, 6582.9, 386.7, 6586.1, 369.7, 6585.7, 369.3, 6599.1, 372.3, 6599.1, 371.4, 6647.7, 367.2, 6647.7, 367.3, 6676.0, 367.6, 6676.3, 405.2, 6675.9, 405.6, 6686.3, 394.6, 6685.7, 394.1, 6702.5], // w1409939928
  k37: [456.5, 6761.8, 460.8, 6761.7, 462.4, 6761.0, 463.9, 6759.7, 464.8, 6757.0, 464.8, 6733.3, 462.8, 6733.3, 462.6, 6664.4, 453.5, 6656.7, 444.6, 6659.8, 432.2, 6660.1, 424.3, 6682.1, 424.6, 6733.6, 425.9, 6736.4, 436.3, 6743.8, 435.4, 6745.7], // w1409939937
  k46: [312.6, 6753.9, 312.6, 6792.5, 447.2, 6791.9, 447.2, 6786.9, 455.8, 6775.9, 429.3, 6754.7], // w1409939946
  k27: [300.4, 6669.7, 299.5, 6708.7, 311.5, 6708.9, 311.6, 6706.8, 351.2, 6707.6, 351.9, 6670.8], // w1409939927
  k12: [316.1, 6654.2, 348.6, 6654.7, 355.1, 6631.5, 316.7, 6631.5], // w1409939912
  k11: [294.2, 6635.2, 293.7, 6647.9, 304.1, 6648.3, 304.8, 6628.0, 299.6, 6627.8, 299.8, 6622.1, 290.6, 6621.8, 290.2, 6635.0], // w1409939911
  k34: [303.8, 6721.6, 303.6, 6729.3, 316.1, 6740.1, 328.8, 6740.1, 329.3, 6738.5, 335.3, 6738.1, 341.7, 6717.9, 332.1, 6717.9, 326.5, 6721.9], // w1409939934
  k35: [347.3, 6723.9, 341.4, 6740.9, 371.5, 6739.5, 384.1, 6730.0, 392.1, 6722.3, 381.7, 6715.6, 381.0, 6717.1, 378.0, 6715.1, 372.1, 6720.5, 355.5, 6720.2, 355.0, 6722.2, 353.3, 6722.2, 352.5, 6724.3], // w1409939935
  k39: [473.3, 6723.6, 472.1, 6769.6, 497.4, 6770.3, 497.4, 6768.3, 499.5, 6768.3, 499.7, 6763.0, 479.6, 6762.5, 480.4, 6731.7, 493.7, 6732.0, 494.2, 6712.8, 478.8, 6712.4, 478.5, 6723.7], // w1409939939
  k38: [543.5, 6748.1, 541.4, 6751.9, 566.8, 6766.5, 576.3, 6751.8, 549.8, 6736.5, 550.4, 6735.5, 553.1, 6734.3, 557.0, 6739.1, 577.7, 6727.4, 569.8, 6713.5, 549.7, 6723.7, 549.1, 6722.9, 538.9, 6728.5, 528.2, 6722.9, 527.8, 6723.8, 508.2, 6712.9, 500.4, 6728.3, 519.1, 6738.4, 521.2, 6734.9, 523.2, 6736.1, 525.2, 6733.6, 527.4, 6735.3, 527.0, 6736.9, 502.1, 6751.7, 509.4, 6766.3, 535.2, 6751.8, 532.9, 6747.9, 535.4, 6746.4, 533.3, 6742.1, 536.1, 6739.6, 543.3, 6743.1, 541.2, 6746.8], // w1409939938
  k24: [512.1, 6702.6, 548.9, 6703.8, 549.7, 6693.1, 556.3, 6693.5, 556.8, 6685.0, 540.8, 6687.4, 512.6, 6696.9], // w1409939924
  k41: [532.2, 6765.9, 531.9, 6774.0, 561.6, 6775.1, 561.8, 6771.0, 549.5, 6770.6, 549.8, 6762.1, 540.4, 6761.7, 540.2, 6766.2], // w1409939941
  k53: [498.2, 6786.9, 497.5, 6811.6, 509.5, 6811.9, 509.8, 6802.1, 573.7, 6804.0, 573.7, 6802.8, 578.6, 6803.0, 579.0, 6789.2], // w1409939953
  k51: [479.9, 6778.3, 472.5, 6778.4, 473.1, 6810.4, 480.5, 6810.2], // w1409939951
  k52: [588.0, 6778.2, 584.3, 6778.2, 583.8, 6811.8, 587.5, 6811.9], // w1409939952
};

// 地块（让位 / 平整范围）
const SITE_CCBD = [138, 6866, 336, 6866, 336, 7237, 138, 7237];
const SITE_MT = [286, 6605, 362, 6605, 362, 6574, 594, 6574, 594, 6817, 286, 6817];
// 生命之树与圆形下沉庭院：OSM 生命之树轮廓质心 (278.3, 7054.7)，影像量得坑半径约 20 m；坑深 7 m【推测】
const TREE = { cx: 278, cz: 7056, pitR: 19.5, depth: 7 };

// 万象城塔楼：公示高度；弧形凹顶下凹量按东立面 g028 量取【推测】；幕墙浅蓝灰反射玻璃 + 古铜竖线 + 深色百叶横带（照片 c_1/c_2/c_4）
const TOWER_STYLE = { tint: '#6f8898', spd: '#8e7a5c', floorH: 4.2, colW: 1.5, spandrel: 0.2, mullW: 0.13, band: 11, lit: 0.36, mode: 0 };
const CCBD_TOWERS = [
  { key: 'A', name: '华润国际文化商业中心A座', h: 147.6, rise: 4.5, seed: 21,
    signs: [{ text: '华润置地', face: [-1, 0], at: 0.72, down: 10, h: 5.2, color: '#e0bd72' }] },
  { key: 'B', name: '华润国际文化商业中心B座', h: 148.8, rise: 4.5, seed: 22 },
  { key: 'C', name: '华润国际文化商业中心C座', h: 150.95, rise: 3.5, seed: 23, style: { spandrel: 0.3, colW: 1.35 } },
  { key: 'D', name: '华润国际文化商业中心D座', h: 150.95, rise: 3.5, seed: 24, style: { spandrel: 0.3, colW: 1.35 } },
];

// 万象城裙楼“盒子”：h 为屋面高（OSM 有标签的直接用；否则参考 CMAB 并按 g028 立面控制在 20–35 m）；
// roof：grass 屋顶花园 / glass 采光顶 / gray（按 Google 影像判读）；red：上段深红褶皱板的比例
const CCBD_BOXES = [
  // 西列（长安南路一侧）
  { k: 'n1', h: 22, roof: 'gray', red: 0.7 },
  { k: 'n2', h: 9, roof: 'gray', red: 0 },
  { k: 'n3', h: 26, roof: 'glass', red: 0.5 },
  { k: 'n4', h: 14, roof: 'grass', red: 0.3 },
  { k: 'w1', h: 30, roof: 'glass', red: 0.75 }, // 2 区（CMAB 32.2 m）
  { k: 'ent', h: 9, roof: 'gray', red: 0, band: 1.4 }, // 西主入口雨棚（正对电视塔）
  { k: 'w2', h: 35.3, roof: 'glass', red: 0.6 }, // 1 区：OSM 35.3 m / 5F
  { k: 'w3', h: 24, roof: 'grass', red: 0.5 }, // 2 号楼
  { k: 'w4', h: 12, roof: 'grass', red: 0.2 },
  { k: 'w5', h: 8, roof: 'gray', red: 0 },
  { k: 'w6', h: 12, roof: 'grass', red: 0.3 },
  // 中列
  { k: 'm1', h: 24, roof: 'glass', red: 0.6 },
  { k: 'm2', h: 17.3, roof: 'grass', red: 0.4 }, // OSM 17.3 m / 3F
  { k: 'm3', h: 9, roof: 'grass', red: 0 }, // OSM 1F，屋顶绿化
  { k: 'm4', h: 30, roof: 'grass', red: 0.7 }, // CMAB 32.2 m
  { k: 'm5', h: 18, roof: 'grass', red: 0.5 },
  { k: 'm6', h: 30, roof: 'glass', red: 0.6 },
  // 东列（汇新路一侧，OSM 11.7 m/2F、17.3 m/3F）
  { k: 'e1', h: 11.7, roof: 'grass', red: 0.4 },
  { k: 'e2', h: 14.2, roof: 'grass', red: 0.3 },
  { k: 'e3', h: 15.4, roof: 'grass', red: 0.5 },
  { k: 'e4', h: 17.3, roof: 'grass', red: 0.6 }, // 3 号楼
  { k: 'e5', h: 17.3, roof: 'grass', red: 0.5 },
  { k: 'e6', h: 11.7, roof: 'grass', red: 0.4 },
  { k: 'e7', h: 8, roof: 'gray', red: 0 },
  { k: 'e8', h: 11.7, roof: 'grass', red: 0.4 },
  { k: 'e9', h: 17.3, roof: 'grass', red: 0.6 },
  { k: 'e10', h: 15.4, roof: 'grass', red: 0.5 },
  { k: 'e11', h: 18, roof: 'glass', red: 0.6 },
];
// 西侧裙楼之间的南北向屋顶花园（总平面 g030 的绿带）：2~3 层基座，屋顶草坪 + 叶形/星形/三角形天窗
const SPINE = [
  { pts: [196, 6921, 226, 6921, 226, 7036, 200.3, 7036, 200.3, 7042, 196, 7042], h: 14 },
  { pts: [200.3, 7075, 226, 7075, 226, 7197, 200.3, 7197], h: 14 },
];
const SKYLIGHTS = {
  lens: [{ cx: 211, cz: 7020, L: 30, W: 13 }, { cx: 212, cz: 7094, L: 26, W: 12 }, { cx: 212, cz: 7136, L: 22, W: 11 }],
  star: [{ cx: 211, cz: 6978, R: 9, r: 3.2, n: 4 }, { cx: 211, cz: 6942, R: 8, r: 4, n: 3 }],
};
// 银杏：中间南北步行街与树心广场（照片 g001/g002）
const GINKGO = [[272, 6896], [286, 6900], [272, 6930], [286, 6935], [272, 6962], [286, 6966], [268, 7004], [288, 7010],
  [238, 7030], [236, 7084], [266, 7100], [288, 7104], [272, 7145], [274, 7180]];

// 万象天地裙房 / 独栋：高度未证实（主 Mall 取 18–22 m：照片中圆形广场有 3 层退台；独栋 6–18 m 按影像视差）【推测】
const MT_POD = { mode: 6, tint: '#2c353d', spd: '#c7cacc', floorH: 5.2, colW: 2.6, spandrel: 0.22, mullW: 0.14, lit: 0.95 };
const MT_STONE = { mode: 7, tint: '#2f3840', spd: '#d4d0c8', floorH: 5.0, colW: 3.2, spandrel: 0.5, lit: 0.8 };
const MT_DARK = { mode: 6, tint: '#1f262c', spd: '#3d4449', floorH: 4.6, colW: 1.8, spandrel: 0.12, lit: 0.95 };
const MT_BLOCKS = [
  { k: 'k28', h: 18, style: MT_POD, perf: 0.55 }, // 圆形广场一侧照片可见 3 层退台 + 屋顶绿篱
  { k: 'k37', h: 22, style: MT_POD, perf: 0.5 },
  { k: 'k46', h: 20, style: MT_POD, perf: 0.4 },
  { k: 'k27', h: 20, style: MT_STONE },
  { k: 'k12', h: 15, style: MT_DARK },
  { k: 'k11', h: 18, style: MT_STONE },
  { k: 'k34', h: 14, style: MT_POD, perf: 0.6 },
  { k: 'k35', h: 24, style: { ...MT_POD, tint: '#39444c', spd: '#e6e6e2' }, louver: true }, // “the mixc 万象天地”白色百叶盒子【推测落位】
  { k: 'k39', h: 16, style: MT_DARK },
  { k: 'k38', h: 17, style: MT_STONE },
  { k: 'k24', h: 10, style: MT_DARK },
  { k: 'k41', h: 8, style: MT_POD },
  { k: 'k53', h: 9, style: MT_POD },
  { k: 'k51', h: 6, style: MT_DARK },
  { k: 'k52', h: 6, style: MT_DARK },
];
// 万象天地街区内 8 栋高层：底座与楼高均为 Google/Esri 双视差估算【视差】；名称与用途未证实
const MT_TOWERS = [
  { key: 'MT1', r: [410, 447, 6582, 6612], h: 54, style: { tint: '#5a7280', spd: '#bfc3c6', floorH: 3.6, colW: 1.9, spandrel: 0.36 } },
  { key: 'MT2', r: [467, 503, 6582, 6610], h: 95, style: { tint: '#4e6676', spd: '#c4c8cb', floorH: 3.6, colW: 1.9, spandrel: 0.36 } },
  { key: 'MT3', r: [517, 553, 6630, 6672], h: 97, style: { tint: '#52697a', spd: '#bcc1c5', floorH: 3.6, colW: 1.9, spandrel: 0.34 } },
  { key: 'MT4', r: [312, 351, 6667, 6702], h: 97, style: { tint: '#3e5566', spd: '#6c7781', floorH: 4.0, colW: 1.5, spandrel: 0.24, band: 10 } },
  { key: 'MT5', r: [370, 409, 6645, 6675], h: 94, style: { tint: '#44596a', spd: '#737e87', floorH: 4.0, colW: 1.5, spandrel: 0.26, band: 10 } },
  { key: 'MT6', r: [427, 465, 6680, 6731], h: 102, style: { tint: '#3b5163', spd: '#66717b', floorH: 4.0, colW: 1.5, spandrel: 0.22, band: 11 } },
  { key: 'MT7', r: [314, 360, 6752, 6794], h: 102, style: { tint: '#3f5668', spd: '#6a7580', floorH: 4.0, colW: 1.5, spandrel: 0.24, band: 11 } },
  { key: 'MT8', r: [381, 433, 6752, 6789], h: 160, helipad: true, style: { tint: '#34485a', spd: '#5f6a74', floorH: 4.2, colW: 1.5, spandrel: 0.2, band: 12, mode: 2 } },
];
// 圆形广场（w1409939928 的弧形缺口：圆心约 (443, 6644)、半径约 27 m，向南敞开）与东侧圆柱玻璃体量（影像直径约 18 m；照片中比两侧 3 层退台高出一层，按 4 层 21 m，未证实）
const MT_PLAZA = { cx: 443, cz: 6644, r: 27, a0: Math.PI - 0.45, a1: 2 * Math.PI + 0.25, levels: 3, floorH: 5.2 };
const MT_DRUM = { cx: 475, cz: 6643, r: 9, h: 21, floorH: 5.2 };

// 店招：取 pois.json 中落在街区内的真实店名，挂到最近的一面墙上（品牌色底 + 白字）
const SHOPS = [
  ['万象影城', '#8a6a3a'], ['盒马鲜生', '#1f7de0'], ['华润万家', '#d8141d'], ['海底捞火锅', '#d91f26'], ['星巴克', '#00704a'],
  ['肯德基', '#d8102b'], ['小米之家', '#ff6a00'], ['喜茶', '#2b2b2b'], ['奈雪的茶', '#d9408a'], ['名创优品', '#d8141d'], ['达美乐比萨', '#006491'],
  ['无印良品', '#7f0019'], ['DJI大疆哈苏', '#2b2b2b'], ['HASSELBAD哈苏相机', '#2b2b2b'],
];

export default {
  id: 'mixc',
  name: '西安万象城·万象天地',
  prepare(ctx) {
    // 平整：两块地块各自取平均地面（万象城南北原始地形约差 4 m）
    this.baseC = ctx.terrain.addFlatten({ points: SITE_CCBD, height: null, feather: 22 });
    this.baseM = ctx.terrain.addFlatten({ points: SITE_MT, height: null, feather: 18 });
    // 生命之树圆形下沉庭院：坑内压到坑底（范围外扩 3.5 m，外圈由铺装环盖住）
    ctx.terrain.addFlatten({ points: G.circle(TREE.cx, TREE.cz, TREE.pitR + 3.5, 40), height: this.baseC - TREE.depth, feather: 3, mode: 'min' });
    // 让位：通用建筑 / 树木 / POI 招牌（店招由本模块挂）；skyline 的批量地标（landmarks2026 的万象城/万象天地条目）因质心落在
    //   buildings 排除区内自动跳过；sunken 模块看 sunken 标记跳过 CCBD 下沉广场条目（本模块自己做生命之树圆坑）。
    //   两块地块内没有 skyline.json 的 OSM 实测高层（已核对），所以 skyline 的 genericFeatures 不需要改。
    const flags = { buildings: true, trees: true, pois: true, sunken: true };
    ctx.exclusions.add({ points: SITE_CCBD, name: '西安万象城' }, flags);
    ctx.exclusions.add({ points: SITE_MT, name: '西安万象天地' }, flags);
    // roads.json 里 x≈322 的一条 service 路（地库坡道/内部通道）穿过万象城东列盒子，地面段在此让位
    ctx.exclusions.add({ points: [296, 6868, 334, 6868, 334, 7232, 296, 7232], name: '万象城东列' }, { buildings: false, trees: false, pois: false, roads: true });
  },

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '西安万象城·万象天地';
    ctx.scene.add(root);
    const mats = solidMats(ctx);
    mats.heli.userData.ownUV = true;
    const M = MX.mixcMats(ctx);
    const E = { ctx, fb: new G.FacadeBuilder(), solid: new SBatcher(), detail: new SBatcher(), mats, signs: new SignAtlas(ctx, 2048, 1024, { rowH: 110 }), beacons: new Beacons(ctx) };
    const errors = [];
    const safe = (name, fn) => { try { fn(); } catch (e) { console.error('[mixc]', name, e); errors.push(name); } };
    const bC = this.baseC ?? ctx.terrain.heightAt(230, 7050), bM = this.baseM ?? ctx.terrain.heightAt(440, 6700);

    // ═════════════ 西安万象城（华润 CCBD） ═════════════
    for (const t of CCBD_TOWERS) safe(t.name, () => MX.arcTower(E, M, {
      key: t.key, name: t.name, pts: FP[t.key], h: t.h, rise: t.rise, base: bC,
      style: { ...TOWER_STYLE, ...(t.style || {}), seed: t.seed }, signs: t.signs,
    }));
    const T = { cer: new MX.Tris(), sof: new MX.Tris(), red: new MX.Tris() };
    for (const b of CCBD_BOXES) safe(b.k, () => MX.framedBox(E, M, { key: b.k.charCodeAt(0) + b.k.length * 7, pts: FP[b.k], base: bC, h: b.h, roof: b.roof, red: b.red, band: b.band }, T));
    for (const s of SPINE) safe('spine', () => MX.framedBox(E, M, { key: 3, pts: s.pts, base: bC, h: s.h, roof: 'grass', red: 0.2 }, T));
    for (const l of SKYLIGHTS.lens) safe('lens', () => MX.lensSkylight(E, M, { ...l, H: 3.2, rot: Math.PI / 2, y0: bC + 14.1 }));
    for (const s of SKYLIGHTS.star) safe('star', () => MX.starSkylight(E, M, { ...s, H: 4, rot: 0.3, y0: bC + 14.1 }));
    // 树心广场外圈的 C 形雨棚（OSM building=roof w1344060539）：8 m 高陶板檐板
    safe('ring', () => {
      const p = G.ccw(FP.ring);
      E.solid.add(G.wallGeometry(p, p, bC + 7.2, bC + 8.4), M.ceramic, null, { worldUV: 1 });
      E.solid.add(G.capGeometry(p, bC + 8.4), M.ceramic, null, { worldUV: 1 });
      E.solid.add(G.capGeometry(p, bC + 7.2, { down: true }), M.soffit, null, { worldUV: 1 });
      for (let i = 0; i < p.length; i += 4) E.detail.add(G.cyl(p[i], bC, p[i + 1], 0.22, 0.22, 7.2, 8), M.bronze);
    });
    // 陶板框架批量几何
    if (!T.cer.empty) E.solid.add(T.cer.geometry(), M.ceramic, null, { worldUV: 1 });
    if (!T.sof.empty) E.solid.add(T.sof.geometry(), M.soffit, null, { worldUV: 1 });
    if (!T.red.empty) E.solid.add(T.red.geometry(), M.pleat, null, { worldUV: 1 });
    // 灵感之桥（OSM w1344060323）：二层连廊横跨南北步行街
    safe('bridge', () => MX.bridge(E, M, { ax: 264.8, az: 6981.85, bx: 292, bz: 6981.85, w: 4.5, y: bC + 7.2, th: 1.2 }));
    // 广场铺装（灰色石材 + 深色弧线鳞纹，照片 g007）；下沉圆坑与外圈铺装环处挖空
    safe('pave', () => MX.paving(E, M.pave, SITE_CCBD, [G.circle(TREE.cx, TREE.cz, TREE.pitR + 8.9, 40)], bC + 0.08));
    // 生命之树 + 圆形下沉庭院
    const y0 = bC - TREE.depth;
    safe('pit', () => MX.sunkenCourt(E, M, { cx: TREE.cx, cz: TREE.cz, r: TREE.pitR, y0, top: bC, deck: 9 }));
    safe('tree', () => MX.buildTree(E, M, { cx: TREE.cx, cz: TREE.cz, y0, petals: treePetals() }));
    for (const [x, z] of GINKGO) safe('ginkgo', () => MX.ginkgo(E, M, x, bC, z, 0.95 + MX.hash(x, z) * 0.2));
    // 招牌：mixc 万象城（香槟金字，挂在深红褶皱板上：西入口两侧、北立面、东立面）
    const signOn = (k, dx, dz, y, h, text = 'mixc 万象城', color = '#efe2c2') => { // 香槟银白字（照片 N2289 / Commons 3）
      const e = MX.pickFace(FP[k], dx, dz);
      if (e) E.signs.place(text, { x: (e.ax + e.bx) / 2, y, z: (e.az + e.bz) / 2 }, e.nx, e.nz, h, e.L * 0.7, { color, weight: 800 });
    };
    safe('signs', () => {
      signOn('w1', -1, 0, bC + 24, 3.4);
      signOn('n1', 0, -1, bC + 16, 3.0);
      signOn('e4', 1, 0, bC + 12, 2.6);
      signOn('e11', 0, 1, bC + 12.5, 2.4);
    });

    // ═════════════ 西安万象天地 ═════════════
    for (const b of MT_BLOCKS) safe(b.k, () => MX.mtBlock(E, M, {
      pts: FP[b.k], h: b.h, base: bM, style: { ...b.style, seed: b.k.length * 13 + b.h }, perf: b.perf, louver: b.louver,
      roofMat: b.h > 12 && MX.hash(b.h, b.k.length) < 0.5 ? mats.grass : null,
    }));
    for (const t of MT_TOWERS) safe(t.key, () => {
      const [x0, x1, z0, z1] = t.r;
      MX.plainTower(E, { key: t.key, pts: G.rect((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0, 0, { chamfer: 1.2 }), h: t.h, base: bM, helipad: t.helipad, style: { lit: 0.42, mullW: 0.1, ...t.style, seed: 60 + t.h } });
    });
    safe('mtPave', () => MX.paving(E, mats.granite, SITE_MT, [], bM + 0.08));
    safe('plaza', () => MX.roundPlaza(E, M, { ...MT_PLAZA, base: bM }));
    safe('drum', () => MX.glassDrum(E, M, { ...MT_DRUM, base: bM }));
    safe('mtSigns', () => {
      // “the mixc 万象天地”：玫红字（照片 t2_1），挂在白色百叶盒子顶部两面【落位推测】
      const k = FP.k35;
      for (const [dx, dz] of [[0, 1], [-1, 0]]) {
        const e = MX.pickFace(k, dx, dz, 8);
        if (e) E.signs.place('the mixc 万象天地', { x: (e.ax + e.bx) / 2, y: bM + 21.5, z: (e.az + e.bz) / 2 }, e.nx, e.nz, 2.6, e.L * 0.85, { color: '#d9466c', weight: 800 });
      }
      // 沿雁展路的主 Mall 立面
      const e = MX.pickFace(FP.k46, 0, 1, 20);
      if (e) E.signs.place('万象天地', { x: e.ax + (e.bx - e.ax) * 0.8, y: bM + 16.5, z: e.az + (e.bz - e.az) * 0.8 }, e.nx, e.nz, 3.2, 26, { color: '#d9466c', weight: 800 });
    });
    // 店招（pois.json 真实店名）
    safe('shops', () => shopSigns(ctx, E, [
      ...CCBD_BOXES.map((b) => ({ pts: FP[b.k], base: bC })),
      ...MT_BLOCKS.map((b) => ({ pts: FP[b.k], base: bM })),
    ]));

    // ═════════════ 输出 ═════════════
    const fmat = createFacadeMaterial(ctx);
    const facade = new THREE.Mesh(E.fb.geometry(), fmat);
    facade.name = '幕墙'; facade.castShadow = true; facade.receiveShadow = true;
    root.add(facade);
    root.add(E.solid.build({ castShadow: true, receiveShadow: true, name: '实体' }));
    const detail = E.detail.build({ castShadow: false, receiveShadow: true, name: '细部' });
    root.add(detail);
    const sm = E.signs.build();
    if (sm) root.add(sm);
    const beaconPts = E.beacons.build();
    root.add(beaconPts);
    // 夜景：生命之树暖金色投光（少量真实点光源）
    for (const [dy, r] of [[18, 0], [34, 0]]) ctx.lights.add({ position: new THREE.Vector3(TREE.cx + r, y0 + dy, TREE.cz), color: 0xffc27a, intensity: 700, distance: 45, nightOnly: true });
    // 标注
    ctx.labels.add('西安万象城', new THREE.Vector3(236, bC + 45, 7056), { category: 'landmark', priority: 2.2, minDist: 80, maxDist: 8000 });
    ctx.labels.add('生命之树', new THREE.Vector3(TREE.cx, bC + 56, TREE.cz), { category: 'landmark', priority: 1.6, minDist: 40, maxDist: 2500 });
    ctx.labels.add('西安万象天地', new THREE.Vector3(430, bM + 30, 6700), { category: 'landmark', priority: 1.8, minDist: 80, maxDist: 6000 });

    const center = new THREE.Vector3(360, bC, 6900);
    const stats = { ms: Math.round(performance.now() - t0), errors };
    console.warn('[mixc] 构建完成 ' + JSON.stringify(stats));
    return {
      stats,
      update() {
        const cam = ctx.camera.position;
        E.beacons.update(ctx.renderer, ctx.camera);
        detail.visible = Math.hypot(cam.x - center.x, cam.z - center.z) < 2600 && cam.y - center.y < 2200;
      },
      setLayer(layer, v) {
        if (layer === 'buildings') root.visible = v;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};

/** 生命之树的花瓣平台：8 层、共 37 片（Heatherwick 官网 56 片；新闻/维基写 7 层 60 片），高度按立面图 g037 量取（自坑底起算），风车状错位旋转 */
function treePetals() {
  const L = [];
  const tier = (y, r, n, a0, w, d) => { for (let k = 0; k < n; k++) { const a = a0 + (k / n) * Math.PI * 2; L.push({ y, r, a, w, d, rot: a + 0.45 }); } };
  // (y 自坑底, 花瓣中心半径, 片数, 起始角, 长, 宽)；最宽一层外缘约 26 m（g037 量得约 52 m 宽）
  tier(6, 10, 3, 0.3, 11, 8);
  tier(12, 11.5, 5, 1.0, 13, 9);
  tier(18, 12.5, 5, 0.2, 13, 9.5);
  tier(27, 16, 8, 0.6, 17, 12);
  tier(35, 12, 6, 1.3, 13, 9);
  tier(41, 11, 5, 0.4, 13, 9);
  tier(47.5, 9, 4, 1.5, 13, 10);
  L.push({ y: 53, r: 0, a: 0, w: 17, d: 14, rot: 0.35 });
  return L;
}

/** 店招：pois.json 里落在两块地块内、名称在 SHOPS 表中的 POI，挂到最近的墙面（离地 4.5 m） */
function shopSigns(ctx, E, blocks) {
  const pois = ctx.data.pois?.pois || [];
  const used = new Set();
  for (const q of pois) {
    if (!q?.n) continue;
    const hit = SHOPS.find(([n]) => q.n.startsWith(n));
    if (!hit || used.has(hit[0])) continue;
    if (!(G.pointIn(q.x, q.z, SITE_CCBD) || G.pointIn(q.x, q.z, SITE_MT))) continue;
    let best = null;
    for (const b of blocks) {
      if (!b.pts) continue;
      for (const e of MX.edgesOf(G.ccw(b.pts))) {
        if (e.L < 6) continue;
        const t = Math.max(0.15, Math.min(0.85, ((q.x - e.ax) * e.dx + (q.z - e.az) * e.dz) / e.L));
        const px = e.ax + e.dx * e.L * t, pz = e.az + e.dz * e.L * t, d = Math.hypot(px - q.x, pz - q.z);
        if (!best || d < best.d) best = { d, px, pz, e, base: b.base };
      }
    }
    if (!best || best.d > 25) continue;
    used.add(hit[0]);
    E.signs.place(hit[0], { x: best.px, y: best.base + 4.6, z: best.pz }, best.e.nx, best.e.nz, 1.2, Math.min(best.e.L * 0.7, 9), { color: '#ffffff', bg: hit[1], weight: 700 });
  }
}
