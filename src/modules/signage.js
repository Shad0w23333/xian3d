// 街道招牌与广告（门头招牌 / 挑出竖牌 / 楼顶大字 / LED 滚动屏 / 霓虹 / 公交站台 / 地铁出入口）
//
// 设计要点（性能关键）：
//  · 文字全部画进 4096² Canvas 图集（signagePaint.js：行段 1024×72 px，按 250 m 区块流式分配/回收），
//    一个 InstancedMesh（单位盒子 + 每实例 UV 矩形 / 发光 / 模式 / 标志位）画出所有招牌、灯箱、滚动屏、灯带、立柱；
//    公交候车亭、地铁出入口雨棚各一个 InstancedMesh（合并几何 + 顶点色）。总 draw call = 3（开阴影时 +2）。
//  · 招牌挂在 POI 最近建筑的“临街”外墙（signageIndex.findFacade：距离 + 外侧到路缘距离评分；首选立面挂不下依次换候选）。
//  · 门头带：首层高 / 地面基准 / 立面风格直接取 buildings 模块渲染用的参数（nearestFacade：groundFloorH、ground、style、street），
//    招牌一律挂在首层橱窗之上、二层窗台之下（与立面着色器 bld-shader.js 的“招牌带”同一高度），同一栋楼底商同底同高连成一条，
//    主次干道的铺面排再衬一条门头底板。不再有“二楼招牌”。
//  · 店名：真实 POI（pois.json，按重要度排序先占位）优先；补充门头按街道等级选业态——主干道为银行/品牌零售/连锁酒店与餐饮，
//    次干道一半品牌一半体面小店，支路小巷才是小吃与杂货；3×3 区块内不重名。
//  · 只在相机 R（画质：0.7/1.1/1.6/2.0 km）内生成；补充门头（通用店名，共享图集单元）只在 fillR 内。
//  · 夜景：灯箱整面发光、发光字仅字形发光、霓虹（闪烁 / 逐字点亮 / 呼吸）、LED 滚动屏（白天也亮），均 × uNight；
//    发光强度按招牌自身最亮颜色归一（signageStyle.capGlow），灯箱压在泛光阈值下不糊字，霓虹/发光字略超阈值保留光晕。
//  · 地铁出入口：通用建筑里落在出入口点上的小体量轮廓（CMAB 把出入口雨棚提取成了“楼”）在 prepare 里登记排除区让位，
//    由本模块生成标准雨棚；这类小楼也不挂店招。
//
// 参考：research/refs/signage/（北院门夜景 LED 竖招、西安地铁出入口与标志、东大街夜景）。
// 样式约定（银行统一色、品牌配色、回民街黑漆金字 + 红绿 LED 竖招）见 src/arch/signageStyle.js。
import * as THREE from 'three';
import { parseBuildings, BuildingIndex, RoadIndex, findFacade } from '../arch/signageIndex.js';
import { pickStyle, signText, districtOf, hash01, strHash, MALL_RE, ROOF_NAME_RE, capGlow, GLOW_CAP, FILL_MAIN, FILL_OK } from '../arch/signageStyle.js';
import { pointInPoly } from '../core/util.js';
import {
  SignAtlas, PAGE, ROW, PAD, CH, SEG, STATIC, measureSign, paintSign, paintStatic, staticRect,
  measureMetroHeader, paintMetroHeader, measureExitLetter, paintExitLetter, measureBusName, paintBusName,
} from '../arch/signagePaint.js';

const C = 250; // 流式区块边长（米）
const STRIDE = 28; // 每实例：矩阵 16 + UV 4 + 效果 4 + 颜色/粗糙度 4
const CAP_SIGN = 20000, CAP_SHELTER = 600, CAP_CANOPY = 600;
// 实例标志位
const F_VERT = 1, F_DOUBLE = 2, F_CUT = 4, F_PAGE1 = 8, F_EMIT = 32, F_STRETCH = 64, F_TICKER = 128;
const GLOW_K = 0.95;
// 固定样式招牌的夜间发光（按其最亮颜色归一到泛光阈值附近，见 signageStyle.GLOW_CAP）：地铁门头/出口字母（黄字）、
// 地铁标志（白色垛口）、顶棚灯带（细条，允许光晕）、公交站名与灯箱海报（白字/浅底）
const G_METRO = 1.15, G_LOGO = 0.95, G_STRIP = 1.35, G_BUS = 0.8;

// 补充门头：一条临街立面是“铺面排”的概率（按 buildings 渲染风格 STYLE：0 高层住宅 1 老式多层 2 玻璃幕墙办公 3 石材办公
// 4 商业裙房 5 城中村 6 工业 7 公共建筑 8 酒店 9 传统风貌；-1 = 未加载通用建筑模块），[主干/次干, 支路/小巷]
const ROW_P = [[0.9, 0.62], [0.9, 0.7], [0.6, 0.22], [0.6, 0.22], [0.97, 0.85], [0.9, 0.85], [0, 0], [0, 0], [0.5, 0.3], [0.9, 0.85]];
const ROW_P_UNKNOWN = [0.7, 0.45];
// 地铁出入口让位：出入口点 EXIT_R 米内、面积 < EXIT_AREA m²、高 < EXIT_H m 的通用建筑轮廓视为被误提取的出入口雨棚
const EXIT_R = 6, EXIT_AREA = 200, EXIT_H = 8;

// 招牌类型的几何与发光参数（H 高 m，D 厚 m，lit 夜间发光系数，rough 面板粗糙度）
const TYPE = {
  lightbox: { H: 1.25, D: 0.22, lit: 1.0, rough: 0.28 },
  plaque: { H: 1.0, D: 0.08, lit: 0.42, rough: 0.5 },
  trad: { H: 0.95, D: 0.12, lit: 0.55, rough: 0.32 },
  led: { H: 1.1, D: 0.1, lit: 0.8, rough: 0.55 },
  neon: { H: 0.9, D: 0.05, lit: 0.85, rough: 0.6 },
};
const SIGN_KINDS = new Set([
  'shop', 'restaurant', 'fast_food', 'cafe', 'bank', 'atm', 'hotel', 'motel', 'hostel', 'guest_house', 'pharmacy',
  'post_office', 'clinic', 'dentist', 'ice_cream', 'bar', 'pub', 'karaoke_box', 'cinema', 'marketplace', 'food_court',
  'nightclub', 'internet_cafe', 'theatre', 'mall', 'supermarket', 'bakery', 'doctors',
]);
const HOTEL = new Set(['hotel', 'motel', 'hostel', 'guest_house']);
const NAME_SKIP = /小区|公寓|住宅|宿舍|家属|号楼|栋|单元|幢|期$|工地|围挡/;

// —— 补充门头的通用店名（不含真实连锁品牌；老字号式“X记/老X家”为常见命名方式） ——
const FILL_FOOD = [
  '老王家凉皮', '秦味肉夹馍', '西府臊子面', '陕西油泼面', '关中羊肉泡馍', '兰州牛肉拉面', '老碗面馆', '张记水盆羊肉',
  '刘记烤肉', '秦镇米皮', '回坊烤肉', '重庆小面', '麻辣烫', '砂锅米线', '东北饺子馆', '黄焖鸡米饭', '家常菜馆',
  '川味小炒', '湘菜馆', '手工水饺', '鲜肉包子', '胡辣汤', '粥铺早餐', '烧烤', '串串香', '老火锅', '酸菜鱼',
  '饸饹面', '铁板烧', '面包坊', '蛋糕烘焙', '鲜榨果汁', '炸鸡汉堡', 'biangbiang面', '葫芦头泡馍', '腊汁肉夹馍',
  '裤带面', '岐山面馆', '汉中热米皮', '烤鱼', '牛肉面', '冒菜', '石锅拌饭', '水煎包',
];
const FILL_SHOP = [
  '诚信烟酒', '名烟名酒', '便民超市', '好又多便利店', '明视眼镜', '鑫源通讯', '手机维修', '丽人美发', '美容美甲',
  '足道养生', '大众药房', '康民大药房', '鲜果时光', '花语鲜花', '洁净干洗', '五金建材', '文具复印', '图文快印',
  '时尚女装', '男装折扣', '品牌鞋店', '母婴用品', '茗茶茶叶', '家电维修', '开锁换锁', '中国福利彩票', '中国体育彩票',
  '房产中介', '宠物用品', '烟酒副食', '粮油店', '干果炒货', '口腔诊所', '中医推拿', '健身会所', '婚纱摄影',
  '数码冲印', '内衣店', '童装', '化妆品', '床上用品', '钟表维修', '棋牌室', '书画装裱', '烟酒茶',
];
const FILL_HUIMIN = [
  '腊牛羊肉', '黄桂柿子饼', '镜糕', '粉蒸肉', '酸梅汤', '牛羊肉泡馍', '回民烤肉', '甑糕', '炒米', '肉丸胡辣汤',
  '灌汤包子', '麻酱凉皮', '红柳烤肉', '粉汤羊血', '小酥肉', '柿子饼', '石子馍', '清真糕点', '牛肉饼', '羊肉串',
];
const FILL_VERT = ['住宿', '旅馆', '烟酒', '美发', '足疗', '药房', '按摩', '棋牌', '网吧', '宾馆', '烤肉', '凉皮', '面馆', '超市', '彩票', '茶楼', '火锅', '泡馍'];
const TICKERS = {
  bank: '欢迎光临　竭诚为您服务　理财咨询请到大堂　',
  pharm: '医保定点药店　24小时营业　买药请出示医保卡　',
  hotel: '欢迎光临　钟点房　热水空调　宽带上网　',
  food: '欢迎品尝　正宗陕西风味　外卖热线　',
};

const LINE_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十四: 14, 十五: 15, 十六: 16 };

const col = (hex) => new THREE.Color(hex);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let preparedBuffer = null;
let prepared = null; // { P, bi, exitBoxes }

/**
 * 地铁出入口让位（prepare 阶段，早于通用建筑模块的让位预处理）：OSM 出入口点落在（或紧贴）一栋小体量通用建筑上，
 * 多半是 CMAB 把出入口雨棚/风亭提取成了“楼”，通用建筑模块会把它画成卷帘门商铺盒子。登记该轮廓为排除区让其让位，
 * 出入口由本模块生成标准雨棚（planMetro）；同时记下这些楼，万一仍被渲染也不挂店招。
 */
function clearMetroExits(ctx) {
  const P = parseBuildings(preparedBuffer || (ctx.data && ctx.data.buildings));
  if (!P) return;
  const bi = new BuildingIndex(P, null);
  const exitBoxes = new Set();
  prepared = { P, bi, exitBoxes };
  const ex = ctx.exclusions;
  for (const p of (ctx.data.pois && ctx.data.pois.pois) || []) {
    if (!p || p.k !== 'subway_entrance' || Math.abs(p.x) > 16500 || Math.abs(p.z) > 16500) continue;
    bi.candidates(p.x, p.z, EXIT_R, (b) => {
      if (exitBoxes.has(b) || P.minDm[b] !== 0 || P.hDm[b] >= EXIT_H * 10) return;
      if (bi.area(b) >= EXIT_AREA || bi.distTo(b, p.x, p.z) > EXIT_R) return;
      exitBoxes.add(b);
      if (!ex) return;
      const pts = [];
      for (let j = 0; j < P.vc[b]; j++) pts.push(bi.vx(b, j), bi.vz(b, j));
      ex.add({ points: pts, name: 'signage-metro-exit' }, { buildings: true, trees: false, roads: false, pois: false, maxHeight: EXIT_H });
    }, true);
  }
  if (exitBoxes.size) console.log(`[signage] 地铁出入口处 ${exitBoxes.size} 个小体量通用建筑让位给出入口雨棚`);
}

