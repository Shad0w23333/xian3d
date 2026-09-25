import * as THREE from 'three';
import { Batcher, toShape } from '../core/util.js';
import { addGroundRibbon } from '../arch/shared.js';

function featurePolygon(outer, holes = []) {
  if (!outer || outer.length < 6) return null;
  const g = new THREE.ShapeGeometry(toShape(outer, holes), 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

function airportRunwayLength(p) {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
}

function extrusion(outer, height) {
  const shape = new THREE.Shape();
  for (let i = 0; i < outer.length; i += 2) {
    const x = outer[i], z = outer[i + 1];
    if (!i) shape.moveTo(x, -z); else shape.lineTo(x, -z);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1, steps: 1 });
  g.rotateX(-Math.PI / 2);
  return g;
}

function drawTerminal(ctx, root, f, index) {
  const pts = f.outer || [];
  if (pts.length < 6) return null;
  const n = pts.length / 2;
  let cx = 0, cz = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { cx += pts[i]; cz += pts[i + 1]; minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]); minZ = Math.min(minZ, pts[i + 1]); maxZ = Math.max(maxZ, pts[i + 1]); }
  cx /= n; cz /= n;
  const ground = ctx.terrain.heightAt(cx, cz), h = Math.max(17, Math.min(56, Number(f.h) || 30));
  const m = index % 4 === 0 ? ctx.mats.get('glassBlue') : ctx.mats.get('metalWhite');
  const body = extrusion(pts, h);
  const mesh = new THREE.Mesh(body, m); mesh.position.y = ground; mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = f.n || '航站楼'; root.add(mesh);
  // 大跨屋盖、玻璃幕墙和登机廊桥。
  const width = maxX - minX, depth = maxZ - minZ;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(Math.max(20, width * 0.96), 1.2, Math.max(20, depth * 0.86)), ctx.mats.get('metalWhite'));
  canopy.position.set(cx, ground + h + 0.35, cz); canopy.castShadow = true; root.add(canopy);
  const glassMat = ctx.mats.clone('glassBlue', { color: 0x8fb5c5, roughness: 0.18, metalness: 0.28 });
  const windows = new THREE.InstancedMesh(new THREE.BoxGeometry(6.5, 2.5, 0.24), glassMat, 48);
  const dummy = new THREE.Object3D();
  const zFront = (cz > -18000 ? maxZ : minZ) + (cz > -18000 ? 1 : -1) * 0.8;
  for (let i = 0; i < 48; i++) {
    const x = minX + (i + 0.5) * width / 48;
    dummy.position.set(x, ground + h * 0.42, zFront); dummy.updateMatrix(); windows.setMatrixAt(i, dummy.matrix);
  }
  windows.instanceMatrix.needsUpdate = true; root.add(windows);
  return { cx, cz, minX, maxX, minZ, maxZ, ground, height: h, name: f.n || '航站楼' };
}

