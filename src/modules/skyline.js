import * as THREE from 'three';
import { Batcher } from '../core/util.js';

const CHUNK = 7000;

function makeBuildingShape(outer, cx, cz, height) {
  const shape = new THREE.Shape();
  for (let i = 0; i < outer.length; i += 2) {
    const x = outer[i] - cx, z = outer[i + 1] - cz;
    if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1, steps: 1 });
  g.rotateX(-Math.PI / 2);
  return g;
}

function fillWindows(ctx, features, chunkMap, maxInstances = 72000) {
  let made = 0;
  for (const f of features) {
    if (made >= maxInstances || f.h < 48 || Math.hypot(f.x, f.z) > 26000) continue;
    const key = `${Math.floor(f.x / CHUNK)}:${Math.floor(f.z / CHUNK)}`;
    const chunk = chunkMap.get(key);
    if (!chunk) continue;
    const ground = ctx.terrain.heightAt(f.x, f.z), outer = f.outer, n = outer.length / 2;
    const floors = Math.min(58, Math.floor(f.h / 3.4));
    for (let edge = 0; edge < n && made < maxInstances; edge++) {
      const i = edge * 2, j = ((edge + 1) % n) * 2;
      const ax = outer[i], az = outer[i + 1], bx = outer[j], bz = outer[j + 1];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
      if (len < 5) continue;
      const cols = Math.min(20, Math.floor(len / 4.3)), rows = Math.min(floors, 42), yaw = Math.atan2(-dz, dx);
      const nx = -dz / len, nz = dx / len;
      for (let r = 0; r < rows && made < maxInstances; r += 1) {
        const y = ground + 2.6 + r * 3.3;
        for (let c = 0; c < cols && made < maxInstances; c++) {
          const t = (c + 0.5) / cols;
          chunk.windows.push({ x: ax + dx * t + nx * 0.11, z: az + dz * t + nz * 0.11, y, yaw });
          made++;
        }
      }
    }
  }
  return made;
}

