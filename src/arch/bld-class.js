// 建筑功能分类（专题图“分类高亮”用）：纯函数，主线程/Node 均可运行。
//
// 类别来源（优先级从高到低，先命中者为准）：
//   1. 建筑名称关键字（buildings_names.json）：如“医院/门诊”→医疗、“XX小区-3号楼”→住宅
//   2. buildings.bin 的明确 kind（OSM 标签）：5 历史/宗教、6 交通、7 学校/医院、8 酒店
//   3. POI 落在建筑轮廓内（或 30 m 内最近的建筑）：pois.json 的 k 字段 + POI 名称关键字
//   4. 大院类 POI 的邻近范围：医院 90 m、中小学/幼儿园 60 m、高校 160 m（仅非住宅建筑）
//   5. 高校用地（landuse university）内的建筑 → 教育
//   6. kind 1~4（CMAB 功能 / OSM）+ style 功能细分（办公/商业）
//   7. 用地（landuse residential/commercial/industrial/military）
//   8. style 功能细分兜底；仍无法判定 → 其他
import { parseBuildings } from './bld-gen.js';

/** 类别表：下标即类别编号（着色器与图例共用） */
export const BLD_CLASSES = [
  { key: 'other', name: '其他', color: '#9aa0a6' },
  { key: 'res', name: '住宅', color: '#f2c94c' },
  { key: 'com', name: '商业/商场', color: '#eb5757' },
  { key: 'off', name: '办公', color: '#2f80ed' },
  { key: 'ind', name: '工业/仓储', color: '#9b51e0' },
  { key: 'edu', name: '教育', color: '#27ae60' },
  { key: 'med', name: '医疗', color: '#ff6fb5' },
  { key: 'gov', name: '政府/公共', color: '#00a3a3' },
  { key: 'cul', name: '文化/宗教/古迹', color: '#b5652d' },
  { key: 'tra', name: '交通', color: '#56ccf2' },
  { key: 'hot', name: '酒店', color: '#f2994a' },
  { key: 'spo', name: '体育', color: '#bde038' },
];
export const C = { OTHER: 0, RES: 1, COM: 2, OFF: 3, IND: 4, EDU: 5, MED: 6, GOV: 7, CUL: 8, TRA: 9, HOT: 10, SPO: 11 };

