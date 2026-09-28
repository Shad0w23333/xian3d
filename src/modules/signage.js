// 街道招牌与广告（门头招牌 / 挑出竖牌 / 楼顶大字 / LED 滚动屏 / 霓虹 / 公交站台 / 地铁出入口）
//
// 设计要点（性能关键）：
//  · 文字全部画进 4096² Canvas 图集（signagePaint.js：行段 1024×72 px，按 250 m 区块流式分配/回收），
//    一个 InstancedMesh（单位盒子 + 每实例 UV 矩形 / 发光 / 模式 / 标志位）画出所有招牌、灯箱、滚动屏、灯带、立柱；
//    公交候车亭、地铁出入口雨棚各一个 InstancedMesh（合并几何 + 顶点色）。总 draw call = 3（开阴影时 +2）。
//  · 招牌挂在 POI 最近建筑的“临街”外墙（signageIndex.findFacade：距离 + 外侧到路缘距离评分），
//    底层门头带高度按 buildings.bin v2 风格（商业裙房 6 m、高层住宅底商 4.5 m、老式多层 3.6 m……）。
//  · 只在相机 R（画质：0.7/1.1/1.6/2.0 km）内生成；补充的普通小店门头（通用店名，共享图集单元）只在 fillR 内。
//  · 夜景：灯箱整面发光、发光字仅字形发光、霓虹（闪烁 / 逐字点亮 / 呼吸）、LED 滚动屏（白天也亮），均 × uNight。
//
// 参考：research/refs/signage/（北院门夜景 LED 竖招、西安地铁出入口与标志、东大街夜景）。
// 样式约定（银行统一色、品牌配色、回民街黑漆金字 + 红绿 LED 竖招）见 src/arch/signageStyle.js。
import * as THREE from 'three';
import { parseBuildings, BuildingIndex, RoadIndex, findFacade } from '../arch/signageIndex.js';
import { pickStyle, signText, districtOf, hash01, strHash, MALL_RE, ROOF_NAME_RE } from '../arch/signageStyle.js';
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

// buildings.bin v2 风格 → 临街底商层高（与 src/arch/bld-gen.js STYLE_P.gfShop 一致）
const GF_SHOP = [4.5, 3.6, 6.0, 5.6, 6.0, 3.8, 0, 4.5, 5.4, 4.0];
// 补充门头概率（按风格）：商业裙房/城中村/传统风貌最密，办公楼少，工业无
const FILL_P = [0.55, 0.7, 0.22, 0.22, 0.8, 0.85, 0, 0.12, 0.35, 0.85];

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

