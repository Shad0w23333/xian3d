import * as THREE from 'three';
import { addBox, addGroundRibbon, addLantern, mergeStaticChildren } from '../arch/shared.js';

const SHOPS = [
  '长安十二时辰', '盛唐密盒', '不倒翁小姐姐', '大唐市集', '大唐礼物', '诗词长安',
  '雁塔题名', '胡姬酒肆', '长安乐坊', '曲江夜宴', '唐风茶社', '大唐西市',
  '华灯初上', '长安记忆', '丝路驿站', '太白酒坊', '曲江书院', '凤鸣长安',
];

function addLanternRow(ctx, parent, centerX, centerZ, z0, z1, side, step = 28) {
  const count = Math.max(1, Math.floor((z1 - z0) / step));
  const poleGeo = new THREE.CylinderGeometry(0.1, 0.14, 7.5, 7);
  const poleMat = ctx.mats.get('woodDark');
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, count);
  const ballGeo = new THREE.SphereGeometry(0.58, 12, 10); ballGeo.scale(1, 1.28, 0.83);
  const glowMat = new THREE.MeshStandardMaterial({ color: 0xd94423, emissive: 0xffa13b, emissiveIntensity: 0, roughness: 0.48 });
  ctx.night.register(glowMat, { day: 0.05, night: 4.1 });
  const lanterns = new THREE.InstancedMesh(ballGeo, glowMat, count);
  const caps = new THREE.InstancedMesh(new THREE.ConeGeometry(0.68, 0.28, 8), ctx.mats.get('gold'), count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const z = z0 + (i + 0.5) * (z1 - z0) / count;
    const x = centerX + side * 26, worldZ = centerZ + z;
    const y = ctx.terrain.heightAt(x, worldZ);
    dummy.position.set(x, y + 3.75, worldZ); dummy.updateMatrix(); poles.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, y + 7.2, worldZ); dummy.updateMatrix(); lanterns.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, y + 8, worldZ); dummy.updateMatrix(); caps.setMatrixAt(i, dummy.matrix);
    if (i % 5 === 2) ctx.lights.add({ position: new THREE.Vector3(x, y + 7.2, worldZ), color: 0xffa644, intensity: 200, distance: 24, nightOnly: true, priority: 1.5 });
  }
  poles.instanceMatrix.needsUpdate = true; lanterns.instanceMatrix.needsUpdate = true; caps.instanceMatrix.needsUpdate = true;
  parent.add(poles, lanterns, caps);
}

