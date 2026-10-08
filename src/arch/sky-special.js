// skyline：非塔楼类地标（电视塔、长安塔、奥体中心、西安北站、丝路会议/展览中心、行政中心、商场附件）
import * as THREE from 'three';
import * as G from './sky-geom.js';
import { style as mkStyle } from './sky-facade.js';
import { groundMin } from './sky-towers.js';

const TAU = Math.PI * 2;
const hsl = (h, s, l) => new THREE.Color().setHSL(h, s, l);

/** 两点间细杆（方截面） */
export function strut(a, b, w = 0.4) {
  const d = new THREE.Vector3().subVectors(b, a);
  const L = d.length();
  const g = new THREE.BoxGeometry(w, L, w);
  g.translate(0, L / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}
function nonIndexed(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** 两个等点数环之间的“裙边”曲面（环为 [x,y,z] 数组），outward 以 (cx,cz) 为中心判定 */
function loft(r0, r1, cx, cz, closed = true) {
  const pos = [], n = r0.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    const a = r0[i], b = r0[j], c = r1[j], d = r1[i];
    // 以面中心相对中轴方向判断朝外
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const mx = (a[0] + c[0]) / 2 - cx, mz = (a[2] + c[2]) / 2 - cz;
    if (nx * mx + nz * mz >= 0) pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    else pos.push(...a, ...c, ...b, ...a, ...d, ...c);
  }
  return nonIndexed(pos);
}
const ringPts = (cx, cz, r, y, n, a0 = 0) => {
  const o = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    o.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
  }
  return o;
};
const flat = (ring) => ring.flatMap((p) => [p[0], p[2]]);

