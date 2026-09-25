import * as THREE from 'three';
import { addBox } from '../arch/shared.js';

const temp = new THREE.Object3D();

function taperedWall(w0, d0, w1, d1, h) {
  const a = [[-w0 / 2, 0, -d0 / 2], [w0 / 2, 0, -d0 / 2], [w0 / 2, 0, d0 / 2], [-w0 / 2, 0, d0 / 2]];
  const b = [[-w1 / 2, h, -d1 / 2], [w1 / 2, h, -d1 / 2], [w1 / 2, h, d1 / 2], [-w1 / 2, h, d1 / 2]];
  const p = [], uv = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    // 外墙面绕序朝外；反向会被 FrontSide 材质背面剔除，导致塔身消失。
    p.push(...a[i], ...b[i], ...a[j], ...a[j], ...b[i], ...b[j]);
    const u0 = Math.hypot(a[i][0] - a[j][0], a[i][2] - a[j][2]);
    uv.push(0, 0, 0, h, u0, 0, u0, 0, 0, h, u0, h);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function plinth(ctx, group, width, height) {
  const stone = ctx.mats.get('marble');
  addBox(group, [width + 13, 0.6, width + 13], [0, 0.3, 0], stone);
  addBox(group, [width + 9, 0.9, width + 9], [0, 1.05, 0], ctx.mats.get('stonePaving'));
  addBox(group, [width + 5, 0.48, width + 5], [0, 1.74, 0], stone);
  for (const side of [-1, 1]) {
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const tread = new THREE.Mesh(new THREE.BoxGeometry(width * 0.58 + (steps - i) * 1.0, 0.23, 1.0), stone);
      tread.position.set(0, 0.22 + i * 0.24, side * (width / 2 + 7 + i * 0.8));
      group.add(tread);
    }
  }
  return height;
}

