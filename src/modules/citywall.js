import * as THREE from 'three';
import { buildGatehouse } from '../arch/traditional.js';
import { makeRibbonGeometry } from '../arch/shared.js';

function dist2(ax, az, bx, bz) { return (ax - bx) ** 2 + (az - bz) ** 2; }

function wallMesh(ctx, points, gates, width, height) {
  const positions = [], uvs = [], indices = [];
  const stations = [];
  let chainage = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    const tx = dx / l, tz = dz / l;
    if (stations.length) chainage += Math.hypot(p[0] - stations.at(-1).x, p[1] - stations.at(-1).z);
    const nx = -tz, nz = tx;
    stations.push({ x: p[0], z: p[1], tx, tz, nx, nz, s: chainage });
  }
  const n = stations.length;
  for (let i = 0; i < n; i++) {
    const a = stations[i], b = stations[(i + 1) % n];
    const nearGate = gates.some((g) => dist2((a.x + b.x) / 2, (a.z + b.z) / 2, g.world.x, g.world.z) < 34 ** 2);
    if (nearGate) continue;
    const alx = a.x + a.nx * width / 2, alz = a.z + a.nz * width / 2;
    const arx = a.x - a.nx * width / 2, arz = a.z - a.nz * width / 2;
    const blx = b.x + b.nx * width / 2, blz = b.z + b.nz * width / 2;
    const brx = b.x - b.nx * width / 2, brz = b.z - b.nz * width / 2;
    const yAL = ctx.terrain.heightAt(alx, alz), yAR = ctx.terrain.heightAt(arx, arz);
    const yBL = ctx.terrain.heightAt(blx, blz), yBR = ctx.terrain.heightAt(brx, brz);
    const quad = (verts, u0, u1, v0, v1) => {
      const k = positions.length / 3;
      positions.push(...verts.flat());
      uvs.push(u0, v0, u0, v1, u1, v0, u1, v1);
      indices.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
    };
    // 外牆與內牆的獨立面片，頂面可見夯土砌磚的寬厚截面。
    quad([[alx, yAL, alz], [alx, yAL + height, alz], [blx, yBL, blz], [blx, yBL + height, blz]], a.s, b.s, 0, height);
    quad([[brx, yBR, brz], [brx, yBR + height, brz], [arx, yAR, arz], [arx, yAR + height, arz]], a.s, b.s, 0, height);
    quad([[alx, yAL + height, alz], [arx, yAR + height, arz], [blx, yBL + height, blz], [brx, yBR + height, brz]], a.s, b.s, 0, width);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices); g.computeVertexNormals();
  return { geometry: g, stations };
}

function nearestTangent(points, x, z) {
  let best = Infinity, tangent = [1, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const d = dist2(x, z, a[0], a[1]);
    if (d < best) { best = d; const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; tangent = [dx / l, dz / l]; }
  }
  return tangent;
}

function offsetLine(points, distance) {
  return points.map((p, i) => {
    const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    return [p[0] - dz / l * distance, p[1] + dx / l * distance];
  }).flat();
}

