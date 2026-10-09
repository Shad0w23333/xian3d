// 行人：轻量“活动气泡”行人系统（全城人行道 / 步行街 / 广场）
//
//   · 路径：roads.json 中的步行街（pedestrian）、人行道（footway）中心线，以及主干/次干/支路两侧人行道
//     （按路宽 + 人行道宽偏移；单行道只取右侧，对应分幅道路的外侧），居住区道路两侧少量；桥梁/隧道不放人。
//   · 热点：钟楼、鼓楼·回民街、大唐不夜城、大雁塔、小寨、永宁门、曲江池等处密度加倍，夜里更热闹（夜间照样有人）。
//   · 气泡：只在相机附近（离地 < 数百米）仿真，半径随高度变化；出圈的人回收并在视野外/远处补人，维持目标密度。
//   · 渲染：arch/people-geo.js 的人形（真实比例、男女老少体型、10 月衣着/发型/帽子/背包挎包/手机，顶点着色器骨骼动画：
//     摆臂、步幅随速度、屈膝、骨盆起伏扭转、看手机低头）。近处（< 60 m）细模并投影，远处简模，各一个 InstancedMesh；
//     CPU 只做沿折线行走。
//   · 开关：setLayer('people', false) 时整个系统停更新、不绘制；同时隐藏大唐不夜城的游客人流（'不夜城人流'）。
import * as THREE from 'three';
import { peopleGeometry, peopleMaterial, peopleDepthMaterial, createPeopleMesh, randomLook, setPeopleLit } from '../arch/people-geo.js';
import { LIFT, roadY } from '../core/roadheight.js';
import { pointInPoly } from '../core/util.js';
import { markParkWalkways } from '../arch/roads_net.js';
import { featureWidth, carFreeZones } from '../arch/vehicle-parking.js';

// 各画质档：最大人数 / 活动半径上限 / 绘制距离 / 生效的最大离地高度
const CAP = [500, 1000, 1800, 2800];
const R_MAX = [420, 600, 800, 1000];
const DRAW_D = [180, 260, 340, 430];
const AGL_MAX = [320, 480, 650, 850];
const CELL = 200; // 空间网格（米）
const BASE_DENSITY = 0.028; // 人 / 米路径（热点 ×，时段 ×，密度设置 ×）

