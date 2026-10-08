// 全城街道设施（streetfurniture 模块）的构件几何、材质与贴图图集。
// 全部程序化：three 基本体（盒/柱/球）按部件变换 + 顶点色后合并成一个非索引几何，每种构件一个 InstancedMesh。
// 本地坐标约定：原点在地面（构件底部中心），+Y 向上；“正面”朝本地 +X（信号灯灯面、垃圾桶投口、报刊亭窗口、牌面）；
// 沿路的线状构件（候车亭、护栏）本地 +X 沿路、+Z 指向人行道外侧（远离车行道）。
// 尺寸依据（实测/规范常见值）：悬臂信号灯杆高 6.5~7 m、臂长 4~12 m、机动车灯组 3 灯竖排（灯径 300 mm）；人行灯 2 灯（红人/绿人）；
// 路名牌约 1.3 m × 0.42 m、牌底离地约 2.1 m；分类垃圾桶双桶各约 0.4 × 0.4 × 0.85 m；共享单车轴距约 1.05 m、轮径 26 寸；
// 室外消火栓 SS100 高约 0.75 m；候车亭进深约 1.9 m、高约 2.7 m、每跨 2.4 m；人行道护栏高约 0.95 m。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { canvas as mkCanvas, text as mkText } from '../core/textures.js';

const V3 = THREE.Vector3, Q = THREE.Quaternion, E = THREE.Euler, M4 = THREE.Matrix4;
const _m = new M4(), _q = new Q(), _e = new E(), _p = new V3(), _s = new V3();
const UP = new V3(0, 1, 0);

