// 程序化客机/运输机：每种机型一个合并几何（带 part 属性），用 InstancedMesh + 着色器调色板实现多家航司涂装。
// 本地坐标：机头朝 +Z，Y 向上，原点 = 主起落架接地点（便于拉平/抬轮时绕主轮转动）。左翼在 +X。
// 尺寸来源：Airbus/Boeing 机场规划手册（Airport Planning / ACAPS）公开数据，取整。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// part 编号：0 机身上部 1 机腹 2 垂尾A 3 垂尾B 4 发动机短舱 5 金属灰（缝翼/前缘/支柱）
//           6 深色（轮胎/风挡/进气道）7 客舱舷窗条 8 机翼浅灰 9 装饰线 10 起落架（可收起）11 螺旋桨盘
export const PART = { BODY: 0, BELLY: 1, FINA: 2, FINB: 3, ENG: 4, METAL: 5, DARK: 6, WIN: 7, WING: 8, CHEAT: 9, GEAR: 10, PROP: 11 };

/** 机型参数（米）。wb=前后轮距；mgz=主起落架相对机身中点的 z；wingZ=翼根 1/4 弦 z */
export const TYPES = {
  a320: { name: 'A320', L: 37.6, R: 1.98, yc: 3.35, span: 35.8, rootC: 6.3, tipC: 1.6, sweep: 25, dih: 5, wingZ: -1.2, wingY: -0.55, wingT: 0.75,
    eng: [{ s: 5.75, r: 1.02, len: 4.4 }], hspan: 12.45, hC: 3.3, vH: 6.2, vC: 5.8, winglet: 2.4, mgz: -2.7, wb: 12.6, pitch: 0.53, doorF: 5.5 },
  b738: { name: 'B737-800', L: 39.5, R: 1.88, yc: 3.1, span: 35.8, rootC: 6.4, tipC: 1.3, sweep: 25, dih: 6, wingZ: -1.5, wingY: -0.6, wingT: 0.7,
    eng: [{ s: 4.9, r: 0.98, len: 4.0, flat: 0.85 }], hspan: 14.3, hC: 3.4, vH: 7.0, vC: 6.0, winglet: 2.5, mgz: -2.4, wb: 15.6, pitch: 0.51, doorF: 5.0 },
  a330: { name: 'A330', L: 63.7, R: 2.82, yc: 5.0, span: 60.3, rootC: 10.5, tipC: 2.5, sweep: 30, dih: 5.5, wingZ: -2.5, wingY: -0.55, wingT: 1.2,
    eng: [{ s: 9.6, r: 1.55, len: 6.8 }], hspan: 19.4, hC: 5.2, vH: 9.6, vC: 8.8, winglet: 2.8, mgz: -5.0, wb: 25.4, pitch: 0.53, doorF: 9.5 },
  b789: { name: 'B787-9', L: 62.8, R: 2.88, yc: 5.0, span: 60.1, rootC: 10.8, tipC: 1.8, sweep: 32, dih: 7, wingZ: -2.8, wingY: -0.5, wingT: 1.2, raked: 1,
    eng: [{ s: 9.8, r: 1.62, len: 7.2, chevron: 1 }], hspan: 19.8, hC: 5.0, vH: 9.2, vC: 9.0, winglet: 0, mgz: -5.2, wb: 25.8, pitch: 0.53, doorF: 9.8 },
  a359: { name: 'A350-900', L: 66.8, R: 2.98, yc: 5.1, span: 64.8, rootC: 11.5, tipC: 2.3, sweep: 31.9, dih: 6, wingZ: -2.9, wingY: -0.5, wingT: 1.25,
    eng: [{ s: 10.2, r: 1.68, len: 7.4 }], hspan: 19.9, hC: 5.3, vH: 9.8, vC: 9.2, winglet: 3.2, curved: 1, mgz: -5.6, wb: 28.7, pitch: 0.53, doorF: 10.0 },
  y20: { name: '运-20', L: 47.0, R: 2.9, yc: 4.3, span: 50.0, rootC: 8.6, tipC: 2.6, sweep: 24, dih: -3, wingZ: -1.0, wingY: 0.82, wingT: 1.2,
    eng: [{ s: 7.2, r: 0.98, len: 5.2 }, { s: 13.6, r: 0.98, len: 5.2 }], hspan: 18.5, hC: 4.8, vH: 9.5, vC: 8.5, winglet: 0, ttail: 1, mgz: -1.5, wb: 14.5, pitch: 0, doorF: 6, mil: 1 },
  ma60: { name: '新舟60', L: 24.7, R: 1.4, yc: 2.55, span: 29.2, rootC: 3.3, tipC: 1.6, sweep: 3, dih: 2, wingZ: -0.6, wingY: 0.85, wingT: 0.5,
    eng: [{ s: 4.25, r: 0.62, len: 5.2, prop: 3.9 }], hspan: 9.4, hC: 2.1, vH: 4.6, vC: 4.2, winglet: 0, mgz: -0.7, wb: 8.5, pitch: 0.55, doorF: 4, turboprop: 1 },
};

