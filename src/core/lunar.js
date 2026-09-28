// 农历与二十四节气（纯前端，无第三方依赖）
//  · 农历：浏览器内置 Intl 中国历（ICU，按北京时间天文推算），取年/月/日/闰月；不支持时返回 null（界面隐藏该行）
//  · 节气：Meeus 低精度太阳视黄经公式 + 行星/月球摄动修正 + 牛顿迭代，求黄经为 15° 整数倍的时刻，
//    换算为北京时间日期（时刻误差约数分钟；仅当节气恰在午夜前后几分钟时日期可能差一天）。

const DEG = Math.PI / 180;
const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
const ZODIAC = '鼠牛虎兔龙蛇马羊猴鸡狗猪';
const MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const DAY_TENS = ['初', '十', '廿', '三'];
const DAY_UNITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 自小寒起按公历顺序排列（小寒 = 黄经 285°，每个节气 +15°） */
export const TERM_NAMES = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];

// 农历传统节日（月-日）；除夕另行判断（腊月最后一天）
const LUNAR_FESTIVALS = { '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节', '7-7': '七夕', '7-15': '中元节',
  '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节', '12-23': '小年' };
const SOLAR_FESTIVALS = { '1-1': '元旦', '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节', '8-1': '建军节',
  '9-10': '教师节', '10-1': '国庆节' };

export function dayName(d) {
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  return DAY_TENS[Math.floor(d / 10)] + DAY_UNITS[d % 10];
}

// —— 农历（Intl 中国历） ——
let lunarFmt = null;
try {
  const f = new Intl.DateTimeFormat('en-US-u-ca-chinese', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
  if (f.resolvedOptions().calendar === 'chinese') lunarFmt = f;
} catch {
  lunarFmt = null;
}

/**
 * 公历日期（北京时间的年月日）→ 农历。
 * @returns {{year:number|null, month:number, day:number, leap:boolean, ganzhi:string, zodiac:string, monthName:string, dayName:string}|null}
 */
export function lunarDate(y, m, d) {
  if (!lunarFmt) return null;
  try {
    const parts = lunarFmt.formatToParts(Date.UTC(y, m - 1, d, 12));
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const mRaw = get('month') || '';
    const month = parseInt(mRaw, 10);
    const day = parseInt(get('day'), 10);
    const leap = /bis|闰/i.test(mRaw);
    let year = parseInt(get('relatedYear'), 10);
    let cyc; // 干支序号 0..59（0 = 甲子）
    if (Number.isFinite(year)) cyc = (((year - 4) % 60) + 60) % 60;
    else {
      // 旧引擎没有 relatedYear：year 字段是 60 年周期内的序号（1 = 甲子）
      const c = parseInt(get('year'), 10);
      if (!Number.isFinite(c)) return null;
      cyc = (c - 1) % 60;
      year = null;
    }
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 30)) return null;
    return {
      year, month, day, leap,
      ganzhi: GAN[cyc % 10] + ZHI[cyc % 12],
      zodiac: ZODIAC[cyc % 12],
      monthName: (leap ? '闰' : '') + MONTHS[month - 1],
      dayName: dayName(day),
    };
  } catch {
    return null;
  }
}

// —— 节气（太阳视黄经） ——
/** 太阳视黄经（度）。jde：力学时儒略日 */
export function sunApparentLongitude(jde) {
  const T = (jde - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M);
  const omega = (125.04 - 1934.136 * T) * DEG;
  let lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega); // 章动 + 光行差
  // 金星、木星、月球摄动修正（Meeus《Astronomical Formulae for Calculators》，时间自 1900.0 起算）
  // 以 2024–2026 年分至时刻核对：误差由最大约 11 分钟降到 4 分钟以内
  const t = (jde - 2415020.0) / 36525;
  lambda += 0.00134 * Math.cos((153.23 + 22518.7541 * t) * DEG)
    + 0.00154 * Math.cos((216.57 + 45037.5082 * t) * DEG)
    + 0.002 * Math.cos((312.69 + 32964.3577 * t) * DEG)
    + 0.00178 * Math.sin((350.74 + 445267.1142 * t - 0.00144 * t * t) * DEG)
    + 0.00179 * Math.sin((231.19 + 20.2 * t) * DEG);
  return ((lambda % 360) + 360) % 360;
}

// ΔT = TT − UT（天）。2020 年代约 69 秒，粗略外推即可（1 分钟误差对“日期”无影响）
const deltaT = (y) => (69.2 + 0.3 * (y - 2020)) / 86400;
const JD_UNIX0 = 2440587.5;

/** 第 year 年第 i 个节气（0 = 小寒 … 23 = 冬至）的 UTC 儒略日 */
function termJD(year, i) {
  const target = (285 + 15 * i) % 360;
  let jd = Date.UTC(year, 0, 6) / 864e5 + JD_UNIX0 + i * 15.2184; // 初值：小寒约 1 月 6 日，之后每 15.22 天一个
  const dT = deltaT(year);
  for (let k = 0; k < 8; k++) {
    let diff = target - sunApparentLongitude(jd + dT);
    diff = ((diff + 540) % 360) - 180;
    jd += (diff * 365.2422) / 360;
    if (Math.abs(diff) < 1e-7) break;
  }
  return jd;
}

const termCache = new Map();
/**
 * 某公历年的 24 节气（北京时间）。
 * @returns {{name:string, index:number, ms:number, y:number, m:number, d:number, dayNum:number}[]}
 */
export function solarTerms(year) {
  let list = termCache.get(year);
  if (list) return list;
  list = TERM_NAMES.map((name, index) => {
    const ms = (termJD(year, index) - JD_UNIX0) * 864e5;
    const bj = new Date(ms + 8 * 3600e3);
    const y = bj.getUTCFullYear(), m = bj.getUTCMonth() + 1, d = bj.getUTCDate();
    return { name, index, ms, y, m, d, dayNum: Date.UTC(y, m - 1, d) / 864e5 };
  });
  termCache.set(year, list);
  return list;
}

/**
 * 当日节气信息。
 * @returns {{today:string|null, current:object, next:object, daysSince:number, daysToNext:number}}
 */
export function termInfo(y, m, d) {
  const today = Date.UTC(y, m - 1, d) / 864e5;
  const all = [...solarTerms(y - 1).slice(-2), ...solarTerms(y), ...solarTerms(y + 1).slice(0, 2)];
  let current = all[0], next = all[all.length - 1];
  for (let i = 0; i < all.length; i++) {
    if (all[i].dayNum <= today) current = all[i];
    else { next = all[i]; break; }
  }
  return {
    today: current.dayNum === today ? current.name : null,
    current,
    next,
    daysSince: today - current.dayNum,
    daysToNext: next.dayNum - today,
  };
}

/** 节日（公历 + 农历，含除夕） */
export function festivals(y, m, d, lunar) {
  const out = [];
  const s = SOLAR_FESTIVALS[`${m}-${d}`];
  if (s) out.push(s);
  if (lunar && !lunar.leap) {
    const l = LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`];
    if (l) out.push(l);
    if (lunar.month === 12 && lunar.day >= 29) {
      const t = new Date(Date.UTC(y, m - 1, d + 1));
      const nx = lunarDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
      if (nx && nx.month === 1 && nx.day === 1 && !nx.leap) out.push('除夕');
    }
  }
  return out;
}
