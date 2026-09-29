// 模块注册表：按顺序 prepare → build。每个模块是独立文件，互不改动。
// 懒加载，单个模块失败不影响整体。
export const MODULES = [
  { id: 'water', load: () => import('./water.js') },
  { id: 'landuse', load: () => import('./landuse.js') },
  { id: 'roads', load: () => import('./roads.js') },
  // 逐栋档案建筑：须在 skyline 等地标模块之前（其 prepare 登记 ctx.superseded，后续模块据此跳过被替代的旧定义）
  { id: 'dossier', load: () => import('./dossier.js') },
  { id: 'citywall', load: () => import('./citywall.js') },
  { id: 'belltower', load: () => import('./belltower.js') },
  { id: 'pagoda', load: () => import('./pagoda.js') },
  { id: 'datang', load: () => import('./datang.js') },
  { id: 'qujiang', load: () => import('./qujiang.js') },
  { id: 'heritage', load: () => import('./heritage.js') },
  { id: 'heritage26', load: () => import('./heritage26.js') },
  { id: 'mixc', load: () => import('./mixc.js') }, // 电视塔东侧：西安万象城（华润 CCBD）+ 西安万象天地；须在 skyline 之前（排除区）
  { id: 'skyline', load: () => import('./skyline.js') },
  { id: 'huimin', load: () => import('./huimin.js') },
  { id: 'sunken', load: () => import('./sunken.js') },
  { id: 'airports', load: () => import('./airports.js') },
  { id: 'buildings', load: () => import('./buildings.js') },
  { id: 'vegetation', load: () => import('./vegetation.js') },
  { id: 'signage', load: () => import('./signage.js') },
  { id: 'traffic', load: () => import('./traffic.js') },
  { id: 'amapinfo', load: () => import('./amapinfo.js') },
  { id: 'metro', load: () => import('./metro.js') },
  { id: 'pedestrians', load: () => import('./pedestrians.js') },
  // 开发用（默认不加载，?modules=archtest 时加载）
  { id: 'archtest', load: () => import('./dev/archtest.js'), dev: true },
];
