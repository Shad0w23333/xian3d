// 专题图层接线：路名、小区名称/边界、建筑分类高亮（含 skyline 精建高楼的屋顶色块）
// 由 main.js 调用 setupThematic()；返回 { update(camera, w, h) } 供主循环每帧调用。
// URL 参数：roadnames=0 / estates=0 关闭；estatelines=1 开启小区边界线（默认关，夜景里黄线太抢眼）；bldclass=1 开启分类高亮；bldsel=res,com,… 只高亮指定类别
import * as THREE from 'three';
import { RoadNames } from './roadnames.js';
import { Estates } from './estates.js';
import { BLD_CLASSES, C, classByName } from '../arch/bld-class.js';

export function setupThematic({ app, ctx, ui, root, params }) {
  const state = { roadnames: params.get('roadnames') !== '0', estates: params.get('estates') !== '0', estateLines: params.get('estatelines') === '1', bldclass: params.get('bldclass') === '1', sel: null };
  if (params.get('bldsel')) {
    const keys = params.get('bldsel').split(',');
    state.sel = new Set(BLD_CLASSES.map((c, i) => (keys.includes(c.key) ? i : -1)).filter((i) => i >= 0));
  }

  let roadNames = null, estates = null;
  try {
    if (ctx.data.roads) roadNames = new RoadNames(root, ctx.data.roads, ctx.terrain);
  } catch (e) {
    console.error('[thematic] 路名初始化失败', e);
    app.errors.push('roadnames: ' + e.message);
  }
  try {
    estates = new Estates(root, ctx);
  } catch (e) {
    console.error('[thematic] 小区初始化失败', e);
    app.errors.push('estates: ' + e.message);
  }
  const skyCaps = buildSkylineCaps(ctx);

  const applyClass = () => {
    const b = ctx.modules.buildings;
    if (b && b.setClassHighlight) {
      b.setClassHighlight(state.bldclass, state.sel);
      if (state.bldclass) ui.setClassStats(b.classStats());
    }
    if (skyCaps) skyCaps.set(state.bldclass, state.sel);
  };
  const setRoadNames = (v) => {
    state.roadnames = v;
    if (roadNames) roadNames.setVisible(v);
    ui.setLayer('roadnames', v);
  };
  const setEstates = (v) => {
    state.estates = v;
    if (estates) estates.setVisible(v);
    ui.setLayer('estates', v);
  };
  const setEstateLines = (v) => {
    state.estateLines = v;
    if (estates) estates.setLines(v);
    ui.setLayer('estatelines', v);
  };
  const setBldClass = (v) => {
    state.bldclass = v;
    applyClass();
    ui.setLayer('bldclass', v);
  };
  ui.on('roadnames', setRoadNames);
  ui.on('estates', setEstates);
  ui.on('estateLines', setEstateLines);
  ui.on('bldclass', (v) => {
    setBldClass(v);
    ui.toast(v ? '建筑分类高亮：开（可在图例中勾选类别）' : '建筑分类高亮：关');
  });
  ui.on('bldclassSel', (set) => {
    state.sel = set;
    if (!state.bldclass) setBldClass(true);
    else applyClass();
  });
  setRoadNames(state.roadnames);
  setEstates(state.estates);
  setEstateLines(state.estateLines);
  if (state.sel) ui.setClassSelection(state.sel);
  if (state.bldclass) setBldClass(true);

  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.code === 'KeyB') {
      setBldClass(!state.bldclass);
      ui.toast(state.bldclass ? '建筑分类高亮：开' : '建筑分类高亮：关');
    }
  });

  Object.assign(app, {
    thematic: state,
    setRoadNames,
    setEstates,
    setBldClass,
    roadNames,
    estates,
  });

  return {
    update(camera, w, h) {
      if (roadNames) roadNames.update(camera, w, h);
      if (estates) estates.update(camera, w, h);
    },
  };
}

// skyline 模块的精建高楼不走通用建筑着色器：分类高亮时在其楼顶加一块类别色屋面（不改 skyline 本身）
function buildSkylineCaps(ctx) {
  if (!ctx.modules.skyline) return null;
  const feats = (ctx.data.skyline?.features || []).filter((f) => f.outer?.length >= 6 && f.h >= 34 && Math.hypot(f.x, f.z) < 47000);
  if (!feats.length) return null;
  const KIND = [C.OTHER, C.RES, C.COM, C.IND, C.GOV, C.CUL, C.TRA, C.EDU, C.HOT];
  const pos = [], idx = [], owner = [];
  const cls = [];
  for (const f of feats) {
    let c = classByName(f.n);
    if (c < 0) c = f.kind === 2 && f.h >= 40 ? C.OFF : KIND[f.kind] ?? C.OTHER;
    const fi = cls.length;
    cls.push(c);
    const o = f.outer;
    const pts = [];
    for (let i = 0; i < o.length; i += 2) pts.push(new THREE.Vector2(o[i], o[i + 1]));
    if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    const y = ctx.terrain.heightAt(f.x, f.z) + f.h + 1.2;
    const base = pos.length / 3;
    for (const p of pts) {
      pos.push(p.x, y, p.y);
      owner.push(fi);
    }
    for (const t of tris) idx.push(base + t[0], base + t[2], base + t[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const col = new Float32Array(pos.length);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = '分类高亮-skyline屋面';
  mesh.visible = false;
  ctx.scene.add(mesh);
  const cc = new THREE.Color();
  return {
    set(on, sel) {
      mesh.visible = on;
      if (!on) return;
      for (let v = 0; v < owner.length; v++) {
        const c = cls[owner[v]];
        if (!sel || sel.has(c)) cc.set(BLD_CLASSES[c].color).multiplyScalar(0.8);
        else cc.setRGB(0.12, 0.12, 0.12);
        col[v * 3] = cc.r;
        col[v * 3 + 1] = cc.g;
        col[v * 3 + 2] = cc.b;
      }
      g.attributes.color.needsUpdate = true;
    },
  };
}
