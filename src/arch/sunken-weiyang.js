// 未央城市广场（原张家堡环岛，2026-02 改造完成）：原环岛中心岛改为城市广场，四个象限各一个花瓣形下沉庭院——
//   西南：水景台阶（逐级退台围合的阶梯看台，坑底水池）  西北：双层商业（两层店面 + 二层挑廊）
//   东南：檐廊（坑底一圈柱廊 + 平顶檐廊，后为店面）    东北：绿坡（逐级草坡退台）
// 广场地面花岗岩铺装 + 十字形浅色步道（对应改造后的未央路 / 凤城八路十字）、灯柱、坐凳、行道树。
// 道路数据仍是旧环岛（roads.json 不归本模块），本模块只占环岛中心岛（环路中线内缩 8.5 m），四个花瓣之间留出十字通道。
// 资料：审查 g8（wy_zjb.png）；尺寸为估计值：花瓣径向半轴 44 m、切向半轴 27 m，中心距广场中心 72 m，下沉 7 m。
import * as THREE from 'three';
import * as G from './sky-geom.js';
import { courtyardTrees } from './streetscape-trees.js';

const c3 = (h) => new THREE.Color(h);
const PETAL = { r: 72, a: 44, b: 27, n: 32, depth: 7 };
// 象限：角度（x 东、z 南，atan2(z, x)），类型
const QUADS = [
  { ang: (3 * Math.PI) / 4, kind: 'water', name: '西南·水景台阶' }, // 西南（-x, +z）
  { ang: (-3 * Math.PI) / 4, kind: 'shops2', name: '西北·双层商业' }, // 西北（-x, -z）
  { ang: Math.PI / 4, kind: 'arcade', name: '东南·檐廊' }, // 东南（+x, +z）
  { ang: -Math.PI / 4, kind: 'green', name: '东北·绿坡' }, // 东北（+x, -z）
];

/** 由环岛环路中线（扁平世界坐标，闭合）求广场与四个花瓣坑口 */
export function weiyangFootprints(ringP) {
  const pts = [];
  for (let i = 0; i + 1 < ringP.length; i += 2) pts.push(ringP[i], ringP[i + 1]);
  if (pts.length > 4 && Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) < 0.5) pts.length -= 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cz += pts[i + 1]; }
  cx /= pts.length / 2; cz /= pts.length / 2;
  const island = G.inset(G.ccw(pts), 8.5);
  const petals = QUADS.map((q) => {
    const ux = Math.cos(q.ang), uz = Math.sin(q.ang), vx = -uz, vz = ux;
    const pcx = cx + ux * PETAL.r, pcz = cz + uz * PETAL.r;
    const p = [];
    for (let i = 0; i < PETAL.n; i++) {
      const t = (i / PETAL.n) * Math.PI * 2;
      // 花瓣：朝广场中心一端收尖（切向半轴随径向位置缩放）
      const ru = Math.cos(t) * PETAL.a, k = 0.62 + 0.38 * ((Math.cos(t) + 1) / 2);
      const rv = Math.sin(t) * PETAL.b * k;
      p.push(pcx + ux * ru + vx * rv, pcz + uz * ru + vz * rv);
    }
    return { ...q, poly: G.ccw(p), cx: pcx, cz: pcz, ux, uz };
  });
  return { island, petals, cx, cz };
}

