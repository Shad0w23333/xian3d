// 路宽与路边停车规则（纯数据，traffic.js 与 pedestrians.js 共用）。
// 路宽与 roads_net.featureInfo 一致：W = max(f.w || 最小宽, 最小宽, 车道数 × 3.4/3.1)，上限 42 m；路面以要素中心线为轴。
// 停车：支路/小区路（residential、unclassified）与 service（小区内部路、停车通道）按路宽决定单侧或双侧顺向停车；
//   三级路（tertiary）只在车道外还有 ≥ 2.1 m 富余（非机动车道/停车带）时停车；主次干道不停。
//   窄路（无人行道）车辆外侧可伸出路缘 0.45 m（西安老小区常见的半压路肩停车），有人行道的路一律停在路面内、不压人行道；
//   离路口（图节点）11 m 内、桥梁/隧道、排除区里不停。
// 禁车区（carFreeZones）：路边停车与车流共用，见下。
import { CFG } from './roads_net.js';
import { pointInPoly } from '../core/util.js';

/** 道路要素的路面宽（米） */
export function featureWidth(f) {
  const cfg = CFG[f._ped ? 12 : f.c] || CFG[7];
  const lanes = Math.max(1, Math.min(8, f.l | 0 || 1));
  let W = Number(f.w) || cfg.minW;
  if (!cfg.paving) W = Math.max(W, cfg.minW, lanes * (cfg.rank >= 8 ? 3.4 : 3.1));
  return Math.min(W, 42);
}

// 等级 → 停车占用率（白天；夜间支路 ×1.35）
const OCC = { 3: 0.0, 4: 0.3, 5: 0.5, 6: 0.42, 7: 0.4 };
const hash = (n) => {
  let x = (n | 0) + 0x9e3779b9;
  x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15; x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
};

/**
 * 停车方案。返回 null（不停）或 { W, side: [右侧?, 左侧?]（相对要素走向）, lat（车身中心离中线）, occ, minLane（该侧行车道中心最小偏移）}
 * laneInfo：{ per（每向车道数）, lw（车道宽）}，与 traffic_net 的有向边一致
 */
export function parkingPlan(f, fi) {
  if (f.b || f.t || f._ped || !f.p || f.p.length < 4) return null;
  const occ = OCC[f.c];
  if (!occ) return null;
  const W = featureWidth(f), half = W / 2;
  const total = Math.max(1, f.l | 0 || 1);
  const twoWay = !f.o;
  const per = twoWay ? Math.max(1, Math.floor(total / 2)) : total;
  const lw = Math.min(3.6, Math.max(2.9, (Number(f.w) || 7) / (twoWay ? per * 2 : per)));
  const narrow = f.c >= 5; // 无人行道的支路/小区路
  let lat, sides;
  if (narrow) {
    // 宽路两侧停、在路面内；窄路单侧、半压路肩
    lat = W >= 9 ? half - 1.0 : half - 1.0 + Math.min(0.45, Math.max(0, 3.45 - half));
    sides = W >= 9 ? [1, 1] : hash(fi * 7 + 3) < 0.5 ? [1, 0] : [0, 1];
    if (!twoWay) sides = [1, 0];
  } else {
    const carEdge = twoWay ? per * lw : (per * lw) / 2;
    if (half - carEdge < 2.1) return null;
    lat = half - 1.0;
    sides = twoWay ? [1, 1] : [1, 0];
  }
  // 停车一侧的行车道须让出：车道中心 ≤ 停车内缘 − 车半宽 − 0.1
  const minLane = lat - 0.92 - 0.92 - 0.1;
  if (f.c !== 6 && minLane < 0.0) return null;
  return { W, side: sides, lat, occ, minLane, per, lw, twoWay };
}
export { hash as parkHash };

