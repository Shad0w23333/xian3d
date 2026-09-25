import * as THREE from 'three';
import { Batcher } from '../core/util.js';
import { makeRibbonGeometry } from '../arch/shared.js';

const MAIN = new Set([0, 1, 2, 3, 4, 8, 9, 10, 11]);
const LOCAL = new Set([5, 6, 7]);
const WALK = new Set([12, 13]);

function roadHeight(ctx, x, z) { return ctx.terrain.heightAt(x, z) + 0.35; }

function labelsFor(ctx, features) {
  const seen = new Set();
  for (const f of features) {
    if (!f.n || f.c > 3 || seen.has(f.n) || f.p.length < 10) continue;
    const mid = Math.floor(f.p.length / 4) * 2;
    const x = f.p[mid], z = f.p[mid + 1];
    if (Math.hypot(x, z) > 17000) continue;
    seen.add(f.n);
    ctx.labels.add(f.n, new THREE.Vector3(x, roadHeight(ctx, x, z) + 9, z), { category: 'street', minDist: 120, maxDist: 5200, priority: 0.8 });
    if (seen.size >= 80) break;
  }
}

export default {
  id: 'roads',
  name: '道路与轨道交通',
  async build(ctx) {
    const root = new THREE.Group();
    root.name = '道路与交通路网';
    ctx.scene.add(root);
    const features = ctx.data.roads?.features || [];
    const surfaceDefs = [
      { key: 'highway', material: ctx.mats.get('asphalt'), include: MAIN, step: 22 },
      { key: 'city', material: ctx.mats.clone('asphalt', { color: 0x4a4946 }), include: LOCAL, step: 18 },
      { key: 'pedestrian', material: ctx.mats.clone('concrete', { color: 0x888174 }), include: WALK, step: 12 },
    ];
    let visibleFeatures = 0;
    for (const def of surfaceDefs) {
      const batch = new Batcher();
      for (const f of features) {
        if (!def.include.has(f.c) || !f.p || f.p.length < 4) continue;
        if (f.t) continue; // 地下隧道不覆蓋地表；橋梁依橋面高程抬升。
        let width = Math.max(2.2, Math.min(42, Number(f.w) || 8));
        if (def.key === 'highway') width = Math.max(width, [31, 25, 20, 15, 11][f.c] || 12);
        const g = makeRibbonGeometry(ctx, f.p, width, f.b ? 4.2 : 0.35, def.step);
        if (!g) continue;
        batch.add(g, def.material);
        g.dispose();
        visibleFeatures++;
      }
      const grp = batch.build({ name: `路面-${def.key}`, castShadow: false, receiveShadow: true });
      for (const mesh of grp.children) ctx.overlay(mesh.material, 0.00024);
      if (grp.children.length) root.add(grp);
    }

    // 道路中心短虚线：只画主干道，全部合在一个 LineSegments 里。
    const dashPositions = [], edgePositions = [];
    for (const f of features) {
      if (!MAIN.has(f.c) || f.t || f.p.length < 6) continue;
      const width = Math.max(8, Math.min(32, Number(f.w) || 12));
      let carry = 0;
      for (let i = 2; i < f.p.length; i += 2) {
        const ax = f.p[i - 2], az = f.p[i - 1], bx = f.p[i], bz = f.p[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1) continue;
        const steps = Math.max(1, Math.ceil(len / 36));
        for (let j = 0; j < steps; j++) {
          const t0 = j / steps, t1 = Math.min(1, t0 + 0.42);
          const mx = ax + (bx - ax) * t0, mz = az + (bz - az) * t0;
          const ex = ax + (bx - ax) * t1, ez = az + (bz - az) * t1;
          const y0 = roadHeight(ctx, mx, mz) + 0.16, y1 = roadHeight(ctx, ex, ez) + 0.16;
          if (((carry + t0 * len) % 28) < 13) dashPositions.push(mx, y0, mz, ex, y1, ez);
          const nx = -(bz - az) / len * width * 0.43, nz = (bx - ax) / len * width * 0.43;
          edgePositions.push(mx + nx, y0, mz + nz, ex + nx, y1, ez + nz, mx - nx, y0, mz - nz, ex - nx, y1, ez - nz);
        }
        carry += len;
      }
    }
    const lineGroup = new THREE.Group();
    if (dashPositions.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(dashPositions, 3));
      const m = new THREE.LineBasicMaterial({ color: 0xffdda1, transparent: true, opacity: 0.78 });
      const marks = new THREE.LineSegments(g, m); marks.renderOrder = 5; lineGroup.add(marks);
    }
    if (edgePositions.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
      const m = new THREE.LineBasicMaterial({ color: 0xd3d0c6, transparent: true, opacity: 0.44 });
      const marks = new THREE.LineSegments(g, m); marks.renderOrder = 5; lineGroup.add(marks);
    }
    root.add(lineGroup);

    // 地铁与铁路轨道：下层黑色床、钢轨双线与站点灯标。
    const rail = ctx.data.rail?.features || [];
    const railBatch = new Batcher();
    const steel = ctx.mats.get('metalGray');
    for (const f of rail) {
      if (f.t || f.p.length < 4) continue;
      const y = f.b ? 8 : 0.8;
      const bed = makeRibbonGeometry(ctx, f.p, Math.max(4, Number(f.w) || 5), y, 20);
      if (bed) { railBatch.add(bed, ctx.mats.get('concrete')); bed.dispose(); }
      const railW = (Number(f.w) || 5) * 0.18;
      const left = [], right = [];
      for (let i = 2; i < f.p.length; i += 2) {
        const dx = f.p[i] - f.p[i - 2], dz = f.p[i + 1] - f.p[i - 1], l = Math.hypot(dx, dz) || 1;
        const nx = -dz / l * railW, nz = dx / l * railW;
        left.push(f.p[i] + nx, f.p[i + 1] + nz); right.push(f.p[i] - nx, f.p[i + 1] - nz);
      }
      for (const p of [left, right]) {
        const geom = makeRibbonGeometry(ctx, p, 0.42, y + 0.18, 18);
        if (geom) { railBatch.add(geom, steel); geom.dispose(); }
      }
    }
    const railGroup = railBatch.build({ name: '地面轨道', castShadow: false, receiveShadow: true });
    if (railGroup.children.length) root.add(railGroup);
    for (const p of ctx.data.pois?.pois || []) {
      if (p.k !== 'station' && p.k !== 'subway_entrance' && p.k !== 'railway') continue;
      const y = roadHeight(ctx, p.x, p.z) + 10;
      ctx.labels.add(p.n, new THREE.Vector3(p.x, y, p.z), { category: 'station', minDist: 70, maxDist: 7000, priority: 1 });
    }
    labelsFor(ctx, features);

    return {
      setQuality(q) { root.visible = true; this._detail = q.level; },
      setLayer(layer, visible) { if (layer === 'roads') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
      count: visibleFeatures,
    };
  },
};
