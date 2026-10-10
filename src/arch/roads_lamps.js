// roads 模块路灯：六种灯型的程序化几何（实例化）+ 远景灯头光点（Points，最大值混合）。
// 灯型依据（调研，见最终汇报）：
//   SINGLE  普通单臂 LED 路灯：灯杆 10 m，锥形钢杆，臂长 ~2.2 m，扁平流线型 LED 灯具（西安主次干道常见）
//   DOUBLE  中央分隔带双臂灯：杆高 11.5 m，两侧各 2.6 m 臂
//   KNOT    “中国结”装饰灯：东西南北大街、长安路一带灯杆挂红色 LED 中国结（国际在线《西安市民生工程之城市夜景亮化》：
//           “东西南北大街红红的中国结”），灯头为双臂仿古灯罩；中国结隔杆挂（KNOT2 为同款不挂结的灯杆）
//   PALACE  唐风宫灯：曲江/大雁塔/大唐不夜城一带地面街道，深色仿古灯杆 + 横担吊挂六角宫灯 + 顶部宫灯
//   LANTERN 二环红灯笼：“二环路沿线的红灯笼”（同上），普通灯杆中部挂一对红灯笼
// 约定：局部 +Z 指向路面（灯臂方向），+Y 向上，原点为灯杆底部中心（= 人行道/分隔带顶面）。
// 灯杆根部（2026-10 第二轮）：原为 0.38×0.6 m 深色金属方墩（白天近乎纯黑、顶面反天光发白，夜里一块黑立方，审查 P2）。
//   改为：埋入铺装、顶面高出 8 cm 的混凝土基础 + 钢法兰底板 + 螺栓护罩（杆色）+ 杆身检修门，尺寸贴合杆径。
// 材质：每个顶点带 aPBR（金属度、粗糙度），喷塑灯杆、灯具壳体、发光面板、混凝土、仿古铜件分开（原整灯金属度 0.55）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAMP } from './roads_net.js';

const C_POLE = [0.42, 0.44, 0.47];
const C_DARK = [0.16, 0.16, 0.17];
const C_DOOR = [0.34, 0.355, 0.38];
const C_CONC = [0.42, 0.41, 0.39];
const C_STEEL = [0.36, 0.37, 0.38];
const C_HOUSING = [0.5, 0.52, 0.55];
const C_LENS = [0.72, 0.72, 0.7];
const C_BRONZE = [0.2, 0.12, 0.08];
const C_RED = [0.55, 0.05, 0.035];
const C_GOLD = [0.62, 0.45, 0.16];
const C_GLASS = [0.74, 0.7, 0.62];
const E_LED = [1.0, 0.74, 0.46]; // 约 3500 K 暖白（原 4500 K 偏冷，夜景近处成白色光球）
const E_WARM = [1.0, 0.66, 0.3];
const E_RED = [1.0, 0.07, 0.03];

// [金属度, 粗糙度]
const P_PAINT = [0.25, 0.48]; // 喷塑钢杆
const P_METAL = [0.6, 0.42]; // 灯具壳体、法兰
const P_LENS = [0.0, 0.3];
const P_CONC = [0.0, 0.92];
const P_BRONZE = [0.55, 0.5];
const P_GOLD = [0.75, 0.35];
const P_CLOTH = [0.0, 0.7]; // 灯笼、中国结
const P_GLASS = [0.0, 0.25];

/** 统一属性（position/normal/color/aEmi/aPBR），去掉 uv，便于合并 */
function prep(geo, color, emi, strength = 0, pbr = P_PAINT) {
  const g = geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3), e = new Float32Array(n * 3), m = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2];
    if (emi) { e[i * 3] = emi[0] * strength; e[i * 3 + 1] = emi[1] * strength; e[i * 3 + 2] = emi[2] * strength; }
    m[i * 2] = pbr[0]; m[i * 2 + 1] = pbr[1];
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aEmi', new THREE.BufferAttribute(e, 3));
  g.setAttribute('aPBR', new THREE.BufferAttribute(m, 2));
  return g;
}

