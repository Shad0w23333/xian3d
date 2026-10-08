// 左上角“西安时讯”卡片（位置信息卡下方，独立、可折叠、可拖动；默认折叠成一行，不挡画面）：
//   · 时间：现实北京时间（Asia/Shanghai）年月日/星期/时分秒、农历与节气、节日；与“场景时间”并列显示，
//     不一致时提示“场景时间与现实不同”，可一键“场景同步当前时间”让昼夜跟随现实
//   · 天气为现实中的实时天气（与场景的白天/夜景无关，明确标注“现实”）
//   · 天气：Open-Meteo 实时天气 + 空气质量（免费、无需 Key、支持 CORS），每 10 分钟刷新；可选“天气同步到场景”（云量/雾）
//   · 广播：西安/陕西网络广播（见 core/radio.js），多候选源自动回退
// 用法（main.js）：setupInfoCard({ root, ui, sky, display, params })；URL 参数 infocard=0 关闭，ui=0 时不创建。
import { lunarDate, termInfo, festivals } from './lunar.js';
import { STATIONS, RETIRED, RadioPlayer } from './radio.js';

const LAT = 34.26, LON = 108.94; // 钟楼一带
const STORE_KEY = 'xian3d.infocard.v1';
const WX_CACHE_KEY = 'xian3d.infocard.wx.v1';
const REFRESH_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT = 20000;

const WX_URL = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: LAT, longitude: LON, timezone: 'Asia/Shanghai', wind_speed_unit: 'ms', forecast_days: 2,
  current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,uv_index',
  hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,uv_index_max',
});
const AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality?' + new URLSearchParams({
  latitude: LAT, longitude: LON, timezone: 'Asia/Shanghai',
  current: 'pm2_5,pm10,us_aqi,european_aqi,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone',
});

// —— 工具 ——
const h = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const pad = (n) => String(n).padStart(2, '0');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const n0t = (v) => (fin(v) ? `${Math.round(v)}°` : '—');
const hhmm = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : '—');
const WEEK = '日一二三四五六';

function loadStore(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v === 'object' ? { ...def, ...v } : { ...def };
  } catch {
    return { ...def };
  }
}
function saveStore(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch {}
}

/** 北京时间各字段。中国自 1991 年起不再实行夏令时，Asia/Shanghai 恒为 UTC+8，直接按偏移计算 */
function beijingNow(ms = Date.now()) {
  const t = new Date(ms + 8 * 3600e3);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), wd: t.getUTCDay() };
}

async function fetchJSON(url) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl ? ctl.signal : undefined, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j && j.error) throw new Error(j.reason || '接口错误');
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// —— 天气现象（WMO 4677 天气代码）→ 中文 + 图标（[名称, 白天图标, 夜间图标]） ——
const WMO = {
  0: ['晴', '☀️', '🌙'], 1: ['晴间多云', '🌤️', '🌙'], 2: ['多云', '⛅', '☁️'], 3: ['阴', '☁️'],
  45: ['雾', '🌫️'], 48: ['冻雾', '🌫️'],
  51: ['小毛毛雨', '🌦️', '🌧️'], 53: ['毛毛雨', '🌦️', '🌧️'], 55: ['浓毛毛雨', '🌧️'], 56: ['冻毛毛雨', '🌧️'], 57: ['强冻毛毛雨', '🌧️'],
  61: ['小雨', '🌦️', '🌧️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'], 66: ['冻雨', '🌧️'], 67: ['强冻雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['米雪', '🌨️'],
  80: ['小阵雨', '🌦️', '🌧️'], 81: ['阵雨', '🌧️'], 82: ['强阵雨', '⛈️'], 85: ['阵雪', '🌨️'], 86: ['强阵雪', '❄️'],
  95: ['雷阵雨', '⛈️'], 96: ['雷阵雨伴冰雹', '⛈️'], 99: ['强雷阵雨伴冰雹', '⛈️'],
};
function wmo(code, isDay = 1) {
  const w = WMO[code] || ['未知', '🌡️'];
  return { name: w[0], icon: !isDay && w[2] ? w[2] : w[1] };
}
const isRainy = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
const isSnowy = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;

// —— 风：16 方位（风的来向）+ 蒲福风级 ——
const DIR16 = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南', '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北'];
const dirName = (deg) => DIR16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const BEAUFORT = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1, 61.3];
const BEAUFORT_NAME = ['静风', '软风', '轻风', '微风', '和风', '清风', '强风', '疾风', '大风', '烈风', '狂风', '暴风', '台风'];
const beaufort = (ms) => BEAUFORT.reduce((n, t) => (ms >= t ? n + 1 : n), 0);
const beaufortName = (lv) => BEAUFORT_NAME[Math.min(lv, 12)];