export default {
  id: 'citywall',
  name: '西安明城墙与十八城门',
  prepare(ctx) {
    // 城墙严格沿 DEM 原始地面建造，不对城内地面做整体拉平。
    void ctx;
  },
  async build(ctx) {
    const data = ctx.data.landmarks || {};
    const points = data.wall || [];
    if (points.length < 8) return {};
    const gates = data.gates || [];
    const root = new THREE.Group(); root.name = '西安城墙'; ctx.scene.add(root);
    const [geom, stations] = (() => { const x = wallMesh(ctx, points, gates, 16, 12.2); return [x.geometry, x.stations]; })();
    const brick = ctx.mats.clone('wallBrick', { side: THREE.DoubleSide });
    const main = new THREE.Mesh(geom, brick); main.castShadow = true; main.receiveShadow = true; root.add(main);
    // 砖石压顶、垛口和垂直马面：实例化后仍只有少数绘制批次。
    const merlonMat = ctx.mats.get('wallBrickDark');
    const merlonGeo = new THREE.BoxGeometry(2.1, 1.45, 1.6);
    const gatePoints = gates.map((g) => [g.world.x, g.world.z]);
    const valid = stations.filter((p, i) => i % 2 === 0 && gatePoints.every((g) => dist2(p.x, p.z, g[0], g[1]) > 38 ** 2));
    const merlons = new THREE.InstancedMesh(merlonGeo, merlonMat, valid.length);
    const dummy = new THREE.Object3D();
    valid.forEach((p, i) => {
      const x = p.x + p.nx * 4.2, z = p.z + p.nz * 4.2;
      dummy.position.set(x, ctx.terrain.heightAt(x, z) + 12.8, z);
      dummy.rotation.set(0, Math.atan2(-p.tz, p.tx), 0); dummy.updateMatrix(); merlons.setMatrixAt(i, dummy.matrix);
    });
    merlons.instanceMatrix.needsUpdate = true; merlons.castShadow = true; root.add(merlons);

    const mamian = data.mamian || [];
    const bastionGeo = new THREE.BoxGeometry(21.5, 9.3, 37);
    const bastions = new THREE.InstancedMesh(bastionGeo, brick, mamian.length);
    mamian.forEach((m, i) => {
      const [x, z] = m.center_on_centerline;
      const [tx, tz] = nearestTangent(points, x, z);
      const nx = -tz, nz = tx, off = Number(m.projection_beyond_face_m) || 11;
      const cx = x + nx * off * 0.36, cz = z + nz * off * 0.36;
      dummy.position.set(cx, ctx.terrain.heightAt(cx, cz) + 4.65, cz);
      dummy.rotation.set(0, Math.atan2(-tz, tx), 0); dummy.updateMatrix(); bastions.setMatrixAt(i, dummy.matrix);
    });
    bastions.instanceMatrix.needsUpdate = true; bastions.castShadow = true; root.add(bastions);

    // 护城河沿外墙连续绕行，低位水面与地形 DTM 对齐。
    const moatMat = new THREE.MeshPhysicalMaterial({ color: 0x4d7481, roughness: 0.18, metalness: 0.28, clearcoat: 0.9, transparent: true, opacity: 0.86 });
    ctx.overlay(moatMat, 0.00012);
    const moat = makeRibbonGeometry(ctx, offsetLine(points, 27), 9.5, -1.4, 14);
    if (moat) { const water = new THREE.Mesh(moat, moatMat); water.name = '城墙护城河'; water.receiveShadow = false; root.add(water); }

    const majorIds = new Set(['yongning', 'anyuan', 'changle', 'anding', 'chaoyang']);
    const byGate = new Map();
    for (const gate of gates) {
      const wx = gate.world?.x ?? gate.osm_node_world?.[0], wz = gate.world?.z ?? gate.osm_node_world?.[1];
      if (!Number.isFinite(wx) || !Number.isFinite(wz)) continue;
      const tangent = gate.wall_tangent || nearestTangent(points, wx, wz);
      const group = new THREE.Group();
      group.name = `${gate.name}城楼`;
      group.position.set(wx, ctx.terrain.heightAt(wx, wz), wz);
      group.rotation.y = Math.atan2(-tangent[1], tangent[0]);
      root.add(group);
      const major = majorIds.has(gate.id);
      buildGatehouse(ctx, group, { width: major ? 60 : 45, depth: major ? 35 : 29, height: major ? 27 : 21, name: gate.name, main: major });
      byGate.set(gate.id, group);
      ctx.labels.add(gate.name, new THREE.Vector3(wx, group.position.y + (major ? 38 : 30), wz), { category: 'landmark', minDist: 100, maxDist: 18000, priority: major ? 3 : 1.1 });
      if (major) {
        ctx.lights.add({ position: new THREE.Vector3(wx, group.position.y + 17, wz), color: 0xffbb67, intensity: 1100, distance: 140, nightOnly: true, priority: 2.4 });
      }
    }
    ctx.labels.add('西安明城墙 · 13.7 km', new THREE.Vector3(0, ctx.terrain.heightAt(0, -1850) + 48, -1850), { category: 'landmark', minDist: 600, maxDist: 15000, priority: 2.5 });
    return {
      setLayer(layer, visible) { if (layer === 'citywall') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
      gateCount: byGate.size,
    };
  },
};