class Mesh {
  constructor() { this.p = []; this.c = []; this.uv = []; }
  tri(a, b, c, col, uv) {
    this.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.c.push(col.r, col.g, col.b);
    this.uv.push(...(uv ? uv.flat() : [a[0] / 4, a[2] / 4, b[0] / 4, b[2] / 4, c[0] / 4, c[2] / 4]));
  }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  /** 盒子：底面多边形四角 + 高 */
  box(x, z, y0, y1, hx, hz, ux, uz, col, top = col) {
    const vx = -uz, vz = ux;
    const P = (su, sv, y) => [x + ux * su * hx + vx * sv * hz, y, z + uz * su * hx + vz * sv * hz];
    const a = P(-1, -1, y0), b = P(1, -1, y0), c = P(1, 1, y0), d = P(-1, 1, y0);
    const e = P(-1, -1, y1), f = P(1, -1, y1), g = P(1, 1, y1), h = P(-1, 1, y1);
    this.quad(e, h, g, f, top);
    this.quad(a, b, f, e, col); this.quad(b, c, g, f, col); this.quad(c, d, h, g, col); this.quad(d, a, e, h, col);
  }
  /** 多边形面（含洞），y 常数 */
  poly(outer, holes, y, col) {
    const toV = (p) => { const v = []; for (let i = 0; i < p.length; i += 2) v.push(new THREE.Vector2(p[i], p[i + 1])); return v; };
    const O = toV(outer), H = holes.map(toV);
    const tris = THREE.ShapeUtils.triangulateShape(O, H);
    const all = [...O, ...H.flat()];
    for (const [i, j, k] of tris) {
      const A = all[i], B = all[j], C = all[k];
      // 朝上：(B-A)×(C-A) 的 y 分量 = (Bz-Az)(Cx-Ax) - (Bx-Ax)(Cz-Az) > 0（x 东 z 南的平面，三角剖分结果的绕向不定）
      const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) > 0;
      if (up) this.tri([A.x, y, A.y], [B.x, y, B.y], [C.x, y, C.y], col);
      else this.tri([A.x, y, A.y], [C.x, y, C.y], [B.x, y, B.y], col);
    }
  }
  mesh(mat, name) {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.receiveShadow = true;
    m.castShadow = true;
    return m;
  }
}