export default {
  id: 'airports',
  name: '咸阳、阎良与机场交通',
  async build(ctx) {
    const root = new THREE.Group(); root.name = '西安机场群'; ctx.scene.add(root);
    const data = ctx.data.aeroway || {};
    const asphalt = ctx.mats.clone('asphalt', { color: 0x33383a, roughness: 0.92 });
    const taxi = ctx.mats.clone('asphalt', { color: 0x565853, roughness: 0.91 });
    const apronMat = ctx.mats.clone('concrete', { color: 0x8b8983, roughness: 0.86 });
    ctx.overlay(asphalt, 0.0002); ctx.overlay(taxi, 0.0002); ctx.overlay(apronMat, 0.00015);

    const apronBatch = new Batcher();
    for (const f of data.aprons || []) {
      const g = featurePolygon(f.outer);
      if (!g) continue;
      const y = ctx.terrain.heightAt(f.outer[0], f.outer[1]) + 0.45;
      apronBatch.add(g, apronMat, new THREE.Matrix4().makeTranslation(0, y, 0)); g.dispose();
    }
    const apronGroup = apronBatch.build({ name: '机场停机坪', castShadow: false, receiveShadow: true }); root.add(apronGroup);

    const runwayMarks = [], runways = data.runways || [];
    const lightLocations = [];
    for (const f of runways) {
      if (!f.p || f.p.length < 4) continue;
      const width = Math.max(22, Math.min(85, Number(f.w) || 45));
      addGroundRibbon(ctx, root, f.p, width, 0.75, asphalt, 22);
      const a = [f.p[0], f.p[1]], b = [f.p.at(-2), f.p.at(-1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz) || 1, nx = -dz / length, nz = dx / length;
      const y = ctx.terrain.heightAt(a[0], a[1]) + 0.98;
      runwayMarks.push(a[0], y, a[1], b[0], y, b[1]);
      // 跑道入口的阈值短横线与两侧灯列。
      const bars = Math.max(6, Math.floor(width / 4));
      for (const [ex, ez] of [a, b]) {
        for (let j = 0; j < bars; j++) {
          const side = (j - (bars - 1) / 2) * (width / bars);
          const tx = ex + nx * side, tz = ez + nz * side;
          runwayMarks.push(tx - dx / length * 24, y + 0.03, tz - dz / length * 24, tx + dx / length * 24, y + 0.03, tz + dz / length * 24);
        }
      }
      const number = Math.max(8, Math.floor(airportRunwayLength(f.p) / 45));
      for (let i = 0; i <= number; i++) {
        const t = i / number, x = a[0] + dx * t, z = a[1] + dz * t;
        for (const side of [-1, 1]) lightLocations.push([x + nx * (width * 0.53) * side, z + nz * (width * 0.53) * side, i < 8 || i > number - 8]);
      }
      if (f.ref) {
        const sign = ctx.sign(f.ref, { height: 7, size: 105, bg: '#17221d', border: '#b6a56b', color: '#f1dfac', serif: true, emissive: 0.05 });
        sign.position.set(a[0] + dx * 0.05, y + 0.8, a[1] + dz * 0.05); sign.rotation.y = Math.atan2(-dx, -dz); root.add(sign);
      }
    }
    for (const f of data.taxiways || []) {
      if (f.p?.length >= 4) addGroundRibbon(ctx, root, f.p, Math.max(9, Number(f.w) || 21), 0.7, taxi, 18);
    }
    if (runwayMarks.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(runwayMarks, 3));
      const m = new THREE.LineBasicMaterial({ color: 0xe6e3cf, transparent: true, opacity: 0.94 });
      const lines = new THREE.LineSegments(g, m); lines.name = '跑道中线与入口标记'; root.add(lines);
    }

    const lightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xcfe5ff, emissiveIntensity: 0, roughness: 0.3 });
    ctx.night.register(lightMat, { day: 0, night: 5 });
    const edgeLights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.34, 8, 6), lightMat, lightLocations.length);
    const lightDummy = new THREE.Object3D();
    lightLocations.forEach(([x, z, threshold], i) => {
      const y = ctx.terrain.heightAt(x, z) + 1.2;
      lightDummy.position.set(x, y, z); lightDummy.scale.setScalar(threshold ? 1.25 : 0.72); lightDummy.updateMatrix(); edgeLights.setMatrixAt(i, lightDummy.matrix);
    });
    edgeLights.instanceMatrix.needsUpdate = true; root.add(edgeLights);

    const terminalInfo = [];
    for (const [i, f] of (data.terminals || []).entries()) terminalInfo.push(drawTerminal(ctx, root, f, i));

    // 咸阳机场塔台、航站楼接驳廊桥和停机位线。
    const xiY = ctx.geo.project(108.752, 34.447), xiYGround = ctx.terrain.heightAt(xiY.x, xiY.z);
    const airportFeatures = data.aerodromes || [];
    const mainAirport = airportFeatures.find((a) => a.iata === 'XIY' || a.n?.includes('咸阳'));
    if (mainAirport && (!terminalInfo.length || !terminalInfo.some((t) => t && Math.hypot(t.cx - xiY.x, t.cz - xiY.z) < 7000))) {
      const p = ctx.geo.project(108.752, 34.447), y = ctx.terrain.heightAt(p.x, p.z);
      const terminal = new THREE.Group(); terminal.position.set(p.x, y, p.z); root.add(terminal);
      const main = new THREE.Mesh(new THREE.BoxGeometry(680, 38, 190), ctx.mats.get('glassBlue'));
      main.position.set(0, 19, 140); main.castShadow = true; terminal.add(main);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(250, 27, 240), ctx.mats.get('glassBlue'));
      wing.position.set(0, 14, -15); terminal.add(wing);
      for (let i = -8; i <= 8; i++) {
        const jet = new THREE.Mesh(new THREE.BoxGeometry(3.2, 5, 52), ctx.mats.get('metalWhite'));
        jet.position.set(i * 38, 9, -145); terminal.add(jet);
      }
      terminalInfo.push({ cx: p.x, cz: p.z, minX: p.x - 340, maxX: p.x + 340, minZ: p.z - 160, maxZ: p.z + 235, ground: y, height: 38, name: 'T5航站楼' });
    }
    if (terminalInfo.length) {
      const tower = new THREE.Group(); tower.name = '咸阳机场空管塔台';
      tower.position.set(xiY.x - 520, xiYGround, xiY.z + 480); root.add(tower);
      const concrete = ctx.mats.get('concrete'), glass = ctx.mats.get('glassBlue'), metal = ctx.mats.get('metalGray');
      const stem = new THREE.Mesh(new THREE.BoxGeometry(13, 35, 13), concrete); stem.position.y = 17.5; tower.add(stem);
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(11, 9, 8, 8), glass); cab.position.y = 38; tower.add(cab);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(10.5, 2.5, 8), metal); cap.position.y = 43; tower.add(cap);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.36, 12, 8), metal); mast.position.y = 50; tower.add(mast);
      ctx.labels.add('西安咸阳国际机场 · 空管塔台', new THREE.Vector3(tower.position.x, xiYGround + 58, tower.position.z), { category: 'airport', minDist: 150, maxDist: 18000, priority: 2 });
    }

    // 停机位廊桥与飞机模型：少量 InstancedMesh 保持机场近景丰富而轻量。
    const planeMat = new THREE.MeshStandardMaterial({ color: 0xd6dcdf, roughness: 0.45, metalness: 0.38 });
    const bodyGeo = new THREE.CylinderGeometry(2.2, 2.6, 46, 10); bodyGeo.rotateX(Math.PI / 2);
    const wingGeo = new THREE.BoxGeometry(52, 1.4, 8.2);
    const tailGeo = new THREE.BoxGeometry(15, 1.0, 4.2);
    const planeCount = Math.max(10, Math.min(42, (runways.length + terminalInfo.length) * 3));
    const planes = new THREE.InstancedMesh(bodyGeo, planeMat, planeCount);
    const wings = new THREE.InstancedMesh(wingGeo, planeMat, planeCount);
    const tails = new THREE.InstancedMesh(tailGeo, planeMat, planeCount);
    const dummy = new THREE.Object3D();
    const gateList = data.gates || [];
    const terminals = terminalInfo.filter(Boolean);
    for (let i = 0; i < planeCount; i++) {
      const terminal = terminals[i % Math.max(1, terminals.length)];
      let x, z;
      if (gateList.length) { const gate = gateList[i % gateList.length]; x = gate.x; z = gate.z; }
      else if (terminal) { x = terminal.cx + (i % 8 - 3.5) * 75; z = terminal.minZ - 110 - Math.floor(i / 8) * 90; }
      else { x = xiY.x + (i % 8 - 3.5) * 74; z = xiY.z + Math.floor(i / 8) * 93; }
      const y = ctx.terrain.heightAt(x, z) + 4.0;
      const yaw = (i % 2 ? 1 : -1) * Math.PI / 2;
      dummy.position.set(x, y, z); dummy.rotation.set(0, yaw, 0); dummy.scale.setScalar(0.78 + (i % 4) * 0.06); dummy.updateMatrix(); planes.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, y + 1, z); dummy.rotation.set(0, yaw, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); wings.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, y + 7, z - 15); dummy.rotation.set(0, yaw, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); tails.setMatrixAt(i, dummy.matrix);
    }
    planes.instanceMatrix.needsUpdate = true; wings.instanceMatrix.needsUpdate = true; tails.instanceMatrix.needsUpdate = true;
    root.add(planes, wings, tails);

    const markers = [];
    for (const f of airportFeatures) {
      if (!f.outer || f.outer.length < 6) continue;
      let x = 0, z = 0, n = f.outer.length / 2;
      for (let i = 0; i < f.outer.length; i += 2) { x += f.outer[i]; z += f.outer[i + 1]; }
      x /= n; z /= n;
      const name = f.n || '机场';
      const maxDist = /咸阳/.test(name) ? 52000 : 34000;
      ctx.labels.add(`${name}${f.iata ? ` · ${f.iata}` : ''}`, new THREE.Vector3(x, ctx.terrain.heightAt(x, z) + 110, z), { category: 'airport', minDist: 180, maxDist, priority: 3 });
      markers.push({ x, z, name });
    }
    // 西关机场旧址为城市航空史标记；阎良试飞基地保留独立机场识别。
    const xiguan = ctx.geo.project(108.886, 34.263), yanliang = ctx.geo.project(109.238, 34.645);
    ctx.labels.add('西关机场旧址', new THREE.Vector3(xiguan.x, ctx.terrain.heightAt(xiguan.x, xiguan.z) + 65, xiguan.z), { category: 'airport', minDist: 500, maxDist: 11000, priority: 1.1 });
    if (!markers.some((m) => m.name.includes('阎良'))) ctx.labels.add('阎良机场 · 试飞基地', new THREE.Vector3(yanliang.x, ctx.terrain.heightAt(yanliang.x, yanliang.z) + 85, yanliang.z), { category: 'airport', minDist: 220, maxDist: 38000, priority: 2 });
    const xiYName = '西安咸阳国际机场';
    ctx.labels.add(`${xiYName} XIY · ZLXY`, new THREE.Vector3(xiY.x, xiYGround + 115, xiY.z), { category: 'airport', minDist: 200, maxDist: 55000, priority: 5 });
    return {
      setLayer(layer, visible) { if (layer === 'airports') root.visible = visible; },
      dispose() { root.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); ctx.scene.remove(root); },
      stats: { runways: runways.length, terminals: terminalInfo.length, planes: planeCount },
    };
  },
};
