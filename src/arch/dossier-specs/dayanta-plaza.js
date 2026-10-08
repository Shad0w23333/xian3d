// 逐栋档案 · 大雁塔北广场东西两侧仿唐商业建筑（2026-10 修复轮补建）
// 问题（审查 g6 #9）：北广场东西两侧本应是仿唐商业建筑（青灰瓦顶、酱色立柱），原来由通用建筑模块按 CMAB 轮廓生成平顶灰褐现代方盒占位。
// 依据：
//   · 位置与体量：Google 卫星（本地离线影像包 z19，tools/imagery_pack.py）+ CMAB 轮廓（buildings.bin #99337/#99309 西侧、#99330/#99338/#99298 东侧，
//     屋脊高 12.6~14.8 m）。东西两翼各分南北两段（中间为广场东西向横街，z≈4255~4306），每段约 34 × 105 m；
//     卫星上每段靠广场一侧的端部各有一座方形攒尖/短脊庑殿顶楼阁（西翼东北角、东南角，东翼西北角、西南角，约 26 × 26 m）。
//   · 形制：携程/马蜂窝游记与百科“大雁塔北广场两侧为仿唐建筑群（商业）”——两层，青灰筒瓦庑殿顶、重檐（腰檐），
//     临广场一侧首层为酱色木柱外廊，白墙 + 深色木格门窗；夜间檐口金色线灯（西安仿唐建筑通行做法）。
// 高度：两层（首层 4.6 m + 二层 4.6 m）→ 墙身 9.2 m，屋面矢高 5.2 m，屋脊约 15.4 m（与 CMAB 12.6~14.8 m 接近）；楼阁墙身 10.4 m、矢高 7 m。
// 未建：九宫格园林、唐代八大人物雕像（属 pagoda 模块的广场景观）、各店招牌（无可靠资料）。
const DY_TILE = { color: '#625d55', roughness: 0.9, metalness: 0.03 }; // 青灰筒瓦（略偏暖：中性灰在天光半球光下发蓝）
const DY_FAC = { pattern: 'stoneWindows', tint: '#3a2e26', spd: '#ddd4c4', floorH: 4.6, colW: 3.8, spandrel: 0.32, mullW: 1.0, lit: 0.55 };
const JIANG = { color: '#5a2e1f', roughness: 0.6, metalness: 0.05 }; // 酱色立柱
const R = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

/** 一段仿唐商业楼：主楼（两层、重檐庑殿顶）+ 临广场端部楼阁 + 临广场一侧首层酱色柱廊 */
function block(id, name, [x0, x1], [z0, z1], plazaX, pav, seed) {
  const step = 4.6, cols = [];
  for (let z = z0 + 3; z <= z1 - 3 + 1e-6; z += step) {
    if (z > pav[2] - 1.5 && z < pav[3] + 1.5) continue; // 楼阁占住的一段不立柱
    cols.push([plazaX, +z.toFixed(2)]);
  }
  return {
    id, name,
    center: [(x0 + x1) / 2, (z0 + z1) / 2],
    clearance: 3.5, // 让位贴着外廊的通用小房（CMAB 5.8 m 小体块）
    flatten: true, // 西翼西侧地形比广场高 2~4 m（广场被 pagoda 压平到 418.8 m）：落地体块下按最低点压平，免得背面墙脚埋进地里
    parts: [
      {
        name: 'hall', pts: R(x0, z0, x1, z1), base: 0, top: 9.2, style: { ...DY_FAC, seed },
        roof: { mech: false, parapet: 0.3 },
        crown: [{ type: 'tangRoof', eave: 2.6, h: 5.2, ridge: 0.72, curve: 0.45, mat: DY_TILE, glow: '#ffc36b', strength: 0.7, double: { gap: 4.4, out: 2.4, h: 1.3 } }],
      },
      {
        name: 'pavilion', pts: R(pav[0], pav[2], pav[1], pav[3]), base: 0, top: 10.4, style: { ...DY_FAC, seed: seed + 1 },
        roof: { mech: false, parapet: 0.3 },
        crown: [{ type: 'tangRoof', eave: 2.8, h: 7, ridge: 0.12, curve: 0.5, mat: DY_TILE, glow: '#ffc36b', strength: 0.7, double: { gap: 4.8, out: 2.6, h: 1.4 } }],
      },
    ],
    columns: [{ part: 'hall', at: cols, r: 0.32, from: 0, to: 4.6, mat: JIANG }],
    label: false,
    meta: {
      dossier: '（无档案条目，2026-10 修复轮按卫星 + CMAB 轮廓 + 游记补建）',
      sources: ['Google 卫星（tiles/ 离线影像包 z19）', 'CMAB buildings.bin #99337 #99309 #99330 #99338 #99298（屋脊 12.6~14.8 m）', '携程/马蜂窝 大雁塔北广场游记（两侧仿唐商业建筑群）'],
      confidence: 'medium（位置、体量）；low（立面细节、楼阁形制）',
      notes: '东西两翼按广场中轴 x≈1568.5 对称；楼阁位置按卫星攒尖屋面的顶点（±3 m）；柱廊柱距 4.6 m 为推定值。',
    },
  };
}

const AXIS_W = [1429.5, 1463.5], AXIS_E = [1673.5, 1707.5]; // 西翼 / 东翼东西范围（东翼为西翼关于 x=1568.5 的镜像）
const N_Z = [4149, 4255], S_Z = [4307, 4414];
export default [
  block('dyt-plaza-wn', '大雁塔北广场西侧仿唐商业楼（北段）', AXIS_W, N_Z, AXIS_W[1] + 1.6, [1443, 1469, 4143, 4169], 401),
  block('dyt-plaza-ws', '大雁塔北广场西侧仿唐商业楼（南段）', AXIS_W, S_Z, AXIS_W[1] + 1.6, [1443, 1469, 4379, 4405], 403),
  block('dyt-plaza-en', '大雁塔北广场东侧仿唐商业楼（北段）', AXIS_E, N_Z, AXIS_E[0] - 1.6, [1668, 1694, 4143, 4169], 405),
  block('dyt-plaza-es', '大雁塔北广场东侧仿唐商业楼（南段）', AXIS_E, S_Z, AXIS_E[0] - 1.6, [1668, 1694, 4379, 4405], 407),
];
