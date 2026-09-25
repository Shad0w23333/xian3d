import * as THREE from 'three';
import { addBox } from '../arch/shared.js';
import { buildTimberTower } from '../arch/traditional.js';

function addCopperBell(ctx, group, x, y, z, scale = 1) {
  const metal = new THREE.MeshPhysicalMaterial({ color: 0x94794f, metalness: 0.8, roughness: 0.32 });
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.52 * scale, 0.86 * scale, 1.1 * scale, 14, 1, true), metal);
  bell.position.set(x, y, z); group.add(bell);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.84 * scale, 0.08 * scale, 8, 16), metal);
  lip.rotation.x = Math.PI / 2; lip.position.set(x, y - 0.5 * scale, z); group.add(lip);
  const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.07 * scale, 0.07 * scale, 0.9 * scale, 6), ctx.mats.get('woodDark'));
  hanger.position.set(x, y + 0.95 * scale, z); group.add(hanger);
}

export default {
  id: 'belltower',
  name: '钟楼与鼓楼',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '钟鼓楼'; ctx.scene.add(root);
    const bell = new THREE.Group(); bell.name = '西安钟楼';
    const bellPos = ctx.geo.project(108.9423419, 34.2610119);
    bell.position.set(bellPos.x, ctx.terrain.heightAt(bellPos.x, bellPos.z), bellPos.z);
    root.add(bell);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(45, 48, 3.2, 64), ctx.mats.get('marble'));
    pedestal.position.y = 1.6; pedestal.receiveShadow = true; bell.add(pedestal);
    const step = new THREE.Mesh(new THREE.CylinderGeometry(38, 41, 1.1, 64), ctx.mats.get('stonePaving'));
    step.position.y = 3.4; bell.add(step);
    const tower = new THREE.Group(); tower.position.y = 4.2; bell.add(tower);
    const spec = buildTimberTower(ctx, tower, { width: 31, depth: 31, height: 25, floors: 3, name: '长安钟楼', signText: '钟楼', signY: 13.6, roof: 'roofGreenGlazed', base: 'wallBrick', trim: 'lacquerRed', tierScale: 0.91, roofOverhang: 3.1, roofRise: 4.5, podium: 0.7, columnRadius: 0.34 });
    // 四面门洞与石阶，让近景能看见一层暗门、斗拱和透光隔扇。
    const doorwayMat = ctx.mats.get('woodDark');
    for (const [x, z] of [[0, 13], [13, 0], [0, -13], [-13, 0]]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(3.7, 5.8, 0.35), doorwayMat);
      door.position.set(x, 4.5, z); door.rotation.y = Math.atan2(x, z); tower.add(door);
    }
    for (let i = -2; i <= 2; i++) {
      const tread = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.35, 1.15), ctx.mats.get('stonePaving'));
      tread.position.set(0, 0.42 + (i + 2) * 0.35, 20 + i * 1.1); tower.add(tread);
    }
    addCopperBell(ctx, tower, 0, 15.8, 4.2, 1.35);
    ctx.labels.add('西安钟楼', new THREE.Vector3(bell.position.x, bell.position.y + spec.top + 20, bell.position.z), { category: 'landmark', minDist: 45, maxDist: 11000, priority: 5 });
    ctx.lights.add({ position: new THREE.Vector3(bell.position.x, bell.position.y + 19, bell.position.z), color: 0xffc16f, intensity: 1800, distance: 170, nightOnly: true, priority: 3 });

    const drumPos = ctx.geo.project(108.9391, 34.2625);
    const drum = new THREE.Group(); drum.name = '西安鼓楼';
    drum.position.set(drumPos.x, ctx.terrain.heightAt(drumPos.x, drumPos.z), drumPos.z);
    root.add(drum);
    const dBase = new THREE.Mesh(new THREE.BoxGeometry(55, 5, 43), ctx.mats.get('marble'));
    dBase.position.y = 2.5; drum.add(dBase);
    const dTower = new THREE.Group(); dTower.position.y = 5; drum.add(dTower);
    const drumSpec = buildTimberTower(ctx, dTower, { width: 37, depth: 30, height: 22, floors: 2, name: '西安鼓楼', signText: '鼓楼', signY: 9.7, roof: 'roofGreenGlazed', base: 'wallBrick', trim: 'lacquerRed', tierScale: 0.91, roofOverhang: 3.4, roofRise: 5.2, podium: 0.8, columnRadius: 0.4 });
    const frame = ctx.mats.get('woodDark');
    addBox(dTower, [9.2, 4.4, 6.4], [0, 9.8, 0], frame);
    const drumBody = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 4.2, 24), ctx.mats.get('lacquerRed'));
    drumBody.rotation.z = Math.PI / 2; drumBody.position.set(0, 11.2, 0); dTower.add(drumBody);
    addCylinderRim(dTower, ctx, 0, 11.2, 0);
    ctx.labels.add('西安鼓楼', new THREE.Vector3(drum.position.x, drum.position.y + drumSpec.top + 13, drum.position.z), { category: 'landmark', minDist: 40, maxDist: 8500, priority: 4 });
    ctx.lights.add({ position: new THREE.Vector3(drum.position.x, drum.position.y + 15, drum.position.z), color: 0xffa75d, intensity: 1200, distance: 110, nightOnly: true, priority: 2 });

    // 老城中轴的街巷牌楼缩景与屋檐灯笼，丰富贴近地面的步行视角。
    for (const [lon, lat, text] of [[108.9416, 34.2586, '南大街'], [108.9423, 34.2642, '北大街'], [108.9370, 34.2613, '回民街']]) {
      const p = ctx.geo.project(lon, lat), y = ctx.terrain.heightAt(p.x, p.z);
      const g = new THREE.Group(); g.position.set(p.x, y, p.z); root.add(g);
      addBox(g, [8.5, 0.55, 0.75], [0, 5.3, 0], ctx.mats.get('lacquerRed'));
      for (const x of [-3.7, 3.7]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 5, 10), ctx.mats.get('lacquerRed'));
        col.position.set(x, 2.5, 0); g.add(col);
      }
      const plaque = ctx.sign(text, { height: 1.05, bg: '#6b2116', border: '#d2a552', color: '#fae3a2', serif: true, size: 84, emissive: 1.5 });
      plaque.position.set(0, 5.55, 0.42); g.add(plaque);
    }
    return {
      setLayer(layer, visible) { if (layer === 'landmarks') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
    };
  },
};

function addCylinderRim(group, ctx, x, y, z) {
  const ringMat = ctx.mats.get('gold');
  for (const offset of [-2.05, 2.05]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.18, 9, 24), ringMat);
    ring.rotation.y = Math.PI / 2; ring.position.set(x + offset, y, z); group.add(ring);
  }
}