export default {
  id: 'skyline',
  name: '高新、曲江与未央天际线',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '西安高层商务区'; ctx.scene.add(root);
    const data = (ctx.data.skyline?.features || []).filter((f) => f.outer?.length >= 6 && f.h >= 34 && Math.hypot(f.x, f.z) < 47000);
    if (!data.length) return { setLayer(layer, v) { if (layer === 'buildings') root.visible = v; } };
    const variants = [
      new THREE.MeshPhysicalMaterial({ color: 0x41677e, metalness: 0.56, roughness: 0.18, clearcoat: 0.88, clearcoatRoughness: 0.1 }),
      new THREE.MeshPhysicalMaterial({ color: 0x5b6a73, metalness: 0.48, roughness: 0.22, clearcoat: 0.82 }),
      new THREE.MeshPhysicalMaterial({ color: 0x8c795e, metalness: 0.46, roughness: 0.25, clearcoat: 0.78 }),
      ctx.mats.clone('concrete', { color: 0xaaa69e, roughness: 0.66 }),
    ];
    const windows = new THREE.MeshPhysicalMaterial({ color: 0x315a73, metalness: 0.58, roughness: 0.13, clearcoat: 0.9, emissive: 0x203546, emissiveIntensity: 0.02 });
    ctx.night.register(windows, { day: 0.02, night: 1.45 });
    const labelsSeen = new Set();
    const signLimit = 42;
    let signCount = 0;
    const chunks = new Map();
    for (let i = 0; i < data.length; i++) {
      const f = data[i], cx = Math.floor(f.x / CHUNK), cz = Math.floor(f.z / CHUNK), key = `${cx}:${cz}`;
      if (!chunks.has(key)) chunks.set(key, { cx: cx * CHUNK, cz: cz * CHUNK, batches: variants.map(() => new Batcher()), windows: [], roots: [] });
      const chunk = chunks.get(key);
      const ground = ctx.terrain.heightAt(f.x, f.z);
      const height = Math.max(34, Number(f.h) || 60);
      const g = makeBuildingShape(f.outer, f.x, f.z, height);
      const matIndex = f.kind === 3 ? 3 : (f.kind === 4 || f.kind === 5 || f.kind === 7 ? 2 : (i % 6 === 0 ? 1 : 0));
      chunk.batches[matIndex].add(g, variants[matIndex], new THREE.Matrix4().makeTranslation(f.x - chunk.cx, ground, f.z - chunk.cz));
      g.dispose();

      const isHero = height > 94 || /电视塔|金融|商务中心|国际大厦|电视台|中心/.test(f.n);
      if (isHero) {
        const top = ground + height;
        const beacon = new THREE.Group(); beacon.position.set(f.x, top, f.z); root.add(beacon);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.52, Math.min(16, height * 0.11), 8), ctx.mats.get('metalGray'));
        mast.position.y = mast.geometry.parameters.height / 2; beacon.add(mast);
        const light = new THREE.Mesh(new THREE.SphereGeometry(0.65, 10, 8), ctx.mats.get('lampWarm'));
        light.position.y = mast.geometry.parameters.height + 0.55; beacon.add(light);
        ctx.lights.add({ position: new THREE.Vector3(f.x, top + mast.geometry.parameters.height, f.z), color: 0xff7161, intensity: 300, distance: 48, nightOnly: true, priority: 1.5 });
      }
      if (isHero && signCount < signLimit && Math.hypot(f.x, f.z) < 30000) {
        const sign = ctx.sign(f.n, { height: 2.2, size: 104, bg: '#152736', border: '#80b7cf', borderWidth: 0.04, color: '#e5f8ff', emissive: 2.4, glow: '#79c5ff' });
        sign.position.set(f.x, ground + Math.min(height * 0.74, height - 5), f.z + 0.5);
        sign.rotation.y = Math.PI;
        root.add(sign); signCount++;
      }
      if (!labelsSeen.has(f.n) && Math.hypot(f.x, f.z) < 38000) {
        ctx.labels.add(f.n, new THREE.Vector3(f.x, ground + height + 6, f.z), { category: 'landmark', minDist: 170, maxDist: 15000, priority: height > 85 ? 1.8 : 0.75 });
        labelsSeen.add(f.n);
      }
    }
    const windowCount = fillWindows(ctx, data, chunks);
    for (const [key, chunk] of chunks) {
      const group = new THREE.Group(); group.name = `高层-${key}`; group.position.set(chunk.cx, 0, chunk.cz);
      for (let i = 0; i < chunk.batches.length; i++) {
        const part = chunk.batches[i].build({ name: `天际线材质${i}`, castShadow: true, receiveShadow: true });
        for (const mesh of part.children) group.add(mesh);
      }
      if (chunk.windows.length) {
        const win = new THREE.InstancedMesh(new THREE.BoxGeometry(1.18, 1.62, 0.06), windows, chunk.windows.length);
        const dummy = new THREE.Object3D();
        for (let i = 0; i < chunk.windows.length; i++) {
          const w = chunk.windows[i]; dummy.position.set(w.x - chunk.cx, w.y, w.z - chunk.cz); dummy.rotation.set(0, w.yaw, 0); dummy.updateMatrix(); win.setMatrixAt(i, dummy.matrix);
        }
        win.instanceMatrix.needsUpdate = true; win.castShadow = false; group.add(win);
      }
      root.add(group);
      const centerX = chunk.cx + CHUNK / 2, centerZ = chunk.cz + CHUNK / 2;
      chunk.roots = [{ group, x: centerX, z: centerZ }];
    }
    let drawDistance = (ctx.quality.buildingDistance || 16000) + 8000;
    let frame = 0, layerVisible = true;
    const districtLabels = [
      ['高新区', 108.885, 34.225, 13000], ['未央国际商圈', 108.941, 34.336, 14000],
      ['曲江新区', 108.979, 34.205, 12000], ['经开区', 108.946, 34.344, 9000],
      ['浐灞生态区', 109.034, 34.315, 12000],
    ];
    for (const [name, lon, lat, maxDist] of districtLabels) {
      const p = ctx.geo.project(lon, lat), y = ctx.terrain.heightAt(p.x, p.z) + 180;
      ctx.labels.add(name, new THREE.Vector3(p.x, y, p.z), { category: 'district', minDist: 1000, maxDist, priority: 2.1 });
    }
    return {
      setQuality(q) { drawDistance = (q.buildingDistance || 16000) + 8000; },
      setLayer(layer, visible) { if (layer === 'buildings') { layerVisible = visible; root.visible = visible; } },
      update() {
        if (++frame % 18) return;
        const p = ctx.camera.position;
        root.traverse((o) => {
          if (!o.isGroup || !o.name.startsWith('高层-')) return;
          o.visible = layerVisible && Math.hypot(p.x - o.position.x - CHUNK / 2, p.z - o.position.z - CHUNK / 2) < drawDistance + CHUNK;
        });
      },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
      stats: { towers: data.length, windows: windowCount, signs: signCount },
    };
  },
};
