import * as THREE from 'three';
import { addBox, addCylinder, mergeStaticChildren } from './shared.js';

const temp = new THREE.Object3D();

function roofMesh(width, depth, baseY, rise, material, overhang = 2.5) {
  const hw = width / 2 + overhang, hd = depth / 2 + overhang;
  const ex = hw * 0.33;
  const eaves = [
    [-hw, baseY, -hd], [hw, baseY, -hd], [hw, baseY, hd], [-hw, baseY, hd],
  ];
  const ridge = [[-ex, baseY + rise, 0], [ex, baseY + rise, 0]];
  const faces = [
    [eaves[0], eaves[1], ridge[1], ridge[0]],
    [eaves[1], eaves[2], ridge[1]],
    [eaves[2], eaves[3], ridge[0], ridge[1]],
    [eaves[3], eaves[0], ridge[0]],
  ];
  const p = [];
  for (const face of faces) {
    if (face.length === 3) p.push(...face[0], ...face[1], ...face[2]);
    else p.push(...face[0], ...face[1], ...face[2], ...face[0], ...face[2], ...face[3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addEaveTrim(group, width, depth, y, overhang, mat, thickness = 0.36) {
  const w = width + overhang * 2, d = depth + overhang * 2;
  addBox(group, [w, thickness, thickness], [0, y, -d / 2], mat);
  addBox(group, [w, thickness, thickness], [0, y, d / 2], mat);
  addBox(group, [thickness, thickness, d], [-w / 2, y, 0], mat);
  addBox(group, [thickness, thickness, d], [w / 2, y, 0], mat);
}

function makeWindowRows(group, width, depth, y, floors, cols, material, glowMat) {
  const countPerSide = cols * floors;
  const paneGeo = new THREE.BoxGeometry(Math.min(1.65, width / (cols * 2.2)), 1.25, 0.1);
  const panes = new THREE.InstancedMesh(paneGeo, glowMat, countPerSide * 4);
  const mullionGeo = new THREE.BoxGeometry(0.065, 1.28, 0.07);
  const mullions = new THREE.InstancedMesh(mullionGeo, material, countPerSide * 8);
  let pi = 0, mi = 0;
  const positions = [];
  for (const side of [-1, 1]) {
    const isFront = Math.abs(side) > 0;
    for (let row = 0; row < floors; row++) {
      const yy = y + 2.4 + row * 3.2;
      for (let i = 0; i < cols; i++) {
        const u = (i + 0.5) / cols;
        if (isFront) {
          positions.push({ x: -width / 2 + u * width, z: side * depth / 2, y: yy, rot: 0 });
        } else {
          positions.push({ x: side * width / 2, z: -depth / 2 + u * depth, y: yy, rot: Math.PI / 2 });
        }
      }
    }
  }
  // 正面、背面、两侧都放窄窗；窗框与格心通过细木条做成重复实例。
  for (const face of positions) {
    temp.position.set(face.x, face.y, face.z);
    temp.rotation.set(0, face.rot, 0);
    temp.updateMatrix();
    panes.setMatrixAt(pi++, temp.matrix);
    for (const off of [-0.43, 0, 0.43]) {
      temp.position.set(face.x + Math.cos(face.rot) * off, face.y, face.z - Math.sin(face.rot) * off);
      temp.rotation.set(0, face.rot, 0);
      temp.updateMatrix();
      mullions.setMatrixAt(mi++, temp.matrix);
    }
  }
  panes.count = pi;
  mullions.count = mi;
  panes.instanceMatrix.needsUpdate = true;
  mullions.instanceMatrix.needsUpdate = true;
  panes.castShadow = false;
  group.add(panes, mullions);
}

/** 一座多层唐风楼阁：柱网、隔扇、梁枋、重檐、鸱吻与发光匾额。单位为米。 */
export function buildTimberTower(ctx, group, options = {}) {
  const {
    width = 34, depth = 30, height = 28, floors = 3, name = '长安楼',
    roof = 'roofGreenGlazed', base = 'wallBrick', trim = 'lacquerRed',
    signText = name, signY = 8, roofOverhang = 3.2, roofRise = 4.6,
    podium = 1.2, tierScale = 0.85, columnRadius = 0.38,
  } = options;
  const stone = ctx.mats.get('marble');
  const masonry = ctx.mats.get(base);
  const roofMat = ctx.mats.get(roof);
  const wood = ctx.mats.get(trim);
  const gold = ctx.mats.get('gold');
  const caihua = ctx.mats.get('caihua');
  const lattice = ctx.mats.get('latticeRed');
  const paper = ctx.mats.get('paperWindow');

  addBox(group, [width + 10, 0.45, depth + 10], [0, 0.25, 0], stone);
  addBox(group, [width + 7, podium, depth + 7], [0, 0.95, 0], stone);
  addBox(group, [width + 4, 0.32, depth + 4], [0, 1.6, 0], masonry);
  const startY = 1.75;
  const storey = Math.max(2.6, (height - podium - floors * roofRise * 0.44) / floors);
  let fw = width, fd = depth, y = startY;
  for (let level = 0; level < floors; level++) {
    const taper = level ? Math.pow(tierScale, level) : 1;
    fw = width * taper;
    fd = depth * taper;
    const bodyH = storey * (level === floors - 1 ? 0.86 : 1);
    const floorBottom = y;
    const floorTop = y + bodyH;
    addBox(group, [fw, 0.36, fd], [0, floorBottom + 0.18, 0], wood);
    addBox(group, [fw, 0.28, fd], [0, floorTop - 0.14, 0], wood);
    // 四面青磚牆基與連續彩畫梁枋。
    const wallH = bodyH * 0.62;
    addBox(group, [fw * 0.86, wallH, 0.38], [0, floorBottom + 0.42 + wallH / 2, -fd / 2 + 0.19], masonry);
    addBox(group, [fw * 0.86, wallH, 0.38], [0, floorBottom + 0.42 + wallH / 2, fd / 2 - 0.19], masonry);
    addBox(group, [0.38, wallH, fd * 0.84], [-fw / 2 + 0.19, floorBottom + 0.42 + wallH / 2, 0], masonry);
    addBox(group, [0.38, wallH, fd * 0.84], [fw / 2 - 0.19, floorBottom + 0.42 + wallH / 2, 0], masonry);
    addBox(group, [fw, 0.44, 0.62], [0, floorBottom + 0.4 + wallH, -fd / 2], caihua);
    addBox(group, [fw, 0.44, 0.62], [0, floorBottom + 0.4 + wallH, fd / 2], caihua);
    addBox(group, [0.62, 0.44, fd], [-fw / 2, floorBottom + 0.4 + wallH, 0], caihua);
    addBox(group, [0.62, 0.44, fd], [fw / 2, floorBottom + 0.4 + wallH, 0], caihua);

    const columns = [];
    const nx = Math.max(3, Math.floor(fw / 5));
    const nz = Math.max(3, Math.floor(fd / 5));
    for (let i = 0; i <= nx; i++) {
      const x = -fw / 2 + (fw * i) / nx;
      columns.push([x, -fd / 2], [x, fd / 2]);
    }
    for (let i = 1; i < nz; i++) {
      const z = -fd / 2 + (fd * i) / nz;
      columns.push([-fw / 2, z], [fw / 2, z]);
    }
    const postGeo = new THREE.CylinderGeometry(columnRadius, columnRadius * 1.12, bodyH, 8);
    const posts = new THREE.InstancedMesh(postGeo, wood, columns.length);
    for (let i = 0; i < columns.length; i++) {
      temp.position.set(columns[i][0], floorBottom + bodyH / 2, columns[i][1]);
      temp.rotation.set(0, 0, 0); temp.updateMatrix(); posts.setMatrixAt(i, temp.matrix);
    }
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    group.add(posts);
    // 隔扇窗格：棂条材质用双面 PBR alpha 贴图，昼夜灯光从纸窗透出。
    const paneMat = paper.clone();
    paneMat.color.set(0x7c4a2a);
    paneMat.roughness = 0.78;
    ctx.night.register(paneMat, { day: 0.02, night: 1.8, curve: 1.15 });
    const latticeMat = lattice;
    const windows = [];
    const cols = Math.max(2, Math.floor(fw / 5.4));
    for (const side of [-1, 1]) for (let i = 0; i < cols; i++) {
      const x = -fw / 2 + (i + 0.5) * fw / cols;
      windows.push([x, floorBottom + 0.6 + wallH * 0.47, side * (fd / 2 + 0.015), 0]);
    }
    const rows = Math.max(2, Math.floor(fd / 5.4));
    for (const side of [-1, 1]) for (let i = 0; i < rows; i++) {
      const z = -fd / 2 + (i + 0.5) * fd / rows;
      windows.push([side * (fw / 2 + 0.015), floorBottom + 0.6 + wallH * 0.47, z, Math.PI / 2]);
    }
    const winGeo = new THREE.PlaneGeometry(Math.min(3.1, fw / cols * 0.73), Math.min(3.2, wallH * 0.62));
    const panes = new THREE.InstancedMesh(winGeo, paneMat, windows.length);
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, Math.min(3.2, wallH * 0.62), 0.12), wood, windows.length * 3);
    let bi = 0;
    for (let i = 0; i < windows.length; i++) {
      const [x, wy, z, rot] = windows[i];
      temp.position.set(x, wy, z); temp.rotation.set(0, rot, 0); temp.updateMatrix(); panes.setMatrixAt(i, temp.matrix);
      for (const off of [-0.55, 0, 0.55]) {
        temp.position.set(x + Math.cos(rot) * off, wy, z - Math.sin(rot) * off);
        temp.rotation.set(0, rot, 0); temp.updateMatrix(); bars.setMatrixAt(bi++, temp.matrix);
      }
    }
    panes.instanceMatrix.needsUpdate = true; bars.count = bi; bars.instanceMatrix.needsUpdate = true;
    panes.castShadow = false; bars.castShadow = false;
    group.add(panes, bars);

    const ow = Math.max(7, roofOverhang * (1.2 - level * 0.05));
    const roofY = floorTop + 0.38;
    addEaveTrim(group, fw, fd, roofY, ow, wood, 0.55);
    const rm = roofMesh(fw, fd, roofY, roofRise * (1 - level * 0.06), roofMat, ow);
    group.add(rm);
    // 正脊、垂脊与两端的金色鸱吻。
    addBox(group, [fw * 0.64, 0.58, 0.7], [0, roofY + roofRise, 0], gold);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (fw / 2 + ow * 0.82), z = sz * (fd / 2 + ow * 0.82);
      addCylinder(group, 0.16, 0.25, 1.05, [x, roofY + 0.45, z], gold, 7);
    }
    y = roofY + roofRise + 0.12;
  }

  // 屋脊宝顶、葫芦形刹杆与避雷饰件。
  addCylinder(group, 0.32, 0.55, 1.25, [0, y + 0.6, 0], gold, 12);
  addCylinder(group, 0.12, 0.18, 1.5, [0, y + 1.8, 0], gold, 10);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 9), gold);
  finial.position.set(0, y + 2.6, 0); group.add(finial);

  if (signText) {
    const sign = ctx.sign(signText, { height: 1.35, color: '#f4d88e', bg: '#6d2118', border: '#d8ad62', borderWidth: 0.08, size: 100, padding: 0.42, serif: true, emissive: 1.25 });
    sign.position.set(0, signY, depth / 2 + 0.35);
    group.add(sign);
  }
  mergeStaticChildren(group, `${name}-楼体合批`);
  return { top: y + 2.8, width, depth, height };
}