// ================= 陕西广播电视塔（设计 245 m，塔总高 249 m：zh.wikipedia / 本地宝“设计高度 245 米，塔总高 249 米”） =================
// 1987 年建成；塔身白色八棱柱收分，其上八角形玻璃塔楼（菱形钢框）、观景檐、小塔楼，钢桅杆至 249 m。夜间塔楼通亮、塔身竖向灯带、桅杆红色障碍灯。
// 2026-10 下移 16 m：维基信息框“顶楼 160 m”、旅游资料“塔楼在 132~153 m 之间”，原模型塔楼 155~171.5 m、观景小塔楼到约 180 m，
// 塔身显得过长、塔楼偏上。现漏斗 131~139 m、玻璃塔楼 139~155.5 m、观景檐与小塔楼 155.5~164 m，桅杆起点随之下移，总高 249 m 不变。
const TV_Y1 = 131; // 塔身顶 / 塔楼下漏斗起点（离地米）
export function buildTVTower(env, { cx, cz, basePts }) {
  const { ctx, fb, solid, detail, mats, beacons } = env;
  const base = groundMin(ctx, basePts);
  // 裙楼（塔基大厅）
  const podSt = mkStyle({ mode: 6, floorH: 4.5, colW: 2.4, spandrel: 0.25, tint: '#36434d', spd: '#dcd8d0', lit: 0.8, seed: 3 });
  fb.prism(G.ccw(basePts), base - 3, base + 12, podSt, { vBase: base });
  solid.add(G.capGeometry(G.inset(G.ccw(basePts), 0.3), base + 12.05), mats.roof);
  // 塔身：八棱柱 r 9.5→6.4，竖向窄窗
  const n = 8, a0 = Math.PI / 8;
  const shaftSt = mkStyle({ mode: 8, floorH: 3.6, colW: 7.0, mullW: 6.1, spandrel: 0.45, tint: '#2e3a44', spd: '#a9aaa6', lit: 0.25, seed: 11 });
  const oct = (r, y) => G.circle(cx, cz, r, n, a0).map((v) => v);
  fb.ring(oct(9.8), oct(6.4), base - 2, base + TV_Y1, shaftSt, { vBase: base });
  // 塔身棱线灯带（夜间蓝色）
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    const p0 = new THREE.Vector3(cx + Math.cos(a) * 9.95, base + 14, cz + Math.sin(a) * 9.95);
    const p1 = new THREE.Vector3(cx + Math.cos(a) * 6.55, base + TV_Y1 - 1, cz + Math.sin(a) * 6.55);
    detail.add(strut(p0, p1, 0.35), mats.ledBlue);
  }
  // 塔楼下漏斗
  const y1 = base + TV_Y1, y2 = y1 + 8, y3 = y2 + 16.5; // 漏斗 8 m、玻璃塔楼 16.5 m
  solid.add(loft(ringPts(cx, cz, 6.4, y1, n, a0), ringPts(cx, cz, 15.5, y2, n, a0), cx, cz), mats.white);
  // 玻璃塔楼（八角，菱形钢框）
  const podGlass = mkStyle({ mode: 0, floorH: 5.5, colW: 3.0, spandrel: 0.0, mullW: 0.18, tint: '#4a6c80', spd: '#d8dadc', lit: 0.85, seed: 21 });
  fb.prism(G.circle(cx, cz, 15.5, n, a0), y2, y3, podGlass, { vBase: y2 });
  for (let i = 0; i < n; i++) {
    const aa = a0 + (i / n) * TAU, ab = a0 + ((i + 1) / n) * TAU, am = (aa + ab) / 2;
    const r = 15.75, rm = r * Math.cos(Math.PI / n);
    const A = new THREE.Vector3(cx + Math.cos(aa) * r, y2, cz + Math.sin(aa) * r);
    const B = new THREE.Vector3(cx + Math.cos(ab) * r, y2, cz + Math.sin(ab) * r);
    const Mt = new THREE.Vector3(cx + Math.cos(am) * rm, y3, cz + Math.sin(am) * rm);
    const Mb = new THREE.Vector3(cx + Math.cos(am) * rm, y2, cz + Math.sin(am) * rm);
    const At = A.clone().setY(y3), Bt = B.clone().setY(y3), Mm = Mb.clone().setY((y2 + y3) / 2);
    const Am = A.clone().setY((y2 + y3) / 2), Bm = B.clone().setY((y2 + y3) / 2);
    // 菱形：各边中点相连
    solid.add(strut(Mb, Am, 0.5), mats.white); solid.add(strut(Am, Mt, 0.5), mats.white);
    solid.add(strut(Mt, Bm, 0.5), mats.white); solid.add(strut(Bm, Mb, 0.5), mats.white);
    solid.add(strut(A, At, 0.7), mats.white);
    void Mm; void Bt;
  }
  // 观景檐（外挑环）+ 上部小塔楼
  solid.add(G.annulus(G.circle(cx, cz, 19.5, n, a0), G.circle(cx, cz, 11, n, a0), y3 + 1.6), mats.white);
  solid.add(loft(ringPts(cx, cz, 15.5, y3, n, a0), ringPts(cx, cz, 19.5, y3 + 1.6, n, a0), cx, cz), mats.white);
  const deckSt = mkStyle({ mode: 4, floorH: 7, colW: 2.2, spandrel: 0, mullW: 0.16, tint: '#557789', spd: '#ffd9a0', seed: 5 });
  fb.prism(G.circle(cx, cz, 11.5, n, a0), y3 + 1.6, y3 + 8.6, deckSt, { vLocal: true });
  solid.add(G.annulus(G.circle(cx, cz, 13, n, a0), G.circle(cx, cz, 4, n, a0), y3 + 8.8), mats.white);
  solid.add(loft(ringPts(cx, cz, 11.5, y3 + 8.6, n, a0), ringPts(cx, cz, 13, y3 + 8.8, n, a0), cx, cz), mats.white);
  solid.add(G.cyl(cx, y3 + 8.8, cz, 6.5, 5.5, 6.5, 8), mats.white);
  // 桅杆（小塔楼帽顶 → 249 m）
  const m0 = y3 + 15.3; // 顶部小塔楼帽顶（y3 + 8.8 + 6.5）
  solid.add(G.cyl(cx, m0, cz, 3.0, 2.2, 20, 8), mats.metal);
  solid.add(G.cyl(cx, m0 + 20, cz, 2.2, 1.4, 20, 8), mats.metal);
  solid.add(G.cyl(cx, m0 + 40, cz, 1.2, 0.35, base + 249 - m0 - 40, 8), mats.metal);
  for (const [yy, r] of [[m0 + 12, 4.2], [m0 + 27, 3.4]]) detail.add(G.cyl(cx, yy, cz, r, r, 1.1, 12), mats.white);
  for (let k = 0; k < 10; k++) detail.add(G.box(cx, m0 + 4 + k * 5.2, cz, 3.2, 0.3, 3.2, (k * Math.PI) / 10), mats.metal);
  beacons.add(cx, base + 249.5, cz, 0, 8);
  for (const yy of [m0 + 13.2, m0 + 28.2, m0 + 45]) beacons.add(cx + 3, yy, cz, 1, 3);
  for (let i = 0; i < 4; i++) {
    const a = a0 + (i / 4) * TAU;
    beacons.add(cx + Math.cos(a) * 19.5, y3 + 2.2, cz + Math.sin(a) * 19.5, 1, 3);
  }
  // 泛光：塔楼暖光点光源（进入光源池）
  ctx.lights.add({ position: new THREE.Vector3(cx, y2 - 6, cz), color: 0xffc98a, intensity: 2500, distance: 90, nightOnly: true, priority: 2 });
  return { base, top: base + 249 };
}

