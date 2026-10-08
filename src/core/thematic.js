// 专题图层接线：路名、小区名称/边界、建筑分类高亮（含 skyline / dossier 精建楼的类别色外壳与屏幕图例）
// 由 main.js 调用 setupThematic()；返回 { update(camera, w, h) } 供主循环每帧调用。
// URL 参数：roadnames=0 / estates=0 关闭；estatelines=1 开启小区边界线（默认关，夜景里黄线太抢眼）；bldclass=1 开启分类高亮；bldsel=res,com,… 只高亮指定类别
import * as THREE from 'three';
import { RoadNames } from './roadnames.js';
import { Estates } from './estates.js';
import { BLD_CLASSES, C, classByName } from '../arch/bld-class.js';

export function setupThematic({ app, ctx, ui, root, params }) {
  const noText = params.get('labels') === '0';
  const state = { roadnames: params.get('roadnames') !== '0' && !noText, estates: params.get('estates') !== '0' && !noText, estateLines: params.get('estatelines') === '1', bldclass: params.get('bldclass') === '1', sel: null };
  if (params.get('bldsel')) {
    const keys = params.get('bldsel').split(',');
    state.sel = new Set(BLD_CLASSES.map((c, i) => (keys.includes(c.key) ? i : -1)).filter((i) => i >= 0));
  }

  let roadNames = null, estates = null;
  try {
    if (ctx.data.roads) roadNames = new RoadNames(root, ctx.data.roads, ctx.terrain, ctx.exclusions);
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
  const skyCaps = buildLandmarkShells(ctx);
  // 视线遮挡：通用建筑 + 精建模块遮挡体（main.js 提供 ctx.lineBlocked）
  const occ = (ax, ay, az, bx, by, bz, m1) => (ctx.lineBlocked ? ctx.lineBlocked(ax, ay, az, bx, by, bz, m1) : false);
  const occVersion = () => (ctx.occluders ? ctx.occluders.version : 0);
  if (roadNames) (roadNames.occ = occ), (roadNames.occVersion = occVersion);
  if (estates && estates.labels) (estates.labels.occ = occ), (estates.labels.occVersion = occVersion), (estates.labels.groundAt = (x, z) => ctx.terrain.heightAt(x, z));

  const applyClass = () => {
    const b = ctx.modules.buildings;
    if (b && b.setClassHighlight) {
      b.setClassHighlight(state.bldclass, state.sel);
      if (state.bldclass) ui.setClassStats(b.classStats());
    }
    if (skyCaps) skyCaps.set(state.bldclass, state.sel);
    ui.setClassLegend?.(state.bldclass, state.sel);
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
    state,
    /** 与“地名标注”总开关联动：路名、小区名一起开关 */
    setText(v) {
      setRoadNames(v);
      setEstates(v);
    },
    /** space：与地名标注共用的屏幕占用表（main.js 每 2 帧 begin 一次后依次调用 地名 → 路名 → 小区名） */
    update(camera, w, h, space) {
      if (roadNames) roadNames.update(camera, w, h, space);
      if (estates) estates.update(camera, w, h, space);
    },
  };
}

// 精建楼（skyline 地标高楼 + dossier 逐栋档案建筑）不走通用建筑着色器：分类高亮时给它们套一层“类别色外壳”
// （按轮廓外扩 0.35 m 拉伸到楼顶，墙面按朝向略分明暗），整栋显示类别色，与通用建筑一致；不改动这两个模块本身。
function buildLandmarkShells(ctx) {
  const polys = []; // { pts:[x,z,...], bot, top, cls }
  const D = ctx.modules.dossier;
  if (D && typeof D.diag === 'function') {
    try {
      for (const P of D.diag()) {
        if (!(P.pts && P.pts.length >= 6) || !(P.top - P.bot > 2)) continue;
        let c = classByName(P.name || '');
        if (c < 0) c = C.OTHER;
        polys.push({ pts: P.pts, bot: P.bot - 0.3, top: P.top + 0.4, cls: c });
      }
    } catch (e) {
      console.warn('[thematic] 档案建筑轮廓读取失败', e);
    }
  }
  const dossierBoxes = polys.map((p) => bbox(p.pts));
  if (ctx.modules.skyline) {
    const KIND = [C.OTHER, C.RES, C.COM, C.IND, C.GOV, C.CUL, C.TRA, C.EDU, C.HOT];
    for (const f of ctx.data.skyline?.features || []) {
      if (!(f.outer?.length >= 6) || !(f.h >= 12) || Math.hypot(f.x, f.z) > 47000) continue;
      // 已被档案建筑替代的（质心落在档案体块里）不重复套壳
      if (dossierBoxes.some((b, i) => f.x > b[0] && f.x < b[2] && f.z > b[1] && f.z < b[3] && inRing(f.x, f.z, polys[i].pts))) continue;
      let c = classByName(f.n);
      if (c < 0) c = f.kind === 2 && f.h >= 40 ? C.OFF : KIND[f.kind] ?? C.OTHER;
      const g = ctx.terrain.heightAt(f.x, f.z);
      polys.push({ pts: f.outer, bot: g - 1, top: g + f.h + 0.6, cls: c });
    }
  }
  if (!polys.length) return null;
  const pos = [], shade = [], owner = [], idx = [];
  const cls = polys.map((p) => p.cls);
  polys.forEach((P, pi) => {
    const o = outset(P.pts, 0.35);
    const n = o.length / 2;
    // 墙
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = o[i * 2], z0 = o[i * 2 + 1], x1 = o[j * 2], z1 = o[j * 2 + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.05) continue;
      // 朝向明暗：外法线与“西南上方”光向的夹角
      const nx = (z1 - z0) / L, nz = -(x1 - x0) / L;
      const k = 0.72 + 0.22 * Math.max(0, -0.6 * nx + 0.8 * nz);
      const b = pos.length / 3;
      pos.push(x0, P.bot, z0, x1, P.bot, z1, x1, P.top, z1, x0, P.top, z0);
      for (let q = 0; q < 4; q++) shade.push(k), owner.push(pi);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2); // 双面写入，绕向无关
    }
    // 顶
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(o[i * 2], o[i * 2 + 1]));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch { tris = []; }
    const b = pos.length / 3;
    for (const p of pts) pos.push(p.x, P.top, p.y), shade.push(1), owner.push(pi);
    for (const t of tris) idx.push(b + t[0], b + t[1], b + t[2], b + t[0], b + t[2], b + t[1]);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const col = new Float32Array(pos.length);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = '分类高亮-精建楼外壳';
  mesh.visible = false;
  mesh.frustumCulled = false;
  ctx.scene.add(mesh);
  const cc = new THREE.Color();
  console.log(`[thematic] 分类高亮外壳：精建楼体块 ${polys.length} 个，${(idx.length / 3 / 1000).toFixed(1)}k 三角形`);
  return {
    set(on, sel) {
      mesh.visible = on;
      if (!on) return;
      for (let v = 0; v < owner.length; v++) {
        const c = cls[owner[v]];
        if (!sel || sel.has(c)) cc.set(BLD_CLASSES[c].color).multiplyScalar(0.85 * shade[v]);
        else cc.setRGB(0.12, 0.12, 0.12).multiplyScalar(shade[v]);
        col[v * 3] = cc.r;
        col[v * 3 + 1] = cc.g;
        col[v * 3 + 2] = cc.b;
      }
      g.attributes.color.needsUpdate = true;
    },
  };
}

