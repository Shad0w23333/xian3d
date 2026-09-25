import * as THREE from 'three';
import { Batcher, circlePoly, toShape, worldBoxUV } from '../core/util.js';

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export function addBox(parent, size, pos, material, opts = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  if (opts.rotation) mesh.rotation.set(...opts.rotation);
  mesh.castShadow = opts.castShadow !== false;
  mesh.receiveShadow = opts.receiveShadow !== false;
  parent.add(mesh);
  return mesh;
}

export function addCylinder(parent, radiusTop, radiusBottom, height, pos, material, segments = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function addShape(parent, points, y, material, holes = []) {
  if (!points || points.length < 6) return null;
  const geometry = new THREE.ShapeGeometry(toShape(points, holes), 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function latLonGroup(ctx, lon, lat, name = '') {
  const p = ctx.geo.project(lon, lat);
  const g = new THREE.Group();
  g.name = name;
  g.position.set(p.x, ctx.terrain.heightAt(p.x, p.z), p.z);
  ctx.scene.add(g);
  return g;
}

export function addLabel(ctx, text, group, y, options = {}) {
  ctx.labels.add(text, new THREE.Vector3(group.position.x, group.position.y + y, group.position.z), options);
}

export function localLine(points, y = 0) {
  const v = [];
  for (let i = 0; i < points.length; i += 2) v.push(points[i], y, points[i + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

export function addLine(parent, points, y, material) {
  if (points.length < 4) return null;
  const mesh = new THREE.Line(localLine(points, y), material);
  parent.add(mesh);
  return mesh;
}

export function addGroundRibbon(ctx, parent, points, width, yLift, material, sample = 12) {
  const verts = [];
  const indices = [];
  let len = 0;
  let prev = null;
  const samples = [];
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2], az = points[i - 1], bx = points[i], bz = points[i + 1];
    const d = Math.hypot(bx - ax, bz - az);
    if (d < 1) continue;
    const n = Math.max(1, Math.ceil(d / sample));
    for (let j = i === 2 ? 0 : 1; j <= n; j++) {
      const t = j / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (prev) len += Math.hypot(x - prev.x, z - prev.z);
      samples.push({ x, z, s: len });
      prev = { x, z };
    }
  }
  if (samples.length < 2) return null;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l, nz = dx / l;
    for (const side of [-1, 1]) {
      const x = p.x + nx * width * side * 0.5, z = p.z + nz * width * side * 0.5;
      verts.push(x, ctx.terrain.heightAt(x, z) + yLift, z);
    }
    if (i) {
      const j = i * 2;
      indices.push(j - 2, j - 1, j, j - 1, j + 1, j);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, material);
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function addMultiPathRibbon(ctx, parent, features, widthFor, material, options = {}) {
  const batch = new Batcher();
  let count = 0;
  for (const f of features || []) {
    const points = f.p || f.points;
    if (!points || points.length < 4) continue;
    const g = makeRibbonGeometry(ctx, points, widthFor(f), options.lift ?? 0.25, options.step ?? 16);
    if (!g) continue;
    batch.add(g, material);
    count++;
  }
  if (!count) return null;
  const group = batch.build({ name: options.name || 'ribbon-batch', castShadow: false, receiveShadow: true });
  parent.add(group);
  return group;
}

export function makeRibbonGeometry(ctx, points, width, lift = 0.25, step = 16) {
  const samples = [];
  let dist = 0;
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2], az = points[i - 1], bx = points[i], bz = points[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1) continue;
    const n = Math.max(1, Math.ceil(L / step));
    for (let j = i === 2 ? 0 : 1; j <= n; j++) {
      const t = j / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (samples.length) dist += Math.hypot(x - samples.at(-1).x, z - samples.at(-1).z);
      samples.push({ x, z, s: dist });
    }
  }
  if (samples.length < 2) return null;
  const pos = new Float32Array(samples.length * 6), uv = new Float32Array(samples.length * 4), idx = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i], a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l, nz = dx / l;
    for (let s = 0; s < 2; s++) {
      const sign = s ? -1 : 1, x = p.x + nx * width * 0.5 * sign, z = p.z + nz * width * 0.5 * sign;
      pos.set([x, ctx.terrain.heightAt(x, z) + lift, z], (i * 2 + s) * 3);
      uv.set([s, p.s / 20], (i * 2 + s) * 2);
    }
    if (i) {
      const k = i * 2;
      idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function addPolylineTube(parent, points, y, radius, material, radialSegments = 5) {
  const path = [];
  for (let i = 0; i < points.length; i += 2) path.push(new THREE.Vector3(points[i], y, points[i + 1]));
  if (path.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal', 0.15);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, path.length * 2), radius, radialSegments, false), material);
  parent.add(mesh);
  return mesh;
}

export function addStreetLamp(ctx, parent, x, z, height = 7, color = 0xffc77a) {
  const y = ctx.terrain.heightAt(x, z);
  const poleMat = ctx.mats.get('metalGray');
  const lampMat = ctx.mats.get('lampWarm');
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.15, height, 8), poleMat);
  pole.position.set(x, y + height / 2, z);
  parent.add(pole);
  addBox(parent, [1.2, 0.18, 0.25], [x, y + height - 0.05, z], lampMat);
  ctx.lights.add({ position: new THREE.Vector3(x, y + height, z), color, intensity: 180, distance: 28, nightOnly: true, priority: 1.1 });
}

export function addLantern(ctx, parent, x, z, y, scale = 1, hue = 0xffc254) {
  const m = new THREE.MeshStandardMaterial({ color: 0xd84626, emissive: hue, emissiveIntensity: 0, roughness: 0.45, metalness: 0.05 });
  ctx.night.register(m, { day: 0.02, night: 3.8 });
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.48 * scale, 12, 10), m);
  body.scale.y = 1.3;
  g.add(body);
  const capMat = ctx.mats.get('gold');
  addCylinder(g, 0.28 * scale, 0.34 * scale, 0.11 * scale, [0, 0.55 * scale, 0], capMat, 8);
  addCylinder(g, 0.05 * scale, 0.05 * scale, 0.33 * scale, [0, -0.76 * scale, 0], capMat, 6);
  if (scale > 0.8) {
    const world = g.getWorldPosition(new THREE.Vector3());
    ctx.lights.add({ position: world, color: hue, intensity: 95, distance: 16, nightOnly: true, priority: 1.4 });
  }
  return g;
}

export function pointsBounds(points) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
    minZ = Math.min(minZ, points[i + 1]); maxZ = Math.max(maxZ, points[i + 1]);
  }
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, width: maxX - minX, depth: maxZ - minZ };
}

