// 西安钟楼、鼓楼与钟鼓楼广场（程序化古建，构件库 src/arch/chinese.js + 本模块私有构件 src/arch/belltower-parts.js）
//
// 资料（维基百科“西安钟楼”、百度百科“西安鼓楼”、西安科普网“鼓楼形制结构”、参考照片 research/refs/arch/belltower_*.jpg）：
//  · 钟楼：明洪武十七年（1384）建、万历十年（1582）迁今址。砖砌方形基座边长 35.5 m、高 8.6 m，四面正中各有高、宽约 6 m 的券洞，
//    十字贯通；基座上木构楼体两层（首层、二层均有回廊，二层设平座栏杆），重檐三滴水四角攒尖顶，覆深绿色琉璃瓦，顶置鎏金宝顶；
//    自地面至宝顶高 36 m。楼体面阔、进深各三间（外加回廊一周）。景云钟复制品（通高 2.45 m、钟口径 1.65 m）1997 年挂于基座西北角红漆钟架上。
//    二层四面门柱有楹联（文字未查实，不做）；主体无大型题字匾额。
//    夜景（参考照片）：基座与楼体暖金色泛光、屋脊与檐口青白色轮廓灯、各层檐下红灯笼、券洞内通透暖光。
//  · 鼓楼：明洪武十三年（1380）建，位于北院门南端、西大街北侧（OSM way 254488437，外廓约 49×33 m，本模块取文献 52.6×38 m 的折中 51.5×36）。
//    台基高 7.7 m，南北向券洞一个（宽高约 6 m）；楼体两层，面阔七间、进深三间，四周回廊，重檐三滴水歇山顶，灰瓦绿琉璃剪边；
//    总高约 34 m。南檐下“文武盛地”、北檐下“声闻于天”蓝底金字巨匾（8 m × 3.6 m，2005 年复制）。
//    台基上南北两侧各排列 24 面大鼓（南侧为“二十四节气鼓”，本模块在南侧鼓架上标注节气名）。东侧有沿墙登台踏步（OSM 外廓东侧凸出部分）。
//  · 钟鼓楼广场：两楼之间，1998 年建成，南临西大街；地下为世纪金花购物中心。此处做花岗岩铺装、草坪、树阵、宫灯柱。
//
// 世界坐标：钟楼中心 = (0, 0)；鼓楼中心约 (-322.5, -83)（OSM 外廓中心）。
import * as THREE from 'three';
import { buildLOD, multiStoreyTower, cityPlatform, eaveLights, lantern, stats } from '../arch/chinese.js';
import { crossPlatform, bronzeBell, bellFrame, drum, wallStair, plazaLamp } from '../arch/belltower-parts.js';
import { overlay } from '../core/util.js';

const BELL_C = [0, 0];
const DRUM_C = [-322.5, -83];
// 广场外廓（鼓楼东侧 → 钟楼西北角，南临西大街人行道 z≈-8）
const PLAZA = [[-351, -104], [-296, -104], [-296, -94], [-66, -94], [-66, -14], [-351, -14]];
const ISLAND_R = 42; // 钟楼环岛内绿岛半径（环岛道路中线约 r=54，由道路模块绘制）

const JIEQI = ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒'];

const flat = (poly) => poly.flatMap((p) => p);
const circle = (cx, cz, r, n = 32) => {
  const a = [];
  for (let i = 0; i < n; i++) a.push(cx + Math.cos((i / n) * Math.PI * 2) * r, cz + Math.sin((i / n) * Math.PI * 2) * r);
  return a;
};

