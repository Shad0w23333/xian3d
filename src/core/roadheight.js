// 道路高程统一规则（roads 与 traffic 等模块共用，保证车辆贴合桥面/高架）
//   普通道路：地面高 + LIFT
//   桥梁/高架（b=1）：地面高 + 6.5 m × max(1, layer)，两端 RAMP 米内平滑过渡到地面（与相邻非桥路段衔接）
//   隧道（t=1）：不渲染（返回 null）
export const LIFT = 0.25;
export const BRIDGE_UNIT = 6.5;
export const RAMP = 90;

/** 计算折线每个顶点的累计里程 */
export function chainage(p) {
  const n = p.length / 2;
  const s = new Float32Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  return s;
}

/** 桥梁抬升量（米）：feature 为 roads.json 的一条要素，s 为里程，total 为总长 */
export function bridgeLift(feature, s, total) {
  if (!feature.b) return 0;
  const lift = BRIDGE_UNIT * Math.max(1, feature.y || 1);
  const ramp = Math.min(RAMP, total * 0.35);
  if (ramp <= 0) return lift;
  const k = Math.min(1, s / ramp, (total - s) / ramp);
  const t = Math.max(0, k);
  return lift * t * t * (3 - 2 * t);
}

/** 路面高度：terrain 为 ctx.terrain */
export function roadY(terrain, feature, x, z, s, total) {
  if (feature.t) return null;
  return terrain.heightAt(x, z) + LIFT + bridgeLift(feature, s, total);
}
