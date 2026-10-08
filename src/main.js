// 西安 3D —— 入口：初始化渲染器、加载数据、构建模块、主循环
import * as THREE from 'three';
import { loadJSON, loadBinary, onProgress } from './core/data.js';
import { Terrain } from './core/terrain.js';
import { Imagery } from './core/imagery.js';
import { TilePack } from './core/tilepack.js';
import { SkySystem } from './core/sky.js';
import { Controls } from './core/controls.js';
import { Post } from './core/post.js';
import { LightPool } from './core/lightpool.js';
import { Labels, LabelSpace } from './core/labels.js';
import { Exclusions } from './core/exclusions.js';
import { createContext } from './core/context.js';
import { UI } from './core/ui.js';
import { QUALITY_LEVELS, PRESETS, PRESETS_EXTRA, START_VIEW, defaultQualityLevel, IMAGERY_PROVIDERS } from './core/config.js';
import { project, unproject } from './core/geo.js';
import { MODULES } from './modules/index.js';
import { installHeightFog } from './core/fog.js';
import { setupThematic } from './core/thematic.js';
import { DisplaySettings } from './core/display.js';
import { buildDisplayPanel } from './core/display-ui.js';
import { setupInfoCard } from './core/infocard.js';
import { Occluders, OCCLUDER_MODULES } from './core/occluders.js';

installHeightFog();

const params = new URLSearchParams(location.search);
const app = { ready: false, modules: [], errors: [] };
window.xian = app;
let readyResolve;
app.readyPromise = new Promise((r) => (readyResolve = r));

// 片区名（用于信息栏“位置”）
const PLACES = [
  ['钟楼', 108.9423, 34.2610, 350],
  ['鼓楼 · 回民街', 108.9395, 34.2625, 350],
  ['明城墙内', 108.9440, 34.2620, 1800],
  ['大雁塔 · 大慈恩寺', 108.9642, 34.2196, 450],
  ['大唐不夜城', 108.9641, 34.2100, 800],
  ['曲江新区', 108.9780, 34.2050, 2500],
  ['小寨', 108.9480, 34.2230, 800],
  ['高新区', 108.8850, 34.2250, 3500],
  ['未央区 · 经开区', 108.9400, 34.3300, 4000],
  ['大明宫', 108.9600, 34.2950, 1500],
  ['浐灞生态区', 109.0300, 34.3100, 3500],
  ['咸阳国际机场', 108.7600, 34.4400, 4500],
  ['阎良', 109.2300, 34.6500, 6000],
  ['渭河', 108.9600, 34.4000, 3000],
  ['长安区', 108.9300, 34.1500, 6000],
  ['咸阳市区', 108.7100, 34.3300, 5000],
  ['秦岭北麓', 108.9500, 34.0200, 12000],
];
function placeName(x, z) {
  let best = null, bd = Infinity;
  for (const [n, lon, lat, r] of PLACES) {
    const p = project(lon, lat);
    const d = Math.hypot(p.x - x, p.z - z) / r;
    if (d < 1 && d < bd) { bd = d; best = n; }
  }
  return best || '西安市';
}

function supportsClipControl() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    return !!(gl && gl.getExtension('EXT_clip_control'));
  } catch {
    return false;
  }
}