// ───────────── 钟楼 ─────────────
function bellTower(b) {
  const plat = crossPlatform(b, { S: 35.5, H: 8.6, tw: 6, th: 6.3 });
  const info = multiStoreyTower(b, {
    y0: plat.topY, style: 'ming',
    storeys: [
      // 首层：外圈回廊柱 + 内圈金柱（面阔三间），门窗在金柱线；白灰槛墙 + 正中隔扇门
      { bays: [3.3, 4.4, 6.2, 4.4, 3.3], depthBays: [3.3, 4.4, 6.2, 4.4, 3.3], colH: 5.9, veranda: true, front: ['wall', 'geshan', 'wall'], back: ['wall', 'geshan', 'wall'], sides: ['wall', 'geshan', 'wall'] },
      // 二层：四面隔扇（红棂窗），平座栏杆
      { colH: 4.4, front: 'doors', back: 'doors', sides: 'doors' },
    ],
    pal: { wall: 0xe4ded2 },
    shrink: 0.3, balcony: 1.7, topEaves: 2, roof: 'zanjian', roofColor: 'green', platform: 'plain', platformH: 0.45, steps: 'none',
    finial: { h: 5.0, gold: true }, rich: true,
  });
  // 夜景：屋脊/檐口青白轮廓灯（照片中为冷白偏青的 LED 勾边）
  if (b.detail >= 1) eaveLights(b, info, { color: 0xc8f2e4, width: b.detail >= 2 ? 0.12 : 0.18 });
  // 檐下红灯笼：首层外檐每间一盏 + 二层平座四角
  if (b.detail >= 1) {
    const r0 = info.rings[0];
    for (const side of r0.sides)
      for (let k = 0; k < side.pts.length - 1; k++) {
        const x = (side.pts[k][0] + side.pts[k + 1][0]) / 2, z = (side.pts[k][1] + side.pts[k + 1][1]) / 2;
        lantern(b, x + side.n[0] * 0.5, info.colTop - 0.25, z + side.n[1] * 0.5, { kind: 'round', size: 1.05 });
      }
    const r1 = info.rings[info.rings.length - 1];
    const e1 = r1.w / 2 + 2.2;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) lantern(b, sx * e1, info.storeyTops[1] - 0.2, sz * e1, { kind: 'round', size: 1.1 });
  }
  // 景云钟复制品：基座西北角红漆钟架（1997）
  b.push(-14.3, plat.topY, -14.3, Math.PI / 4);
  bellFrame(b, 3.2, 4.4);
  bronzeBell(b, 0, 4.4 - 0.55, 0, 2.45, 1.65);
  b.pop();
  // 首层殿内正中再悬一口钟（门内可见）
  bronzeBell(b, 0, plat.topY + 5.2, 0, 2.2, 1.5);
  return { ...info, platTop: plat.topY };
}

// ───────────── 鼓楼 ─────────────
function drumTower(b) {
  const W = 51.5, D = 36, H = 7.7;
  const col = 0x8b877f;
  // 砖台（南北向券洞一个）：沿用构件库城台（四周矮女墙，无垛口）
  const plat = cityPlatform(b, { w: W, d: D, h: H, tunnels: 1, tw: 6, th: 6.2, crenel: true, parapetH: 1.8, inner: ['front', 'back', 'left', 'right'], color: col, capColor: 0x8e8a82, batter: 0.4 });
  const topY = plat.topY;
  // 东侧登台踏步（OSM 外廓东侧凸出 3 m）
  wallStair(b, W / 2 - 0.1, W / 2 + 3.0, 11.5, -12.5, H, { outerX: W / 2 + 3.0 });
  const info = multiStoreyTower(b, {
    y0: topY, style: 'ming',
    storeys: [
      // 首层：面阔七间 + 回廊 → 外圈 9 × 5 柱网
      { bays: [3.1, 4.3, 4.5, 4.6, 5.4, 4.6, 4.5, 4.3, 3.1], depthBays: [3.1, 4.6, 5.2, 4.6, 3.1], colH: 6.3, veranda: true, front: 'center3', back: 'center3', sides: 'windows' },
      { colH: 5.0, front: 'doors', back: 'doors', sides: 'windows' },
    ],
    shrink: 0.3, balcony: 1.6, topEaves: 2, roof: 'xieshan',
    // 灰瓦 + 绿琉璃脊（剪边近似）
    roofColor: { tile: 0x8d9196, tube: 0x868a8f, ridge: 0x2d6e44, glazed: false },
    platform: 'plain', platformH: 0.45, steps: 'none', rich: true,
  });
  // 南北巨匾（蓝底金字，8 m × 3.6 m，二层檐下）
  if (b.detail >= 1) {
    const r1 = info.rings[info.rings.length - 1];
    const zf = r1.d / 2 + 0.55;
    const y = info.storeyTops[1] - 1.1;
    const opt = { bg: '#1e3a66', color: '#f0c860', border: '#d8ae52' };
    b.plaque('文武盛地', 0, y, zf, 8, 3.0, opt);
    b.push(0, 0, 0, Math.PI);
    b.plaque('声闻于天', 0, y, zf, 8, 3.0, opt);
    b.pop();
  }
  // 台上大鼓：南北各 24 面（南侧二十四节气鼓，鼓架上标节气名）
  const n = 24, span = W - 5.5, step = span / (n - 1);
  const zRow = D / 2 - 0.4 - 1.7;
  const dia = 1.45;
  for (const s of [1, -1])
    for (let i = 0; i < n; i++) {
      const x = -span / 2 + i * step;
      const yc = topY + 1.05 + dia / 2;
      drum(b, x, yc, s * zRow, dia, 0, { base: topY, len: 0.95 });
      if (s > 0 && b.detail >= 2) b.plaque(JIEQI[i], x, topY + 0.55, zRow + 0.47, 0.34, 0.9, { vertical: true, bg: '#7a1c12', color: '#f2cf6a', border: '#c89a3c' });
    }
  // 殿内“闻天鼓”（首层正中）
  drum(b, 0, topY + 0.45 + 2.2, 0, 3.4, Math.PI / 2, { base: topY + 0.45, len: 0.8, color: 0x9a2216 });
  if (b.detail >= 1) {
    eaveLights(b, info, { color: 0xffd28a, width: b.detail >= 2 ? 0.11 : 0.16 });
    const r0 = info.rings[0];
    for (const side of r0.sides)
      for (let k = 0; k < side.pts.length - 1; k++) {
        const x = (side.pts[k][0] + side.pts[k + 1][0]) / 2, z = (side.pts[k][1] + side.pts[k + 1][1]) / 2;
        lantern(b, x + side.n[0] * 0.5, info.colTop - 0.25, z + side.n[1] * 0.5, { kind: 'round', size: 1.0 });
      }
  }
  return { ...info, platTop: topY };
}

