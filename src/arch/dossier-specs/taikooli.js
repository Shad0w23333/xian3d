// 逐栋档案 · 西安太古里（小雁塔东侧，2026-10 修复轮补建）
// 问题（审查 g3 #18）：小雁塔东侧友谊西路以南、长安北路以西一大片没有任何 3D 建筑，地面是过时卫星影像里的平房。
// 资料（2026-10 联网）：
//   · 2023-11-14 开工，2026-09-21 首开区建筑群结构封顶，预计 2027 年初整体结构封顶、2027 年内分阶段开业（封面新闻 / 界面 / 21 财经 2026-09-21）；
//   · 总楼面面积近 27 万 m²（含地下），规划 29 座单体建筑，低密度、开放式街区，以小雁塔、荐福寺为视觉中心，规划视线通廊（界面、封面新闻）；
//   · 近 30 栋独栋，主材为沉稳的灰砖 + 温润木质元素 + 大面积通透玻璃幕墙，大量坡屋顶，多栋楼上退台、空中绿化与连廊，
//     西侧先开工的楼栋已在做幕墙与装修，中部全部封顶，最东侧紧邻地铁的几栋仍在封顶施工（腾讯新闻 2026-09-01 效果图与进度）；
//   · 限高：近小雁塔 24 m、近地铁 36 m（克而瑞 2026-09）；规划许可批前公示：地上 2~7 层、地下 1~3 层；
//   · 保留并活化第七横街、第八横街、一字横街三条历史街道（具体走向未公开）。
// 落位：用地以卫星（tiles/ 离线影像包 z18，施工期）与 OSM 道路核定——北至友谊西路南侧 z≈2078、东至长安北路西侧 x≈−44、
//   西至荐福寺东路 x≈−298、南至该路东折处 z≈2402，约 8.3 万 m²（北区）；南区（荐福寺东路以南的施工场地）范围不明，未建。
// 建模：楼栋平面图未公开，按“29 座单体、低密度街区”的资料做示意街区——东西向主街正对小雁塔（z≈2244，宽 28 m，视线通廊），
//   另两条东西向巷与两条南北向巷，12 个街块各分 1~3 栋，共 26 栋；西侧近塔 2~3 层、中部 2~3 层、东侧 2~4 层，东北角近地铁 6 层（在建）；
//   最东侧两栋按“仍在封顶施工”做裸露结构 + 塔吊。层高 5 m（商业）。坡屋顶以唐风意象的缓坡四坡顶（出檐、轻举折起翘）为主，两栋玻璃小楼为现代低坡顶。
//   整个地块铺贴地形的浅灰石材铺装（kind:'pave'），盖住旧影像里的平房。地上建筑面积合计约 14 万 m²（资料：地上约 12.6 万 m²；示意体块含中庭/挑空，略偏大）。
const TK_ROOF = { color: '#655f57', roughness: 0.86, metalness: 0.05 }; // 深灰瓦/金属屋面（略偏暖：中性灰在天光半球光下发蓝）
const FAC = {
  brick: { pattern: 'stoneWindows', tint: '#33404a', spd: '#75716a', floorH: 5, colW: 4.6, spandrel: 0.3, mullW: 1.1, lit: 0.5 }, // 灰砖 + 大窗
  glass: { pattern: 'grid', tint: '#3b4954', spd: '#57524c', floorH: 5, colW: 3.0, spandrel: 0.16, mullW: 0.22, lit: 0.55 }, // 大面积玻璃 + 深色框
  wood: { pattern: 'stoneWindows', tint: '#2f3a42', spd: '#8b6b4b', floorH: 5, colW: 2.6, spandrel: 0.32, mullW: 0.7, lit: 0.5 }, // 木色格栅
};
const SHOP = { pattern: 'retail', tint: '#36434c', spd: '#5f5a53', floorH: 5.2, colW: 3.6, spandrel: 0.12, mullW: 0.3, lit: 0.8 };
const R = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];
const META = {
  dossier: '（无档案条目，2026-10 修复轮按新闻资料 + 施工期卫星补建的示意街区）',
  sources: [
    'https://cbgc.scol.com.cn/news/7983795（2026-09-21 首开区结构封顶、近 27 万 m²、视线通廊、三条历史街道）',
    'https://www.jiemian.com/article/15131329.html（29 座单体建筑、低密度开放式街区）',
    'https://news.qq.com/rain/a/20260901A032NU00（近 30 栋独栋、灰砖/木质/大玻璃、坡屋顶、退台、东端仍在封顶）',
    'https://www.swireproperties.com/zh-hk/media/press-releases/2023/20231114_xian-breaks-ground/（用地约 11.99 万 m²、低层开放式、唐风）',
    '克而瑞好房点评 2026-09（限高：近地铁 36 m、近小雁塔 24 m）',
    'Google 卫星（tiles/ 离线影像包 z18，施工期）、OSM 友谊西路 / 长安北路 / 荐福寺东路',
  ],
  confidence: 'low（楼栋划分与形体为示意）；medium（用地范围、层数区间、材料、施工进度）',
};