function bbox(p) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) (x0 = Math.min(x0, p[i])), (x1 = Math.max(x1, p[i])), (z0 = Math.min(z0, p[i + 1])), (z1 = Math.max(z1, p[i + 1]));
  return [x0, z0, x1, z1];
}
function inRing(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
  }
  return c;
}
/** 多边形每个顶点沿相邻两边外法线的角平分方向外扩 d 米（凹角处限幅） */
function outset(p, d) {
  const n = p.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  const sg = a >= 0 ? 1 : -1; // 鞋带公式 > 0 为逆时针，外法线 = (dz, -dx)
  const out = new Array(p.length);
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n;
    const ex0 = p[i * 2] - p[h * 2], ez0 = p[i * 2 + 1] - p[h * 2 + 1];
    const ex1 = p[j * 2] - p[i * 2], ez1 = p[j * 2 + 1] - p[i * 2 + 1];
    const l0 = Math.hypot(ex0, ez0) || 1, l1 = Math.hypot(ex1, ez1) || 1;
    let nx = sg * (ez0 / l0 + ez1 / l1), nz = -sg * (ex0 / l0 + ex1 / l1);
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    out[i * 2] = p[i * 2] + nx * d;
    out[i * 2 + 1] = p[i * 2 + 1] + nz * d;
  }
  return out;
}
