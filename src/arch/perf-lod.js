// 绘制负担控制的小工具（各场景模块共用；不属于核心渲染管线）
//
// shadowReach：本项目只有一张跟随相机的平行光阴影贴图（core/sky.js _updateShadow），正交范围半边长 = clamp(离地高 × 2.2, 350, 3600) × 阴影范围倍率，
// 中心在相机前方 0.35 × 半边长处。离相机超过“半边长 × 1.4 + 余量 + 影长”的物体不可能把影子投进这张贴图，却照样走一遍阴影通道
// （three.js 只按光源视锥剔除，而光源视锥沿光线方向延伸数公里）。各模块据此按距离关闭 castShadow。

/**
 * 距相机多远以内的物体还可能把影子投进阴影贴图。
 * @param ctx 模块上下文（用 ctx.sky.shadowSize 与 ctx.uniforms.uSunDir）
 * @param cap 上限（米），通常取画质档位常量
 * @param maxH 该类物体的典型最大高度（米），太阳低角时影子更长
 */
export function shadowReach(ctx, cap = Infinity, maxH = 60) {
  const size = ctx.sky?.shadowSize ?? 800;
  const sy = ctx.uniforms?.uSunDir?.value?.y ?? 0.7; // sin(太阳高度角)
  const tanE = Math.max(0.12, sy / Math.sqrt(Math.max(1e-6, 1 - sy * sy)));
  return Math.min(cap, size * 1.4 + 120 + maxH / tanE);
}