function box(w, h, d, x, y, z, color, emi, s, rotX = 0, rotY = 0, rotZ = 0, pbr = P_PAINT) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX || rotY || rotZ) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ)));
  g.translate(x, y, z);
  return prep(g, color, emi, s, pbr);
}
function cyl(rt, rb, h, seg, x, y, z, color, emi, s, pbr = P_PAINT) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
  g.translate(x, y, z);
  return prep(g, color, emi, s, pbr);
}
/** 两点之间的圆杆 */
function rod(a, b, r, seg, color, emi, s, pbr = P_PAINT) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, L, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q);
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return prep(g, color, emi, s, pbr);
}
function sphere(r, sx, sy, sz, x, y, z, color, emi, s, seg = 10, pbr = P_CLOTH) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg - 2));
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return prep(g, color, emi, s, pbr);
}

/**
 * 扁平流线型 LED 灯具（在 +Z 方向 z 处，dir=-1 朝 -Z）：壳体根部宽 0.4 m、端部收到 0.31 m，顶面根部高端部低（侧看楔形），
 * 底面嵌发光面板（白天浅灰，不再是白色方块）；根部有与灯臂相接的套管。
 */
function ledHead(parts, y, z, dir = 1) {
  const L = 0.86, W0 = 0.4, H0 = 0.12;
  const g = new THREE.BoxGeometry(W0, H0, L, 1, 1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getZ(i) + L / 2) / L; // 0 根部 → 1 端部
    pos.setX(i, pos.getX(i) * (1 - 0.22 * t));
    if (pos.getY(i) > 0) pos.setY(i, pos.getY(i) - 0.05 * t);
    pos.setZ(i, pos.getZ(i) * dir);
  }
  if (dir < 0) g.index.array.reverse(); // 镜像后翻转绕序
  g.computeVertexNormals();
  g.translate(0, y, z * dir);
  parts.push(prep(g, C_HOUSING, null, 0, P_METAL));
  // 发光面板（略小于壳体底面、凹进 5 mm）
  parts.push(box(0.29, 0.012, 0.6, 0, y - H0 / 2 - 0.001, (z + 0.04) * dir, C_LENS, E_LED, 2.4, 0, 0, 0, P_LENS));
  // 根部套管（灯臂插入处，沿 Z）
  parts.push(rod([0, y + 0.005, (z - L / 2 - 0.14) * dir], [0, y + 0.005, (z - L / 2 + 0.02) * dir], 0.05, 8, C_HOUSING, null, 0, P_METAL));
}
/** 弯臂：从杆顶 (0,y0,0) 上挑到 (0,y0+rise,len) */
function arm(parts, y0, len, rise, dir = 1, r = 0.045) {
  const mid = [0, y0 + rise * 0.8, len * 0.45 * dir];
  parts.push(rod([0, y0 - 0.1, 0], mid, r, 8, C_POLE));
  parts.push(rod(mid, [0, y0 + rise, len * dir], r, 8, C_POLE));
}
/**
 * 灯杆根部：混凝土基础（埋入铺装，顶面高出 8 cm）+ 钢法兰底板 + 螺栓护罩（杆色）。返回杆身起点高度。
 * rb：杆底半径
 */
