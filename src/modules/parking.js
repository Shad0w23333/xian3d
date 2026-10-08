// 地面停车场：OSM amenity=parking（地面式；tools/build_parking.py → public/data/parking.json，全城约 840 处，合计约 4.7 km²）。
// 此前这些地方只有卫星图（机场 T2 陆侧、商场、医院、景区停车场近看是一张糊照片：车、车棚贴在地上，审查 g9 P1）。
//
// 做法（只在相机 1.6 km 内、按 600 m 分格流式生成，离开后卸载）：
//   · 沥青地面：2 m 网格按多边形裁剪、贴地（不带路面贴图，深灰带轻微斑驳）；
//   · 车位：按多边形最长边方向排成“双排车位 + 6 m 通道”的模块（2.5 × 5.3 m），白线；车位四角都在多边形内、不压楼才画；
//   · 停放车辆：占用率 55~85%（每块地随机），实例化简模（车身 + 座舱 + 车窗 + 车轮），车身颜色按真实分布（白/黑/银灰为主）；
//   · 灯杆：沿通道每 ~30 m 一根，夜间灯头发光，少量真实点光源。
// 跳过：精建模块已登记“通用建筑让位”的地块（街景片区停车场、地标广场等），以及住宅/校园用地内的（由小区模块负责）。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';

const CELL = 600, NEAR = 1600, FAR = 1900;
const STALL_W = 2.5, STALL_D = 5.3, AISLE = 6.0, MOD = STALL_D * 2 + AISLE;
const CAR_COLORS = [
  ['#e8e8e6', 0.32], ['#1c1d20', 0.2], ['#9a9da2', 0.14], ['#c3c6ca', 0.1], ['#3a4250', 0.06], ['#7a1e22', 0.05],
  ['#1f3a68', 0.05], ['#5b5f4a', 0.03], ['#b08d57', 0.03], ['#2d5a3c', 0.02],
];

function pip(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
  }
  return c;
}
function bbox(p) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
  }
  return { x0, x1, z0, z1 };
}
function area(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(a / 2);
}
const hash = (a, b, s = 0) => { const v = Math.sin(a * 12.9898 + b * 78.233 + s * 37.719) * 43758.5453; return v - Math.floor(v); };
function pickColor(h) {
  let acc = 0;
  for (const [c, w] of CAR_COLORS) { acc += w; if (h < acc) return c; }
  return CAR_COLORS[0][0];
}