let SEED = 500;
/**
 * 一栋：x0..x1 × z0..z1，floors 层；o.fac 立面（brick/glass/wood）、o.terrace 顶层退台方向（'N'|'S'|'E'|'W'，退 6 m）、
 * o.ridge 长正脊（近双坡）或四坡（缺省）、o.modern 现代低坡顶、o.uc 在建（裸露结构 + 塔吊）、o.crane 塔吊参数
 */
function tk(id, x0, z0, x1, z1, floors, o = {}) {
  const H = floors * 5, seed = (SEED += 3);
  const parts = [];
  // 屋顶：唐风意象的缓坡四坡顶（tangRoof：出檐 1.8 m、轻微举折与起翘，资料“顶部隐约可见唐代飞檐与斗拱意象”）；o.modern 为现代低坡四坡/双坡（pubHip）
  const roof = (w, d) => (o.modern
    ? [{ type: 'pubHip', h: Math.max(2.2, Math.min(w, d) * 0.15), eave: 1.4, ridge: o.ridge, mat: TK_ROOF, eaveMat: '#3a3d41', eaveH: 0.45 }]
    : [{ type: 'tangRoof', eave: 1.8, h: Math.max(2.4, Math.min(w, d) * 0.16), ridge: o.ridge != null ? 0.85 : undefined, curve: 0.3, lift: 0.5, base: 0.6, mat: TK_ROOF, ridgeMat: '#3b3936' }]);
  if (o.uc) {
    // 在建：裸露楼板与柱（夜间不亮），顶上塔吊
    parts.push({
      name: 'body', pts: R(x0, z0, x1, z1), base: 0, top: H, style: { pattern: 'openFrame', floorH: 5, colW: 8.4, seed },
      roof: { mech: false, parapet: 0.2 },
      crown: [{ type: 'crane', offset: o.crane?.offset ?? [0, 0], h: o.crane?.h ?? 24, jib: o.crane?.jib ?? 42, rot: o.crane?.rot ?? 200 }],
    });
  } else if (o.terrace && floors >= 3) {
    // 顶层退台：下部 floors−1 层平屋面（屋顶露台），顶层向内退 6 m 再起坡屋顶
    const t = o.terrace, d = 6;
    const ux0 = t === 'W' ? x0 + d : x0, ux1 = t === 'E' ? x1 - d : x1, uz0 = t === 'N' ? z0 + d : z0, uz1 = t === 'S' ? z1 - d : z1;
    parts.push({ name: 'body', pts: R(x0, z0, x1, z1), base: 0, top: H - 5, style: { ...FAC[o.fac || 'brick'], seed }, roof: { mech: false, parapet: 1.1 } });
    parts.push({
      name: 'top', pts: R(ux0, uz0, ux1, uz1), base: H - 5, top: H, style: { ...FAC.glass, seed: seed + 1 },
      roof: { mech: false, parapet: 0.3 }, crown: roof(ux1 - ux0, uz1 - uz0),
    });
  } else {
    parts.push({
      name: 'body', pts: R(x0, z0, x1, z1), base: 0, top: H, style: { ...FAC[o.fac || 'brick'], seed },
      roof: { mech: false, parapet: 0.3 }, crown: roof(x1 - x0, z1 - z0),
    });
  }
  if (!o.uc) parts.push({ name: 'shop', kind: 'facade', pts: R(x0, z0, x1, z1), grow: 0.15, base: 0, top: 5.2, style: { ...SHOP, seed: seed + 2 } });
  return { id: 'taikoo-' + id, name: '西安太古里·' + id, center: [(x0 + x1) / 2, (z0 + z1) / 2], parts, label: false, meta: META };
}