function footing(parts, rb, color = C_POLE, conc = true) {
  if (conc) parts.push(box(0.56, 0.36, 0.56, 0, -0.1, 0, C_CONC, null, 0, 0, 0, 0, P_CONC)); // 顶面 y = 0.08
  parts.push(box(rb * 2.9, 0.03, rb * 2.9, 0, 0.095, 0, C_STEEL, null, 0, 0, 0, 0, P_METAL)); // 法兰
  parts.push(cyl(rb * 1.12, rb * 1.32, 0.3, 12, 0, 0.11 + 0.15, 0, color)); // 螺栓护罩
  return 0.4;
}
function pole(parts, h, rb = 0.12, rt = 0.065, color = C_POLE) {
  const y0 = footing(parts, rb, color);
  parts.push(cyl(rt, rb, h - y0, 12, 0, y0 + (h - y0) / 2, 0, color));
  // 检修门（背向路面一侧，离地约 1 m）
  const ry = rb - ((rb - rt) * (0.95 - y0)) / (h - y0);
  parts.push(box(0.1, 0.34, 0.03, 0, 0.95, -(ry + 0.004), C_DOOR, null, 0, 0, 0, 0, P_PAINT));
}

/** 六角宫灯（中心 x,y,z） */
function palaceLantern(parts, x, y, z, r = 0.3, h = 0.66) {
  parts.push(cyl(r, r, h, 6, x, y, z, [0.95, 0.8, 0.55], E_WARM, 3, P_GLASS));
  // 立柱
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.push(box(0.04, h + 0.04, 0.04, x + Math.cos(a) * r, y, z + Math.sin(a) * r, C_BRONZE, null, 0, 0, 0, 0, P_BRONZE));
  }
  parts.push(cyl(0.02, r * 1.55, 0.28, 6, x, y + h / 2 + 0.14, z, C_BRONZE, null, 0, P_BRONZE)); // 攒尖顶
  parts.push(cyl(r * 0.9, r * 1.1, 0.06, 6, x, y + h / 2 + 0.02, z, C_GOLD, null, 0, P_GOLD));
  parts.push(cyl(r * 1.05, r * 0.3, 0.16, 6, x, y - h / 2 - 0.08, z, C_BRONZE, null, 0, P_BRONZE));
  parts.push(box(0.05, 0.45, 0.05, x, y - h / 2 - 0.38, z, C_RED, E_RED, 0.8, 0, 0, 0, P_CLOTH)); // 流苏
}

/** 仿古灯罩（东西南北大街双臂灯）：六角磨砂玻璃罩 + 深色攒尖顶 + 宝珠 + 底托，吊在灯臂端部下方 */
function antiqueShade(parts, y, z) {
  parts.push(cyl(0.17, 0.2, 0.42, 6, 0, y, z, C_GLASS, E_LED, 2.2, P_GLASS));
  parts.push(cyl(0.035, 0.27, 0.15, 6, 0, y + 0.285, z, C_DARK, null, 0, P_METAL));
  parts.push(cyl(0.24, 0.24, 0.03, 6, 0, y + 0.225, z, C_GOLD, null, 0, P_GOLD));
  parts.push(sphere(0.045, 1, 1, 1, 0, y + 0.39, z, C_GOLD, null, 0, 8, P_GOLD));
  parts.push(cyl(0.2, 0.13, 0.06, 6, 0, y - 0.24, z, C_DARK, null, 0, P_METAL));
  parts.push(cyl(0.012, 0.012, 0.22, 4, 0, y + 0.45, z, C_DARK, null, 0, P_METAL)); // 吊杆
}