/** 停放车辆简模（车头朝 +x，原点在车底中心）：车身、座舱、车窗、车轮；返回非索引几何 + 顶点色（车窗/轮子固定色，车身白色由实例色染） */
function carGeometry() {
  const parts = [];
  const add = (w, h, d, x, y, z, col, bevel = 0) => {
    const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1).toNonIndexed();
    if (bevel) {
      // 顶面四边内收（圆润一点的车身/座舱）
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setX(i, p.getX(i) * (1 - bevel / w * 2)); p.setZ(i, p.getZ(i) * (1 - bevel / d * 2)); }
    }
    g.translate(x, y, z);
    const c = new THREE.Color(col);
    const cols = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) { cols[i] = c.r; cols[i + 1] = c.g; cols[i + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  };
  add(4.5, 0.62, 1.78, 0, 0.62, 0, '#ffffff', 0.06);          // 车身（实例色）
  add(2.35, 0.5, 1.56, -0.25, 1.17, 0, '#ffffff', 0.18);       // 座舱
  add(2.2, 0.38, 1.6, -0.25, 1.15, 0, '#20262c', 0.16);        // 车窗带（略宽于座舱：侧窗）
  for (const x of [1.42, -1.38]) add(0.66, 0.6, 1.84, x, 0.31, 0, '#141414'); // 车轮（每轴一块，近看即两侧轮胎；每辆车约 60 个三角形）
  const g = mergeNonIndexed(parts);
  g.computeVertexNormals();
  return g;
}
function mergeNonIndexed(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export default {
  id: 'parking',
  name: '地面停车场',
  async prepare(ctx) {
    const raw = await loadJSON('parking.json', { optional: true });
    const lots = [];
    const lu = ctx.data.landuse?.polys || [];
    const res = lu.filter((f) => (f.k === 'residential' || f.k === 'university') && f.outer && f.outer.length >= 6).map((f) => ({ p: f.outer, bb: bbox(f.outer) }));
    const inRes = (x, z) => res.some((r) => x >= r.bb.x0 && x <= r.bb.x1 && z >= r.bb.z0 && z <= r.bb.z1 && pip(x, z, r.p));
    for (const L of raw?.lots || []) {
      const p = L.p;
      if (!p || p.length < 6) continue;
      const a = area(p);
      if (a < 250) continue; // 路边几个车位的小块不画（影像就够了）
      const b = bbox(p);
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      if (ctx.exclusions.test(cx, cz, 'buildings', 0)) continue; // 精建区（街景片区停车场、地标广场）
      if (inRes(cx, cz)) continue; // 小区/校园内由小区模块负责
      lots.push({ p, bb: b, a, cx, cz, name: L.n || '' });
    }
    // 停车场内不种树（OSM 绿地多边形常把停车场包进去）
    for (const L of lots) ctx.exclusions.add({ points: L.p, name: 'parking' }, { buildings: false, trees: true, pois: false });
    this.lots = lots;
  },

  build(ctx) {
    const lots = this.lots || [];
    const root = new THREE.Group();
    root.name = '地面停车场';
    ctx.scene.add(root);
    const T = ctx.terrain;
    // 格网索引
    const grid = new Map();
    for (let i = 0; i < lots.length; i++) {
      const b = lots[i].bb;
      for (let gx = Math.floor(b.x0 / CELL); gx <= Math.floor(b.x1 / CELL); gx++)
        for (let gz = Math.floor(b.z0 / CELL); gz <= Math.floor(b.z1 / CELL); gz++) {
          const k = gx + ',' + gz;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
        }
    }
    // 通用建筑轮廓（车位不压楼）：按需解析相机附近的楼
    const B = ctx.data.buildings;
    let bldIdx = null;
    const buildingsNear = (b) => {
      if (!B) return [];
      if (!bldIdx) {
        const dv = new DataView(B);
        const ver = dv.getUint32(4, true), N = dv.getUint32(8, true);
        let o = 16;
        const ax = new Float32Array(B, o, N); o += N * 4;
        const az = new Float32Array(B, o, N); o += N * 4;
        const vs = new Uint32Array(B, o, N); o += N * 4;
        const vc = new Uint16Array(B, o, N); o += N * 2;
        o += N * 4; // h, minh
        const kind = new Uint8Array(B, o, N); o += N;
        const flags = new Uint8Array(B, o, N); o += N;
        o += ver >= 2 ? N : 0;
        o += (4 - (o % 4)) % 4;
        bldIdx = { ax, az, vs, vc, flags, offs: new Int16Array(B, o), N };
      }
      const { ax, az, vs, vc, flags, offs, N } = bldIdx;
      const out = [];
      for (let i = 0; i < N; i++) {
        if (ax[i] < b.x0 - 80 || ax[i] > b.x1 + 80 || az[i] < b.z0 - 80 || az[i] > b.z1 + 80) continue;
        if (flags[i] & 128) continue;
        const p = [];
        for (let k = vs[i] * 2, e = k + vc[i] * 2; k < e; k += 2) p.push(ax[i] + offs[k] * 0.1, az[i] + offs[k + 1] * 0.1);
        out.push({ p, bb: bbox(p) });
      }
      return out;
    };

    // —— 材质与共享几何 ——
    const matGround = ctx.overlay(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }), 0.0009);
    const matLine = ctx.overlay(new THREE.MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.8 }), 0.0011);
    const matCar = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35 });
    const matPole = new THREE.MeshStandardMaterial({ color: 0x6f7378, roughness: 0.6, metalness: 0.5 });
    const matLamp = new THREE.MeshStandardMaterial({ color: 0xf2efe6, emissive: 0xffe6bf, emissiveIntensity: 0 });
    ctx.night.register(matLamp, { day: 0, night: 1.8 });
    const carGeo = carGeometry();
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 9, 6).translate(0, 4.5, 0);
    const headGeo = new THREE.BoxGeometry(0.9, 0.18, 0.35).translate(0, 9, 0);

    const built = new Map(); // 格键 → { group, lights[] }
    const buildLot = (L, group, lights) => {
      const { p, bb } = L;
      const blds = buildingsNear(bb);
      const inBld = (x, z) => blds.some((q) => x >= q.bb.x0 && x <= q.bb.x1 && z >= q.bb.z0 && z <= q.bb.z1 && pip(x, z, q.p));
      // 最长边方向
      let best = 0, ux = 1, uz = 0;
      for (let i = 0; i < p.length; i += 2) {
        const j = (i + 2) % p.length, dx = p[j] - p[i], dz = p[j + 1] - p[i + 1], l = Math.hypot(dx, dz);
        if (l > best) { best = l; ux = dx / l; uz = dz / l; }
      }
      const vx = -uz, vz = ux;
      // 局部坐标范围
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        const u = p[i] * ux + p[i + 1] * uz, v = p[i] * vx + p[i + 1] * vz;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const W = (u, v) => [u * ux + v * vx, u * uz + v * vz];
      const H = (x, z) => T.heightAt(x, z);
      // 地面：2 m 网格（格心在多边形内的格子画成四边形，顶点贴地）
      const gp = [], gc = [];
      const S = 2;
      const seed = L.cx * 0.13 + L.cz * 0.07;
      for (let x = bb.x0; x < bb.x1; x += S)
        for (let z = bb.z0; z < bb.z1; z += S) {
          if (!pip(x + S / 2, z + S / 2, p)) continue;
          const n = 0.86 + 0.14 * hash(Math.floor(x / 6), Math.floor(z / 6), seed) + 0.05 * hash(x, z, 3);
          const c = [0.2 * n, 0.2 * n, 0.205 * n];
          const q = [[x, z], [x + S, z], [x + S, z + S], [x, z + S]].map(([a, b2]) => [a, H(a, b2) + 0.05, b2]);
          for (const k of [0, 2, 1, 0, 3, 2]) { gp.push(...q[k]); gc.push(...c); }
        }
      if (gp.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, matGround);
        m.receiveShadow = true;
        group.add(m);
      }
      // 车位：沿 v 方向排模块（双排 + 通道），沿 u 方向排车位
      const lp = [];
      const cars = [];
      const poles = [];
      const occ = 0.55 + 0.3 * hash(L.cx, L.cz, 7);
      const line = (a, b, w = 0.12) => {
        const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * w / 2, nz = (dx / l) * w / 2;
        const q = [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]].map(([x, z]) => [x, H(x, z) + 0.07, z]);
        for (const k of [0, 2, 1, 0, 3, 2]) lp.push(...q[k]);
      };
      for (let v = v0 + 1.5; v + STALL_D * 2 <= v1 - 1; v += MOD) {
        for (const [vs, dir] of [[v, 1], [v + STALL_D, -1]]) {
          let rowAny = false;
          for (let u = u0 + 1.5; u + STALL_W <= u1 - 1.5; u += STALL_W) {
            const corners = [W(u, vs), W(u + STALL_W, vs), W(u + STALL_W, vs + STALL_D), W(u, vs + STALL_D)];
            if (!corners.every(([x, z]) => pip(x, z, p))) continue;
            const [cx, cz] = W(u + STALL_W / 2, vs + STALL_D / 2);
            if (inBld(cx, cz)) continue;
            rowAny = true;
            line(W(u, vs), W(u, vs + STALL_D));
            line(W(u + STALL_W, vs), W(u + STALL_W, vs + STALL_D));
            // 车位底线（靠通道一侧不画，靠背一侧画）
            const back = dir === 1 ? vs : vs + STALL_D;
            line(W(u, back), W(u + STALL_W, back));
            if (hash(u, vs, seed) < occ) {
              const yaw = Math.atan2(vz * dir, vx * dir); // 车头朝通道（-dir 的对侧）……按车位朝向
              const jitter = (hash(u, vs, 11) - 0.5) * 0.25;
              cars.push([cx + vx * jitter * dir, H(cx, cz), cz + vz * jitter * dir, yaw + (hash(u, vs, 13) < 0.5 ? 0 : Math.PI) + (hash(u, vs, 17) - 0.5) * 0.06, hash(u, vs, 19)]);
            }
          }
          if (rowAny && dir === -1) {
            // 通道中线上每 30 m 一根灯杆（只在有车位的模块旁）
            for (let u = u0 + 12; u < u1 - 8; u += 30) {
              const [x, z] = W(u, v + STALL_D * 2 + AISLE * 0.5);
              if (pip(x, z, p) && !inBld(x, z)) poles.push([x, H(x, z), z]);
            }
          }
        }
      }
      if (lp.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
        g.computeVertexNormals();
        group.add(new THREE.Mesh(g, matLine));
      }
      return { cars, poles };
    };

    const buildCell = (key) => {
      const ids = grid.get(key) || [];
      const group = new THREE.Group();
      const allCars = [], allPoles = [], lights = [];
      for (const i of ids) {
        const L = lots[i];
        // 跨格的停车场只在它中心所在的格里建
        if (Math.floor(L.cx / CELL) + ',' + Math.floor(L.cz / CELL) !== key) continue;
        const r = buildLot(L, group, lights);
        allCars.push(...r.cars);
        allPoles.push(...r.poles);
      }
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), pv = new THREE.Vector3();
      if (allCars.length) {
        const im = new THREE.InstancedMesh(carGeo, matCar, allCars.length);
        const c = new THREE.Color();
        allCars.forEach(([x, y, z, yaw, h], k) => {
          q.setFromAxisAngle(up, -yaw);
          im.setMatrixAt(k, m4.compose(pv.set(x, y + 0.02, z), q, s1));
          im.setColorAt(k, c.set(pickColor(h)));
        });
        im.castShadow = true;
        im.receiveShadow = true;
        im.computeBoundingSphere();
        group.add(im);
      }
      if (allPoles.length) {
        const pm = new THREE.InstancedMesh(poleGeo, matPole, allPoles.length);
        const hm = new THREE.InstancedMesh(headGeo, matLamp, allPoles.length);
        allPoles.forEach(([x, y, z], k) => {
          m4.makeTranslation(x, y, z);
          pm.setMatrixAt(k, m4);
          hm.setMatrixAt(k, m4);
        });
        pm.computeBoundingSphere(); hm.computeBoundingSphere();
        group.add(pm, hm);
        for (let k = 0; k < allPoles.length; k += 4) {
          const [x, y, z] = allPoles[k];
          lights.push(ctx.lights.add({ position: new THREE.Vector3(x, y + 8.6, z), color: 0xffe2b8, intensity: 260, distance: 30, nightOnly: true, priority: 0.35 }));
        }
      }
      root.add(group);
      return { group, lights, cars: allCars.length };
    };
    const disposeCell = (c) => {
      root.remove(c.group);
      c.group.traverse((o) => { if (o.geometry && o.geometry !== carGeo && o.geometry !== poleGeo && o.geometry !== headGeo) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
      for (const l of c.lights) if (ctx.lights.remove) ctx.lights.remove(l); else l.enabled = false;
    };

    const cam = ctx.camera;
    let frame = 0, pending = [];
    const refresh = () => {
      const x = cam.position.x, z = cam.position.z;
      const agl = cam.position.y - T.heightAt(x, z);
      const near = agl < 600 ? NEAR : 0; // 高空俯视不画（看不清，只是负担）
      const want = new Set();
      if (near > 0)
        for (let gx = Math.floor((x - near) / CELL); gx <= Math.floor((x + near) / CELL); gx++)
          for (let gz = Math.floor((z - near) / CELL); gz <= Math.floor((z + near) / CELL); gz++) {
            const cx = (gx + 0.5) * CELL, cz = (gz + 0.5) * CELL;
            if (Math.hypot(cx - x, cz - z) < near + CELL * 0.71 && grid.has(gx + ',' + gz)) want.add(gx + ',' + gz);
          }
      for (const [k, c] of built) {
        const [gx, gz] = k.split(',').map(Number);
        const cx = (gx + 0.5) * CELL, cz = (gz + 0.5) * CELL;
        if (!want.has(k) && (near === 0 || Math.hypot(cx - x, cz - z) > FAR + CELL)) { disposeCell(c); built.delete(k); }
      }
      pending = [...want].filter((k) => !built.has(k)).sort((a, b) => {
        const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number);
        return Math.hypot((ax + 0.5) * CELL - x, (az + 0.5) * CELL - z) - Math.hypot((bx + 0.5) * CELL - x, (bz + 0.5) * CELL - z);
      });
    };
    refresh();
    // 首帧前把相机所在格先建好（截图/预设视角直接可见）
    for (let i = 0; i < 4 && pending.length; i++) { const k = pending.shift(); built.set(k, buildCell(k)); }
    console.warn(`[parking] 地面停车场 ${lots.length} 处（OSM），首批 ${built.size} 格`);
    return {
      update() {
        if ((++frame & 15) === 0) refresh();
        if (pending.length) { const k = pending.shift(); if (!built.has(k)) built.set(k, buildCell(k)); } // 每帧至多建一格
      },
      busy: () => pending.length > 0,
      stats: () => ({ lots: lots.length, cells: built.size, pending: pending.length, cars: [...built.values()].reduce((s, c) => s + c.cars, 0) }),
      setLayer(layer, v) { if (layer === 'buildings') root.visible = v; },
      dispose() { for (const c of built.values()) disposeCell(c); built.clear(); ctx.scene.remove(root); },
    };
  },
};