export default {
  id: 'datang',
  name: '大唐不夜城',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '大唐不夜城'; ctx.scene.add(root);
    const p = ctx.geo.project(108.96455, 34.2131);
    const baseY = ctx.terrain.heightAt(p.x, p.z);
    const zN = -720, zS = 820, half = 21;
    const axis = [0, zN, 0, zS];
    const stone = ctx.mats.get('stonePaving');
    const plaza = ctx.mats.clone('concrete', { color: 0x918678, roughness: 0.82, side: THREE.DoubleSide });
    const promenade = [
      [-62, zN, 62, zN, 62, zS, -62, zS],
      [-160, -180, 160, -180, 160, 75, -160, 75],
      [-160, 375, 160, 375, 160, 635, -160, 635],
    ];
    for (const pts of promenade) {
      const pos = [];
      for (let i = 0; i < pts.length; i += 2) pos.push(p.x + pts[i], baseY + 0.55, p.z + pts[i + 1]);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex([0, 1, 2, 0, 2, 3]); g.computeVertexNormals();
      const m = new THREE.Mesh(g, plaza); m.receiveShadow = true; root.add(m);
    }
    const central = addGroundRibbon(ctx, root, [p.x, p.z + zN, p.x, p.z + zS], 27, 0.6, stone, 10);
    if (central) central.name = '不夜城石板中轴';
    for (const offset of [-39, 39]) addGroundRibbon(ctx, root, [p.x + offset, p.z + zN, p.x + offset, p.z + zS], 2.6, 0.45, ctx.mats.get('concrete'), 15);

    // 两侧仿唐市肆以木柱、青砖墙、深色瓦檐和夜间匾额构成近景街面。
    const wood = ctx.mats.get('lacquerRed'), masonry = ctx.mats.get('pagodaBrick'), roof = ctx.mats.get('roofGray');
    const beam = ctx.mats.get('woodDark'), glass = ctx.mats.get('glassGold');
    for (let i = 0; i < SHOPS.length; i++) {
      const row = Math.floor(i / 2), side = i % 2 ? 1 : -1;
      const z = zN + 68 + row * 156;
      const x = side * 77;
      const shop = new THREE.Group(); shop.position.set(p.x + x, ctx.terrain.heightAt(p.x + x, p.z + z), p.z + z); root.add(shop);
      const frontDir = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      addBox(shop, [25, 8.8, 14], [0, 4.4, 0], masonry);
      addBox(shop, [26.5, 0.75, 15.5], [0, 9.0, 0], wood);
      addBox(shop, [28, 0.65, 17], [0, 13.0, 0], roof);
      addBox(shop, [23, 2.4, 0.35], [0, 2.8, side < 0 ? 7.15 : -7.15], glass);
      for (const xx of [-10.5, -3.5, 3.5, 10.5]) {
        addBox(shop, [0.32, 9.8, 0.46], [xx, 5.0, side < 0 ? 7.2 : -7.2], wood);
      }
      const plaque = ctx.sign(SHOPS[i], { height: 1.2, size: 88, bg: i % 3 === 0 ? '#6f2118' : '#343028', border: '#d2ae6b', color: '#f4dfaa', serif: true, emissive: 2.2 });
      plaque.position.set(0, 10.6, side < 0 ? 8.0 : -8.0); plaque.rotation.y = frontDir; shop.add(plaque);
      const tablet = ctx.sign('长安 · 大唐', { height: 0.58, size: 60, bg: '#8b5a24', border: '#e3c477', color: '#fff1c0', serif: true, emissive: 2.5 });
      tablet.position.set(0, 8.5, side < 0 ? 8.0 : -8.0); tablet.rotation.y = frontDir; shop.add(tablet);
      mergeStaticChildren(shop, `${SHOPS[i]}店铺构件`);
    }

    addLanternRow(ctx, root, p.x, p.z, zN + 3, zS - 10, -1, 26);
    addLanternRow(ctx, root, p.x, p.z, zN + 3, zS - 10, 1, 26);

    // 三处节庆入口牌坊和下沉广场的发光题字。
    for (const [z, label] of [[zN + 24, '大唐不夜城'], [95, '盛世长安'], [zS - 15, '丝路起点']]) {
      const arch = new THREE.Group(); arch.position.set(p.x, ctx.terrain.heightAt(p.x, p.z + z), p.z + z); root.add(arch);
      for (const x of [-17, 17]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(1.8, 12, 2.2), wood); post.position.set(x, 6, 0); arch.add(post);
        addBox(arch, [3.3, 0.55, 3.3], [x, 12.1, 0], ctx.mats.get('gold'));
        addLantern(ctx, arch, x, -1.2, 9.6, 0.72);
      }
      addBox(arch, [39, 1.2, 4.3], [0, 12.4, 0], wood);
      const sign = ctx.sign(label, { height: 1.5, size: 102, bg: '#70251a', border: '#e3b867', color: '#ffedc0', serif: true, emissive: 3.0, glow: '#ff9f3f' });
      sign.position.set(0, 13.2, 2.25); arch.add(sign);
      mergeStaticChildren(arch, `${label}牌楼构件`);
    }
    // 地面行进灯带，靠近视点时能看见石板边线与连续灯笼的暖色反射。
    const trim = ctx.mats.get('ledGold');
    addGroundRibbon(ctx, root, [p.x - half, p.z + zN, p.x - half, p.z + zS], 0.36, 0.75, trim, 10);
    addGroundRibbon(ctx, root, [p.x + half, p.z + zN, p.x + half, p.z + zS], 0.36, 0.75, trim, 10);
    mergeStaticChildren(root, '不夜城静态构件');
    ctx.labels.add('大唐不夜城', new THREE.Vector3(p.x, baseY + 36, p.z), { category: 'district', minDist: 150, maxDist: 16000, priority: 5 });
    ctx.labels.add('大雁塔北广场', new THREE.Vector3(p.x, baseY + 24, p.z - 720), { category: 'district', minDist: 150, maxDist: 9500, priority: 2.5 });
    for (let i = 0; i < 12; i++) {
      const z = zN + (i + 0.5) * (zS - zN) / 12;
      ctx.lights.add({ position: new THREE.Vector3(p.x, ctx.terrain.heightAt(p.x, p.z + z) + 14, p.z + z), color: 0xffa64a, intensity: 600, distance: 95, nightOnly: true, priority: 1.8 });
    }
    return {
      setLayer(layer, visible) { if (layer === 'landmarks' || layer === 'traffic') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
    };
  },
};
