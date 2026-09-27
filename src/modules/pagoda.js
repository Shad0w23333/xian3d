// 大雁塔 · 大慈恩寺 · 北广场音乐喷泉 · 南广场玄奘像
//
// 平面位置以 OSM 与 Esri 卫星影像（research/refs/pagoda/sat_*.png，世界坐标网格叠加）核对：
//   · 大雁塔塔心 (1572, 4589)，台基 45.7(东西) × 48.7(南北) m，高 4.2 m；通高 64.5 m（详见 src/arch/pagoda-tower.js）
//   · 大慈恩寺中轴 x = 1572：山门 z≈4777 → 钟楼(东)/鼓楼(西) z≈4710 → 大雄宝殿 z≈4662 → 法堂 z≈4633 → 大雁塔 →
//     玄奘三藏院（塔北，z≈4465~4540；正殿大遍觉堂，东光明堂、西般若堂，唐风回廊）；寺域约 x 1492~1656、z 4455~4782
//   · 东西配殿为两列长厢房（x≈1547 / 1597，z≈4617~4668），明清灰瓦硬山
//   · 北广场：寺北 z 4098~4450，中轴喷泉：北端音乐水池 z 4148~4192 + 八级叠水池 z 4194~4410 + 南端跌水
//   · 南广场：玄奘像 (1572, 4850)，面南正对大唐不夜城
// 地坪：寺院台地约 423.6 m，北广场约 418.8 m（DEM 实测，寺北坡坎 4.8 m 用跌水与台阶过渡）。
import * as THREE from 'three';
import { ArchBuilder, floodlit, hall, multiStoreyTower, corridor, yardWall, lantern, getKit, stats } from '../arch/chinese.js';
import { dayanta, dayantaLights } from '../arch/pagoda-tower.js';
import { buildFountain } from '../arch/pagoda-fountain.js';
import { xuanzangStatue, tangLampPost, bronzeGroup, censer } from '../arch/pagoda-figures.js';
import { Batcher } from '../core/util.js';

const CX = 1572, TZ = 4589; // 塔心（寺院局部原点）
const H_T = 423.6; // 寺院台地
const H_N = 418.8; // 北广场
const H_S = 423.5; // 南广场
const STATUE = [1572, 4850];
const FOUNTAIN_C = [1571, 4278];

const rect = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