// ───────────── 广场与绿岛 ─────────────
function plaza(b, hPlaza, hBell) {
  const PAVE = 0x9d978b, PAVE2 = 0x7f796e, CURB = 0xb9b3a7;
  // —— 钟鼓楼广场（局部原点 = 世界原点，y = 世界高度） ——
  const y = hPlaza;
  b.push(0, y, 0, 0);
  // 主铺装（分块：西段鼓楼前广场、东段树阵广场），留出草坪
  const lawns = [[-262, -78, -196, -34], [-186, -78, -128, -34]];
  b.box('stone', -351, -0.3, -64, -296, 0.1, -14, PAVE, { skip: 'bottom' }); // 鼓楼南侧前场
  b.box('stone', -296, -0.3, -94, -66, 0.1, -14, PAVE, { skip: 'bottom' });
  // 中轴深色铺装带、分格线
  b.box('stone', -272, 0.1, -60, -120, 0.13, -52, PAVE2, { skip: 'bottom' });
  for (let x = -290; x < -66; x += 12) b.box('stone', x, 0.1, -94, x + 0.25, 0.115, -14, PAVE2, { skip: 'bottom' });
  // 草坪（花岗岩路缘石 + 草坪面由外部草地材质绘制）
  for (const [x0, z0, x1, z1] of lawns) {
    b.box('stone', x0 - 0.35, 0.1, z0 - 0.35, x1 + 0.35, 0.45, z0, CURB, { skip: 'bottom' });
    b.box('stone', x0 - 0.35, 0.1, z1, x1 + 0.35, 0.45, z1 + 0.35, CURB, { skip: 'bottom' });
    b.box('stone', x0 - 0.35, 0.1, z0, x0, 0.45, z1, CURB, { skip: 'bottom' });
    b.box('stone', x1, 0.1, z0, x1 + 0.35, 0.45, z1, CURB, { skip: 'bottom' });
  }
  // 宫灯柱：南北两排
  const lampPts = [];
  for (let x = -284; x <= -76; x += 26) lampPts.push([x, -19], [x, -89]);
  for (let x = -345; x <= -300; x += 22) lampPts.push([x, -19]);
  for (const [x, z] of lampPts) {
    plazaLamp(b, x, z, 5.4);
    if (b.detail >= 1) {
      lantern(b, x - 0.75, 5.1, z, { kind: 'palace', size: 0.75 });
      lantern(b, x + 0.75, 5.1, z, { kind: 'palace', size: 0.75 });
    }
  }
  b.pop();
  // —— 钟楼绿岛（圆形，花带 + 花岗岩环路 + 铁艺矮栏） ——
  b.push(0, hBell, 0, 0);
  b.box('stone', -21.5, -0.3, -21.5, 21.5, 0.12, 21.5, 0x9e988c, { skip: 'bottom' });
  const seg = b.detail >= 2 ? 72 : 36;
  // 花带同心环（红/黄/紫/绿篱）
  const rings = [[21.8, 24.5, 0x3f6a2c, 0.35], [24.5, 27.5, 0xb3261c, 0.22], [27.5, 30, 0xe0b62a, 0.2], [30, 33, 0x6a3f8a, 0.2], [33, 36, 0xb3261c, 0.2], [36, 38.2, 0x3f6a2c, 0.45]];
  for (const [r0, r1, c, h] of rings) {
    const prof = [[r0, 0], [r0 + 0.15, h], [r1 - 0.15, h], [r1, 0]];
    ringLathe(b, 'plaster', prof, seg, c);
  }
  // 外圈花岗岩路缘
  ringLathe(b, 'stone', [[ISLAND_R - 0.6, -0.2], [ISLAND_R - 0.6, 0.25], [ISLAND_R, 0.25], [ISLAND_R, -0.2]], seg, CURB);
  if (b.detail >= 1) {
    const r = ISLAND_R - 1.2, N = 84;
    const rail = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      b.box('metal', x - 0.05, 0.1, z - 0.05, x + 0.05, 0.95, z + 0.05, 0x2a2c2e);
      rail.push([x, 0.9, z]);
    }
    b.sweep('metal', rail, [[-0.03, -0.03], [0.03, -0.03], [0.03, 0.03], [-0.03, 0.03]], 0x2a2c2e, { closed: true });
    b.sweep('metal', rail.map((p) => [p[0], 0.4, p[2]]), [[-0.025, -0.025], [0.025, -0.025], [0.025, 0.025], [-0.025, 0.025]], 0x2a2c2e, { closed: true });
  }
  b.pop();
  return { lawns, lampPts };
}
/** 绕 Y 轴的环形回转体（prof=[[r,y],...]，外侧逆时针），用于花带、路缘 */
function ringLathe(b, mk, prof, seg, col) {
  const bk = b.bucket(mk);
  const cl = lin3(col);
  const n = prof.length;
  const base = bk.count;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j < n; j++) {
      const [r, y] = prof[j];
      const [r2, y2] = prof[Math.min(n - 1, j + 1)], [r1, y1] = prof[Math.max(0, j - 1)];
      const tr = r2 - r1, ty = y2 - y1;
      const l = Math.hypot(tr, ty) || 1;
      const nr = ty / l, ny = -tr / l; // 截面法线（外向/上）
      b.vtx(bk, ca * r, y, sa * r, ca * -nr, -ny, sa * -nr, ca * r, sa * r, cl);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < n - 1; j++) {
      const a = base + i * n + j, c = a + n;
      b.tri(bk, a, a + 1, c + 1);
      b.tri(bk, a, c + 1, c);
    }
}
function lin3(c) {
  const col = new THREE.Color(c);
  return [col.r, col.g, col.b];
}