// 名称关键字（顺序即优先级：先判“家属院/宿舍”等住宅，再判具体功能）
const NAME_RULES = [
  [C.EDU, /(学生公寓|学生宿舍|研究生公寓|留学生公寓|学生\d*舍|^\d+舍$|[东西南北]\d+舍)/],
  [C.IND, /(工业园|物流园|厂区|产业基地)/],
  [C.OFF, /(产业园|科技园|软件园|创业园|孵化|研发中心|企业园|总部基地|写字楼)/],
  [C.RES, /(家属|住宅|宿舍|职工楼|小区|花园|家园|佳苑|雅苑|华苑|新村|公寓(?!酒店)|别墅|山庄|名邸|华庭|嘉园|府邸|社区-|[0-9一二三四五六七八九十]+号?(住宅)?楼$|\d+栋$|\d+幢$|单元$)/],
  [C.MED, /(医院|门诊|住院|急诊|医疗|医技|卫生院|卫生服务|妇幼|保健院|诊所|病房|口腔|康复中心|血站|疾控|体检)/],
  [C.HOT, /(酒店|宾馆|饭店|旅馆|客栈|招待所|民宿|度假村|Hotel|HOTEL|如家|汉庭|锦江|7天|速8)/],
  [C.SPO, /(体育|运动|球场|球馆|游泳|健身|奥体|网球|篮球|足球|羽毛球|滑冰|冰场)/],
  [C.EDU, /(学校|小学|中学|附中|大学|学院|幼儿园|教学|实验楼|实训|教室|讲堂|图书馆楼|研究生|校区|书院门|培训中心|科研楼|研究所|研究院)/],
  [C.CUL, /(寺|庙|塔$|塔院|道观|观$|祠|教堂|清真|礼拜|博物馆|博物院|美术馆|纪念馆|展览馆|图书馆|文化馆|文化中心|艺术中心|剧院|剧场|音乐厅|大剧院|遗址|故居|碑林|钟楼|鼓楼|城楼|箭楼|宫$|殿$|阁$|门楼|牌楼|陵|影剧院)/],
  [C.TRA, /(火车站|高铁站|车站|地铁|航站楼|机场|汽车站|客运站|客运中心|公交|枢纽|停车楼|停车场|加油站|收费站|充电站|动车|机务段|货运站)/],
  [C.GOV, /(政府|委员会|人大|政协|法院|检察院|公安|派出所|交警|税务|管委会|街道办|办事处|区委|市委|省委|党校|海关|消防|邮政|邮局|监狱|看守所|武警|部队|军区|民政|社保|行政中心|政务|市民中心|便民服务|服务中心$|局$|厅$|署$|总领事馆|领事馆)/],
  [C.IND, /(厂房|工厂|厂$|车间|仓库|仓储|物流|库房|泵房|泵站|变电|配电|锅炉|水厂|污水|热电|电厂|厂区|工业|制造|机加|冷库|粮库)/],
  [C.COM, /(商场|购物|百货|超市|商城|市场|万达|奥莱|奥特莱斯|步行街|商业|商厦|银泰|大悦城|万象|赛格|SKP|吾悦|荟聚|宜家|店$|餐厅|美食|影城|影院|KTV|商铺|底商|菜市场|批发|汽车城|4S|体验中心|会所)/],
  [C.OFF, /(大厦|写字楼|办公|综合楼|行政楼|总部|研发|科技园|软件园|创业|孵化|金融|银行|证券|保险|公司|集团|大楼|中心大楼|商务|国际中心|广场-[A-Z0-9]|[A-Z]座$|信息港)/],
];

/** 名称 → 类别（-1 未命中） */
export function classByName(n) {
  if (!n) return -1;
  for (const [c, re] of NAME_RULES) if (re.test(n)) return c;
  return -1;
}

// POI 类别（pois.json 的 k 字段）
const POI_K = {
  hotel: C.HOT, motel: C.HOT, hostel: C.HOT, guest_house: C.HOT,
  school: C.EDU, kindergarten: C.EDU, university: C.EDU, college: C.EDU, language_school: C.EDU, driver_training: C.EDU, research_institute: C.EDU,
  hospital: C.MED, clinic: C.MED, dentist: C.MED,
  museum: C.CUL, library: C.CUL, theatre: C.CUL, place_of_worship: C.CUL, gallery: C.CUL, arts_centre: C.CUL, archaeological_site: C.CUL,
  memorial: C.CUL, monument: C.CUL, city_gate: C.CUL, ruins: C.CUL, tomb: C.CUL, attraction: C.CUL, citywalls: C.CUL, exhibition_centre: C.CUL,
  station: C.TRA, bus_station: C.TRA, fuel: C.TRA, parking: C.TRA, charging_station: C.TRA,
  police: C.GOV, fire_station: C.GOV, townhall: C.GOV, courthouse: C.GOV, post_office: C.GOV, community_centre: C.GOV, social_facility: C.GOV, prison: C.GOV,
  conference_centre: C.GOV,
  shop: C.COM, marketplace: C.COM, cinema: C.COM, karaoke_box: C.COM, food_court: C.COM, theme_park: C.COM,
  bank: C.OFF,
};
// 小型底商 POI（餐饮/银行网点等）只用于“无明确功能”的建筑，不覆盖住宅
const POI_WEAK = new Set(['shop', 'bank', 'cinema', 'karaoke_box', 'food_court', 'fuel', 'parking', 'charging_station', 'post_office', 'clinic', 'dentist', 'community_centre']);
// 大院类 POI：按半径覆盖周边非住宅建筑
const POI_CAMPUS = { hospital: 90, school: 60, kindergarten: 40, university: 160, college: 140, research_institute: 70, prison: 120 };

