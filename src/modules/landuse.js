import * as THREE from 'three';
import { Batcher, toShape } from '../core/util.js';

const PALETTE = {
  park: [0x526d43, 0.93], forest: [0x304d35, 0.97], grass: [0x687b49, 0.97],
  farmland: [0x80734a, 0.98], orchard: [0x5d7145, 0.98], residential: [0x8b8170, 0.95],
  commercial: [0x897763, 0.94], industrial: [0x77766f, 0.97], university: [0x7c795d, 0.96],
  cemetery: [0x586a4e, 0.98], military: [0x686e5e, 0.98], construction: [0x92805f, 0.96], square: [0xa39c8e, 0.88],
};

function polygon(points, holes) {
  if (!points || points.length < 6) return null;
  const s = toShape(points, holes || []);
  const g = new THREE.ShapeGeometry(s, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

export default {
  id: 'landuse',
  name: '公园与用地',
  async build(ctx) {
    const root = new THREE.Group();
    root.name = '公园绿地';
    ctx.scene.add(root);
    const mats = {};
    const batches = {};
    for (const [kind, [color, roughness]] of Object.entries(PALETTE)) {
      mats[kind] = ctx.mats.clone(kind === 'park' || kind === 'forest' || kind === 'grass' ? 'grass' : 'concrete', { color, roughness });
      mats[kind].color.setHex(color);
      batches[kind] = new Batcher();
    }
    for (const f of ctx.data.landuse?.polys || []) {
      const kind = PALETTE[f.k] ? f.k : 'grass';
      const g = polygon(f.outer, f.holes);
      if (!g) continue;
      let h = 0;
      for (let i = 0; i < f.outer.length; i += 2) h += ctx.terrain.heightAt(f.outer[i], f.outer[i + 1]);
      h = h / Math.max(1, f.outer.length / 2) + 0.35;
      batches[kind].add(g, mats[kind], new THREE.Matrix4().makeTranslation(0, h, 0));
      g.dispose();
      if (f.n && (kind === 'park' || kind === 'university' || kind === 'square')) {
        const n = f.outer.length / 2;
        let x = 0, z = 0;
        for (let i = 0; i < f.outer.length; i += 2) { x += f.outer[i]; z += f.outer[i + 1]; }
        x /= n; z /= n;
        if (Math.hypot(x, z) < 25000) ctx.labels.add(f.n, new THREE.Vector3(x, h + 22, z), { category: 'district', minDist: 350, maxDist: 14000, priority: 1.1 });
      }
    }
    for (const [kind, batch] of Object.entries(batches)) {
      const group = batch.build({ name: `用地-${kind}`, castShadow: false, receiveShadow: true });
      if (group.children.length) root.add(group);
    }
    return {
      setLayer(layer, visible) { if (layer === 'landuse') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
    };
  },
};
