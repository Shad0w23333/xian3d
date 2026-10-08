// 大雁塔 · 大慈恩寺 · 北广场音乐喷泉 · 南广场玄奘像
//
// 平面位置以 OSM 与 Esri 卫星影像（research/refs/pagoda/sat_*.png，世界坐标网格叠加）核对：
//   · 大雁塔塔心 (1572, 4589)，台基 45.7(东西) × 48.7(南北) m，高 4.2 m；通高 64.5 m（详见 src/arch/pagoda-tower.js）
//   · 大慈恩寺中轴 x = 1572：山门 z≈4777 → 钟楼(东)/鼓楼(西) z≈4710 → 大雄宝殿 z≈4662 → 法堂 z≈4633 → 大雁塔 →
//     玄奘三藏院（塔北，z≈4465~4540；正殿大遍觉堂，东光明堂、西般若堂，唐风回廊）；寺域约 x 1492~1656、z 4455~4782
//   · 东西配殿为两列长厢房（x≈1547 / 1597，z≈4617~4668），明清灰瓦硬山
//   · 北广场：寺北 z 4098~4450，中轴喷泉：北端音乐水池 z 4148~4194 + 八级叠水池 z 4194~4410 + 南端跌水
//     广场由北向南分八级台地抬升（每级 0.45 m，与叠水池同级），台地前沿为通宽踏步，水从每级池沿跌落到下一级；
//     东西两侧为仿唐商业街（两层唐风楼，灰瓦朱柱，按 OSM 足迹分段重建，通用建筑让位）。
//   · 南广场：玄奘像 (1572, 4850)，面南正对大唐不夜城
// 地坪：寺院台地约 423.6 m，北广场北端约 418.8 m（DEM 实测，寺北坡坎 4.8 m 用八级台地 + 南端跌水过渡）。
// 夜景：塔身暖金泛光；北广场以暖白/金色灯光为主，只有音乐喷泉表演（约 12、16、19、21 点各一场）时水柱与水面才变彩色。
import * as THREE from 'three';
import { ArchBuilder, floodlit, hall, multiStoreyTower, corridor, yardWall, lantern, lanternPost, getKit, stats } from '../arch/chinese.js';
import { dayanta, dayantaLights } from '../arch/pagoda-tower.js';
import { buildFountain, showFactor } from '../arch/pagoda-fountain.js';
import { xuanzangStatue, tangLampPost, bronzeGroup, censer } from '../arch/pagoda-figures.js';
import { readBuildings, obb, signedArea, tangFromFootprint } from '../arch/qujiang-gen.js';
import { Batcher } from '../core/util.js';

const CX = 1572, TZ = 4589; // 塔心（寺院局部原点）
const H_T = 423.6; // 寺院台地
const H_N = 418.8; // 北广场
const H_S = 423.5; // 南广场
const STATUE = [1572, 4850];
const FOUNTAIN_C = [1571, 4278];
// 北广场八级台地（与叠水池同级）：北端前场 z<TZ0 为 H_N，第 i 级台地铺装面 = H_N + STEP·(i+1)
const STEP = 0.45, NT = 8, TZ0 = 4194, TZ1 = 4410, TD = (TZ1 - TZ0) / NT;
const PX0 = 1486, PX1 = 1656; // 广场铺装东西边界
const POOL_W = 56, RIM = 0.7;
const tierOf = (z) => (z < TZ0 ? -1 : Math.min(NT - 1, Math.floor((z - TZ0) / TD)));
/** 北广场铺装面绝对高程（台地第 i 级或北端前场） */
const plazaTop = (z) => H_N + 0.06 + STEP * (tierOf(z) + 1);
// 两侧仿唐商业街：OSM 足迹所在范围（西 x 1420~1476，东 x 1660~1716）
const WINGS = [[1420, 4140, 1476, 4432], [1660, 4140, 1716, 4432]];
// 大慈恩寺院墙内（含玄奘三藏院、东西跨院）：通用建筑一律让位（原先方丈院、慈恩图书馆等被画成 4~5 层米色现代楼），
// 院内车行道不画（OSM 的 unclassified 环路实为寺内甬道）；中轴以外的足迹由本模块按原位重建为灰瓦殿堂/亭
const TEMPLE_IN = [1492, 4457, 1654, 4782];
// 中轴殿宇、塔院、三藏院由 templeFn 手工建模（这些范围内的足迹不重复重建）
const TEMPLE_MODELED = [[CX - 33, TZ + 33, CX + 33, TZ + 200], [CX - 43, TZ - 49, CX + 43, TZ + 36], [CX - 50, TZ - 130, CX + 50, TZ - 48]];

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
  // 中轴灯笼：挂在灯笼柱横担上（原先凭空悬在 3.2 m 高处）
  for (const z of [100, 112, 140, 160]) for (const sx of [-1, 1]) lanternPost(b, sx * 7, 0, z, 3.2, { kind: 'palace', yaw: sx > 0 ? Math.PI : 0 });
}