export default {
  id: 'signage',
  name: '街道招牌与广告',
  prepare(ctx) {
    // 通用建筑模块可能把 buildings.bin 转交 Worker（ArrayBuffer 被分离），这里先复制一份只读副本
    const buf = ctx.data && ctx.data.buildings;
    if (buf && buf.byteLength) preparedBuffer = buf.slice(0);
    prepared = null;
    try {
      clearMetroExits(ctx);
    } catch (e) {
      console.warn('[signage] 地铁出入口让位失败', e);
    }
  },
  async build(ctx) {
    const s = new Signage(ctx);
    return s.init();
  },
};

/** 规划阶段的实例收集器（纯 CPU，结果缓存） */
class Plan {
  constructor() {
    this.a = [];
    this.keys = [];
    this.reqs = new Map();
    this.sh = [];
    this.cn = [];
  }
  /** 盒子：背面中心 (x,y,z)，正面朝 (nx,nz)；W 宽 H 高 D 厚 */
  sign(x, y, z, nx, nz, W, H, D, key, glow, mode, phase, flags, c, rough) {
    this.a.push(nz * W, 0, -nx * W, 0, 0, H, 0, 0, nx * D, 0, nz * D, 0, x, y, z, 1, 0, 0, 0, 0, glow, mode, phase, flags, c.r, c.g, c.b, rough);
    this.keys.push(key);
  }
  struct(list, x, y, z, fx, fz) {
    list.push(fz, 0, -fx, 0, 0, 1, 0, 0, fx, 0, fz, 0, x, y, z, 1);
  }
  finish() {
    return {
      a: new Float32Array(this.a), keys: this.keys, reqs: this.reqs,
      sh: new Float32Array(this.sh), cn: new Float32Array(this.cn), n: this.keys.length,
    };
  }
}

class Signage {
  constructor(ctx) {
    this.ctx = ctx;
    this.chunks = new Map();
    this.live = new Set();
    this.occ = new Map();
    this.roofed = new Set();
    this.dirty = true;
    this.frame = 0;
    this.lastCam = new THREE.Vector3(1e9, 0, 1e9);
    this.wanted = [];
    this.hot = 0; // 相机跳变后加大每帧预算
    this.visible = true;
    this.setQuality(ctx.quality || {});
  }

  setQuality(q) {
    const lv = q.level != null ? q.level : 2;
    this.level = lv;
    this.R = [700, 1100, 1600, 2000][clamp(lv, 0, 3)];
    this.fillR = [260, 380, 520, 680][clamp(lv, 0, 3)];
    this.lastCam.set(1e9, 0, 1e9);
  }

  init() {
    const ctx = this.ctx;
    const t0 = performance.now();
    if (prepared && prepared.P) {
      // 复用 prepare 阶段建好的索引（prepare 只做几何遍历，未缓存 usable 状态）
      this.P = prepared.P;
      this.bi = prepared.bi;
      this.bi.exclusions = ctx.exclusions;
    } else {
      this.P = parseBuildings(preparedBuffer || ctx.data.buildings);
      this.bi = new BuildingIndex(this.P, ctx.exclusions);
    }
    this.exitBoxes = (prepared && prepared.exitBoxes) || new Set();
    // 通用建筑模块的立面参数查询（首层高、地面基准、风格、临街），与渲染一致；未加载该模块时按默认值估计
    const bm = ctx.modules && ctx.modules.buildings;
    this.nf = bm && typeof bm.nearestFacade === 'function' ? bm.nearestFacade : null;
    this.bcache = new Map();
    // nearestFacade 首次调用会建全城外墙网格（十几毫秒）：放在加载阶段建好，免得第一次流式规划时卡一帧
    if (this.nf) this.nf(0, 0, 1);
    this.ri = new RoadIndex(ctx.data.roads);
    const cls = this.ri.cls;
    const bad = new Set([cls.motorway, cls.motorway_link, cls.footway, cls.service]);
    this.acceptMain = (c) => !bad.has(c);
    const names = ctx.data.roads.classes || [];
    const ci = (n) => names.indexOf(n);
    const fillCls = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'pedestrian', 'footway', 'primary_link', 'secondary_link'].map(ci));
    this.acceptFill = (c, b) => fillCls.has(c) && !b;
    // 与 buildings 模块判定“临街底商边”所用道路一致（src/modules/buildings.js packRoads）
    const bldCls = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'pedestrian'].map(ci));
    this.acceptBld = (c) => bldCls.has(c);
    // 街道等级：0 主干（trunk/primary）1 次干（secondary/匝道）2 支路（tertiary）3 小路（residential/unclassified/footway）4 步行街
    this.grade = new Map([[ci('trunk'), 0], [ci('primary'), 0], [ci('secondary'), 1], [ci('primary_link'), 1], [ci('secondary_link'), 1], [ci('tertiary'), 2], [ci('pedestrian'), 4]]);
    this.acceptMajor = (c, b) => !b && this.grade.has(c) && this.grade.get(c) <= 1;
    this.groundOK = (b) => this.P.minDm[b] === 0 && !this.exitBoxes.has(b);
    this.clsFootway = ci('footway');
    // 高校/中小学校园、军事管理区内部：楼前是校园步道，不补沿街门头（只有面向主次干道的楼才可能有底商）
    this.inCampus = landIndex(ctx.data.landuse, new Set(['university', 'military']));
    this.buildSubway(ctx.data.rail, ctx.data.amapExtra?.metro);
    this.bucketPOIs((ctx.data.pois && ctx.data.pois.pois) || []);
    this.bucketBus(ctx.data.roads);
    this.bucketNamed(ctx.data.buildingNames || {});
    this.initRender();
    this.initShared();
    this.tInit = performance.now() - t0;
    const self = this;
    return {
      update(dt, t) { self.update(dt, t); },
      setQuality(q) { self.setQuality(q); },
      // 招牌挂在建筑上：随“建筑”图层显隐（labels / traffic 等图层与本模块无关）
      setLayer(name, on) { if (name === 'buildings' || name === 'signage') self.setVisible(on); },
      setVisible(on) { self.setVisible(on); },
      stats() { return self.stats(); },
      /** 诊断：(x,z) 半径 r 内已上屏的招牌实例 {k 单元键, x, y 离地, z, W, H, g 发光} */
      diag(x, z, r = 60) { return self.diag(x, z, r); },
      dispose() { self.dispose(); },
    };
  }

  // ———————————————————— 数据分桶 ————————————————————
  chunk(cx, cz, create = true) {
    const k = (cx + 512) * 1024 + (cz + 512);
    let ch = this.chunks.get(k);
    if (!ch && create) {
      ch = { k, cx, cz, x: (cx + 0.5) * C, z: (cz + 0.5) * C, pois: [], bus: [], named: [], plan: null, fill: null, live: false, fillOn: false, segs: [], d: 0 };
      this.chunks.set(k, ch);
    }
    return ch;
  }
  chunkAt(x, z) {
    return this.chunk(Math.floor(x / C), Math.floor(z / C));
  }
  /** 点是否只落在 skyline 模块的单栋高楼排除区内（不在其他精建片区/档案建筑里） */
  inSkyline(x, z) {
    const ex = this.ctx.exclusions;
    const list = ex && ex.grid ? ex.grid.get(Math.floor(x / ex.cell) * 100003 + Math.floor(z / ex.cell)) : null;
    if (!list) return false;
    let hit = false;
    for (const it of list) {
      if (!it.flags.pois) continue;
      const b = it.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || !pointInPoly(x, z, it.p)) continue;
      if (it.name !== 'skyline' || (b.x1 - b.x0) * (b.z1 - b.z0) > 40000) return false;
      hit = true;
    }
    return hit;
  }
  bucketPOIs(pois) {
    const ex = this.ctx.exclusions;
    this.orphans = new WeakSet();
    let n = 0;
    for (const p of pois) {
      if (!p || !p.n || Math.abs(p.x) > 16500 || Math.abs(p.z) > 16500) continue;
      const k = p.k;
      const metro = k === 'subway_entrance';
      const brandLandmark = k === 'landmark' && /银行|中国移动|中国联通|中国电信|邮政|酒店|宾馆|饭店/.test(p.n);
      const roofLandmark = k === 'landmark' && ROOF_NAME_RE.test(p.n) && !NAME_SKIP.test(p.n);
      if (!metro && !SIGN_KINDS.has(k) && !brandLandmark && !roofLandmark) continue;
      if (ex && ex.test(p.x, p.z, 'pois')) {
        // 落在现代地标高楼（skyline）轮廓里的底商 POI：高楼模型本身不画沿街门头，原先这些真实店名（南大街百货大厦里的
        // 中国银行、百货大厦酒店……）整条丢掉，街面只剩随机店名。改为挂到紧邻的临街通用建筑（多为该楼的裙房）上
        if (metro || !SIGN_KINDS.has(k) || MALL_RE.test(p.n) || !this.inSkyline(p.x, p.z)) continue;
        this.orphans.add(p);
      }
      this.chunkAt(p.x, p.z).pois.push(p);
      n++;
    }
    this.nPois = n;
    // 重要的先占位（地铁口 > 重要度 > 银行/酒店/商场），同一立面挂不下时次要店铺换到旁边的立面
    const pri = (p) => (p.k === 'subway_entrance' ? 100 : 0) + (p.i || 0) * 10 + (p.k === 'bank' || HOTEL.has(p.k) || MALL_RE.test(p.n) ? 5 : 0);
    for (const ch of this.chunks.values()) if (ch.pois.length > 1) ch.pois.sort((a, b) => pri(b) - pri(a));
  }
  /** 公交站候选点：沿有名称的主干道（trunk/primary/secondary，非桥非隧）每 ~520 m 一处，双向道路两侧各一 */
  bucketBus(roads) {
    const feats = (roads && roads.features) || [];
    const cls = roads.classes || [];
    const ok = new Set(['trunk', 'primary', 'secondary'].map((n) => cls.indexOf(n)));
    const SP = 520;
    for (let fi = 0; fi < feats.length; fi++) {
      const f = feats[fi];
      if (!ok.has(f.c) || f.b || f.t || !f.n || !f.p || f.p.length < 4) continue;
      const p = f.p;
      if (Math.abs(p[0]) > 15000 || Math.abs(p[1]) > 15000) continue;
      let next = 120 + hash01(fi * 31 + 7) * 300, s = 0;
      for (let i = 2; i < p.length; i += 2) {
        const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az, L = Math.hypot(dx, dz);
        if (L < 1e-3) continue;
        while (next <= s + L) {
          const t = (next - s) / L;
          const x = ax + dx * t, z = az + dz * t;
          const sides = f.o ? [1] : [1, -1];
          for (const side of sides) {
            const off = side > 0 ? 0 : 45; // 对向站台错开
            const xx = x + (dx / L) * off * -1, zz = z + (dz / L) * off * -1;
            this.chunkAt(xx, zz).bus.push({ x: xx, z: zz, dx: (dx / L) * side, dz: (dz / L) * side, fi, w: f.w || 12 });
          }
          next += SP;
        }
        s += L;
      }
    }
  }
  bucketNamed(names) {
    const P = this.P;
    if (!P) return;
    for (const key in names) {
      const b = +key, nm = names[key];
      if (!(b >= 0 && b < P.count) || !nm) continue;
      if (!ROOF_NAME_RE.test(nm) || NAME_SKIP.test(nm)) continue;
      if (P.hDm[b] < 300) continue; // ≥ 30 m 才做楼顶字
      const x = P.ax[b], z = P.az[b];
      if (Math.abs(x) > 16500 || Math.abs(z) > 16500) continue;
      this.chunkAt(x, z).named.push(b);
    }
  }
  buildSubway(rail, amapMetro) {
    const segs = [];
    // 高德地铁线网（全线、含 OSM 缺的新线）优先；OSM 线段照常加入，重合处取最近距离不受影响
    for (const L of amapMetro || []) {
      const p = L.p;
      if (L.num) for (let i = 2; i < p.length; i += 2) segs.push(p[i - 2], p[i - 1], p[i], p[i + 1], L.num);
    }
    const feats = (rail && rail.features) || [];
    const ci = (rail && rail.classes ? rail.classes : []).indexOf('subway');
    for (const f of feats) {
      if (f.c !== ci || !f.n || /出入段|联络|停车场|试车|车辆段|支线/.test(f.n)) continue;
      const m = f.n.match(/(\d+|[一二三四五六七八九十]+)号线/);
      if (!m) continue;
      const num = /\d/.test(m[1]) ? +m[1] : LINE_NUM[m[1]];
      if (!num) continue;
      const p = f.p;
      for (let i = 2; i < p.length; i += 2) segs.push(p[i - 2], p[i - 1], p[i], p[i + 1], num);
    }
    this.subSegs = new Float32Array(segs);
  }
  linesAt(x, z) {
    const s = this.subSegs;
    const best = new Map();
    for (let o = 0; o < s.length; o += 5) {
      const ax = s[o], az = s[o + 1], dx = s[o + 2] - ax, dz = s[o + 3] - az;
      if (Math.abs(ax - x) > 900 || Math.abs(az - z) > 900) continue;
      const L2 = dx * dx + dz * dz || 1e-6;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      const n = s[o + 4];
      if (!best.has(n) || best.get(n) > d) best.set(n, d);
    }
    let arr = [...best].filter(([, d]) => d < 260).map(([n]) => n);
    if (!arr.length && best.size) arr = [[...best].sort((a, b) => a[1] - b[1])[0]].filter(([, d]) => d < 650).map(([n]) => n);
    return arr.sort((a, b) => a - b).slice(0, 3);
  }

  // ———————————————————— 渲染对象 ————————————————————
  initRender() {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    const aniso = Math.min(renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 8, (ctx.quality && ctx.quality.anisotropy) || 8);
    this.atlas = new SignAtlas(THREE, renderer, { maxPages: this.level >= 2 ? 2 : 1, anisotropy: aniso });
    this.atlas.addPage();
    paintStatic(this.atlas);
    this.uniforms = { uPage0: { value: this.atlas.pages[0].tex }, uPage1: { value: this.atlas.pages[0].tex }, uTime: ctx.uniforms.uTime, uNight: ctx.uniforms.uNight };
    this.atlas.onPage = (page) => {
      if (page.index === 1) this.uniforms.uPage1.value = page.tex;
    };

    // 招牌单位盒：x,y ∈ [-0.5,0.5]，z ∈ [0,1]（背面贴墙）；aFace 1=正面(+z) 2=背面 0=侧面
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0, 0.5);
    const face = new Float32Array(24);
    for (let i = 16; i < 20; i++) face[i] = 1;
    for (let i = 20; i < 24; i++) face[i] = 2;
    box.setAttribute('aFace', new THREE.BufferAttribute(face, 1));
    box.deleteAttribute('uv');
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.08, emissive: 0x000000 });
    const U = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aUV; attribute vec4 aFx; attribute vec4 aCol; attribute float aFace;