// 涂装调色板（不画任何商标，只用航司主色色块）：[机身, 机腹, 垂尾A(上), 垂尾B(下), 发动机, 装饰线]
export const LIVERIES = [
  ['#eeeff0', '#cfd4d9', '#c8102e', '#1d3f7a', '#1d3f7a', '#eeeff0'], // 0 东方航空（基地航司）：白身，红/藏蓝垂尾
  ['#eeeff0', '#e9e9e9', '#c41a2a', '#d9a426', '#c41a2a', '#eeeff0'], // 1 海南航空：红金尾
  ['#eeeff0', '#d5dbe1', '#63ade0', '#4b9ad6', '#eeeff0', '#eeeff0'], // 2 南方航空：天蓝尾
  ['#eeeff0', '#d9dadc', '#eeeff0', '#cf1b24', '#cf1b24', '#eeeff0'], // 3 国际航空：白尾红纹
  ['#eeeff0', '#e7e7e7', '#c3151f', '#dcae3a', '#c3151f', '#eeeff0'], // 4 四川航空：红金
  ['#eeeff0', '#1f5fb0', '#1f5fb0', '#2f78c8', '#1f5fb0', '#1f5fb0'], // 5 厦门航空：蓝腹蓝尾
  ['#eeeff0', '#e4e4e4', '#69b23f', '#4e9a2b', '#eeeff0', '#69b23f'], // 6 春秋航空：绿尾
  ['#eeeff0', '#d8d8d8', '#8a1538', '#c9a14a', '#8a1538', '#eeeff0'], // 7 吉祥航空：酒红金
  ['#f2f3f4', '#dfe3e8', '#12a3b4', '#1e56a0', '#f2f3f4', '#1e56a0'], // 8 试飞涂装：白身蓝绿
  ['#8d959b', '#7b8389', '#8d959b', '#848c92', '#7b8389', '#8d959b'], // 9 军用灰
  ['#eeeff0', '#e2e2e2', '#d6232a', '#1b3a8c', '#eeeff0', '#1b3a8c'], // 10 幸福航空
  ['#eeeff0', '#d9dde0', '#0f7f78', '#d2a33a', '#0f7f78', '#eeeff0'], // 11 长龙航空
];
export const XIY_MIX = [[0, 34], [1, 12], [2, 12], [3, 10], [4, 8], [5, 7], [6, 5], [7, 5], [11, 5], [10, 2]];

