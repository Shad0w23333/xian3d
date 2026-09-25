import * as THREE from 'three';

function hash(n) {
  let x = (n + 0x9e3779b9) | 0;
  x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15; x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

function pathOf(feature, id) {
  const p = feature.p;
  const pts = [];
  let length = 0;
  for (let i = 2; i < p.length; i += 2) {
    const x = p[i], z = p[i + 1];
    if (pts.length) length += Math.hypot(x - pts.at(-1).x, z - pts.at(-1).z);
    pts.push({ x, z, s: length });
  }
  return pts.length > 1 && length > 60 ? { id, pts, length, feature } : null;
}

function pointAt(path, distance) {
  const pts = path.pts;
  let lo = 1, hi = pts.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (pts[m].s < distance) lo = m + 1; else hi = m;
  }
  const a = pts[lo - 1], b = pts[lo];
  const t = THREE.MathUtils.clamp((distance - a.s) / Math.max(1e-3, b.s - a.s), 0, 1);
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * t, z: a.z + dz * t, dx: dx / len, dz: dz / len };
}

export default {
  id: 'traffic',
  name: '道路交通流',
  async build(ctx) {
    const root = new THREE.Group();
    root.name = '城市动态车流';
    ctx.scene.add(root);
    const roads = ctx.data.roads?.features || [];
    const paths = [];
    for (let i = 0; i < roads.length; i++) {
      const f = roads[i];
      if (f.c > 7 || f.t || (f.c > 4 && f.w < 5)) continue;
      const path = pathOf(f, i);
      if (path) paths.push(path);
    }
    const cumulative = [];
    let totalLen = 0;
    for (const p of paths) { totalLen += p.length; cumulative.push(totalLen); }
    totalLen ||= 1;
    const random = (i) => hash(i * 7919 + 181);
    const cars = [];
    const maxCars = Math.min(1800, Math.max(320, Math.round(totalLen / 600)));
    for (let i = 0; i < maxCars; i++) {
      const pick = random(i) * totalLen;
      let lo = 0, hi = cumulative.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < pick) lo = mid + 1; else hi = mid; }
      const path = paths[lo];
      if (!path) continue;
      const reverse = random(i + 3) < 0.5 && !path.feature.o;
      const lane = (random(i + 17) - 0.5) * Math.min(path.feature.w * 0.54, 7.0);
      cars.push({ path, s: random(i + 33) * path.length, speed: 5 + random(i + 71) * 13, lane, reverse, color: random(i + 99) });
    }
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.36, metalness: 0.32 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x253947, roughness: 0.12, metalness: 0.25, clearcoat: 0.9 });
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff1cd, emissive: 0xffc872, emissiveIntensity: 0, roughness: 0.38 });
    ctx.night.register(lightMat, { day: 0.05, night: 2.2 });
    const shell = new THREE.InstancedMesh(new THREE.BoxGeometry(1.95, 1.25, 4.6), bodyMat, cars.length);
    const cabin = new THREE.InstancedMesh(new THREE.BoxGeometry(1.52, 0.95, 2.35), glassMat, cars.length);
    const headlights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.22, 0.12), lightMat, cars.length * 2);
    const colors = [0xe9e0cd, 0x9b2f26, 0x263a4a, 0x777b80, 0x987243, 0xc5cbd0, 0x253334, 0x467b77];
    for (let i = 0; i < cars.length; i++) {
      const c = new THREE.Color(colors[Math.floor(cars[i].color * colors.length)]);
      shell.setColorAt(i, c);
    }
    shell.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cabin.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    headlights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(shell, cabin, headlights);
    const q = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
    const basis = new THREE.Matrix4(), up = new THREE.Vector3(0, 1, 0), forward = new THREE.Vector3();
    const tmp = new THREE.Object3D();
    let density = ctx.quality.trafficDensity ?? 1;
    let layerEnabled = true;
    let frame = 0;
    const updateCars = (dt, elapsed) => {
      if (!layerEnabled) return;
      frame++;
      const active = Math.min(cars.length, Math.round(300 + (cars.length - 300) * Math.min(1.4, density)));
      for (let i = 0; i < active; i++) {
        const car = cars[i];
        const distance = ((car.s + elapsed * car.speed) % car.path.length + car.path.length) % car.path.length;
        const sample = pointAt(car.path, car.reverse ? car.path.length - distance : distance);
        const dx = car.reverse ? -sample.dx : sample.dx, dz = car.reverse ? -sample.dz : sample.dz;
        const nx = -dz, nz = dx;
        const x = sample.x + nx * car.lane, z = sample.z + nz * car.lane;
        const y = ctx.terrain.heightAt(x, z) + 0.95;
        const yaw = Math.atan2(dx, dz);
        q.setFromAxisAngle(up, yaw);
        pos.set(x, y, z);
        tmp.position.copy(pos); tmp.quaternion.copy(q); tmp.scale.set(1, 1, 1); tmp.updateMatrix(); shell.setMatrixAt(i, tmp.matrix);
        tmp.position.set(x, y + 0.72, z); tmp.quaternion.copy(q); tmp.scale.set(1, 1, 1); tmp.updateMatrix(); cabin.setMatrixAt(i, tmp.matrix);
        // 车头局部 +Z；前灯在车体两侧，和昼夜材质联动。
        for (let j = 0; j < 2; j++) {
          const side = j ? 1 : -1;
          forward.set(dx, 0, dz);
          pos.set(x + forward.x * 2.2 + nx * side * 0.62, y + 0.3, z + forward.z * 2.2 + nz * side * 0.62);
          tmp.position.copy(pos); tmp.quaternion.copy(q); tmp.updateMatrix(); headlights.setMatrixAt(i * 2 + j, tmp.matrix);
        }
      }
      shell.count = active; cabin.count = active; headlights.count = active * 2;
      shell.instanceMatrix.needsUpdate = true; cabin.instanceMatrix.needsUpdate = true; headlights.instanceMatrix.needsUpdate = true;
      if (shell.instanceColor) shell.instanceColor.needsUpdate = true;
    };

    // 少量航班在咸阳机场附近做缓慢巡航，作为可见的机场动态交通符号。
    const aircraft = [];
    const aMat = new THREE.MeshStandardMaterial({ color: 0xd9dfe0, roughness: 0.43, metalness: 0.42 });
    const planeGeo = new THREE.ConeGeometry(1.0, 7.2, 8);
    planeGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.Group();
      const fuselage = new THREE.Mesh(planeGeo, aMat);
      plane.add(fuselage);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(15, 0.25, 2.4), aMat); wing.position.y = 0.1; plane.add(wing);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.25, 1.5), aMat); tail.position.set(0, 0.6, -2.5); plane.add(tail);
      root.add(plane);
      aircraft.push({ plane, phase: i * 2.1 });
    }
    const airport = ctx.geo.project(108.752, 34.447);
    const updatePlanes = (t) => {
      for (const [i, a] of aircraft.entries()) {
        const ang = t * 0.035 + a.phase;
        const r = 6500 + i * 1400;
        a.plane.position.set(airport.x + Math.cos(ang) * r, ctx.terrain.heightAt(airport.x, airport.z) + 1050 + i * 180, airport.z + Math.sin(ang) * r);
        a.plane.rotation.y = -ang + Math.PI / 2;
      }
    };
    return {
      update(dt, elapsed) { updateCars(dt, elapsed); updatePlanes(elapsed); },
      setQuality(q) { density = q.trafficDensity ?? 1; },
      setLayer(layer, visible) { if (layer === 'traffic') { layerEnabled = visible; root.visible = visible; } },
      dispose() { shell.geometry.dispose(); cabin.geometry.dispose(); headlights.geometry.dispose(); planeGeo.dispose(); ctx.scene.remove(root); },
      count: cars.length,
    };
  },
};
