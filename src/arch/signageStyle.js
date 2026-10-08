// 招牌样式库：按 POI 类型 / 品牌 / 片区决定招牌形式与配色。
// 颜色取自各品牌门店常见配色（简化，非官方色值）；银行按“工行/中行红、建行蓝、农行绿”等统一色。
// 字段：
//   type   plaque 门头平板 | lightbox 灯箱 | led 发光字（透明底，挂在背板上）| trad 传统黑漆金字牌匾 | neon 霓虹 | ticker LED 滚动屏
//   bg fg  背景 / 文字色；back 发光字背板色；frame 边框色
//   glow   夜间发光强度（线性 HDR，×uNight）；mode 0 常亮 1 闪烁 2 滚动 3 逐字点亮 4 呼吸
//   emblem 左侧标志：icbc boc ccb abc bank(圆+字) m(麦当劳) cross(药店十字) cup(咖啡) post(邮政)
//   blade  是否加挑出式竖向灯箱；vert 优先竖排

export function hash01(n) {
  let x = (n | 0) + 0x9e3779b9;
  x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad); x ^= x >>> 15; x = Math.imul(x, 0x735a2d97); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
export function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 招牌上显示的名称：去掉括号分店名、“｜”后缀与多余空白 */
export function signText(name) {
  let s = String(name || '').trim();
  s = s.replace(/[（(][^）)]*[）)]/g, '').replace(/[｜|].*$/, '').replace(/\s+/g, ' ').trim();
  if (!s) s = String(name || '').trim();
  if ([...s].length > 14) s = [...s].slice(0, 14).join('');
  return s;
}
export const isCJK = (s) => /^[㐀-鿿豈-﫿·]+$/.test(s);