/** 中国结（在 YZ 平面，面向道路方向行驶的车辆）；夜里暖红低亮度（原 3.2 倍自发光，一串红点像警示灯，审查 P2） */
function chineseKnot(parts, y, z, S = 0.85) {
  const t = 0.07;
  const add = (w, h, yy, zz, rot) => parts.push(box(t, h, w, 0, yy, zz, C_RED, E_RED, 0.9, rot, 0, 0, P_CLOTH));
  const q = Math.PI / 4;
  // 外菱形 4 边
  const L = S * 0.72, o = S * 0.25;
  add(L, t, y + o, z + o, q);
  add(L, t, y + o, z - o, -q);
  add(L, t, y - o, z + o, -q);
  add(L, t, y - o, z - o, q);
  // 内菱形
  const L2 = S * 0.4, o2 = S * 0.14;
  add(L2, t, y + o2, z + o2, q);
  add(L2, t, y + o2, z - o2, -q);
  add(L2, t, y - o2, z + o2, -q);
  add(L2, t, y - o2, z - o2, q);
  parts.push(box(t, 0.14, 0.14, 0, y, z, C_RED, E_RED, 0.9, 0, 0, 0, P_CLOTH));
  // 顶环与流苏
  parts.push(box(t, 0.2, 0.06, 0, y + S * 0.6, z, C_GOLD, null, 0, 0, 0, 0, P_GOLD));
  parts.push(box(0.05, 0.7, 0.18, 0, y - S * 0.85, z, C_RED, E_RED, 0.5, 0, 0, 0, P_CLOTH));
  parts.push(box(0.08, 0.08, 0.22, 0, y - S * 0.5, z, C_GOLD, null, 0, 0, 0, 0, P_GOLD));
}

function redLantern(parts, x, y, z) {
  parts.push(sphere(0.3, 1, 0.82, 1, x, y, z, C_RED, E_RED, 1.4, 10, P_CLOTH));
  parts.push(cyl(0.14, 0.14, 0.07, 8, x, y + 0.27, z, C_GOLD, null, 0, P_GOLD));
  parts.push(cyl(0.14, 0.14, 0.07, 8, x, y - 0.27, z, C_GOLD, null, 0, P_GOLD));
  parts.push(box(0.04, 0.34, 0.04, x, y - 0.48, z, [0.75, 0.55, 0.12], E_RED, 0.6, 0, 0, 0, P_CLOTH));
}

/** 生成各灯型几何；返回 {geo, head}（head：灯头位置，用于远景光点） */
export function lampGeometries() {
  const out = {};
  // 普通单臂
  {
    const p = [];
    pole(p, 10);
    arm(p, 10, 2.3, 0.35);
    ledHead(p, 10.3, 2.55);
    out[LAMP.SINGLE] = { geo: mergeGeometries(p), head: [[0, 10.2, 2.55]] };
  }
  // 中央双臂
  {
    const p = [];
    pole(p, 11.5, 0.14, 0.075);
    arm(p, 11.5, 2.6, 0.4, 1);
    arm(p, 11.5, 2.6, 0.4, -1);
    ledHead(p, 11.85, 2.85, 1);
    ledHead(p, 11.85, 2.85, -1);
    out[LAMP.DOUBLE] = { geo: mergeGeometries(p), head: [[0, 11.75, 2.85], [0, 11.75, -2.85]] };
  }
  // 中国结装饰灯（东西南北大街/长安路）：挂结 / 不挂结两种，隔杆交替
  for (const withKnot of [true, false]) {
    const p = [];
    pole(p, 9.5, 0.13, 0.08, [0.3, 0.3, 0.32]);
    arm(p, 9.5, 1.7, 0.3, 1, 0.05);
    arm(p, 9.5, 1.7, 0.3, -1, 0.05);
    for (const d of [1, -1]) antiqueShade(p, 9.3, 1.72 * d);
    p.push(cyl(0.02, 0.09, 0.5, 8, 0, 9.75, 0, C_GOLD, null, 0, P_GOLD));
    if (withKnot) chineseKnot(p, 5.6, 0.22, 0.9);
    const head = [[0, 9.3, 1.72], [0, 9.3, -1.72]];
    if (withKnot) head.push([0, 5.6, 0.2]);
    out[withKnot ? LAMP.KNOT : LAMP.KNOT2] = { geo: mergeGeometries(p), head };
  }
  // 唐风宫灯
  {
    const p = [];
    const y0 = footing(p, 0.15, [0.28, 0.26, 0.24]);
    p.push(cyl(0.11, 0.15, 6.9 - y0, 8, 0, y0 + (6.9 - y0) / 2, 0, C_BRONZE, null, 0, P_BRONZE));
    p.push(box(0.12, 0.14, 2.5, 0, 6.9, 0, C_BRONZE, null, 0, 0, 0, 0, P_BRONZE)); // 横担（沿 Z）
    p.push(box(0.06, 0.3, 0.06, 0, 6.72, 1.1, C_BRONZE, null, 0, 0, 0, 0, P_BRONZE));
    p.push(box(0.06, 0.3, 0.06, 0, 6.72, -1.1, C_BRONZE, null, 0, 0, 0, 0, P_BRONZE));
    palaceLantern(p, 0, 6.1, 1.1, 0.26, 0.56);
    palaceLantern(p, 0, 6.1, -1.1, 0.26, 0.56);
    palaceLantern(p, 0, 7.5, 0, 0.32, 0.7);
    // 杆身云纹箍
    p.push(cyl(0.17, 0.17, 0.1, 8, 0, 2.2, 0, C_GOLD, null, 0, P_GOLD));
    p.push(cyl(0.16, 0.16, 0.1, 8, 0, 4.6, 0, C_GOLD, null, 0, P_GOLD));
    out[LAMP.PALACE] = { geo: mergeGeometries(p), head: [[0, 7.5, 0], [0, 6.1, 1.1], [0, 6.1, -1.1]] };
  }
  // 二环：单臂灯 + 一对红灯笼
  {
    const p = [];
    pole(p, 10);
    arm(p, 10, 2.3, 0.35);
    ledHead(p, 10.3, 2.55);
    p.push(box(0.06, 0.06, 1.3, 0, 6.6, 0, C_DARK, null, 0, 0, 0, 0, P_METAL)); // 挂架（沿 Z 两侧）
    redLantern(p, 0, 6.2, 0.55);
    redLantern(p, 0, 6.2, -0.55);
    out[LAMP.LANTERN] = { geo: mergeGeometries(p), head: [[0, 10.2, 2.55], [0, 6.2, 0.55], [0, 6.2, -0.55]] };
  }
  for (const k in out) out[k].geo.computeBoundingSphere();
  return out;
}