const LANDUSE_K = { residential: C.RES, commercial: C.COM, industrial: C.IND, university: C.EDU, military: C.GOV };

const inRing = (x, z, p) => {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const zi = p[i + 1], zj = p[j + 1];
    if (zi > z !== zj > z && x < ((p[j] - p[i]) * (z - zi)) / (zj - zi) + p[i]) c = !c;
  }
  return c;
};

/** 用地网格：返回 (x,z) → 覆盖该点的最小地块 {k,n,outer} 或 null */
export function landuseLocator(landuse, kinds = LANDUSE_K) {
  const polys = (landuse?.polys || []).filter((p) => kinds[p.k] != null && p.outer && p.outer.length >= 6);
  const CELL = 250;
  const grid = new Map();
  for (const p of polys) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const o = p.outer;
    for (let i = 0; i < o.length; i += 2) {
      if (o[i] < x0) x0 = o[i];
      if (o[i] > x1) x1 = o[i];
      if (o[i + 1] < z0) z0 = o[i + 1];
      if (o[i + 1] > z1) z1 = o[i + 1];
    }
    p._bb = [x0, z0, x1, z1];
    const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL), j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4000) continue; // 超大地块（整片农田/林地级）不参与
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = i * 100003 + j;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(p);
      }
  }
  return (x, z) => {
    const a = grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!a) return null;
    let best = null, ba = Infinity;
    for (const p of a) {
      const b = p._bb;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      const area = p.a || (b[2] - b[0]) * (b[3] - b[1]);
      if (area >= ba) continue;
      if (!inRing(x, z, p.outer)) continue;
      if (p.holes && p.holes.some((h) => inRing(x, z, h))) continue;
      best = p;
      ba = area;
    }
    return best;
  };
}

/**
 * 计算每栋建筑的类别。
 * buffer 或 P（parseBuildings 结果）；names：{index: 名称}；landuse / pois 为原始 JSON
 * 返回 { cls: Uint8Array(N), src: Uint8Array(N)（命中规则序号 1..8）, stats }
 */
