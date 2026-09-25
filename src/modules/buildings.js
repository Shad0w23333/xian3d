import * as THREE from 'three';

const CHUNK = 5000;
const PALETTE = [
  [0.67, 0.62, 0.54], [0.72, 0.68, 0.59], [0.61, 0.65, 0.67], [0.53, 0.57, 0.6],
  [0.72, 0.7, 0.64], [0.62, 0.55, 0.45], [0.55, 0.61, 0.65], [0.77, 0.74, 0.67], [0.66, 0.59, 0.48],
];

function hash(n) {
  let x = (n + 0x9e3779b9) | 0; x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad); x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97); x ^= x >>> 15; return (x >>> 0) / 4294967296;
}

function chunkFor(map, x, z) {
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK), key = `${cx}:${cz}`;
  if (!map.has(key)) map.set(key, { key, cx: cx * CHUNK, cz: cz * CHUNK, positions: [], colors: [], indices: [], windows: [], count: 0 });
  return map.get(key);
}

function colorFor(kind, seed, roof = false) {
  const base = PALETTE[Math.max(0, Math.min(PALETTE.length - 1, kind))] || PALETTE[0];
  const k = (hash(seed) - 0.5) * 0.11;
  if (roof) return [0.31 + k, 0.32 + k, 0.33 + k];
  return base.map((x) => Math.max(0, Math.min(1, x + k)));
}

function pushVertex(chunk, p, c) {
  chunk.positions.push(p[0], p[1], p[2]); chunk.colors.push(c[0], c[1], c[2]);
}

function appendBuilding(chunk, points, groundY, height, kind, seed, minHeight = 0, makeRoof = true) {
  const n = points.length / 2;
  if (n < 3 || n > 260) return;
  const wall = colorFor(kind, seed), roof = colorFor(kind, seed + 19, true);
  const h0 = groundY + minHeight, h1 = h0 + height;
  const start = chunk.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2] - chunk.cx, z = points[i * 2 + 1] - chunk.cz;
    pushVertex(chunk, [x, h0, z], wall);       // 外牆底环
  }
  for (let i = 0; i < n; i++) {
    const x = points[i * 2] - chunk.cx, z = points[i * 2 + 1] - chunk.cz;
    pushVertex(chunk, [x, h1, z], wall);       // 外牆顶环
  }
  const roofStart = chunk.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2] - chunk.cx, z = points[i * 2 + 1] - chunk.cz;
    pushVertex(chunk, [x, h1, z], roof);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = start + i, b = start + j, at = start + n + i, bt = start + n + j;
    chunk.indices.push(a, b, at, b, bt, at);
  }
  if (makeRoof) {
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(points[i * 2] - chunk.cx, points[i * 2 + 1] - chunk.cz));
    try {
      const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const tri of triangles) chunk.indices.push(roofStart + tri[0], roofStart + tri[1], roofStart + tri[2]);
    } catch {
      for (let i = 1; i < n - 1; i++) chunk.indices.push(roofStart, roofStart + i, roofStart + i + 1);
    }
  }
  chunk.count++;
}

function skylineMatch(name, x, z, index) {
  if (!name) return false;
  const features = skylineMatch.index.get(name);
  if (!features) return false;
  return features.some((p) => Math.hypot(x - p[0], z - p[1]) < 35);
}
skylineMatch.index = new Map();

function addWindows(chunk, pts, ground, height, maxCount) {
  if (chunk.windows.length >= maxCount) return;
  const floors = Math.max(1, Math.floor((height - 2.8) / 3.15));
  if (floors <= 1) return;
  const n = pts.length / 2;
  for (let i = 0; i < n && chunk.windows.length < maxCount; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], j = (i + 1) % n;
    const bx = pts[j * 2], bz = pts[j * 2 + 1], dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 5) continue;
    const cols = Math.min(18, Math.floor(len / 4.6));
    const rows = Math.min(floors, 48);
    const yaw = Math.atan2(-dz, dx);
    const nx = -dz / len, nz = dx / len;
    for (let row = 0; row < rows && chunk.windows.length < maxCount; row++) {
      const y = ground + 2.6 + row * 3.1;
      if (y > ground + height - 1.5) break;
      for (let col = 0; col < cols && chunk.windows.length < maxCount; col++) {
        const t = (col + 0.5) / cols;
        chunk.windows.push({ x: ax + dx * t + nx * 0.12, y, z: az + dz * t + nz * 0.12, yaw,
          w: Math.min(1.45, len / cols * 0.55), h: Math.min(1.65, height / floors * 0.53) });
      }
    }
  }
}