// —— 空气质量：按中国《环境空气质量指数（AQI）技术规定》HJ 633-2012 由实时浓度计算 ——
const IAQI = [0, 50, 100, 150, 200, 300, 400, 500];
const AQ_BP = {
  pm2_5: [0, 35, 75, 115, 150, 250, 350, 500], // μg/m³（24 小时分级，实时报沿用）
  pm10: [0, 50, 150, 250, 350, 420, 500, 600],
  sulphur_dioxide: [0, 150, 500, 650, 800], // 1 小时；>800 时标准改用 24 小时浓度，这里按 200 封顶
  nitrogen_dioxide: [0, 100, 200, 700, 1200, 2340, 3090, 3840],
  carbon_monoxide: [0, 5, 10, 35, 60, 90, 120, 150], // mg/m³（接口为 μg/m³，计算时 /1000）
  ozone: [0, 160, 200, 300, 400, 800, 1000, 1200],
};
const AQ_NAME = { pm2_5: 'PM2.5', pm10: 'PM10', sulphur_dioxide: 'SO₂', nitrogen_dioxide: 'NO₂', carbon_monoxide: 'CO', ozone: 'O₃' };
function iaqi(c, bp) {
  if (!fin(c) || c < 0) return null;
  for (let i = 1; i < bp.length; i++) {
    if (c <= bp[i]) return Math.ceil(((IAQI[i] - IAQI[i - 1]) / (bp[i] - bp[i - 1])) * (c - bp[i - 1]) + IAQI[i - 1]);
  }
  return IAQI[bp.length - 1];
}
function chinaAQI(cur) {
  let aqi = null, primary = null;
  const sub = {};
  for (const k of Object.keys(AQ_BP)) {
    const c = k === 'carbon_monoxide' && fin(cur[k]) ? cur[k] / 1000 : cur[k];
    const v = iaqi(c, AQ_BP[k]);
    sub[k] = v;
    if (v != null && (aqi == null || v > aqi)) { aqi = v; primary = k; }
  }
  return { aqi, primary: aqi > 50 ? primary : null, sub };
}
// [上限, 等级, 底色, 字色]
const AQI_LEVELS = [
  [50, '优', '#00e400', '#0b2a0b'], [100, '良', '#ffff00', '#2a2a00'], [150, '轻度污染', '#ff7e00', '#2a1500'],
  [200, '中度污染', '#ff0000', '#fff'], [300, '重度污染', '#99004c', '#fff'], [Infinity, '严重污染', '#7e0023', '#fff'],
];
const aqiLevel = (v) => AQI_LEVELS.find((l) => v <= l[0]) || AQI_LEVELS[AQI_LEVELS.length - 1];

// —— 天气 → 场景参数（sky 只有云量/云密度与雾浓度可调；雨雪无粒子，用更厚的云与雾表现） ——
function weatherToScene(cur) {
  const cc = fin(cur.cloud_cover) ? clamp(cur.cloud_cover, 0, 100) / 100 : 0.3;
  const code = cur.weather_code | 0;
  const wet = isRainy(code) || isSnowy(code) || (fin(cur.precipitation) && cur.precipitation > 0.05);
  const coverage = clamp(0.03 + 0.82 * Math.pow(cc, 0.85) + (wet ? 0.08 : 0), 0, 0.92);
  const density = clamp(0.22 + 0.38 * cc + (wet ? 0.25 : 0), 0.15, 0.95);
  // 能见度 ≥ 20 km 视为通透（倍率 1），以对数插值到 0.5 km 时 8 倍
  const vis = fin(cur.visibility) ? cur.visibility : 20000;
  let fog = 1 + (Math.log(20000 / clamp(vis, 500, 20000)) / Math.log(40)) * 7;
  if (wet) fog *= 1.3;
  if (code === 45 || code === 48) fog = Math.max(fog, 5);
  return { coverage, density, fog: clamp(fog, 0.6, 8) };
}

const ARROW_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 L18 20 L12 16 L6 20 Z"/></svg>';

class InfoCard {
  constructor({ root, ui, sky, display, params }) {
    this.root = root;
    this.ui = ui;
    this.sky = sky;
    this.display = display;
    this.state = loadStore(STORE_KEY, { collapsed: true, tab: 'wx', pos: null, volume: 0.8, muted: false, station: null, wxSync: false, follow: false });
    // 2026-10 起默认折叠（展开时与信息栏、小地图一起占满左栏）：旧存档里的“展开”迁移一次为折叠
    if (!this.state.ui2) {
      this.state.collapsed = true;
      this.state.ui2 = true;
      saveStore(STORE_KEY, this.state);
    }
    if (params && params.has('time')) this.state.follow = false; // URL 指定了场景时间：不自动跟随现实时间
    this.wx = null; // { fc, aq, fetchedAt }
    this.wxError = null;
    this._dateKey = '';
    this._lastSync = null; // { hours, at }
    this.radio = new RadioPlayer((s) => this._renderRadio(s));
    this.radio.volume = fin(this.state.volume) ? this.state.volume : 0.8;
    this.radio.muted = !!this.state.muted;
    this._build();
    this._bind();
    this._tick();
    // 先显示缓存（离线时也有内容），再联网刷新
    const cached = loadStore(WX_CACHE_KEY, {});
    if (cached.fc) {
      this.wx = { fc: cached.fc, aq: cached.aq || null, fetchedAt: cached.fetchedAt || 0, cached: true };
      this._renderWeather();
    }
    this.refreshWeather();
    this._wxTimer = setInterval(() => { if (!document.hidden) this.refreshWeather(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.wx && Date.now() - this.wx.fetchedAt > REFRESH_MS) this.refreshWeather();
    });
    if (display && display.onChange) display.onChange(() => this._applySceneWeather());
  }