varying vec2 vST; varying vec4 vUV; varying vec4 vFx; varying vec4 vCol; varying float vFace;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
vUV = aUV; vFx = aFx; vCol = aCol; vFace = aFace;
{
  int fl = int(aFx.w + 0.5);
  float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
  vec2 bxy = position.xy + 0.5;
  if (aFace > 1.5) bxy.x = 1.0 - bxy.x;
  bool vert = (fl & 1) != 0;
  vec2 st = vert ? vec2(1.0 - bxy.y, 1.0 - bxy.x) : vec2(bxy.x, 1.0 - bxy.y);
  float Ls = vert ? sy : sx, Lt = vert ? sx : sy;
  float Ab = Ls / max(Lt, 1e-4);
  float Ac = aUV.z / max(aUV.w, 1e-6);
  if ((fl & 64) == 0 && aUV.z > 0.0) {
    if ((fl & 128) != 0) st.x *= Ab / Ac;
    else if (Ab > Ac) st.x = (st.x - 0.5) * (Ab / Ac) + 0.5;
    else st.y = (st.y - 0.5) * (Ac / Ab) + 0.5;
  }
  vST = st;
}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uPage0; uniform sampler2D uPage1; uniform float uTime; uniform float uNight;
varying vec2 vST; varying vec4 vUV; varying vec4 vFx; varying vec4 vCol; varying float vFace;`)
        .replace('#include <map_fragment>', `