export function rectLoop(cx, cz, w, d, rot = 0) {
  const hw = w / 2, hd = d / 2, c = Math.cos(rot), s = Math.sin(rot);
  return [-hw, -hd, hw, -hd, hw, hd, -hw, hd].reduce((a, _, i, arr) => {
    if (i % 2) return a;
    const x = arr[i], z = arr[i + 1];
    a.push(cx + x * c + z * s, cz - x * s + z * c);
    return a;
  }, []);
}

export function boxGeometryWithWorldUV(width, height, depth, uvScale = 1) {
  const g = new THREE.BoxGeometry(width, height, depth);
  return worldBoxUV(g, uvScale);
}

export function makeMaterial(color, roughness = 0.8, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, ...opts });
}

export function circlePoints(x, z, radius, n = 24) { return circlePoly(x, z, radius, n); }

export function shapeFromPoly(parent, points, y, material) { return addShape(parent, points, y, material); }

export function addPbrLight(ctx, position, color, intensity, distance, priority = 1) {
  return ctx.lights.add({ position, color, intensity, distance, nightOnly: true, priority });
}

/** 合并父级下静态且不透明的小网格，保留实例网格、发光标牌与透明窗片。 */
export function mergeStaticChildren(parent, name = 'architecture-batch') {
  const batch = new Batcher();
  const remove = [];
  parent.updateMatrix();
  for (const child of [...parent.children]) {
    if (!child.isMesh || child.isInstancedMesh || child.userData.keepSeparate) continue;
    const mat = child.material;
    if (!mat || Array.isArray(mat) || mat.transparent || mat.alphaTest > 0 || mat.depthWrite === false || mat.emissiveMap) continue;
    child.updateMatrix();
    batch.add(child.geometry, mat, child.matrix, { worldUV: 1 });
    remove.push(child);
  }
  if (!remove.length) return null;
  const merged = batch.build({ name, castShadow: true, receiveShadow: true });
  for (const child of remove) {
    parent.remove(child);
    child.geometry.dispose();
  }
  parent.add(merged);
  return merged;
}