  _save() {
    saveStore(STORE_KEY, this.state);
  }

  // ———————————————— 构建 ————————————————
  _build() {
    const el = h('section', 'panel xcard');
    el.setAttribute('aria-label', '西安时讯：时间、天气、广播');
    const groups = [...new Set(STATIONS.map((s) => s.group))];
    const stationHtml = groups.map((g) => `
      <div class="xc-grp">${g}</div>
      ${STATIONS.filter((s) => s.group === g).map((s) => `
        <button class="xc-st" data-id="${s.id}" title="${esc(`${s.name} ${s.freq}${s.alt ? ' / ' + s.alt : ''}${s.unverified ? '（直播地址未核实）' : ''}`)}">
          <span class="xc-st-f">${s.freq}</span>
          <span class="xc-st-n">${esc(s.name)}${s.sub ? `<small>${esc(s.sub)}</small>` : s.alt ? `<small>${s.alt}</small>` : ''}${s.unverified ? '<small class="xc-unv">未核实</small>' : ''}</span>
          <i class="xc-st-s" aria-hidden="true"></i>
        </button>`).join('')}`).join('');
    el.innerHTML = `
      <header class="xc-head" title="拖动移动位置 · 双击恢复默认位置">
        <span class="xc-logo" aria-hidden="true">◷</span>
        <div class="xc-title"><b>西安时讯</b><small>现实时间 · 实时天气 · 广播</small></div>
        <span class="xc-mini" title="现实中的北京时间与实时天气（不是场景里的时间）"><em class="xc-real">现实</em><b class="xc-mini-t">--:--</b><span class="xc-mini-w"></span><span class="xc-mini-r"></span></span>
        <button class="xc-fold" title="折叠 / 展开" aria-expanded="true">▾</button>
      </header>
      <div class="xc-body">
        <div class="xc-time">
          <div class="xc-clock"><b class="xc-hms">--:--:--</b><span class="xc-tz">现实 · 北京时间</span></div>
          <div class="xc-date">—</div>
          <div class="xc-scene" title="场景里的太阳/昼夜按这个时间计算（右侧面板时间滑块）">场景时间 <b class="xc-scene-t">--:--</b> <span class="xc-scene-s"></span></div>
          <div class="xc-lunar"></div>
          <div class="xc-tacts">
            <button class="xc-sync" title="把场景的太阳/昼夜设到当前北京时间">⟳ 场景同步当前时间</button>
            <label class="xc-chk" title="每 15 秒把场景时间对齐到现实时间；手动调整时间后自动停止"><input type="checkbox" class="xc-follow" /> 持续跟随</label>
          </div>
        </div>
        <nav class="xc-tabs" role="tablist">
          <button data-tab="wx" role="tab">实时天气 · 空气</button>
          <button data-tab="radio" role="tab">网络广播<i class="xc-live" aria-hidden="true"></i></button>
        </nav>
        <div class="xc-player" hidden>
          <button class="xc-pp" title="播放 / 暂停">▶</button>
          <div class="xc-np"><b class="xc-np-n">—</b><small class="xc-np-s">—</small></div>
          <button class="xc-mute" title="静音">🔊</button>
          <input type="range" class="xc-vol" min="0" max="1" step="0.01" title="音量" />
        </div>
        <div class="xc-pane xc-wx" data-pane="wx">
          <div class="xc-wx-msg">正在获取西安实时天气……</div>
          <div class="xc-wx-note">现实中的西安天气（与场景的白天 / 夜景设置无关）</div>
          <div class="xc-wx-data" hidden>
            <div class="xc-now">
              <span class="xc-ico"></span>
              <div class="xc-temp"><b></b><small></small></div>
              <div class="xc-cond"><b></b><small></small></div>
            </div>
            <div class="xc-aqi"></div>
            <div class="xc-wind">
              <span class="xc-arrow" title="">${ARROW_SVG}</span>
              <div><b class="xc-wind-a"></b><small class="xc-wind-b"></small></div>
            </div>
            <div class="xc-grid"></div>
            <div class="xc-hours"></div>
          </div>
          <div class="xc-wx-foot">
            <span class="xc-upd"></span>
            <button class="xc-refresh" title="立即刷新">刷新</button>
            <label class="xc-chk" title="把云量、能见度（雾）、降水映射到场景天空与大气雾"><input type="checkbox" class="xc-wxsync" /> 天气同步到场景</label>
          </div>
          <div class="xc-src">数据：Open-Meteo（天气 / CAMS 空气质量模型，AQI 按国标 HJ 633 由实时浓度计算）</div>
        </div>
        <div class="xc-pane xc-radio" data-pane="radio">
          <div class="xc-stations">${stationHtml}</div>
          <div class="xc-note">
            已停播：${RETIRED.map(([f, n, d]) => `${f} ${n}（${d}）`).join('、')}。<br />
            直播流来自蜻蜓 FM、央广等第三方平台，地址可能变动；无法播放时会自动尝试备用源。
          </div>
        </div>
      </div>`;
    this.el = el;
    this.root.appendChild(el);
    const $ = (s) => el.querySelector(s);
    this.$ = $;
    $('.xc-follow').checked = !!this.state.follow;
    $('.xc-wxsync').checked = !!this.state.wxSync;
    $('.xc-vol').value = String(this.radio.volume);
    this._setCollapsed(!!this.state.collapsed, false);
    this._setTab(this.state.tab === 'radio' ? 'radio' : 'wx', false);
    this._renderMute();
    // 上次收听的台：只高亮、显示在播放条，不自动播放（浏览器也不允许无手势自动播放）
    const last = STATIONS.find((s) => s.id === this.state.station);
    if (last) {
      this.radio.station = last;
      this._renderRadio({ status: 'paused', message: '点击 ▶ 继续收听', station: last, srcIndex: -1, srcCount: last.src.length });
    }
    this._place();
  }