// ================= 长安塔（2011 世园会，约 99 m） =================
// 方形平面（旋转 45°），7 明层逐层收分，层间暗层，薄钢檐外挑，攒尖顶+塔刹；夜间逐层彩色 LED。
export function buildChanganTower(env, { cx, cz, rot }) {
  const { ctx, fb, solid, detail, mats, beacons } = env;
  const sq = (w) => G.rect(cx, cz, w, w, rot);
  const base = groundMin(ctx, sq(46));
  // 台基
  solid.add(G.wallGeometry(sq(58), sq(58), base - 3, base + 1.5), mats.granite);
  solid.add(G.capGeometry(sq(58), base + 1.5), mats.granite);
  solid.add(G.wallGeometry(sq(46), sq(46), base + 1.5, base + 4), mats.granite);
  solid.add(G.capGeometry(sq(46), base + 4), mats.granite);
  const hs = [13, 11.5, 10.5, 10, 9, 8.5, 7.5];
  let y = base + 4;
  const hues = [0.62, 0.66, 0.72, 0.78, 0.5, 0.4, 0.33];
  for (let k = 0; k < 7; k++) {
    const w = 34 - k * 2.6;
    const col = hsl(hues[k], 0.85, 0.55);
    const st = mkStyle({ mode: 4, floorH: hs[k], colW: 1.8, spandrel: 0, mullW: 0.16, tint: '#3c5a70', spd: [col.r, col.g, col.b], seed: k * 3 });
    fb.prism(sq(w), y, y + hs[k], st, { vLocal: true });
    y += hs[k];
    // 薄钢檐（四角起翘）
    const ov = 5.2 - k * 0.35, W = w + ov * 2;
    const outer = sq(W), inner = sq(w - 0.2);
    const lift = 1.6 - k * 0.1;
    const up = (px, pz) => {
      const dx = px - cx, dz = pz - cz;
      const c = Math.cos(-rot), s = Math.sin(-rot);
      const lx = Math.abs(dx * c - dz * s), lz = Math.abs(dx * s + dz * c);
      const t = Math.min(lx, lz) / (W / 2);
      return t > 0.72 ? ((t - 0.72) / 0.28) ** 2 * lift : 0;
    };
    const eaveOuter = [];
    // 细分外边以做起翘
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      for (let s = 0; s < 6; s++) {
        const t = s / 6;
        eaveOuter.push(outer[i * 2] + (outer[j * 2] - outer[i * 2]) * t, outer[i * 2 + 1] + (outer[j * 2 + 1] - outer[i * 2 + 1]) * t);
      }
    }
    const eaveInner = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      for (let s = 0; s < 6; s++) {
        const t = s / 6;
        eaveInner.push(inner[i * 2] + (inner[j * 2] - inner[i * 2]) * t, inner[i * 2 + 1] + (inner[j * 2 + 1] - inner[i * 2 + 1]) * t);
      }
    }
    const ey = y + 0.9;
    solid.add(G.annulus(eaveOuter, eaveInner, (px, pz) => ey + up(px, pz)), mats.white);
    solid.add(G.annulus(eaveInner, eaveOuter, (px, pz) => ey - 0.9 + up(px, pz) * 0.9), mats.white);
    solid.add(G.wallGeometry(eaveOuter, eaveOuter, (px, pz) => ey - 0.9 + up(px, pz) * 0.9, (px, pz) => ey + up(px, pz)), mats.ledBlue);
    y += 0.9;
    // 暗层
    if (k < 6) {
      solid.add(G.wallGeometry(sq(w - 4), sq(w - 4), y, y + 1.4), mats.dark);
      y += 1.4;
    }
  }
  // 攒尖顶 + 塔刹
  const wt = 34 - 6 * 2.6 + 6;
  const top = sq(wt);
  const apex = [cx, y + 7, cz];
  const pos = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    pos.push(top[i * 2], y, top[i * 2 + 1], ...apex, top[j * 2], y, top[j * 2 + 1]);
  }
  solid.add(nonIndexed(pos), mats.white);
  detail.add(G.cyl(cx, y + 6.5, cz, 0.9, 0.2, 10, 8), ctx.mats.get('gold'));
  for (let k = 0; k < 5; k++) detail.add(G.cyl(cx, y + 8 + k * 1.3, cz, 1.6 - k * 0.2, 1.6 - k * 0.2, 0.35, 12), ctx.mats.get('gold'));
  beacons.add(cx, base + 99, cz, 0, 4);
  return { base, top: base + 99 };
}

