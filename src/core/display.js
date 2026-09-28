// 画质与显示设置：细项定义、存取（localStorage + URL 参数覆盖）、增量应用（只做变化项需要的工作，立即生效、不重载页面）
//
// 画质档位（低/中/高/超高）作为“预设”：选择预设会把下面的“预设细项”全部填好；之后改任何一项即显示“自定义”。
// 显示对象（车辆/列车/航班/行人/树木）不属于预设，单独记忆。
//
// URL 参数（优先于已保存设置，只影响本次，不写入存储）：
//   q=0..3 预设；shadows=0/1；sq=0..3 阴影质量；aa=off|fxaa|smaa|msaa2|msaa4|msaa8；bloom=0/1；bloomStrength=倍率；
//   tm=aces|agx|neutral|reinhard|off；exposure=倍率；ibl=0/1；clouds=0/1；fog=倍率(0=无雾)；vd=视距 km(0=不限)；
//   bd=建筑显示距离 m；treeDistance=倍率；treeDensity=倍率；lod=地形细分；zoom=影像精度 14..19；pr=像素比；
//   pointLights=数量；vehicles/trains/flights/people/trees=0/1；trafficDensity/peopleDensity=倍率
import * as THREE from 'three';
import { QUALITY_LEVELS, SHADOW_QUALITY } from './config.js';

const STORE_KEY = 'xian3d.display.v1';
const LEGACY_KEY = 'xian3d.quality';