  _bind() {
    const el = this.el, $ = this.$;
    // 卡片内交互不触发画面鼠标锁定
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    $('.xc-fold').addEventListener('click', () => this._setCollapsed(!this.state.collapsed));
    el.querySelectorAll('.xc-tabs button').forEach((b) => b.addEventListener('click', () => this._setTab(b.dataset.tab)));
    $('.xc-sync').addEventListener('click', () => this.syncSceneTime(true));
    $('.xc-follow').addEventListener('change', (e) => this._setFollow(e.target.checked));
    $('.xc-refresh').addEventListener('click', () => this.refreshWeather(true));
    $('.xc-wxsync').addEventListener('change', (e) => {
      this.state.wxSync = e.target.checked;
      this._save();
      this._applySceneWeather();
      this.ui?.toast?.(this.state.wxSync ? (this.wx ? '场景天空已同步西安实时天气（云量 / 能见度）' : '天气数据到达后将同步到场景') : '已恢复默认天空');
    });
    // 广播
    $('.xc-stations').addEventListener('click', (e) => {
      const b = e.target.closest('.xc-st');
      if (!b) return;
      const st = STATIONS.find((s) => s.id === b.dataset.id);
      if (!st) return;
      this.state.station = st.id;
      this._save();
      this.radio.toggle(st);
    });
    $('.xc-pp').addEventListener('click', () => this.radio.station && this.radio.toggle(this.radio.station));
    $('.xc-vol').addEventListener('input', (e) => {
      this.radio.volume = parseFloat(e.target.value);
      if (this.radio.muted && this.radio.volume > 0) this.radio.muted = false;
      this.state.volume = this.radio.volume;
      this.state.muted = this.radio.muted;
      this._renderMute();
    });
    $('.xc-vol').addEventListener('change', () => this._save());
    $('.xc-mute').addEventListener('click', () => {
      this.radio.muted = !this.radio.muted;
      this.state.muted = this.radio.muted;
      this._save();
      this._renderMute();
    });
    this._bindDrag();
    // 布局：跟随信息卡高度、窗口尺寸、小地图显隐
    const relayout = () => this._place();
    window.addEventListener('resize', relayout);
    if (typeof ResizeObserver !== 'undefined' && this.ui?.info) new ResizeObserver(relayout).observe(this.ui.info);
    if (typeof MutationObserver !== 'undefined' && this.ui?.mini) new MutationObserver(relayout).observe(this.ui.mini, { attributes: true, attributeFilter: ['class'] });
  }