// ================= 西安奥体中心（“石榴花”体育场、体育馆、游泳跳水馆） =================
export function buildAoti(env, o) {
  const { ctx, fb, solid, detail, mats } = env;
  // —— 体育场 ——
  {
    const { cx, cz } = o.stadium;
    const A = 150, B = 168, a = 86, b = 110;
    const base = groundMin(ctx, G.rect(cx, cz, A * 2, B * 2));
    const NT = 24 * 8, NS = 14;
    const P = (th, s) => {
      const f = Math.abs(Math.sin(12 * th));
      const notch = 1 - 0.05 * (1 - Math.sqrt(f)) * (1 - s);
      const rx = (A + (a - A) * s) * notch, rz = (B + (b - B) * s) * notch;
      const hb = s < 0.55 ? 16 + 38 * Math.sin((Math.PI / 2) * (s / 0.55)) : 54 - 9 * ((s - 0.55) / 0.45) ** 2;
      const bulge = 4.5 * Math.sqrt(f) * Math.sin(Math.PI * Math.min(1, s * 1.1));
      return [cx + Math.cos(th) * rx, base + hb + bulge, cz + Math.sin(th) * rz];
    };
    const pos = [], uv = [];
    for (let i = 0; i < NT; i++) for (let j = 0; j < NS; j++) {
      const t0 = (i / NT) * TAU, t1 = ((i + 1) / NT) * TAU, s0 = j / NS, s1 = (j + 1) / NS;
      const p00 = P(t0, s0), p10 = P(t1, s0), p11 = P(t1, s1), p01 = P(t0, s1);
      pos.push(...p00, ...p11, ...p10, ...p00, ...p01, ...p11);
      const u0 = (i / NT) * 24, u1 = ((i + 1) / NT) * 24;
      uv.push(u0, s0, u1, s1, u1, s0, u0, s0, u0, s1, u1, s1);
    }
    const shell = nonIndexed(pos);
    shell.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    // 夜景：花瓣折缝与外沿金色勾勒、花瓣面粉红泛光（“石榴花”）
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g2 = cv.getContext('2d'), img = g2.createImageData(256, 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) {
      const u = x / 255, sv = y / 63;
      const edge = Math.exp(-((Math.min(u, 1 - u) / 0.05) ** 2));
      const rim = Math.exp(-((sv / 0.07) ** 2)) + 0.6 * Math.exp(-(((1 - sv) / 0.05) ** 2));
      const k = 0.22 + 0.3 * (1 - sv) + edge * 0.9 + rim * 0.7;
      const gold = Math.min(1, edge * 0.9 + rim * 0.7);
      const r = 1.0, gg = 0.42 + 0.4 * gold, b = 0.38 - 0.2 * gold;
      const o = (y * 256 + x) * 4;
      img.data[o] = Math.min(255, r * k * 200); img.data[o + 1] = Math.min(255, gg * k * 200); img.data[o + 2] = Math.min(255, b * k * 200); img.data[o + 3] = 255;
    }
    g2.putImageData(img, 0, 0);
    const et = new THREE.CanvasTexture(cv);
    et.colorSpace = THREE.SRGBColorSpace; et.wrapS = THREE.RepeatWrapping;
    const shellMat = mats.membrane.clone();
    shellMat.emissiveMap = et; shellMat.emissive = new THREE.Color(0xffffff);
    shellMat.userData.ownUV = true;
    ctx.night.register(shellMat, { day: 0, night: 1.6 });
    solid.add(shell, shellMat);
    // 花瓣下檐外沿（垂直短裙）
    const rimR = [], rimR2 = [];
    for (let i = 0; i < NT; i++) { const p = P((i / NT) * TAU, 0); rimR.push(p); rimR2.push([p[0], p[1] - 3, p[2]]); }
    solid.add(loft(rimR2, rimR, cx, cz), mats.membrane);
    // 看台外墙（玻璃+石材）与看台
    const wall = [];
    for (let i = 0; i < 64; i++) { const t = (i / 64) * TAU; wall.push(cx + Math.cos(t) * (A - 16), cz + Math.sin(t) * (B - 16)); }
    fb.prism(G.ccw(wall), base - 2, base + 18, mkStyle({ mode: 6, floorH: 6, colW: 4, spandrel: 0.2, tint: '#3c4a55', spd: '#c9c3b8', lit: 0.8 }), { vBase: base });
    const stand = [];
    const ring = (rx, rz, y) => { const r = []; for (let i = 0; i < 96; i++) { const t = (i / 96) * TAU; r.push([cx + Math.cos(t) * rx, y, cz + Math.sin(t) * rz]); } return r; };
    stand.push(loft(ring(64, 90, base + 1.5), ring(A - 20, B - 20, base + 40), cx, cz));
    // 看台朝内：翻转法线
    for (const g of stand) {
      const p = g.attributes.position.array;
      for (let i = 0; i < p.length; i += 9) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
      g.computeVertexNormals();
      solid.add(g, mats.seats);
    }
    const track = ring(64, 90, base + 1.5).flatMap((p) => [p[0], p[2]]);
    solid.add(G.capGeometry(G.ccw(track), base + 1.5), mats.track);
    const field = ring(44, 70, 0).flatMap((p) => [p[0], p[2]]);
    solid.add(G.capGeometry(G.ccw(field), base + 1.6), mats.grass);
    // 场内泛光
    ctx.lights.add({ position: new THREE.Vector3(cx, base + 40, cz), color: 0xfff2e0, intensity: 3000, distance: 220, nightOnly: true, priority: 1 });
  }
  // —— 体育馆（多面体折板穹顶） ——
  {
    const { cx, cz, r } = o.arena;
    const base = groundMin(ctx, G.circle(cx, cz, r, 16));
    const N = 18;
    fb.prism(G.circle(cx, cz, r - 4, 48), base - 2, base + 9, mkStyle({ mode: 6, floorH: 9, colW: 3.2, spandrel: 0.1, tint: '#3d4d58', spd: '#d0ccc4', lit: 0.8 }), { vBase: base });
    const b0 = ringPts(cx, cz, r, base + 9, N), m0 = ringPts(cx, cz, r * 0.8, base + 29, N, Math.PI / N), t0 = ringPts(cx, cz, r * 0.42, base + 41, N);
    const pos = [];
    const tri = (p, q, s) => {
      const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e2 = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const mx = (p[0] + q[0] + s[0]) / 3 - cx, mz = (p[2] + q[2] + s[2]) / 3 - cz;
      if (nx * mx + nz * mz + ny * 30 >= 0) pos.push(...p, ...q, ...s); else pos.push(...p, ...s, ...q);
    };
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      tri(b0[i], b0[j], m0[i]); tri(m0[i], b0[j], m0[j]);
      tri(m0[i], m0[j], t0[j]); tri(m0[i], t0[j], t0[i]);
    }
    solid.add(nonIndexed(pos), mats.white);
    solid.add(G.capGeometry(flat(t0), base + 41), mats.glassRoof);
    // 折线灯带
    for (let i = 0; i < N; i++) detail.add(strut(new THREE.Vector3(...b0[i]), new THREE.Vector3(...m0[i]), 0.5), mats.ledBlue);
  }
  // —— 游泳跳水馆（弧形屋面） ——
  {
    const { cx, cz, w, d, rot } = o.aqua;
    const pts = G.rect(cx, cz, w, d, rot);
    const base = groundMin(ctx, pts);
    fb.prism(pts, base - 2, base + 20, mkStyle({ mode: 6, floorH: 10, colW: 3.5, spandrel: 0.1, tint: '#3e5160', spd: '#cfd3d6', lit: 0.8 }), { vBase: base });
    solid.add(vault(cx, cz, w + 4, d + 4, rot, base + 20, 9, 24), mats.white);
  }
}