const B = (re, o) => ({ re, ...o });
// —— 品牌（先匹配先得） ——
const BRANDS = [
  // 银行
  B(/工商银行|ICBC/i, { type: 'lightbox', bg: '#c7000b', fg: '#ffffff', emblem: 'icbc', glow: 1.6, bank: 1 }),
  B(/^中国银行|中国银行(?!业)/, { type: 'lightbox', bg: '#b81c22', fg: '#ffffff', emblem: 'boc', glow: 1.6, bank: 1 }),
  B(/建设银行|CCB/, { type: 'lightbox', bg: '#0a4ea2', fg: '#ffffff', emblem: 'ccb', glow: 1.6, bank: 1 }),
  B(/农业银行/, { type: 'lightbox', bg: '#00846b', fg: '#ffffff', emblem: 'abc', glow: 1.6, bank: 1 }),
  B(/交通银行/, { type: 'lightbox', bg: '#1d2c7a', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/招商银行/, { type: 'lightbox', bg: '#c8152d', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/邮政储蓄|邮储/, { type: 'lightbox', bg: '#00804a', fg: '#ffffff', emblem: 'post', glow: 1.6, bank: 1 }),
  B(/兴业银行/, { type: 'lightbox', bg: '#004b9b', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/浦发|浦东发展银行/, { type: 'lightbox', bg: '#0a2f6b', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/中信银行/, { type: 'lightbox', bg: '#c9161d', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/光大银行/, { type: 'lightbox', bg: '#5b2a86', fg: '#ffd400', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/民生银行/, { type: 'lightbox', bg: '#00868b', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/平安银行/, { type: 'lightbox', bg: '#f05a23', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/华夏银行|广发银行|北京银行|东亚银行|西安银行/, { type: 'lightbox', bg: '#c8102e', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/长安银行/, { type: 'lightbox', bg: '#0b5aa6', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/农商银行|农村商业|秦农|信用社/, { type: 'lightbox', bg: '#008c47', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 }),
  B(/中国邮政|邮局|邮政/, { type: 'lightbox', bg: '#007a3d', fg: '#ffffff', emblem: 'post', glow: 1.5 }),
  // 餐饮
  B(/麦当劳|McDonald/i, { type: 'lightbox', bg: '#c8102e', fg: '#ffc72c', emblem: 'm', glow: 2.0 }),
  B(/肯德基|KFC/i, { type: 'lightbox', bg: '#c8102e', fg: '#ffffff', glow: 2.0 }),
  B(/星巴克|Starbucks/i, { type: 'led', back: '#1e3b30', fg: '#e9f2ec', emblem: 'cup', emblemColor: '#00704a', glow: 2.2 }),
  B(/瑞幸|luckin/i, { type: 'lightbox', bg: '#0b2a8f', fg: '#ffffff', emblem: 'cup', glow: 1.8 }),
  B(/蜜雪冰城/, { type: 'lightbox', bg: '#e60012', fg: '#ffffff', glow: 1.9 }),
  B(/喜茶|HEYTEA/i, { type: 'plaque', bg: '#f4f4f2', fg: '#161616', glow: 1.3 }),
  B(/奈雪/, { type: 'plaque', bg: '#f2f0ea', fg: '#2a2a2a', glow: 1.3 }),
  B(/霸王茶姬/, { type: 'plaque', bg: '#1b1b1d', fg: '#d8b46a', glow: 1.6 }),
  B(/茶话弄|茶颜/, { type: 'plaque', bg: '#3a2a20', fg: '#ecd6a4', glow: 1.5 }),
  B(/必胜客|Pizza Hut/i, { type: 'lightbox', bg: '#c8102e', fg: '#ffffff', glow: 1.9 }),
  B(/汉堡王|Burger King/i, { type: 'lightbox', bg: '#d62300', fg: '#f5ebdc', glow: 1.9 }),
  B(/海底捞/, { type: 'lightbox', bg: '#b5121b', fg: '#ffffff', glow: 1.9 }),
  B(/呷哺/, { type: 'lightbox', bg: '#e60012', fg: '#ffffff', glow: 1.9 }),
  B(/真功夫/, { type: 'lightbox', bg: '#d9001b', fg: '#ffffff', glow: 1.9 }),
  B(/赛百味|Subway/i, { type: 'lightbox', bg: '#00843d', fg: '#ffc600', glow: 1.9 }),
  B(/沙县小吃/, { type: 'lightbox', bg: '#1760ad', fg: '#ffffff', glow: 1.9 }),
  B(/德克士|华莱士/, { type: 'lightbox', bg: '#e8380d', fg: '#ffffff', glow: 1.9 }),
  B(/哈根达斯|Häagen|鲜芋仙|DQ/i, { type: 'plaque', bg: '#2b1b3f', fg: '#f3e6c8', glow: 1.6 }),
  B(/Tim Hortons/i, { type: 'lightbox', bg: '#c8102e', fg: '#ffffff', glow: 1.8 }),
  // 零售
  B(/周大福/, { type: 'plaque', bg: '#8f1d21', fg: '#ecc77f', frame: '#c9a15b', glow: 1.8 }),
  B(/周生生/, { type: 'plaque', bg: '#b0101f', fg: '#f0d28c', frame: '#caa35a', glow: 1.8 }),
  B(/六福/, { type: 'plaque', bg: '#1a1a1a', fg: '#d8b45a', frame: '#b48f3e', glow: 1.8 }),
  B(/老凤祥|老庙|周六福|中国黄金/, { type: 'plaque', bg: '#a8141b', fg: '#f3d27a', frame: '#c9a15b', glow: 1.8 }),
  B(/优衣库|UNIQLO/i, { type: 'lightbox', bg: '#e60012', fg: '#ffffff', glow: 1.8 }),
  B(/小米/, { type: 'lightbox', bg: '#ff6900', fg: '#ffffff', glow: 1.8 }),
  B(/名创优品|MINISO/i, { type: 'lightbox', bg: '#e5002d', fg: '#ffffff', glow: 1.8 }),
  B(/华为|HUAWEI/i, { type: 'plaque', bg: '#f2f2f2', fg: '#1a1a1a', glow: 1.4 }),
  B(/荣耀|OPPO|vivo/i, { type: 'plaque', bg: '#f2f2f2', fg: '#1e2a78', glow: 1.4 }),
  B(/中国移动/, { type: 'lightbox', bg: '#0085cf', fg: '#ffffff', glow: 1.7 }),
  B(/中国联通/, { type: 'lightbox', bg: '#e60027', fg: '#ffffff', glow: 1.7 }),
  B(/中国电信/, { type: 'lightbox', bg: '#0062b0', fg: '#ffffff', glow: 1.7 }),
  B(/新华书店|书店|图书/, { type: 'plaque', bg: '#a3151b', fg: '#f6dea0', serif: 1, glow: 1.5 }),
  B(/7-?11|罗森|全家|便利/i, { type: 'lightbox', bg: '#ffffff', fg: '#008c45', glow: 1.7 }),
  B(/永辉|华润万家|人人乐|沃尔玛|超市/, { type: 'lightbox', bg: '#e60012', fg: '#ffffff', glow: 1.7 }),
  B(/Apple/i, { type: 'led', back: '#d9dcdf', fg: '#f5f5f5', glow: 1.8 }),
  // 酒店
  B(/如家/, { type: 'lightbox', bg: '#ffd200', fg: '#3a2c86', glow: 1.8, blade: 1, vert: 1 }),
  B(/7天/, { type: 'lightbox', bg: '#ffd400', fg: '#1b1b1b', glow: 1.8, blade: 1, vert: 1 }),
  B(/汉庭/, { type: 'lightbox', bg: '#1d3f8f', fg: '#ffffff', glow: 1.8, blade: 1, vert: 1 }),
  B(/全季/, { type: 'plaque', bg: '#3b2e2a', fg: '#eadcc5', glow: 1.6, blade: 1, vert: 1 }),
  B(/桔子/, { type: 'lightbox', bg: '#f08300', fg: '#ffffff', glow: 1.8, blade: 1, vert: 1 }),
  B(/格林豪泰/, { type: 'lightbox', bg: '#008a3e', fg: '#ffffff', glow: 1.8, blade: 1, vert: 1 }),
  B(/布丁/, { type: 'lightbox', bg: '#e5007f', fg: '#ffffff', glow: 1.8, blade: 1, vert: 1 }),
  B(/维也纳|锦江|美居|诺富特|宜必思|喜来登|豪生|假日|华美达|希尔顿|万豪|凯悦|洲际|皇冠/, { type: 'led', back: '#2a2522', fg: '#f3d8a2', glow: 2.4, blade: 1, vert: 1, hotelLux: 1 }),
];

// 中国传统老字号：黑漆金字牌匾
const TRAD_RE = /老孙家|同盛祥|德发长|贾三|老米家|老白家|老海家|樊记|西安饭庄|春发生|老童家|老马家|泡馍|肉夹馍|灌汤包|胡辣汤|饺子馆|老字号|茶庄|茗茶|老铺|斋$/;
const FOOD = new Set(['restaurant', 'fast_food', 'food_court', 'biergarten']);
const DRINK = new Set(['cafe', 'ice_cream']);
const HOTEL = new Set(['hotel', 'motel', 'hostel', 'guest_house']);
const FUN = new Set(['cinema', 'theatre', 'karaoke_box', 'nightclub', 'bar', 'pub', 'internet_cafe', 'casino']);

const PALETTE_FOOD = [
  { type: 'lightbox', bg: '#b3121b', fg: '#ffd966', glow: 1.9 },
  { type: 'plaque', bg: '#f5f1e6', fg: '#b3121b', glow: 1.4 },
  { type: 'lightbox', bg: '#f7c600', fg: '#b31217', glow: 1.9 },
  { type: 'plaque', bg: '#5a3a22', fg: '#f4e2b8', glow: 1.5 },
  { type: 'led', back: '#2b2d30', fg: '#ff4a2e', glow: 2.6 },
  { type: 'lightbox', bg: '#0f5c3a', fg: '#fff3c4', glow: 1.8 },
];
const PALETTE_SHOP = [
  { type: 'led', back: '#3a3d42', fg: '#ffffff', glow: 2.4 },
  { type: 'lightbox', bg: '#ffffff', fg: '#1e4fa3', glow: 1.7 },
  { type: 'lightbox', bg: '#1e4fa3', fg: '#ffffff', glow: 1.7 },
  { type: 'plaque', bg: '#141414', fg: '#f2f2f2', glow: 1.5 },
  { type: 'led', back: '#8a8f96', fg: '#e8262b', glow: 2.4 },
  { type: 'lightbox', bg: '#e8262b', fg: '#ffffff', glow: 1.8 },
  { type: 'plaque', bg: '#e9e4d8', fg: '#2c2c2c', glow: 1.3 },
];
const PALETTE_DRINK = [
  { type: 'plaque', bg: '#f3f0e8', fg: '#222222', glow: 1.3 },
  { type: 'led', back: '#5b4331', fg: '#fff1d6', glow: 2.2 },
  { type: 'lightbox', bg: '#2e6b4f', fg: '#ffffff', glow: 1.7 },
  { type: 'plaque', bg: '#fbd9d3', fg: '#8a2b2b', glow: 1.4 },
];
const PALETTE_HOTEL = [
  { type: 'lightbox', bg: '#1b3e7a', fg: '#ffffff', glow: 1.8 },
  { type: 'led', back: '#262626', fg: '#ffd27a', glow: 2.5 },
  { type: 'lightbox', bg: '#8f1d21', fg: '#ffe2a0', glow: 1.8 },
  { type: 'lightbox', bg: '#f6f3ea', fg: '#7a1a1a', glow: 1.6 },
];
const PALETTE_FUN = [
  { type: 'neon', fg: '#ff3ca6', glow: 3.4, mode: 1 },
  { type: 'neon', fg: '#35d6ff', glow: 3.4, mode: 4 },
  { type: 'neon', fg: '#ffd23c', glow: 3.2, mode: 3 },
  { type: 'neon', fg: '#8cff5a', glow: 3.2, mode: 1 },
];
// 回民街 / 北院门：夜里满街红绿 LED 竖招 + 黑漆金字
const PALETTE_HUIMIN = [
  { type: 'trad', bg: '#1d1510', fg: '#e3b861', frame: '#8a6a2e', glow: 1.5, serif: 1 },
  { type: 'trad', bg: '#2a1a12', fg: '#f0c870', frame: '#9a7432', glow: 1.5, serif: 1 },
  { type: 'neon', fg: '#ff3b30', glow: 3.0, mode: 0, back: '#101010', dots: 1 },
  { type: 'neon', fg: '#39ff6a', glow: 3.0, mode: 4, back: '#101010', dots: 1 },
  { type: 'lightbox', bg: '#f6d21a', fg: '#c1121f', glow: 2.0 },
  { type: 'lightbox', bg: '#1d4ea1', fg: '#ffffff', glow: 1.8 },
];

/** 片区：回民街（北院门/西羊市/大皮院一带）、明城墙内 */
export function districtOf(x, z) {
  if (x > -760 && x < 20 && z > -680 && z < -60) return 'huimin';
  if (x > -2000 && x < 2150 && z > -1650 && z < 1350) return 'wall';
  // 用户点名的“街景级”片区走廊（streetscape 模块覆盖区）：临街门头更密
  if ((x > -450 && x < 1250 && z > -8760 && z < -8560) || (x > -80 && x < 120 && z > -9330 && z < -7700)) return 'street'; // 凤城七路 / 未央路
  if (x > 3690 && x < 4720 && z > 6080 && z < 7440) return 'street'; // 曲江池东路 / 曲江池南路 / 新开门南路
  if (x > 5200 && x < 7200 && z > -8600 && z < -7400) return 'street'; // 浐灞欧亚大道两岸
  return 'city';
}

/**
 * 选样式。poi: {n, k, i}；返回新对象（可修改）。
 */
export function pickStyle(poi, text, district) {
  const h = strHash(poi.n + poi.k);
  const r = hash01(h);
  let s = null;
  for (const b of BRANDS) if (b.re.test(poi.n)) { s = { ...b, brand: 1 }; break; }
  const k = poi.k;
  if (!s) {
    if (k === 'bank' || k === 'atm') s = { type: 'lightbox', bg: '#1a4f8b', fg: '#ffffff', emblem: 'bank', glow: 1.6, bank: 1 };
    else if (k === 'pharmacy' || /药/.test(poi.n)) s = { type: 'lightbox', bg: '#00843d', fg: '#ffffff', emblem: 'cross', glow: 1.8, blade: 1, bladeCross: 1 };
    else if (k === 'post_office') s = { type: 'lightbox', bg: '#007a3d', fg: '#ffffff', emblem: 'post', glow: 1.5 };
    else if (k === 'clinic' || k === 'dentist' || k === 'hospital' || k === 'doctors') s = { type: 'lightbox', bg: '#ffffff', fg: '#0a6a4a', emblem: 'cross', emblemColor: '#d7141a', glow: 1.5 };
    else if (district === 'huimin' && (FOOD.has(k) || k === 'shop' || DRINK.has(k))) s = { ...PALETTE_HUIMIN[(h >>> 3) % PALETTE_HUIMIN.length] };
    else if (FOOD.has(k) && TRAD_RE.test(poi.n)) s = { type: 'trad', bg: '#1d1510', fg: '#e3b861', frame: '#8a6a2e', glow: 1.5, serif: 1 };
    else if (FOOD.has(k)) s = { ...PALETTE_FOOD[(h >>> 3) % PALETTE_FOOD.length] };
    else if (DRINK.has(k)) s = { ...PALETTE_DRINK[(h >>> 3) % PALETTE_DRINK.length] };
    else if (HOTEL.has(k)) s = { ...PALETTE_HOTEL[(h >>> 3) % PALETTE_HOTEL.length], blade: 1, vert: 1 };
    else if (FUN.has(k)) s = { ...PALETTE_FUN[(h >>> 3) % PALETTE_FUN.length] };
    else if (k === 'marketplace') s = { type: 'lightbox', bg: '#c1121f', fg: '#ffe066', glow: 1.9 };
    else if (district === 'wall' && r < 0.18) s = { type: 'trad', bg: '#1d1510', fg: '#e3b861', frame: '#8a6a2e', glow: 1.5, serif: 1 };
    else s = { ...PALETTE_SHOP[(h >>> 3) % PALETTE_SHOP.length] };
  }
  if (district === 'huimin' && s.type === 'trad' && TRAD_RE.test(poi.n)) s.frame = '#b08d3c';
  if (s.type === 'trad') s.serif = 1;
  s.h = h;
  s.r = r;
  // 挑出式竖牌：酒店/药店必加，餐馆与小店按概率（回民街更多）
  if (!s.blade) {
    const p = district === 'huimin' ? 0.55 : FOOD.has(k) ? 0.28 : k === 'shop' ? 0.18 : DRINK.has(k) ? 0.2 : 0;
    s.blade = hash01(h + 7) < p ? 1 : 0;
  }
  // 少量 LED 滚动屏（银行、药店、酒店门口常见）
  s.ticker = (s.bank && hash01(h + 11) < 0.55) || ((k === 'pharmacy' || HOTEL.has(k)) && hash01(h + 11) < 0.35) || (FOOD.has(k) && hash01(h + 11) < 0.08) ? 1 : 0;
  // 少量霓虹闪烁（非品牌）
  if (!s.mode && !s.brand && !s.bank && hash01(h + 13) < 0.06) s.mode = hash01(h + 17) < 0.5 ? 1 : 3;
  return s;
}

// ———————————————————— 夜间发光上限 ————————————————————
// 夜景泛光阈值约 0.7（线性 HDR 亮度，见 core/post.js），超过阈值的像素整块进入泛光。灯箱/牌匾整面发光，
// 若按固定倍率（旧值 1.6~2.0）点亮，黄/白底整块冲过阈值，泛光把字淹没成一团光（“串串香”、红底白字招牌）。
// 做法：按招牌发光部分的最大亮度归一——整面发光的灯箱压到阈值以下（只亮不晕，字底对比按原配色保留），
// 发光字/霓虹只有细笔画发光，允许略超阈值留一点光晕（霓虹感）。
const srgbLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** '#rrggbb' → 线性亮度 */
export function hexLum(hex) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return 0;
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.2126 * srgbLin(((n >> 16) & 255) / 255) + 0.7152 * srgbLin(((n >> 8) & 255) / 255) + 0.0722 * srgbLin((n & 255) / 255);
}
/** 与 signagePaint.lighter 相同的提亮（霓虹字芯 = 字色向白提亮 62%） */
function lighterHex(hex, k) {
  const n = parseInt(hex.slice(1, 7), 16);
  const f = (v) => Math.round(v + (255 - v) * k);
  return '#' + [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
/** 夜间发光部分的最大线性亮度 */
export function signLum(s) {
  const fg = s.fg || '#ffffff';
  let L;
  if (s.type === 'led' || s.type === 'ticker') L = hexLum(fg);
  else if (s.type === 'neon') L = Math.max(hexLum(lighterHex(fg, 0.62)), s.back ? hexLum(s.back) : 0);
  else L = Math.max(hexLum(s.bg || '#ffffff'), hexLum(fg), s.emblemColor ? hexLum(s.emblemColor) : 0);
  return Math.max(L, 0.04);
}
/** 发光亮度上限（线性 HDR）：整面灯箱 < 泛光阈值；发光字/霓虹细笔画略高于阈值 */
export const GLOW_CAP = { lightbox: 0.62, plaque: 0.62, trad: 0.62, led: 0.95, neon: 1.25, ticker: 0.9, roof: 1.15 };
export function capGlow(s, glow, cap = GLOW_CAP[s.type] ?? 0.62) {
  return Math.min(glow, cap / signLum(s));
}

// ———————————————————— 补充门头店名库（按街道等级选业态） ————————————————————
// 主干道（trunk / primary：东西南北大街、长安路、小寨东西路……）：沿街是银行、品牌零售、珠宝、通讯营业厅、连锁酒店、
// 连锁餐饮与西安本地老字号，而不是“黄焖鸡米饭 / 数码冲印”这类小巷底商。[业态 kind, 店名]
export const FILL_MAIN = [
  ['bank', '中国工商银行'], ['bank', '中国建设银行'], ['bank', '中国农业银行'], ['bank', '中国银行'], ['bank', '交通银行'], ['bank', '招商银行'],
  ['bank', '中国邮政储蓄银行'], ['bank', '浦发银行'], ['bank', '中信银行'], ['bank', '兴业银行'], ['bank', '光大银行'], ['bank', '民生银行'],
  ['bank', '平安银行'], ['bank', '西安银行'], ['bank', '长安银行'], ['bank', '华夏银行'],
  ['shop', '周大福'], ['shop', '老凤祥'], ['shop', '周生生'], ['shop', '六福珠宝'], ['shop', '中国黄金'], ['shop', '老庙黄金'],
  ['shop', '中国移动'], ['shop', '中国联通'], ['shop', '中国电信'], ['shop', '华为'], ['shop', '小米之家'], ['shop', 'OPPO'], ['shop', 'vivo'],
  ['shop', '李宁'], ['shop', '安踏'], ['shop', '特步'], ['shop', '海澜之家'], ['shop', '波司登'], ['shop', '太平鸟'], ['shop', '鸿星尔克'],
  ['shop', '宝岛眼镜'], ['shop', '精益眼镜'], ['shop', '屈臣氏'], ['shop', '名创优品'], ['shop', '新华书店'], ['shop', '西部证券'], ['shop', '中国人寿'],
  ['pharmacy', '怡康医药'], ['pharmacy', '广济堂医药'], ['pharmacy', '老百姓大药房'],
  ['hotel', '如家酒店'], ['hotel', '汉庭酒店'], ['hotel', '全季酒店'], ['hotel', '维也纳酒店'], ['hotel', '锦江之星'], ['hotel', '7天酒店'],
  ['fast_food', '肯德基'], ['fast_food', '麦当劳'], ['fast_food', '德克士'], ['restaurant', '必胜客'], ['cafe', '星巴克'], ['cafe', '瑞幸咖啡'],
  ['restaurant', '魏家凉皮'], ['restaurant', '老米家泡馍'], ['restaurant', '西安饭庄'], ['restaurant', '同盛祥'], ['restaurant', '德发长'],
  ['restaurant', '春发生'], ['restaurant', '樊记腊汁肉夹馍'], ['restaurant', '海底捞'], ['cafe', '喜茶'], ['cafe', '茶话弄'], ['cafe', '霸王茶姬'],
];
/** 次干道上可用的“体面”小店名（排除五金、开锁、棋牌、冲印这类小巷业态） */
export const FILL_OK = new Set([
  '西府臊子面', '陕西油泼面', '关中羊肉泡馍', '老碗面馆', '重庆小面', '家常菜馆', '湘菜馆', '老火锅', '酸菜鱼', '面包坊', '蛋糕烘焙', '烤鱼',
  '牛肉面', 'biangbiang面', '葫芦头泡馍', '腊汁肉夹馍', '岐山面馆', '汉中热米皮', '秦镇米皮', '秦味肉夹馍', '石锅拌饭',
  '明视眼镜', '鑫源通讯', '丽人美发', '美容美甲', '大众药房', '康民大药房', '鲜果时光', '花语鲜花', '茗茶茶叶', '时尚女装', '男装折扣',
  '品牌鞋店', '母婴用品', '化妆品', '口腔诊所', '健身会所', '婚纱摄影', '童装', '便民超市', '好又多便利店',
]);

/** 商场/百货类名称：做楼顶大字 */
export const MALL_RE = /购物中心|购物广场|百货|商场|商城|奥特莱斯|奥莱|万达广场|大悦城|赛格|开元商城|世纪金花|王府井|万象城|银泰|砂之船|SKP|益田|大融城|印象城|龙湖|吾悦|凯德|茂业|民生百货|金鹰|太古里|老城根|华旗|兴正元|世贸/i;
/** 楼顶发光字的建筑名（大厦/酒店/商场） */
export const ROOF_NAME_RE = /大厦|酒店|饭店|宾馆|大酒店|国际|中心|银行|商城|百货|广场|SKP|万达|赛格|开元|金花|王府井|集团|书城|图书大厦/;