// —— 北广场、南广场小品 ——
function plazaFn(b, yN, yS) {
  // 北广场（台地逐级抬高）：水池两侧灯柱、外侧灯柱；灯柱避开台地前沿踏步（离级线 ≥ 2 m）
  const yAt = (z) => plazaTop(z) - H_T;
  const offStep = (z) => {
    if (z < TZ0 - 2 || z > TZ1 + 2) return z;
    const k = (z - TZ0) / TD, f = k - Math.floor(k);
    return f * TD < 2.5 ? z + 2.5 : f * TD > TD - 2.5 ? z - 2.5 : z;
  };
  for (let z = 4150; z <= 4400; z += 20)
    for (const sx of [-1, 1]) { const zz = offStep(z); tangLampPost(b, FOUNTAIN_C[0] + sx * 36 - CX, yAt(zz), zz - TZ); }
  for (let z = 4115; z <= 4405; z += 29)
    for (const sx of [-1, 1]) { const zz = offStep(z); tangLampPost(b, FOUNTAIN_C[0] + sx * 80 - CX, yAt(zz), zz - TZ); }
  // 唐诗园林铜雕群
  let seed = 1;
  for (const z of [4175, 4235, 4300, 4365])
    for (const sx of [-1, 1]) {
      const zz = offStep(z);
      b.push(FOUNTAIN_C[0] + sx * 58 - CX, yAt(zz), zz - TZ, sx * Math.PI / 2);
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
    // 八级台地：地形压到“下一级台面 − 5 cm”，台地铺装（实体盒）总在地形之上，级间地形斜坡不会从踏步前冒出
    // （羽化 6 m：两侧与商业街之间的地面随台地缓坡过渡；相邻级之间的羽化最高只到“下一级台面 − 5 cm”，仍低于本级铺装）
    for (let i = 0; i < NT; i++) T.addFlatten({ points: rect(1478, TZ0 + TD * i, 1666, TZ0 + TD * (i + 1)), height: H_N + STEP * i - 0.05, feather: 6 });
    T.addFlatten({ points: rect(1478, TZ1, 1666, 4452), height: H_N + STEP * (NT - 1) - 0.05, feather: 1.5 });
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
    // 北广场：园路（OSM footway/pedestrian）不再由道路模块画成深色路面压在铺装上（广场整体由本模块分级铺装）
    E.add({ points: rect(1486, 4098, 1658, 4454), name: '北广场' }, { buildings: true, trees: false, roads: true });
    E.add({ points: rect(1528, 4100, 1614, 4454), name: '喷泉' }, { buildings: true, trees: true });
    E.add({ points: rect(...TEMPLE_IN), name: '大慈恩寺院内' }, { buildings: true, trees: false, roads: true });
    // 两侧仿唐商业街（本模块按 OSM 足迹重建，通用建筑与树让位）
    for (const [x0, z0, x1, z1] of WINGS) E.add({ points: rect(x0, z0, x1, z1), name: '北广场仿唐商业街' }, { buildings: true, trees: true });
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
    // 近景级的斗拱/椽头等实例化小构件不投射阴影：它们本就处在屋檐投下的阴影里，却占阴影通道一半以上的三角形（约 0.65M）
    lodS.levels[0].object.traverse((o) => { if (o.isMesh && /^inst:/.test(o.name)) o.castShadow = false; });
    // 寺内中轴以外的院落建筑（方丈院、跨院、亭）：按 OSM 足迹原位重建
    const extras = templeExtras(ctx, templeFlood);
    if (extras) root.add(extras);

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
    // 北广场：浅灰花岗岩，0.6 m 分格（原先沿用通用铺装：偏青、1 m 以上大块，贴图里的大块暗斑成排重复，像一排阴影）
    const paveN = new THREE.MeshStandardMaterial({ map: plazaPavingTexture(), roughness: 0.82 });
    paveN.name = 'pagoda.plazaPaving';
    // 北广场在 landuse 的公园多边形内：绿地色调层（乘法混合、贴地 +0.25 m、带深度偏移）会把铺装染成青绿色。
    // 铺装放进透明队列（不透明度 1、写深度），在色调层（renderOrder −1）之后绘制，不再被染色
    paveN.transparent = true;
    paveN.depthWrite = true;
    const stepStone = new THREE.MeshStandardMaterial({ color: 0x6c675f, roughness: 0.7 });
    const marble = ctx.mats.get('marble');
    const dark = ctx.mats.get('wallBrickDark');
    // 塔院与中轴甬道
    paving(batch, pave, CX - 40, TZ - 46, CX + 40, TZ + 36, H_T + 0.06);
    paving(batch, pave, CX - 8, TZ + 36, CX + 8, TZ + 196, H_T + 0.05);
    paving(batch, pave, CX - 20, TZ + 84, CX + 20, TZ + 104, H_T + 0.055);
    paving(batch, pave, CX - 44, TZ - 122, CX + 44, TZ - 56, H_T + 0.05);
    // 南广场
    paving(batch, pave, 1540, 4786, 1604, 4946, H_S + 0.06);
    paving(batch, pave, 1506, 4832, 1638, 4868, H_S + 0.055);

    // ───── 北广场：北端前场 + 八级台地 + 叠水池 + 南端跌水 ─────
    const box = (mat, x0, y0, z0, x1, y1, z1, uv = 1) => {
      const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      batch.add(g, mat, null, { worldUV: uv });
    };
    const cxF = FOUNTAIN_C[0], wX0 = cxF - POOL_W / 2, wX1 = cxF + POOL_W / 2, pX0 = wX0 - RIM, pX1 = wX1 + RIM;
    box(paveN, PX0, H_N - 0.1, 4098, PX1, H_N + 0.06, TZ0);
    const tierTop = (i) => H_N + 0.06 + STEP * (i + 1);
    for (let i = 0; i < NT; i++) {
      const z0 = TZ0 + TD * i, z1 = z0 + TD, yT = tierTop(i);
      // 水池两侧通宽台面（实体盒，北沿即 0.45 m 踏步）+ 级线条石
      box(paveN, PX0, H_N - 0.3, z0, pX0, yT, z1);
      box(paveN, pX1, H_N - 0.3, z0, PX1, yT, z1);
      box(stepStone, PX0, yT - 0.5, z0 - 0.02, pX0, yT + 0.02, z0 + 0.4);
      box(stepStone, pX1, yT - 0.5, z0 - 0.02, PX1, yT + 0.02, z0 + 0.4);
    }
    // 音乐水池（北端，凸起池：北、东、西三面池沿；南面是第一级叠水池的池沿立面）
    const front = { z0: 4148, z1: TZ0, w: 64, y: H_N + 0.3 };
    {
      const x0 = cxF - front.w / 2, x1 = cxF + front.w / 2, top = H_N + 0.48;
      box(marble, x0 - RIM, H_N - 0.2, front.z0 - RIM, x1 + RIM, top, front.z0);
      box(marble, x0 - RIM, H_N - 0.2, front.z0, x0, top, front.z1);
      box(marble, x1, H_N - 0.2, front.z0, x1 + RIM, top, front.z1);
      box(dark, x0, H_N - 0.2, front.z0, x1, H_N - 0.12, front.z1);
    }
    // 八级叠水池：每级池面比上一级低 0.45 m，北沿为跌水堰
    const pools = [];
    for (let i = 0; i < NT; i++) {
      const zN = TZ0 + TD * i, zS = zN + TD, yT = tierTop(i), rimTop = yT + 0.14, last = i === NT - 1;
      pools.push({ z0: zN + RIM, z1: last ? zS - RIM : zS, w: POOL_W, y: yT - 0.06, rimTop, zN, zS });
      box(marble, pX0, H_N - 0.3, zN, pX1, rimTop, zN + RIM); // 北沿（堰）
      box(marble, pX0, yT - 0.7, zN + RIM, wX0, rimTop, zS);
      box(marble, wX1, yT - 0.7, zN + RIM, pX1, rimTop, zS);
      if (last) box(marble, pX0, yT - 0.7, zS - RIM, pX1, rimTop, zS);
      box(dark, wX0, yT - 0.62, zN + RIM, wX1, yT - 0.52, last ? zS - RIM : zS);
    }
    // 南端跌水（第八级 → 寺院台地）：中间 44 m 水阶，两侧通宽石阶
    const casc = [];
    const cz0 = TZ1, cz1 = 4452, nC = 8;
    const yTop = H_T + 0.06, yBot = pools[NT - 1].rimTop + 0.12;
    for (let k = 0; k < nC; k++) {
      const z0 = cz1 - ((cz1 - cz0) * (k + 1)) / nC, z1 = cz1 - ((cz1 - cz0) * k) / nC;
      const y = yTop - ((yTop - yBot) * k) / (nC - 1);
      casc.push({ z0, z1, y });
      box(marble, cxF - 22, H_N - 0.3, z0, cxF + 22, y - 0.08, z1);
      box(paveN, PX0, H_N - 0.3, z0, cxF - 22, y, z1);
      box(paveN, cxF + 22, H_N - 0.3, z0, PX1, y, z1);
    }
    const ground = batch.build({ castShadow: false, receiveShadow: true, name: '铺装与水池' });
    root.add(ground);

    // 叠水水面（与喷泉共用水材质）+ 跌水水帘
    const fountain = buildFountain(ctx, { cx: cxF, front, pools });
    root.add(fountain.group);
    const sheetTex = streakTexture();
    {
      const wm = fountain.waterMat;
      const geos = [];
      for (const c of casc) {
        const g = new THREE.PlaneGeometry(42, c.z1 - c.z0 - 0.1);
        g.rotateX(-Math.PI / 2);
        g.translate(cxF, c.y - 0.05, (c.z0 + c.z1) / 2);
        geos.push(g);
      }
      // 水帘：各级池北沿（落入下一级）、第八级南沿内侧（跌水落入第八级）、跌水各阶前沿
      const sheets = [];
      const sheet = (x, w, z, y0, y1) => {
        const h = Math.max(0.12, y1 - y0);
        const g = new THREE.PlaneGeometry(w, h);
        g.translate(x, (y0 + y1) / 2, z);
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 1.6, uv.getY(i) * h / 1.2);
        sheets.push(g);
        // 落水处白沫带（贴水面）
        const f = new THREE.PlaneGeometry(w, 0.9);
        f.rotateX(-Math.PI / 2);
        f.translate(x, y0 + 0.015, z - 0.45);
        const fu = f.attributes.uv;
        for (let i = 0; i < fu.count; i++) fu.setXY(i, fu.getX(i) * w / 1.6, 0.02 + fu.getY(i) * 0.25);
        sheets.push(f);
      };
      pools.forEach((p, i) => sheet(cxF, POOL_W - 1, p.zN - 0.03, i === 0 ? front.y : pools[i - 1].y, p.rimTop + 0.03));
      sheet(cxF, 42, pools[NT - 1].zS - RIM - 0.03, pools[NT - 1].y, yBot - 0.04);
      for (let k = 0; k < nC - 1; k++) sheet(cxF, 42, casc[k].z0 - 0.03, casc[k + 1].y - 0.05, casc[k].y - 0.04);
      const cm = new THREE.Mesh(mergeGeos(geos), wm);
      cm.receiveShadow = true;
      root.add(cm);
      const sheetMat = new THREE.MeshStandardMaterial({ color: 0xf2f7f8, alphaMap: sheetTex, transparent: true, depthWrite: false, roughness: 0.25, emissive: 0xffe6c4, emissiveIntensity: 0, side: THREE.DoubleSide });
      ctx.night.register(sheetMat, { day: 0.03, night: 0.45 });
      const sm = new THREE.Mesh(mergeGeos(sheets), sheetMat);
      sm.name = 'waterSheets';
      sm.castShadow = false;
      sm.renderOrder = 3;
      root.add(sm);
    }

    // ───── 两侧仿唐商业街（OSM 足迹 → 分段两层唐风楼，面向广场） ─────
    const wings = buildWings(ctx);
    if (wings) root.add(wings);

    // ───── 灯光与标注 ─────
    const top = H_T + tInfo.top;
    const L = ctx.lights;
    L.add({ position: new THREE.Vector3(CX, H_T + 22, TZ + 38), color: 0xffb060, intensity: 2600, distance: 120, nightOnly: true, priority: 3 });
    L.add({ position: new THREE.Vector3(CX, H_T + 22, TZ - 38), color: 0xffb060, intensity: 2200, distance: 110, nightOnly: true, priority: 2.6 });
    // 北广场：平时暖白（原先常亮冷蓝/紫色强光 → 整片广场被打成荧光色块）；表演时随水柱变色
    const WARM = new THREE.Color(0xffe0b4);
    const fLights = [
      L.add({ position: new THREE.Vector3(cxF, H_N + 10, 4172), color: WARM, intensity: 380, distance: 70, nightOnly: true, priority: 2.2 }),
      L.add({ position: new THREE.Vector3(cxF, tierTop(4) + 9, 4320), color: WARM, intensity: 320, distance: 70, nightOnly: true, priority: 2 }),
    ];
    L.add({ position: new THREE.Vector3(STATUE[0], H_S + 3, STATUE[1] + 9), color: 0xffd6a0, intensity: 600, distance: 35, nightOnly: true, priority: 2.2 });
    L.add({ position: new THREE.Vector3(CX, H_T + 6, TZ + 96), color: 0xffc27a, intensity: 500, distance: 40, nightOnly: true, priority: 1.6 });
    ctx.labels.add('大雁塔', new THREE.Vector3(CX, top + 8, TZ), { category: 'landmark', minDist: 60, maxDist: 25000, priority: 5 });
    ctx.labels.add('大慈恩寺', new THREE.Vector3(CX, H_T + 16, TZ + 188), { category: 'landmark', minDist: 80, maxDist: 6000, priority: 3 });
    ctx.labels.add('大雁塔北广场', new THREE.Vector3(FOUNTAIN_C[0], H_N + 18, FOUNTAIN_C[1]), { category: 'landmark', minDist: 120, maxDist: 8000, priority: 3 });
    ctx.labels.add('玄奘像', new THREE.Vector3(STATUE[0], H_S + 14, STATUE[1]), { category: 'landmark', minDist: 40, maxDist: 2500, priority: 2 });

    const ms = performance.now() - t0;
    const s1 = stats(root);
    console.info(`[pagoda] 构建 ${ms.toFixed(0)} ms，网格 ${s1.meshes}，三角形 ${s1.tris}，喷头 ${fountain.jetCount}，水花粒子 ${fountain.sprayCount}`);

    const camP = new THREE.Vector3();
    const fc = new THREE.Vector3(FOUNTAIN_C[0], H_N, FOUNTAIN_C[1]);
    let lastSec = 0;
    return {
      update(dt, t) {
        camP.copy(ctx.camera.position);
        const d = camP.distanceTo(fc);
        const show = showFactor(ctx.sky?.hours ?? 12);
        const sec = ctx.uniforms.uTime.value;
        const c = fountain.update(sec, d, show);
        for (const [i, l] of fLights.entries()) {
          l.color.copy(WARM).lerp(c, show);
          l.intensity = (i ? 320 : 380) + 700 * show;
        }
        // 水帘向下流动
        sheetTex.offset.y = (sheetTex.offset.y + (sec - lastSec) * 0.9) % 1;
        lastSec = sec;
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

/** 大慈恩寺中轴以外的院落建筑：按 OSM 足迹原位重建为灰瓦殿堂/亭（不带夜间轮廓灯），正面朝寺院中轴 */
function templeExtras(ctx, flood) {
  const B = readBuildings(ctx.data.buildings);
  if (!B) return null;
  const inR = (x, z, r) => x > r[0] && x < r[2] && z > r[1] && z < r[3];
  const fps = [];
  for (let i = 0; i < B.n; i++) {
    const x = B.ax[i], z = B.az[i];
    if (!inR(x, z, TEMPLE_IN) || TEMPLE_MODELED.some((r) => inR(x, z, r))) continue;
    const pts = B.poly(i);
    if (Math.abs(signedArea(pts)) < 20) continue;
    fps.push({ x, z, pts, h: Math.min(B.hd[i] / 10, 9) }); // 寺内多为单层殿宇，高度封顶避免重建成重檐楼阁
  }
  if (!fps.length) return null;
  const ground = (x, z) => ctx.terrain.heightAt(x, z);
  const origin = { x: CX, y: H_T, z: TZ };
  const lod = new THREE.LOD();
  lod.name = '大慈恩寺院落';
  lod.position.set(origin.x, origin.y, origin.z);
  for (const [det, dist] of [[1, 0], [0, 110]]) {
    const b = new ArchBuilder(ctx, { detail: det, style: 'ming', instancing: det >= 1, name: lod.name });
    for (const fp of fps) tangFromFootprint(b, fp, origin, ground, [CX - fp.x, 0], { eaveLights: false, ledCorridor: false, lanterns: false });
    lod.addLevel(b.build({ flood, name: lod.name + det }), dist);
  }
  lod.addLevel(new THREE.Object3D(), 6000);
  return lod;
}

/** 北广场花岗岩铺装：浅暖灰，0.6 m 方格（贴图 2.4 m = 4×4 块），细麻点，不带大块暗斑 */
function plazaPavingTexture() {
  const S = 512, N = 4, px = S / N;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let s = 23;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#76716a';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const v = 152 + r() * 16;
      g.fillStyle = `rgb(${v + 4},${v + 1},${v - 6})`;
      g.fillRect(i * px + 1.5, j * px + 1.5, px - 3, px - 3);
    }
  for (let k = 0; k < 9000; k++) {
    const v = r() < 0.5 ? 100 + r() * 40 : 180 + r() * 40;
    g.fillStyle = `rgba(${v},${v - 2},${v - 6},0.35)`;
    g.fillRect(r() * S, r() * S, 1.2, 1.2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 2.4, 1 / 2.4);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 跌水水帘透明度贴图：竖向水纹（offset.y 动画 = 向下流动） */
function streakTexture() {
  const W = 64, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(150,150,150)';
  g.fillRect(0, 0, W, H);
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const x = r() * W, w = 0.6 + r() * 2.2, y = r() * H, h = 20 + r() * 90, v = 170 + r() * 85;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, w, h);
    g.fillRect(x, y - H, w, h); // 纵向无缝
  }
  for (let i = 0; i < 25; i++) {
    const x = r() * W, y = r() * H, v = 60 + r() * 60;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, 1 + r() * 3, 6 + r() * 20);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ───────────── 北广场两侧仿唐商业街 ─────────────
const WING_NAMES = ['唐韵坊', '慈恩茶舍', '长安书局', '雁塔文创', '大唐礼物', '陕西非遗', '胡饼坊', '曲江春宴', '大唐珍宝', '长安乐坊'];
const oddBays = (span, target) => {
  let n = Math.max(1, Math.round(span / target));
  if (n % 2 === 0) n += span / n > target ? 1 : -1;
  return Math.max(3, Math.min(7, n));
};
/**
 * 按 OSM 足迹（北广场东西两侧的大体量商业楼）沿长轴分段，每段一座两层唐风楼，正面朝广场。
 * 每侧一个 LOD：160 m 内近景（斗拱、门窗、灯笼），外为简模（每侧约 10 个网格），4 km 外隐藏。
 */
function buildWings(ctx) {
  const B = readBuildings(ctx.data.buildings);
  if (!B) return null;
  const sides = { [-1]: [], 1: [] };
  for (let i = 0; i < B.n; i++) {
    const x = B.ax[i], z = B.az[i];
    if (!WINGS.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1)) continue;
    const pts = B.poly(i);
    if (Math.abs(signedArea(pts)) < 250) continue; // 售货亭、厕所等小体量不重建（让位后为空地）
    const bb = obb(pts);
    if (bb) sides[x < FOUNTAIN_C[0] ? -1 : 1].push({ ...bb, h: B.hd[i] / 10 });
  }
  const root = new THREE.Group();
  root.name = '北广场仿唐商业街';
  let nameK = 0, nB = 0;
  for (const side of [-1, 1]) {
    const blocks = sides[side];
    if (!blocks.length) continue;
    const ox = blocks.reduce((a, q) => a + q.cx, 0) / blocks.length, oz = blocks.reduce((a, q) => a + q.cz, 0) / blocks.length;
    const oy = ctx.terrain.heightAt(ox, oz);
    const lod = new THREE.LOD();
    lod.position.set(ox, oy, oz);
    lod.name = '仿唐商业街' + (side < 0 ? '西' : '东');
    const plan = [];
    for (const q of blocks) {
      const nU = Math.max(1, Math.round(q.w / 27)), uL = q.w / nU;
      const dUse = Math.min(q.d * 0.9, 22);
      for (let k = 0; k < nU; k++) {
        const t = -q.w / 2 + uL * (k + 0.5);
        const x = q.cx + q.ux * t, z = q.cz + q.uz * t;
        const bays = oddBays(uL - 3.5, 4.4), bayW = (uL - 3.5) / bays;
        const depthBays = Math.max(2, Math.min(5, Math.round((dUse - 2.4) / 4.6))), depthW = (dUse - 2.4) / depthBays;
        plan.push({ x, z, bays, bayW, depthBays, depthW, roof: (k + nB) % 2 ? 'wudian' : 'xieshan', name: WING_NAMES[nameK++ % WING_NAMES.length], tall: q.h > 14 && k === ((nU / 2) | 0) });
      }
      nB++;
    }
    for (const [det, dist] of [[1, 0], [0, 160]]) {
      const b = new ArchBuilder(ctx, { detail: det, style: 'tang', instancing: det >= 1, name: lod.name });
      for (const u of plan) {
        b.push(u.x - ox, ctx.terrain.heightAt(u.x, u.z) - 0.05 - oy, u.z - oz, side < 0 ? Math.PI / 2 : -Math.PI / 2);
        const storeys = [
          { bays: u.bays, depthBays: u.depthBays, bayW: u.bayW, depthW: u.depthW, colH: 4.6, front: 'tangshop', back: 'wall', sides: 'wall' },
          { colH: 3.7, front: 'zhiling', back: 'wall', sides: u.tall ? 'wall' : 'zhiling' },
        ];
        if (u.tall) storeys.push({ colH: 3.3, front: 'zhiling', back: 'wall', sides: 'zhiling' });
        multiStoreyTower(b, {
          style: 'tang', storeys, shrink: 0.6, pingzuo: true, balcony: 1.0, roof: u.roof, roofColor: 'darkgray',
          platform: 'plain', platformH: 0.45, platformMargin: 1.2, steps: 'front', plaque: u.name,
          lanterns: true, lanternSize: 0.6, eaveLights: { color: 0xffc56a, width: 0.08 },
        });
        b.pop();
      }
      lod.addLevel(b.build({ flood: { color: 0xffc27a, strength: 0.6, baseY: oy - 0.5, height: 16, top: 0.45, upDim: 0.95 }, name: lod.name + det }), dist);
    }
    lod.addLevel(new THREE.Object3D(), 4000);
    root.add(lod);
  }
  return root;
}
