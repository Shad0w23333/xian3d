import * as THREE from 'three';
import { Batcher, toShape } from '../core/util.js';

const KINDS = {
  river: [0x527d91, 0.19, 0.35],
  lake: [0x436e87, 0.16, 0.4],
  reservoir: [0x4d7787, 0.18, 0.34],
  canal: [0x627f89, 0.24, 0.22],
  pond: [0x557c7c, 0.21, 0.28],
};

function surfaceGeo(points, holes = []) {
  if (!points || points.length < 6) return null;
  const g = new THREE.ShapeGeometry(toShape(points, holes), 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

function levelRibbon(points, width, y, step = 18) {
  const samples = [];
  let dist = 0;
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2], az = points[i - 1], bx = points[i], bz = points[i + 1];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 2) continue;
    const count = Math.max(1, Math.ceil(length / step));
    for (let j = i === 2 ? 0 : 1; j <= count; j++) {
      const t = j / count, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (samples.length) dist += Math.hypot(x - samples.at(-1).x, z - samples.at(-1).z);
      samples.push({ x, z, d: dist });
    }
  }
  if (samples.length < 2) return null;
  const pos = new Float32Array(samples.length * 6), uv = new Float32Array(samples.length * 4), idx = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i], a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1, nx = -dz / len, nz = dx / len;
    for (let side = 0; side < 2; side++) {
      const sign = side ? -1 : 1, x = p.x + nx * width * 0.5 * sign, z = p.z + nz * width * 0.5 * sign;
      pos.set([x, y, z], (i * 2 + side) * 3);
      uv.set([side, p.d / 20], (i * 2 + side) * 2);
    }
    if (i) {
      const k = i * 2;
      idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export default {
  id: 'water',
  name: '渭河与城市水系',
  async build(ctx) {
    const data = ctx.data.water || {};
    const root = new THREE.Group();
    root.name = '西安水系';
    ctx.scene.add(root);
    const materials = {};
    for (const [kind, [color, roughness, metalness]] of Object.entries(KINDS)) {
      materials[kind] = new THREE.MeshPhysicalMaterial({
        color, roughness, metalness, clearcoat: 0.78, clearcoatRoughness: 0.1,
        transparent: true, opacity: 0.91, side: THREE.DoubleSide,
      });
      ctx.overlay(materials[kind], 0.00015);
    }
    const polygons = new Batcher();
    for (const p of data.polys || []) {
      const geom = surfaceGeo(p.outer, p.holes || []);
      if (!geom) continue;
      const y = Number.isFinite(p.h) ? p.h : ctx.terrain.heightAt(p.outer[0], p.outer[1]) - 1.5;
      polygons.add(geom, materials[p.k] || materials.lake, new THREE.Matrix4().makeTranslation(0, y, 0));
      geom.dispose();
      if (p.n && Math.abs(p.outer[0]) < 45000) {
        const cx = p.outer.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / (p.outer.length / 2);
        const cz = p.outer.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / (p.outer.length / 2);
        if (p.n === '渭河') ctx.labels.add('渭河', new THREE.Vector3(cx, y + 5, cz), { category: 'district', minDist: 300, maxDist: 42000, priority: 2 });
      }
    }
    root.add(polygons.build({ name: '水面多边形', castShadow: false, receiveShadow: false }));

    const lines = new Batcher();
    let weiheLabelled = false;
    for (const f of data.lines || []) {
      if (!f.p || f.p.length < 4) continue;
      const y = f.n === '渭河' ? 364.5 : ctx.terrain.heightAt(f.p[0], f.p[1]) - 1.2;
      let width = Math.min(1800, Math.max(6, Number(f.w) || 20));
      if (f.n === '渭河') width = Math.max(width, 520);
      const geom = levelRibbon(f.p, width, y, width > 200 ? 36 : 12);
      if (geom) {
        lines.add(geom, materials[f.k] || materials.river);
        geom.dispose();
      }
      if (f.n === '渭河' && !weiheLabelled) {
        const mid = Math.floor(f.p.length / 4) * 2;
        ctx.labels.add('渭河', new THREE.Vector3(f.p[mid], y + 7, f.p[mid + 1]), { category: 'district', minDist: 500, maxDist: 45000, priority: 3 });
        weiheLabelled = true;
      }
    }
    const lineGroup = lines.build({ name: '河道面带', castShadow: false, receiveShadow: false });
    if (lineGroup.children.length) root.add(lineGroup);

    return {
      setLayer(layer, visible) { if (layer === 'water') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
    };
  },
};