// ───────────── 树阵（实例化） ─────────────
function treeGrid(ctx, pts, hFn) {
  const n = pts.length;
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 3.2, 6).translate(0, 1.6, 0);
  const crownGeo = new THREE.IcosahedronGeometry(2.6, 2).scale(1, 0.8, 1).translate(0, 5.0, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.9 });
  const t = new THREE.InstancedMesh(trunkGeo, trunkMat, n), c = new THREE.InstancedMesh(crownGeo, crownMat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  pts.forEach(([x, z], i) => {
    const k = 0.85 + ((i * 37) % 11) / 30;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * 1.7);
    m.compose(p.set(x, hFn(x, z), z), q, s.set(k, k, k));
    t.setMatrixAt(i, m);
    c.setMatrixAt(i, m);
    c.setColorAt(i, col.setHSL(0.26 + ((i * 13) % 7) / 200, 0.38, 0.27 + ((i * 7) % 5) / 60));
  });
  for (const o of [t, c]) {
    o.castShadow = true;
    o.receiveShadow = true;
    o.computeBoundingSphere();
  }
  t.name = '广场树干';
  c.name = '广场树冠';
  return [t, c];
}

export default {
  id: 'belltower',
  name: '钟楼与鼓楼',
  prepare(ctx) {
    this.hBell = ctx.terrain.addFlatten({ points: circle(0, 0, ISLAND_R + 2, 36), height: null, feather: 10 });
    this.hPlaza = ctx.terrain.addFlatten({ points: flat(PLAZA), height: null, feather: 8 });
    ctx.exclusions.add({ circle: [BELL_C[0], BELL_C[1], ISLAND_R + 1] }, { buildings: true, trees: true, roads: false });
    ctx.exclusions.add({ points: flat(PLAZA) }, { buildings: true, trees: true, roads: false });
    ctx.exclusions.add({ rect: [DRUM_C[0], DRUM_C[1], 58, 42, 0] }, { buildings: true, trees: true, roads: true });
  },
  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '钟鼓楼';
    ctx.scene.add(root);
    const hBell = this.hBell ?? ctx.terrain.heightAt(0, 0);
    const hPlaza = this.hPlaza ?? ctx.terrain.heightAt(-180, -55);
    const hDrum = hPlaza;
    const levels = [[2, 0], [1, 260], [0, 750]];

    // 钟楼
    const bell = buildLOD(ctx, bellTower, { style: 'ming', levels, name: '西安钟楼', flood: { color: 0xffc47a, strength: 2.1, baseY: hBell + 0.5, height: 36, top: 0.8 } });
    bell.position.set(BELL_C[0], hBell, BELL_C[1]);
    root.add(bell);
    const bInfo = bell.userData.info;

    // 鼓楼
    const drumT = buildLOD(ctx, drumTower, { style: 'ming', levels, name: '西安鼓楼', flood: { color: 0xffc27a, strength: 2.0, baseY: hDrum + 0.5, height: 34, top: 0.8 } });
    drumT.position.set(DRUM_C[0], hDrum, DRUM_C[1]);
    root.add(drumT);
    const dInfo = drumT.userData.info;

    // 广场 + 绿岛（不泛光）
    let pInfo = null;
    const plazaLOD = buildLOD(ctx, (b) => (pInfo = plaza(b, hPlaza, hBell)), { style: 'ming', levels: [[2, 0], [1, 500]], name: '钟鼓楼广场' });
    root.add(plazaLOD);

    // 草坪面（外部草地材质，贴地覆盖层）
    const grassMat = overlay(ctx.mats.get('grass').clone(), 0.0008);
    const shapes = [];
    for (const [x0, z0, x1, z1] of pInfo.lawns) {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, hPlaza + 0.3, (z0 + z1) / 2);
      shapes.push(g);
    }
    const ring = new THREE.RingGeometry(21.6, 38.4, 64).rotateX(-Math.PI / 2).translate(0, hBell + 0.1, 0);
    shapes.push(ring);
    for (const g of shapes) {
      const uv = g.attributes.uv, pos = g.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / 4, pos.getZ(i) / 4);
      const mesh = new THREE.Mesh(g, grassMat);
      mesh.receiveShadow = true;
      mesh.name = '草坪';
      root.add(mesh);
    }

    // 树阵：广场南北两排 + 草坪四周
    const trees = [];
    for (let x = -290; x <= -72; x += 9) {
      if (!pInfo.lampPts.some((p) => Math.abs(p[0] - x) < 3)) trees.push([x, -23], [x, -85]);
    }
    for (const [x0, z0, x1, z1] of pInfo.lawns) for (let x = x0 + 5; x < x1 - 2; x += 11) trees.push([x, z0 + 4], [x, z1 - 4]);
    for (const m of treeGrid(ctx, trees, () => hPlaza + 0.1)) root.add(m);

    // 灯光：钟楼四角地面泛光 + 楼内暖光；鼓楼南北
    const L = (x, y, z, color, intensity, distance, priority) => ctx.lights.add({ position: new THREE.Vector3(x, y, z), color, intensity, distance, nightOnly: true, priority });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) L(sx * 24, hBell + 2, sz * 24, 0xffc27a, 900, 55, 3);
    L(0, hBell + bInfo.platTop + 4, 0, 0xffb060, 500, 30, 2);
    L(DRUM_C[0], hDrum + 3, DRUM_C[1] + 28, 0xffc27a, 1000, 60, 3);
    L(DRUM_C[0], hDrum + 3, DRUM_C[1] - 28, 0xffc27a, 800, 60, 2);

    // 标注
    ctx.labels.add('西安钟楼', new THREE.Vector3(0, hBell + bInfo.topY + 8, 0), { category: 'landmark', minDist: 60, maxDist: 12000, priority: 5 });
    ctx.labels.add('西安鼓楼', new THREE.Vector3(DRUM_C[0], hDrum + dInfo.topY + 7, DRUM_C[1]), { category: 'landmark', minDist: 60, maxDist: 8000, priority: 4 });
    ctx.labels.add('钟鼓楼广场', new THREE.Vector3(-180, hPlaza + 6, -55), { category: 'landmark', minDist: 80, maxDist: 2500, priority: 2 });

    const ms = performance.now() - t0;
    const st = { bell: stats(bell.levels[0].object), drum: stats(drumT.levels[0].object), plaza: stats(plazaLOD.levels[0].object), bellTop: +bInfo.topY.toFixed(1), drumTop: +dInfo.topY.toFixed(1), buildMs: Math.round(ms) };
    console.warn('[belltower] ' + JSON.stringify(st));
    return {
      setLayer(layer, visible) {
        if (layer === 'landmarks') root.visible = visible;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};
