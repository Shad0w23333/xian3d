import * as THREE from 'three';
import { addBox, addGroundRibbon, addLantern, mergeStaticChildren } from '../arch/shared.js';
import { buildTimberTower } from '../arch/traditional.js';

function pavilion(ctx, root, lon, lat, name, scale = 1) {
  const p = ctx.geo.project(lon, lat);
  const g = new THREE.Group(); g.name = name;
  g.position.set(p.x, ctx.terrain.heightAt(p.x, p.z), p.z); root.add(g);
  const result = buildTimberTower(ctx, g, {
    width: 27 * scale, depth: 23 * scale, height: 25 * scale, floors: 3,
    name, signText: name, signY: 12 * scale, roof: 'roofYellowGlazed', base: 'pagodaBrick',
    trim: 'lacquerRed', tierScale: 0.87, roofOverhang: 3.5 * scale, roofRise: 4.7 * scale,
    podium: 0.9, columnRadius: 0.32 * scale,
  });
  ctx.labels.add(name, new THREE.Vector3(p.x, g.position.y + result.top + 10, p.z), { category: 'landmark', minDist: 140, maxDist: 13500, priority: 1.8 });
  ctx.lights.add({ position: new THREE.Vector3(p.x, g.position.y + result.top * 0.62, p.z), color: 0xffca7d, intensity: 620, distance: 86, nightOnly: true, priority: 1.6 });
  return g;
}

export default {
  id: 'qujiang',
  name: '曲江新区与大唐芙蓉园',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '曲江文化新区'; ctx.scene.add(root);
    const center = ctx.geo.project(108.9784, 34.2052);
    const parkGround = ctx.mats.clone('grass', { color: 0x586b3e, roughness: 0.97 });
    const lakeWalk = ctx.mats.get('stonePaving');
    // 曲江池南湖和芙蓉园沿岸步行带；水体本身由水系矢量面承载。
    addGroundRibbon(ctx, root, [center.x - 930, center.z + 250, center.x - 510, center.z - 560, center.x + 90, center.z - 840, center.x + 660, center.z - 520, center.x + 970, center.z + 150], 6.2, 0.65, lakeWalk, 14);
    addGroundRibbon(ctx, root, [center.x - 710, center.z + 380, center.x - 260, center.z + 700, center.x + 550, center.z + 620, center.x + 930, center.z + 250], 5.2, 0.65, lakeWalk, 14);
    // 入口广场与中轴草坪。
    const square = new THREE.Mesh(new THREE.BoxGeometry(180, 0.5, 130), ctx.mats.get('stonePaving'));
    square.position.set(center.x, ctx.terrain.heightAt(center.x, center.z) + 0.4, center.z + 360); square.receiveShadow = true; root.add(square);
    const lawns = new THREE.Mesh(new THREE.BoxGeometry(280, 0.22, 80), parkGround);
    lawns.position.set(center.x + 240, ctx.terrain.heightAt(center.x + 240, center.z) + 0.26, center.z - 10); root.add(lawns);
    pavilion(ctx, root, 108.9728, 34.2085, '紫云楼', 1.2);
    pavilion(ctx, root, 108.9684, 34.2121, '御宴宫', 0.78);
    pavilion(ctx, root, 108.9789, 34.1972, '曲江亭', 0.82);

    // 唐风园门、曲江池遗址公园与诗词雕塑。
    const gatePos = ctx.geo.project(108.9764, 34.2081), gateY = ctx.terrain.heightAt(gatePos.x, gatePos.z);
    const gate = new THREE.Group(); gate.name = '芙蓉园南门'; gate.position.set(gatePos.x, gateY, gatePos.z); root.add(gate);
    const timber = ctx.mats.get('lacquerRed'), gold = ctx.mats.get('gold'), stone = ctx.mats.get('marble');
    for (const x of [-20, 20]) {
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.0, 14, 12), timber);
      column.position.set(x, 7, 0); gate.add(column);
      addBox(gate, [7, 0.75, 6], [x, 14.2, 0], gold);
      addLantern(ctx, gate, x, -1.7, 11.2, 1.1, 0xffbf59);
    }
    addBox(gate, [51, 1.4, 6.8], [0, 14.5, 0], timber);
    const gateSign = ctx.sign('大唐芙蓉园', { height: 2.1, size: 115, bg: '#6e1d14', border: '#e2bb74', color: '#ffedbe', serif: true, emissive: 2.5 });
    gateSign.position.set(0, 15.3, 3.5); gate.add(gateSign);
    mergeStaticChildren(gate, '芙蓉园牌楼');

    // 曲江池上的三孔石桥，分段拱券与青石栏杆。
    const bridge = new THREE.Group(); bridge.name = '曲江石拱桥';
    bridge.position.set(center.x + 400, ctx.terrain.heightAt(center.x + 400, center.z + 250), center.z + 250); root.add(bridge);
    const stoneMat = ctx.mats.get('stonePaving');
    const deck = new THREE.Mesh(new THREE.BoxGeometry(96, 2.4, 11), stoneMat); deck.position.y = 4.2; deck.castShadow = true; bridge.add(deck);
    for (const x of [-38, 0, 38]) {
      const pier = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 6.3, 4.3, 12), stoneMat); pier.position.set(x, 1.6, 0); bridge.add(pier);
    }
    for (const side of [-1, 1]) {
      addBox(bridge, [96, 1.1, 0.65], [0, 6.1, side * 5.2], stone);
      for (let x = -42; x <= 42; x += 7) {
        const baluster = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.23, 2.1, 7), stone);
        baluster.position.set(x, 5.1, side * 5.2); bridge.add(baluster);
      }
    }
    // 夜景中的垂柳色温与亭台灯火。
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * Math.PI * 2, rx = 830 + 85 * Math.sin(a * 3), rz = 520 + 90 * Math.cos(a * 2);
      const x = center.x + Math.cos(a) * rx, z = center.z + Math.sin(a) * rz, y = ctx.terrain.heightAt(x, z);
      ctx.lights.add({ position: new THREE.Vector3(x, y + 8, z), color: i % 3 ? 0xffbb77 : 0xcad8ff, intensity: 160, distance: 36, nightOnly: true, priority: 1.1 });
      if (i % 4 === 0) addLantern(ctx, root, x, z, y + 5, 0.7, 0xffbc5d);
    }
    ctx.labels.add('曲江新区', new THREE.Vector3(center.x, ctx.terrain.heightAt(center.x, center.z) + 215, center.z), { category: 'district', minDist: 900, maxDist: 26000, priority: 3 });
    ctx.labels.add('曲江池遗址公园', new THREE.Vector3(center.x + 680, ctx.terrain.heightAt(center.x + 680, center.z + 200) + 28, center.z + 200), { category: 'district', minDist: 220, maxDist: 11500, priority: 2 });
    return {
      setLayer(layer, visible) { if (layer === 'landmarks' || layer === 'landuse') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
    };
  },
};