// 街块（x：西 −292~−222、中 −210~−138、东 −126~−48；z：2086~2146、2158~2230、主街 2230~2258、2258~2326、2338~2396）
const BUILDINGS = [
  // 西列（近小雁塔，限高 24 m：2~3 层）
  tk('W1a', -292, 2086, -260, 2146, 2, { fac: 'wood' }),
  tk('W1b', -254, 2086, -222, 2146, 3, { fac: 'brick', terrace: 'W' }),
  tk('W2a', -292, 2158, -252, 2230, 2, { fac: 'brick', ridge: 1 }),
  tk('W2b', -246, 2158, -222, 2194, 2, { fac: 'glass', modern: true }),
  tk('W2c', -246, 2200, -222, 2230, 2, { fac: 'wood' }),
  tk('W3a', -292, 2258, -258, 2326, 2, { fac: 'brick', ridge: 1 }),
  tk('W3b', -252, 2258, -222, 2326, 3, { fac: 'glass', terrace: 'N' }),
  tk('W4a', -292, 2338, -252, 2396, 2, { fac: 'wood' }),
  tk('W4b', -246, 2338, -222, 2396, 2, { fac: 'brick' }),
  // 中列（3 层为主）
  tk('M1a', -210, 2086, -178, 2146, 2, { fac: 'brick' }),
  tk('M1b', -172, 2086, -138, 2146, 3, { fac: 'glass', terrace: 'S' }),
  tk('M2a', -210, 2158, -170, 2190, 2, { fac: 'wood', ridge: 1 }),
  tk('M2b', -210, 2196, -170, 2230, 2, { fac: 'glass', modern: true, ridge: 1 }),
  tk('M2c', -164, 2158, -138, 2230, 3, { fac: 'brick', terrace: 'S' }),
  tk('M3a', -210, 2258, -138, 2286, 2, { fac: 'brick', ridge: 1 }),
  tk('M3b', -210, 2292, -176, 2326, 2, { fac: 'wood' }),
  tk('M3c', -170, 2292, -138, 2326, 3, { fac: 'glass', terrace: 'E' }),
  tk('M4', -210, 2338, -138, 2396, 3, { fac: 'brick', terrace: 'N' }),
  // 东列（近长安北路与地铁 2 号线南稍门站：3~4 层，东北角 6 层；最东侧两栋仍在封顶施工）
  tk('E1a', -126, 2086, -92, 2146, 4, { fac: 'glass', terrace: 'W' }),
  tk('E1b', -86, 2086, -48, 2146, 6, { uc: true, crane: { offset: [6, 4], h: 26, jib: 44, rot: 205 } }),
  tk('E2a', -126, 2158, -92, 2194, 2, { fac: 'wood' }),
  tk('E2b', -126, 2200, -92, 2230, 3, { fac: 'brick', ridge: 1 }),
  tk('E2c', -86, 2158, -48, 2230, 3, { uc: true, crane: { offset: [-4, -10], h: 24, jib: 40, rot: 160 } }),
  tk('E3a', -126, 2258, -80, 2326, 3, { fac: 'glass', terrace: 'S' }),
  tk('E3b', -74, 2258, -48, 2326, 3, { fac: 'brick' }),
  tk('E4', -126, 2338, -48, 2396, 3, { fac: 'wood', terrace: 'S' }),
];

// 整个地块的铺装 + 标注（铺装落地轮廓同时作为排除区：旧影像对应的通用建筑、树木让位）
const SITE = {
  id: 'taikoo-site',
  name: '西安太古里',
  center: [-170, 2240],
  parts: [{ name: 'pave', kind: 'pave', pts: [-297, 2079, -44, 2079, -44, 2398, -290, 2398, -297, 2391], base: 0, top: 0.2, step: 6, lift: 0.12, mat: 'granite' }],
  label: { text: '西安太古里', y: 26, priority: 1.6 },
  supersede: { names: ['西安太古里', '太古里'] },
  meta: { ...META, notes: '铺装网格 6 m、贴地形 +0.12 m。南区未建（范围不明）。' },
};

export default [SITE, ...BUILDINGS];