/** 部件：基本体 → 非索引、变换、整体顶点色（只保留 position/normal/uv/color） */
function part(geo, col, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
  g.applyMatrix4(_m);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = col[0]; c[i * 3 + 1] = col[1]; c[i * 3 + 2] = col[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
const box = (w, h, d, col, o) => part(new THREE.BoxGeometry(w, h, d), col, o);
const cyl = (r0, r1, h, seg, col, o, open = false) => part(new THREE.CylinderGeometry(r1, r0, h, seg, 1, open), col, o);
/** 两点间圆管 */
function tube(a, b, r, col, seg = 6) {
  const d = new V3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const L = d.length();
  const g = new THREE.CylinderGeometry(r, r, L, seg, 1, true);
  let gg = g.toNonIndexed();
  _q.setFromUnitVectors(UP, d.normalize());
  _m.compose(_p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _s.set(1, 1, 1));
  gg.applyMatrix4(_m);
  return part(gg, col);
}
function merge(parts) {
  const g = mergeGeometries(parts, false);
  g.computeBoundingSphere();
  return g;
}

// —— 颜色 ——
const STEEL = [0.62, 0.64, 0.66];
const DARK = [0.055, 0.058, 0.062];
const BLACK = [0.03, 0.03, 0.032];
const WHITE = [0.86, 0.87, 0.86];
const TINT = [1, 1, 1]; // 由实例色决定
const GREY = [0.42, 0.43, 0.44];

/** 悬臂信号灯杆（不含横臂）：高 6.9 m，底座法兰 + 检修门 + 臂座 */
function sigPole() {
  return merge([
    cyl(0.34, 0.32, 0.06, 12, GREY, { y: 0.03 }),
    cyl(0.22, 0.19, 0.32, 10, STEEL, { y: 0.19 }),
    cyl(0.155, 0.11, 6.9, 12, STEEL, { y: 3.45 }, true),
    cyl(0.115, 0.08, 0.08, 10, STEEL, { y: 6.94 }),
    box(0.04, 0.38, 0.16, GREY, { x: 0.15, y: 0.75 }),
    box(0.34, 0.42, 0.3, STEEL, { y: 6.3 }),
    // 电子警察/监控小臂（朝路口一侧略伸出）
    box(0.9, 0.06, 0.06, STEEL, { x: 0.45, y: 5.2 }),
    box(0.32, 0.16, 0.14, WHITE, { x: 0.95, y: 5.12 }),
  ]);
}
/** 横臂：沿本地 +X 从 0 到 1（实例 X 缩放 = 臂长），截面半径 0.08 m；端部封板 */
function sigArm() {
  return merge([
    cyl(0.085, 0.085, 1, 10, STEEL, { x: 0.5, rz: -Math.PI / 2 }, true),
    // 斜拉杆（从 0 到 0.45，向上 0.7 m）
    tube([0.0, 0.75, 0], [0.45, 0.05, 0], 0.035, STEEL, 5),
  ]);
}
/** 机动车灯组：三灯竖排黑色灯箱，灯面朝 +X，灯罩（遮檐）三道；顶部吊杆 */
function sigHead() {
  const parts = [box(0.26, 1.16, 0.4, DARK, {}), box(0.05, 0.4, 0.05, STEEL, { y: 0.77 })];
  for (const ly of [0.38, 0, -0.38]) {
    parts.push(box(0.2, 0.02, 0.32, BLACK, { x: 0.23, y: ly + 0.155, rz: -0.12 }));
    parts.push(box(0.2, 0.2, 0.015, BLACK, { x: 0.23, y: ly + 0.05, z: 0.16 }));
    parts.push(box(0.2, 0.2, 0.015, BLACK, { x: 0.23, y: ly + 0.05, z: -0.16 }));
  }
  return merge(parts);
}
/** 人行灯：两灯（上红人、下绿人），灯面朝 +X，背后抱箍连到立杆 */
function pedHead() {
  const parts = [box(0.22, 0.66, 0.32, DARK, {}), box(0.22, 0.06, 0.06, STEEL, { x: -0.2, y: 0.18 }), box(0.22, 0.06, 0.06, STEEL, { x: -0.2, y: -0.18 })];
  for (const ly of [0.16, -0.16]) parts.push(box(0.16, 0.02, 0.3, BLACK, { x: 0.18, y: ly + 0.15, rz: -0.12 }));
  return merge(parts);
}
/** 灯面圆片：单位半径，法线朝 +X；uv 供人行灯图案用 */
function lensGeo() {
  const g = new THREE.CircleGeometry(1, 14);
  g.rotateY(Math.PI / 2);
  return part(g, [1, 1, 1]);
}
/** 通用立杆：单位半径、单位高度（底在 0），实例缩放 (r, h, r) */
function postGeo() {
  return merge([cyl(1, 1, 1, 8, TINT, { y: 0.5 }), cyl(1.1, 0.7, 0.04, 8, TINT, { y: 1.02 })]);
}
/** 双面牌：正面（法线 +X）与背面（法线 −X），单位 1 × 1（实例缩放 (1, 高, 宽)）；face 属性 0 正 1 背 */
function plateGeo() {
  const pos = [], nor = [], uv = [], face = [];
  const t = 0.012;
  const quad = (pts, n, uvs, f) => {
    for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...pts[i]); nor.push(...n); uv.push(...uvs[i]); face.push(f); }
  };
  // 正面：观者在 +X 看向 −X，右手方向为 −Z → u 沿 −Z 增大
  quad([[t, -0.5, 0.5], [t, -0.5, -0.5], [t, 0.5, -0.5], [t, 0.5, 0.5]], [1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], 0);
  quad([[-t, -0.5, -0.5], [-t, -0.5, 0.5], [-t, 0.5, 0.5], [-t, 0.5, -0.5]], [-1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('face', new THREE.Float32BufferAttribute(face, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  g.computeBoundingSphere();
  return g;
}
/** 玻璃板：本地 XY 平面（法线 +Z），单位 1 × 1 */
function paneGeo() {
  return part(new THREE.PlaneGeometry(1, 1), [1, 1, 1]);
}

/**
 * 公交候车亭（nb 跨，每跨 2.4 m）：本地 +X 沿路，背板在 z = 0，开口朝 −Z（车行道一侧），顶棚进深 2.0 m。
 * 只做钢结构 + 顶棚 + 蓝色檐口 + 座椅 + 第 0 跨广告灯箱框；玻璃背板（其余各跨）、灯箱画面、站名另用实例。
 * 立柱向下多伸 0.6 m（站台后半落在人行道外的地面上时不悬空）。
 */
function shelterGeo(nb) {
  const L = nb * 2.4;
  const parts = [];
  const BLUE = [0.07, 0.24, 0.55], ROOF = [0.3, 0.32, 0.34], UNDER = [0.78, 0.79, 0.8], SEAT = [0.72, 0.74, 0.76];
  // 站台铺装垫层：后半常伸出人行道外沿，补一块比人行道高 3 cm 的石材站台（向下 0.6 m 埋入地面）
  parts.push(box(L + 0.6, 0.63, 2.4, [0.44, 0.43, 0.41], { y: -0.285, z: -0.85 }));
  parts.push(box(L + 0.62, 0.05, 0.12, [0.48, 0.47, 0.45], { y: 0.006, z: 0.33 }));
  for (let i = 0; i <= nb; i++) {
    const x = -L / 2 + i * 2.4;
    parts.push(box(0.1, 3.3, 0.1, STEEL, { x, y: 1.05, z: 0.05 }));
    // 悬挑斜撑：柱顶 → 顶棚前缘
    parts.push(tube([x, 2.55, 0.05], [x, 2.66, -1.75], 0.035, STEEL, 5));
  }
  parts.push(box(L + 0.3, 0.06, 2.1, UNDER, { y: 2.66, z: -0.88 }));
  parts.push(box(L + 0.3, 0.08, 2.1, ROOF, { y: 2.73, z: -0.88 }));
  parts.push(box(L + 0.34, 0.3, 0.06, BLUE, { y: 2.72, z: -1.95 }));
  parts.push(box(L + 0.34, 0.3, 0.06, BLUE, { y: 2.72, z: 0.18 }));
  parts.push(box(0.06, 0.3, 2.16, BLUE, { x: -(L + 0.34) / 2, y: 2.72, z: -0.88 }));
  parts.push(box(0.06, 0.3, 2.16, BLUE, { x: (L + 0.34) / 2, y: 2.72, z: -0.88 }));
  // 背板上下框
  parts.push(box(L, 0.06, 0.07, STEEL, { y: 0.32, z: 0.05 }));
  parts.push(box(L, 0.06, 0.07, STEEL, { y: 2.36, z: 0.05 }));
  // 第 0 跨广告灯箱框（双面画面另画）
  parts.push(box(2.24, 2.12, 0.2, [0.5, 0.52, 0.54], { x: -L / 2 + 1.2, y: 1.34, z: 0.05 }));
  // 座椅（不锈钢长凳）
  const bw = Math.min(L - 2.8, 4.2);
  const bx = 1.2;
  parts.push(box(bw, 0.05, 0.42, SEAT, { x: bx, y: 0.46, z: -0.32 }));
  parts.push(box(bw, 0.32, 0.04, SEAT, { x: bx, y: 0.68, z: -0.1 }));
  for (const lx of [-bw / 2 + 0.2, bw / 2 - 0.2]) parts.push(box(0.05, 0.44, 0.36, STEEL, { x: bx + lx, y: 0.22, z: -0.32 }));
  return merge(parts);
}

/** 报刊亭（绿色）：正面（窗口）朝 +X；店招另用牌实例 */
function kioskGeo() {
  const G = [0.13, 0.38, 0.25], G2 = [0.09, 0.27, 0.18], GL = [0.08, 0.1, 0.11];
  const parts = [
    box(1.5, 2.25, 2.2, G, { y: 1.125 }),
    box(1.85, 0.12, 2.5, G2, { x: 0.12, y: 2.31 }),
    box(0.02, 0.8, 1.8, GL, { x: 0.76, y: 1.32 }),
    box(0.35, 0.05, 2.0, G2, { x: 0.92, y: 0.94 }),
    box(0.45, 0.04, 2.3, G2, { x: 0.97, y: 1.8, rz: -0.25 }),
    box(1.6, 0.08, 2.3, GREY, { y: 0.04 }),
  ];
  // 摆在窗台上的杂志（彩色薄板）
  const cols = [[0.85, 0.2, 0.2], [0.95, 0.8, 0.3], [0.2, 0.45, 0.8], [0.9, 0.9, 0.88], [0.3, 0.7, 0.4], [0.8, 0.4, 0.6]];
  for (let i = 0; i < 6; i++) parts.push(box(0.02, 0.28, 0.22, cols[i], { x: 0.8, y: 1.15, z: -0.75 + i * 0.3, rz: 0.2 }));
  return merge(parts);
}

/** 分类垃圾桶（双桶：左蓝“可回收物”、右灰“其他垃圾”），投口朝 +X */
function binGeo() {
  const B = [0.1, 0.33, 0.68], Gy = [0.32, 0.34, 0.35], LID = [0.2, 0.21, 0.22], W = [0.9, 0.9, 0.88];
  const parts = [box(0.44, 0.05, 0.92, LID, { y: 0.025 })];
  for (const [z, c] of [[-0.22, B], [0.22, Gy]]) {
    parts.push(box(0.38, 0.8, 0.4, c, { y: 0.45, z }));
    parts.push(box(0.42, 0.06, 0.43, c.map((v) => v * 0.7), { y: 0.88, z }));
    parts.push(box(0.012, 0.11, 0.25, BLACK, { x: 0.19, y: 0.7, z }));
    parts.push(box(0.008, 0.08, 0.3, W, { x: 0.19, y: 0.5, z }));
  }
  return merge(parts);
}

/** 共享单车（车头朝 +X，轴距 1.06 m，轮径 0.64 m），车架/车筐/轮罩取实例色（品牌色），轮胎、车座深色；略向一侧倾斜（撑脚） */
function bikeGeo() {
  const parts = [];
  const R = 0.32, xf = 0.53, xr = -0.53;
  for (const x of [xf, xr]) {
    parts.push(cyl(R, R, 0.045, 12, [0.05, 0.05, 0.05], { x, y: R, rx: Math.PI / 2 }, true));
    parts.push(cyl(R - 0.02, R - 0.02, 0.04, 9, [0.42, 0.42, 0.42], { x, y: R, rx: Math.PI / 2 }));
    parts.push(box(0.5, 0.025, 0.07, TINT, { x: x - 0.02, y: R + 0.36, rz: x > 0 ? -0.15 : 0.15 }));
  }
  const bb = [-0.04, 0.3, 0], seat = [-0.21, 0.83, 0], head = [0.4, 0.72, 0], headTop = [0.37, 0.95, 0];
  parts.push(tube(head, bb, 0.032, TINT, 5));
  parts.push(tube(bb, seat, 0.03, TINT, 5));
  parts.push(tube(bb, [xr, R, 0.04], 0.022, TINT, 4));
  parts.push(tube([-0.18, 0.72, 0], [xr, R, 0.04], 0.02, TINT, 4));
  parts.push(tube(head, headTop, 0.035, TINT, 5));
  parts.push(tube(head, [xf, R, 0.03], 0.025, TINT, 4));
  parts.push(box(0.5, 0.13, 0.035, TINT, { x: -0.27, y: 0.33, z: 0.06 }));
  parts.push(tube(seat, [-0.24, 0.96, 0], 0.016, [0.6, 0.6, 0.6], 4));
  parts.push(box(0.27, 0.07, 0.15, [0.07, 0.07, 0.07], { x: -0.25, y: 0.99 }));
  parts.push(tube(headTop, [0.33, 1.05, 0], 0.02, [0.5, 0.5, 0.5], 4));
  parts.push(cyl(0.017, 0.017, 0.58, 5, [0.08, 0.08, 0.08], { x: 0.33, y: 1.05, rx: Math.PI / 2 }, true));
  parts.push(box(0.26, 0.17, 0.32, TINT, { x: 0.62, y: 0.9 }));
  parts.push(box(0.2, 0.012, 0.26, [0.15, 0.15, 0.15], { x: 0.62, y: 0.99 }));
  parts.push(box(0.15, 0.1, 0.13, [0.92, 0.92, 0.92], { x: -0.46, y: 0.62 }));
  parts.push(tube(bb, [-0.1, 0.0, 0.17], 0.012, [0.4, 0.4, 0.4], 4));
  const g = merge(parts);
  g.rotateX(0.1); // 撑脚一侧倾斜约 6°
  g.computeBoundingSphere();
  return g;
}

/** 电动车（踏板车）：车壳取实例色；轮胎/车座/把手深色；车头朝 +X */
function ebikeGeo() {
  const parts = [];
  const R = 0.25, D = [0.05, 0.05, 0.05];
  for (const x of [0.58, -0.55]) {
    parts.push(cyl(R, R, 0.09, 12, D, { x, y: R, rx: Math.PI / 2 }));
    parts.push(cyl(0.13, 0.13, 0.095, 8, [0.55, 0.56, 0.58], { x, y: R, rx: Math.PI / 2 }));
  }
  parts.push(box(0.55, 0.08, 0.3, [0.12, 0.12, 0.13], { x: 0.05, y: 0.3 }));
  parts.push(box(0.14, 0.62, 0.36, TINT, { x: 0.42, y: 0.66, rz: 0.22 }));
  parts.push(box(0.7, 0.34, 0.3, TINT, { x: -0.33, y: 0.6 }));
  parts.push(box(0.36, 0.08, 0.26, TINT, { x: -0.5, y: 0.5 }));
  parts.push(box(0.62, 0.1, 0.28, [0.06, 0.06, 0.06], { x: -0.26, y: 0.82 }));
  parts.push(tube([0.5, 0.92, 0], [0.58, R, 0], 0.03, [0.3, 0.3, 0.32]));
  parts.push(box(0.16, 0.16, 0.42, TINT, { x: 0.5, y: 1.0 }));
  parts.push(cyl(0.017, 0.017, 0.66, 6, [0.08, 0.08, 0.08], { x: 0.47, y: 1.07, rx: Math.PI / 2 }));
  parts.push(box(0.05, 0.08, 0.12, [0.95, 0.95, 0.9], { x: 0.59, y: 1.0 }));
  for (const z of [-0.26, 0.26]) {
    parts.push(box(0.03, 0.06, 0.1, [0.1, 0.1, 0.1], { x: 0.45, y: 1.26, z: z * 1.05 }));
    parts.push(tube([0.47, 1.07, z * 0.95], [0.45, 1.23, z * 1.05], 0.008, [0.15, 0.15, 0.15], 3));
  }
  const g = merge(parts);
  g.rotateX(0.07);
  g.computeBoundingSphere();
  return g;
}
/** 外卖箱（装在电动车后座上，实例色：黄 / 蓝） */
function dboxGeo() {
  return merge([box(0.42, 0.4, 0.4, TINT, { x: -0.5, y: 1.08 }), box(0.43, 0.04, 0.41, [0.9, 0.9, 0.9], { x: -0.5, y: 1.2 })]);
}

/** 室外消火栓（红色，地上式） */
function hydrantGeo() {
  const RED = [0.72, 0.05, 0.04], S = [0.7, 0.7, 0.68];
  return merge([
    cyl(0.17, 0.15, 0.08, 8, [0.35, 0.35, 0.35], { y: 0.04 }, true),
    cyl(0.12, 0.11, 0.62, 10, RED, { y: 0.39 }, true),
    cyl(0.115, 0.05, 0.11, 10, RED, { y: 0.755 }),
    cyl(0.03, 0.03, 0.06, 6, S, { y: 0.83 }),
    cyl(0.045, 0.045, 0.32, 6, RED, { y: 0.5, rx: Math.PI / 2 }, true),
    cyl(0.05, 0.05, 0.02, 6, S, { y: 0.5, z: 0.165, rx: Math.PI / 2 }),
    cyl(0.05, 0.05, 0.02, 6, S, { y: 0.5, z: -0.165, rx: Math.PI / 2 }),
    cyl(0.06, 0.06, 0.16, 6, RED, { x: 0.12, y: 0.42, rz: Math.PI / 2 }, true),
    cyl(0.065, 0.065, 0.02, 6, S, { x: 0.2, y: 0.42, rz: Math.PI / 2 }),
  ]);
}

/** 配电箱/通信交接箱：混凝土底座 + 箱体（实例色）+ 门缝 + 把手 + 警示贴；正面朝 +X */
function cabinetGeo() {
  const parts = [
    box(0.62, 0.15, 1.1, [0.58, 0.57, 0.55], { y: 0.075 }),
    box(0.46, 1.25, 0.96, TINT, { y: 0.775 }),
    box(0.54, 0.05, 1.04, TINT.map((v) => v * 0.85), { y: 1.42 }),
    box(0.006, 1.12, 0.012, BLACK, { x: 0.232, y: 0.78 }),
    box(0.02, 0.1, 0.03, BLACK, { x: 0.24, y: 0.85, z: 0.06 }),
    box(0.02, 0.1, 0.03, BLACK, { x: 0.24, y: 0.85, z: -0.06 }),
    box(0.006, 0.12, 0.14, [0.95, 0.78, 0.1], { x: 0.233, y: 1.2, z: 0.24 }),
  ];
  return merge(parts);
}
/** 阻车石球（花岗岩，直径 0.56 m） */
function ballGeo() {
  return merge([part(new THREE.SphereGeometry(0.28, 10, 6), [0.6, 0.58, 0.55], { y: 0.26 })]);
}
/** 不锈钢阻车桩（带黄色反光环） */
function bollardGeo() {
  return merge([
    cyl(0.085, 0.075, 0.78, 8, [0.68, 0.69, 0.7], { y: 0.39 }, true),
    cyl(0.079, 0.079, 0.08, 8, [0.95, 0.72, 0.08], { y: 0.6 }, true),
    cyl(0.075, 0.03, 0.06, 8, [0.68, 0.69, 0.7], { y: 0.81 }),
  ]);
}
/** 人行道护栏一节（2.0 m，沿本地 +X 从 0 到 2）：白色立柱 + 上下横杆 + 竖栅 */
function fenceGeo() {
  const W = [0.84, 0.86, 0.86], BL = [0.15, 0.35, 0.65];
  const parts = [
    box(0.06, 1.0, 0.06, W, { y: 0.5 }),
    box(2.0, 0.05, 0.045, W, { x: 1.0, y: 0.94 }),
    box(2.0, 0.04, 0.04, W, { x: 1.0, y: 0.16 }),
    box(2.0, 0.035, 0.035, BL, { x: 1.0, y: 0.82 }),
  ];
  for (let i = 1; i < 9; i++) parts.push(box(0.022, 0.62, 0.022, W, { x: i * 0.222, y: 0.5 }));
  return merge(parts);
}

/** 全部构件几何 */
export function makeGeometries() {
  return {
    sigPole: sigPole(), sigArm: sigArm(), sigHead: sigHead(), pedHead: pedHead(), lens: lensGeo(),
    post: postGeo(), plate: plateGeo(), ad: plateGeo(), pane: paneGeo(),
    shelter2: shelterGeo(2), shelter3: shelterGeo(3), kiosk: kioskGeo(),
    bin: binGeo(), bike: bikeGeo(), ebike: ebikeGeo(), dbox: dboxGeo(), hydrant: hydrantGeo(), cabinet: cabinetGeo(),
    ball: ballGeo(), bollard: bollardGeo(), fence: fenceGeo(),
  };
}

// ───────────────────────── 贴图 ─────────────────────────
const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif';
const LATIN = '"Helvetica Neue","Arial Narrow",Arial,sans-serif';

/** 信号灯人形图案（红人站立 / 绿人行走），白形黑底，作灯面遮罩 */
function iconTexture() {
  const c = mkCanvas(128, 64), g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  // 站立的人
  g.beginPath(); g.arc(32, 13, 5.5, 0, Math.PI * 2); g.fill();
  g.lineWidth = 8;
  g.beginPath(); g.moveTo(32, 22); g.lineTo(32, 38); g.stroke();
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(25, 24); g.lineTo(23, 37); g.moveTo(39, 24); g.lineTo(41, 37); g.stroke();
  g.lineWidth = 5.5;
  g.beginPath(); g.moveTo(29, 38); g.lineTo(29, 54); g.moveTo(35, 38); g.lineTo(35, 54); g.stroke();
  // 行走的人
  g.beginPath(); g.arc(98, 12, 5.5, 0, Math.PI * 2); g.fill();
  g.lineWidth = 7;
  g.beginPath(); g.moveTo(96, 21); g.lineTo(93, 37); g.stroke();
  g.lineWidth = 4.5;
  g.beginPath(); g.moveTo(95, 24); g.lineTo(86, 33); g.moveTo(95, 24); g.lineTo(104, 31); g.stroke();
  g.lineWidth = 5.5;
  g.beginPath(); g.moveTo(93, 37); g.lineTo(84, 53); g.moveTo(93, 37); g.lineTo(103, 52); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** 公交站灯箱画面（公益广告，2×2 图集），返回 {texture, cell(i) → [u0,v0,du,dv]} */
function posterAtlas() {
  const W = 512, H = 768;
  const c = mkCanvas(W * 2, H * 2), g = c.getContext('2d');
  const items = [
    { bg: ['#b8202a', '#6d0f16'], t1: '文明西安', t2: '你我共建', deco: '#f3c64b' },
    { bg: ['#1b6e4a', '#0c3a27'], t1: '绿色出行', t2: '低碳生活', deco: '#b9e48a' },
    { bg: ['#173f8a', '#0a1f48'], t1: '西安年', t2: '最中国', deco: '#f0c35a' },
    { bg: ['#e9e2d0', '#c9bda0'], t1: '讲文明', t2: '树新风', deco: '#b52a2a', dark: true },
  ];
  items.forEach((it, i) => {
    const x = (i % 2) * W, y = Math.floor(i / 2) * H;
    const gr = g.createLinearGradient(0, y, 0, y + H);
    gr.addColorStop(0, it.bg[0]);
    gr.addColorStop(1, it.bg[1]);
    g.fillStyle = gr;
    g.fillRect(x, y, W, H);
    // 装饰：大圆 + 城墙垛口剪影
    g.fillStyle = it.deco;
    g.globalAlpha = 0.85;
    g.beginPath(); g.arc(x + W * 0.5, y + H * 0.36, W * 0.26, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.fillStyle = it.dark ? '#7a2020' : 'rgba(0,0,0,0.35)';
    const by = y + H * 0.62;
    g.fillRect(x, by, W, H * 0.06);
    for (let k = 0; k < 9; k++) g.fillRect(x + k * (W / 8.5), by - 18, W / 17, 18);
    const fg = it.dark ? '#7a1414' : '#ffffff';
    for (const [str, yy, sz] of [[it.t1, 0.76, 92], [it.t2, 0.88, 64]]) {
      const tt = mkText(str, { size: sz, color: fg, padding: 0.05, letterSpacing: 0.12 });
      const tw = Math.min(W * 0.86, tt.canvas.width), th = tw / (tt.canvas.width / tt.canvas.height);
      g.drawImage(tt.canvas, x + (W - tw) / 2, y + H * yy - th / 2, tw, th);
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { texture: t, cell: (i) => [(i % 2) * 0.5, 1 - (Math.floor(i / 2) + 1) * 0.5, 0.5, 0.5] };
}

// ───────────────────────── 拼音 ─────────────────────────
/** 西安路名 → 牌面拼音（GB 17733：专名、通名分写，方位词与通名连写，全大写，隔音符号 '）。缺字时返回 '' */
export function roadPinyin(name, PY) {
  const chars = [...name.replace(/[（(].*?[）)]/g, '')];
  const syl = chars.map((c) => PY.get(c));
  if (!chars.length || syl.some((s) => !s)) return '';
  // 从尾部剥通名：[方位/序数]?(大街|大道|辅路|辅道|路|街|巷|段|环)
  const tokens = [];
  let end = chars.length;
  const GEN = ['大街', '大道', '辅路', '辅道', '干道', '路', '街', '巷', '段'];
  const PRE = '东西南北中一二三四五六七八九十';
  for (let guard = 0; guard < 3; guard++) {
    const s = chars.slice(0, end).join('');
    let hit = 0;
    for (const gname of GEN) if (s.endsWith(gname)) { hit = [...gname].length; break; }
    if (!hit) break;
    let st = end - hit;
    // 方位词/序数词与通名连写（南路 NANLU、一路 YILU），但至少给专名留一个字（东大街 → DONG DAJIE）
    if (st - 1 >= 1 && PRE.includes(chars[st - 1])) st -= 1;
    if (st < 1) break;
    tokens.unshift([st, end]);
    end = st;
  }
  tokens.unshift([0, end]);
  const word = ([a, b]) => {
    let w = '';
    for (let i = a; i < b; i++) {
      const s = syl[i];
      if (i > a && /^[aoe]/.test(s)) w += "'";
      w += s;
    }
    return w;
  };
  return tokens.filter(([a, b]) => b > a).map(word).join(' ').toUpperCase();
}

// ───────────────────────── 文字图集 ─────────────────────────
/**
 * 动态文字图集（1920×2016，5 列 × 21 行 = 105 格，每格 384×96 px）：路名牌、公交站牌按需画入，按引用计数回收（分块卸载时释放）。
 * 前 4 格为静态：交通标志（每格 4 个 96² 方格）与报刊亭店招。文字字形用 core/textures.js 的 text() 生成后缩放贴入。
 * 所有牌子共用一张贴图、一个材质、一个 InstancedMesh（每实例 UV 矩形），不按牌建贴图。
 */
export class TextAtlas {
  constructor() {
    this.cols = 5; this.rows = 21; this.cw = 384; this.ch = 96;
    this.canvas = mkCanvas(this.cols * this.cw, this.rows * this.ch);
    this.g = this.canvas.getContext('2d');
    this.g.fillStyle = '#1a3f8f';
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture = t;
    this.map = new Map(); // key -> {slot, ref, t}
    this.free = [];
    this.STATIC = 4;
    for (let i = this.rows * this.cols - 1; i >= this.STATIC; i--) this.free.push(i);
    this.dirty = true;
    this.clock = 0;
    this.misses = 0;
    this.paintStatic();
  }
  /** 格 → UV 矩形 [u0, v0, du, dv]（v0 为下边；CanvasTexture flipY） */
  rect(slot, x0 = 0, y0 = 0, x1 = 1, y1 = 1) {
    const col = slot % this.cols, row = Math.floor(slot / this.cols);
    const u0 = (col + x0) / this.cols, u1 = (col + x1) / this.cols;
    const vTop = 1 - (row + y0) / this.rows, vBot = 1 - (row + y1) / this.rows;
    return [u0, vBot, u1 - u0, vTop - vBot];
  }
  /** 静态交通标志方格 i（0..11） */
  signRect(i) {
    const slot = Math.floor(i / 4), k = i % 4;
    const pad = 0.004;
    return this.rect(slot, k * 0.25 + pad, pad * 4, (k + 1) * 0.25 - pad, 1 - pad * 4);
  }
  acquire(key, paint) {
    let it = this.map.get(key);
    if (it) { it.ref++; it.t = ++this.clock; return it.slot; }
    let slot = this.free.pop();
    if (slot === undefined) {
      // 回收最久未用、引用为 0 的格
      let best = null;
      for (const [k, v] of this.map) if (v.ref <= 0 && (!best || v.t < best[1].t)) best = [k, v];
      if (!best) { this.misses++; return -1; }
      this.map.delete(best[0]);
      slot = best[1].slot;
    }
    const col = slot % this.cols, row = Math.floor(slot / this.cols);
    const g = this.g;
    g.save();
    g.beginPath(); g.rect(col * this.cw, row * this.ch, this.cw, this.ch); g.clip();
    paint(g, col * this.cw, row * this.ch, this.cw, this.ch);
    g.restore();
    this.map.set(key, { slot, ref: 1, t: ++this.clock });
    this.dirty = true;
    return slot;
  }
  release(key) {
    const it = this.map.get(key);
    if (it) it.ref--;
  }
  flush() {
    if (this.dirty) { this.texture.needsUpdate = true; this.dirty = false; }
  }
  paintStatic() {
    const g = this.g, S = this.ch; // 方格边长 = 格高（每格 4 个方格）
    // 标志按 128 单位绘制：at(i) 把画布变换设到第 i 个方格（缩放到 S），返回原点
    const at = (i) => {
      const slot = Math.floor(i / 4), k = i % 4;
      const sc = S / 128;
      g.setTransform(sc, 0, 0, sc, (slot % this.cols) * this.cw + k * S, Math.floor(slot / this.cols) * this.ch);
      return [0, 0];
    };
    for (let i = 0; i < 12; i++) { const [x, y] = at(i); g.clearRect(x, y, 128, 128); }
    const disc = (x, y, fill, ring) => {
      g.fillStyle = ring; g.beginPath(); g.arc(x + 64, y + 64, 60, 0, Math.PI * 2); g.fill();
      g.fillStyle = fill; g.beginPath(); g.arc(x + 64, y + 64, 47, 0, Math.PI * 2); g.fill();
    };
    // 0~3 限速 70/60/50/40（白底红圈黑字）
    [70, 60, 50, 40].forEach((v, i) => {
      const [x, y] = at(i);
      disc(x, y, '#f4f4f0', '#c8161d');
      g.fillStyle = '#111';
      g.font = `700 56px ${LATIN}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(v), x + 64, y + 67);
    });
    // 4 禁止停车（蓝底红圈红叉）
    {
      const [x, y] = at(4);
      disc(x, y, '#1d4fa3', '#c8161d');
      g.strokeStyle = '#c8161d'; g.lineWidth = 11;
      g.beginPath(); g.moveTo(x + 34, y + 34); g.lineTo(x + 94, y + 94); g.moveTo(x + 94, y + 34); g.lineTo(x + 34, y + 94); g.stroke();
    }
    // 5 人行横道（蓝底方牌、白三角、黑色行人走在斑马线上）
    {
      const [x, y] = at(5);
      g.fillStyle = '#f2f2ee'; g.fillRect(x + 4, y + 4, 120, 120);
      g.fillStyle = '#1d4fa3'; g.fillRect(x + 9, y + 9, 110, 110);
      g.fillStyle = '#f2f2ee';
      g.beginPath(); g.moveTo(x + 64, y + 18); g.lineTo(x + 112, y + 106); g.lineTo(x + 16, y + 106); g.closePath(); g.fill();
      g.fillStyle = '#111';
      for (let k = 0; k < 4; k++) g.fillRect(x + 30 + k * 18, y + 94, 10, 8);
      g.beginPath(); g.arc(x + 66, y + 48, 6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#111'; g.lineCap = 'round';
      g.lineWidth = 7; g.beginPath(); g.moveTo(x + 64, y + 56); g.lineTo(x + 61, y + 74); g.stroke();
      g.lineWidth = 5; g.beginPath(); g.moveTo(x + 61, y + 74); g.lineTo(x + 52, y + 90); g.moveTo(x + 61, y + 74); g.lineTo(x + 72, y + 89);
      g.moveTo(x + 63, y + 60); g.lineTo(x + 54, y + 69); g.moveTo(x + 63, y + 60); g.lineTo(x + 73, y + 67); g.stroke();
    }
    // 6 公交专用（蓝底白字 + 公交车图形）
    {
      const [x, y] = at(6);
      g.fillStyle = '#f2f2ee'; g.fillRect(x + 4, y + 4, 120, 120);
      g.fillStyle = '#1d4fa3'; g.fillRect(x + 9, y + 9, 110, 110);
      g.fillStyle = '#f2f2ee';
      g.fillRect(x + 30, y + 22, 68, 40);
      g.fillStyle = '#1d4fa3';
      for (let k = 0; k < 3; k++) g.fillRect(x + 35 + k * 20, y + 28, 16, 14);
      g.fillStyle = '#f2f2ee';
      g.beginPath(); g.arc(x + 44, y + 64, 6, 0, Math.PI * 2); g.arc(x + 84, y + 64, 6, 0, Math.PI * 2); g.fill();
      g.font = `700 25px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('公交专用', x + 64, y + 96);
    }
    // 7 圆牌背面、8 方牌背面（灰色镀锌板 + 抱箍）
    {
      const [x, y] = at(7);
      g.fillStyle = '#8d9196'; g.beginPath(); g.arc(x + 64, y + 64, 60, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#6d7176'; g.fillRect(x + 56, y + 20, 16, 88);
      const [x2, y2] = at(8);
      g.fillStyle = '#8d9196'; g.fillRect(x2 + 4, y2 + 4, 120, 120);
      g.fillStyle = '#6d7176'; g.fillRect(x2 + 56, y2 + 10, 16, 108);
    }
    // 9 注意行人（黄底黑边三角）——备用
    {
      const [x, y] = at(9);
      g.fillStyle = '#111';
      g.beginPath(); g.moveTo(x + 64, y + 8); g.lineTo(x + 122, y + 116); g.lineTo(x + 6, y + 116); g.closePath(); g.fill();
      g.fillStyle = '#f2c230';
      g.beginPath(); g.moveTo(x + 64, y + 22); g.lineTo(x + 110, y + 108); g.lineTo(x + 18, y + 108); g.closePath(); g.fill();
      g.fillStyle = '#111'; g.beginPath(); g.arc(x + 64, y + 52, 6, 0, Math.PI * 2); g.fill();
      g.fillRect(x + 60, y + 60, 8, 26);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    // 第 3 格：报刊亭店招（绿底白字）
    {
      const x = (3 % this.cols) * this.cw, y = Math.floor(3 / this.cols) * this.ch, H = this.ch;
      g.fillStyle = '#145c3a'; g.fillRect(x, y, this.cw, H);
      g.fillStyle = '#e8f2ea'; g.fillRect(x, y + H * 0.81, this.cw, H * 0.08);
      const tt = mkText('报刊亭  便民服务', { size: 64, color: '#ffffff', padding: 0.05, letterSpacing: 0.1 });
      const tw = Math.min(this.cw * 0.9, tt.canvas.width * ((H * 0.62) / tt.canvas.height)), th = tw / (tt.canvas.width / tt.canvas.height);
      g.drawImage(tt.canvas, x + (this.cw - tw) / 2, y + H * 0.42 - th / 2, tw, th);
    }
    this.dirty = true;
  }
}

/** 路名牌画法：蓝底白字、白色内框；上中文、下拼音 */
export function paintRoadSign(g, x, y, w, h, name, py) {
  const k = h / 128; // 按 128 px 格高设计的尺寸
  g.fillStyle = '#1b4aa0';
  g.fillRect(x, y, w, h);
  g.strokeStyle = '#f4f6f8';
  g.lineWidth = 5 * k;
  g.strokeRect(x + 8 * k, y + 8 * k, w - 16 * k, h - 16 * k);
  const tt = mkText(name, { size: 64, color: '#ffffff', padding: 0.04, letterSpacing: 0.18, weight: 600 });
  const maxW = w - 48 * k, maxH = py ? h * 0.5 : h * 0.62;
  let th = maxH, tw = th * (tt.canvas.width / tt.canvas.height);
  if (tw > maxW) { tw = maxW; th = tw / (tt.canvas.width / tt.canvas.height); }
  const cy = py ? y + h * 0.4 : y + h * 0.5;
  g.drawImage(tt.canvas, x + (w - tw) / 2, cy - th / 2, tw, th);
  if (py) {
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let fs = Math.round(26 * k);
    g.font = `600 ${fs}px ${LATIN}`;
    while (g.measureText(py).width > w - 44 * k && fs > 11) { fs -= 1; g.font = `600 ${fs}px ${LATIN}`; }
    g.fillText(py, x + w / 2, y + h * 0.78);
  }
}

/** 公交站牌画法：上蓝底白字站名、下白底蓝字线路 */
export function paintBusSign(g, x, y, w, h, name, routes) {
  const split = routes ? 0.62 : 1;
  g.fillStyle = '#163f8c';
  g.fillRect(x, y, w, h * split);
  const k = h / 128;
  const tt = mkText(name, { size: 64, color: '#ffffff', padding: 0.04, letterSpacing: 0.1, weight: 600 });
  const maxW = w - 30 * k, maxH = h * split * 0.72;
  let th = maxH, tw = th * (tt.canvas.width / tt.canvas.height);
  if (tw > maxW) { tw = maxW; th = tw / (tt.canvas.width / tt.canvas.height); }
  g.drawImage(tt.canvas, x + (w - tw) / 2, y + (h * split) / 2 - th / 2, tw, th);
  if (routes) {
    g.fillStyle = '#f3f4f2';
    g.fillRect(x, y + h * split, w, h * (1 - split));
    g.fillStyle = '#163f8c';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let fs = Math.round(30 * k);
    g.font = `700 ${fs}px ${FONT}`;
    while (g.measureText(routes).width > w - 24 * k && fs > 11) { fs -= 1; g.font = `700 ${fs}px ${FONT}`; }
    g.fillText(routes, x + w / 2, y + h * (split + (1 - split) / 2) + 1);
  }
}

// ───────────────────────── 材质 ─────────────────────────
/**
 * 材质：metal（顶点色 × 实例色，金属漆面）、matte（顶点色，非金属）、plate（文字图集，每实例 UV）、ad（灯箱画面，夜间发光）、
 * glass（候车亭背板玻璃）、lens（信号灯面：按 uTime 周期红黄绿切换，东西/南北相位相反，夜间强发光）。
 */
export function makeMaterials(ctx, atlas) {
  const S = THREE.MeshStandardMaterial;
  const M = {};
  M.metal = new S({ color: 0xffffff, vertexColors: true, metalness: 0.45, roughness: 0.45 });
  M.matte = new S({ color: 0xffffff, vertexColors: true, metalness: 0.0, roughness: 0.78 });
  M.paint = new S({ color: 0xffffff, vertexColors: true, metalness: 0.15, roughness: 0.5 });
  // 牌：每实例两组 UV 矩形（正面 aUV、背面 aUV2）
  M.plate = new S({ color: 0xffffff, map: atlas.texture, metalness: 0.15, roughness: 0.5, alphaTest: 0.5, side: THREE.FrontSide });
  M.plate.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aUV;\nattribute vec4 aUV2;\nattribute float face;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = mix(aUV.xy + uv * aUV.zw, aUV2.xy + uv * aUV2.zw, face);\n#endif');
  };
  M.plate.customProgramCacheKey = () => 'furn-plate';
  const posters = posterAtlas();
  M.posterCell = posters.cell;
  M.ad = new S({ color: 0xffffff, map: posters.texture, emissiveMap: posters.texture, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.35 });
  M.ad.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aUV;\nattribute vec4 aUV2;\nattribute float face;')
      .replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nvec2 fUv = mix(aUV.xy + uv * aUV.zw, aUV2.xy + uv * aUV2.zw, face);\n#ifdef USE_MAP\nvMapUv = fUv;\n#endif\n#ifdef USE_EMISSIVEMAP\nvEmissiveMapUv = fUv;\n#endif'
      );
  };
  M.ad.customProgramCacheKey = () => 'furn-ad';
  ctx.night.register(M.ad, { day: 0.12, night: 1.15 });
  M.glass = new S({ color: 0xa9c3cf, metalness: 0.1, roughness: 0.06, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, vertexColors: true });
  // 信号灯面
  const icon = iconTexture();
  M.lens = new S({ color: 0xffffff, vertexColors: true, roughness: 0.25, metalness: 0.0, emissive: 0xffffff });
  M.lens.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = ctx.uniforms.uTime;
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.uniforms.uIcon = { value: icon };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSig;\nvarying vec4 vSig;\nvarying vec2 vLensUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSig = aSig;\nvLensUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uNight;\nuniform sampler2D uIcon;\nvarying vec4 vSig;\nvarying vec2 vLensUv;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // 周期 64 s：本相位绿 0~28、黄 28~31、红 31~64；另一相位（vSig.y = 1）错开半周期，两相之间各有 1 s 全红
          float t = mod(uTime + vSig.x + vSig.y * 32.0, 64.0);
          float k = vSig.z;
          vec3 lc = vec3(1.0, 0.07, 0.03);
          float on = 0.0;
          if (k < 0.5) { on = step(31.0, t); }
          else if (k < 1.5) { lc = vec3(1.0, 0.55, 0.02); on = step(28.0, t) * step(t, 31.0); }
          else if (k < 2.5) { lc = vec3(0.05, 1.0, 0.42); on = step(t, 28.0); }
          else if (k < 3.5) { on = step(25.0, t); }
          else { lc = vec3(0.05, 1.0, 0.42); on = t < 19.0 ? 1.0 : (t < 25.0 ? step(0.5, fract(t)) : 0.0); }
          float mask = 1.0;
          if (k > 2.5) mask = texture2D(uIcon, vec2((k > 3.5 ? 0.5 : 0.0) + vLensUv.x * 0.5, vLensUv.y)).r;
          float inten = mix(2.4, 9.0, uNight);
          totalEmissiveRadiance = lc * mask * (on * inten + 0.025);
          diffuseColor.rgb = mix(vec3(0.015), lc * 0.06, mask);
        }`
      );
  };
  M.lens.customProgramCacheKey = () => 'furn-lens';
  return M;
}
