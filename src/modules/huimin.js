// 回民街（回坊）· 洒金桥精细街区：用 OSM 逐户建筑轮廓替换 CMAB 粗块（低于 15 m 的通用建筑让位，街区内高楼保留）。
// 数据：public/data/huimin.json（tools/build_huimin.py）；几何与贴图：src/arch/huimin-gen.js；调研：research/refs/huimin/notes.md
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { pointInPoly } from '../core/util.js';
import { buildHuimin, buildHuiminFar } from '../arch/huimin-gen.js';
import { buildArch, paifang } from '../arch/chinese.js';
import { shadowReach } from '../arch/perf-lod.js';

/** 点到多边形（扁平数组）的距离；点在内部为 0 */
function polyDist(x, z, p) {
  if (pointInPoly(x, z, p)) return 0;
  let best = Infinity;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const ax = p[i], az = p[i + 1], dx = p[j] - ax, dz = p[j + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}

export default {
  id: 'huimin',
  name: '回民街·洒金桥',
  async prepare(ctx) {
    this.data = await loadJSON('huimin.json', { optional: true });
    if (!this.data) return;
    const D = this.data, E = ctx.exclusions;
    // 街区：高度 ≤ maxH 的通用建筑让位（街区内高楼保留）；树木与 POI 按下面的细粒度规则处理
    for (const p of D.district) E.add({ points: p, name: 'huimin' }, { buildings: true, trees: false, pois: false, maxHeight: D.maxH ?? 15 });
    // 树木：避让本街区的逐户轮廓（vegetation 只认 buildings.bin 的建筑，否则树会种进新房子里）；巷道、院落仍可种树
    for (const b of D.b) if (b.p.length >= 6) E.add({ points: b.p }, { buildings: false, trees: true, pois: false });
    // POI：街区内的店名由本模块挂在对应铺面上（b.sg）。signage 只保留地铁口与靠近“仍由通用建筑模块渲染的楼”（D.keep：
    //   高楼 / 锚点在街区外的现有建筑）的 POI；其余若交给 signage，它会把店名挂到几十米外的高楼或街区外的楼上，与本模块重复
    const keep = (D.keep || []).map((p) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
      }
      return { p, x0, x1, z0, z1 };
    });
    // 已挂到本街区铺面上的店名（build_huimin.py 取铺面中心 30 m 内的 POI 名作 b.sg）：同名 POI 一律归本模块，
    //   不再看是否靠近保留建筑——否则 signage 会在旁边的保留楼上把同一个店名再挂一遍
    const signed = new Map();
    for (const b of D.b) {
      if (!b.sg) continue;
      const n = b.p.length / 2;
      let x = 0, z = 0;
      for (let i = 0; i < n; i++) { x += b.p[i * 2]; z += b.p[i * 2 + 1]; }
      if (!signed.has(b.sg)) signed.set(b.sg, []);
      signed.get(b.sg).push([x / n, z / n]); // 顶点均值，与 build_huimin.py 的 cen 相同
    }
    const shopName = (s) => String(s || '').split('(')[0].split('（')[0].trim(); // 与 build_huimin.py 取店名的规则相同
    const NEAR = 6, SG_R = 30.5;
    let nOwn = 0;
    for (const q of ctx.data.pois?.pois || []) {
      if (!q || q.k === 'subway_entrance' || !D.district.some((p) => pointInPoly(q.x, q.z, p))) continue;
      const onShop = signed.get(shopName(q.n))?.some(([x, z]) => Math.hypot(x - q.x, z - q.z) < SG_R);
      const nearKeep = !onShop && keep.some((k) => q.x > k.x0 - NEAR && q.x < k.x1 + NEAR && q.z > k.z0 - NEAR && q.z < k.z1 + NEAR && polyDist(q.x, q.z, k.p) < NEAR);
      if (nearKeep) continue;
      E.add({ rect: [q.x, q.z, 2, 2, 0], name: 'huimin-poi' }, { buildings: false, trees: false, pois: true });
      nOwn++;
    }
    this.nOwnPois = nOwn;
  },
  async build(ctx) {
    const data = this.data;
    if (!data) return {};
    const t0 = performance.now();
    const { group, detail, lanternMesh, houseMeshes, stats } = buildHuimin(ctx, data);
    ctx.scene.add(group);
    // 阴影：整个街区离相机超过 SHADOW_R 时不投射（7500 栋小房子的阴影在远处不可辨，却让三角形翻倍）
    const casters = [];
    group.traverse((o) => { if (o.isMesh && o.castShadow) casters.push(o); });
    let shadowOn = true;
    const qk = [0.6, 0.8, 1, 1.2][ctx.quality.level ?? 2] ?? 1;
    const SHADOW_R = 1400 * qk, LANTERN_R = 800 * qk, DETAIL_R = 1800 * qk;
    const FAR_R = [900, 2400, 3200, 4000][ctx.quality.level ?? 2] ?? 3200; // 超过此距离用远景低模
    // 远景低模：逐户轮廓直接拉伸成体块（平顶、顶点色），FAR_R 以外代替 0.6M 三角形的精细街区（它在 10 km 外也常驻）
    let farMesh = null;
    try {
      farMesh = buildHuiminFar(ctx, data);
      farMesh.visible = false;
      group.add(farMesh);
    } catch (e) {
      console.warn('[huimin] 远景低模构建失败', e);
    }
    let farOn = false;
    // 北院门北口白色花岗岩牌楼（1993 年建，四柱三间；调研 §2.2，尺寸为推测值）
    try {
      const px = -300, pz = -548;
      const pf = buildArch(ctx, (b) => paifang(b, { bays: 3, kind: 'stone', width: 15, h: 7.5, text: '北院门', roofColor: 'gray' }), { style: 'ming', name: '北院门牌楼' });
      pf.position.set(px, ctx.terrain.heightAt(px, pz), pz);
      group.add(pf);
    } catch (e) {
      console.warn('[huimin] 牌楼构建失败', e);
    }
    // 主街夜间暖光（真实点光源，LightPool 只点亮离相机最近的几盏；强度单位坎德拉，与其他街灯同量级）：
    //   沿主街中线每 ~14 m 一盏、离中线 1~1.5 m 左右交替、高 4.6 m（模拟头顶灯笼串与两侧店招把石板路照亮；
    //   贴着铺面放会把摊位白色棚布照成一团过曝）。旧版按折线顶点放，北院门整条街只有 1~2 盏
    let nLights = 0;
    const LIT = { 北院门: 1, 西羊市: 1, 大皮院: 1, 北广济街: 1, 洒金桥: 1, 化觉巷: 1, 大麦市街: 0.7, 庙后街: 0.7, 大学习巷: 0.7 };
    for (const lane of data.lanes) {
      const k = LIT[lane.n];
      if (!k) continue;
      const p = lane.p, hw = Math.min(1.5, (lane.w || 6) / 6);
      let s0 = 0, next = 7, side = 1;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, L = Math.hypot(dx, dz);
        for (; next < s0 + L; next += 14) {
          const s = next - s0;
          const x = ax + (dx * s) / L - (dz / L) * hw * side, z = az + (dz * s) / L + (dx / L) * hw * side;
          ctx.lights.add({ position: new THREE.Vector3(x, ctx.terrain.heightAt(x, z) + 4.6, z), color: 0xffa860, intensity: 110 * k, distance: 26, nightOnly: true, priority: 0.8 });
          side = -side;
          nLights++;
        }
        s0 += L;
      }
    }
    const c = new THREE.Vector3(-800, ctx.terrain.heightAt(-800, -500), -500);
    ctx.labels.add('回民街', new THREE.Vector3(-420, c.y + 30, -420), { category: 'district', priority: 1.5, minDist: 80, maxDist: 5000 });
    ctx.labels.add('洒金桥', new THREE.Vector3(-1320, c.y + 25, -760), { category: 'district', priority: 1.2, minDist: 80, maxDist: 4000 });
    console.warn(`[huimin] ${data.b.length} 栋，${JSON.stringify({ ...stats, ownPois: this.nOwnPois, lights: nLights })}，${(performance.now() - t0).toFixed(0)} ms`);
    const tmp = new THREE.Vector3();
    let frame = 0;
    return {
      update() {
        frame++;
        tmp.copy(ctx.camera.position);
        const d = Math.hypot(tmp.x - c.x, tmp.z - c.z, Math.max(0, tmp.y - c.y - 300));
        detail.visible = d < DETAIL_R && tmp.y - c.y < 1200;
        if (lanternMesh) lanternMesh.visible = d < LANTERN_R && tmp.y - c.y < 600;
        const far = !!farMesh && d > FAR_R;
        if (far !== farOn) {
          farOn = far;
          farMesh.visible = far;
          for (const m of houseMeshes) m.visible = !far;
        }
        if (frame % 10 === 1) {
          const sh = d < shadowReach(ctx, SHADOW_R, 15);
          if (sh !== shadowOn) {
            shadowOn = sh;
            for (const o of casters) o.castShadow = sh;
          }
        }
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