function parseBinary(buffer) {
  if (!buffer || buffer.byteLength < 16) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 88 || view.getUint8(1) !== 66 || view.getUint8(2) !== 76 || view.getUint8(3) !== 68) return null;
  const version = view.getUint32(4, true), count = view.getUint32(8, true), total = view.getUint32(12, true);
  if (version !== 1 || count > 800000 || total > 6000000) return null;
  let o = 16;
  const anchorsX = new Float32Array(count), anchorsZ = new Float32Array(count);
  for (let i = 0; i < count; i++, o += 4) anchorsX[i] = view.getFloat32(o, true);
  for (let i = 0; i < count; i++, o += 4) anchorsZ[i] = view.getFloat32(o, true);
  const starts = new Uint32Array(count), counts = new Uint16Array(count), heights = new Uint16Array(count), mins = new Uint16Array(count), kinds = new Uint8Array(count), flags = new Uint8Array(count);
  for (let i = 0; i < count; i++, o += 4) starts[i] = view.getUint32(o, true);
  for (let i = 0; i < count; i++, o += 2) counts[i] = view.getUint16(o, true);
  for (let i = 0; i < count; i++, o += 2) heights[i] = view.getUint16(o, true);
  for (let i = 0; i < count; i++, o += 2) mins[i] = view.getUint16(o, true);
  for (let i = 0; i < count; i++, o++) kinds[i] = view.getUint8(o);
  for (let i = 0; i < count; i++, o++) flags[i] = view.getUint8(o);
  o = (o + 3) & ~3;
  if (o + total * 4 > buffer.byteLength) return null;
  const offsets = new Int16Array(total * 2);
  for (let i = 0; i < offsets.length; i++, o += 2) offsets[i] = view.getInt16(o, true);
  return { count, total, anchorsX, anchorsZ, starts, counts, heights, mins, kinds, flags, offsets };
}

function buildFallback(ctx, root) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0xb5b0a6, roughness: 0.74, metalness: 0.08 });
  const count = 2100;
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const obj = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const gx = i % 42, gz = Math.floor(i / 42);
    const x = -9200 + gx * 440 + (hash(i + 8) - 0.5) * 170;
    const z = -7600 + gz * 440 + (hash(i + 29) - 0.5) * 170;
    const h = 6 + Math.pow(hash(i + 88), 2.2) * (Math.hypot(x + 6200, z - 5000) < 2200 ? 170 : 55);
    const w = 65 + hash(i + 147) * 110, d = 60 + hash(i + 261) * 100;
    obj.position.set(x, ctx.terrain.heightAt(x, z) + h / 2, z);
    obj.scale.set(w, h, d); obj.rotation.y = hash(i + 412) * Math.PI; obj.updateMatrix(); mesh.setMatrixAt(i, obj.matrix);
    const c = new THREE.Color().setHSL(0.08 + hash(i + 512) * 0.11, 0.06 + hash(i + 618) * 0.08, 0.47 + hash(i + 716) * 0.2);
    mesh.setColorAt(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  return [{ visible: true, x: 0, z: 0, fallback: true }];
}