export default {
  id: 'signage',
  name: '街道招牌与广告',
  prepare(ctx) {
    // 通用建筑模块可能把 buildings.bin 转交 Worker（ArrayBuffer 被分离），这里先复制一份只读副本
    const buf = ctx.data && ctx.data.buildings;
    if (buf && buf.byteLength) preparedBuffer = buf.slice(0);
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
    this.P = parseBuildings(preparedBuffer || ctx.data.buildings);
    this.bi = new BuildingIndex(this.P, ctx.exclusions);
    this.ri = new RoadIndex(ctx.data.roads);
    const cls = this.ri.cls;
    const bad = new Set([cls.motorway, cls.motorway_link, cls.footway, cls.service]);
    this.acceptMain = (c) => !bad.has(c);
    const fillCls = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'pedestrian', 'footway', 'primary_link', 'secondary_link'].map((n) => (ctx.data.roads.classes || []).indexOf(n)));
    this.acceptFill = (c, b) => fillCls.has(c) && !b;
    this.groundOK = (b) => this.P.minDm[b] === 0;
    this.mainCls = new Set([cls.trunk, cls.primary, cls.secondary]);
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
  bucketPOIs(pois) {
    const ex = this.ctx.exclusions;
    let n = 0;
    for (const p of pois) {
      if (!p || !p.n || Math.abs(p.x) > 16500 || Math.abs(p.z) > 16500) continue;
      const k = p.k;
      const metro = k === 'subway_entrance';
      const brandLandmark = k === 'landmark' && /银行|中国移动|中国联通|中国电信|邮政|酒店|宾馆|饭店/.test(p.n);
      const roofLandmark = k === 'landmark' && ROOF_NAME_RE.test(p.n) && !NAME_SKIP.test(p.n);
      if (!metro && !SIGN_KINDS.has(k) && !brandLandmark && !roofLandmark) continue;
      if (ex && ex.test(p.x, p.z, 'pois')) continue;
      this.chunkAt(p.x, p.z).pois.push(p);
      n++;
    }
    this.nPois = n;
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
  if (sTex || (sfl & 32) != 0) totalEmissiveRadiance = sEm * vFx.x * k;
}`);
    };
    mat.customProgramCacheKey = () => 'signage-v1';
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
    this.fillKeys = { food: [], shop: [], huimin: [], vert: [], vhm: [] };
    FILL_FOOD.forEach((n) => { const k = 'F|f|' + n; add(k, mkSign(n, 'restaurant', 'city', false)); this.fillKeys.food.push(k); });
    FILL_SHOP.forEach((n) => { const k = 'F|s|' + n; add(k, mkSign(n, 'shop', 'city', false)); this.fillKeys.shop.push(k); });
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
  gfOf(b) {
    const st = this.P.style ? this.P.style[b] : 255;
    const g = GF_SHOP[st];
    return g ? g : 4.5;
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
    const f = findFacade(bi, ri, p.x, p.z, { maxR: 42, filter: this.groundOK });
    if (!f) return;
    if (f.inside && f.d > 16 && !s.bank && !HOTEL.has(k) && !isMall && (p.i || 0) < 2) return; // 商场内部店铺
    const b = f.b, e = f.e;
    const hgt = bi.height(b);
    const gf = this.gfOf(b);
    const T = TYPE[s.type] || TYPE.lightbox;
    const key = `S|${p.n}|${k}|${dist}`;
    const req = this.req(plan, key, () => {
      const m = measureSign(s, text, false);
      return { kind: 'sign', text, s, vert: false, w: m.w, m };
    });
    const Ac = req.w / CH;
    const imp = p.i || 0;
    let H = T.H * (imp >= 2 ? 1.2 : 1) * (s.bank ? 1.12 : 1) * (isMall ? 1.9 : 1);
    const E = this.edge(b, e);
    const L = E.L;
    const r = s.r;
    let target = s.bank ? 8 + r * 4 : HOTEL.has(k) ? 6 + r * 4 : isMall ? 14 + r * 8 : 3.2 + r * 3.8;
    H = Math.min(H, Math.max(0.6, hgt - 0.25 - 2.15));
    let textLen = H * Ac;
    if (textLen > L - 0.5) { H = (L - 0.5) / Ac; textLen = L - 0.5; }
    if (H < 0.5) return;
    let W = clamp(Math.max(textLen, target), textLen, L - 0.5);
    if (s.type === 'neon' && !s.back) W = textLen; // 无底板霓虹：只占字宽
    const c0 = f.t * L;
    let lvl = 0, m = this.slot(b, e, 0, L, W, c0);
    if (m == null && hgt > gf + 3.4) { lvl = 1; m = this.slot(b, e, 1, L, W, c0); }
    if (m == null) return;
    const g0 = this.ctx.terrain.heightAt(E.ax + E.tx * m, E.az + E.tz * m);
    let bottom;
    if (lvl === 0) {
      bottom = Math.max(2.45, gf - 0.2 - H);
      if (isMall) bottom = Math.max(bottom, Math.min(gf + 1.5, hgt - H - 0.6));
      if (bottom + H > hgt - 0.25) bottom = hgt - 0.25 - H;
      if (bottom < 1.9) return;
    } else {
      H *= 0.9;
      bottom = gf + 0.45;
    }
    const gap = 0.05;
    const x = E.ax + E.tx * m + E.nx * gap, z = E.az + E.tz * m + E.nz * gap;
    const y = g0 + bottom + H / 2;
    const cut = s.type === 'neon' && !s.back;
    const flags = cut ? F_CUT : 0;
    const side = col(s.type === 'lightbox' ? '#8e949a' : s.type === 'led' || s.type === 'neon' ? s.back || '#1a1a1a' : s.frame || s.bg || '#333333');
    const glow = (s.glow || 1.6) * T.lit * GLOW_K;
    const phase = hash01(s.h + 23);
    plan.sign(x, y, z, E.nx, E.nz, W, H, T.D, key, glow, s.mode || 0, phase, flags, side, T.rough);
    if (s.type === 'lightbox' && imp >= 1 && !cut) {
      // 灯箱顶部的细金属压条（近看有厚度层次）
      plan.sign(x, y + H / 2 + 0.03, z, E.nx, E.nz, W + 0.06, 0.06, T.D + 0.04, null, 0, 0, 0, 0, col('#5d6166'), 0.4);
    }
    // LED 滚动屏
    if (s.ticker && lvl === 0 && bottom > 2.9) {
      const tk = s.bank ? 'T|bank' : k === 'pharmacy' ? 'T|pharm' : HOTEL.has(k) ? 'T|hotel' : 'T|food';
      const tw = Math.min(3.6, W * 0.7), th = 0.3;
      plan.sign(x + E.nx * 0.02, g0 + bottom - 0.28, z + E.nz * 0.02, E.nx, E.nz, tw, th, 0.06, tk, 2.4 * GLOW_K, 2, phase, F_TICKER, col('#0c0c0c'), 0.35);
    }
    // 挑出式竖牌（酒店竖向灯箱、药店、回民街 LED 竖招）
    if (s.blade && lvl === 0) this.planBlade(plan, b, e, E, m + (W / 2 + 0.7) * (hash01(s.h + 5) < 0.5 ? 1 : -1), g0, gf, hgt, s, text, key, HOTEL.has(k) || s.vert, `${p.n}|${k}|${dist}`);
    // 商场：楼顶大字
    if (isMall) this.planRoof(plan, b, text, s, E);
  }

  planBlade(plan, b, e, E, m, g0, gf, hgt, s, text, key, big, id) {
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
    let Wb = big ? 1.05 : 0.72;
    let Hb = Wb * Ac;
    const maxH = big ? Math.max(3, Math.min(9, hgt - gf - 1)) : 3.2;
    if (Hb > maxH) { Hb = maxH; Wb = Hb / Ac; }
    if (Wb < 0.35) return;
    const bottom = big ? gf + 0.3 : Math.max(2.7, gf - 0.1);
    if (bottom + Hb > hgt + (big ? 0 : 0.5)) return;
    const out = 0.32 + Wb / 2;
    const D = big ? 0.3 : 0.16;
    const cx = E.ax + E.tx * m + E.nx * out - E.tx * (D / 2), cz = E.az + E.tz * m + E.nz * out - E.tz * (D / 2);
    const T = TYPE[vs.type] || TYPE.lightbox;
    plan.sign(cx, g0 + bottom + Hb / 2, cz, E.tx, E.tz, Wb, Hb, D, vkey, (vs.glow || 1.8) * T.lit * GLOW_K, s.mode || 0, hash01(s.h + 29), F_VERT | F_DOUBLE, col(vs.type === 'lightbox' ? '#8e949a' : vs.back || vs.frame || '#222222'), T.rough);
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
    const g0 = this.ctx.terrain.heightAt(mx, mz);
    const crown = hgt >= 90;
    const y = crown ? g0 + hgt - H / 2 - 2.2 : g0 + hgt + 0.35 + H / 2;
    const off = crown ? 0.12 : -0.7;
    const phase = hash01(h + 3);
    plan.sign(mx + E.nx * off, y, mz + E.nz * off, E.nx, E.nz, W, H, 0.25, key, 2.6 * GLOW_K, phase < 0.15 ? 4 : 0, phase, F_CUT | F_DOUBLE, col('#2a2c30'), 0.5);
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
      plan.sign(E.ax + E.tx * mpos + E.nx * 0.06, g2 + 3.3, E.az + E.tz * mpos + E.nz * 0.06, E.nx, E.nz, Wd, 0.85, 0.12, key, 1.5 * GLOW_K, 0, 0, 0, col('#2a2f35'), 0.35);
      this.planTotem(plan, E.ax + E.tx * mpos + E.nx * 2.6, E.az + E.tz * mpos + E.nz * 2.6, g2, E.nx, E.nz, ekey, ereq, logoCol);
      return;
    }
    // 雨棚（几何原点在地面中心，+z = 开口）
    plan.struct(plan.cn, x, g + 0.05, z, fx, fz);
    const hy = g + 0.05 + 3.12;
    for (const sgn of [1, -1]) {
      plan.sign(x + fx * sgn * (L / 2 + 0.31), hy, z + fz * sgn * (L / 2 + 0.31), fx * sgn, fz * sgn, W + 0.2, 0.9, 0.08, key, 1.5 * GLOW_K, 0, 0, 0, col('#2a2f35'), 0.35);
    }
    // 顶棚灯带
    plan.sign(x - fx * (L / 2 - 0.6), g + 0.05 + 2.93, z - fz * (L / 2 - 0.6), fx, fz, 2.8, 0.05, L - 1.2, null, 2.4 * GLOW_K, 0, 0, F_EMIT, col('#fff1dc'), 0.5);
    // 标识柱：开口前方一侧，面向道路
    const tx = x + fx * (L / 2 + 1.8) + nx * (W / 2 - 0.6), tz = z + fz * (L / 2 + 1.8) + nz * (W / 2 - 0.6);
    this.planTotem(plan, tx, tz, terrain.heightAt(tx, tz), -nx, -nz, ekey, ereq, logoCol);
  }
  planTotem(plan, x, z, g, nx, nz, ekey, ereq, c) {
    const D = 0.36;
    plan.sign(x - nx * D / 2, g + 1.9, z - nz * D / 2, nx, nz, 0.8, 3.8, D, null, 0, 0, 0, 0, c, 0.45);
    plan.sign(x - nx * (D / 2 + 0.01), g + 3.33, z - nz * (D / 2 + 0.01), nx, nz, 0.66, 0.66, D + 0.02, '@logo', 1.8 * GLOW_K, 0, 0, F_STRETCH | F_DOUBLE, c, 0.35);
    const Ac = ereq.w / CH;
    const Wl = 0.7, Hl = Math.min(0.62, Wl / Ac);
    plan.sign(x - nx * (D / 2 + 0.01), g + 2.62, z - nz * (D / 2 + 0.01), nx, nz, Wl, Hl, D + 0.02, ekey, 1.4 * GLOW_K, 0, 0, F_DOUBLE, col('#23272c'), 0.35);
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
    plan.sign(px, g + 2.45, pz, fx, fz, 8.8, 0.4, 0.06, key, 1.3 * GLOW_K, 0, 0, 0, blue, 0.35);
    [px, pz] = P(0, -1.01);
    plan.sign(px, g + 2.45, pz, -fx, -fz, 8.8, 0.4, 0.06, key, 1.3 * GLOW_K, 0, 0, 0, blue, 0.35);
    // 广告灯箱（后墙右端，双面）
    const pk = '@p' + (strHash(name) % 4);
    [px, pz] = P(3.35, -0.92);
    plan.sign(px, g + 1.32, pz, fx, fz, 1.3, 1.95, 0.24, pk, 1.1 * GLOW_K, 0, 0, F_STRETCH | F_DOUBLE, col('#a7acb1'), 0.3);
    // 顶棚灯带
    [px, pz] = P(0, -0.35);
    plan.sign(px, g + 2.43, pz, fx, fz, 8.0, 0.04, 0.35, null, 2.2 * GLOW_K, 0, 0, F_EMIT, col('#eef4ff'), 0.5);
    // 站牌立杆 + 竖向站名牌（双面，朝来车方向）
    const Ac = vreq.w / CH;
    let Hb = Math.min(1.9, 0.52 * Ac), Wb = Hb / Ac;
    [px, pz] = P(-5.6, 0.55);
    plan.sign(px, g + 1.55, pz, X.x, X.z, 0.09, 3.1, 0.09, null, 0, 0, 0, 0, col('#9aa0a6'), 0.3);
    plan.sign(px - X.x * 0.08, g + 3.0 - Hb / 2 - 0.05, pz - X.z * 0.08, X.x, X.z, Wb, Hb, 0.07, vkey, 1.2 * GLOW_K, 0, 0, F_VERT | F_DOUBLE, blue, 0.35);
  }

  /** 补充门头：临街底层外墙按“开间”切槽，空位挂通用店名（共享图集单元） */
  ensureFill(ch) {
    if (ch.fill) return ch.fill;
    // 先确保本块与相邻块的 POI 招牌已占位
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const nb = this.chunk(ch.cx + dx, ch.cz + dz, false);
      if (nb) this.ensurePlan(nb);
    }
    const plan = new Plan();
    const bi = this.bi, P = this.P;
    if (P) {
      const x0 = ch.cx * C, z0 = ch.cz * C;
      const ex = this.ctx.exclusions;
      bi.candidates(ch.x, ch.z, C * 0.72, (b) => {
        const axb = P.ax[b], azb = P.az[b];
        if (axb < x0 || axb >= x0 + C || azb < z0 || azb >= z0 + C) return;
        if (P.minDm[b] !== 0) return;
        const hgt = P.hDm[b] * 0.1;
        if (hgt < 3.0) return;
        const st = P.style ? P.style[b] : 255;
        const prob = st < FILL_P.length ? FILL_P[st] : P.kind[b] === 2 ? 0.7 : P.kind[b] === 3 ? 0 : 0.45;
        if (!prob) return;
        if (ex && ex.test(axb, azb, 'pois')) return;
        const dist = districtOf(axb, azb);
        const gf = this.gfOf(b);
        const n = P.vc[b];
        for (let e = 0; e < n; e++) {
          const E = this.edge(b, e);
          if (E.L < 4.5) continue;
          const mx = E.ax + E.tx * E.L / 2, mz = E.az + E.tz * E.L / 2;
          if (bi.inside(mx + E.nx * 2, mz + E.nz * 2, b) >= 0) continue;
          const r = this.ri.nearest(mx + E.nx * 3, mz + E.nz * 3, 26, this.acceptFill, E.tx, E.tz, 0.8);
          if (!r || r.d > (this.mainCls.has(r.c) ? 32 : 18)) continue;
          // 临街主次干道两侧更密（东大街、解放路、长安路式的连续门头）
          const pe = Math.min(0.97, prob + (this.mainCls.has(r.c) ? (dist === 'wall' ? 0.45 : 0.3) : 0) + (dist !== 'city' ? 0.12 : 0));
          const g0 = this.ctx.terrain.heightAt(mx, mz);
          let a = 0.35, si = 0;
          const hb = strHash(`${b}:${e}`);
          while (a < E.L - 3.3) {
            const hs = hb + si * 7919;
            let sw = 3.6 + hash01(hs) * 3.8;
            if (a + sw > E.L - 0.3) sw = E.L - 0.3 - a;
            if (sw < 3.2) break;
            si++;
            const a0 = a;
            a += sw;
            if (hash01(hs + 1) > pe) continue;
            const m = a0 + sw / 2, Wt = sw - 0.5;
            if (!this.occupy(b, e, 0, m - Wt / 2 - 0.1, m + Wt / 2 + 0.1)) continue;
            const set = dist === 'huimin' ? this.fillKeys.huimin : hash01(hs + 2) < 0.5 ? this.fillKeys.food : this.fillKeys.shop;
            const key = set[(hs >>> 5) % set.length];
            const req = this.permReq.get(key);
            if (!req || !this.perm.get(key)) continue;
            const s = req.s, T = TYPE[s.type] || TYPE.lightbox;
            const Ac = req.w / CH;
            let H = T.H * 0.95;
            if (H * Ac > Wt) H = Wt / Ac;
            H = Math.min(H, hgt - 0.25 - 2.15); // 单层铺面：招牌压在檐口下
            if (H < 0.55) continue;
            let bottom = Math.max(2.45, gf - 0.2 - H);
            if (bottom + H > hgt - 0.25) bottom = hgt - 0.25 - H;
            if (bottom < 2.1) continue;
            const cut = s.type === 'neon' && !s.back;
            const W = cut ? H * Ac : Wt;
            const x = E.ax + E.tx * m + E.nx * 0.05, z = E.az + E.tz * m + E.nz * 0.05;
            const side = col(s.type === 'lightbox' ? '#8e949a' : s.type === 'led' || s.type === 'neon' ? s.back || '#1a1a1a' : s.frame || s.bg || '#333333');
            plan.sign(x, g0 + bottom + H / 2, z, E.nx, E.nz, W, H, T.D, key, (s.glow || 1.6) * T.lit * GLOW_K, s.mode || 0, hash01(hs + 3), cut ? F_CUT : 0, side, T.rough);
            // 二楼招牌（楼上餐馆 / 足疗 / 棋牌等）
            if (hgt > gf + 3.6 && hash01(hs + 8) < (this.mainCls.has(r.c) ? 0.28 : 0.14) && this.occupy(b, e, 1, m - Wt * 0.42, m + Wt * 0.42)) {
              const set2 = hash01(hs + 9) < 0.5 ? this.fillKeys.food : this.fillKeys.shop;
              const k2 = set2[(hs >>> 9) % set2.length];
              const r2 = this.permReq.get(k2);
              if (r2 && this.perm.get(k2)) {
                const s2 = r2.s, T2 = TYPE[s2.type] || TYPE.lightbox;
                const A2 = r2.w / CH;
                let H2 = T2.H * 0.8;
                const W2 = Wt * 0.8;
                if (H2 * A2 > W2) H2 = W2 / A2;
                const cut2 = s2.type === 'neon' && !s2.back;
                if (H2 > 0.5 && gf + 0.5 + H2 < hgt - 0.3) {
                  plan.sign(x, g0 + gf + 0.5 + H2 / 2, z, E.nx, E.nz, cut2 ? H2 * A2 : W2, H2, T2.D, k2, (s2.glow || 1.6) * T2.lit * GLOW_K, s2.mode || 0, hash01(hs + 10), cut2 ? F_CUT : 0,
                    col(s2.type === 'lightbox' ? '#8e949a' : s2.type === 'led' || s2.type === 'neon' ? s2.back || '#1a1a1a' : s2.frame || s2.bg || '#333333'), T2.rough);
                }
              }
            }
            // 竖牌（回民街更多）
            const pb = dist === 'huimin' ? 0.45 : 0.1;
            if (hash01(hs + 4) < pb && hgt > gf + 2) {
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
                plan.sign(vx, g0 + Math.max(2.7, gf - 0.1) + Hb / 2, vz, E.tx, E.tz, Hb / vA, Hb, 0.14, vkey, (vs.glow || 1.8) * VT.lit * GLOW_K, vs.mode || 0, hash01(hs + 6), F_VERT | F_DOUBLE, col(vs.back || vs.bg || '#222222'), VT.rough);
              }
            }
          }
        }
      });
    }
    const fin = plan.finish();
    this.resolve(fin, null);
    ch.fill = fin;
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
  const frame = '#3c4046', glass = '#3e5866', roof = '#565b61', stone = '#8f8d88', voidc = '#1a1b1d';
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
