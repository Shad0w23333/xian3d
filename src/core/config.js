// 全局配置：画质档位、在线影像、预设视角
import { project } from './geo.js';

// 在线卫星影像源。gcj=true 表示瓦片按 GCJ-02（火星坐标）绘制，加载时自动纠偏拼接。
export const IMAGERY_PROVIDERS = {
  amap: {
    name: '高德卫星',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 18,
    gcj: true,
    attribution: '影像 © 高德地图 AutoNavi',
  },
  local: {
    name: '本地离线高清',
    local: true, // 由 TilePack 提供（public/tiles/*.xtp），不联网
    maxZoom: 19,
    gcj: false, // 管线中已纠偏
    attribution: '影像：本地离线瓦片包（仅供个人本地使用）',
  },
  esri: {
    name: 'Esri 卫星',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    subdomains: null,
    maxZoom: 18,
    gcj: false,
    attribution: '影像 Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
};
export const DEFAULT_IMAGERY = 'amap';
// 兼容旧代码
export const ONLINE_IMAGERY = IMAGERY_PROVIDERS[DEFAULT_IMAGERY];

// 画质档位：0 低 / 1 中 / 2 高 / 3 超高
export const QUALITY_LEVELS = [
  {
    name: '低', pixelRatio: 0.75, msaa: 0, shadows: false, shadowMapSize: 1024,
    bloom: true, pointLights: 0, terrainSplit: 1.35, maxTileZoom: 16,
    buildingDistance: 6000, trafficDensity: 0.35, treeDensity: 0.3, anisotropy: 2,
  },
  {
    name: '中', pixelRatio: 1, msaa: 2, shadows: true, shadowMapSize: 2048,
    bloom: true, pointLights: 4, terrainSplit: 1.7, maxTileZoom: 17,
    buildingDistance: 10000, trafficDensity: 0.6, treeDensity: 0.6, anisotropy: 4,
  },
  {
    name: '高', pixelRatio: 1.25, msaa: 4, shadows: true, shadowMapSize: 4096,
    bloom: true, pointLights: 8, terrainSplit: 2.0, maxTileZoom: 18,
    buildingDistance: 16000, trafficDensity: 1.0, treeDensity: 1.0, anisotropy: 8,
  },
  {
    name: '超高', pixelRatio: 2, msaa: 4, shadows: true, shadowMapSize: 4096,
    bloom: true, pointLights: 12, terrainSplit: 2.4, maxTileZoom: 19,
    buildingDistance: 26000, trafficDensity: 1.4, treeDensity: 1.3, anisotropy: 16,
  },
];

export function defaultQualityLevel() {
  const mem = navigator.deviceMemory || 8;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (mobile) return 0;
  if (mem <= 4) return 1;
  return 2;
}

/** 由经纬度 + 离地高度定义视角 */
function view(lon, lat, alt, tlon, tlat, talt) {
  const p = project(lon, lat);
  const t = project(tlon, tlat);
  return { pos: [p.x, alt, p.z], target: [t.x, talt, t.z], agl: true };
}

// 预设视角：alt / talt 均为“离地高度”（运行时加上地面海拔）
// key: 键盘按键；hours: 切换到该时刻（不设则保持当前时间）
export const PRESETS = [
  { key: '1', name: '全城俯视', ...view(108.985, 34.175, 7200, 108.945, 34.268, 0) },
  { key: '2', name: '钟楼', ...view(108.9407, 34.2588, 110, 108.94234, 34.26101, 24) },
  { key: '3', name: '大雁塔', ...view(108.9578, 34.2213, 75, 108.95943, 34.2198, 32) },
  { key: '4', name: '大唐不夜城夜景', hours: 20.6, ...view(108.95945, 34.2075, 42, 108.95945, 34.2172, 24) },
  { key: '5', name: '城墙·永宁门', ...view(108.9395, 34.2478, 85, 108.9423, 34.2530, 15) },
  { key: '6', name: '曲江·大唐芙蓉园', ...view(108.9625, 34.2075, 280, 108.9694, 34.2147, 20) },
  { key: '7', name: '高新区 CBD', ...view(108.8905, 34.2085, 380, 108.8755, 34.1964, 120) },
  { key: '8', name: '未央国际商圈', ...view(108.9500, 34.3180, 380, 108.9420, 34.3380, 60) },
  { key: '9', name: '咸阳国际机场', ...view(108.7900, 34.4250, 520, 108.7650, 34.4470, 0) },
  { key: '0', name: '渭河', ...view(108.9300, 34.3700, 650, 108.9700, 34.4150, 0) },
];

// Shift + 数字的扩展视角
export const PRESETS_EXTRA = [
  { key: '!1', name: '秦岭远眺', ...view(108.95, 34.30, 2600, 108.95, 34.02, 900) },
  { key: '!2', name: '阎良机场', ...view(109.215, 34.620, 700, 109.235, 34.645, 0) },
  { key: '!3', name: '城墙全景（北门）', ...view(108.9423, 34.2860, 420, 108.9423, 34.2610, 0) },
  { key: '!4', name: '小雁塔', ...view(108.9362, 34.2385, 95, 108.9377, 34.2405, 25) },
  { key: '!5', name: '陕西电视塔', ...view(108.9340, 34.2050, 260, 108.94183, 34.19768, 150) },
];

export const START_VIEW = PRESETS[0];

// 默认时间（小时）
export const DEFAULT_HOURS = 16.4;
// 模拟日期（影响太阳轨迹）：秋分前后
export const DAY_OF_YEAR = 268;