/** 该灯头是否为红色装饰（中国结 / 红灯笼）：远景光点暗一些、偏深红 */
export function lampHeadRed(t, i) {
  return (t === LAMP.KNOT && i === 2) || (t === LAMP.LANTERN && i > 0);
}

/**
 * 远景低模灯型（几百米外用）：一根 5 边形灯杆 + 每个灯头位置一个发光小盒（颜色/发光与完整灯型一致），
 * 每盏约 22~46 个三角形（完整灯型 200~700 个）。入参为 lampGeometries() 的结果，返回 {type: geometry}。
 */
export function lampGeometriesLow(full) {
  const out = {};
  const H = { [LAMP.SINGLE]: 10, [LAMP.DOUBLE]: 11.5, [LAMP.KNOT]: 9.5, [LAMP.KNOT2]: 9.5, [LAMP.PALACE]: 7.3, [LAMP.LANTERN]: 10 };
  const HEADCOL = {
    [LAMP.SINGLE]: [C_HOUSING, E_LED, 2.4], [LAMP.DOUBLE]: [C_HOUSING, E_LED, 2.4], [LAMP.KNOT]: [C_GLASS, E_LED, 2.2],
    [LAMP.KNOT2]: [C_GLASS, E_LED, 2.2], [LAMP.PALACE]: [[0.95, 0.8, 0.55], E_WARM, 3], [LAMP.LANTERN]: [C_HOUSING, E_LED, 2.4],
  };
  for (const k in full) {
    const t = +k;
    const p = [];
    const poleCol = t === LAMP.PALACE ? C_BRONZE : t === LAMP.KNOT || t === LAMP.KNOT2 ? [0.3, 0.3, 0.32] : C_POLE;
    const g = new THREE.CylinderGeometry(0.07, 0.12, H[t] || 10, 5, 1, true);
    g.translate(0, (H[t] || 10) / 2, 0);
    p.push(prep(g, poleCol, null, 0, t === LAMP.PALACE ? P_BRONZE : P_PAINT));
    full[k].head.forEach(([hx, hy, hz], i) => {
      // 中国结 / 红灯笼的附加灯头是红色
      const red = lampHeadRed(t, i);
      const [c, e, s] = red ? [C_RED, E_RED, 1.0] : HEADCOL[t];
      const big = t === LAMP.PALACE || red || t === LAMP.KNOT || t === LAMP.KNOT2;
      p.push(box(big ? 0.4 : 0.36, big ? 0.45 : 0.12, big ? 0.4 : 0.8, hx, hy, hz, c, e, s, 0, 0, 0, red ? P_CLOTH : P_LENS));
    });
    out[k] = mergeGeometries(p);
    out[k].computeBoundingSphere();
  }
  return out;
}