/** 筒拱屋面：沿长边 w 方向，跨度 d，矢高 rise */
export function vault(cx, cz, w, d, rot, y0, rise, seg = 20) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (u, v, y) => [cx + u * c - v * s, y, cz + u * s + v * c];
  const pos = [];
  for (let k = 0; k < seg; k++) {
    const t0 = k / seg, t1 = (k + 1) / seg;
    const v0 = -d / 2 + d * t0, v1 = -d / 2 + d * t1;
    const h0 = y0 + rise * Math.sin(Math.PI * t0), h1 = y0 + rise * Math.sin(Math.PI * t1);
    const a = P(-w / 2, v0, h0), b = P(w / 2, v0, h0), cc = P(w / 2, v1, h1), dd = P(-w / 2, v1, h1);
    pos.push(...a, ...b, ...cc, ...a, ...cc, ...dd);
  }
  // 两端山墙
  for (const u of [-w / 2, w / 2]) for (let k = 0; k < seg; k++) {
    const t0 = k / seg, t1 = (k + 1) / seg;
    const v0 = -d / 2 + d * t0, v1 = -d / 2 + d * t1;
    const a = P(u, v0, y0), b = P(u, v0, y0 + rise * Math.sin(Math.PI * t0)), cc = P(u, v1, y0 + rise * Math.sin(Math.PI * t1)), dd = P(u, v1, y0);
    pos.push(...a, ...b, ...cc, ...a, ...cc, ...dd);
  }
  const g = nonIndexed(pos);
  // 统一朝上/朝外
  const nrm = g.attributes.normal.array, p = g.attributes.position.array;
  for (let i = 0; i < p.length; i += 9) {
    const mx = (p[i] + p[i + 3] + p[i + 6]) / 3 - cx, my = (p[i + 1] + p[i + 4] + p[i + 7]) / 3 - y0 + 0.5, mz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3 - cz;
    if (nrm[i] * mx + nrm[i + 1] * my * 50 + nrm[i + 2] * mz < 0) for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
  }
  g.computeVertexNormals();
  return g;
}

