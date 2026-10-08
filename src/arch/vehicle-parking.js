// 路宽与路边停车规则（纯数据，traffic.js 与 pedestrians.js 共用）。
// 路宽与 roads_net.featureInfo 一致：W = max(f.w || 最小宽, 最小宽, 车道数 × 3.4/3.1)，上限 42 m；路面以要素中心线为轴。
// 停车：支路/小区路（residential、unclassified）与 service（小区内部路、停车通道）按路宽决定单侧或双侧顺向停车；
//   三级路（tertiary）只在车道外还有 ≥ 2.1 m 富余（非机动车道/停车带）时停车；主次干道不停。
//   窄路（无人行道）车辆外侧可伸出路缘 0.45 m（西安老小区常见的半压路肩停车），有人行道的路一律停在路面内、不压人行道；
//   离路口（图节点）11 m 内、桥梁/隧道、排除区里不停。
import { CFG } from './roads_net.js';

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
