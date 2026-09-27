// 回民街（回坊）· 洒金桥精细街区：用 OSM 逐户建筑轮廓替换 CMAB 粗块（低于 15 m 的通用建筑让位，街区内高楼保留）。
// 数据：public/data/huimin.json（tools/build_huimin.py）；几何与贴图：src/arch/huimin-gen.js；调研：research/refs/huimin/notes.md
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { buildHuimin } from '../arch/huimin-gen.js';
import { buildArch, paifang } from '../arch/chinese.js';

export default {
  id: 'huimin',
  name: '回民街·洒金桥',
  async prepare(ctx) {
    this.data = await loadJSON('huimin.json', { optional: true });
    if (!this.data) return;
    for (const p of this.data.district) ctx.exclusions.add({ points: p, name: 'huimin' }, { buildings: true, trees: false, pois: false, maxHeight: this.data.maxH ?? 15 });
  },
  async build(ctx) {
    const data = this.data;
    if (!data) return {};
    const t0 = performance.now();
    const { group, detail, stats } = buildHuimin(ctx, data);
    ctx.scene.add(group);
    // 北院门北口白色花岗岩牌楼（1993 年建，四柱三间；调研 §2.2，尺寸为推测值）
    try {
      const px = -300, pz = -548;
      const pf = buildArch(ctx, (b) => paifang(b, { bays: 3, kind: 'stone', width: 15, h: 7.5, text: '北院门', roofColor: 'gray' }), { style: 'ming', name: '北院门牌楼' });
      pf.position.set(px, ctx.terrain.heightAt(px, pz), pz);
      group.add(pf);
    } catch (e) {
      console.warn('[huimin] 牌楼构建失败', e);
    }
    // 北院门夜间暖光（少量真实点光源）
    const lane = data.lanes.find((l) => l.n === '北院门');
    if (lane) {
      const p = lane.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const x = p[i], z = p[i + 1];
        if (i % 6 === 0) ctx.lights.add({ position: new THREE.Vector3(x, ctx.terrain.heightAt(x, z) + 5, z), color: 0xffa860, intensity: 5, distance: 26, nightOnly: true });
      }
    }
    const c = new THREE.Vector3(-800, ctx.terrain.heightAt(-800, -500), -500);
    ctx.labels.add('回民街', new THREE.Vector3(-420, c.y + 30, -420), { category: 'district', priority: 1.5, minDist: 80, maxDist: 5000 });
    ctx.labels.add('洒金桥', new THREE.Vector3(-1320, c.y + 25, -760), { category: 'district', priority: 1.2, minDist: 80, maxDist: 4000 });
    console.warn(`[huimin] ${data.b.length} 栋，${JSON.stringify(stats)}，${(performance.now() - t0).toFixed(0)} ms`);
    const tmp = new THREE.Vector3();
    return {
      update() {
        tmp.copy(ctx.camera.position);
        detail.visible = Math.hypot(tmp.x - c.x, tmp.z - c.z) < 1800 && tmp.y - c.y < 1200;
      },
      setLayer(layer, v) {
        if (layer === 'buildings') group.visible = v;
      },
      dispose() {
        group.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(group);
      },
    };
  },
};