// ================= 西安北站（2011 年，高架站房 + 12 个菱形采光顶 + 两侧无站台柱雨棚） =================
export function buildNorthStation(env, { cx, cz, rot, w, L }) {
  const { ctx, fb, solid, detail, mats, signs } = env;
  const hall = G.rect(cx, cz, w, L, rot);
  const base = groundMin(ctx, hall);
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (u, v) => [cx + u * c - v * s, cz + u * s + v * c];
  const H = 32;
  fb.prism(hall, base - 2, base + H, mkStyle({ mode: 6, floorH: 8, colW: 4.5, mullW: 0.3, spandrel: 0.12, tint: '#3f5767', spd: '#cfd2d4', lit: 0.85, seed: 7 }), { vBase: base });
  // 大屋面（外挑 9 m，厚 3 m）
  const roof = G.rect(cx, cz, w + 18, L + 18, rot);
  solid.add(G.wallGeometry(roof, roof, base + H, base + H + 3), mats.white);
  solid.add(G.capGeometry(roof, base + H + 3), mats.parapet);
  solid.add(G.capGeometry(roof, base + H, { down: true }), mats.white);
  // 12 个菱形采光顶（横跨屋面）
  const ry = base + H + 3;
  for (let k = 0; k < 12; k++) {
    const v = -L / 2 + 30 + k * ((L - 60) / 11);
    const hx = w * 0.36, hz = 17, hh = 8;
    const Lp = P(-hx, v), Rp = P(hx, v), F = P(0, v - hz), B = P(0, v + hz), R1 = P(-hx * 0.55, v), R2 = P(hx * 0.55, v);
    const L3 = [Lp[0], ry, Lp[1]], Rt = [Rp[0], ry, Rp[1]], F3 = [F[0], ry, F[1]], B3 = [B[0], ry, B[1]], r1 = [R1[0], ry + hh, R1[1]], r2 = [R2[0], ry + hh, R2[1]];
    const pos = [];
    const tri = (a, b, cc) => {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
      const ny = e1[2] * e2[0] - e1[0] * e2[2];
      if (ny >= 0) pos.push(...a, ...b, ...cc); else pos.push(...a, ...cc, ...b);
    };
    tri(L3, F3, r1); tri(F3, r2, r1); tri(F3, Rt, r2); tri(L3, r1, B3); tri(r1, r2, B3); tri(B3, r2, Rt);
    solid.add(nonIndexed(pos), mats.white);
    const m1 = new THREE.Vector3(r1[0], r1[1] + 0.3, r1[2]), m2 = new THREE.Vector3(r2[0], r2[1] + 0.3, r2[2]);
    detail.add(strut(m1, m2, 2.2), mats.glassRoof);
  }
  // 两侧站台雨棚（高 14 m，横向分跨起脊）
  for (const side of [-1, 1]) {
    const cw = 128, u0 = side * (w / 2 + 9 + cw / 2);
    const [px, pz] = P(u0, 0);
    const can = G.rect(px, pz, cw, L - 40, rot);
    const cy = base + 14;
    solid.add(G.wallGeometry(can, can, cy, cy + 1.2), mats.white);
    solid.add(G.capGeometry(can, cy + 1.2), mats.parapet);
    solid.add(G.capGeometry(can, cy, { down: true }), mats.white);
    for (let k = 0; k < 11; k++) {
      const v = -(L - 40) / 2 + (k + 0.5) * ((L - 40) / 11);
      const [qx, qz] = P(u0, v);
      solid.add(vault(qx, qz, cw - 6, 22, rot, cy + 1.2, 2.2, 8), mats.glassRoof);
      for (const du of [-cw / 3, 0, cw / 3]) {
        const [sx, sz] = P(u0 + du, v);
        detail.add(G.cyl(sx, base, sz, 0.7, 0.7, 14, 8), mats.metal);
      }
    }
  }
  // 站名（南北立面，红字）
  for (const end of [1, -1]) {
    const [mx, mz] = P(0, end * (L / 2 + 9));
    const nx = -s * end, nz = c * end;
    signs.place('西安北站', { x: mx, y: base + H + 1.5, z: mz }, nx, nz, 7.5, 60, { color: '#e8322a', weight: 900, serif: true });
  }
  return { base };
}