// 热点：[lon, lat, 半径 m, 倍率]
const HOTSPOTS = [
  [108.9423, 34.2610, 420, 6], // 钟楼（钟鼓楼广场、开元、世纪金花）
  [108.9475, 34.2610, 520, 4], // 东大街（骡马市、民生）
  [108.9423, 34.2660, 450, 3], // 北大街
  [108.9423, 34.2550, 450, 3.5], // 南大街（粉巷、南门）
  [108.9395, 34.2632, 420, 5], // 鼓楼 · 回民街
  [108.9595, 34.2120, 700, 3.5], // 大唐不夜城
  [108.9642, 34.2196, 420, 3], // 大雁塔
  [108.9458, 34.2238, 650, 6], // 小寨（长安路 × 小寨东/西路十字，赛格、百汇、金莎）
  [108.9423, 34.2515, 260, 2], // 永宁门
  [108.9440, 34.2620, 1800, 1.6], // 明城墙内
  [108.9780, 34.2050, 800, 1.6], // 曲江池
  [108.8850, 34.2250, 1800, 1.2], // 高新区
  [108.9588, 34.2783, 380, 5], // 西安站（南广场、解放路北口）
  [108.9020, 34.2255, 400, 3], // 西安国际金融中心·高新路商圈
  [108.9470, 34.2330, 380, 3], // 南稍门·长安路
  [108.9895, 34.2400, 450, 2.5], // 曲江新区·金地广场一带
];
// 小吃街/步行街热点（世界坐标 x, z, 半径, 倍率；按 roads.json 街道中心线量取）：
// 下午到夜里都是人挤人的地方，倍率高于一般热点
const HOT_STREETS = [
  [-305, -290, 280, 16], // 北院门（鼓楼以北，步行街）
  [-1322, -900, 330, 12], // 洒金桥（北段）
  [-1322, -560, 300, 10], // 洒金桥（南段，近大麦市街）
  [-520, -415, 240, 8], // 西羊市
  [-550, -563, 220, 6], // 大皮院
  [-570, -292, 200, 4], // 化觉巷
  [230, 800, 260, 5], // 书院门 · 三学街（南门内东侧）
  [2100, -560, 200, 5], // 永兴坊（中山门内）
];
// 广场（行人在广场内随机穿行、驻足）：landuse 的 square（≥ 3000 m²，喷泉水面除外）+ 下列精建地标广场。
// 地面高度取精建模块的遮挡体高度场（ctx.occluders.topAt，台地/铺装面），高出地面 0.9 m 以上的格子（天窗、雕塑、
// 花坛、建筑）当障碍物：走到跟前掉头。w = 密度权重（相对人行道）
const LANDMARK_PLAZAS = [
  { n: '钟鼓楼广场', w: 3.5, p: [-290, -92, -72, -92, -72, -20, -290, -20] },
  { n: '鼓楼南广场', w: 2.5, p: [-350, -58, -297, -58, -297, -20, -350, -20] },
  { n: '大雁塔北广场西侧', w: 4, p: [1490, 4104, 1527, 4104, 1527, 4448, 1490, 4448] },
  { n: '大雁塔北广场东侧', w: 4, p: [1617, 4104, 1654, 4104, 1654, 4448, 1617, 4448] },
  { n: '大雁塔北广场北端', w: 3, p: [1490, 4104, 1654, 4104, 1654, 4140, 1490, 4140] },
  { n: '大雁塔南广场', w: 3, p: [1508, 4792, 1637, 4792, 1637, 4940, 1508, 4940] },
];
const PLAZA_SKIP = /喷泉|水池|水面/;
// 时段人流（相对傍晚高峰）
const HOUR_KEYS = [[0, 0.3], [2, 0.1], [5, 0.06], [7, 0.45], [9, 0.7], [12, 0.85], [15, 0.8], [18, 1], [20.5, 1], [22.5, 0.65], [24, 0.3]];
function hourFactor(h) {
  h = ((h % 24) + 24) % 24;
  for (let i = 1; i < HOUR_KEYS.length; i++) {
    const [h1, v1] = HOUR_KEYS[i];
    if (h <= h1) {
      const [h0, v0] = HOUR_KEYS[i - 1];
      return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0);
    }
  }
  return 0.3;
}
// 与 arch/roads_net.js 的 CFG 对应：路面最小宽 / 人行道宽
const MIN_W = [7.5, 7, 7, 6.5, 6, 5, 3.5, 5, 4.5, 4.5, 4.5, 4, 4, 2];
const SIDEWALK = [0, 4.5, 5, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// 行道树离路缘距离（与 arch/vegPlant.js 的 STREET 表一致）：行人走在树池内侧（靠建筑一侧），不再穿过树干与灯杆
const TREE_D = [0, 2.0, 2.0, 1.9, 1.8];

const NEAR_D = 60; // 细模距离
const NEAR_CAP = 700;

let seed = 987654;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export default {
  id: 'pedestrians',
  name: '行人',
  async build(ctx) {
    const { terrain, camera } = ctx;
    const Q = ctx.quality;
    let level = Math.max(0, Math.min(3, Q.level ?? 2));

    // —— 路径 ——
    // 每条路径：pts（x,z 交错）、cum（累计里程）、len、off（横向偏移基准）、jit（横向抖动幅度）、w（密度权重）、lift
    const paths = [];
    const hot = HOTSPOTS.map(([lon, lat, r, k]) => { const p = ctx.geo.project(lon, lat); return { x: p.x, z: p.z, r, k }; });
    for (const [x, z, r, k] of HOT_STREETS) hot.push({ x, z, r, k });
    const hotAt = (x, z) => {
      let k = 1;
      for (const h of hot) {
        const d = Math.hypot(x - h.x, z - h.z);
        if (d < h.r) k = Math.max(k, 1 + (h.k - 1) * (1 - (d / h.r) ** 2));
      }
      return k;
    };
    // 店铺密度（100 m 格，3×3 邻域求和）：商圈人行道加密（小寨、钟楼、东大街等核心商圈约 ×3~4）
    const POI_CELL = 100, poiGrid = new Map();
    const SHOPPY = /^(shop|restaurant|fast_food|cafe|marketplace|supermarket|mall|bakery|ice_cream|pharmacy|bank|karaoke_box|cinema|hotel|clinic)$/;
    for (const q of ctx.data.pois?.pois || []) {
      if (!q || !SHOPPY.test(q.k || '')) continue;
      const k = Math.floor(q.x / POI_CELL) * 100003 + Math.floor(q.z / POI_CELL);
      poiGrid.set(k, (poiGrid.get(k) || 0) + 1);
    }
    const poiAt = (x, z) => {
      const gx = Math.floor(x / POI_CELL), gz = Math.floor(z / POI_CELL);
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) n += poiGrid.get((gx + dx) * 100003 + gz + dz) || 0;
      return 1 + Math.min(3, Math.max(0, n - 20) / 30);
    };
    // 地铁出入口附近（60 m）再加密
    const metroPts = (ctx.data.pois?.pois || []).filter((q) => q && q.k === 'subway_entrance');
    const MCELL = 120, metroGrid = new Map();
    for (const q of metroPts) {
      const k = Math.floor(q.x / MCELL) * 100003 + Math.floor(q.z / MCELL);
      let a = metroGrid.get(k);
      if (!a) metroGrid.set(k, (a = []));
      a.push(q.x, q.z);
    }
    const metroAt = (x, z) => {
      const gx = Math.floor(x / MCELL), gz = Math.floor(z / MCELL);
      let k = 1;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const a = metroGrid.get((gx + dx) * 100003 + gz + dz);
        if (a) for (let i = 0; i < a.length; i += 2) { const d = Math.hypot(a[i] - x, a[i + 1] - z); if (d < 60) k = Math.max(k, 1 + 1.5 * (1 - d / 60)); }
      }
      return k;
    };
    const segWeights = (pts, n) => {
      const sw = new Float32Array(Math.max(1, n - 1));
      for (let i = 0; i < n - 1; i++) {
        const mx = (pts[i * 2] + pts[i * 2 + 2]) * 0.5, mz = (pts[i * 2 + 1] + pts[i * 2 + 3]) * 0.5;
        sw[i] = Math.max(hotAt(mx, mz), poiAt(mx, mz)) * metroAt(mx, mz);
      }
      return sw;
    };
    const feats = ctx.data.roads?.features || [];
    markParkWalkways(ctx.data.roads, ctx.data.landuse); // 景区/公园里的无名支路按步行道（c=12）放人
    // 禁车的支路（回民街街区、地标门前、寺院景区，见 vehicle-parking.js carFreeZones）按步行街放人：走满路面
    const CF = carFreeZones(ctx);
    for (const f of feats) {
      const c = f._ped || CF.walkable(f) ? 12 : f.c;
      if (f.t || f.b || !f.p || f.p.length < 4) continue;
      let sides = null;
      const W = Math.min(42, Math.max(Number(f.w) || MIN_W[c] || 5, MIN_W[c] || 5, c >= 1 && c <= 4 ? Math.max(1, f.l | 0 || 1) * (c <= 2 ? 3.4 : 3.1) : 0));
      if (c === 12) sides = [[0, W * 0.8, 1.6]];
      else if (c === 13) sides = [[0, Math.min(W, 3) * 0.6, 1.1]];
      else if (c >= 1 && c <= 4) {
        const sw = SIDEWALK[c];
        const a = TREE_D[c] + 0.7, b = Math.max(a + 0.2, sw - 0.3);
        const o = W / 2 + (a + b) / 2, jit = Math.max(0.3, b - a);
        sides = f.o ? [[o, jit, 1]] : [[o, jit, 1], [-o, jit, 1]];
      } else if (c === 5) {
        // 小区路/支路没有人行道：走在路缘外侧（路面上有行车与路边停车）
        const o = featureWidth(f) / 2 + 0.7;
        sides = [[o, 0.4, 0.3], [-o, 0.4, 0.3]];
      }
      if (!sides) continue;
      const src = f.p;
      const n = src.length / 2;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(src[i * 2] - src[i * 2 - 2], src[i * 2 + 1] - src[i * 2 - 1]);
      const len = cum[n - 1];
      if (len < 8) continue;
      const pts = Float32Array.from(src);
      const sw = segWeights(pts, n);
      for (const [off, jit, w] of sides) paths.push({ f, pts, cum, n, len, off, jit, w, sw, lift: c >= 1 && c <= 4 ? 0.14 : 0.04, cls: c });
    }
    // 不放人的地方：地形挖洞、“道路模块不画路面”的排除区里的坑口与楼体内部（roads 且非 buildings，或面积 < 5000 m² 的
    // 地标实体如鼓楼城台）。同时标 buildings 与 roads 的大片步行区（不夜城步行街、大雁塔北广场与寺院）照常放人
    const HCELL = 200, hideGrid = new Map();
    for (const it of ctx.exclusions?.items || []) {
      const fl = it.flags, b = it.bb;
      if (!fl.roads) continue;
      if (fl.buildings && (b.x1 - b.x0) * (b.z1 - b.z0) >= 5000) continue;
      for (let cx = Math.floor(b.x0 / HCELL); cx <= Math.floor(b.x1 / HCELL); cx++)
        for (let cz = Math.floor(b.z0 / HCELL); cz <= Math.floor(b.z1 / HCELL); cz++) {
          const k = cx * 100003 + cz;
          let a = hideGrid.get(k);
          if (!a) hideGrid.set(k, (a = []));
          a.push(it);
        }
    }
    const hideEx = (x, z) => {
      const a = hideGrid.get(Math.floor(x / HCELL) * 100003 + Math.floor(z / HCELL));
      if (!a) return false;
      for (const it of a) {
        const b = it.bb;
        if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
        if (pointInPoly(x, z, it.p)) return true;
      }
      return false;
    };
    // 车行道（主次干道、支路、匝道；不含桥隧、步行化支路）：行人不走进别的道路的车行道——路口处人行道折线的端点
    // 落在横向道路中线上、步道穿越车行道处等，走到路缘就掉头（不在车流里横穿）
    const CW_CELL = 40, cwGrid = new Map();
    for (const f of feats) {
      if (f.c < 1 || f.c > 11 || f.c === 6 || f.b || f.t || f._ped || !f.p || f.p.length < 4 || CF.walkable(f)) continue;
      const hw = featureWidth(f) / 2 - 0.3;
      if (hw < 1.5) continue;
      const p = f.p;
      for (let i = 2; i < p.length; i += 2) {
        const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
        const x0 = Math.min(ax, bx) - hw, x1 = Math.max(ax, bx) + hw, z0 = Math.min(az, bz) - hw, z1 = Math.max(az, bz) + hw;
        if (x1 - x0 > 3000 || z1 - z0 > 3000) continue;
        for (let cx = Math.floor(x0 / CW_CELL); cx <= Math.floor(x1 / CW_CELL); cx++)
          for (let cz = Math.floor(z0 / CW_CELL); cz <= Math.floor(z1 / CW_CELL); cz++) {
            const k = cx * 100003 + cz;
            let a = cwGrid.get(k);
            if (!a) cwGrid.set(k, (a = []));
            a.push(ax, az, bx, bz, hw);
          }
      }
    }
    const inCarriage = (x, z) => {
      const a = cwGrid.get(Math.floor(x / CW_CELL) * 100003 + Math.floor(z / CW_CELL));
      if (!a) return false;
      for (let i = 0; i < a.length; i += 5) {
        const ax = a[i], az = a[i + 1], dx = a[i + 2] - ax, dz = a[i + 3] - az;
        const l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        if (qx * qx + qz * qz < a[i + 4] * a[i + 4]) return true;
      }
      return false;
    };
    // 广场路径：随机弦（两端都在广场内、沿线不出界），行人在广场内来回走、驻足
    let pseed = 4242;
    const prnd = () => { pseed = (pseed * 16807) % 2147483647; return pseed / 2147483647; };
    const plazaList = LANDMARK_PLAZAS.map((q) => ({ ...q }));
    for (const L of ctx.data.landuse?.polys || []) {
      if (L.k !== 'square' || !L.outer || L.outer.length < 6 || PLAZA_SKIP.test(L.n || '')) continue;
      plazaList.push({ n: L.n || '广场', w: L.n ? 2.5 : 1.6, p: L.outer, holes: L.holes || [] });
    }
    let nPlazaPaths = 0;
    for (const P of plazaList) {
      const p = P.p;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, A = 0;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
        A += p[j] * p[i + 1] - p[i] * p[j + 1];
      }
      A = Math.abs(A) / 2;
      if (A < 3000) continue;
      const inside = (x, z) => pointInPoly(x, z, p) && !(P.holes || []).some((h) => h && h.length >= 6 && pointInPoly(x, z, h)) && !hideEx(x, z) && !inCarriage(x, z);
      const nChord = Math.max(3, Math.min(90, Math.round(A / 500)));
      const Lmax = Math.min(90, Math.max(20, Math.sqrt(A) * 0.8));
      for (let k = 0; k < nChord; k++) {
        for (let tries = 0; tries < 10; tries++) {
          const ax = x0 + prnd() * (x1 - x0), az = z0 + prnd() * (z1 - z0);
          if (!inside(ax, az)) continue;
          const an = prnd() * Math.PI * 2, L = 12 + prnd() * (Lmax - 12);
          const bx = ax + Math.cos(an) * L, bz = az + Math.sin(an) * L;
          let ok = true;
          for (let q = 1; q <= 6 && ok; q++) ok = inside(ax + ((bx - ax) * q) / 6, az + ((bz - az) * q) / 6);
          if (!ok) continue;
          const pts = Float32Array.from([ax, az, bx, bz]);
          const cum = Float32Array.from([0, L]);
          const mw = Math.max(hotAt((ax + bx) / 2, (az + bz) / 2), 1);
          paths.push({ f: null, pts, cum, n: 2, len: L, off: 0, jit: 2.4, w: P.w, sw: Float32Array.from([mw]), lift: 0.03 - LIFT, plaza: true, cls: -1 });
          nPlazaPaths++;
          break;
        }
      }
    }
    // 空间网格：cell → [pathIndex, segIndex, ...]；道路模块不画的路段（排除区 roads）与地形挖洞处不放人
    const hidden = (x, z) => !!(terrain.inHole?.(x, z) || hideEx(x, z));
    // 实体占地：片区模块自建房屋的逐户轮廓（回民街/曲江等登记为“只让树”的排除区，单个面积 < 5000 m²）。
    // OSM 街道中心线与房屋轮廓常有几米到十几米的偏差（北院门南段中心线斜进西侧铺面），行人落进房子里就看不见了：
    // 生成与行走时遇到房屋就横向挪到街上
    const SOLID_CELL = 50;
    const solidGrid = new Map();
    for (const it of ctx.exclusions?.items || []) {
      const fl = it.flags;
      if (!fl.trees || fl.buildings || fl.roads) continue;
      const b = it.bb;
      if ((b.x1 - b.x0) * (b.z1 - b.z0) > 5000) continue;
      for (let cx = Math.floor(b.x0 / SOLID_CELL); cx <= Math.floor(b.x1 / SOLID_CELL); cx++)
        for (let cz = Math.floor(b.z0 / SOLID_CELL); cz <= Math.floor(b.z1 / SOLID_CELL); cz++) {
          const k = cx * 100003 + cz;
          let a = solidGrid.get(k);
          if (!a) solidGrid.set(k, (a = []));
          a.push(it);
        }
    }
    const solid = (x, z) => {
      const a = solidGrid.get(Math.floor(x / SOLID_CELL) * 100003 + Math.floor(z / SOLID_CELL));
      if (!a) return false;
      for (const it of a) {
        const b = it.bb;
        if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
        if (pointInPoly(x, z, it.p)) return true;
      }
      return false;
    };
    const grid = new Map();
    const key = (cx, cz) => cx * 65536 + cz;
    paths.forEach((p, pi) => {
      for (let i = 0; i < p.n - 1; i++) {
        const mx = (p.pts[i * 2] + p.pts[i * 2 + 2]) * 0.5, mz = (p.pts[i * 2 + 1] + p.pts[i * 2 + 3]) * 0.5;
        if (hidden(mx, mz)) continue;
        const k = key(Math.floor(mx / CELL) + 32768, Math.floor(mz / CELL) + 32768);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(pi, i);
      }
    });

    // —— 渲染 ——
    const MAXN = CAP[3];
    const geoNear = peopleGeometry(0), geoFar = peopleGeometry(1);
    const mat = peopleMaterial(ctx);
    const WN = createPeopleMesh(ctx, geoNear, mat, NEAR_CAP, '行人（近景）');
    const WF = createPeopleMesh(ctx, geoFar, mat, MAXN, '行人');
    WN.mesh.customDepthMaterial = peopleDepthMaterial(ctx);
    const shadowsOn = () => !!Q.shadows && level >= 1;
    WN.mesh.castShadow = shadowsOn();
    WF.mesh.castShadow = false;
    for (const w of [WN, WF]) { w.mesh.receiveShadow = true; ctx.scene.add(w.mesh); }
    geoNear.dispose(); geoFar.dispose();

    // —— 行人状态（SoA） ——
    const wPath = new Int32Array(MAXN), wSeg = new Int32Array(MAXN);
    const wS = new Float32Array(MAXN), wDir = new Int8Array(MAXN), wSpd = new Float32Array(MAXN), wOff = new Float32Array(MAXN);
    const wPh = new Float32Array(MAXN), wLook = new Array(MAXN), wScale = new Float32Array(MAXN), wYaw = new Float32Array(MAXN);
    const wY = new Float32Array(MAXN), wX = new Float32Array(MAXN), wZ = new Float32Array(MAXN), wTimer = new Float32Array(MAXN);
    const wHid = new Uint8Array(MAXN); // 上次检查时是否已在隐藏区内（区分“走进去”与“生成/卡在里面”）
    let N = 0;

    // 活动区候选段（按权重×长度的累计分布抽样）
    let candP = new Int32Array(1024), candI = new Int32Array(1024), candCum = new Float64Array(1024), nCand = 0;
    const bub = { x: 1e9, z: 1e9, R: 0, on: false };
    let target = 0;

    const frustum = new THREE.Frustum();
    const projM = new THREE.Matrix4();
    const sphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
    // 步行速度：成年人 1.1~1.6 m/s，老人慢、看手机的人慢
    const walkSpeed = (i) => (0.95 + rnd() * 0.6) * (wLook[i]?.speedK ?? 1) * (wLook[i] && wLook[i].mask & 1024 ? 0.82 : 1);

    const locate = (i) => {
      const p = paths[wPath[i]];
      let g = wSeg[i];
      const s = wS[i];
      while (g < p.n - 2 && s > p.cum[g + 1]) g++;
      while (g > 0 && s < p.cum[g]) g--;
      wSeg[i] = g;
      const ax = p.pts[g * 2], az = p.pts[g * 2 + 1], bx = p.pts[g * 2 + 2], bz = p.pts[g * 2 + 3];
      const sl = p.cum[g + 1] - p.cum[g] || 1;
      const t = Math.min(1, Math.max(0, (s - p.cum[g]) / sl));
      const dx = (bx - ax) / sl, dz = (bz - az) / sl;
      // 右法线 (-dz, dx)
      wX[i] = ax + (bx - ax) * t - dz * wOff[i];
      wZ[i] = az + (bz - az) * t + dx * wOff[i];
      if (wSpd[i] > 0) wYaw[i] = Math.atan2(dx * wDir[i], dz * wDir[i]);
    };
    // 落在房屋里：沿路径法线左右试探（±1.5 m 步长，至多 ±12 m）挪到最近的空地；找不到返回 false
    const LAT_STEPS = [1.5, -1.5, 3, -3, 4.5, -4.5, 6, -6, 8, -8, 10, -10, 12, -12];
    const unstick = (i) => {
      if (!solidGrid.size || !solid(wX[i], wZ[i])) return true;
      const o0 = wOff[i];
      for (const d of LAT_STEPS) {
        wOff[i] = o0 + d;
        locate(i);
        if (!solid(wX[i], wZ[i])) return true;
      }
      wOff[i] = o0;
      locate(i);
      return false;
    };
    // 高度跟随道路纵断面（引桥路堤、被抬高的地面路上行人不再低于路面）；无纵断面时退回地形
    const occ = ctx.occluders;
    const groundY = (i) => {
      const p = paths[wPath[i]];
      const g = terrain.heightAt(wX[i], wZ[i]) + LIFT;
      if (p.plaza) {
        // 精建广场的铺装/台地面（遮挡体高度场）；没有登记实体的地方贴地形
        const top = occ ? occ.topAt(wX[i], wZ[i]) : -Infinity;
        const t0 = g - LIFT;
        wY[i] = top > t0 - 0.6 && top < t0 + 0.9 ? top + 0.02 : g + p.lift;
        return;
      }
      const r = p.f && p.f._rp ? roadY(terrain, p.f, wX[i], wZ[i], wS[i], p.len) : null;
      wY[i] = Math.max(g, r ?? g) + p.lift;
    };
    // 广场里高出地面 0.9 m 以上的实体（天窗、雕塑、花坛、亭子）或低于地面 0.6 m 的坑（水池）当障碍
    const plazaBlocked = (i) => {
      if (!occ) return false;
      const top = occ.topAt(wX[i], wZ[i]);
      if (top === -Infinity) return false;
      const t0 = terrain.heightAt(wX[i], wZ[i]);
      return top > t0 + 0.9 || top < t0 - 0.6;
    };
    // 行人是否该掉头：隐藏区、别的道路的车行道（广场路径另查障碍）
    const offLimits = (i) => {
      if (hidden(wX[i], wZ[i])) return true;
      const p = paths[wPath[i]];
      if (p.plaza) return plazaBlocked(i);
      return inCarriage(wX[i], wZ[i]);
    };

    const spawn = (i, anywhere) => {
      if (!nCand) return false;
      const cp = camera.position;
      for (let tries = 0; tries < 5; tries++) {
        const r = rnd() * candCum[nCand - 1];
        let lo = 0, hi = nCand - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (candCum[m] < r) lo = m + 1; else hi = m; }
        const pi = candP[lo], g = candI[lo], p = paths[pi];
        wPath[i] = pi;
        wSeg[i] = g;
        wS[i] = p.cum[g] + rnd() * (p.cum[g + 1] - p.cum[g]);
        wOff[i] = p.off + (rnd() - 0.5) * p.jit;
        const stand = rnd() < 0.12;
        wLook[i] = randomLook(rnd);
        wSpd[i] = stand ? 0 : walkSpeed(i);
        wDir[i] = rnd() < 0.5 ? 1 : -1;
        wYaw[i] = rnd() * Math.PI * 2;
        wTimer[i] = stand ? 5 + rnd() * 25 : 20 + rnd() * 60;
        locate(i);
        // 中点不在隐藏区的路段也可能部分穿进坑口/楼体排除区：落点在区内就重抽，5 次都不行就不补这个人
        if (offLimits(i) || !unstick(i)) { if (tries < 4) continue; return false; }
        if (anywhere || tries === 4) break;
        // 非初始补人：尽量补在视野外或较远处，避免“凭空出现”
        const d = Math.hypot(wX[i] - cp.x, wZ[i] - cp.z);
        sphere.center.set(wX[i], terrain.heightAt(wX[i], wZ[i]) + 1, wZ[i]);
        sphere.radius = 1.5;
        if (d > bub.R * 0.55 || !frustum.intersectsSphere(sphere)) break;
      }
      wPh[i] = rnd();
      wScale[i] = wLook[i].height / 1.7;
      wHid[i] = 0;
      groundY(i);
      return true;
    };
    const kill = (i) => {
      const j = --N;
      if (i === j) return;
      wPath[i] = wPath[j]; wSeg[i] = wSeg[j]; wS[i] = wS[j]; wDir[i] = wDir[j]; wSpd[i] = wSpd[j]; wOff[i] = wOff[j];
      wPh[i] = wPh[j]; wLook[i] = wLook[j]; wScale[i] = wScale[j]; wYaw[i] = wYaw[j]; wY[i] = wY[j]; wX[i] = wX[j]; wZ[i] = wZ[j]; wTimer[i] = wTimer[j]; wHid[i] = wHid[j];
    };

    let density = Q.peopleDensity ?? 1;
    const refresh = (first) => {
      const cp = camera.position;
      const agl = camera.userData.agl ?? cp.y - terrain.heightAt(cp.x, cp.z);
      if (agl > AGL_MAX[level] || density <= 0) {
        bub.on = false;
        N = 0;
        nCand = 0;
        return;
      }
      const R = THREE.MathUtils.clamp(260 + Math.max(0, agl) * 1.3, 300, R_MAX[level]);
      const wasOn = bub.on;
      // 相机瞬移（预设视角/跳转，一次移动超过气泡半径）：旧气泡里的人全部出圈，新气泡按“首次”处理直接铺满，
      // 否则补人只补在视野外，跳过去后的前几十秒街上空无一人
      const jumped = wasOn && Math.hypot(cp.x - bub.x, cp.z - bub.z) > R;
      bub.on = true;
      bub.x = cp.x; bub.z = cp.z; bub.R = R;
      // 候选段
      nCand = 0;
      let acc = 0;
      const c0x = Math.floor((cp.x - R) / CELL) + 32768, c1x = Math.floor((cp.x + R) / CELL) + 32768;
      const c0z = Math.floor((cp.z - R) / CELL) + 32768, c1z = Math.floor((cp.z + R) / CELL) + 32768;
      const R2 = R * R;
      for (let cx = c0x; cx <= c1x; cx++)
        for (let cz = c0z; cz <= c1z; cz++) {
          const a = grid.get(key(cx, cz));
          if (!a) continue;
          for (let k = 0; k < a.length; k += 2) {
            const p = paths[a[k]], g = a[k + 1];
            const mx = (p.pts[g * 2] + p.pts[g * 2 + 2]) * 0.5 - cp.x, mz = (p.pts[g * 2 + 1] + p.pts[g * 2 + 3]) * 0.5 - cp.z;
            if (mx * mx + mz * mz > R2) continue;
            if (nCand >= candP.length) {
              const grow = (A, T) => { const b = new T(A.length * 2); b.set(A); return b; };
              candP = grow(candP, Int32Array); candI = grow(candI, Int32Array); candCum = grow(candCum, Float64Array);
            }
            acc += (p.cum[g + 1] - p.cum[g]) * p.w * p.sw[g];
            candP[nCand] = a[k]; candI[nCand] = g; candCum[nCand] = acc; nCand++;
          }
        }
      const night = ctx.uniforms.uNight.value;
      const hf = hourFactor(ctx.sky?.hours ?? 16) * (1 + 0.15 * night);
      target = Math.min(CAP[level], Math.round(acc * BASE_DENSITY * hf * density));
      // 回收出圈的人
      const out2 = (R * 1.08) ** 2;
      for (let i = N - 1; i >= 0; i--) {
        const dx = wX[i] - cp.x, dz = wZ[i] - cp.z;
        if (dx * dx + dz * dz > out2) kill(i);
      }
      while (N > target) kill(N - 1);
      const anywhere = first || !wasOn || jumped;
      // 每次最多补一部分，分摊到多次刷新
      const add = anywhere ? target - N : Math.min(target - N, 300);
      for (let k = 0; k < add; k++) if (spawn(N, anywhere)) N++;
    };

    // —— 帧更新 ——
    let enabled = true;
    let refreshT = 0, frame = 0, first = true;
    const crowdMeshes = [];
    let crowdScanned = false;
    const scanCrowds = () => {
      crowdScanned = true;
      ctx.scene.traverse((o) => { if (o.isInstancedMesh && o.name === '不夜城人流') crowdMeshes.push(o); });
    };

    const inst = {
      update(dt) {
        if (!enabled) return;
        dt = Math.min(dt, 0.1);
        frame++;
        const cp = camera.position;
        refreshT -= dt;
        const moved = Math.hypot(cp.x - bub.x, cp.z - bub.z);
        projM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projM, camera.coordinateSystem, camera.reversedDepth);
        if (first || refreshT <= 0 || (bub.on && moved > bub.R * 0.3)) {
          refresh(first);
          first = false;
          refreshT = 0.6;
        }
        if (!bub.on || !N) { for (const w of [WN, WF]) { w.reset(); w.commit(); } return; }
        const drawD2 = DRAW_D[level] ** 2, nearD2 = NEAR_D * NEAR_D;
        WN.reset(); WF.reset();
        for (let i = 0; i < N; i++) {
          const p = paths[wPath[i]];
          // 状态机：走一段 ↔ 驻足
          wTimer[i] -= dt;
          if (wTimer[i] <= 0) {
            if (wSpd[i] > 0 && rnd() < 0.3) { wSpd[i] = 0; wTimer[i] = 3 + rnd() * 12; }
            else { wSpd[i] = walkSpeed(i); wTimer[i] = 20 + rnd() * 60; if (rnd() < 0.25) wDir[i] = -wDir[i]; }
          }
          if (wSpd[i] > 0) {
            let s = wS[i] + wDir[i] * wSpd[i] * dt;
            if (s < 0) { s = -s; wDir[i] = 1; } else if (s > p.len) { s = 2 * p.len - s; wDir[i] = -1; }
            wS[i] = s;
            locate(i);
            if ((frame + i) % 8 === 0) {
              groundY(i);
              // 从外面走进被隐藏的路段（下沉广场坑口、楼体内部等排除区）就掉头；
              // 连续两次检查都在区内（掉头也没走出来）说明卡住了，移除，由补人逻辑重新生成
              // 走进房屋：先横向挪回街上，挪不开再按隐藏区处理
              const h = offLimits(i) || !unstick(i) ? 1 : 0;
              if (h && wHid[i]) { kill(i); i--; continue; }
              if (h) wDir[i] = -wDir[i];
              wHid[i] = h;
            }
          }
          const dx = wX[i] - cp.x, dy = wY[i] - cp.y, dz = wZ[i] - cp.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > drawD2) continue;
          // 相机 2.2 m 内不画（人眼高度机位前不再有人贴脸）
          if (dx * dx + dz * dz < 4.84 && Math.abs(dy) < 2.5) continue;
          sphere.center.set(wX[i], wY[i] + 0.9, wZ[i]);
          sphere.radius = 1.2;
          if (!frustum.intersectsSphere(sphere)) continue;
          const w = d2 < nearD2 && !WN.full() ? WN : WF;
          if (w.full()) continue;
          w.put(wX[i], wY[i], wZ[i], wYaw[i], wScale[i], wLook[i], wPh[i], wSpd[i], 0);
        }
        WN.commit(); WF.commit();
        // 夜里：路灯/店面补光（反照率比例，强度低，不再整体发灰白光）
        setPeopleLit(ctx.uniforms.uNight.value * 0.14);
      },
      setLayer(name, on) {
        if (name !== 'people') return;
        enabled = !!on;
        if (!enabled) { for (const w of [WN, WF]) { w.reset(); w.commit(); } N = 0; bub.on = false; }
        else first = true;
        if (!crowdScanned) scanCrowds();
        for (const m of crowdMeshes) m.visible = enabled;
      },
      setQuality(q) {
        level = Math.max(0, Math.min(3, q.level ?? level));
        density = q.peopleDensity ?? density;
        WN.mesh.castShadow = shadowsOn();
        refreshT = 0;
      },
      /** 调试：行人位置、朝向、速度 */
      debugWalkers() {
        const out = [];
        for (let i = 0; i < N; i++) out.push({ x: wX[i], y: wY[i], z: wZ[i], yaw: wYaw[i], v: wSpd[i] });
        return out;
      },
      stats() {
        return { walkers: N, drawn: WN.mesh.count + WF.mesh.count, near: WN.mesh.count, target, bubbleR: Math.round(bub.R), paths: paths.length, plazaPaths: nPlazaPaths, cand: nCand };
      },
      dispose() {
        for (const w of [WN, WF]) { w.mesh.geometry.dispose(); ctx.scene.remove(w.mesh); }
        mat.dispose();
      },
    };
    if (typeof window !== 'undefined') window.__peds = inst;
    return inst;
  },
};