export function classifyBuildings(P, names, landuse, pois) {
  if (P instanceof ArrayBuffer) P = parseBuildings(P);
  if (!P) return null;
  const N = P.count;
  const cls = new Uint8Array(N);
  const src = new Uint8Array(N); // 0 = 未赋值
  const { anchorX: AX, anchorZ: AZ, kind: K, style: S, heightDm: HD, vertStart: VS, vertCount: VC, offs } = P;
  names = names || {};
  const set = (i, c, r) => {
    if (c < 0) return;
    if (src[i] === 0 || r < src[i]) {
      cls[i] = c;
      src[i] = r;
    }
  };

  // 1. 名称
  for (const key in names) {
    const i = +key;
    if (i >= 0 && i < N) set(i, classByName(names[key]), 1);
  }
  // 2. 明确的 OSM kind
  for (let i = 0; i < N; i++) {
    const k = K[i];
    if (k === 5) set(i, C.CUL, 2);
    else if (k === 6) set(i, C.TRA, 2);
    else if (k === 8) set(i, C.HOT, 2);
    else if (k === 7) set(i, C.EDU, 7); // 学校/医院二义：优先让 POI/名称决定，兜底为教育
  }

  // 建筑锚点网格（100 m）
  const G = 100;
  const bgrid = new Map();
  for (let i = 0; i < N; i++) {
    const k = Math.floor(AX[i] / G) * 100003 + Math.floor(AZ[i] / G);
    let a = bgrid.get(k);
    if (!a) bgrid.set(k, (a = []));
    a.push(i);
  }
  const contains = (i, x, z) => {
    const s = VS[i] * 2, n = VC[i];
    const lx = (x - AX[i]) * 10, lz = (z - AZ[i]) * 10;
    let c = false;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const xa = offs[s + a * 2], za = offs[s + a * 2 + 1], xb = offs[s + b * 2], zb = offs[s + b * 2 + 1];
      if (za > lz !== zb > lz && lx < ((xb - xa) * (lz - za)) / (zb - za) + xa) c = !c;
    }
    return c;
  };
  const near = (x, z, R, fn) => {
    const r = Math.ceil(R / G) + 1, ci = Math.floor(x / G), cj = Math.floor(z / G);
    for (let i = ci - r; i <= ci + r; i++)
      for (let j = cj - r; j <= cj + r; j++) {
        const a = bgrid.get(i * 100003 + j);
        if (a) for (const b of a) fn(b, Math.hypot(AX[b] - x, AZ[b] - z));
      }
  };

  // 3/4. POI
  for (const p of pois?.pois || []) {
    let c = POI_K[p.k];
    const byName = classByName(p.n);
    if (p.k === 'landmark' || c == null) c = byName;
    else if (byName >= 0 && byName !== C.RES && byName !== C.OFF && byName !== C.COM) c = byName; // “XX医院”被标成 shop 等情况
    if (c == null || c < 0 || c === C.RES) continue;
    const weak = POI_WEAK.has(p.k);
    let hit = -1, hd = 30;
    near(p.x, p.z, 60, (b, d) => {
      if (d < 250 && contains(b, p.x, p.z)) { hit = b; hd = -1; }
      else if (hd >= 0 && d < hd) { hit = b; hd = d; }
    });
    if (hit >= 0 && !(weak && (K[hit] === 1 || K[hit] >= 3))) set(hit, c, weak ? 6 : 3);
    const R = POI_CAMPUS[p.k];
    if (R) near(p.x, p.z, R, (b, d) => { if (d < R && K[b] !== 1 && K[b] !== 5 && K[b] !== 6) set(b, c, 4); });
  }

  // 5~8. 用地 + kind + style
  const lu = landuseLocator(landuse);
  for (let i = 0; i < N; i++) {
    if (src[i] && src[i] <= 4) continue;
    const H = HD[i] * 0.1;
    const sf = S ? S[i] >> 4 : 0;
    const k = K[i];
    const p = lu(AX[i], AZ[i]);
    const luC = p ? LANDUSE_K[p.k] : -1;
    if (luC === C.EDU && H < 80) { set(i, C.EDU, 5); continue; }
    if (k === 1) set(i, C.RES, 6);
    else if (k === 2) set(i, sf === 5 || (sf !== 6 && H >= 40) ? C.OFF : C.COM, 6);
    else if (k === 3) set(i, C.IND, 6);
    else if (k === 4) set(i, luC === C.IND ? C.IND : C.GOV, 6);
    if (src[i]) continue;
    if (luC >= 0) {
      if (luC === C.COM && (sf === 5 || H >= 50)) set(i, C.OFF, 7);
      else set(i, luC, 7);
      continue;
    }
    const fromStyle = sf >= 1 && sf <= 4 ? C.RES : sf === 5 ? C.OFF : sf === 6 ? C.COM : sf === 7 ? C.IND : sf === 8 ? C.GOV : -1;
    if (fromStyle >= 0) set(i, fromStyle, 8);
  }

  // 统计
  const byClass = new Array(BLD_CLASSES.length).fill(0);
  const bySrc = new Array(9).fill(0);
  for (let i = 0; i < N; i++) {
    byClass[cls[i]]++;
    bySrc[src[i]]++;
  }
  return { cls, src, stats: { total: N, byClass, bySrc, classified: N - byClass[0] } };
}

/** 平铺成着色器可读的 R8 数据：每行 1024 栋（与 bld-gen 数据纹理同行布局） */
export function classTextureData(cls) {
  const rows = Math.max(1, Math.ceil(cls.length / 1024));
  const a = new Uint8Array(rows * 1024);
  a.set(cls);
  return { data: a, width: 1024, height: rows };
}