/**
 * 路灯材质：顶点色 + aEmi（夜间自发光）+ aPBR（逐部件金属度/粗糙度）。
 * 夜间灯杆下部受灯下铺装的反射光（暖色、离地 3.5 m 内由强到弱）：原先夜里近处灯杆与底座是纯黑剪影（审查 P1/P2）。
 */
export function lampMaterial(ctx) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.3 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = ctx.uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aEmi;\nattribute vec2 aPBR;\nvarying vec3 vEmi;\nvarying vec2 vPBR;\nvarying float vLY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmi = aEmi; vPBR = aPBR; vLY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec3 vEmi;\nvarying vec2 vPBR;\nvarying float vLY;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vPBR.y, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(vPBR.x, 0.0, 1.0);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += vEmi * (0.04 + uNight);
// 灯下铺装的暖色反射光：照亮灯杆下部（基础、护罩、检修门），越高越弱；杆身整体留一点灯具外溢光
float bounce = 0.05 + 0.3 * (1.0 - smoothstep(0.0, 3.5, vLY));
totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.64, 0.34) * bounce * uNight;`
      );
  };
  mat.customProgramCacheKey = () => 'roadLamp|v3';
  return mat;
}

/** 远景灯头光点（最大值混合），近处由实例化灯头代替而逐渐淡出 */
export function lampPointsMaterial(ctx) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNight: ctx.uniforms.uNight,
      uScale: { value: 800 },
      uFog: { value: 3e-5 },
      uGain: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uScale;
      uniform float uFog;
      attribute vec3 color;
      varying vec3 vCol;
      varying float vA;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mvPosition.z, 1.0);
        float px = 1.5 * uScale / d;
        float ps = clamp(px, 2.0, 12.0);
        // 按像素大小限亮：灯头小于点精灵时亮度随“真实像素尺寸 / 精灵尺寸”下降；取平方根（远处仍可辨成串的灯点，
        // 取最大值混合不会叠加成光团），再设上限 0.75（远处灯点不进泛光阈值）
        vA = min(sqrt(clamp(px / ps, 0.0, 1.0)) * 1.25, 1.0) * smoothstep(90.0, 260.0, d) * exp(-uFog * d * 0.6);
        vA *= mix(1.0, 0.75, smoothstep(600.0, 2500.0, d));
        gl_PointSize = ps;
        gl_Position = projectionMatrix * mvPosition;
        vCol = color;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uNight;
      uniform float uGain;
      varying vec3 vCol;
      varying float vA;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c) * 4.0;
        float a = exp(-r2 * 5.0) + 0.25 * exp(-r2 * 1.6);
        if (a * vA < 0.004) discard;
        gl_FragColor = vec4(vCol * a * vA * uNight * uGain, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    // 取最大值混合（WebGL2 原生 MAX）：同一像素里叠多少盏灯只取最亮的一盏。全城俯视时成百盏灯头压进同一像素，
    // 加色混合会叠成一团过曝白光再被泛光放大；稀疏灯点的观感与加色混合一致（背景暗时 max≈add）
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  return mat;
}