  _bindDrag() {
    const head = this.$('.xc-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button,input,label')) return;
      const r = this.el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId, moved: false };
      head.setPointerCapture?.(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const x = e.clientX - drag.dx, y = e.clientY - drag.dy;
      if (!drag.moved && Math.hypot(x - this.el.offsetLeft, y - this.el.offsetTop) < 3) return;
      drag.moved = true;
      this.el.classList.add('dragging');
      this.state.pos = { x: Math.round(x), y: Math.round(y) };
      this._place();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) this._save();
      drag = null;
      this.el.classList.remove('dragging');
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      this.state.pos = null;
      this._save();
      this._place();
    });
  }

  /** 定位：默认贴在位置信息卡下方；拖动后用保存的位置（夹在视口内）；底部给小地图让位 */
  _place() {
    const el = this.el;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth || 300;
    let x, y;
    const p = this.state.pos;
    if (p && fin(p.x) && fin(p.y)) {
      x = clamp(p.x, 4, Math.max(4, vw - w - 4));
      y = clamp(p.y, 4, Math.max(4, vh - 44));
    } else {
      const info = this.ui?.info;
      const r = info && info.isConnected ? info.getBoundingClientRect() : null;
      x = r && r.width ? r.left : 16;
      y = r && r.height ? r.bottom + 10 : 16;
    }
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    let bottom = vh - 12;
    const mini = this.ui?.mini;
    if (mini && mini.isConnected && !mini.classList.contains('off')) {
      const mr = mini.getBoundingClientRect();
      if (mr.height && x < mr.right && x + w > mr.left && mr.top > y + 160) bottom = mr.top - 10;
    }
    el.style.maxHeight = `${Math.max(120, bottom - y)}px`;
  }

  _setCollapsed(c, save = true) {
    this.state.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    const b = this.$('.xc-fold');
    b.textContent = c ? '▸' : '▾';
    b.setAttribute('aria-expanded', String(!c));
    if (save) this._save();
    this._place();
  }

  _setTab(tab, save = true) {
    this.state.tab = tab;
    this.el.querySelectorAll('.xc-tabs button').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    this.el.querySelectorAll('.xc-pane').forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (save) this._save();
  }

  // ———————————————— 时间 ————————————————
  _tick() {
    const t = beijingNow();
    const hms = `${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
    this.$('.xc-hms').textContent = hms;
    this.$('.xc-mini-t').textContent = hms.slice(0, 5);
    const key = `${t.y}-${t.mo}-${t.d}`;
    if (key !== this._dateKey) {
      this._dateKey = key;
      this._renderDate(t);
    }
    if (this.state.follow) this._followStep();
    this._renderSceneTime(t);
    this._clockT = setTimeout(() => this._tick(), 1000 - (Date.now() % 1000) + 8);
  }

  /** 场景时间与现实时间对照（相差超过 10 分钟时提示不同步） */
  _renderSceneTime(t) {
    const sky = this.sky;
    if (!sky || !Number.isFinite(sky.hours)) return;
    const hs = ((sky.hours % 24) + 24) % 24;
    const hh = Math.floor(hs), mm = Math.floor((hs - hh) * 60);
    this.$('.xc-scene-t').textContent = `${pad(hh)}:${pad(mm)}`;
    let d = Math.abs(hs - (t.h + t.mi / 60));
    d = Math.min(d, 24 - d);
    const el = this.$('.xc-scene-s');
    const night = (sky.night ?? 0) > 0.5;
    el.textContent = d < 1 / 6 ? '（与现实同步）' : `（${night ? '夜景' : '白天'}，与现实不同步）`;
    el.classList.toggle('diff', d >= 1 / 6);
  }

  _renderDate(t) {
    this.$('.xc-date').textContent = `${t.y}年${t.mo}月${t.d}日 星期${WEEK[t.wd]}`;
    const L = lunarDate(t.y, t.mo, t.d);
    const T = termInfo(t.y, t.mo, t.d);
    const fest = festivals(t.y, t.mo, t.d, L);
    const parts = [];
    if (L) parts.push(`农历${L.ganzhi}年（${L.zodiac}） ${L.monthName}${L.dayName}`);
    const term = T.today ? `<b class="xc-term">今日${T.today}</b>` : `${T.current.name}第 ${T.daysSince + 1} 天 · 距${T.next.name}（${T.next.m}月${T.next.d}日）${T.daysToNext} 天`;
    this.$('.xc-lunar').innerHTML = `${parts.map(esc).join('')}${parts.length ? '<br />' : ''}${term}${fest.length ? ` <b class="xc-fest">${fest.map(esc).join(' · ')}</b>` : ''}`;
  }

  /** 场景时间 = 当前北京时间 */
  syncSceneTime(animate = true, quiet = false) {
    const sky = this.sky;
    if (!sky || !sky.setHours) return;
    const t = beijingNow();
    const hours = t.h + t.mi / 60 + t.s / 3600;
    if (sky.playing) {
      sky.playing = false;
      this.ui?.setPlaying?.(false);
    }
    sky.setHours(hours, animate);
    this._lastSync = { hours, at: Date.now() };
    if (!quiet) this.ui?.toast?.(`场景时间已同步：${pad(t.h)}:${pad(t.mi)}（北京时间）`);
  }

  _setFollow(on) {
    this.state.follow = !!on;
    this.$('.xc-follow').checked = this.state.follow;
    this._save();
    if (on) {
      this.syncSceneTime(true, true);
      this.ui?.toast?.('场景时间持续跟随现实（手动调时后自动停止）');
    }
  }

  _followStep() {
    const sky = this.sky, ls = this._lastSync;
    if (!sky) return;
    const now = Date.now();
    if (!ls) { this.syncSceneTime(true, true); return; }
    if (now - ls.at < 15000) return;
    // 场景时间被手动改过（滑块 / 预设视角 / 时间流逝）→ 停止跟随
    let d = Math.abs(sky.hours - ls.hours);
    d = Math.min(d, 24 - d);
    if (d > 0.02) {
      this._setFollow(false);
      this.ui?.toast?.('场景时间已手动调整，停止跟随现实时间');
      return;
    }
    this.syncSceneTime(false, true);
  }

  // ———————————————— 天气 ————————————————
  async refreshWeather(manual = false) {
    if (this._wxBusy) return;
    this._wxBusy = true;
    this.$('.xc-refresh').disabled = true;
    if (!this.wx) this._wxMsg('正在获取西安实时天气……');
    const [fc, aq] = await Promise.allSettled([fetchJSON(WX_URL), fetchJSON(AQ_URL)]);
    this._wxBusy = false;
    this.$('.xc-refresh').disabled = false;
    clearTimeout(this._retryT);
    if (fc.status === 'fulfilled' && fc.value && fc.value.current) {
      this.wx = { fc: fc.value, aq: aq.status === 'fulfilled' ? aq.value : null, fetchedAt: Date.now(), cached: false };
      this.wxError = null;
      this._fails = 0;
      saveStore(WX_CACHE_KEY, { fc: this.wx.fc, aq: this.wx.aq, fetchedAt: this.wx.fetchedAt });
      if (manual) this.ui?.toast?.('天气已更新');
    } else {
      const err = fc.status === 'rejected' ? fc.reason : new Error('数据格式异常');
      this.wxError = err && err.name === 'AbortError' ? '请求超时' : (err && err.message) || '网络错误';
      console.warn('[infocard] 天气获取失败：', this.wxError);
      // 失败后按 1、2、4、8 分钟退避自动重试（不超过常规刷新间隔）
      this._fails = (this._fails || 0) + 1;
      this._retryT = setTimeout(() => this.refreshWeather(), Math.min(REFRESH_MS, 60000 * 2 ** (this._fails - 1)));
    }
    this._renderWeather();
    this._applySceneWeather();
  }

  _wxMsg(html, isErr = false) {
    const m = this.$('.xc-wx-msg');
    m.hidden = !html;
    m.classList.toggle('err', isErr);
    m.innerHTML = html || '';
  }

  _renderWeather() {
    const $ = this.$;
    const wx = this.wx;
    const upd = $('.xc-upd');
    if (!wx) {
      $('.xc-wx-data').hidden = true;
      this._wxMsg(`⚠ 天气获取失败（${esc(this.wxError || '离线')}），场景不受影响。 <button class="xc-retry">重试</button>`, true);
      $('.xc-retry')?.addEventListener('click', () => this.refreshWeather(true));
      upd.textContent = '';
      $('.xc-mini-w').textContent = '';
      return;
    }
    const at = beijingNow(wx.fetchedAt);
    const stale = this.wxError || wx.cached;
    upd.innerHTML = stale
      ? `<em class="err">离线</em> · 显示 ${at.mo}/${at.d} ${pad(at.h)}:${pad(at.mi)} 的数据`
      : `更新于 ${pad(at.h)}:${pad(at.mi)}`;
    if (this.wxError) {
      this._wxMsg(`⚠ 刷新失败（${esc(this.wxError)}） <button class="xc-retry">重试</button>`, true);
      $('.xc-retry')?.addEventListener('click', () => this.refreshWeather(true));
    } else this._wxMsg('');
    $('.xc-wx-data').hidden = false;

    const fc = wx.fc, c = fc.current || {}, dl = fc.daily || {}, hr = fc.hourly || {};
    const W = wmo(c.weather_code, c.is_day);
    const today = (c.time || '').slice(0, 10);
    const di = Math.max(0, (dl.time || []).indexOf(today));
    const tmax = dl.temperature_2m_max?.[di], tmin = dl.temperature_2m_min?.[di];
    const n1 = (v, u = '') => (fin(v) ? `${v.toFixed(1)}${u}` : '—');
    const n0 = (v, u = '') => (fin(v) ? `${Math.round(v)}${u}` : '—');

    $('.xc-ico').textContent = W.icon;
    $('.xc-temp b').textContent = fin(c.temperature_2m) ? `${c.temperature_2m.toFixed(1)}°` : '—';
    $('.xc-temp small').textContent = `体感 ${n1(c.apparent_temperature, '°')}`;
    $('.xc-cond b').textContent = W.name;
    $('.xc-cond small').textContent = fin(tmax) && fin(tmin) ? `今日 ${Math.round(tmin)}° ~ ${Math.round(tmax)}°` : '';
    $('.xc-mini-w').textContent = fin(c.temperature_2m) ? `${W.icon} ${Math.round(c.temperature_2m)}°` : '';

    // 风
    const ws = c.wind_speed_10m, wd = c.wind_direction_10m, wg = c.wind_gusts_10m;
    const lv = fin(ws) ? beaufort(ws) : null;
    const arrow = $('.xc-arrow');
    if (fin(wd)) {
      arrow.style.transform = `rotate(${(wd + 180) % 360}deg)`; // 箭头指向风的去向（上 = 北）
      arrow.title = `风从${dirName(wd)}方吹来（${Math.round(wd)}°）`;
      arrow.style.visibility = '';
    } else arrow.style.visibility = 'hidden';
    $('.xc-wind-a').textContent = fin(wd) && lv != null ? `${lv === 0 ? '静风' : dirName(wd) + '风'} ${lv} 级 · ${beaufortName(lv)}` : '风况 —';
    $('.xc-wind-b').textContent = `风速 ${n1(ws, ' m/s')} · 阵风 ${n1(wg, ' m/s')}${fin(wg) ? `（${beaufort(wg)} 级）` : ''} · ${fin(wd) ? Math.round(wd) + '°' : ''}`;

    // 要素网格
    const vis = c.visibility;
    const visTxt = fin(vis) ? (vis >= 10000 ? `${Math.round(vis / 1000)} km` : `${(vis / 1000).toFixed(1)} km`) : '—';
    const cells = [
      ['湿度', n0(c.relative_humidity_2m, '%')],
      ['气压', n0(c.pressure_msl, ' hPa')],
      ['能见度', visTxt],
      ['云量', n0(c.cloud_cover, '%')],
      ['降水', `${n1(c.precipitation, ' mm')}`, fin(dl.precipitation_sum?.[di]) ? `今日累计 ${dl.precipitation_sum[di].toFixed(1)} mm` : ''],
      ['紫外线', fin(c.uv_index) ? c.uv_index.toFixed(1) : '—', fin(dl.uv_index_max?.[di]) ? `今日最高 ${dl.uv_index_max[di].toFixed(1)}` : ''],
      ['日出', hhmm(dl.sunrise?.[di])],
      ['日落', hhmm(dl.sunset?.[di])],
    ];
    $('.xc-grid').innerHTML = cells.map(([k, v, t]) => `<div${t ? ` title="${esc(t)}"` : ''}><span>${k}</span><b>${esc(v)}</b></div>`).join('');

    this._renderAQ();
    this._renderHours(hr, c.time);
  }

  _renderAQ() {
    const box = this.$('.xc-aqi');
    const aq = this.wx && this.wx.aq && this.wx.aq.current;
    if (!aq) {
      box.innerHTML = '<span class="xc-dim">空气质量暂不可用</span>';
      return;
    }
    const { aqi, primary, sub } = chinaAQI(aq);
    if (aqi == null) {
      box.innerHTML = '<span class="xc-dim">空气质量暂不可用</span>';
      return;
    }
    const L = aqiLevel(aqi);
    const chip = (k, label) => {
      const v = aq[k];
      if (!fin(v)) return '';
      const s = sub[k];
      const col = s != null ? aqiLevel(s)[2] : 'transparent';
      return `<span class="xc-pm" title="${label} 分指数 ${s ?? '—'}"><i style="background:${col}"></i>${label} <b>${Math.round(v)}</b></span>`;
    };
    box.innerHTML = `
      <span class="xc-aqi-badge" style="background:${L[2]};color:${L[3]}" title="中国 AQI（HJ 633-2012，由实时浓度计算）">AQI ${aqi}<small>${L[1]}</small></span>
      <div class="xc-aqi-r">
        <div>${chip('pm2_5', 'PM2.5')}${chip('pm10', 'PM10')}<span class="xc-unit">μg/m³</span></div>
        <small>${primary ? `首要污染物 ${AQ_NAME[primary]}` : '空气质量令人满意'}${fin(aq.us_aqi) ? ` · 美标 AQI ${Math.round(aq.us_aqi)}` : ''}</small>
      </div>`;
  }

  _renderHours(hr, curTime) {
    const box = this.$('.xc-hours');
    const times = hr.time || [];
    let i0 = times.indexOf(`${(curTime || '').slice(0, 13)}:00`);
    if (i0 < 0) { box.innerHTML = ''; return; }
    const N = 8;
    const idx = [];
    for (let i = i0 + 1; i < times.length && idx.length < N; i++) idx.push(i);
    if (!idx.length) { box.innerHTML = ''; return; }
    const temps = idx.map((i) => hr.temperature_2m?.[i]).filter(fin);
    const lo = Math.min(...temps), hi = Math.max(...temps);
    const cw = 36, H = 26;
    const pts = idx.map((i, k) => {
      const v = hr.temperature_2m?.[i];
      const y = fin(v) ? 4 + (1 - (hi > lo ? (v - lo) / (hi - lo) : 0.5)) * (H - 8) : H / 2;
      return `${(k + 0.5) * cw},${y.toFixed(1)}`;
    });
    const svg = `<svg class="xc-spark" viewBox="0 0 ${idx.length * cw} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(' ')}" /></svg>`;
    const cols = idx.map((i) => {
      const W = wmo(hr.weather_code?.[i], hr.is_day?.[i]);
      const pp = hr.precipitation_probability?.[i];
      return `<div class="xc-h" title="${esc(`${times[i].slice(11, 16)} ${W.name}${fin(pp) ? ` 降水概率 ${pp}%` : ''}`)}">
        <span>${times[i].slice(11, 13)}时</span><i>${W.icon}</i><b>${n0t(hr.temperature_2m?.[i])}</b><em>${fin(pp) && pp >= 20 ? `${pp}%` : ''}</em></div>`;
    }).join('');
    box.innerHTML = `<div class="xc-h-cap">未来 ${idx.length} 小时</div>${svg}<div class="xc-h-row" style="grid-template-columns:repeat(${idx.length},1fr)">${cols}</div>`;
  }

  /** 天气 → 场景天空（云量 / 云密度 / 雾浓度）。关闭时恢复画质设置里的原值 */
  _applySceneWeather() {
    const sky = this.sky;
    const u = sky && sky.skyMat && sky.skyMat.uniforms;
    if (!sky || !u || !u.cloudCoverage) return;
    const baseFog = this.display?.values && fin(this.display.values.fog) ? this.display.values.fog : (this._baseFog ?? sky.fogScale);
    if (!this.state.wxSync || !this.wx || !this.wx.fc?.current) {
      if (this._wxApplied) {
        sky.fogScale = baseFog;
        if (sky.setClouds) sky.setClouds(sky.cloudsEnabled !== false);
        if (this._baseDensity != null) u.cloudDensity.value = this._baseDensity;
        this._wxApplied = false;
      }
      return;
    }
    if (!this._wxApplied) {
      this._baseFog = sky.fogScale;
      this._baseDensity = u.cloudDensity.value;
    }
    const m = weatherToScene(this.wx.fc.current);
    sky.fogScale = baseFog * m.fog; // 画质设置里关闭雾（0）时保持无雾
    if (sky.cloudsEnabled !== false) {
      u.cloudCoverage.value = m.coverage;
      u.cloudDensity.value = m.density;
    }
    this._wxApplied = true;
  }

  // ———————————————— 广播 ————————————————
  _renderRadio(s) {
    const $ = this.$;
    if (!$) return;
    const st = s.station;
    const player = $('.xc-player');
    player.hidden = !st;
    const active = s.status === 'playing' || s.status === 'loading';
    $('.xc-pp').textContent = active ? '❚❚' : '▶';
    $('.xc-pp').classList.toggle('on', active);
    if (st) {
      $('.xc-np-n').textContent = `${st.freq} ${st.name}`;
      const srcTxt = s.srcCount > 1 && s.srcIndex >= 0 && s.status === 'playing' ? ` · 源 ${s.srcIndex + 1}/${s.srcCount}` : '';
      $('.xc-np-s').textContent = (s.message || '') + srcTxt;
      $('.xc-np-s').className = `xc-np-s ${s.status}`;
    }
    this.el.querySelectorAll('.xc-st').forEach((b) => {
      const cur = st && b.dataset.id === st.id;
      b.classList.toggle('on', !!cur);
      b.classList.toggle('loading', !!cur && s.status === 'loading');
      b.classList.toggle('playing', !!cur && s.status === 'playing');
      b.classList.toggle('err', !!cur && s.status === 'error');
    });
    this.el.classList.toggle('radio-on', s.status === 'playing');
    $('.xc-mini-r').textContent = s.status === 'playing' && st ? `♪ ${st.freq}` : '';
    if (s.status === 'error' && st) this.ui?.toast?.(`${st.name}：${s.message}`, 3200);
  }

  _renderMute() {
    const m = this.radio.muted || this.radio.volume === 0;
    this.$('.xc-mute').textContent = m ? '🔇' : this.radio.volume < 0.45 ? '🔈' : '🔊';
    this.$('.xc-mute').title = m ? '取消静音' : '静音';
  }
}


/**
 * 创建左上角“西安时讯”卡片。ui=0（无界面截图）或 infocard=0 时不创建，返回 null。
 * @param {{root:HTMLElement, ui:object, sky:object, display?:object, params?:URLSearchParams}} opts
 */
export function setupInfoCard(opts) {
  const params = opts.params || new URLSearchParams(location.search);
  if (params.get('ui') === '0' || params.get('infocard') === '0') return null;
  try {
    return new InfoCard({ ...opts, params });
  } catch (e) {
    console.error('[infocard] 初始化失败', e);
    return null;
  }
}