/** 高墙式城门塔：门洞留空，两侧敦台承托二层楼与重檐。 */
export function buildGatehouse(ctx, group, options = {}) {
  const { width = 52, depth = 30, height = 24, name = '城门', main = false } = options;
  const brick = ctx.mats.get('wallBrick');
  const trim = ctx.mats.get('lacquerRed');
  const roof = ctx.mats.get(main ? 'roofYellowGlazed' : 'roofGray');
  const stone = ctx.mats.get('marble');
  const gold = ctx.mats.get('gold');
  const gateW = main ? width * 0.38 : width * 0.32;
  const pierW = (width - gateW - 3) / 2;
  const pierH = height * 0.58;
  for (const side of [-1, 1]) {
    const x = side * (gateW / 2 + 1.5 + pierW / 2);
    addBox(group, [pierW, pierH, depth], [x, pierH / 2, 0], brick);
    addBox(group, [pierW + 1.3, 0.9, depth + 1.5], [x, pierH + 0.35, 0], stone);
    // 檐下暗红承檩，三组雀替托出翼角。
    addBox(group, [pierW + 4, 0.7, depth + 5], [x, pierH + 1.0, 0], trim);
  }
  const passageTop = new THREE.Mesh(new THREE.BoxGeometry(gateW + 2.5, 1.3, depth + 2.4), stone);
  passageTop.position.set(0, pierH - 0.65, 0); passageTop.castShadow = true; group.add(passageTop);
  const upperW = width * 0.94, upperD = depth * 0.9, upperH = height - pierH - 4.2;
  addBox(group, [upperW, upperH, upperD], [0, pierH + 1.3 + upperH / 2, 0], brick);
  const windows = [];
  const columns = 7;
  for (const zside of [-1, 1]) for (let i = 0; i < columns; i++) windows.push([-upperW / 2 + (i + 0.5) * upperW / columns, zside * (upperD / 2 + 0.08), 0]);
  const geo = new THREE.BoxGeometry(1.5, 2.4, 0.12);
  const wm = ctx.mats.get('paperWindow');
  const wins = new THREE.InstancedMesh(geo, wm, windows.length);
  for (let i = 0; i < windows.length; i++) { temp.position.set(windows[i][0], pierH + 2.6 + upperH * 0.44, windows[i][1]); temp.rotation.set(0, windows[i][2], 0); temp.updateMatrix(); wins.setMatrixAt(i, temp.matrix); }
  wins.instanceMatrix.needsUpdate = true; group.add(wins);
  const roofY = height - 2.0;
  addEaveTrim(group, upperW, upperD, roofY, 4.8, trim, 0.65);
  group.add(roofMesh(upperW, upperD, roofY, main ? 6.3 : 5.2, roof, 4.8));
  addBox(group, [upperW * 0.72, 0.45, 0.6], [0, roofY + (main ? 6.3 : 5.2), 0], gold);
  for (const x of [-upperW / 2 - 3.8, upperW / 2 + 3.8]) {
    addCylinder(group, 0.2, 0.24, 1.15, [x, roofY + 0.5, 0], gold, 8);
  }
  const plaque = ctx.sign(name, { height: 1.65, color: '#f4d691', bg: main ? '#7c1f14' : '#473628', border: '#d6ae66', borderWidth: 0.07, size: 98, serif: true, emissive: 0.8 });
  plaque.position.set(0, pierH + 1.6 + upperH * 0.72, upperD / 2 + 0.24);
  group.add(plaque);

  // 城门通道内壁、石券线脚和穿行的深色门洞。
  addBox(group, [gateW, pierH * 0.75, 0.65], [0, pierH * 0.4, -depth / 2 + 0.32], brick);
  addBox(group, [gateW, pierH * 0.75, 0.65], [0, pierH * 0.4, depth / 2 - 0.32], brick);
  addBox(group, [gateW - 1.4, 0.4, 0.45], [0, pierH * 0.78, -depth / 2 + 0.4], stone);
  addBox(group, [gateW - 1.4, 0.4, 0.45], [0, pierH * 0.78, depth / 2 - 0.4], stone);
  mergeStaticChildren(group, `${name}-城门合批`);
  return { top: roofY + (main ? 6.3 : 5.2) + 1 };
}