// —— 大慈恩寺（寺院局部坐标：x 东，z 南，原点塔心） ——
function templeFn(b) {
  const gray = 'gray';
  // 山门（三门：三券洞，歇山灰瓦，红墙）
  b.push(0, 0, 188, 0);
  hall(b, { bays: 3, bayW: 5.0, centerW: 5.6, depthBays: 2, depthW: 4.4, colH: 5.0, roof: 'xieshan', front: ['arch', 'arch', 'arch'], back: ['arch', 'arch', 'arch'], sides: 'wall', platformH: 0.9, steps: 'frontback', plaque: '大慈恩寺', plaqueVertical: false, lanterns: true, roofColor: gray, wallColor: 0x9a3a2b });
  b.pop();
  // 钟楼（东）、鼓楼（西）
  for (const sx of [-1, 1]) {
    b.push(sx * 22, 0, 121, 0);
    multiStoreyTower(b, { floors: 2, bays: 3, depthBays: 3, bayW: 2.8, colH: 3.3, roof: 'xieshan', platformH: 1.4, steps: 'front', roofColor: gray, plaque: sx < 0 ? '鼓楼' : '钟楼' });
    b.pop();
  }
  // 大雄宝殿
  b.push(0, 0, 74, 0);
  hall(b, { bays: 5, bayW: 4.8, centerW: 5.4, depthBays: 4, depthW: 4.0, colH: 5.4, roof: 'xieshan', platformH: 1.5, railing: true, stepsYulu: 1.4, plaque: '大雄宝殿', front: 'center3', lanterns: true, roofColor: gray });
  b.pop();
  censer(b, 0, 0, 93);
  // 法堂
  b.push(0, 0, 45, 0);
  hall(b, { bays: 5, bayW: 4.2, centerW: 4.6, depthBays: 3, depthW: 3.5, colH: 4.4, roof: 'xieshan', platformH: 0.9, plaque: '法堂', front: 'center3', roofColor: gray });
  b.pop();
  // 东西配殿（长厢房，面向中庭）
  for (const sx of [-1, 1]) {
    b.push(sx * 25.5, 0, 55, sx < 0 ? Math.PI / 2 : -Math.PI / 2);
    hall(b, { bays: 11, bayW: 4.3, depthBays: 2, depthW: 4.0, colH: 3.8, roof: 'yingshan', platformH: 0.6, front: 'center3', back: 'wall', sides: 'wall', roofColor: gray });
    b.pop();
  }
  // 玄奘三藏院（唐风，灰瓦）
  b.push(0, 0, -100, 0);
  hall(b, { style: 'tang', bays: 7, bayW: 4.5, centerW: 5.2, depthBays: 4, depthW: 4.3, colH: 5.2, eaves: 2, roof: 'xieshan', platformH: 1.3, railing: true, plaque: '大遍觉堂', roofColor: gray });
  b.pop();
  for (const sx of [-1, 1]) {
    b.push(sx * 33, 0, -92, sx < 0 ? Math.PI / 2 : -Math.PI / 2);
    hall(b, { style: 'tang', bays: 5, bayW: 4.0, depthBays: 3, depthW: 3.6, colH: 4.2, roof: 'xieshan', platformH: 0.9, plaque: sx < 0 ? '般若堂' : '光明堂', roofColor: gray });
    b.pop();
  }
  b.push(0, 0, -54, 0);
  hall(b, { style: 'tang', bays: 3, bayW: 4.4, depthBays: 2, depthW: 3.6, colH: 4.2, roof: 'xieshan', front: 'gate', back: 'gate', sides: 'wall', platformH: 0.8, steps: 'frontback', plaque: '玄奘三藏院', roofColor: gray });
  b.pop();
  corridor(b, [[-8.5, -54], [-46, -54], [-46, -124], [46, -124], [46, -54], [8.5, -54]], { style: 'tang', w: 3.2, colH: 3.2 });
  // 寺院围墙（红墙灰瓦帽），山门与北门处留口
  const wall = { h: 3.6, t: 0.7, color: 0x9a3a2b };
  yardWall(b, [[-11, 188], [-80, 188], [-80, -133], [-7, -133]], wall);
  yardWall(b, [[7, -133], [84, -133], [84, 188], [11, 188]], wall);
  // 中轴灯笼
  for (const z of [100, 112, 140, 160]) for (const sx of [-1, 1]) lantern(b, sx * 7, 3.2, z, { kind: 'palace' });
}

// —— 北广场、南广场小品 ——
function plazaFn(b, yN, yS) {
  // 北广场：水池两侧灯柱、外侧灯柱
  for (let z = 4150; z <= 4400; z += 20)
    for (const sx of [-1, 1]) tangLampPost(b, FOUNTAIN_C[0] + sx * 36 - CX, yN, z - TZ);
  for (let z = 4115; z <= 4405; z += 29)
    for (const sx of [-1, 1]) tangLampPost(b, FOUNTAIN_C[0] + sx * 80 - CX, yN, z - TZ);
  // 唐诗园林铜雕群
  let seed = 1;
  for (const z of [4175, 4235, 4300, 4365])
    for (const sx of [-1, 1]) {
      b.push(FOUNTAIN_C[0] + sx * 58 - CX, yN, z - TZ, sx * Math.PI / 2);
      bronzeGroup(b, 2 + (seed % 3), seed++);
      b.pop();
    }
  // 北入口广场群雕
  for (let i = 0; i < 6; i++) {
    const x = FOUNTAIN_C[0] - 75 + i * 30;
    b.push(x - CX, yN, 4122 - TZ, Math.PI);
    bronzeGroup(b, 3, 20 + i);
    b.pop();
  }
  // 南广场灯柱
  for (let z = 4800; z <= 4940; z += 20)
    for (const sx of [-1, 1]) tangLampPost(b, sx * 26, yS, z - TZ);
}