int sfl = int(vFx.w + 0.5);
bool sTex = vUV.z > 0.0 && vFace > 0.5 && (vFace < 1.5 || (sfl & 2) != 0);
bool sCut = (sfl & 4) != 0;
if (sCut && !sTex) discard;
vec3 sEm = vCol.rgb;
vec2 sst = vST;
if (sTex) {
  if ((sfl & 128) != 0) sst.x = fract(sst.x + uTime * 0.075 + vFx.z);
  vec2 se = vec2(1.5 / (vUV.z * ${PAGE}.0), 1.5 / (vUV.w * ${PAGE}.0));
  sst = clamp(sst, se, 1.0 - se);
  vec2 suv = vUV.xy + sst * vUV.zw;
  vec4 tx = (sfl & 8) != 0 ? texture(uPage1, suv) : texture(uPage0, suv);
  if (sCut) { if (tx.a < 0.45) discard; tx.rgb /= tx.a; tx.a = 1.0; }
  sEm = tx.rgb;
  diffuseColor.rgb = tx.rgb + vCol.rgb * (1.0 - tx.a);
} else {
  diffuseColor.rgb = vCol.rgb;
}`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vCol.a;')
        .replace('#include <emissivemap_fragment>', `{
  float k = uNight;
  float md = vFx.y;
  if (md > 0.5 && md < 1.5) {
    float c = fract(uTime * 0.37 + vFx.z * 7.0);
    float h = fract(sin(floor(uTime * 11.0) + vFx.z * 91.0) * 43758.5);
    k *= c < 0.7 ? 1.0 : (h > 0.45 ? 1.0 : 0.05);
  } else if (md > 2.5 && md < 3.5) {
    float p = fract(uTime * 0.2 + vFx.z) * 1.5;
    k *= sst.x < p ? 1.0 : 0.08;
  } else if (md > 3.5) {
    k *= 0.5 + 0.5 * sin(uTime * 2.4 + vFx.z * 6.283);
  }
  if (md > 1.5 && md < 2.5) k = max(k, 0.55);
  if (sTex || (sfl & 32) != 0) {
    // 发光强度已按招牌自身最亮颜色归一（CPU 端 capGlow）；这里再按像素亮度兜底钳制，任何像素都不远超泛光阈值
    vec3 se = sEm * vFx.x * k;
    float sl = dot(se, vec3(0.2126, 0.7152, 0.0722));
    totalEmissiveRadiance = se * min(1.0, 1.5 / max(sl, 1e-4));
  }
}`);
    };
    mat.customProgramCacheKey = () => 'signage-v2';
    const mesh = new THREE.InstancedMesh(box, mat, CAP_SIGN);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'signage-signs';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const mk = (name) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(CAP_SIGN * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      box.setAttribute(name, a);
      return a;
    };
    this.aUV = mk('aUV');
    this.aFx = mk('aFx');
    this.aCol = mk('aCol');
    this.signs = mesh;

    const smat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.35 });
    this.shelters = new THREE.InstancedMesh(shelterGeometry(), smat, CAP_SHELTER);
    this.canopies = new THREE.InstancedMesh(canopyGeometry(), smat, CAP_CANOPY);
    for (const m of [this.shelters, this.canopies]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = !!(ctx.quality && ctx.quality.shadows);
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.shelters.name = 'signage-busstops';
    this.canopies.name = 'signage-metro';
    this.group = new THREE.Group();
    this.group.name = 'signage';
    this.group.add(mesh, this.shelters, this.canopies);
    ctx.scene.add(this.group);
  }

  /** 常驻单元：补充店名（横 / 竖）、滚动屏文字、静态区（地铁标志、海报） */
  initShared() {
    this.perm = new Map();
    const reqs = [];
    const add = (key, req) => { this.perm.set(key, null); reqs.push([key, req]); };
    const mkSign = (name, kind, dist, vert) => {
      const s = pickStyle({ n: name, k: kind }, name, dist);
      if (vert && (s.type === 'neon' && !s.back)) s.back = '#141414';
      const m = measureSign(s, name, vert);
      return { kind: 'sign', text: name, s, vert, w: m.w, m };
    };
    this.fillKeys = { food: [], shop: [], food2: [], shop2: [], main: [], mainHotel: [], mainOffice: [], huimin: [], vert: [], vhm: [] };
    FILL_FOOD.forEach((n) => { const k = 'F|f|' + n; add(k, mkSign(n, 'restaurant', 'city', false)); this.fillKeys.food.push(k); if (FILL_OK.has(n)) this.fillKeys.food2.push(k); });
    FILL_SHOP.forEach((n) => { const k = 'F|s|' + n; add(k, mkSign(n, 'shop', 'city', false)); this.fillKeys.shop.push(k); if (FILL_OK.has(n)) this.fillKeys.shop2.push(k); });
    FILL_MAIN.forEach(([kind, n]) => {
      const k = 'F|m|' + n;
      add(k, mkSign(n, kind, 'city', false));
      this.fillKeys.main.push(k);
      if (kind === 'hotel') this.fillKeys.mainHotel.push(k);
      if (kind === 'bank' || kind === 'cafe') this.fillKeys.mainOffice.push(k); // 写字楼底层：银行网点与咖啡
    });
    FILL_HUIMIN.forEach((n) => { const k = 'F|h|' + n; add(k, mkSign(n, 'restaurant', 'huimin', false)); this.fillKeys.huimin.push(k); });
    FILL_VERT.forEach((n) => { const k = 'F|v|' + n; add(k, mkSign(n, 'shop', 'city', true)); this.fillKeys.vert.push(k); });
    FILL_VERT.forEach((n) => { const k = 'F|vh|' + n; add(k, mkSign(n, 'restaurant', 'huimin', true)); this.fillKeys.vhm.push(k); });
    for (const t in TICKERS) {
      const s = { type: 'ticker', fg: t === 'bank' ? '#ff3b1f' : t === 'pharm' ? '#2dff5a' : '#ffb21f' };
      const m = measureSign(s, TICKERS[t], false);
      add('T|' + t, { kind: 'sign', text: TICKERS[t], s, vert: false, w: m.w, m });
    }
    const rects = this.pack(reqs);
    if (rects) for (const [k, r] of rects) this.perm.set(k, r);
    const st = (r) => { const q = staticRect(r); return { u: q[0], v: q[1], du: q[2], dv: q[3], page: 0 }; };
    this.perm.set('@logo', st(STATIC.logo));
    this.perm.set('@board', st(STATIC.board));
    STATIC.posters.forEach((p, i) => this.perm.set('@p' + i, st(p)));
    this.permReq = new Map(reqs);
    this.atlas.flush();
  }

  /**
   * 增量打包：把 st.reqs 逐个画进舞台画布、按行段上传（每次暂停/换段时只上传新画的列）。
   * 返回 true 完成，false 超时暂停（下次继续），null 图集已满（已回滚本次分配的行段）。
   */
  packStep(st, deadline = Infinity) {
    const atlas = this.atlas, g = atlas.g;
    const flush = () => {
      if (st.seg && st.x > st.x0) atlas.uploadRegion(st.seg, st.x0, st.x);
      st.x0 = st.x;
    };
    g.clearRect(0, 0, SEG, ROW); // 舞台可能被别的区块用过；已上传部分不会再传
    while (st.i < st.reqs.length) {
      const [key, req] = st.reqs[st.i];
      const w = Math.min(SEG - 8, req.w);
      if (!st.seg || st.x + w > SEG - 3) {
        flush();
        const seg = atlas.alloc();
        if (!seg) {
          for (const sg of st.segs) atlas.free(sg);
          st.segs = [];
          return null;
        }
        st.segs.push(seg);
        st.seg = seg;
        st.x = st.x0 = 3;
        g.clearRect(0, 0, SEG, ROW);
      }
      paintReq(g, st.x, PAD, w, req);
      const seg = st.seg;
      st.rects.set(key, { u: (seg.x + st.x) / PAGE, v: (seg.y + PAD) / PAGE, du: w / PAGE, dv: CH / PAGE, page: seg.page });
      st.x += w + 7;
      st.i++;
      if (performance.now() > deadline && st.i < st.reqs.length) { flush(); return false; }
    }
    flush();
    return true;
  }
  pack(reqs) {
    const st = { reqs, i: 0, segs: [], rects: new Map(), seg: null, x: 0, x0: 0 };
    return this.packStep(st) ? st.rects : null;
  }

  // ———————————————————— 规划（CPU，缓存） ————————————————————
  occupy(b, e, lvl, a0, a1) {
    const k = b * 4096 + e * 4 + lvl;
    let l = this.occ.get(k);
    if (!l) this.occ.set(k, (l = []));
    for (let i = 0; i < l.length; i += 2) if (a0 < l[i + 1] && a1 > l[i]) return false;
    l.push(a0, a1);
    return true;
  }
  /** 在边 [0,L] 上找宽 W、尽量靠近 c 的空位 → 中心参数，失败返回 null */
  slot(b, e, lvl, L, W, c) {
    const k = b * 4096 + e * 4 + lvl;
    const l = this.occ.get(k) || [];
    const lo = W / 2 + 0.25, hi = L - W / 2 - 0.25;
    if (hi < lo) return null;
    const cands = [clamp(c, lo, hi)];
    for (let i = 0; i < l.length; i += 2) cands.push(l[i + 1] + 0.35 + W / 2, l[i] - 0.35 - W / 2);
    cands.sort((p, q) => Math.abs(p - c) - Math.abs(q - c));
    for (const m of cands) {
      if (m < lo - 1e-3 || m > hi + 1e-3) continue;
      if (this.occupy(b, e, lvl, m - W / 2 - 0.15, m + W / 2 + 0.15)) return m;
    }
    return null;
  }
  req(plan, key, make) {
    let r = plan.reqs.get(key) || this.permReq.get(key);
    if (!r) {
      r = make();
      plan.reqs.set(key, r);
    }
    return r;
  }
  /**
   * 通用建筑的立面参数（与 buildings 模块渲染完全一致）：ga 地面基准（立面分层的零点）、gf 首层高、fh 标准层高、
   * st 渲染风格、street 是否临街、H 楼高。
   * 旧版按 buildings.bin 的 style 字节直接查表——那个字节是“功能 << 4 | 年代”，查出来多半是默认值，
   * 门头高度与立面上实际的首层/橱窗对不上，招牌压到二三层窗户上。
   */
  binfo(b) {
    let I = this.bcache.get(b);
    if (I) return I;
    const P = this.P;
    const H = Math.max(3, P.hDm[b] * 0.1);
    if (this.nf) {
      // 从最长的几条边中点向楼内 5 cm 查最近外墙：命中本楼即读到其参数（与邻楼共墙的边可能命中邻楼，换下一条）
      const n = P.vc[b];
      const es = [];
      for (let e = 0; e < n; e++) es.push(this.edge(b, e));
      const order = es.map((E, e) => e).sort((p, q) => es[q].L - es[p].L);
      for (let k = 0; k < Math.min(4, n) && !I; k++) {
        const E = es[order[k]];
        const r = this.nf(E.ax + E.tx * E.L * 0.5 - E.nx * 0.05, E.az + E.tz * E.L * 0.5 - E.nz * 0.05, 1.5);
        if (r && r.index === b) I = { ga: r.ground, gf: r.groundFloorH, fh: r.floorH, st: r.style, street: !!r.street, H: r.height || H };
      }
    }
    if (!I) I = { ga: this.ctx.terrain.heightAt(P.ax[b], P.az[b]), gf: 4.5, fh: 3.2, st: -1, street: true, H };
    this.bcache.set(b, I);
    return I;
  }
  /** 该边是否画成“临街底商”（与 bld-gen.js 逐边 EF 判定一致：楼临街 + 边外 2 m 处 18 m 内有道路且立面朝向道路） */
  edgeStreet(E, I) {
    if (!I.street || E.L < 3) return false;
    const mx = E.ax + E.tx * E.L * 0.5 + E.nx * 2, mz = E.az + E.tz * E.L * 0.5 + E.nz * 2;
    const r = this.ri.nearest(mx, mz, 18, this.acceptBld);
    if (!r) return false;
    const dx = r.px - mx, dz = r.pz - mz, dl = Math.hypot(dx, dz) || 1;
    return (dx * E.nx + dz * E.nz) / dl > 0.25;
  }
  /**
   * 门头带（相对地面基准 ga，米）：首层橱窗/卷帘门/窗洞顶之上、二层窗台之下。各风格首层布局取自 bld-shader.js：
   * 有“招牌带”的（高层住宅/老式多层临街底商、商业裙房）顶边对齐招牌带，其余贴橱窗顶向上。
   * 返回 {y0 底, h 标准高, top 可加高到的上限} 或 null（无处可挂）。
   */
  band(I, eStreet) {
    const gf = I.gf, H = I.H;
    let shopTop, top, fixTop = null;
    switch (I.st) {
      case 0: shopTop = eStreet ? gf - 1.1 : Math.min(2.6, gf - 0.4); top = gf + 0.05; if (eStreet) fixTop = gf - 0.15; break;
      case 1: shopTop = eStreet ? Math.min(gf - 0.35, 2.9) : 2.45; top = gf + 0.1; if (eStreet && gf > 3.3) fixTop = gf - 0.15; break;
      case 2: shopTop = gf - 0.5; top = gf + 0.75; break;
      case 3: shopTop = gf - 0.8; top = gf + 0.8; break;
      case 4: shopTop = gf - 1.35; top = gf + 0.6; fixTop = gf - 0.1; break;
      case 5: shopTop = Math.min(3.0, gf - 0.3); top = gf + 0.9; break;
      case 6: shopTop = Math.min(4.9, H - 2.4); top = Math.min(H - 1.2, shopTop + 1.6); break; // 厂房：卷帘门以上、高侧窗以下
      case 7: shopTop = gf - 0.85; top = gf + 0.8; break;
      case 8: shopTop = gf - 0.6; top = gf + 0.45; break;
      case 9: shopTop = Math.min(gf - 0.6, 2.6); top = gf + 0.9; break;
      default: shopTop = 2.45; top = Math.max(gf, 3.6); break;
    }
    const lo = Math.max(2.45, shopTop + 0.06);
    top = Math.min(top, H - 0.3);
    if (top - lo < 0.42) return null;
    const h = Math.min(clamp(gf * 0.26, 0.8, 1.3), top - lo);
    const y0 = fixTop != null ? clamp(fixTop - h, lo, top - h) : lo;
    return { y0, h, top };
  }
  edge(b, e) {
    const bi = this.bi, n = this.P.vc[b], j = (e + 1) % n;
    const ax = bi.vx(b, e), az = bi.vz(b, e), bx = bi.vx(b, j), bz = bi.vz(b, j);
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1e-3;
    const sg = bi.orient(b);
    return { ax, az, tx: dx / L, tz: dz / L, L, nx: (dz / L) * sg, nz: (-dx / L) * sg };
  }

  ensurePlan(ch) {
    if (ch.plan) return ch.plan;
    const plan = new Plan();
    if (this.P) {
      for (const p of ch.pois) {
        try {
          if (p.k === 'subway_entrance') this.planMetro(plan, p);
          else this.planPOI(plan, p);
        } catch (e) { /* 单个 POI 失败不影响整体 */ }
      }
      for (const b of ch.named) this.planRoof(plan, b, this.ctx.data.buildingNames[b], null);
    }
    for (const c of ch.bus) this.planBus(plan, c);
    ch.plan = plan.finish();
    return ch.plan;
  }

  planPOI(plan, p) {
    const bi = this.bi, ri = this.ri;
    const text = signText(p.n);
    if (!text || [...text].length < 2) return;
    const k = p.k;
    const isMall = MALL_RE.test(p.n) && (k === 'shop' || k === 'mall' || k === 'landmark');
    if (k === 'landmark' && !/银行|中国移动|中国联通|中国电信|邮政|酒店|宾馆|饭店/.test(p.n)) {
      // 大厦类地标：只做楼顶字
      const b = bi.inside(p.x, p.z);
      if (b >= 0) this.planRoof(plan, b, p.n, null);
      return;
    }
    const dist = districtOf(p.x, p.z);
    const s = pickStyle(p, text, dist);
    const cands = findFacade(bi, ri, p.x, p.z, { maxR: 42, filter: this.groundOK, list: 6 });
    if (!cands.length) return;
    const f0 = cands[0];
    if (f0.inside && f0.d > 16 && !s.bank && !HOTEL.has(k) && !isMall && (p.i || 0) < 2) return; // 商场内部店铺
    const T = TYPE[s.type] || TYPE.lightbox;
    const key = `S|${p.n}|${k}|${dist}`;
    const req = this.req(plan, key, () => {
      const m = measureSign(s, text, false);
      return { kind: 'sign', text, s, vert: false, w: m.w, m };
    });
    const Ac = req.w / CH;
    const imp = p.i || 0;
    const big = imp >= 2 || !!s.bank || HOTEL.has(k) || isMall;
    const r = s.r;
    const target = s.bank ? 8 + r * 4 : HOTEL.has(k) ? 6 + r * 4 : isMall ? 14 + r * 8 : 3.2 + r * 3.8;
    const cut = s.type === 'neon' && !s.back;
    const orphan = this.orphans.has(p); // 所在高楼不画门头，挂到紧邻的临街裙房/底商上
    for (const f of cands) {
      if (f.score > f0.score + 18) break; // 离 POI 太远的立面宁可不挂
      if (orphan && (f.d > 32 || f.inside)) continue;
      const b = f.b, e = f.e;
      const E = this.edge(b, e);
      const L = E.L;
      if (L < 2.4) continue;
      const I = this.binfo(b);
      const eSt = this.edgeStreet(E, I);
      if (orphan && !eSt && !this.ri.nearest(E.ax + E.tx * L * 0.5 + E.nx * 3, E.az + E.tz * L * 0.5 + E.nz * 3, 30, this.acceptMajor, E.tx, E.tz, 0.8)) continue;
      const B = this.band(I, eSt);
      if (!B) continue;
      // 门头带：与同楼补充门头同底；银行/酒店/商场/重要店铺向上加高（不超过二层窗台）
      const H = big ? Math.min(B.top - B.y0, B.h * (isMall ? 1.6 : 1.25)) : B.h;
      const textLen = H * Ac;
      let W = cut ? Math.min(textLen, L - 0.5) : clamp(Math.max(textLen, target), 0, L - 0.5);
      if (W < 1.6) continue;
      const c0 = f.t * L;
      let m = this.slot(b, e, 0, L, W, c0);
      if (m == null && W > Math.min(textLen, L - 0.5) + 0.4) {
        W = Math.max(1.6, Math.min(textLen, L - 0.5)); // 收窄到字宽再试
        m = this.slot(b, e, 0, L, W, c0);
      }
      if (m == null) continue;
      const g0 = I.ga;
      const x = E.ax + E.tx * m + E.nx * 0.05, z = E.az + E.tz * m + E.nz * 0.05;
      if (bi.inside(x + E.nx * 1.2, z + E.nz * 1.2, b) >= 0) continue; // 招牌前方被相邻（重叠）轮廓挡住
      const y = g0 + B.y0 + H / 2;
      const flags = cut ? F_CUT : 0;
      const side = col(s.type === 'lightbox' ? '#8e949a' : s.type === 'led' || s.type === 'neon' ? s.back || '#1a1a1a' : s.frame || s.bg || '#333333');
      const glow = capGlow(s, (s.glow || 1.6) * T.lit * GLOW_K);
      const phase = hash01(s.h + 23);
      plan.sign(x, y, z, E.nx, E.nz, W, H, T.D, key, glow, s.mode || 0, phase, flags, side, T.rough);
      if (s.type === 'lightbox' && imp >= 1 && !cut) {
        // 灯箱顶部的细金属压条（近看有厚度层次）
        plan.sign(x, y + H / 2 + 0.03, z, E.nx, E.nz, W + 0.06, 0.06, T.D + 0.04, null, 0, 0, 0, 0, col('#5d6166'), 0.4);
      }
      // LED 滚动屏（门头下沿）
      if (s.ticker && B.y0 > 2.9) {
        const tk = s.bank ? 'T|bank' : k === 'pharmacy' ? 'T|pharm' : HOTEL.has(k) ? 'T|hotel' : 'T|food';
        const ts = this.permReq.get(tk);
        const tw = Math.min(3.6, W * 0.7), th = 0.3;
        plan.sign(x + E.nx * 0.02, g0 + B.y0 - 0.28, z + E.nz * 0.02, E.nx, E.nz, tw, th, 0.06, tk, ts ? capGlow(ts.s, 2.4 * GLOW_K) : 1.0, 2, phase, F_TICKER, col('#0c0c0c'), 0.35);
      }
      // 挑出式竖牌（酒店竖向灯箱、药店、回民街 LED 竖招）
      if (s.blade) this.planBlade(plan, b, e, E, m + (W / 2 + 0.7) * (hash01(s.h + 5) < 0.5 ? 1 : -1), I, B, s, text, key, HOTEL.has(k) || s.vert, `${p.n}|${k}|${dist}`);
      // 商场：楼顶大字
      if (isMall) this.planRoof(plan, b, text, s, E);
      return;
    }
  }

  planBlade(plan, b, e, E, m, I, B, s, text, key, big, id) {
    const L = E.L;
    m = clamp(m, 0.45, L - 0.45);
    const vt = [...text].slice(0, big ? 8 : 6).join('');
    const vs = { ...s };
    if (vs.type === 'neon' && !vs.back) vs.back = '#141414';
    if (vs.type === 'plaque' || vs.type === 'trad') vs.type = vs.type === 'trad' ? 'trad' : 'lightbox';
    const vkey = `V|${id}`;
    const req = this.req(plan, vkey, () => {
      const mm = measureSign(vs, vt, true);
      return { kind: 'sign', text: vt, s: vs, vert: true, w: mm.w, m: mm };
    });
    const Ac = req.w / CH;
    const hgt = I.H, gf = I.gf;
    let Wb = big ? 1.05 : 0.72;
    let Hb = Wb * Ac;
    const maxH = big ? Math.max(3, Math.min(9, hgt - gf - 1)) : 3.2;
    if (Hb > maxH) { Hb = maxH; Wb = Hb / Ac; }
    if (Wb < 0.35) return;
    // 大竖牌（酒店）从二层起挂在楼身上；小竖牌与门头带同底
    const bottom = big ? gf + 0.3 : B.y0;
    if (bottom + Hb > hgt + (big ? 0 : 0.5)) return;
    const out = 0.32 + Wb / 2;
    const D = big ? 0.3 : 0.16;
    const g0 = I.ga;
    const cx = E.ax + E.tx * m + E.nx * out - E.tx * (D / 2), cz = E.az + E.tz * m + E.nz * out - E.tz * (D / 2);
    const T = TYPE[vs.type] || TYPE.lightbox;
    plan.sign(cx, g0 + bottom + Hb / 2, cz, E.tx, E.tz, Wb, Hb, D, vkey, capGlow(vs, (vs.glow || 1.8) * T.lit * GLOW_K), s.mode || 0, hash01(s.h + 29), F_VERT | F_DOUBLE, col(vs.type === 'lightbox' ? '#8e949a' : vs.back || vs.frame || '#222222'), T.rough);
    // 支架（上下两根横撑）
    const bx = E.ax + E.tx * m + E.nx * 0.01 - E.tx * 0.025, bz = E.az + E.tz * m + E.nz * 0.01 - E.tz * 0.025;
    const arm = col('#3b3e42');
    for (const yy of [bottom + Hb - 0.12, bottom + 0.12]) {
      plan.sign(bx + E.nx * 0.18, g0 + yy, bz + E.nz * 0.18, E.tx, E.tz, 0.36, 0.05, 0.05, null, 0, 0, 0, 0, arm, 0.45);
    }
  }
  /** 楼顶 / 楼冠发光大字 */
  planRoof(plan, b, name, style, E0 = null) {
    if (!name || this.roofed.has(b) || !this.bi.usable(b)) return;
    const hgt = this.bi.height(b);
    if (hgt < 14) return;
    let text = signText(name);
    if ([...text].length > 6) text = text.replace(/^(陕西省|陕西|西安市|西安)/, '');
    if ([...text].length < 2) return;
    const E = E0 || this.bestStreetEdge(b);
    if (!E) return;
    this.roofed.add(b);
    const h = strHash(name);
    const palette = ['#ff3a2e', '#ffd36a', '#f4f6f8', '#ff3a2e', '#63c7ff'];
    const fg = style && style.bank ? (style.bg || '#e0201b') : palette[h % palette.length];
    const s = { type: 'led', fg, h, glow: 2.6 };
    const key = `R|${name}|${fg}`;
    const req = this.req(plan, key, () => {
      const m = measureSign(s, text, false);
      return { kind: 'sign', text, s, vert: false, w: m.w, m };
    });
    const Ac = req.w / CH;
    let H = style ? clamp(hgt * 0.11, 2.4, 6.5) : clamp(hgt * 0.045, 1.8, 5.5); // 商场字更大
    if (H * Ac > E.L * 0.92) H = (E.L * 0.92) / Ac;
    if (H < 1.3) return;
    const W = H * Ac;
    const mx = E.ax + E.tx * (E.L / 2), mz = E.az + E.tz * (E.L / 2);
    const g0 = this.binfo(b).ga; // 楼顶 = 地面基准 + 楼高（与通用建筑渲染一致）
    const crown = hgt >= 90;
    const y = crown ? g0 + hgt - H / 2 - 2.2 : g0 + hgt + 0.35 + H / 2;
    const off = crown ? 0.12 : -0.7;
    const phase = hash01(h + 3);
    plan.sign(mx + E.nx * off, y, mz + E.nz * off, E.nx, E.nz, W, H, 0.25, key, capGlow(s, 2.6 * GLOW_K, GLOW_CAP.roof), phase < 0.15 ? 4 : 0, phase, F_CUT | F_DOUBLE, col('#2a2c30'), 0.5);
    if (!crown) {
      // 字后钢架（两根横梁 + 立柱，白天可见的楼顶招牌支架）
      const steel = col('#4a4d52');
      plan.sign(mx + E.nx * (off - 0.35), g0 + hgt + 0.35 + H * 0.25, mz + E.nz * (off - 0.35), E.nx, E.nz, W * 0.96, 0.08, 0.08, null, 0, 0, 0, 0, steel, 0.5);
      plan.sign(mx + E.nx * (off - 0.35), g0 + hgt + 0.35 + H * 0.75, mz + E.nz * (off - 0.35), E.nx, E.nz, W * 0.96, 0.08, 0.08, null, 0, 0, 0, 0, steel, 0.5);
    }
  }
  bestStreetEdge(b) {
    const n = this.P.vc[b];
    let best = null, bs = -Infinity;
    const main = new Set([this.ri.cls.trunk, this.ri.cls.primary, this.ri.cls.secondary]);
    for (let e = 0; e < n; e++) {
      const E = this.edge(b, e);
      if (E.L < 8) continue;
      const mx = E.ax + E.tx * E.L / 2 + E.nx * 10, mz = E.az + E.tz * E.L / 2 + E.nz * 10;
      const r = this.ri.nearest(mx, mz, 80, this.acceptMain);
      const sc = Math.min(E.L, 60) * 0.5 - (r ? Math.max(0, r.d) : 90) + (r && main.has(r.c) ? 12 : 0);
      if (sc > bs) { bs = sc; best = E; }
    }
    return best;
  }

  /** 地铁出入口：“钟楼-C口” → 雨棚 + 门头（线路色块 + 站名 + 出口字母）+ 独立标识柱（西安地铁标志） */
  planMetro(plan, p) {
    const mm = p.n.match(/^(.+?)(?:站)?[-－—\s]*([A-Za-z]\d{0,2})\s*(?:出入)?口$/);
    if (!mm) return;
    const station = mm[1].replace(/站$/, '');
    const exit = mm[2].toUpperCase();
    const lines = this.linesAt(p.x, p.z);
    const bi = this.bi, ri = this.ri, terrain = this.ctx.terrain;
    const key = `M|${station}|${lines.join(',')}|${exit}`;
    this.req(plan, key, () => ({ kind: 'metro', name: station, lines, exit, w: measureMetroHeader(station, lines, exit) }));
    const ekey = `E|${exit}|${lines.join(',')}`;
    const ereq = this.req(plan, ekey, () => ({ kind: 'exit', exit, lines, w: measureExitLetter(lines) }));
    let x = p.x, z = p.z;
    const r = ri.nearest(x, z, 60, this.acceptMain);
    let dx = 1, dz = 0, nx = 0, nz = 1;
    if (r) {
      dx = r.dx; dz = r.dz;
      const side = (x - r.px) * -dz + (z - r.pz) * dx >= 0 ? 1 : -1;
      nx = -dz * side; nz = dx * side;
      const want = r.w / 2 + 3.4;
      const cur = Math.max(0, r.cd);
      if (cur < want) { x += nx * (want - cur); z += nz * (want - cur); }
    }
    const W = 4.8, L = 9.0;
    const f = hash01(strHash(p.n)) < 0.5 ? 1 : -1;
    const fx = dx * f, fz = dz * f; // 开口朝向（沿人行道）
    const inB = (u, v) => bi.inside(x + fx * v + nx * u, z + fz * v + nz * u) >= 0;
    const g = terrain.heightAt(x, z);
    const logoCol = col('#3a3f45');
    if (inB(0, 0) || inB(W / 2, L / 2) || inB(-W / 2, L / 2) || inB(W / 2, -L / 2) || inB(-W / 2, -L / 2)) {
      // 出入口在建筑内（商场合建）：立面门头 + 路边标识柱
      const fc = findFacade(bi, ri, p.x, p.z, { maxR: 30, filter: this.groundOK });
      if (!fc) return;
      const E = this.edge(fc.b, fc.e);
      const Wd = Math.min(E.L - 0.4, 5.2);
      if (Wd < 2) return;
      const mpos = this.slot(fc.b, fc.e, 0, E.L, Wd, fc.t * E.L);
      if (mpos == null) return;
      const g2 = terrain.heightAt(E.ax + E.tx * mpos, E.az + E.tz * mpos);
      plan.sign(E.ax + E.tx * mpos + E.nx * 0.06, g2 + 3.3, E.az + E.tz * mpos + E.nz * 0.06, E.nx, E.nz, Wd, 0.85, 0.12, key, G_METRO, 0, 0, 0, col('#2a2f35'), 0.35);
      this.planTotem(plan, E.ax + E.tx * mpos + E.nx * 2.6, E.az + E.tz * mpos + E.nz * 2.6, g2, E.nx, E.nz, ekey, ereq, logoCol);
      return;
    }
    // 雨棚（几何原点在地面中心，+z = 开口）
    plan.struct(plan.cn, x, g + 0.05, z, fx, fz);
    const hy = g + 0.05 + 3.12;
    for (const sgn of [1, -1]) {
      plan.sign(x + fx * sgn * (L / 2 + 0.31), hy, z + fz * sgn * (L / 2 + 0.31), fx * sgn, fz * sgn, W + 0.2, 0.9, 0.08, key, G_METRO, 0, 0, 0, col('#2a2f35'), 0.35);
      // 两侧檐口也挂站名门头：从马路上看过去是雨棚的长边，只有开口端有站名时认不出是地铁口
      const sx = fz * sgn, sz = -fx * sgn;
      plan.sign(x + sx * (W / 2 + 0.31), g + 0.05 + 3.1, z + sz * (W / 2 + 0.31), sx, sz, L * 0.8, 0.72, 0.08, key, G_METRO, 0, 0, 0, col('#2a2f35'), 0.35);
    }
    // 顶棚灯带
    plan.sign(x - fx * (L / 2 - 0.6), g + 0.05 + 2.93, z - fz * (L / 2 - 0.6), fx, fz, 2.8, 0.05, L - 1.2, null, G_STRIP, 0, 0, F_EMIT, col('#fff1dc'), 0.5);
    // 标识柱：开口前方一侧，面向道路
    const tx = x + fx * (L / 2 + 1.8) + nx * (W / 2 - 0.6), tz = z + fz * (L / 2 + 1.8) + nz * (W / 2 - 0.6);
    this.planTotem(plan, tx, tz, terrain.heightAt(tx, tz), -nx, -nz, ekey, ereq, logoCol);
  }
  planTotem(plan, x, z, g, nx, nz, ekey, ereq, c) {
    const D = 0.36;
    plan.sign(x - nx * D / 2, g + 1.9, z - nz * D / 2, nx, nz, 0.8, 3.8, D, null, 0, 0, 0, 0, c, 0.45);
    plan.sign(x - nx * (D / 2 + 0.01), g + 3.33, z - nz * (D / 2 + 0.01), nx, nz, 0.66, 0.66, D + 0.02, '@logo', G_LOGO, 0, 0, F_STRETCH | F_DOUBLE, c, 0.35);
    const Ac = ereq.w / CH;
    const Wl = 0.7, Hl = Math.min(0.62, Wl / Ac);
    plan.sign(x - nx * (D / 2 + 0.01), g + 2.62, z - nz * (D / 2 + 0.01), nx, nz, Wl, Hl, D + 0.02, ekey, G_METRO, 0, 0, F_DOUBLE, col('#23272c'), 0.35);
  }

  /** 公交候车亭：顶棚 + 背板玻璃 + 座椅（几何）；站名灯箱、广告灯箱、站牌、顶棚灯带（招牌实例） */
  planBus(plan, c) {
    const ri = this.ri, bi = this.bi, terrain = this.ctx.terrain;
    const f = ri.feats[c.fi];
    // 交叉路名
    const own = f.n;
    let name = null, bd = Infinity;
    const acc = (cc, b, fi) => {
      const nm = ri.names[fi];
      return nm && nm !== own && !b && this.acceptMain(cc) && !own.startsWith(nm) && !nm.startsWith(own);
    };
    const r = ri.nearest(c.x, c.z, 170, acc);
    if (r && Math.abs(r.dx * c.dx + r.dz * c.dz) < 0.55) { name = ri.names[r.fi]; bd = Math.max(0, r.cd); }
    if (!name || bd < 28) return;
    name = name.replace(/[（(].*?[）)]/g, '').trim();
    if (/[路街道巷]$/.test(name)) name += '口';
    if ([...name].length > 9) return;
    const nx = -c.dz, nz = c.dx; // 行车方向右侧
    const off = c.w / 2 + 2.5;
    const x = c.x + nx * off, z = c.z + nz * off;
    if (this.ctx.exclusions && this.ctx.exclusions.test(x, z, 'pois')) return;
    for (const u of [-5.5, 0, 5.5]) if (bi.inside(x + c.dx * u - nx * 1.2, z + c.dz * u - nz * 1.2) >= 0) return;
    const on = ri.nearest(x, z, 6, (cc, b, fi) => fi !== c.fi && !b);
    if (on && on.d < 0.6) return;
    const g = terrain.heightAt(x, z) + 0.15;
    const fx = -nx, fz = -nz; // 开口朝路
    const X = { x: fz, z: -fx }; // 本地 +x
    const P = (lx, lz) => [x + X.x * lx + fx * lz, z + X.z * lx + fz * lz];
    plan.struct(plan.sh, x, g, z, fx, fz);
    const key = `B|${name}`;
    this.req(plan, key, () => ({ kind: 'bus', name, w: measureBusName(name, false) }));
    const vkey = `BV|${name}`;
    const vreq = this.req(plan, vkey, () => ({ kind: 'busv', name, w: measureBusName(name, true) }));
    const blue = col('#1d4f91');
    // 顶部站名灯箱（前后两面）
    let [px, pz] = P(0, 0.93);
    plan.sign(px, g + 2.45, pz, fx, fz, 8.8, 0.4, 0.06, key, G_BUS, 0, 0, 0, blue, 0.35);
    [px, pz] = P(0, -1.01);
    plan.sign(px, g + 2.45, pz, -fx, -fz, 8.8, 0.4, 0.06, key, G_BUS, 0, 0, 0, blue, 0.35);
    // 广告灯箱（后墙右端，双面）
    const pk = '@p' + (strHash(name) % 4);
    [px, pz] = P(3.35, -0.92);
    plan.sign(px, g + 1.32, pz, fx, fz, 1.3, 1.95, 0.24, pk, G_BUS, 0, 0, F_STRETCH | F_DOUBLE, col('#a7acb1'), 0.3);
    // 顶棚灯带
    [px, pz] = P(0, -0.35);
    plan.sign(px, g + 2.43, pz, fx, fz, 8.0, 0.04, 0.35, null, G_STRIP, 0, 0, F_EMIT, col('#eef4ff'), 0.5);
    // 站牌立杆 + 竖向站名牌（双面，朝来车方向）
    const Ac = vreq.w / CH;
    let Hb = Math.min(1.9, 0.52 * Ac), Wb = Hb / Ac;
    [px, pz] = P(-5.6, 0.55);
    plan.sign(px, g + 1.55, pz, X.x, X.z, 0.09, 3.1, 0.09, null, 0, 0, 0, 0, col('#9aa0a6'), 0.3);
    plan.sign(px - X.x * 0.08, g + 3.0 - Hb / 2 - 0.05, pz - X.z * 0.08, X.x, X.z, Wb, Hb, 0.07, vkey, G_BUS, 0, 0, F_VERT | F_DOUBLE, blue, 0.35);
  }

  /** 3×3 区块内已用的招牌名（真实 POI 名 + 已排的补充门头名），补充门头据此不重名 */
  usedNames(ch) {
    const used = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const nb = this.chunk(ch.cx + dx, ch.cz + dz, false);
      if (!nb) continue;
      for (const p of nb.pois) used.add(signText(p.n));
      if (nb.fillNames) for (const n of nb.fillNames) used.add(n);
    }
    return used;
  }
  /**
   * 补充门头店名：按街道等级选业态（主干道 = 银行/品牌零售/连锁酒店餐饮；次干道一半品牌一半体面小店；支路小巷 = 小吃杂货），
   * 酒店楼优先酒店、写字楼优先银行咖啡；附近已有同名招牌的跳过。返回图集单元键或 null。
   */
  pickFill(grade, dist, st, hs, used) {
    const K = this.fillKeys;
    const r = hash01(hs + 2), r2 = hash01(hs + 3);
    let set;
    if (dist === 'huimin') set = K.huimin;
    else if (grade <= 1 && st === 8 && r < 0.7) set = K.mainHotel;
    else if (grade <= 1 && (st === 2 || st === 3) && r < 0.6) set = K.mainOffice;
    else if (grade === 0) set = r < 0.88 ? K.main : r2 < 0.5 ? K.food2 : K.shop2;
    else if (grade === 1) set = r < 0.5 ? K.main : r2 < 0.5 ? K.food2 : K.shop2;
    else if (grade === 2 || grade === 4) set = r < 0.18 ? K.main : r2 < 0.5 ? K.food : K.shop;
    else set = r2 < 0.5 ? K.food : K.shop;
    if (!set || !set.length) return null;
    const brand = set === K.main || set === K.mainHotel || set === K.mainOffice;
    const i0 = hs >>> 5;
    for (let t = 0; t < 10; t++) {
      const key = set[(i0 + t * 7) % set.length];
      const req = this.permReq.get(key);
      if (!req || !this.perm.get(key)) continue;
      if (used.has(req.text)) continue;
      used.add(req.text);
      return key;
    }
    // 品牌名不重复挂；小店名允许重复（“兰州牛肉拉面”满城都是）
    if (brand) return null;
    const key = set[i0 % set.length];
    return this.perm.get(key) ? key : null;
  }

  /**
   * 补充门头：临街底层外墙按“开间”切槽，在 POI 招牌之外的空位挂通用店名（共享图集单元）。
   * 一条立面要么是铺面排（几乎每个开间都有招牌，连成门头带），要么不挂；招牌统一挂在该楼的门头带（band）上，
   * 主次干道再在整排招牌后衬一条门头底板。只在画了底商橱窗的立面上挂（与 buildings 立面着色一致）。
   */
  ensureFill(ch) {
    if (ch.fill) return ch.fill;
    // 先确保本块与相邻块的 POI 招牌已占位
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const nb = this.chunk(ch.cx + dx, ch.cz + dz, false);
      if (nb) this.ensurePlan(nb);
    }
    const plan = new Plan();
    const bi = this.bi, P = this.P;
    const used = this.usedNames(ch);
    const mine = new Set();
    if (P) {
      const x0 = ch.cx * C, z0 = ch.cz * C;
      const ex = this.ctx.exclusions;
      const FASCIA = ['#2c2e31', '#3a3530', '#45484d', '#2f3437', '#4d4740'];
      bi.candidates(ch.x, ch.z, C * 0.72, (b) => {
        const axb = P.ax[b], azb = P.az[b];
        if (axb < x0 || axb >= x0 + C || azb < z0 || azb >= z0 + C) return;
        if (P.minDm[b] !== 0 || this.exitBoxes.has(b)) return;
        if (P.hDm[b] < 30) return;
        if (ex && ex.test(axb, azb, 'pois')) return;
        const I = this.binfo(b);
        const st = I.st;
        const rp = st >= 0 && st < ROW_P.length ? ROW_P[st] : ROW_P_UNKNOWN;
        if (!rp[0] && !rp[1]) return; // 厂房、公共建筑不补门头
        const dist = districtOf(axb, azb);
        const campus = this.inCampus(axb, azb);
        const n = P.vc[b];
        for (let e = 0; e < n; e++) {
          const E = this.edge(b, e);
          if (E.L < 4.5) continue;
          const mx = E.ax + E.tx * E.L / 2, mz = E.az + E.tz * E.L / 2;
          if (bi.inside(mx + E.nx * 2, mz + E.nz * 2, b) >= 0) continue;
          // 街道等级按“临街的最高等级道路”定：主次干道人行道常被 OSM 单独画成 footway，最近的那条线往往是人行道
          let grade, footOnly = false;
          const rm = this.ri.nearest(mx + E.nx * 3, mz + E.nz * 3, 32, this.acceptMajor, E.tx, E.tz, 0.8);
          if (rm) grade = this.grade.get(rm.c);
          else {
            const r = this.ri.nearest(mx + E.nx * 3, mz + E.nz * 3, 18, this.acceptFill, E.tx, E.tz, 0.8);
            if (!r) continue;
            grade = this.grade.has(r.c) ? this.grade.get(r.c) : 3;
            footOnly = r.c === this.clsFootway;
          }
          if (campus && grade >= 2) continue; // 校园/大院内部步道旁不开店
          const main = grade <= 1;
          // 住宅/城中村只在临街底商边（立面画了橱窗/卷帘门）挂；商业/办公/酒店/传统风貌首层本就是铺面
          const eSt = this.edgeStreet(E, I);
          if (!eSt && (st === 0 || st === 1 || st === 5)) continue;
          const hb = strHash(`${b}:${e}`);
          let rowP = rp[main ? 0 : 1] + (dist === 'street' ? 0.2 : 0) + (dist === 'wall' && !main ? 0.1 : 0);
          if (footOnly) rowP *= 0.35; // 只临小区/广场步道（没有车行道）的立面多不是铺面
          if (hash01(hb + 77) > rowP) continue; // 这条立面不是铺面排
          const B = this.band(I, eSt);
          if (!B) continue;
          const g0 = I.ga, H = B.h;
          const y = g0 + B.y0 + H / 2;
          let a = 0.3, si = 0;
          while (a < E.L - 3.0) {
            const hs = hb + si * 7919;
            // 主次干道铺面开间更宽（品牌店、银行网点）
            let sw = main ? 4.5 + hash01(hs) * 4.5 : 3.6 + hash01(hs) * 3.8;
            if (a + sw > E.L - 0.3) sw = E.L - 0.3 - a;
            if (sw < 3.0) break;
            si++;
            const a0 = a;
            a += sw;
            if (hash01(hs + 1) > (main ? 0.94 : 0.84)) continue; // 少量空铺 / 无招牌
            const m = a0 + sw / 2, Wt = sw - 0.3;
            if (!this.occupy(b, e, 0, m - Wt / 2 - 0.05, m + Wt / 2 + 0.05)) continue;
            const key = this.pickFill(grade, dist, st, hs, used);
            if (!key) continue;
            const req = this.permReq.get(key);
            mine.add(req.text);
            const s = req.s, T = TYPE[s.type] || TYPE.lightbox;
            const cut = s.type === 'neon' && !s.back;
            const W = cut ? Math.min(H * (req.w / CH), Wt) : Wt;
            const x = E.ax + E.tx * m + E.nx * 0.05, z = E.az + E.tz * m + E.nz * 0.05;
            if (bi.inside(x + E.nx * 1.2, z + E.nz * 1.2, b) >= 0) continue; // 招牌前方被相邻（重叠）轮廓挡住
            const side = col(s.type === 'lightbox' ? '#8e949a' : s.type === 'led' || s.type === 'neon' ? s.back || '#1a1a1a' : s.frame || s.bg || '#333333');
            plan.sign(x, y, z, E.nx, E.nz, W, H, T.D, key, capGlow(s, (s.glow || 1.6) * T.lit * GLOW_K), s.mode || 0, hash01(hs + 3), cut ? F_CUT : 0, side, T.rough);
            // 挑出竖牌：支路小巷与回民街（主次干道沿街整治后多已拆除）
            const pb = dist === 'huimin' ? 0.45 : main ? 0 : 0.1;
            if (hash01(hs + 4) < pb && I.H > B.y0 + 2) {
              const vset = dist === 'huimin' ? this.fillKeys.vhm : this.fillKeys.vert;
              const vkey = vset[(hs >>> 7) % vset.length];
              const vreq = this.permReq.get(vkey);
              if (vreq && this.perm.get(vkey)) {
                const vA = vreq.w / CH;
                const Wb = 0.62, Hb = Math.min(2.6, Wb * vA);
                const mb = clamp(a0 + 0.3, 0.4, E.L - 0.4);
                const out = 0.3 + Wb / 2;
                const vx = E.ax + E.tx * mb + E.nx * out, vz = E.az + E.tz * mb + E.nz * out;
                const vs = vreq.s, VT = TYPE[vs.type] || TYPE.lightbox;
                plan.sign(vx, g0 + B.y0 + Hb / 2, vz, E.tx, E.tz, Hb / vA, Hb, 0.14, vkey, capGlow(vs, (vs.glow || 1.8) * VT.lit * GLOW_K), vs.mode || 0, hash01(hs + 6), F_VERT | F_DOUBLE, col(vs.back || vs.bg || '#222222'), VT.rough);
              }
            }
          }
          // 门头底板：主次干道上把整排招牌（含该立面上的 POI 招牌）连成一条连续的门头带
          if (main) {
            const l = this.occ.get(b * 4096 + e * 4);
            if (l && l.length >= 4) {
              let lo = Infinity, hi = -Infinity;
              for (let i = 0; i < l.length; i += 2) { lo = Math.min(lo, l[i]); hi = Math.max(hi, l[i + 1]); }
              lo = Math.max(0.05, lo - 0.1);
              hi = Math.min(E.L - 0.05, hi + 0.1);
              if (hi - lo > 4) {
                const c = (lo + hi) / 2;
                const fc = col(FASCIA[hb % FASCIA.length]);
                plan.sign(E.ax + E.tx * c + E.nx * 0.01, y, E.az + E.tz * c + E.nz * 0.01, E.nx, E.nz, hi - lo, H + 0.24, 0.05, null, 0, 0, 0, 0, fc, 0.6);
              }
            }
          }
        }
      });
    }
    const fin = plan.finish();
    this.resolve(fin, null);
    ch.fill = fin;
    ch.fillNames = mine;
    return fin;
  }
  // ———————————————————— 流式加载 ————————————————————
  /** 为区块分配图集单元并写入 UV（可分帧）：true 完成 / false 暂停 / null 图集满 */
  goLive(ch, deadline = Infinity) {
    const plan = this.ensurePlan(ch);
    if (!ch.pk) ch.pk = { reqs: [...plan.reqs], i: 0, segs: [], rects: new Map(), seg: null, x: 0, x0: 0 };
    const r = this.packStep(ch.pk, deadline);
    if (r === null) { ch.pk = null; return null; }
    if (r === false) return false;
    ch.segs = ch.pk.segs;
    this.resolve(plan, ch.pk.rects);
    ch.pk = null;
    ch.live = true;
    this.live.add(ch);
    this.dirty = true;
    return true;
  }
  resolve(plan, rects) {
    const a = plan.a;
    for (let i = 0; i < plan.n; i++) {
      const key = plan.keys[i];
      const o = i * STRIDE;
      let fl = a[o + 23] | 0;
      fl &= ~F_PAGE1;
      if (key == null) { a[o + 16] = a[o + 17] = a[o + 18] = a[o + 19] = 0; a[o + 23] = fl; continue; }
      const r = (rects && rects.get(key)) || this.perm.get(key);
      if (!r) { a[o + 18] = 0; a[o + 19] = 0; a[o + 20] = 0; continue; }
      a[o + 16] = r.u; a[o + 17] = r.v; a[o + 18] = r.du; a[o + 19] = r.dv;
      if (r.page === 1) fl |= F_PAGE1;
      a[o + 23] = fl;
    }
  }
  unload(ch) {
    if (ch.pk) { for (const s of ch.pk.segs) this.atlas.free(s); ch.pk = null; }
    for (const s of ch.segs) this.atlas.free(s);
    ch.segs = [];
    ch.live = false;
    this.live.delete(ch);
    this.dirty = true;
  }

  update(dt) {
    if (!this.P && !this.nPois) return;
    this.frame++;
    const cam = this.ctx.camera.position;
    const moved = Math.hypot(cam.x - this.lastCam.x, cam.z - this.lastCam.z);
    const agl = cam.y - this.ctx.terrain.heightAt(cam.x, cam.z);
    const R = agl > 2500 ? 0 : agl > 1200 ? Math.min(this.R, 900) : this.R;
    if (moved > 25 || this.frame % 30 === 0) {
      if (moved > 400) this.hot = 90;
      this.lastCam.copy(cam);
      const list = [];
      const r0 = Math.floor((cam.x - R) / C), r1 = Math.floor((cam.x + R) / C);
      const q0 = Math.floor((cam.z - R) / C), q1 = Math.floor((cam.z + R) / C);
      if (R > 0) for (let cx = r0; cx <= r1; cx++) for (let cz = q0; cz <= q1; cz++) {
        const x = (cx + 0.5) * C, z = (cz + 0.5) * C;
        const d = Math.max(0, Math.hypot(x - cam.x, z - cam.z) - C * 0.7);
        if (d > R) continue;
        if (Math.abs(x) > 16500 || Math.abs(z) > 16500) continue;
        const ch = this.chunk(cx, cz);
        ch.d = d;
        list.push(ch);
      }
      list.sort((a, b) => a.d - b.d);
      this.wanted = list;
      for (const ch of this.live) {
        const d = Math.max(0, Math.hypot(ch.x - cam.x, ch.z - cam.z) - C * 0.7);
        ch.d = d;
        if (d > R + 300) this.unload(ch);
      }
      for (const ch of this.live) {
        const on = ch.d < this.fillR;
        if (on !== ch.fillOn) { ch.fillOn = on; this.dirty = true; }
      }
    }
    // 预算内加载（近 → 远）
    const t0 = performance.now();
    const budget = this.hot > 0 ? 28 : 5;
    if (this.hot > 0) this.hot--;
    const T = this.tPh || (this.tPh = { plan: 0, fill: 0, live: 0 });
    const tm = (k, t1) => { const d = performance.now() - t1; if (d > T[k]) T[k] = d; };
    for (const ch of this.wanted) {
      const tc = performance.now();
      if (tc - t0 > budget) break;
      this.tWork = (this.tWork || 0);
      // 分阶段：规划（含相邻块）→ 上图集 → 补充门头；每阶段之间检查预算，避免单帧卡顿
      if (!ch.plan) { this.ensurePlan(ch); tm('plan', tc); continue; }
      if (ch.d < this.fillR && !ch.fill) {
        let need = false;
        for (let dx = -1; dx <= 1 && !need; dx++) for (let dz = -1; dz <= 1; dz++) {
          const nb = this.chunk(ch.cx + dx, ch.cz + dz, false);
          if (nb && !nb.plan) { const t1 = performance.now(); this.ensurePlan(nb); tm('plan', t1); need = true; break; }
        }
        if (need) continue;
      }
      if (!ch.live) {
        const t1 = performance.now();
        if (ch.failAt && this.frame - ch.failAt < 120) continue;
        const res = this.goLive(ch, t0 + budget);
        if (res === false) { tm('live', t1); break; } // 本帧预算用完，下帧继续画
        if (res === null) {
          // 图集满：卸掉比它更远的已加载区块后重试
          let far = null;
          for (const o of this.live) if (o.d > ch.d + 120 && (!far || o.d > far.d)) far = o;
          if (far) { this.unload(far); if (this.goLive(ch, t0 + budget) !== null) continue; }
          ch.failAt = this.frame;
          continue;
        }
        tm('live', t1);
        ch.fillOn = ch.d < this.fillR;
        if (ch.fillOn && !ch.fill) continue;
      }
      if (ch.fillOn && !ch.fill) { const t1 = performance.now(); this.ensureFill(ch); tm('fill', t1); this.dirty = true; }
      const dtc = performance.now() - tc;
      if (dtc > 0.05) { this.tWork += dtc; this.tMax = Math.max(this.tMax || 0, dtc); }
    }
    this.atlas.flush();
    if (this.dirty) this.assemble();
  }

  assemble() {
    this.dirty = false;
    const M = this.signs.instanceMatrix.array, UV = this.aUV.array, FX = this.aFx.array, CO = this.aCol.array;
    let n = 0, ns = 0, nc = 0;
    const SH = this.shelters.instanceMatrix.array, CN = this.canopies.instanceMatrix.array;
    const put = (p) => {
      const a = p.a;
      const m = Math.min(p.n, CAP_SIGN - n);
      for (let i = 0; i < m; i++, n++) {
        const o = i * STRIDE;
        M.set(a.subarray(o, o + 16), n * 16);
        UV.set(a.subarray(o + 16, o + 20), n * 4);
        FX.set(a.subarray(o + 20, o + 24), n * 4);
        CO.set(a.subarray(o + 24, o + 28), n * 4);
      }
    };
    for (const ch of this.live) {
      const p = ch.plan;
      put(p);
      if (ch.fillOn && ch.fill) put(ch.fill);
      if (p.sh.length && ns + p.sh.length / 16 <= CAP_SHELTER) { SH.set(p.sh, ns * 16); ns += p.sh.length / 16; }
      if (p.cn.length && nc + p.cn.length / 16 <= CAP_CANOPY) { CN.set(p.cn, nc * 16); nc += p.cn.length / 16; }
    }
    const upd = (attr, count, size) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(1, count) * size);
      attr.needsUpdate = true;
    };
    this.signs.count = n;
    upd(this.signs.instanceMatrix, n, 16);
    upd(this.aUV, n, 4);
    upd(this.aFx, n, 4);
    upd(this.aCol, n, 4);
    this.shelters.count = ns;
    upd(this.shelters.instanceMatrix, ns, 16);
    this.canopies.count = nc;
    upd(this.canopies.instanceMatrix, nc, 16);
    this.signs.visible = this.visible && n > 0;
    this.shelters.visible = this.visible && ns > 0;
    this.canopies.visible = this.visible && nc > 0;
  }

  setVisible(on) {
    this.visible = on;
    this.group.visible = on;
  }
  stats() {
    let fills = 0;
    for (const ch of this.live) if (ch.fillOn && ch.fill) fills += ch.fill.n;
    return {
      phases: this.tPh, init: Math.round(this.tInit), work: Math.round(this.tWork || 0), maxChunk: +(this.tMax || 0).toFixed(1), pois: this.nPois, live: this.live.size, signs: this.signs.count, fills,
      shelters: this.shelters.count, canopies: this.canopies.count, pages: this.atlas.pages.length, segs: this.atlas.usedSegs,
    };
  }
  diag(x, z, r) {
    const out = [];
    const T = this.ctx.terrain;
    for (const ch of this.live) {
      for (const p of [ch.plan, ch.fillOn ? ch.fill : null]) {
        if (!p) continue;
        const a = p.a;
        for (let i = 0; i < p.n; i++) {
          const o = i * STRIDE, px = a[o + 12], pz = a[o + 14];
          if (Math.hypot(px - x, pz - z) > r) continue;
          out.push({
            k: p.keys[i], x: +px.toFixed(1), y: +(a[o + 13] - T.heightAt(px, pz)).toFixed(2), z: +pz.toFixed(1),
            W: +Math.hypot(a[o], a[o + 2]).toFixed(2), H: +a[o + 5].toFixed(2), g: +a[o + 20].toFixed(2),
          });
        }
      }
    }
    return out;
  }
  dispose() {
    this.ctx.scene.remove(this.group);
    this.signs.geometry.dispose();
    this.signs.material.dispose();
    this.shelters.geometry.dispose();
    this.canopies.geometry.dispose();
    this.shelters.material.dispose();
    this.atlas.dispose();
  }
}

/** 按请求类型把单元画进舞台画布 */
function paintReq(g, x, y, w, req) {
  switch (req.kind) {
    case 'sign': paintSign(g, x, y, w, req.s, req.text, req.m, req.vert); break;
    case 'metro': paintMetroHeader(g, x, y, w, req.name, req.lines, req.exit); break;
    case 'exit': paintExitLetter(g, x, y, w, req.exit, req.lines); break;
    case 'bus': paintBusName(g, x, y, w, req.name, false); break;
    case 'busv': paintBusName(g, x, y, w, req.name, true); break;
    default: break;
  }
}

/** 用地多边形点查询（landuse.json 指定类别；500 m 格网 + 外包盒预筛） → (x, z) => bool */
function landIndex(lu, kinds) {
  const grid = new Map(), CELL = 500;
  for (const p of (lu && lu.polys) || []) {
    const o = p.outer;
    if (!kinds.has(p.k) || !o || o.length < 6) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) {
      if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i];
      if (o[i + 1] < z0) z0 = o[i + 1]; if (o[i + 1] > z1) z1 = o[i + 1];
    }
    if (x1 < -17000 || x0 > 17000 || z1 < -17000 || z0 > 17000 || (x1 - x0) * (z1 - z0) > 9e6) continue;
    const it = { o, x0, x1, z0, z1 };
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = cx * 100003 + cz;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(it);
      }
  }
  return (x, z) => {
    const l = grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!l) return false;
    for (const it of l) if (x >= it.x0 && x <= it.x1 && z >= it.z0 && z <= it.z1 && pointInPoly(x, z, it.o)) return true;
    return false;
  };
}

// ———————————————————— 构筑物几何（合并 + 顶点色） ————————————————————
function merged(boxes) {
  const pos = [], nor = [], colr = [], idx = [];
  const c = new THREE.Color();
  for (const [x0, y0, z0, x1, y1, z1, hex] of boxes) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const base = pos.length / 3;
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    c.set(hex);
    for (let i = 0; i < P.length; i += 3) {
      pos.push(P[i], P[i + 1], P[i + 2]);
      nor.push(N[i], N[i + 1], N[i + 2]);
      // 顶面略亮、底面略暗（假 AO）
      const k = N[i + 1] > 0.5 ? 1.0 : N[i + 1] < -0.5 ? 0.6 : 0.85;
      colr.push(c.r * k, c.g * k, c.b * k);
    }
    for (const i of g.index.array) idx.push(base + i);
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** 公交候车亭（本地：x 沿路 ±4.6，z：-0.9 后 / +0.9 朝路，y 自人行道面起）。
 *  西安常见款：不锈钢立柱、深灰铝顶棚、后侧钢化玻璃、铝座椅，长 9 m 深 1.8 m 高 2.7 m。 */
function shelterGeometry() {
  const steel = '#a3a8ad', dark = '#3f444a', glass = '#51666f', seat = '#8a9096';
  const B = [];
  for (const x of [-4.3, 0, 4.3]) {
    B.push([x - 0.06, 0, -0.86, x + 0.06, 2.45, -0.74, steel]);
    B.push([x - 0.05, 2.2, -0.8, x + 0.05, 2.45, 0.85, steel]); // 悬挑梁
  }
  B.push([-4.6, 2.45, -1.0, 4.6, 2.6, 1.0, dark]); // 顶棚
  B.push([-4.6, 2.3, 0.86, 4.6, 2.6, 0.92, dark]); // 前檐
  B.push([-4.25, 0.45, -0.84, 2.6, 2.25, -0.8, glass]); // 背板玻璃
  B.push([-4.25, 0.05, -0.84, 4.25, 0.45, -0.8, steel]); // 踢脚
  B.push([-3.4, 0.44, -0.72, 1.6, 0.5, -0.3, seat]); // 座椅
  for (const x of [-3.2, -1, 1.4]) B.push([x - 0.04, 0, -0.6, x + 0.04, 0.44, -0.45, steel]);
  B.push([-4.7, -0.15, -1.1, 4.7, 0.0, 1.05, '#8d8b85']); // 站台铺装（略高于地面）
  return merged(B);
}

/** 地铁出入口雨棚（本地：x 横向 ±2.4，z 纵向 ±4.5，+z 为开口）。
 *  参考西安地铁 1/2 号线出入口：深灰金属框架 + 蓝灰玻璃侧墙 + 平顶，开口上方门头（招牌实例）。 */
function canopyGeometry() {
  const frame = '#4a5058', glass = '#5f7f8c', roof = '#5d636a', stone = '#8f8d88', voidc = '#1a1b1d';
  const W = 2.4, L = 4.5;
  const B = [];
  B.push([-W - 0.2, 0, -L - 0.2, W + 0.2, 0.15, L + 0.2, stone]); // 台基
  B.push([-W + 0.35, 0.15, -L + 0.8, W - 0.35, 0.17, L - 0.6, voidc]); // 下行楼梯口（暗）
  for (const sx of [-1, 1]) {
    B.push([sx * W - 0.06, 0.15, -L, sx * W + 0.06, 2.85, L, glass]); // 侧墙玻璃
    B.push([sx * W - 0.1, 0.15, -L, sx * W + 0.1, 0.9, L, frame]); // 侧墙下部实墙
    for (const z of [-L, -L / 3, L / 3, L]) B.push([sx * W - 0.12, 0.15, z - 0.12, sx * W + 0.12, 3.0, z + 0.12, frame]);
  }
  B.push([-W, 0.15, -L - 0.1, W, 2.85, -L + 0.05, glass]); // 后墙
  B.push([-W - 0.3, 2.95, -L - 0.3, W + 0.3, 3.25, L + 0.3, roof]); // 顶板
  B.push([-W - 0.3, 2.62, L + 0.1, W + 0.3, 3.62, L + 0.3, frame]); // 前门头背板
  B.push([-W - 0.3, 2.62, -L - 0.3, W + 0.3, 3.62, -L - 0.1, frame]); // 后门头背板
  B.push([-W - 0.36, 3.25, -L - 0.36, W + 0.36, 3.35, L + 0.36, '#6c7278']); // 檐口压顶
  return merged(B);
}