// ================= 丝路国际会议中心（方形“唐风”大屋檐） =================
export function buildConference(env, { cx, cz, side, rot, name }) {
  const { ctx, fb, solid, detail, mats, signs } = env;
  const sq = (w) => G.rect(cx, cz, w, w, rot);
  const base = groundMin(ctx, sq(side));
  const inner = side * 0.84;
  // 列柱廊（石材柱 + 深色玻璃）
  fb.prism(sq(inner), base - 2, base + 30, mkStyle({ mode: 9, floorH: 10, colW: 9, mullW: 2.6, spandrel: 0.1, tint: '#2c3b46', spd: '#e3ded2', lit: 0.6, seed: 13 }), { vBase: base });
  // 大屋檐板
  const R = sq(side);
  solid.add(G.wallGeometry(R, R, base + 30, base + 35), mats.stone);
  solid.add(G.capGeometry(R, base + 35), mats.roof);
  solid.add(G.capGeometry(R, base + 30, { down: true }), mats.stone);
  // 檐口下的独立柱
  const n = 12;
  for (let e = 0; e < 4; e++) for (let k = 0; k < n; k++) {
    const t = -0.5 + (k + 0.5) / n;
    const c = Math.cos(rot), s = Math.sin(rot);
    const dir = [[0, -1], [1, 0], [0, 1], [-1, 0]][e];
    const u = dir[0] !== 0 ? dir[0] * side * 0.46 : t * side * 0.92;
    const v = dir[1] !== 0 ? dir[1] * side * 0.46 : t * side * 0.92;
    detail.add(G.cyl(cx + u * c - v * s, base, cz + u * s + v * c, 1.4, 1.4, 30, 10), mats.stone);
  }
  // 中央抬升体 + 圆鼓
  fb.prism(sq(side * 0.55), base + 35, base + 44, mkStyle({ mode: 7, floorH: 9, colW: 6, mullW: 1.8, spandrel: 0.2, tint: '#2c3b46', spd: '#e3ded2', lit: 0.5, seed: 17 }), { vBase: base + 35 });
  solid.add(G.capGeometry(sq(side * 0.55), base + 44), mats.roof);
  fb.prism(G.circle(cx, cz, side * 0.11, 32), base + 44, base + 50, mkStyle({ mode: 4, floorH: 6, colW: 2, tint: '#6d8aa0', spd: '#ffe0b0', seed: 19 }), { vLocal: true });
  solid.add(G.capGeometry(G.circle(cx, cz, side * 0.11, 32), base + 50), mats.glassRoof);
  // 檐口金色字
  if (name) for (const e of [2, 1]) {
    const poly = R;
    const i = e, j = (i + 1) % 4;
    const mx = (poly[i * 2] + poly[j * 2]) / 2, mz = (poly[i * 2 + 1] + poly[j * 2 + 1]) / 2;
    const L = Math.hypot(poly[j * 2] - poly[i * 2], poly[j * 2 + 1] - poly[i * 2 + 1]);
    const nx = (poly[j * 2 + 1] - poly[i * 2 + 1]) / L, nz = -(poly[j * 2] - poly[i * 2]) / L;
    signs.place(name, { x: mx, y: base + 32.5, z: mz }, nx, nz, 3.6, L * 0.6, { color: '#e8c678', weight: 800, serif: true });
  }
  return { base };
}

// ================= 展馆（按 OSM 轮廓的最小外接矩形生成筒拱展厅） =================
export function buildHall(env, poly, { h = 18, rise = 7, name = null } = {}) {
  const { ctx, fb, solid, detail, mats, signs } = env;
  const p = G.ccw(poly);
  const base = groundMin(ctx, p);
  const o = G.obb(p);
  const box = G.rect(o.cx, o.cz, o.w, o.d, o.rot);
  fb.prism(box, base - 2, base + h, mkStyle({ mode: 7, floorH: h / 2, colW: 8, mullW: 5.5, spandrel: 0.55, tint: '#34444f', spd: '#d4d6d6', lit: 0.4, seed: o.cx % 97 }), { vBase: base });
  // 沿长边方向排列的横向拱肋（卫星上的白色条纹）
  const ribs = Math.max(4, Math.round(o.w / 16));
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  for (let k = 0; k < ribs; k++) {
    const u = -o.w / 2 + (k + 0.5) * (o.w / ribs);
    solid.add(vault(o.cx + u * c, o.cz + u * s, o.w / ribs - 1.2, o.d + 3, o.rot, base + h, rise, 12), k % 2 ? mats.white : mats.parapet);
  }
  if (name) {
    const i = 0, j = 1;
    const mx = (box[i * 2] + box[j * 2]) / 2, mz = (box[i * 2 + 1] + box[j * 2 + 1]) / 2;
    const L = Math.hypot(box[j * 2] - box[i * 2], box[j * 2 + 1] - box[i * 2 + 1]);
    signs.place(name, { x: mx, y: base + h - 3, z: mz }, (box[j * 2 + 1] - box[i * 2 + 1]) / L, -(box[j * 2] - box[i * 2]) / L, 4, L * 0.7, { color: '#ffffff', weight: 800 });
  }
  return base;
}