/** 平铺地面（米制 UV 的薄板，合批为一个网格） */
function paving(batch, mat, x0, z0, x1, z1, y, t = 0.12) {
  const g = new THREE.BoxGeometry(x1 - x0, t, z1 - z0);
  g.translate((x0 + x1) / 2, y - t / 2, (z0 + z1) / 2);
  batch.add(g, mat, null, { worldUV: 1 });
}

export default {
  id: 'pagoda',
  name: '大雁塔与大慈恩寺',
  prepare(ctx) {
    const T = ctx.terrain;
    T.addFlatten({ points: rect(1488, 4454, 1660, 4786), height: H_T, feather: 14 });
    T.addFlatten({ points: rect(1478, 4096, 1666, 4410), height: H_N, feather: 18 });
    T.addFlatten({ points: rect(1500, 4786, 1645, 4944), height: H_S, feather: 16 });
    const E = ctx.exclusions;
    // 大雁塔台基与塔院
    E.add({ points: rect(CX - 42, TZ - 48, CX + 42, TZ + 36), name: '大雁塔' }, { buildings: true, trees: true });
    // 寺院中轴殿宇
    E.add({ points: rect(CX - 32, TZ + 34, CX + 32, TZ + 200), name: '大慈恩寺中轴' }, { buildings: true, trees: false });
    E.add({ points: rect(CX - 14, TZ + 40, CX + 14, TZ + 200), name: '大慈恩寺甬道' }, { buildings: true, trees: true });
    // 玄奘三藏院
    E.add({ points: rect(CX - 50, TZ - 128, CX + 50, TZ - 49), name: '玄奘三藏院' }, { buildings: true, trees: true });
    // 围墙线（两侧窄带）
    E.add({ points: rect(CX - 82, TZ - 135, CX - 78, TZ + 190) }, { buildings: true, trees: true });
    E.add({ points: rect(CX + 82, TZ - 135, CX + 86, TZ + 190) }, { buildings: true, trees: true });
    // 北广场中央（水池与铺装）
    E.add({ points: rect(1486, 4098, 1658, 4454), name: '北广场' }, { buildings: true, trees: false });
    E.add({ points: rect(1528, 4100, 1614, 4454), name: '喷泉' }, { buildings: true, trees: true });
    // 南广场
    E.add({ points: rect(1505, 4788, 1640, 4946), name: '南广场' }, { buildings: true, trees: false });
    E.add({ circle: [STATUE[0], STATUE[1], 18], name: '玄奘像' }, { buildings: true, trees: true });
    E.add({ points: rect(1544, 4786, 1600, 4946) }, { buildings: true, trees: true });
  },

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '大慈恩寺与大雁塔';
    ctx.scene.add(root);
    const kit = getKit(ctx);

    // ───── 大雁塔 ─────
    const pwin = new THREE.MeshStandardMaterial({ color: 0x241c16, roughness: 0.95, emissive: 0xffa04a, emissiveIntensity: 0 });
    pwin.name = 'pagodaInterior';
    ctx.night.register(pwin, { day: 0, night: 1.35 });
    const flood = { color: 0xffb35c, strength: 2.1, baseY: H_T, height: 72, top: 0.55, upDim: 0.55, ctx };
    const brickF = floodlit(kit.mat('brick').clone(), flood);
    const stoneF = floodlit(kit.mat('stone').clone(), flood);
    const towerMats = { brick: brickF, stone: stoneF, pwin };
    const lodT = new THREE.LOD();
    let tInfo = null;
    for (const [det, dist] of [[2, 0], [0, 900]]) {
      const b = new ArchBuilder(ctx, { detail: det, name: '大雁塔' });
      const inf = dayanta(b);
      if (det >= 1) dayantaLights(b, inf);
      tInfo = tInfo || inf;
      const g = b.build({ materials: towerMats, name: '大雁塔' + det });
      lodT.addLevel(g, dist);
    }
    lodT.position.set(CX, H_T, TZ);
    lodT.name = '大雁塔';
    root.add(lodT);

    // ───── 大慈恩寺殿宇 ─────
    const templeFlood = { color: 0xffc27a, strength: 1.25, baseY: H_T, height: 16, top: 0.35 };
    const lodS = new THREE.LOD();
    for (const [det, dist] of [[2, 0], [0, 650]]) {
      const b = new ArchBuilder(ctx, { detail: det, name: '大慈恩寺', instancing: true });
      templeFn(b);
      lodS.addLevel(b.build({ flood: templeFlood, name: '大慈恩寺' + det }), dist);
    }
    lodS.position.set(CX, H_T, TZ);
    root.add(lodS);

    // ───── 广场小品 + 玄奘像 ─────
    const pb = new ArchBuilder(ctx, { detail: 2, name: '广场小品', instancing: true });
    plazaFn(pb, H_N - H_T + 0.06, H_S - H_T + 0.06);
    const plaza = pb.build({ name: '广场小品' });
    plaza.position.set(CX, H_T, TZ);
    root.add(plaza);
    const sb = new ArchBuilder(ctx, { detail: 2, name: '玄奘像' });
    sb.push(0, 0, 0, 0);
    const st = xuanzangStatue(sb);
    sb.pop();
    const statueFlood = { color: 0xffcf96, strength: 1.6, baseY: H_S, height: 12, top: 0.5, upDim: 0.2 };
    const statue = sb.build({ flood: statueFlood, name: '玄奘像' });
    statue.position.set(STATUE[0], H_S + 0.06, STATUE[1]);
    root.add(statue);

    // ───── 铺装地坪 ─────
    const batch = new Batcher();
    const pave = ctx.mats.get('stonePaving');
    const marble = ctx.mats.get('marble');
    // 塔院与中轴甬道
    paving(batch, pave, CX - 40, TZ - 46, CX + 40, TZ + 36, H_T + 0.06);
    paving(batch, pave, CX - 8, TZ + 36, CX + 8, TZ + 196, H_T + 0.05);
    paving(batch, pave, CX - 20, TZ + 84, CX + 20, TZ + 104, H_T + 0.055);
    paving(batch, pave, CX - 44, TZ - 122, CX + 44, TZ - 56, H_T + 0.05);
    // 北广场：中央铺装、入口广场、东西向步道
    paving(batch, pave, 1530, 4100, 1612, 4412, H_N + 0.06);
    paving(batch, pave, 1486, 4098, 1656, 4146, H_N + 0.055);
    for (const z of [4262, 4412]) paving(batch, pave, 1486, z, 1656, z + 12, H_N + 0.05);
    // 南广场
    paving(batch, pave, 1540, 4786, 1604, 4946, H_S + 0.06);
    paving(batch, pave, 1506, 4832, 1638, 4868, H_S + 0.055);

    // ───── 北广场喷泉水池（音乐水池 + 八级叠水 + 南端跌水） ─────
    const pools = [];
    const nP = 8, pz0 = 4194, pz1 = 4410, step = 0.2;
    for (let i = 0; i < nP; i++) {
      const z0 = pz0 + ((pz1 - pz0) * i) / nP, z1 = pz0 + ((pz1 - pz0) * (i + 1)) / nP;
      pools.push({ z0: z0 + 0.8, z1: z1 - 0.8, w: 56, y: H_N + 0.3 + step * (nP - i) * 0.5 + (i === nP - 1 ? 0 : 0) });
    }
    // 北低南高：由北向南逐级升高
    pools.forEach((p, i) => (p.y = H_N + 0.3 + step * (i + 1)));
    const front = { z0: 4148, z1: 4192, w: 64, y: H_N + 0.3 };
    const all = [front, ...pools];
    const rimH = 0.18;
    for (const p of all) {
      const x0 = FOUNTAIN_C[0] - p.w / 2, x1 = FOUNTAIN_C[0] + p.w / 2, c = 0.7;
      const top = p.y + rimH, bot = H_N;
      const box = (a, b, cc, d) => {
        const g = new THREE.BoxGeometry(b - a, top - bot, d - cc);
        g.translate((a + b) / 2, (top + bot) / 2, (cc + d) / 2);
        batch.add(g, marble, null, { worldUV: 1 });
      };
      box(x0 - c, x1 + c, p.z0 - c, p.z0);
      box(x0 - c, x1 + c, p.z1, p.z1 + c);
      box(x0 - c, x0, p.z0, p.z1);
      box(x1, x1 + c, p.z0, p.z1);
      // 池底（暗色，微透）
      const fl = new THREE.BoxGeometry(p.w, 0.1, p.z1 - p.z0);
      fl.translate(FOUNTAIN_C[0], p.y - 0.45, (p.z0 + p.z1) / 2);
      batch.add(fl, ctx.mats.get('wallBrickDark'), null, { worldUV: 1 });
    }
    // 南端跌水台阶（北广场 → 寺院台地）：水阶 + 两侧石阶
    const casc = [];
    const cz0 = 4412, cz1 = 4452, nC = 8;
    const yTop = H_T - 0.5, yBot = pools[pools.length - 1].y + 0.3;
    for (let k = 0; k < nC; k++) {
      const z0 = cz1 - ((cz1 - cz0) * (k + 1)) / nC, z1 = cz1 - ((cz1 - cz0) * k) / nC;
      const y = yTop - ((yTop - yBot) * k) / (nC - 1);
      casc.push({ z0, z1, y });
      const g = new THREE.BoxGeometry(44, y - H_N, z1 - z0);
      g.translate(FOUNTAIN_C[0], (y + H_N) / 2 - 0.12, (z0 + z1) / 2);
      batch.add(g, marble, null, { worldUV: 1 });
      for (const sx of [-1, 1]) {
        const sgeo = new THREE.BoxGeometry(22, y + 0.25 - H_N, z1 - z0);
        sgeo.translate(FOUNTAIN_C[0] + sx * 33, (y + 0.25 + H_N) / 2, (z0 + z1) / 2);
        batch.add(sgeo, pave, null, { worldUV: 1 });
      }
    }
    const ground = batch.build({ castShadow: false, receiveShadow: true, name: '铺装与水池' });
    root.add(ground);

    // 跌水水面（与喷泉共用水材质）+ 水帘
    const fountain = buildFountain(ctx, { cx: FOUNTAIN_C[0], front, pools });
    root.add(fountain.group);
    {
      const wm = fountain.group.getObjectByName('fountainWater').material;
      const geos = [];
      const sheetMat = new THREE.MeshStandardMaterial({ color: 0xdfe8ec, roughness: 0.25, transparent: true, opacity: 0.72, emissive: 0x9fd0ff, emissiveIntensity: 0 });
      ctx.night.register(sheetMat, { day: 0.05, night: 1.4 });
      const sheets = [];
      for (const c of casc) {
        const g = new THREE.PlaneGeometry(40, c.z1 - c.z0);
        g.rotateX(-Math.PI / 2);
        g.translate(FOUNTAIN_C[0], c.y + 0.02, (c.z0 + c.z1) / 2);
        geos.push(g);
      }
      // 各级水池之间与跌水前沿的白色水帘
      const edges = [...all.map((p) => [p.z0, p.y, p.w]), ...casc.map((c) => [c.z0, c.y, 40])];
      for (const [z, y, w] of edges) {
        const g = new THREE.PlaneGeometry(w - 2, Math.max(0.25, y - H_N + 0.1));
        g.translate(FOUNTAIN_C[0], (y + H_N) / 2 + 0.05, z - 0.72);
        g.rotateY(0);
        sheets.push(g);
      }
      const cm = new THREE.Mesh(mergeGeos(geos), wm);
      cm.receiveShadow = true;
      root.add(cm);
      const sm = new THREE.Mesh(mergeGeos(sheets), sheetMat);
      sm.name = 'waterSheets';
      root.add(sm);
    }

    // ───── 灯光与标注 ─────
    const top = H_T + tInfo.top;
    const L = ctx.lights;
    L.add({ position: new THREE.Vector3(CX, H_T + 22, TZ + 38), color: 0xffb060, intensity: 2600, distance: 120, nightOnly: true, priority: 3 });
    L.add({ position: new THREE.Vector3(CX, H_T + 22, TZ - 38), color: 0xffb060, intensity: 2200, distance: 110, nightOnly: true, priority: 2.6 });
    L.add({ position: new THREE.Vector3(FOUNTAIN_C[0], H_N + 8, 4170), color: 0x9fc4ff, intensity: 1800, distance: 90, nightOnly: true, priority: 2.2 });
    L.add({ position: new THREE.Vector3(FOUNTAIN_C[0], H_N + 6, 4320), color: 0xd0a0ff, intensity: 1400, distance: 80, nightOnly: true, priority: 2 });
    L.add({ position: new THREE.Vector3(STATUE[0], H_S + 3, STATUE[1] + 9), color: 0xffd6a0, intensity: 600, distance: 35, nightOnly: true, priority: 2.2 });
    L.add({ position: new THREE.Vector3(CX, H_T + 6, TZ + 96), color: 0xffc27a, intensity: 500, distance: 40, nightOnly: true, priority: 1.6 });
    ctx.labels.add('大雁塔', new THREE.Vector3(CX, top + 8, TZ), { category: 'landmark', minDist: 60, maxDist: 25000, priority: 5 });
    ctx.labels.add('大慈恩寺', new THREE.Vector3(CX, H_T + 16, TZ + 188), { category: 'landmark', minDist: 80, maxDist: 6000, priority: 3 });
    ctx.labels.add('大雁塔北广场', new THREE.Vector3(FOUNTAIN_C[0], H_N + 18, FOUNTAIN_C[1]), { category: 'landmark', minDist: 120, maxDist: 8000, priority: 3 });
    ctx.labels.add('玄奘像', new THREE.Vector3(STATUE[0], H_S + 14, STATUE[1]), { category: 'landmark', minDist: 40, maxDist: 2500, priority: 2 });

    const ms = performance.now() - t0;
    const s1 = stats(root);
    console.info(`[pagoda] 构建 ${ms.toFixed(0)} ms，网格 ${s1.meshes}，三角形 ${s1.tris}，喷头 ${fountain.jetCount}`);

    const camP = new THREE.Vector3();
    const fc = new THREE.Vector3(FOUNTAIN_C[0], H_N, FOUNTAIN_C[1]);
    return {
      update(dt, t) {
        camP.copy(ctx.camera.position);
        const d = camP.distanceTo(fc);
        fountain.update(ctx.uniforms.uTime.value, d);
        plaza.visible = d < 3000;
      },
      setLayer(layer, visible) {
        if (layer === 'landmarks') root.visible = visible;
      },
      setQuality(q) {},
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};

function mergeGeos(geos) {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    P.set(g.attributes.position.array, o * 3);
    N.set(g.attributes.normal.array, o * 3);
    U.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(P, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  m.computeBoundingSphere();
  return m;
}