// ======================================================================
// 禁车区：地标/景区/步行街周边不停车、支路不跑车
// ======================================================================
// ① 精建模块排除区（ctx.exclusions）：标了 roads（道路模块不画路面）的一律不通车不停车；标了 buildings（地标、寺院、
//    城门、回民街街区、片区广场、地铁口……）的区内不停车，支路（residential/service/unclassified）不跑车。
// ② 景区步行区 = 同时标 buildings 与 roads 的排除区（鼓楼城台、大唐不夜城步行街、大雁塔北广场与寺院）：
//    外扩 20 m 内不停车、12 m 内支路不跑车；端点离它 ≤ 15 m 的短支路（门洞前的断头路）、
//    一半以上路段在 30 m 内的支路（绕地标的环路）整条禁车。
// ③ 回民街街区（huimin 排除区，属 ①）：区内一律不停车，支路不跑车（北院门/西羊市/大皮院/化觉巷等都是步行街）。
// ④ 寺院、古迹景区与遗址公园（landuse park 且名称含寺/庙/宫/观/祠/塔/陵/景区/遗址/博物…）：区内不停车，支路不跑车。
// ⑤ 步行街（pedestrian）路面及两侧 1.5 m 内不停车。
const MINOR = new Set([5, 6, 7]);
const SCENIC_NAME = /寺|庙|宫|观|祠|塔|陵|景区|遗址|博物|名胜|风景|古迹|碑林|书院/;
const ZCELL = 250;
const SC_R = 30;

function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}
/** 点到闭合多边形边界的距离（米） */
function polyDist(x, z, p) {
  let best = Infinity;
  const n = p.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) best = Math.min(best, segDist2(x, z, p[j], p[j + 1], p[i], p[i + 1]));
  return Math.sqrt(best);
}
function gridAdd(grid, x0, z0, x1, z1, item) {
  for (let cx = Math.floor(x0 / ZCELL); cx <= Math.floor(x1 / ZCELL); cx++)
    for (let cz = Math.floor(z0 / ZCELL); cz <= Math.floor(z1 / ZCELL); cz++) {
      const k = cx * 100003 + cz;
      let a = grid.get(k);
      if (!a) grid.set(k, (a = []));
      a.push(item);
    }
}
const gridGet = (grid, x, z) => grid.get(Math.floor(x / ZCELL) * 100003 + Math.floor(z / ZCELL));

/**
 * 禁车区索引（须在各模块 prepare 登记完排除区之后创建）。返回：
 *   noPark(x, z)            路边停车禁停
 *   noDrive(x, z, cls)      车行道样点禁行（cls = roads.json 等级）
 *   featureCarFree(f)       整条道路要素禁车（停车与通车都不要）
 *   stats                   统计（调试）
 */