const km = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} km` : `${v} m`);
const times = (d = 1) => (v) => `${(+v).toFixed(d)}×`;

/**
 * 细项定义。preset=true 的项由画质预设填充；dep 表示依赖的开关（开关关闭时控件变灰）。
 * type：bool 复选框 / select 下拉 / range 滑块
 */
export const DISPLAY_SCHEMA = [
  { group: '光影' },
  { key: 'shadows', label: '阴影', type: 'bool', preset: true, url: 'shadows' },
  { key: 'shadowQuality', label: '阴影质量', type: 'select', preset: true, dep: 'shadows', url: 'sq', num: true,
    options: SHADOW_QUALITY.map((s, i) => [i, `${s.name}（${s.mapSize}² · 范围 ${s.range}×）`]) },
  { key: 'aa', label: '抗锯齿', type: 'select', preset: true, url: 'aa',
    options: [['off', '关'], ['fxaa', 'FXAA（快速）'], ['smaa', 'SMAA（锐利）'], ['msaa2', 'MSAA 2×'], ['msaa4', 'MSAA 4×'], ['msaa8', 'MSAA 8×']] },
  { key: 'bloom', label: '泛光（夜景辉光）', type: 'bool', preset: true, url: 'bloom' },
  { key: 'bloomStrength', label: '泛光强度', type: 'range', min: 0.2, max: 2.5, step: 0.1, fmt: times(1), preset: true, dep: 'bloom', url: 'bloomStrength' },
  { key: 'toneMapping', label: '色调映射', type: 'select', preset: true, url: 'tm',
    options: [['aces', 'ACES 电影感'], ['agx', 'AgX'], ['neutral', '中性（Khronos）'], ['reinhard', 'Reinhard'], ['off', '关（线性）']] },
  { key: 'exposure', label: '曝光', type: 'range', min: 0.4, max: 2, step: 0.05, fmt: times(2), preset: true, url: 'exposure' },
  { key: 'ibl', label: '环境反射（天空光照贴图）', type: 'bool', preset: true, url: 'ibl' },
  { key: 'clouds', label: '云层', type: 'bool', preset: true, url: 'clouds' },
  { key: 'fog', label: '大气雾 / 霾浓度', type: 'range', min: 0, max: 3, step: 0.1, fmt: (v) => (v <= 0 ? '无雾' : times(1)(v)), preset: true, url: 'fog' },

  { group: '可视度' },
  { key: 'viewDistance', label: '视距（远裁剪面）', type: 'range', min: 2, max: 61, step: 1, zeroAt: 61,
    fmt: (v) => (!v ? '不限' : `${v} km`), preset: true, url: 'vd' },
  { key: 'buildingDistance', label: '建筑显示距离', type: 'range', min: 1000, max: 30000, step: 500, fmt: km, preset: true, url: 'bd' },
  { key: 'treeDistance', label: '树木显示距离', type: 'range', min: 0.3, max: 2.5, step: 0.1, fmt: times(1), preset: true, url: 'treeDistance' },
  { key: 'treeDensity', label: '树木密度', type: 'range', min: 0.1, max: 1.5, step: 0.05, fmt: times(2), preset: true, url: 'treeDensity' },
  { key: 'terrainSplit', label: '地形精度（LOD）', type: 'range', min: 1, max: 3, step: 0.05, fmt: times(2), preset: true, url: 'lod' },
  { key: 'maxTileZoom', label: '影像精度', type: 'range', min: 14, max: 19, step: 1, fmt: (v) => `z${v}`, preset: true, url: 'zoom' },
  { key: 'pixelRatio', label: '像素比（渲染分辨率，不超过屏幕）', type: 'range', min: 0.5, max: 2, step: 0.05, fmt: times(2), preset: true, url: 'pr' },
  { key: 'pointLights', label: '夜景动态光源', type: 'range', min: 0, max: 16, step: 1, fmt: (v) => (v ? `${v} 盏` : '关'), preset: true, url: 'pointLights' },

  { group: '显示对象' },
  { key: 'vehicles', label: '车辆（道路车流）', type: 'bool', def: true, url: 'vehicles' },
  { key: 'trafficDensity', label: '车辆密度', type: 'range', min: 0.1, max: 1.5, step: 0.05, fmt: times(2), preset: true, dep: 'vehicles', url: 'trafficDensity' },
  { key: 'trains', label: '列车 / 地铁', type: 'bool', def: true, url: 'trains' },
  { key: 'flights', label: '航班（机场飞机）', type: 'bool', def: true, url: 'flights' },
  { key: 'people', label: '行人', type: 'bool', def: true, url: 'people' },
  { key: 'peopleDensity', label: '行人密度', type: 'range', min: 0.1, max: 2, step: 0.05, fmt: times(2), preset: true, dep: 'people', url: 'peopleDensity' },
  { key: 'trees', label: '树木', type: 'bool', def: true, url: 'trees' },
];
const ITEMS = DISPLAY_SCHEMA.filter((d) => d.key);
const PRESET_KEYS = ITEMS.filter((d) => d.preset).map((d) => d.key);
const OBJECT_KEYS = ITEMS.filter((d) => !d.preset).map((d) => d.key);
const BY_KEY = Object.fromEntries(ITEMS.map((d) => [d.key, d]));

const TONE = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  off: THREE.NoToneMapping,
};

const FAR_UNLIMITED = 260000;

function parseValue(def, raw) {
  if (raw == null) return undefined;
  if (def.type === 'bool') return !(raw === '0' || raw === 'false' || raw === 'off' || raw === false);
  if (def.type === 'range' || def.num) {
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : undefined;
  }
  const s = String(raw);
  return def.options.some(([k]) => String(k) === s) ? s : undefined;
}
function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
}

export class DisplaySettings {
  /**
   * @param {URLSearchParams} params
   * @param {number} defaultLevel 无存储时的默认档位
   */
  constructor(params, defaultLevel) {
    this.params = params;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch {}
    let base = defaultLevel;
    if (saved && Number.isInteger(saved.base)) base = saved.base;
    else {
      try { const s = localStorage.getItem(LEGACY_KEY); if (s != null && !Number.isNaN(parseInt(s))) base = parseInt(s); } catch {}
    }
    const qParam = params.has('q') ? parseInt(params.get('q')) : NaN;
    if (!Number.isNaN(qParam)) base = qParam;
    this.base = THREE.MathUtils.clamp(base | 0, 0, QUALITY_LEVELS.length - 1);
    this.values = this._presetValues(this.base);
    for (const k of OBJECT_KEYS) this.values[k] = BY_KEY[k].def;
    // 已保存的细项（URL 指定了 q 时，预设细项以 q 为准，只沿用显示对象开关）
    if (saved && saved.values && typeof saved.values === 'object') {
      const keys = Number.isNaN(qParam) ? ITEMS.map((d) => d.key) : OBJECT_KEYS;
      for (const k of keys) {
        const v = saved.values[k];
        if (v === undefined) continue;
        const d = BY_KEY[k];
        if (d.type === 'bool' ? typeof v === 'boolean' : d.type === 'range' || d.num ? Number.isFinite(v) : d.options.some(([o]) => o === v)) this.values[k] = v;
      }
    }
    // URL 覆盖
    for (const d of ITEMS) {
      const raw = params.get(d.url) ?? (d.url !== d.key ? params.get(d.key) : null);
      const v = parseValue(d, raw);
      if (v !== undefined) this.values[d.key] = v;
    }
    this.env = null;
    this.listeners = [];
  }

  _presetValues(i) {
    const Q = QUALITY_LEVELS[i];
    const v = {};
    for (const k of PRESET_KEYS) v[k] = Q[k];
    if (v.aa == null) v.aa = Q.msaa ? 'msaa' + Q.msaa : 'fxaa';
    return v;
  }

  /** 当前是否与某预设完全一致（返回档位；自定义返回 -1） */
  get presetIndex() {
    const p = this._presetValues(this.base);
    return PRESET_KEYS.every((k) => sameValue(p[k], this.values[k])) ? this.base : -1;
  }

  /** 生成模块使用的画质对象（ctx.quality 的字段） */
  toQuality(maxTex = 16384) {
    const Q = QUALITY_LEVELS[this.base];
    const v = this.values;
    const sq = SHADOW_QUALITY[THREE.MathUtils.clamp(v.shadowQuality | 0, 0, SHADOW_QUALITY.length - 1)];
    const aa = v.aa;
    return {
      ...Q,
      ...Object.fromEntries(PRESET_KEYS.map((k) => [k, v[k]])),
      name: this.presetIndex >= 0 ? Q.name : '自定义',
      level: this.base,
      msaa: aa.startsWith('msaa') ? parseInt(aa.slice(4)) : 0,
      shadowMapSize: Math.min(sq.mapSize, maxTex),
      shadowRange: sq.range,
    };
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ base: this.base, values: this.values })); } catch {}
    try { localStorage.setItem(LEGACY_KEY, String(this.base)); } catch {}
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  /**
   * 接入运行时对象后立即完整应用一次。
   * env: { renderer, scene, camera, sky, post, terrain, lights, ctx, instances, setLayer, ui }
   */
  attach(env) {
    this.env = env;
    this._apply(new Set(ITEMS.map((d) => d.key)), true);
  }

  /** 选择预设：填充全部预设细项 */
  applyPreset(i) {
    this.base = THREE.MathUtils.clamp(i | 0, 0, QUALITY_LEVELS.length - 1);
    const p = this._presetValues(this.base);
    const changed = new Set(['level']);
    for (const k of PRESET_KEYS) if (!sameValue(p[k], this.values[k])) { this.values[k] = p[k]; changed.add(k); }
    this.save();
    this._apply(changed);
  }

  /** 修改单个细项 */
  set(key, value) {
    const d = BY_KEY[key];
    if (!d) return;
    if (sameValue(this.values[key], value)) return;
    this.values[key] = value;
    this.save();
    this._apply(new Set([key]));
  }

  /** 批量修改（例如“交通流与航班”总开关） */
  setMany(obj) {
    const changed = new Set();
    for (const [k, v] of Object.entries(obj)) if (BY_KEY[k] && !sameValue(this.values[k], v)) { this.values[k] = v; changed.add(k); }
    if (!changed.size) return;
    this.save();
    this._apply(changed);
  }

  _apply(ch, initial = false) {
    const E = this.env;
    if (!E) return;
    const { renderer, camera, sky, post, terrain, lights, ctx, instances } = E;
    const has = (...k) => k.some((x) => ch.has(x));
    const v = this.values;
    const q = this.toQuality(renderer.capabilities.maxTextureSize || 4096);
    Object.assign(ctx.quality, q);
    const cq = ctx.quality;

    // —— 渲染分辨率 / 后期 ——
    let rebuildPost = false;
    if (has('pixelRatio') || initial) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, v.pixelRatio));
      renderer.setSize(window.innerWidth, window.innerHeight);
      rebuildPost = true;
    }
    if (has('aa') || initial) rebuildPost = true;
    if (rebuildPost) post.build(cq);
    if (has('bloom', 'bloomStrength') || rebuildPost) post.setBloom(v.bloom, v.bloomStrength);
    if (has('toneMapping') || initial) renderer.toneMapping = TONE[v.toneMapping] ?? THREE.ACESFilmicToneMapping;
    if (has('exposure') || initial) sky.exposureScale = v.exposure;

    // —— 天空 / 雾 / 视距 ——
    if (has('ibl') || initial) sky.setEnvironment(v.ibl);
    if (has('clouds') || initial) sky.setClouds(v.clouds);
    if (has('fog', 'viewDistance') || initial) {
      const vd = v.viewDistance > 0 ? v.viewDistance * 1000 : 0;
      camera.far = vd ? vd : FAR_UNLIMITED;
      camera.updateProjectionMatrix();
      sky.fogScale = v.fog;
      // 视距受限时给雾设下限，让远裁剪面处基本被雾遮住（雾关闭时不加）
      sky.fogFloor = vd && v.fog > 0 ? 2.3 / vd : 0;
    }

    // —— 阴影 ——
    if (has('shadows', 'shadowQuality') || initial) {
      renderer.shadowMap.enabled = !!v.shadows;
      sky.setQuality(cq); // castShadow / 分辨率 / 范围
    }

    // —— 地形 / 光源 ——
    if (has('terrainSplit', 'maxTileZoom', 'level') || initial) terrain.setQuality(cq);
    if ((has('pointLights') || initial) && lights.lights.length !== (v.pointLights | 0)) lights.setCount(v.pointLights | 0);

    // —— 各模块（阴影投射、建筑/树木距离、密度、档位相关半径） ——
    const modKeys = ['shadows', 'shadowQuality', 'buildingDistance', 'treeDistance', 'treeDensity', 'trafficDensity', 'peopleDensity', 'level'];
    // 启动时模块已按同一个 ctx.quality 构建，无需再下发
    if (!initial && has(...modKeys)) {
      for (const inst of instances) {
        try { inst.setQuality?.(cq); } catch (e) { console.error('[display] setQuality 失败', inst.id, e); }
      }
    }

    // —— 显示对象（关闭 = 停止仿真与绘制） ——
    if (has('vehicles') || initial) E.setLayer('vehicles', v.vehicles);
    if (has('trains') || initial) E.setLayer('trains', v.trains);
    if (has('flights') || initial) {
      // 机场模块只认 'traffic'（控制航班）；这里直接下发，不影响道路车辆
      try { ctx.modules.airports?.setLayer?.('traffic', v.flights); } catch {}
      E.ui?.setLayer('flights', v.flights);
    }
    if (has('people') || initial) E.setLayer('people', v.people);
    if (has('trees') || initial) E.setLayer('trees', v.trees);
    if (has('vehicles', 'trains', 'flights') || initial) E.ui?.setLayer('traffic', v.vehicles || v.trains || v.flights);

    for (const fn of this.listeners) fn(this, ch);
  }
}