export default {
  id: 'buildings',
  name: '城市建筑与玻璃幕墙',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '西安城市建筑'; ctx.scene.add(root);
    const parsed = parseBinary(ctx.data.buildings);
    if (!parsed) {
      const chunks = buildFallback(ctx, root);
      return {
        setQuality(q) { this.drawDistance = q.buildingDistance || 18000; },
        setLayer(layer, visible) { if (layer === 'buildings') root.visible = visible; },
        update() {}, dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
      };
    }
    const names = ctx.data.buildingNames || {};
    const skyline = ctx.data.skyline?.features || [];
    skylineMatch.index = new Map();
    for (const f of skyline) {
      if (!skylineMatch.index.has(f.n)) skylineMatch.index.set(f.n, []);
      skylineMatch.index.get(f.n).push([f.x, f.z]);
    }
    const chunks = new Map();
    let windowCount = 0, landmarkCount = 0;
    const maxWindows = 78000;
    for (let i = 0; i < parsed.count; i++) {
      const count = parsed.counts[i], start = parsed.starts[i];
      if (count < 3 || count > 240) continue;
      const x = parsed.anchorsX[i], z = parsed.anchorsZ[i];
      const name = names[String(i)] || '';
      const isSkyline = (parsed.flags[i] & 8) !== 0 || skylineMatch(name, x, z, i);
      if (isSkyline) continue; // 实测高层由 skyline 模块以完整幕墙与轮廓渲染。
      const item = chunkFor(chunks, x, z);
      const points = new Array(count * 2);
      for (let j = 0; j < count; j++) {
        points[j * 2] = x + parsed.offsets[(start + j) * 2] / 10;
        points[j * 2 + 1] = z + parsed.offsets[(start + j) * 2 + 1] / 10;
      }
      const ground = ctx.terrain.heightAt(x, z), height = parsed.heights[i] / 10, minHeight = parsed.mins[i] / 10;
      appendBuilding(item, points, ground, height, parsed.kinds[i], i, minHeight);
      if (height >= 18 && Math.hypot(x, z) < 13500 && windowCount < maxWindows) {
        const before = item.windows.length;
        addWindows(item, points, ground + minHeight, height, maxWindows - windowCount);
        windowCount += item.windows.length - before;
      }
      if (name && Math.hypot(x, z) < 24000 && landmarkCount < 360) {
        if (height > 24 || /钟楼|鼓楼|大明宫|博物馆|机场|大厦|广场|电视塔|中心|酒店/.test(name)) {
          ctx.labels.add(name, new THREE.Vector3(x, ground + height + 3, z), { category: 'landmark', minDist: 90, maxDist: 9500, priority: height > 80 ? 2.4 : 0.7 });
          landmarkCount++;
        }
      }
    }

    const buildingMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.12, side: THREE.DoubleSide });
    const windowMat = new THREE.MeshPhysicalMaterial({ color: 0x536e80, metalness: 0.52, roughness: 0.17, clearcoat: 0.78, emissive: 0x26394a, emissiveIntensity: 0.03, side: THREE.DoubleSide });
    ctx.night.register(windowMat, { day: 0.03, night: 1.35, curve: 1.05 });
    const chunksList = [];
    for (const chunk of chunks.values()) {
      if (!chunk.count) continue;
      const group = new THREE.Group(); group.name = `建筑区块 ${chunk.key}`;
      group.position.set(chunk.cx, 0, chunk.cz);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(chunk.positions, 3));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(chunk.colors, 3));
      geom.setIndex(chunk.indices); geom.computeVertexNormals(); geom.computeBoundingSphere();
      const mesh = new THREE.Mesh(geom, buildingMat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = true; group.add(mesh);
      if (chunk.windows.length) {
        const win = new THREE.InstancedMesh(new THREE.BoxGeometry(1.35, 1.45, 0.075), windowMat, chunk.windows.length);
        const dummy = new THREE.Object3D();
        chunk.windows.forEach((w, j) => {
          dummy.position.set(w.x - chunk.cx, w.y, w.z - chunk.cz); dummy.rotation.set(0, w.yaw, 0);
          dummy.scale.set(w.w / 1.35, w.h / 1.45, 1); dummy.updateMatrix(); win.setMatrixAt(j, dummy.matrix);
        });
        win.instanceMatrix.needsUpdate = true; win.castShadow = false; win.receiveShadow = false; group.add(win);
      }
      root.add(group);
      chunksList.push({ group, x: chunk.cx + CHUNK / 2, z: chunk.cz + CHUNK / 2 });
      chunk.positions.length = chunk.colors.length = chunk.indices.length = chunk.windows.length = 0;
    }
    const q = ctx.quality;
    let drawDistance = q.buildingDistance || 18000;
    let layerVisible = true, frame = 0;
    return {
      setQuality(next) { drawDistance = Math.max(5000, next.buildingDistance || 18000); },
      setLayer(layer, visible) { if (layer === 'buildings') { layerVisible = visible; root.visible = visible; } },
      update() {
        if (++frame % 15) return;
        const p = ctx.camera.position;
        for (const c of chunksList) c.group.visible = layerVisible && Math.hypot(p.x - c.x, p.z - c.z) < drawDistance + 4500;
      },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
      stats: { count: parsed.count, windows: windowCount, labels: landmarkCount },
    };
  },
};