export default {
  id: 'pagoda',
  name: '大雁塔与大慈恩寺',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '大慈恩寺与大雁塔'; ctx.scene.add(root);
    const ll = ctx.geo.project(108.96423, 34.2196);
    const baseY = ctx.terrain.heightAt(ll.x, ll.z);
    const temple = new THREE.Group(); temple.position.set(ll.x, baseY, ll.z); root.add(temple);
    const ground = new THREE.Mesh(new THREE.BoxGeometry(155, 0.65, 160), ctx.mats.get('stonePaving'));
    ground.position.set(0, 0.15, 0); ground.receiveShadow = true; temple.add(ground);
    // 大慈恩寺南北中轴院墙和门殿，开口留在南面。
    const wall = ctx.mats.get('wallBrickDark');
    const wallY = 3.4;
    addBox(temple, [158, 6.6, 2.4], [0, wallY, -80], wall);
    addBox(temple, [158, 6.6, 2.4], [0, wallY, 80], wall);
    addBox(temple, [2.4, 6.6, 154], [-78, wallY, 0], wall);
    addBox(temple, [2.4, 6.6, 154], [78, wallY, 0], wall);
    const gate = new THREE.Group(); gate.position.set(0, 0.65, 77); temple.add(gate);
    addBox(gate, [30, 0.8, 14], [0, 6.7, 0], ctx.mats.get('marble'));
    addBox(gate, [3.8, 12, 3.8], [-13, 6.3, 0], ctx.mats.get('wallBrick'));
    addBox(gate, [3.8, 12, 3.8], [13, 6.3, 0], ctx.mats.get('wallBrick'));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(18, 5.5, 4), ctx.mats.get('roofGreenGlazed'));
    roof.position.set(0, 14, 0); roof.rotation.y = Math.PI / 4; gate.add(roof);
    const plaque = ctx.sign('大慈恩寺', { height: 1.55, size: 98, bg: '#792417', border: '#dab56c', color: '#f5dfa6', serif: true, emissive: 1.3 });
    plaque.position.set(0, 9.2, 7.3); gate.add(plaque);

    // 七层方形砖塔：实测轮廓、逐层收分、石质檐口、券窗与塔刹。
    const tower = new THREE.Group(); tower.name = '大雁塔'; tower.position.set(0, 1.95, -2); temple.add(tower);
    const width0 = 25.4;
    plinth(ctx, tower, width0, 67);
    const brickMat = ctx.mats.get('pagodaBrick');
    const eaveMat = ctx.mats.get('roofGray');
    const detailMat = ctx.mats.get('wallBrickDark');
    const windowMat = ctx.mats.clone('paperWindow', { color: 0x3c2c20, emissive: new THREE.Color(0x8c5730), emissiveIntensity: 0.16 });
    ctx.night.register(windowMat, { day: 0.12, night: 1.5 });
    let y = 2.1, width = width0;
    const tierHeights = [8.6, 7.4, 6.9, 6.4, 5.9, 5.5, 5.1];
    for (let floor = 0; floor < 7; floor++) {
      const h = tierHeights[floor], topW = width - 1.7;
      const body = new THREE.Mesh(taperedWall(width, width, topW, topW, h), brickMat);
      body.position.y = y; body.castShadow = true; body.receiveShadow = true; tower.add(body);
      // 每层四面均有小券窗，窗口由深色内凹板和浅色石券边组成。
      const panel = new THREE.InstancedMesh(new THREE.BoxGeometry(Math.max(1.1, width * 0.13), 2.15, 0.28), windowMat, 4);
      const lintel = new THREE.InstancedMesh(new THREE.BoxGeometry(Math.max(1.8, width * 0.17), 0.36, 0.48), detailMat, 4);
      const sill = new THREE.InstancedMesh(new THREE.BoxGeometry(Math.max(1.8, width * 0.17), 0.32, 0.48), detailMat, 4);
      const dist = (width + topW) * 0.25 + 0.14;
      const centers = [[0, -dist, 0], [dist, 0, Math.PI / 2], [0, dist, Math.PI], [-dist, 0, -Math.PI / 2]];
      centers.forEach(([x, z, ry], i) => {
        temp.position.set(x, y + h * 0.52, z); temp.rotation.set(0, ry, 0); temp.updateMatrix(); panel.setMatrixAt(i, temp.matrix);
        temp.position.set(x, y + h * 0.52 + 1.2, z); temp.rotation.set(0, ry, 0); temp.updateMatrix(); lintel.setMatrixAt(i, temp.matrix);
        temp.position.set(x, y + h * 0.52 - 1.2, z); temp.rotation.set(0, ry, 0); temp.updateMatrix(); sill.setMatrixAt(i, temp.matrix);
      });
      panel.instanceMatrix.needsUpdate = true; lintel.instanceMatrix.needsUpdate = true; sill.instanceMatrix.needsUpdate = true;
      tower.add(panel, lintel, sill);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(width + 4.6, 0.72, width + 4.6), eaveMat);
      slab.position.set(0, y + h - 0.05, 0); slab.castShadow = true; tower.add(slab);
      const edge = new THREE.Mesh(new THREE.BoxGeometry(width + 5.2, 0.2, width + 5.2), detailMat);
      edge.position.set(0, y + h + 0.4, 0); tower.add(edge);
      // 四角飞檐外挑与檐角铜铃。
      const cornerR = Math.sqrt(2) * (width / 2 + 2.1);
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * Math.PI / 2;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.25, 1.5, 7), ctx.mats.get('gold'));
        tip.position.set(Math.cos(a) * cornerR, y + h + 0.8, Math.sin(a) * cornerR); tip.rotation.z = -0.55; tower.add(tip);
      }
      y += h + 0.75;
      width = topW;
    }
    const finial = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.48, 5.6, 12), ctx.mats.get('gold'));
    finial.position.set(0, y + 2.8, 0); tower.add(finial);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.66, 14, 12), ctx.mats.get('gold'));
    orb.position.set(0, y + 5.8, 0); tower.add(orb);

    // 塔前石阶、碑亭与经幢。
    for (const z of [27, 34]) {
      addBox(tower, [34, 0.45, 2.4], [0, 0.55, z], ctx.mats.get('marble'));
    }
    const stele = new THREE.Mesh(new THREE.BoxGeometry(1.8, 4.4, 0.9), ctx.mats.get('stonePaving'));
    stele.position.set(-24, 2.5, 39); temple.add(stele);
    ctx.labels.add('大雁塔 · 玄奘塔院', new THREE.Vector3(ll.x, baseY + y + 14, ll.z), { category: 'landmark', minDist: 50, maxDist: 25000, priority: 5 });
    ctx.labels.add('大慈恩寺', new THREE.Vector3(ll.x, baseY + 19, ll.z + 95), { category: 'landmark', minDist: 100, maxDist: 14000, priority: 3 });
    ctx.lights.add({ position: new THREE.Vector3(ll.x, baseY + 30, ll.z), color: 0xffbf70, intensity: 1500, distance: 150, nightOnly: true, priority: 2.8 });
    return {
      setLayer(layer, visible) { if (layer === 'landmarks') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
    };
  },
};