// ================= 行政中心（新唐风：石材墙面 + 深灰庑殿/歇山式大屋顶） =================
// 注：SPECIAL.gov（FP.gov）实为未央路以东的市委/人大/政协院落与东侧西安市中医医院（research/refs/dossiers/north.json）；
//   西安市人民政府在未央路以西 (−669,−9258)（OSM r18903162，约 240×247 m 对称院落），目前由通用建筑表达
export function buildGovBlock(env, poly, { h, roof = true }) {
  const { ctx, fb, solid, mats } = env;
  const p = G.ccw(poly);
  const base = groundMin(ctx, p);
  const st = mkStyle({ mode: 9, floorH: 4.2, colW: 3.6, mullW: 1.5, spandrel: 0.36, tint: '#2b3740', spd: '#d8cfbd', lit: 0.3, seed: Math.abs(p[0]) % 71 });
  fb.prism(p, base - 2, base + h, st, { vBase: base });
  const o = G.obb(p);
  const fill = Math.abs(G.area(p)) / (o.w * o.d);
  if (roof && fill > 0.72) {
    // 庑殿顶：挑檐 2 m，正脊沿长边
    const ov = 2.2, W = o.w + ov * 2, D = o.d + ov * 2;
    const rh = Math.min(10, Math.max(3.5, D * 0.26));
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    const P = (u, v, y) => [o.cx + u * c - v * s, y, o.cz + u * s + v * c];
    const y0 = base + h;
    const a = P(-W / 2, -D / 2, y0), b = P(W / 2, -D / 2, y0), cc = P(W / 2, D / 2, y0), d = P(-W / 2, D / 2, y0);
    const r1 = P(-(W - D) / 2, 0, y0 + rh), r2 = P((W - D) / 2, 0, y0 + rh);
    const pos = [...a, ...r1, ...b, ...b, ...r1, ...r2, ...b, ...r2, ...cc, ...cc, ...r2, ...d, ...d, ...r2, ...r1, ...d, ...r1, ...a];
    const g = nonIndexed(pos);
    // 统一朝上
    const pa = g.attributes.position.array, na = g.attributes.normal.array;
    for (let i = 0; i < pa.length; i += 9) if (na[i + 1] < 0) for (let k = 0; k < 3; k++) { const t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t; }
    g.computeVertexNormals();
    solid.add(g, mats.roofTile, null, { worldUV: 1 });
    // 檐口厚度（深灰）
    const eave = G.rect(o.cx, o.cz, W, D, o.rot);
    solid.add(G.wallGeometry(eave, eave, y0 - 0.9, y0), mats.dark);
    solid.add(G.capGeometry(eave, y0 - 0.9, { down: true }), mats.dark);
  } else {
    solid.add(G.wallGeometry(p, p, base + h, base + h + 1.2), mats.stone);
    solid.add(G.capGeometry(G.inset(p, 0.3), base + h + 0.1), mats.roof);
  }
  return base;
}

/** 熙地港屋面白色椭球采光罩 */
export function domes(env, list, y) {
  const { solid, mats } = env;
  for (const [x, z, rx, rz] of list) {
    const g = new THREE.SphereGeometry(1, 20, 8, 0, TAU, 0, Math.PI / 2);
    g.scale(rx, 5, rz);
    g.translate(x, y, z);
    solid.add(g, mats.white);
  }
}

// ================= 在建超高层（西安环球贸易中心 1 号楼：幕墙施工到低区、上部裸露楼板、核心筒领先、塔吊） =================
export function buildUnderConstruction(env, { pts, facadeTo, slabTo, coreTo }) {
  const { ctx, fb, solid, detail, mats, beacons } = env;
  const p = G.ccw(pts);
  const base = groundMin(ctx, p);
  const c = G.centroid(p);
  fb.prism(p, base - 2, base + facadeTo, mkStyle({ tint: '#3d5a70', spd: '#56626c', floorH: 4.2, colW: 1.5, spandrel: 0.26, lit: 0.05, seed: 31 }), { vBase: base });
  // 裸露结构：楼板+柱（混凝土灰）与黑洞洞的内部
  fb.prism(G.inset(p, 0.4), base + facadeTo, base + slabTo, mkStyle({ mode: 7, floorH: 4.2, colW: 8.5, mullW: 0.9, spandrel: 0.16, tint: '#15181b', spd: '#9c988f', lit: 0.0, seed: 32 }), { vBase: base });
  solid.add(G.capGeometry(G.inset(p, 0.4), base + slabTo), mats.roof);
  const core = G.rect(c.x, c.z, 24, 22, 0);
  solid.add(G.wallGeometry(core, core, base + slabTo, base + coreTo), mats.roof);
  solid.add(G.capGeometry(core, base + coreTo), mats.roof);
  // 塔吊
  const mx = c.x + 18, mz = c.z - 18, top = base + coreTo + 34;
  detail.add(G.box(mx, (base + top) / 2, mz, 2.0, top - base, 2.0), mats.yellow);
  detail.add(G.box(mx + 22, top + 1, mz, 62, 1.6, 1.4), mats.yellow);
  detail.add(G.box(mx - 14, top + 1, mz, 20, 1.4, 2.2), mats.yellow);
  detail.add(G.box(mx - 20, top - 0.5, mz, 5, 3, 3), mats.roof);
  detail.add(G.box(mx, top + 5, mz, 1.0, 9, 1.0), mats.yellow);
  beacons.add(mx, top + 10, mz, 0, 4);
  beacons.add(mx + 52, top + 2, mz, 1, 2.5);
  return { base };
}