async function main() {
  const root = document.getElementById('app');
  const ui = new UI(root);
  const offProg = onProgress((p) => ui.setLoading(Math.min(0.6, (p.done / Math.max(1, p.total)) * 0.6), `加载数据：${p.current}（${p.done}/${p.total}）`));

  // 画质：预设档位 + 细项（localStorage 记忆，URL 参数可覆盖），见 core/display.js
  const display = new DisplaySettings(params, defaultQualityLevel());
  app.display = display;
  let qIndex = display.base;
  let quality = display.toQuality();

  // —— 渲染器 ——
  const reversed = supportsClipControl() && params.get('rdepth') !== '0';
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    reversedDepthBuffer: reversed,
    logarithmicDepthBuffer: !reversed,
    preserveDrawingBuffer: params.get('shot') === '1',
  });
  renderer.domElement.className = 'gl';
  renderer.domElement.tabIndex = 0;
  root.appendChild(renderer.domElement);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // EffectComposer 包含多个渲染通道；关闭 Three.js 的逐次自动清零，按帧统计整条管线。
  renderer.info.autoReset = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = !!quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.renderer = renderer;
  app.reversedDepth = reversed;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 260000);
  app.scene = scene;
  app.camera = camera;

  // —— 数据 ——
  ui.setLoading(0.02, '读取元数据……');
  const meta = (await loadJSON('meta.json', { optional: true })) || { dem: [], imagery: [] };
  const terrain = new Terrain();
  const imagery = new Imagery(renderer, quality);
  imagery.setOnlineConfig(meta.online);
  // 本地离线高清影像包（public/tiles/，tools/imagery_pack.py 生成）：存在时默认使用，?pack=0 关闭
  const pack = params.get('pack') === '0' ? null : await TilePack.load('tiles/');
  if (pack) imagery.attachPack(pack);
  {
    let pid = params.get('imagery');
    if (!pid) {
      // 已保存的选择只在“当时已有本地包”或“现在仍没有本地包”时沿用；
      // 旧版（无本地选项时）存的 amap/esri 不应压过新生成的本地包
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem('xian3d.imagery.v2') || 'null');
        if (!saved) { const s = localStorage.getItem('xian3d.imagery'); if (s) saved = { id: s, hadLocal: s === 'local' }; }
      } catch {}
      if (saved && typeof saved.id === 'string' && (saved.hadLocal || !pack)) pid = saved.id;
    }
    if (pid === 'local' && !pack) pid = null;
    if (!pid && pack) pid = 'local';
    if (pid && IMAGERY_PROVIDERS[pid]) imagery.setProvider(pid);
  }
  // online=0 只关闭联网影像；本地瓦片包不受影响（Imagery 内区分，之后切换影像源也保持）
  if (params.get('online') === '0') imagery.setOnlineEnabled(false);
  const [,] = await Promise.all([terrain.load(meta), imagery.loadMosaics(meta.imagery)]);

  const data = {};
  const optional = { optional: true };
  const [roads, water, landuse, aeroway, pois, rail, buildings, bnames, landmarks, skyline, amapExtra] = await Promise.all([
    loadJSON('roads.json', optional),
    loadJSON('water.json', optional),
    loadJSON('landuse.json', optional),
    loadJSON('aeroway.json', optional),
    loadJSON('pois.json', optional),
    loadJSON('rail.json', optional),
    loadBinary('buildings.bin', optional),
    loadJSON('buildings_names.json', optional),
    loadJSON('landmarks.json', optional),
    loadJSON('skyline.json', optional),
    loadJSON('amap_extra.json', optional),
  ]);
  Object.assign(data, { roads, water, landuse, aeroway, pois, rail, buildings, buildingNames: bnames, landmarks, skyline, amapExtra });
  offProg();

  // —— 系统 ——
  const uniformsHolder = {};
  const lights = new LightPool(scene, quality.pointLights, renderer, camera);
  const labels = new Labels(root);
  const exclusions = new Exclusions();
  const ctx = createContext({ renderer, scene, camera, terrain, imagery, sky: null, lights, labels, exclusions, quality, data, meta });
  // 遮挡体登记：精建模块的实体（标注视线遮挡 + 相机建筑内推出），见 core/occluders.js
  const occluders = new Occluders(terrain);
  ctx.occluders = occluders;
  app.occluders = occluders;
  /** 视线遮挡（标注共用）：通用建筑真实轮廓 + 精建模块遮挡体；终点留 m1 米不算（锚点贴着地标本身） */
  ctx.lineBlocked = (ax, ay, az, bx, by, bz, m1) => {
    const L = Math.hypot(bx - ax, bz - az);
    const end = m1 ?? Math.min(40, Math.max(6, L * 0.03));
    if (occluders.segmentBlocked(ax, ay, az, bx, by, bz, 1, end)) return true;
    const b = ctx.modules.buildings;
    return !!(b && b.occluded && b.occluded(ax, ay, az, bx, by, bz));
  };
  const sky = new SkySystem(renderer, scene, ctx.uniforms, quality);
  ctx.sky = sky;
  app.ctx = ctx;
  Object.assign(uniformsHolder, ctx.uniforms);

  // —— 模块 ——
  const want = params.get('modules');
  const list = want === 'none' ? [] : want ? MODULES.filter((m) => want.split(',').includes(m.id)) : MODULES.filter((m) => !m.dev);
  const skip = new Set((params.get('skip') || '').split(',').filter(Boolean));
  const loaded = [];
  for (const m of list) {
    if (skip.has(m.id)) continue;
    try {
      const mod = (await m.load()).default;
      loaded.push(mod);
    } catch (e) {
      console.error('[module] 加载失败', m.id, e);
      app.errors.push(`${m.id}: ${e.message}`);
    }
  }
  // prepare：平整区/排除区
  for (const mod of loaded) {
    try {
      if (mod.prepare) await mod.prepare(ctx);
    } catch (e) {
      console.error('[module] prepare 失败', mod.id, e);
      app.errors.push(`${mod.id}.prepare: ${e.message}`);
    }
  }
  terrain.initRender(scene, imagery, quality, ctx);

  // build
  const instances = [];
  for (let i = 0; i < loaded.length; i++) {
    const mod = loaded[i];
    ui.setLoading(0.62 + (0.33 * i) / Math.max(1, loaded.length), `构建：${mod.name || mod.id}……`);
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    const nChildren = scene.children.length;
    try {
      const inst = (await mod.build(ctx)) || {};
      // 记录归属模块（调试/诊断用）
      for (let k = nChildren; k < scene.children.length; k++) scene.children[k].userData.module ??= mod.id;
      inst.id = mod.id;
      inst.name = mod.name;
      if (OCCLUDER_MODULES.has(mod.id)) for (let k = nChildren; k < scene.children.length; k++) occluders.addObject(scene.children[k]);
      instances.push(inst);
      ctx.modules[mod.id] = inst;
      console.log(`[module] ${mod.id} 构建完成 ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (e) {
      console.error('[module] build 失败', mod.id, e);
      app.errors.push(`${mod.id}.build: ${e.message}`);
    }
  }
  app.modules = instances;
  // 兜底：零长度法线在 Metal 上 normalize → NaN，经泛光扩散成全屏黑。构建完成后统一修正为朝上
  {
    const t0 = performance.now();
    let fixed = 0;
    scene.traverse((o) => {
      const N = o.geometry?.attributes?.normal;
      if (!o.isMesh || !N || N.isInterleavedBufferAttribute || N.normalized || !(N.array instanceof Float32Array)) return;
      if ([].concat(o.material).every((m) => m.flatShading)) return;
      const a = N.array;
      let n = 0;
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i], y = a[i + 1], z = a[i + 2];
        if (!(x * x + y * y + z * z > 1e-12)) { a[i] = 0; a[i + 1] = 1; a[i + 2] = 0; n++; }
      }
      if (n) { N.needsUpdate = true; fixed += n; }
    });
    if (fixed) console.warn(`[xian3d] 修正零长度/NaN 法线 ${fixed} 个（${(performance.now() - t0).toFixed(0)} ms）`);
  }

  // —— 后期 & 控制 ——
  const post = new Post(renderer, scene, camera, quality, reversed);
  const controls = new Controls(camera, renderer.domElement, terrain);
  app.controls = controls;
  ctx.controls = controls; // 地铁地下浏览等模块运行时需要接管地面高度
  app.post = post;

  // 起始视角
  const resolveView = (v) => {
    const p = new THREE.Vector3(...v.pos);
    const t = new THREE.Vector3(...v.target);
    if (v.agl) {
      p.y += terrain.heightAt(p.x, p.z);
      t.y += terrain.heightAt(t.x, t.z);
    }
    return { p, t };
  };
  const allPresets = [...PRESETS, ...PRESETS_EXTRA];
  // —— 建筑碰撞 / 落点推出：通用建筑（真实轮廓棱柱）+ 精建模块遮挡体 ——
  const bldSolid = (x, y, z) => {
    const b = ctx.modules.buildings;
    return !!(b && b.occluded && b.occluded(x - 0.2, y, z, x + 0.2, y, z, 0, true) >= 0);
  };
  controls.solid = (x, y, z) => occluders.solidAt(x, y, z) || bldSolid(x, y, z);
  /** 某处附近（400 m）的遮挡体还没栅格化完：优先做完（同步，最多约 1.5 s） */
  const occNear = (x, z, r = 400) => {
    if (!occluders.queue.length) return;
    occluders.prioritize(x, z);
    if (occluders.queue[0].d > r) return;
    const t0 = performance.now();
    while (occluders.queue.length && occluders.queue[0].d <= r && performance.now() - t0 < 1500) occluders.process(50, r);
  };
  app.occNear = occNear;
  const setView = (v, instant) => {
    const { p, t } = resolveView(v);
    if (instant) {
      occNear(p.x, p.z);
      camera.position.copy(controls.resolve(p, t));
      camera.lookAt(t);
      controls._syncAnglesFromCamera();
    } else {
      // 平滑飞行：不同步等待栅格化（避免按键卡顿），只把目的地附近排到队首，飞行途中后台做完；到达后若落在实体内再推出
      if (occluders.queue.length) occluders.prioritize(p.x, p.z);
      controls.flyTo(p, t, {
        onArrive: () => {
          occNear(p.x, p.z, 200);
          controls.ensureFree();
        },
      });
    }
    if (v.hours != null) sky.setHours(v.hours, !instant);
  };
  let startView = START_VIEW;
  if (params.get('view')) startView = allPresets.find((p) => p.key === params.get('view')) || START_VIEW;
  if (params.get('ll')) {
    // ll=lon,lat,离地高,目标lon,目标lat,目标离地高
    const a = params.get('ll').split(',').map(Number);
    const p = project(a[0], a[1]), t = project(a[3], a[4]);
    startView = { pos: [p.x, a[2], p.z], target: [t.x, a[5] || 0, t.z], agl: true };
  }
  if (params.get('cam')) {
    // cam=x,y,z,tx,ty,tz（世界坐标，y 为离地高度）
    const a = params.get('cam').split(',').map(Number);
    startView = { pos: [a[0], a[1], a[2]], target: [a[3], a[4], a[5]], agl: true };
  }
  setView(startView, true);
  occluders.onIdle = () => {
    const s = occluders.stats();
    console.log(`[occluders] 遮挡体 ${s.meshes} 个网格 / ${(s.tris / 1e6).toFixed(2)}M 三角形 → ${s.tiles} 块（${s.mb} MB），累计 ${s.ms} ms`);
    if (controls.ensureFree()) console.log('[occluders] 相机落在实体内，已推出');
  };
  if (params.get('time')) sky.setHours(parseFloat(params.get('time')));
  if (params.get('orbit') === '1') controls.setMode('orbit');

  // —— UI ——
  ui.build(app);
  ui.setQualityActive(qIndex);
  const updateAttribution = () =>
    ui.setAttribution([
      imagery.provider.attribution,
      '建筑 CMAB（Zhang et al. 2025）',
      '地图数据 © OpenStreetMap 贡献者',
      ...(meta.sources || []).filter((x) => !/Esri|OpenStreetMap/i.test(x)).map((x) => x.split('(')[0].split('（')[0].trim()).slice(0, 2),
    ]);
  updateAttribution();
  ui.setProvider(imagery.providerId, !!imagery.pack);
  ui.setLayer('online', imagery.netAllowed);
  const miniSrc = imagery.mosaics.find((m) => /main/.test(m.file)) || imagery.mosaics[imagery.mosaics.length - 1];
  if (miniSrc) ui.setMinimapImage(miniSrc.texture.image, miniSrc.bounds);
  if (params.get('mini') === '0') ui.toggleMinimap(false);
  if (params.get('labels') === '0') setTimeout(() => setLayer('labels', false), 0);

  const goPreset = (key) => {
    const v = allPresets.find((p) => p.key === key);
    if (!v) return;
    setView(v, false);
    ui.toast(`前往：${v.name}`);
  };
  // —— 着色器预编译：点光源数量 / 阴影开关 / 环境贴图变化会让几乎所有材质重新编译（实测 4→12 盏灯单帧卡 0.8~1.6 s，
  //    从“低”切到“超高”连续几次累计 5 s 以上）。改为：暂停出图 → 按场景子树分帧提交编译（KHR_parallel_shader_compile 后台编译）
  //    → 全部就绪后恢复出图。主线程不再长时间阻塞，界面（提示、按钮）保持响应。
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  /** 在后期管线的 HDR 渲染目标下编译（程序参数里的色调映射/输出色彩空间与实际出图一致，否则首帧会全部再编译一遍） */
  const compileInSceneTarget = (obj) => {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(post.composer?.renderTarget1 || null);
    try {
      return renderer.compileAsync(obj, camera, scene).catch(() => {});
    } finally {
      renderer.setRenderTarget(prev);
    }
  };
  let compileJob = null;
  const precompile = () => {
    if (compileJob) return compileJob;
    compileJob = (async () => {
      const t0 = performance.now();
      app.compiling = true;
      try {
        await nextFrame();
        // 编译单元：网格很多的组拆成子树（每个单元同步部分 ≤ 十几毫秒，按帧切片提交）
        const units = [];
        const split = (o, depth) => {
          let n = 0;
          o.traverse((m) => { if (m.isMesh) n++; });
          if (n > 120 && depth < 4 && !o.isMesh && o.children.length > 1) for (const c of o.children) split(c, depth + 1);
          else if (n) units.push(o);
        };
        for (const c of scene.children) split(c, 0);
        const jobs = [];
        let tSlice = performance.now();
        for (const u of units) {
          jobs.push(compileInSceneTarget(u));
          if (performance.now() - tSlice > 16) {
            await nextFrame();
            tSlice = performance.now();
          }
        }
        await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 10000))]);
        // 首次使用时取 uniform/attribute 位置也是同步调用（几百个程序累计可达 0.5~1 s），同样分帧预取
        tSlice = performance.now();
        for (const p of renderer.info.programs || []) {
          try { p.getUniforms(); p.getAttributes(); } catch {}
          if (performance.now() - tSlice > 12) {
            await nextFrame();
            tSlice = performance.now();
          }
        }
      } finally {
        app.compiling = false;
        compileJob = null;
        app.lastCompileMs = Math.round(performance.now() - t0);
      }
    })();
    return compileJob;
  };
  app.precompile = precompile;
  let qSwitching = false;
  // 画质预设：填充“画质与显示”各细项并增量应用（core/display.js），随后后台预编译着色器
  const applyQuality = async (i) => {
    qIndex = THREE.MathUtils.clamp(i | 0, 0, QUALITY_LEVELS.length - 1);
    const name = QUALITY_LEVELS[qIndex].name;
    ui.setQualityActive(qIndex);
    ui.setQualityBusy?.(true);
    ui.toast(`正在切换画质：${name}（编译着色器）……`, 12000);
    qSwitching = true;
    try {
      await nextFrame();
      await nextFrame(); // 先让提示显示出来
      display.applyPreset(qIndex);
      quality = ctx.quality;
      await precompile();
    } finally {
      qSwitching = false;
      ui.setQualityBusy?.(false);
    }
    ui.toast(`画质：${name}${app.lastCompileMs > 300 ? `（着色器编译 ${(app.lastCompileMs / 1000).toFixed(1)} s）` : ''}`);
  };
  // “画质与显示”面板里单项改动同样可能触发全体重编译（灯数 / 阴影 / 环境反射）
  display.onChange((d, ch) => {
    if (!app.ready || qSwitching || !['pointLights', 'shadows', 'ibl'].some((k) => ch.has(k))) return;
    ui.toast('正在编译着色器……', 12000);
    precompile().then(() => ui.toast('显示设置已应用'));
  });
  const layers = { traffic: true, labels: true, buildings: true, districts: false };
  const setLayer = (name, v) => {
    layers[name] = v;
    if (name === 'labels') {
      labels.setVisible(v);
      if (app.thematic && app.thematic.setText) app.thematic.setText(v); // 路名、小区名一起开关
    }
    for (const inst of instances) if (inst.setLayer) inst.setLayer(name, v);
    ui.setLayer(name, v);
  };
  ui.on('hours', (hrs) => sky.setHours(hrs));
  ui.on('hoursAnimated', (hrs) => sky.setHours(hrs, true));
  ui.on('togglePlay', () => { sky.playing = !sky.playing; ui.setPlaying(sky.playing); });
  ui.on('speed', (s) => (sky.speed = s));
  ui.on('preset', goPreset);
  ui.on('quality', applyQuality);
  ui.on('online', (v) => {
    imagery.setOnlineEnabled(v);
    if (imagery.provider.local) ui.toast(v ? '已允许联网影像（当前为本地离线高清）' : '已禁止联网影像（本地离线高清照常使用）');
    else ui.toast(v ? '已开启在线高清卫星影像' : '已切换到内置影像');
  });
  ui.on('provider', (id) => {
    if (imagery.setProvider(id)) {
      try { localStorage.setItem('xian3d.imagery.v2', JSON.stringify({ id, hadLocal: !!imagery.pack })); } catch {}
      updateAttribution();
      ui.toast(`影像源：${imagery.provider.name}`);
    }
  });
  // “交通流与航班”作为总开关：同时切换 车辆 / 列车 / 航班（细项见“画质与显示 → 显示对象”）
  ui.on('traffic', (v) => display.setMany({ vehicles: v, trains: v, flights: v }));
  ui.on('labels', (v) => setLayer('labels', v));
  ui.on('buildings', (v) => setLayer('buildings', v));
  ui.on('districts', (v) => setLayer('districts', v));
  // —— 地铁：透视俯视 / 进入地下 ——
  // 透视俯视 / 地下浏览时，地面路名、小区名和地面地名不再显示（只留地铁站名），退出时恢复原开关状态
  let metroSaved = null;
  const GROUND_CATS = ['landmark', 'district', 'airport', 'station', 'street', 'admin', 'town', 'biz', 'metro'];
  const metroLabels = (quiet, hideGround = false) => {
    if (quiet) {
      if (!metroSaved) {
        const th = app.thematic && app.thematic.state;
        metroSaved = { rn: th ? th.roadnames : true, es: th ? th.estates : true, hidden: new Set(labels.hidden) };
        app.setRoadNames?.(false);
        app.setEstates?.(false);
      }
      if (hideGround) for (const c of GROUND_CATS) labels.hidden.add(c);
    } else if (metroSaved) {
      app.setRoadNames?.(metroSaved.rn && layers.labels);
      app.setEstates?.(metroSaved.es && layers.labels);
      for (const c of GROUND_CATS) labels.hidden.delete(c);
      for (const c of metroSaved.hidden) if (GROUND_CATS.includes(c)) labels.hidden.add(c);
      metroSaved = null;
    }
  };
  const metroXray = () => {
    const m = ctx.metro;
    if (!m) return ui.toast('地铁数据未加载');
    if (m.underground) {
      m.setUnder(false);
      metroLabels(false);
      ui.setMetroUnder?.(false);
    }
    m.setXray(!m.xray);
    metroLabels(m.xray, true);
    ui.setLayer('metro', m.xray);
    ui.toast(m.xray ? '地铁透视：线网按官方色显示（X 返回）' : '已退出地铁透视');
  };
  const metroUnder = () => {
    const m = ctx.metro;
    if (!m) return ui.toast('地铁数据未加载');
    if (m.xray) metroLabels(false);
    m.setUnder(!m.underground);
    metroLabels(m.underground);
    ui.setLayer('metro', false);
    ui.setMetroUnder?.(m.underground);
    ui.toast(m.underground ? `已进入地铁 ${m.station} 站（G 切换步行/飞行，U 返回地面）` : '已返回地面');
  };
  app.metroXray = metroXray;
  app.metroUnder = metroUnder;
  if (params.get('metro') === 'xray') setTimeout(metroXray, 0);
  if (params.get('metro') === 'under') setTimeout(metroUnder, 0);
  ui.on('metro', () => metroXray());
  ui.on('metroUnder', () => metroUnder());
  sky.speed = 0.1666667;
  initDisplaySettings();

  // —— 画质与显示设置：接入运行时对象、生成面板区块 ——
  function initDisplaySettings() {
    display.attach({ renderer, scene, camera, sky, post, terrain, lights, ctx, instances, ui, setLayer });
    const panel = buildDisplayPanel(ui, display, { open: params.get('disp') === '1' ? true : undefined });
    ui.addSectionAfterQuality(panel.el);
  }

  // —— 专题图层：路名 / 小区 / 建筑分类高亮（见 core/thematic.js） ——
  const thematic = setupThematic({ app, ctx, ui, root, params });
  app.thematic = thematic;
  // 地标/片区标注：被建筑挡住时隐藏
  labels.occ = ctx.lineBlocked;
  labels.groundAt = (x, z) => terrain.heightAt(x, z);
  labels.occVersion = () => occluders.version;
  const labelSpace = new LabelSpace();
  app.labelSpace = labelSpace;

  // —— 左上角“西安时讯”卡片：北京时间/农历节气、实时天气与空气质量、网络广播（见 core/infocard.js） ——
  app.infoCard = setupInfoCard({ root, ui, sky, display, params });

  // —— 一键俯视（通用）：app.topDown(on) 平滑转到当前视点正上方俯视；app.topDown(false) 回到原视角 ——
  //    俯视中心：视线与地面交点（1.5 km 内），否则取相机正下方；保持原航向（屏幕上方 = 原前进方向）
  {
    let saved = null;
    const dir = new THREE.Vector3();
    const flyNoArc = (p, t) => {
      controls.flyTo(p, t, { duration: 1.6 });
      if (controls.tween) controls.tween.arc = 0;
    };
    app.topDown = (on = !saved) => {
      if (on && !saved) {
        if (controls.mode !== 'fly') controls.setMode('fly');
        camera.getWorldDirection(dir);
        const cp = camera.position;
        const agl = Math.max(1, cp.y - terrain.heightAt(cp.x, cp.z));
        let cx = cp.x, cz = cp.z;
        if (dir.y < -0.05) {
          const t = agl / -dir.y;
          if (Math.hypot(dir.x * t, dir.z * t) < 1500) (cx += dir.x * t), (cz += dir.z * t);
        }
        const H = THREE.MathUtils.clamp(Math.max(agl * 1.4, 700), 700, 9000);
        const g = terrain.heightAt(cx, cz);
        let fx = dir.x, fz = dir.z;
        const fl = Math.hypot(fx, fz);
        if (fl < 1e-3) (fx = 0), (fz = -1);
        else (fx /= fl), (fz /= fl);
        saved = { p: cp.clone(), t: cp.clone().addScaledVector(dir, 100), mode: controls.mode };
        flyNoArc(new THREE.Vector3(cx, g + H, cz), new THREE.Vector3(cx + fx * H * 0.022, g, cz + fz * H * 0.022));
      } else if (!on && saved) {
        flyNoArc(saved.p, saved.t);
        saved = null;
      }
      ui.setTopDown(!!saved);
      return !!saved;
    };
    app.isTopDown = () => !!saved;
    ui.on('topdown', () => app.topDown());
    window.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.code === 'KeyV') ui.toast(app.topDown() ? '俯视（再按 V 回到原视角）' : '回到原视角');
    });
    if (params.get('topdown') === '1') {
      // 自动化：直接定位到俯视（不做动画）
      app.topDown(true);
      if (controls.tween) controls.tween.t = controls.tween.dur;
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const c = e.code;
    if (c.startsWith('Digit')) {
      const d = c.slice(5);
      goPreset(e.shiftKey ? '!' + d : d);
      return;
    }
    switch (c) {
      case 'KeyN': sky.toggleDayNight(); ui.toast(sky.night > 0.5 ? '切换到白天' : '切换到夜景'); break;
      case 'KeyT': sky.playing = !sky.playing; ui.setPlaying(sky.playing); ui.toast(sky.playing ? '时间流逝：开' : '时间流逝：关'); break;
      case 'BracketLeft': sky.setHours(sky.hours - 0.5, true); break;
      case 'BracketRight': sky.setHours(sky.hours + 0.5, true); break;
      case 'KeyG': controls.setMode(controls.mode === 'walk' ? 'fly' : 'walk'); ui.toast(controls.mode === 'walk' ? '步行模式（空格跳跃）' : '飞行模式'); break;
      case 'KeyO': controls.setMode(controls.mode === 'orbit' ? 'fly' : 'orbit'); ui.toast(controls.mode === 'orbit' ? '环绕展示模式' : '飞行模式'); break;
      case 'KeyL': setLayer('labels', !layers.labels); break;
      case 'KeyX': metroXray(); break;
      case 'KeyU': metroUnder(); break;
      case 'KeyM': ui.toggleMinimap(); break;
      case 'KeyP': ui.togglePanel(); break;
      case 'KeyH': case 'Slash': ui.toggleHelp(); break;
      case 'KeyF':
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
        break;
      case 'KeyK': screenshot(); break;
    }
  });

  const screenshot = () => {
    post.render(0);
    renderer.domElement.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `xian3d-${Date.now()}.png`;
      a.click();
    });
  };

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    post.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  // —— 主循环 ——
  const clock = new THREE.Clock();
  let fps = 60, frames = 0, fpsT = 0, elapsed = 0;
  const prevPos = camera.position.clone();
  const lastLabelPos = camera.position.clone();
  let speed = 0;
  app.frame = 0;
  const tick = () => {
    // 自动截图：暂停渲染，避免软件渲染（SwiftShader）时帧循环阻塞截图
    if (app.paused) { clock.getDelta(); requestAnimationFrame(tick); return; }
    const dt = Math.min(clock.getDelta(), 0.1);
    elapsed += dt;
    app.frame++;
    // 遮挡体分帧栅格化（相机附近优先；全部完成后若相机落在实体内则推出）
    if (occluders.queue.length) occluders.process(app.frame < 30 ? 2 : 4);
    controls.update(dt);
    // 动态近裁剪面：高空时增大，提升深度精度
    const agl = camera.userData.agl || 0;
    const near = THREE.MathUtils.clamp(agl * 0.01, 0.3, 30);
    if (Math.abs(near - camera.near) / camera.near > 0.2) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    ctx.uniforms.uTime.value = elapsed;
    ctx.uniforms.uCameraPos.value.copy(camera.position);
    sky.update(dt, camera);
    ctx.night.update(sky.night);
    terrain.update(camera);
    imagery.update();
    for (const inst of instances) {
      if (inst.update) {
        try { inst.update(dt, elapsed); } catch (e) {
          if (!inst._err) { console.error('[module] update 失败', inst.id, e); inst._err = true; }
        }
      }
    }
    lights.update(camera, sky.night);
    post.update(sky.night);
    renderer.info.reset();
    // 预编译着色器期间暂停出图（画面停在上一帧），避免渲染时同步等待编译造成长卡顿
    if (!app.compiling) post.render(dt);
    // 标注：三套（地名 → 路名 → 小区名）每 2 帧共用一张屏幕占用表，按离地高度整体限量
    // 相机瞬移（预设跳转/ll 定位/推出）后当帧就刷新，不留上一机位的残影
    const jumped = camera.position.distanceToSquared(lastLabelPos) > 900;
    if ((app.frame % 2 === 0 || jumped) && !app.compiling) {
      lastLabelPos.copy(camera.position);
      const W = window.innerWidth, H = window.innerHeight;
      labelSpace.begin(camera, W, H);
      labels.update(camera, W, H, labelSpace);
      thematic.update(camera, W, H, labelSpace);
    }

    speed = speed * 0.9 + (camera.position.distanceTo(prevPos) / Math.max(dt, 1e-3)) * 0.1;
    prevPos.copy(camera.position);
    frames++;
    fpsT += dt;
    if (fpsT >= 0.5) {
      fps = frames / fpsT;
      frames = 0;
      fpsT = 0;
    }
    const info = renderer.info.render;
    ui.update({
      camera,
      sky,
      fps,
      speed,
      mode: controls.mode,
      locked: controls.locked,
      place: ctx.metro && ctx.metro.underground ? `地下 · 地铁${ctx.metro.station || ''}站` : placeName(camera.position.x, camera.position.z),
      under: !!(ctx.metro && ctx.metro.underground),
      online: imagery.online.enabled ? `${imagery.provider.local ? '本地' : imagery.online.status} · 缓存 ${imagery.cache.size}` : '离线',
      stats: `绘制 ${info.calls} 次 · ${(info.triangles / 1e6).toFixed(2)}M 三角形 · 地形块 ${terrain.visibleCount}`,
    });
    app.fps = fps;
    requestAnimationFrame(tick);
  };

  // 预热一帧（编译着色器）后再移除加载页
  ui.setLoading(0.97, '编译着色器……');
  try {
    await compileInSceneTarget(scene);
  } catch (e) {
    console.warn('compileAsync 失败', e);
  }
  ui.setLoading(1, '完成');
  requestAnimationFrame(tick);
  ui.hideLoading();

  // 调试/自动化接口
  Object.assign(app, {
    ready: true,
    ctx,
    sky,
    terrain,
    imagery,
    goto: goPreset,
    presets: allPresets,
    resolveView,
    setView: (v) => setView(v, true),
    setHours: (hrs) => sky.setHours(hrs),
    setQuality: applyQuality,
    project,
    unproject,
    /** 影像/地形瓦片是否已基本加载完成（自动截图用） */
    settled: () => imagery.pending.size === 0 && imagery.inflight.size === 0,
  });
  readyResolve(app);
  if (app.errors.length) console.warn('[xian3d] 模块错误：', app.errors);
}

main().catch((e) => {
  console.error(e);
  const el = document.querySelector('.loading-msg');
  if (el) el.textContent = '启动失败：' + e.message;
  app.fatal = e.message;
});