function graniteTex() {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let s = 29;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = 4, b = S / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = 168 + r() * 26 | 0;
    g.fillStyle = `rgb(${v},${v - 3},${v - 8})`;
    g.fillRect(i * b, j * b, b, b);
  }
  for (let k = 0; k < 3000; k++) { const v = r() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${0.04 + r() * 0.06})`; g.fillRect(r() * S, r() * S, 1.5, 1.5); }
  g.strokeStyle = 'rgba(60,56,50,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * b, 0); g.lineTo(i * b, S); g.stroke(); g.beginPath(); g.moveTo(0, i * b); g.lineTo(S, i * b); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** 构建：fp = weiyangFootprints()；H0 = 广场（平整后）地面高；tops = 各花瓣压顶高 */
export function buildWeiyang(ctx, fp, H0) {
  const group = new THREE.Group();
  group.name = '未央城市广场';
  const pave = new Mesh(), solid = new Mesh(), glass = new Mesh(), lamp = new Mesh(), water = new Mesh(), rail = new Mesh(), grass = new Mesh();
  const PAVE = c3('#ffffff'), CROSS = c3('#e8e2d6'), WALL = c3('#c9c1b3'), STONE = c3('#d8d2c6'), DARK = c3('#3e4247'), WOOD = c3('#8a6a4a');
  const SHOP = [c3('#ffd9a0'), c3('#ffe6c4'), c3('#fff0d8'), c3('#ffc98a')], SIGN = [c3('#c9302c'), c3('#1f4e79'), c3('#2d6a4f'), c3('#b8860b'), c3('#222222')];
  const GREEN = c3('#5a8a3e'), GREEN2 = c3('#4c7a34');
  const lights = [], treePts = [];
  const { cx, cz } = fp;
  const yP = H0 + 0.12;
  // —— 广场铺装（中心岛减去四个花瓣坑口外扩 0.6 m 的压顶）+ 十字浅色步道 ——
  const holes = fp.petals.map((P) => G.inset(P.poly, -0.6));
  pave.poly(fp.island, holes, yP, PAVE);
  const inPetal = (x, z, m = 0) => fp.petals.some((P) => G.pointIn(x, z, m ? G.inset(P.poly, -m) : P.poly));
  for (const [ux, uz] of [[1, 0], [0, 1]]) {
    const vx = -uz, vz = ux, L = 140, W = 9;
    for (let s = -L; s < L; s += 10) {
      const s1 = Math.min(L, s + 10);
      const P = (t, w) => [cx + ux * t + vx * w, yP + 0.012, cz + uz * t + vz * w];
      // 步道段整段在广场内才铺（靠环路两端留给原铺装）
      if (!G.pointIn(cx + ux * s1 + vx * W, cz + uz * s1 + vz * W, fp.island) || !G.pointIn(cx + ux * s - vx * W, cz + uz * s - vz * W, fp.island)) continue;
      pave.quad(P(s, -W), P(s, W), P(s1, W), P(s1, -W), CROSS);
    }
    // 步道两侧灯柱 + 行道树
    for (let t = -126; t <= 126; t += 18) {
      if (Math.abs(t) < 12) continue;
      for (const sd of [-1, 1]) {
        const x = cx + ux * t + vx * sd * (W + 2.5), z = cz + uz * t + vz * sd * (W + 2.5);
        if (!G.pointIn(x, z, fp.island) || inPetal(x, z, 3)) continue;
        if ((Math.round(t / 18) & 1) === 0) {
          solid.box(x, z, yP, yP + 4.6, 0.09, 0.09, 1, 0, DARK);
          lamp.box(x, z, yP + 4.6, yP + 5.0, 0.28, 0.28, 1, 0, c3('#ffe2a8'));
          lights.push([x, yP + 4.8, z]);
        } else treePts.push([x, H0, z, 1.0]);
      }
    }
  }
  // 环岛外圈树带（环路内侧 12 m）
  const ring = fp.island, nR = ring.length / 2;
  for (let i = 0; i < nR; i++) {
    const j = (i + 1) % nR, ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    for (let s = 6; s < L; s += 13) {
      const t = s / L, x0 = ax + (bx - ax) * t, z0 = az + (bz - az) * t;
      const dx = cx - x0, dz = cz - z0, l = Math.hypot(dx, dz) || 1;
      const x = x0 + (dx / l) * 6, z = z0 + (dz / l) * 6;
      // 十字步道开口处不种
      if (Math.abs(x - cx) < 12 || Math.abs(z - cz) < 12 || inPetal(x, z, 4)) continue;
      treePts.push([x, H0, z, 1.15]);
    }
  }
  // 坐凳（十字中心四角）
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) solid.box(cx + sx * 14, cz + sz * 14, yP, yP + 0.45, 2.2, 0.3, 1, 0, WOOD, WOOD);
  // —— 花瓣下沉庭院 ——
  for (const P of fp.petals) {
    const top = P.top, D = PETAL.depth, yF = top - D;
    const poly = P.poly, n = poly.length / 2;
    const at = (k, y) => [poly[k * 2], y, poly[k * 2 + 1]];
    const toCenter = (k, d) => { const x = poly[k * 2], z = poly[k * 2 + 1], dx = P.cx - x, dz = P.cz - z, l = Math.hypot(dx, dz) || 1; return [x + (dx / l) * d, z + (dz / l) * d]; };
    // 压顶：内侧面、顶面、外侧面
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [oax, oaz] = toCenter(i, -0.6), [obx, obz] = toCenter(j, -0.6);
      solid.quad(at(i, top - 0.12), at(j, top - 0.12), at(j, top + 0.14), at(i, top + 0.14), STONE);
      solid.quad(at(i, top + 0.14), at(j, top + 0.14), [obx, top + 0.14, obz], [oax, top + 0.14, oaz], STONE);
      solid.quad([oax, H0 - 0.6, oaz], [obx, H0 - 0.6, obz], [obx, top + 0.14, obz], [oax, top + 0.14, oaz], STONE);
    }
    // 楼梯开口：朝广场中心的尖端（t = π 一侧，即顶点 n/2 附近）
    const tip = n / 2, isStair = (i) => Math.abs(i - tip) <= 1 || Math.abs(i + 1 - tip) <= 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (isStair(i) && P.kind !== 'water' && P.kind !== 'green') continue;
      rail.quad(at(i, top + 0.14), at(j, top + 0.14), at(j, top + 1.15), at(i, top + 1.15), c3('#cfe3ea'));
      solid.quad(at(i, top + 1.15), at(j, top + 1.15), at(j, top + 1.21), at(i, top + 1.21), c3('#8a9096'));
    }
    if (P.kind === 'water' || P.kind === 'green') {
      // 逐级退台：花瓣轮廓按比例向花瓣中心收缩，每级落 D/nS
      const nS = P.kind === 'water' ? 14 : 7;
      const sMin = P.kind === 'water' ? 0.5 : 0.42;
      const ring2 = (sc) => { const r = []; for (let i = 0; i < n; i++) r.push(P.cx + (poly[i * 2] - P.cx) * sc, P.cz + (poly[i * 2 + 1] - P.cz) * sc); return r; };
      for (let k = 0; k < nS; k++) {
        const s0 = 1 - ((1 - sMin) * k) / nS, s1 = 1 - ((1 - sMin) * (k + 1)) / nS;
        const yA = top - (D * k) / nS, yB = top - (D * (k + 1)) / nS;
        const A = ring2(s0), B = ring2(s1);
        const topC = P.kind === 'green' ? (k & 1 ? GREEN : GREEN2) : k & 1 ? STONE : WALL;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const a0 = [A[i * 2], yA, A[i * 2 + 1]], a1 = [A[j * 2], yA, A[j * 2 + 1]];
          const a0b = [A[i * 2], yB, A[i * 2 + 1]], a1b = [A[j * 2], yB, A[j * 2 + 1]];
          const b0 = [B[i * 2], yB, B[i * 2 + 1]], b1 = [B[j * 2], yB, B[j * 2 + 1]];
          (P.kind === 'green' ? grass : solid).quad(a0, a1, a1b, a0b, P.kind === 'green' ? GREEN2 : WALL); // 立面
          (P.kind === 'green' ? grass : solid).quad(a0b, a1b, b1, b0, topC); // 踏面 / 草坡
          // 踏步灯带（每隔几级一圈，夜间暖光；立面上沿下 6 cm）
          if (k % (P.kind === 'water' ? 3 : 2) === 1) lamp.quad([a0[0], yA - 0.1, a0[2]], [a1[0], yA - 0.1, a1[2]], [a1[0], yA - 0.04, a1[2]], [a0[0], yA - 0.04, a0[2]], c3('#ffd59a'));
        }
      }
      // 坑底
      const F = ring2(sMin);
      if (P.kind === 'water') {
        solid.poly(F, [], yF, STONE);
        const W = ring2(sMin * 0.82);
        water.poly(W, [], yF + 0.12, c3('#3b6f8c'));
        // 喷泉柱（夜间发光）
        for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; lamp.box(P.cx + Math.cos(a) * 6, P.cz + Math.sin(a) * 6, yF + 0.1, yF + 0.5, 0.15, 0.15, 1, 0, c3('#bfe4ff')); }
      } else {
        grass.poly(F, [], yF, GREEN);
        for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2 + 0.4; treePts.push([P.cx + Math.cos(a) * 7, yF, P.cz + Math.sin(a) * 7, 0.85]); }
      }
    } else {
      // 坑底铺装 + 挡墙
      solid.poly(poly, [], yF + 0.03, c3('#b9b2a6'));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        solid.quad(at(i, yF), at(j, yF), at(j, top - 0.12), at(i, top - 0.12), WALL);
      }
      // 店面：沿墙一圈（楼梯口除外），向坑内 0.15 m
      const levels = P.kind === 'shops2' ? 2 : 1;
      for (let i = 0; i < n; i++) {
        if (isStair(i)) continue;
        const j = (i + 1) % n;
        const [ax, az] = toCenter(i, 0.15), [bx, bz] = toCenter(j, 0.15);
        for (let L = 0; L < levels; L++) {
          const y0 = yF + 0.1 + L * 3.6, y1 = y0 + 2.6;
          glass.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], SHOP[(i + L) % 4]);
          solid.quad([ax, y1, az], [bx, y1, bz], [bx, y1 + 0.7, bz], [ax, y1 + 0.7, az], SIGN[(i * 3 + L) % SIGN.length]);
        }
      }
      if (P.kind === 'shops2') {
        // 二层挑廊：沿墙 2.4 m 宽的环形楼板 + 栏杆
        const yG = yF + 3.5;
        for (let i = 0; i < n; i++) {
          if (isStair(i)) continue;
          const j = (i + 1) % n;
          const [ax, az] = toCenter(i, 0.2), [bx, bz] = toCenter(j, 0.2), [cx2, cz2] = toCenter(j, 2.6), [dx2, dz2] = toCenter(i, 2.6);
          solid.quad([ax, yG, az], [bx, yG, bz], [cx2, yG, cz2], [dx2, yG, dz2], STONE);
          solid.quad([dx2, yG - 0.35, dz2], [cx2, yG - 0.35, cz2], [cx2, yG, cz2], [dx2, yG, dz2], WALL);
          rail.quad([dx2, yG, dz2], [cx2, yG, cz2], [cx2, yG + 1.05, cz2], [dx2, yG + 1.05, dz2], c3('#cfe3ea'));
        }
      } else {
        // 檐廊：离墙 3.2 m 一圈柱 + 平顶檐（4.4 m 高）
        const yR = yF + 4.4;
        for (let i = 0; i < n; i++) {
          if (isStair(i)) continue;
          const j = (i + 1) % n;
          const [ax, az] = toCenter(i, 0.2), [bx, bz] = toCenter(j, 0.2), [cx2, cz2] = toCenter(j, 3.6), [dx2, dz2] = toCenter(i, 3.6);
          solid.quad([ax, yR, az], [bx, yR, bz], [cx2, yR, cz2], [dx2, yR, dz2], c3('#7a6a5a'));
          solid.quad([dx2, yR - 0.5, dz2], [cx2, yR - 0.5, cz2], [cx2, yR + 0.15, cz2], [dx2, yR + 0.15, dz2], WOOD);
          if (i % 2 === 0) {
            const [px, pz] = toCenter(i, 3.3);
            solid.box(px, pz, yF, yR - 0.5, 0.22, 0.22, 1, 0, c3('#8b2a1e'));
          }
        }
      }
      // 楼梯：从广场中心一侧的尖端直下坑底（宽 4 m）
      const [sx, sz] = [poly[tip * 2], poly[tip * 2 + 1]];
      const dx = P.cx - sx, dz = P.cz - sz, l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l;
      const nSt = Math.round(D / 0.16), run = D * 1.9;
      for (let k = 0; k < nSt; k++) {
        const t0 = (k / nSt) * run, t1 = ((k + 1) / nSt) * run;
        solid.box(sx + ux * (t0 + t1) / 2, sz + uz * (t0 + t1) / 2, yF, top - (D * (k + 1)) / nSt, (t1 - t0) / 2, 2.0, ux, uz, k & 1 ? STONE : WALL, STONE);
      }
      // 坑底树池 + 坐凳
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + 0.6, x = P.cx + Math.cos(a) * 9, z = P.cz + Math.sin(a) * 9;
        solid.box(x, z, yF, yF + 0.45, 1.3, 1.3, 1, 0, STONE, c3('#4a3a2a'));
        treePts.push([x, yF + 0.45, z, 0.75]);
      }
    }
    lights.push([P.cx, yF + 3.5, P.cz]);
  }
  const tex = graniteTex();
  const matPave = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.75 });
  ctx.overlay(matPave, 0.0003);
  tex.repeat.set(1, 1);
  const matSolid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  const matGrass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  const matGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.2, emissive: 0xffc890, emissiveIntensity: 0, side: THREE.DoubleSide });
  const matLamp = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffc070, emissiveIntensity: 0, side: THREE.DoubleSide });
  const matWater = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.4, emissive: 0x2a6fa0, emissiveIntensity: 0 });
  ctx.night.register(matWater, { day: 0, night: 0.6 }); // 水池底灯
  const matRail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  ctx.night.register(matGlass, { day: 0.05, night: 1.2 });
  ctx.night.register(matLamp, { day: 0, night: 1.3 });
  for (const [M, mat, name] of [[pave, matPave, '广场铺装'], [solid, matSolid, '下沉庭院'], [grass, matGrass, '绿坡'], [glass, matGlass, '店面'], [lamp, matLamp, '灯'], [water, matWater, '水池'], [rail, matRail, '玻璃栏杆']]) {
    const m = M.mesh(mat, name);
    if (!m) continue;
    if (M === pave || M === lamp || M === rail) m.castShadow = false;
    if (M === pave) m.renderOrder = -1;
    group.add(m);
  }
  if (treePts.length) group.add(courtyardTrees(ctx, treePts, { name: '未央城市广场树' }));
  return {
    group,
    lights: lights.map(([x, y, z]) => ({ position: new THREE.Vector3(x, y, z), color: 0xffd2a0, intensity: 120, distance: 30 })),
    label: new THREE.Vector3(cx, H0 + 18, cz),
  };
}