// ---------- 几何工具 ----------
function tag(g, part, aux = null) {
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  g.setAttribute('part', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
  g.setAttribute('aux', new THREE.BufferAttribute(aux || new Float32Array(n * 2), 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** 由 8 个角点构成的六面体（翼面/尾翼），a=根部前缘上, 顺序：根前上 根后上 梢后上 梢前上 / 根前下 根后下 梢后下 梢前下 */
function hexa(c) {
  const f = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 3, 7, 4], [1, 5, 6, 2], [0, 4, 5, 1], [3, 2, 6, 7]];
  const pos = [];
  for (const [a, b, cc, d] of f) for (const i of [a, b, cc, a, cc, d]) pos.push(...c[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** 翼面：根部位置 (x0,y0,zLE)，展向长度 span（沿 +X 或 -X），带后掠/上反，side=+1 左翼 */
function wingPanel({ x0, y0, zLE, rootC, tipC, span, sweep, dih, tR, tT, side, vertical = false }) {
  const sw = Math.tan((sweep * Math.PI) / 180) * span;
  const dy = Math.tan((dih * Math.PI) / 180) * span;
  let c;
  if (!vertical) {
    const xt = x0 + side * span;
    c = [
      [x0, y0 + tR / 2, zLE], [x0, y0 + tR * 0.25, zLE - rootC], [xt, y0 + dy + tT * 0.25, zLE - sw - tipC], [xt, y0 + dy + tT / 2, zLE - sw],
      [x0, y0 - tR / 2, zLE], [x0, y0 - tR * 0.25, zLE - rootC], [xt, y0 + dy - tT * 0.25, zLE - sw - tipC], [xt, y0 + dy - tT / 2, zLE - sw],
    ];
    if (side < 0) c = [c[3], c[2], c[1], c[0], c[7], c[6], c[5], c[4]].map((p) => p);
  } else {
    const yt = y0 + span;
    c = [
      [-tR / 2, y0, zLE], [-tR * 0.2, y0, zLE - rootC], [-tT * 0.2, yt, zLE - sw - tipC], [-tT / 2, yt, zLE - sw],
      [tR / 2, y0, zLE], [tR * 0.2, y0, zLE - rootC], [tT * 0.2, yt, zLE - sw - tipC], [tT / 2, yt, zLE - sw],
    ];
  }
  const g = hexa(c);
  // 确保法线朝外：检查第一个面法线与 +Y（或 -X）方向
  return g;
}

function fixWinding(g, center) {
  // 若多数三角形法线指向中心则翻转
  const p = g.attributes.position.array;
  let score = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 9) {
    a.fromArray(p, i); b.fromArray(p, i + 3); c.fromArray(p, i + 6);
    n.subVectors(c, b).cross(m.subVectors(a, b));
    m.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(center);
    score += Math.sign(n.dot(m));
  }
  if (score > 0) {
    for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
    g.computeVertexNormals();
  }
  return g;
}

function cyl(r1, r2, len, seg, axis = 'z', open = false) {
  const g = new THREE.CylinderGeometry(r1, r2, len, seg, 1, open);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  return g;
}

/** 机身：车削体，头部略下垂、尾锥上翘；返回按三角形分好 part 的几何列表 */
function fuselage(T) {
  const { L, R } = T;
  const st = [[0, 0.02], [0.012, 0.36], [0.03, 0.62], [0.055, 0.82], [0.09, 0.95], [0.14, 1], [0.5, 1], [0.7, 1], [0.78, 0.9], [0.86, 0.68], [0.93, 0.42], [0.985, 0.16], [1, 0.08]];
  if (T.mil) { st.splice(7, 5, [0.66, 1], [0.75, 0.86], [0.85, 0.6], [0.94, 0.36], [1, 0.14]); }
  const pts = st.map(([f, r]) => new THREE.Vector2(Math.max(0.01, r * R), L / 2 - f * L));
  const seg = 16;
  let g = new THREE.LatheGeometry(pts.reverse(), seg);
  g.rotateX(Math.PI / 2); // lathe 的 y 轴 → +z（机头 +z）
  let p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const f = (L / 2 - v.z) / L;
    const r = Math.hypot(v.x, v.y);
    if (f > 0.7) v.y += (R - r) * (T.mil ? 0.95 : 0.88);
    else if (f < 0.12) v.y -= (R - r) * 0.3;
    v.y *= 1.04; // 机身截面略高于宽
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g = g.toNonIndexed();
  // 按三角形分组
  const parts = { 0: [], 1: [], 6: [], 9: [] };
  p = g.attributes.position;
  const arr = p.array, nrm = g.attributes.normal.array;
  for (let i = 0; i < arr.length; i += 9) {
    const cx = (arr[i] + arr[i + 3] + arr[i + 6]) / 3, cy = (arr[i + 1] + arr[i + 4] + arr[i + 7]) / 3, cz = (arr[i + 2] + arr[i + 5] + arr[i + 8]) / 3;
    const f = (L / 2 - cz) / L;
    let part = 0;
    if (cy < -0.42 * R) part = 1;
    else if (!T.mil && cy > -0.2 * R && cy < -0.02 * R && f > 0.1 && f < 0.8) part = 9;
    if (f > 0.03 && f < 0.075 && cy > 0.02 * R && cy < 0.6 * R && Math.abs(cx) < 0.8 * R) part = 6;
    parts[part].push(i);
  }
  const out = [];
  for (const [part, idx] of Object.entries(parts)) {
    if (!idx.length) continue;
    const pos = new Float32Array(idx.length * 9), nn = new Float32Array(idx.length * 9);
    idx.forEach((s, k) => { pos.set(arr.subarray(s, s + 9), k * 9); nn.set(nrm.subarray(s, s + 9), k * 9); });
    const q = new THREE.BufferGeometry();
    q.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    q.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
    out.push(tag(q, +part));
  }
  // 客舱舷窗条（两侧）
  if (T.pitch) {
    const z0 = L / 2 - 0.12 * L, z1 = L / 2 - 0.74 * L, h = Math.max(0.36, R * 0.2), y = R * 0.2;
    for (const s of [1, -1]) {
      const x = Math.sqrt(R * R - y * y) * 1.0 + 0.03;
      const pos = [s * x, y - h / 2, z0, s * x, y + h / 2, z0, s * x, y + h / 2, z1, s * x, y - h / 2, z1];
      const len = (z0 - z1) / T.pitch;
      const aux = [0, 0, 0, 1, len, 1, len, 0];
      const q = new THREE.BufferGeometry();
      q.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      q.setIndex(s > 0 ? [0, 3, 2, 0, 2, 1] : [0, 1, 2, 0, 2, 3]);
      const auxA = new THREE.Float32BufferAttribute(aux, 2);
      q.setAttribute('aux', auxA);
      q.computeVertexNormals();
      const ni = q.toNonIndexed();
      out.push(tag(ni, PART.WIN, ni.attributes.aux.array));
    }
  }
  return out;
}

function engineGeo(T, e, side, wingLE, wingY) {
  const out = [];
  const x = side * e.s;
  const sweepOff = Math.tan((T.sweep * Math.PI) / 180) * (e.s - T.R);
  const dy = Math.tan((T.dih * Math.PI) / 180) * (e.s - T.R);
  const high = T.wingY > 0;
  const y = wingY + dy + (high ? -e.r * 0.55 : -e.r * 1.05);
  const zc = wingLE - sweepOff + (T.turboprop ? e.len * 0.2 : e.len * 0.42);
  const m = new THREE.Matrix4();
  // 短舱（前粗后细）
  const nac = new THREE.LatheGeometry([[0.35, 1.12], [0.7, 1], [0.98, 0.5], [1, 0.12], [0.92, 0]].map(([r, f]) => new THREE.Vector2(e.r * r, -f * e.len)), 14);
  nac.rotateX(Math.PI / 2);
  if (e.flat) nac.scale(1, e.flat, 1);
  nac.translate(x, y, zc);
  out.push(tag(nac, PART.ENG));
  const inl = new THREE.CircleGeometry(e.r * 0.86, 14);
  if (e.flat) inl.scale(1, e.flat, 1);
  inl.translate(x, y, zc - 0.25);
  out.push(tag(inl, PART.DARK));
  // 挂架
  const pyl = new THREE.BoxGeometry(0.25 * e.r, Math.abs(wingY + dy - y) + 0.2, e.len * 0.8);
  pyl.translate(x, (y + wingY + dy) / 2 + (high ? 0 : 0.1), zc - e.len * 0.45);
  out.push(tag(pyl, PART.METAL));
  if (e.prop) {
    for (let k = 0; k < 6; k++) {
      const bl = new THREE.BoxGeometry(0.22, e.prop / 2, 0.06);
      bl.translate(0, e.prop / 4, 0); bl.rotateZ((k * Math.PI) / 3 + 0.3); bl.translate(x, y, zc + 0.35);
      out.push(tag(bl, PART.PROP));
    }
    const sp = new THREE.ConeGeometry(e.r * 0.4, 0.9, 10); sp.rotateX(Math.PI / 2); sp.translate(x, y, zc + 0.7);
    out.push(tag(sp, PART.METAL));
  }
  return out;
}

function gearGeo(T) {
  const out = [];
  const R = T.R, yb = T.yc - R * 1.04; // 机身底部高度
  const wheelR = T.L > 50 ? 0.62 : T.L > 30 ? 0.57 : 0.4;
  // 主起落架（局部 z=0 为主轮接地点，机身中点在 z=-mgz）
  const mainX = T.wingY > 0 ? R * 0.9 : T.span * (T.L > 50 ? 0.09 : 0.105);
  for (const s of [1, -1]) {
    const x = s * mainX;
    const st = cyl(0.14, 0.14, Math.max(0.5, T.yc - R * 0.3 - wheelR), 6, 'y');
    st.translate(x, (T.yc - R * 0.3 + wheelR) / 2, 0);
    out.push(tag(st, PART.GEAR));
    const bogie = T.L > 50 ? [-0.9, 0.9, 0] : T.wingY > 0 ? [-0.8, 0.8] : [0];
    for (const bz of bogie) for (const wx of [-0.5, 0.5]) {
      const w = cyl(wheelR, wheelR, 0.45, 12, 'x');
      w.translate(x + wx * (T.L > 50 ? 1.4 : 0.9), wheelR, bz);
      out.push(tag(w, PART.GEAR));
    }
  }
  // 前起落架
  const nz = T.wb;
  const nw = wheelR * 0.75;
  const st = cyl(0.1, 0.1, Math.max(0.4, yb + 0.3 - nw), 6, 'y');
  st.translate(0, (yb + 0.3 + nw) / 2, nz);
  out.push(tag(st, PART.GEAR));
  for (const wx of [-0.28, 0.28]) {
    const w = cyl(nw, nw, 0.3, 10, 'x');
    w.translate(wx, nw, nz);
    out.push(tag(w, PART.GEAR));
  }
  return out;
}

/** 构建机型几何（已平移到主轮原点），返回 {geometry, T} */
export function buildAircraftGeometry(key) {
  const T = TYPES[key];
  const list = [];
  const shift = new THREE.Matrix4().makeTranslation(0, T.yc, -T.mgz); // 机身中点 → 主轮原点
  const body = fuselage(T);
  for (const g of body) list.push(g.applyMatrix4(shift));
  // 机翼
  const wy = T.wingY * T.R;
  const wingLE = T.wingZ + T.rootC * 0.25;
  const semi = T.span / 2 - T.R * 0.8 - (T.winglet ? 0.2 : 0);
  for (const side of [1, -1]) {
    const x0 = side * T.R * 0.8;
    const w = wingPanel({ x0, y0: wy, zLE: wingLE, rootC: T.rootC, tipC: T.tipC, span: semi, sweep: T.sweep, dih: T.dih, tR: T.wingT, tT: T.wingT * 0.35, side });
    fixWinding(w, new THREE.Vector3(side * (T.R + semi * 0.4), wy, wingLE - T.rootC * 0.6));
    list.push(tag(w, PART.WING).applyMatrix4(shift));
    // 前缘缝翼条（金属灰）
    const sl = wingPanel({ x0: x0 + side * 0.4, y0: wy + 0.01, zLE: wingLE + 0.05, rootC: T.rootC * 0.12, tipC: T.tipC * 0.14, span: semi - 0.8, sweep: T.sweep, dih: T.dih, tR: T.wingT * 0.9, tT: T.wingT * 0.34, side });
    fixWinding(sl, new THREE.Vector3(side * (T.R + semi * 0.4), wy, wingLE - T.rootC * 0.05));
    list.push(tag(sl, PART.METAL).applyMatrix4(shift));
    const tipX = x0 + side * semi, tipY = wy + Math.tan((T.dih * Math.PI) / 180) * semi, tipZ = wingLE - Math.tan((T.sweep * Math.PI) / 180) * semi;
    if (T.winglet) {
      const cant = T.curved ? 0.5 : 0.25;
      const wl = hexa([
        [tipX, tipY + 0.1, tipZ], [tipX, tipY + 0.05, tipZ - T.tipC], [tipX + side * T.winglet * cant, tipY + T.winglet, tipZ - T.tipC - T.winglet * 0.55], [tipX + side * T.winglet * cant, tipY + T.winglet, tipZ - T.winglet * 0.8],
        [tipX - side * 0.12, tipY + 0.1, tipZ], [tipX - side * 0.12, tipY + 0.05, tipZ - T.tipC], [tipX + side * (T.winglet * cant - 0.08), tipY + T.winglet, tipZ - T.tipC - T.winglet * 0.55], [tipX + side * (T.winglet * cant - 0.08), tipY + T.winglet, tipZ - T.winglet * 0.8],
      ]);
      fixWinding(wl, new THREE.Vector3(tipX + side * T.winglet * cant * 0.3, tipY + T.winglet * 0.5, tipZ - T.tipC));
      list.push(tag(wl, PART.FINA).applyMatrix4(shift));
    }
    for (const e of T.eng) for (const g of engineGeo(T, e, side, wingLE, wy)) list.push(g.applyMatrix4(shift));
    // 水平尾翼
    const hz = -T.L / 2 + T.hC * 1.35 + (T.ttail ? -T.vC * 0.2 : 0);
    const hy = T.ttail ? T.R * 0.7 + T.vH * 0.95 : T.R * 0.15;
    const hsw = T.ttail ? T.vH * Math.tan((35 * Math.PI) / 180) * 0.95 : 0;
    const hs = wingPanel({ x0: side * (T.ttail ? 0.2 : T.R * 0.35), y0: hy, zLE: hz - hsw + T.hC, rootC: T.hC, tipC: T.hC * 0.4, span: T.hspan / 2 - T.R * 0.3, sweep: T.sweep + 6, dih: T.ttail ? -2 : 6, tR: 0.35, tT: 0.12, side });
    fixWinding(hs, new THREE.Vector3(side * T.hspan * 0.25, hy, hz - hsw + T.hC * 0.5));
    list.push(tag(hs, T.mil ? PART.BODY : PART.WING).applyMatrix4(shift));
  }
  // 垂尾（按对角线分两色）
  const vz = -T.L / 2 + T.vC * 1.25 + (T.mil ? 0 : 0.6);
  const vy = T.R * 0.55;
  const fin = wingPanel({ x0: 0, y0: vy, zLE: vz, rootC: T.vC, tipC: T.vC * 0.38, span: T.vH, sweep: 36, dih: 0, tR: 0.45, tT: 0.18, vertical: true });
  fixWinding(fin, new THREE.Vector3(0, vy + T.vH * 0.4, vz - T.vC * 0.6));
  {
    const arr = fin.attributes.position.array, nrm = fin.attributes.normal.array;
    const A = [], B = [];
    for (let i = 0; i < arr.length; i += 9) {
      const cy = (arr[i + 1] + arr[i + 4] + arr[i + 7]) / 3, cz = (arr[i + 2] + arr[i + 5] + arr[i + 8]) / 3;
      const hf = (cy - vy) / T.vH, zf = (vz - cz) / T.vC;
      (hf + zf * 0.35 > 0.62 ? A : B).push(i);
    }
    for (const [idx, part] of [[A, PART.FINA], [B, PART.FINB]]) {
      if (!idx.length) continue;
      const pos = new Float32Array(idx.length * 9), nn = new Float32Array(idx.length * 9);
      idx.forEach((s, k) => { pos.set(arr.subarray(s, s + 9), k * 9); nn.set(nrm.subarray(s, s + 9), k * 9); });
      const q = new THREE.BufferGeometry();
      q.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      q.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
      list.push(tag(q, part).applyMatrix4(shift));
    }
  }
  // 起落架（已在主轮坐标系）
  for (const g of gearGeo(T)) list.push(g);
  // 军机：机身背鳍/起落架整流罩
  if (T.mil) {
    for (const s of [1, -1]) {
      const pod = new THREE.BoxGeometry(1.0, 1.5, 9);
      pod.translate(s * T.R * 0.95, T.yc - T.R * 0.7, -T.mgz - 0.5 - (-T.mgz));
      list.push(tag(pod, PART.BELLY));
    }
  }
  const geometry = mergeGeometries(list, false);
  geometry.computeBoundingSphere();
  return { geometry, T };
}

/** 生成着色器调色板 uniform（vec3 数组） */
export function liveryUniform() {
  const arr = [];
  for (const l of LIVERIES) for (const c of l) arr.push(new THREE.Color(c).convertSRGBToLinear());
  return { value: arr };
}

/**
 * 飞机材质：MeshStandardMaterial + onBeforeCompile，按 part 与实例涂装索引着色；舷窗夜间发光；可收起落架。
 */
export function aircraftMaterial(ctx, T, palette) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.08 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPal = palette;
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float part; attribute vec2 aux; attribute float aLiv; attribute float aGear;
        varying float vPart; varying vec2 vAux; varying float vLiv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPart = part; vAux = aux; vLiv = aLiv;
        if (part > 9.5 && part < 10.5 && aGear < 0.5) transformed = vec3(0.0, ${(T.yc * 0.9).toFixed(2)}, ${(-T.mgz).toFixed(2)});`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uPal[${LIVERIES.length * 6}]; uniform float uNight;
        varying float vPart; varying vec2 vAux; varying float vLiv;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        int pi = int(vPart + 0.5); int li = int(vLiv + 0.5) * 6;
        vec3 pc = uPal[li];
        float wmask = 0.0;
        if (pi == 1) pc = uPal[li + 1];
        else if (pi == 2) pc = uPal[li + 2];
        else if (pi == 3) pc = uPal[li + 3];
        else if (pi == 4) pc = uPal[li + 4];
        else if (pi == 9) pc = uPal[li + 5];
        else if (pi == 5) pc = vec3(0.42, 0.44, 0.46);
        else if (pi == 6) pc = vec3(0.025, 0.028, 0.032);
        else if (pi == 8) pc = vec3(0.55, 0.57, 0.6);
        else if (pi == 10) pc = vec3(0.3, 0.31, 0.32);
        else if (pi == 11) pc = vec3(0.12);
        else if (pi == 7) {
          float a = fract(vAux.x); float b = vAux.y;
          wmask = smoothstep(0.28, 0.34, a) * (1.0 - smoothstep(0.66, 0.72, a)) * smoothstep(0.1, 0.22, b) * (1.0 - smoothstep(0.78, 0.9, b));
          pc = mix(uPal[li], vec3(0.03, 0.04, 0.05), wmask);
        }
        diffuseColor.rgb = pc;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        if (pi == 4 || pi == 5) roughnessFactor = 0.3; if (pi == 6) roughnessFactor = 0.15; if (pi == 10) roughnessFactor = 0.6;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        if (pi == 5 || pi == 8) metalnessFactor = 0.55; if (pi == 4) metalnessFactor = 0.25;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.78, 0.5) * wmask * uNight * 2.2;`);
  };
  m.customProgramCacheKey = () => 'xiy-aircraft-' + T.name;
  return m;
}

/** 单架飞机的灯位（本地坐标，主轮原点），供动态灯光使用：[x,y,z,类型] 类型 0 红航行 1 绿航行 2 白尾灯 3 红防撞 4 白频闪 5 着陆灯 */
export function aircraftLightOffsets(T) {
  const semi = T.span / 2;
  const tipY = T.yc + T.wingY * T.R + Math.tan((T.dih * Math.PI) / 180) * (semi - T.R);
  const tipZ = -T.mgz + T.wingZ + T.rootC * 0.25 - Math.tan((T.sweep * Math.PI) / 180) * (semi - T.R) - T.tipC * 0.3;
  return [
    [semi, tipY, tipZ, 0], [-semi, tipY, tipZ, 1],
    [semi, tipY, tipZ - T.tipC * 0.6, 4], [-semi, tipY, tipZ - T.tipC * 0.6, 4],
    [0, T.yc + T.R * 0.98, -T.mgz + T.L * 0.05, 3], [0, T.yc - T.R * 1.05, -T.mgz - T.L * 0.05, 3],
    [0, T.yc + T.R * 0.2, -T.mgz - T.L / 2 + 0.2, 2],
    [T.R * 1.6, T.yc + T.wingY * T.R - 0.3, -T.mgz + T.wingZ + T.rootC * 0.3, 5], [-T.R * 1.6, T.yc + T.wingY * T.R - 0.3, -T.mgz + T.wingZ + T.rootC * 0.3, 5],
    [0, T.yc - T.R * 0.4, T.wb + 0.2, 5],
  ];
}
