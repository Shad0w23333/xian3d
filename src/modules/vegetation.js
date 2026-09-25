import * as THREE from 'three';
import { pointInPoly, polyBBox } from '../core/util.js';

function random01(seed) {
  let x = (seed + 0x6d2b79f5) | 0;
  x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61);
  return ((x ^ x >>> 14) >>> 0) / 4294967296;
}

export default {
  id: 'vegetation',
  name: '行道树与公园绿化',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '城市绿化'; ctx.scene.add(root);
    const candidates = [];
    const polygons = ctx.data.landuse?.polys || [];
    let seed = 1;
    for (const f of polygons) {
      if (!['park', 'forest', 'grass', 'university', 'cemetery'].includes(f.k) || !f.outer || f.outer.length < 6) continue;
      const b = polyBBox(f.outer), area = Math.max(0, (b.x1 - b.x0) * (b.z1 - b.z0));
      if (area < 12000) continue;
      const count = Math.min(1500, Math.ceil(area / (f.k === 'forest' ? 270 : 540)));
      for (let i = 0, attempts = 0; i < count * 7 && candidates.length < 23000 && attempts < count * 7; i++, attempts++) {
        const x = b.x0 + random01(seed++) * (b.x1 - b.x0), z = b.z0 + random01(seed++) * (b.z1 - b.z0);
        if (!pointInPoly(x, z, f.outer)) continue;
        if (f.holes?.some((h) => pointInPoly(x, z, h))) continue;
        if (ctx.exclusions.test(x, z, 'trees')) continue;
        candidates.push({ x, z, seed, forest: f.k === 'forest' });
        if (i > count * 3) break;
      }
      if (candidates.length >= 23000) break;
    }
    // 现有数据缺少树点的街区，用长安路、曲江园路的树带补齐街景。
    for (const [lon, lat, dx, dz, rows] of [
      [108.9425, 34.2610, 0, 1, 36], [108.9645, 34.213, 1, 0, 48],
      [108.885, 34.225, 0, 1, 34], [108.95, 34.335, 1, 0, 40],
    ]) {
      const p = ctx.geo.project(lon, lat);
      for (let i = -rows; i <= rows; i++) {
        for (const side of [-1, 1]) {
          const x = p.x + (dx ? side * 20 : 0) + (dx ? i * 15 : 0);
          const z = p.z + (dz ? side * 20 : 0) + (dz ? i * 15 : 0);
          if (ctx.exclusions.test(x, z, 'trees')) continue;
          candidates.push({ x, z, seed: seed++, forest: false });
        }
      }
    }
    const max = Math.min(23000, candidates.length);
    const trunkMat = ctx.mats.get('woodDark');
    const leafMat = ctx.mats.clone('grass', { color: 0x486a39, roughness: 0.96 });
    const pineMat = ctx.mats.clone('grass', { color: 0x315c38, roughness: 0.98 });
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.24, 5.1, 7), trunkMat, max);
    const broad = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(2.6, 1), leafMat, max);
    const conifer = new THREE.InstancedMesh(new THREE.ConeGeometry(2.6, 6.2, 9, 2), pineMat, max);
    const dummy = new THREE.Object3D();
    const bright = [0.86, 0.97, 1.08, 0.9, 1.02];
    let broadCount = 0, pineCount = 0;
    for (let i = 0; i < max; i++) {
      const t = candidates[i], h = 5.5 + random01(t.seed) * 5.6;
      const y = ctx.terrain.heightAt(t.x, t.z);
      const scale = 0.72 + random01(t.seed + 13) * 0.75;
      const isPine = t.forest || random01(t.seed + 3) > 0.7;
      dummy.position.set(t.x, y + 2.45, t.z); dummy.scale.set(scale, h / 5.1, scale); dummy.rotation.y = random01(t.seed + 7) * Math.PI; dummy.updateMatrix(); trunk.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, y + h * 0.74, t.z); dummy.scale.set(scale * 0.88, scale, scale * 0.88); dummy.rotation.y = random01(t.seed + 9) * Math.PI; dummy.updateMatrix();
      if (isPine) conifer.setMatrixAt(pineCount++, dummy.matrix); else broad.setMatrixAt(broadCount++, dummy.matrix);
      const c = new THREE.Color().setRGB(bright[Math.floor(random01(t.seed + 21) * bright.length)] * 0.72,
        bright[Math.floor(random01(t.seed + 21) * bright.length)] * 0.84,
        bright[Math.floor(random01(t.seed + 21) * bright.length)] * 0.62);
      if (isPine) conifer.setColorAt(pineCount - 1, c); else broad.setColorAt(broadCount - 1, c);
    }
    trunk.count = max; broad.count = broadCount; conifer.count = pineCount;
    trunk.instanceMatrix.needsUpdate = true; broad.instanceMatrix.needsUpdate = true; conifer.instanceMatrix.needsUpdate = true;
    if (broad.instanceColor) broad.instanceColor.needsUpdate = true;
    if (conifer.instanceColor) conifer.instanceColor.needsUpdate = true;
    trunk.castShadow = broad.castShadow = conifer.castShadow = true;
    root.add(trunk, broad, conifer);
    let density = ctx.quality.treeDensity ?? 1, layerVisible = true;
    const updateDensity = () => {
      const factor = Math.max(0.12, Math.min(1.3, density));
      trunk.count = Math.min(max, Math.round(max * factor));
      broad.count = Math.min(broadCount, Math.round(broadCount * factor));
      conifer.count = Math.min(pineCount, Math.round(pineCount * factor));
    };
    updateDensity();
    return {
      setQuality(q) { density = q.treeDensity ?? 1; updateDensity(); },
      setLayer(layer, visible) { if (layer === 'trees') { layerVisible = visible; root.visible = visible; } },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
      count: max,
    };
  },
};