export function carFreeZones(ctx) {
  const EX = ctx.exclusions && ctx.exclusions.items && ctx.exclusions.items.length ? ctx.exclusions : null;
  // ② 景区步行区
  const scenicGrid = new Map();
  let nScenic = 0;
  if (EX) for (const it of EX.items) {
    if (!(it.flags.buildings && it.flags.roads)) continue;
    const b = it.bb;
    gridAdd(scenicGrid, b.x0 - SC_R, b.z0 - SC_R, b.x1 + SC_R, b.z1 + SC_R, it);
    nScenic++;
  }
  // ④ 寺院/古迹景区公园
  const parkGrid = new Map();
  let nPark = 0;
  for (const L of ctx.data?.landuse?.polys || []) {
    if (L.k !== 'park' || !SCENIC_NAME.test(L.n || '') || !L.outer || L.outer.length < 6) continue;
    const p = L.outer;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
    gridAdd(parkGrid, x0, z0, x1, z1, { p, holes: L.holes || [], x0, x1, z0, z1 });
    nPark++;
  }
  // ⑤ 步行街路段
  const pedGrid = new Map();
  for (const f of ctx.data?.roads?.features || []) {
    if (f.c !== 12 || f.t || !f.p || f.p.length < 4) continue;
    const hw = Math.max(2, (Number(f.w) || 4) / 2);
    const p = f.p;
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
      gridAdd(pedGrid, Math.min(ax, bx) - hw - 2, Math.min(az, bz) - hw - 2, Math.max(ax, bx) + hw + 2, Math.max(az, bz) + hw + 2, [ax, az, bx, bz, hw]);
    }
  }

  const scenicDist = (x, z) => {
    const a = gridGet(scenicGrid, x, z);
    let d = Infinity;
    if (a) for (const it of a) {
      const b = it.bb;
      if (x < b.x0 - SC_R || x > b.x1 + SC_R || z < b.z0 - SC_R || z > b.z1 + SC_R) continue;
      d = Math.min(d, pointInPoly(x, z, it.p) ? 0 : polyDist(x, z, it.p));
      if (d === 0) break;
    }
    return d;
  };
  const inScenicPark = (x, z) => {
    const a = gridGet(parkGrid, x, z);
    if (!a) return false;
    for (const q of a) {
      if (x < q.x0 || x > q.x1 || z < q.z0 || z > q.z1) continue;
      if (!pointInPoly(x, z, q.p)) continue;
      if (q.holes.some((h) => h && h.length >= 6 && pointInPoly(x, z, h))) continue;
      return true;
    }
    return false;
  };
  const nearPed = (x, z, extra) => {
    const a = gridGet(pedGrid, x, z);
    if (!a) return false;
    for (const s of a) {
      const r = s[4] + extra;
      if (segDist2(x, z, s[0], s[1], s[2], s[3]) < r * r) return true;
    }
    return false;
  };
  const exB = (x, z) => !!(EX && EX.test(x, z, 'buildings'));
  const exR = (x, z) => !!(EX && EX.test(x, z, 'roads'));
  // 回民街街区（huimin 模块登记的排除区）
  const huimin = EX ? EX.items.filter((it) => it.name === 'huimin') : [];
  const inHuimin = (x, z) => huimin.some((it) => x >= it.bb.x0 && x <= it.bb.x1 && z >= it.bb.z0 && z <= it.bb.z1 && pointInPoly(x, z, it.p));

  const carFreeCache = new WeakMap();
  const walkCache = new WeakMap();
  const stats = { scenic: nScenic, scenicParks: nPark, carFreeFeatures: 0 };
  return {
    stats,
    /** 步行化的支路（行人按步行街放、走满路面）：整条禁车，或 60% 以上顶点在回民街街区/寺院景区内 */
    walkable(f) {
      if (!f || !MINOR.has(f.c) || f.b || f.t || !f.p || f.p.length < 4) return false;
      let v = walkCache.get(f);
      if (v !== undefined) return v;
      v = this.featureCarFree(f);
      if (!v) {
        const p = f.p, n = p.length / 2;
        let hit = 0;
        for (let i = 0; i < n; i++) if (inHuimin(p[i * 2], p[i * 2 + 1]) || inScenicPark(p[i * 2], p[i * 2 + 1])) hit++;
        v = hit / n >= 0.6;
      }
      walkCache.set(f, v);
      return v;
    },
    noPark(x, z) {
      return exR(x, z) || exB(x, z) || scenicDist(x, z) < 20 || inScenicPark(x, z) || nearPed(x, z, 1.5);
    },
    noDrive(x, z, cls) {
      if (exR(x, z)) return true;
      if (!MINOR.has(cls)) return false;
      return exB(x, z) || scenicDist(x, z) < 12 || inScenicPark(x, z) || nearPed(x, z, 0.5);
    },
    featureCarFree(f) {
      if (!f || !MINOR.has(f.c) || !f.p || f.p.length < 4) return false;
      let v = carFreeCache.get(f);
      if (v !== undefined) return v;
      v = false;
      const p = f.p, n = p.length / 2;
      const d0 = scenicDist(p[0], p[1]), d1 = scenicDist(p[n * 2 - 2], p[n * 2 - 1]);
      const dm = scenicDist(p[(n >> 1) * 2], p[(n >> 1) * 2 + 1]);
      if (Math.min(d0, d1, dm) < SC_R) {
        let L = 0;
        for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
        if (Math.min(d0, d1) <= 15 && L < 120) v = true;
        else {
          // 沿线每 5 m 取样：一半以上在 30 m 内 → 绕地标的环路
          let hit = 0, tot = 0;
          for (let i = 2; i < p.length; i += 2) {
            const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
            const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 5));
            for (let q = 0; q < k; q++) {
              const t = (q + 0.5) / k;
              tot++;
              if (scenicDist(ax + (bx - ax) * t, az + (bz - az) * t) < SC_R) hit++;
            }
          }
          v = tot > 0 && hit / tot >= 0.5;
        }
      }
      if (v) stats.carFreeFeatures++;
      carFreeCache.set(f, v);
      return v;
    },
  };
}
