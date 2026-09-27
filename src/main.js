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
import { Labels } from './core/labels.js';
import { Exclusions } from './core/exclusions.js';
import { createContext } from './core/context.js';
import { UI } from './core/ui.js';
import { QUALITY_LEVELS, PRESETS, PRESETS_EXTRA, START_VIEW, defaultQualityLevel, IMAGERY_PROVIDERS } from './core/config.js';
import { project, unproject } from './core/geo.js';
import { MODULES } from './modules/index.js';
import { installHeightFog } from './core/fog.js';

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

  let qIndex = params.has('q') ? parseInt(params.get('q')) : (() => {
    try { const s = localStorage.getItem('xian3d.quality'); if (s != null) return parseInt(s); } catch {}
    return defaultQualityLevel();
  })();
  qIndex = THREE.MathUtils.clamp(qIndex || 0, 0, QUALITY_LEVELS.length - 1);
  let quality = { ...QUALITY_LEVELS[qIndex], level: qIndex };

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
  renderer.shadowMap.enabled = true;
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
    if (!pid) try { pid = localStorage.getItem('xian3d.imagery'); } catch {}
    if (pid === 'local' && !pack) pid = null;
    if (!pid && pack) pid = 'local';
    if (pid && IMAGERY_PROVIDERS[pid]) imagery.setProvider(pid);
  }
  // online=0 只关闭联网影像；本地瓦片包不受影响
  if (params.get('online') === '0' && !imagery.provider.local) imagery.setOnlineEnabled(false);
  const [,] = await Promise.all([terrain.load(meta), imagery.loadMosaics(meta.imagery)]);

  const data = {};
  const optional = { optional: true };
  const [roads, water, landuse, aeroway, pois, rail, buildings, bnames, landmarks, skyline] = await Promise.all([
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
  ]);
  Object.assign(data, { roads, water, landuse, aeroway, pois, rail, buildings, buildingNames: bnames, landmarks, skyline });
  offProg();

  // —— 系统 ——
  const uniformsHolder = {};
  const lights = new LightPool(scene, quality.pointLights);
  const labels = new Labels(root);
  const exclusions = new Exclusions();
  const ctx = createContext({ renderer, scene, camera, terrain, imagery, sky: null, lights, labels, exclusions, quality, data, meta });
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
  terrain.initRender(scene, imagery, quality);

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
  const setView = (v, instant) => {
    const { p, t } = resolveView(v);
    if (instant) {
      camera.position.copy(p);
      camera.lookAt(t);
      controls._syncAnglesFromCamera();
    } else controls.flyTo(p, t);
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
  const applyQuality = (i) => {
    qIndex = i;
    quality = { ...QUALITY_LEVELS[i], level: i };
    Object.assign(ctx.quality, quality);
    try { localStorage.setItem('xian3d.quality', String(i)); } catch {}
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    sky.setQuality(quality);
    terrain.setQuality(ctx.quality);
    lights.setCount(quality.pointLights);
    post.build(quality);
    for (const inst of instances) if (inst.setQuality) inst.setQuality(ctx.quality);
    ui.setQualityActive(i);
    ui.toast(`画质：${quality.name}`);
  };
  const layers = { traffic: true, labels: true, buildings: true };
  const setLayer = (name, v) => {
    layers[name] = v;
    if (name === 'labels') labels.setVisible(v);
    for (const inst of instances) if (inst.setLayer) inst.setLayer(name, v);
    ui.setLayer(name, v);
  };
  ui.on('hours', (hrs) => sky.setHours(hrs));
  ui.on('hoursAnimated', (hrs) => sky.setHours(hrs, true));
  ui.on('togglePlay', () => { sky.playing = !sky.playing; ui.setPlaying(sky.playing); });
  ui.on('speed', (s) => (sky.speed = s));
  ui.on('preset', goPreset);
  ui.on('quality', applyQuality);
  ui.on('online', (v) => { imagery.setOnlineEnabled(v); ui.toast(v ? '已开启在线高清卫星影像' : '已切换到内置影像'); });
  ui.on('provider', (id) => {
    if (imagery.setProvider(id)) {
      try { localStorage.setItem('xian3d.imagery', id); } catch {}
      updateAttribution();
      ui.toast(`影像源：${imagery.provider.name}`);
    }
  });
  ui.on('traffic', (v) => setLayer('traffic', v));
  ui.on('labels', (v) => setLayer('labels', v));
  ui.on('buildings', (v) => setLayer('buildings', v));
  sky.speed = 0.1666667;

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
  let speed = 0;
  app.frame = 0;
  const tick = () => {
    // 自动截图：暂停渲染，避免软件渲染（SwiftShader）时帧循环阻塞截图
    if (app.paused) { clock.getDelta(); requestAnimationFrame(tick); return; }
    const dt = Math.min(clock.getDelta(), 0.1);
    elapsed += dt;
    app.frame++;
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
    post.render(dt);
    labels.update(camera, window.innerWidth, window.innerHeight);

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
      place: placeName(camera.position.x, camera.position.z),
      online: imagery.online.enabled ? `${imagery.online.status} · 缓存 ${imagery.cache.size}` : '离线',
      stats: `绘制 ${info.calls} 次 · ${(info.triangles / 1e6).toFixed(2)}M 三角形 · 地形块 ${terrain.visibleCount}`,
    });
    app.fps = fps;
    requestAnimationFrame(tick);
  };

  // 预热一帧（编译着色器）后再移除加载页
  ui.setLoading(0.97, '编译着色器……');
  try {
    await renderer.compileAsync(scene, camera);
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
