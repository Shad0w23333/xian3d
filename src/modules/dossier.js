// 逐栋档案建筑：按 research/refs/dossiers（逐栋档案 + 照片）精建的商场、小区、公共建筑、地标。
// spec：src/arch/dossier-specs/*.js；建模库：src/arch/dossier-kit.js；轮廓：public/data/dossier_fp.json（tools/build_dossier_fp.py）。
// 替代机制：prepare 时登记 ctx.superseded = {names:Set, keys:Set, polys:[…]}，并为每栋加排除区（通用建筑/树木让位）；
//   skyline 用其内部的 isSuperseded(ctx, spec)、其他模块可用 dossier-kit.js 导出的 isSuperseded，跳过被档案替代的旧定义
//   （按 key / 名称，或质心落在档案建筑轮廓内）。
//   本模块须注册在 skyline（及其他会被替代的地标模块）之前——见 src/modules/index.js。
import * as THREE from 'three';
import { Batcher } from '../core/util.js';
import * as G from '../arch/sky-geom.js';
import { createFacadeMaterial } from '../arch/sky-facade.js';
import { SignAtlas, Beacons, solidMats } from '../arch/sky-towers.js';
import { loadJSON } from '../core/data.js';
import { setFootprints, resolveSpec, buildDossier } from '../arch/dossier-kit.js';
import { DOSSIER_SPECS } from '../arch/dossier-specs/index.js';

/** 有贴图的材质自动套米制 UV（同 skyline） */
class SBatcher extends Batcher {
  add(g, m, mtx = null, o = {}) {
    if (m.map && !m.userData.ownUV && !o.worldUV) o = { ...o, worldUV: 1 };
    return super.add(g, m, mtx, o);
  }
}

const CELL = 3000; // 合批分组：3 km 网格
let RESOLVED = [];

/** 登记替代信息（其他模块也可在自己的 prepare 里读 ctx.superseded） */
function ensureSuperseded(ctx) {
  return (ctx.superseded ??= { names: new Set(), keys: new Set(), polys: [], by: [] });
}

export default {
  id: 'dossier',
  name: '逐栋档案建筑',
  async prepare(ctx) {
    setFootprints(await loadJSON('dossier_fp.json', { optional: true }));
    const sup = ensureSuperseded(ctx);
    RESOLVED = [];
    for (const spec of DOSSIER_SPECS) {
      try {
        const R = resolveSpec(spec);
        RESOLVED.push(R);
        for (const n of [spec.name, ...(spec.supersede?.names || [])]) if (n) sup.names.add(n);
        for (const k of spec.supersede?.keys || []) sup.keys.add(k);
        for (const p of R.polys) {
          sup.polys.push(p);
          sup.by.push(spec.id);
          ctx.exclusions.add({ points: G.inset(p, -(spec.clearance ?? 2.5)), name: 'dossier:' + spec.id }, { buildings: true, trees: true });
        }
        if (spec.flatten) for (const p of R.polys) ctx.terrain.addFlatten({ points: G.inset(p, -6), height: null, feather: 20 });
      } catch (e) {
        console.error('[dossier] 解析失败', spec.id, e);
      }
    }
    console.warn(`[dossier] 档案建筑 ${RESOLVED.length}/${DOSSIER_SPECS.length} 栋；替代名称 ${sup.names.size}、key ${sup.keys.size}、轮廓 ${sup.polys.length}`);
  },

  async build(ctx) {
    const t0 = performance.now();
    const root = new THREE.Group();
    root.name = '逐栋档案建筑';
    ctx.scene.add(root);
    if (!RESOLVED.length) return { stats: { count: 0 } };
    const fmat = createFacadeMaterial(ctx);
    const mats = solidMats(ctx);
    mats.heli.userData.ownUV = true;
    // 招牌图集：各片区 spec 招牌合计上百条，4096×1024（行高 150）只装得下约 36 条；改为 4096×2048、行高 110（约 140 条）
    const signs = new SignAtlas(ctx, 4096, 2048, { rowH: 110 });
    const beacons = new Beacons(ctx);
    const envs = new Map();
    const env = (x, z) => {
      const id = Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
      if (!envs.has(id)) envs.set(id, { ctx, id, fb: new G.FacadeBuilder(), solid: new SBatcher(), detail: new SBatcher(), mats, signs, beacons });
      return envs.get(id);
    };
    const errors = [];
    const built = [];
    for (const R of RESOLVED) {
      try {
        const r = buildDossier(env(R.center.x, R.center.z), R);
        built.push({ id: R.spec.id, name: R.spec.name, ...r });
      } catch (e) {
        console.error('[dossier] 构建失败', R.spec.id, e);
        errors.push(R.spec.id);
      }
    }
    const lod = [];
    for (const E of envs.values()) {
      const grp = new THREE.Group();
      grp.name = 'dossier-' + E.id;
      if (E.fb.count) {
        const m = new THREE.Mesh(E.fb.geometry(), fmat);
        m.castShadow = true; m.receiveShadow = true; m.name = '幕墙';
        grp.add(m);
      }
      grp.add(E.solid.build({ castShadow: true, receiveShadow: true, name: '实体' }));
      const det = E.detail.build({ castShadow: false, receiveShadow: false, name: '细部' });
      grp.add(det);
      const bs = new THREE.Box3().setFromObject(det);
      if (!bs.isEmpty()) lod.push({ obj: det, box: bs, range: 3200 });
      root.add(grp);
    }
    const sm = signs.build();
    if (sm) {
      root.add(sm);
      lod.push({ obj: sm, box: new THREE.Box3().setFromObject(sm), range: 9000 });
    }
    root.add(beacons.build());
    const stats = { count: built.length, errors, ms: Math.round(performance.now() - t0) };
    console.warn('[dossier] 构建完成 ' + JSON.stringify(stats));
    return {
      stats,
      built,
      update() {
        beacons.update(ctx.renderer, ctx.camera);
        for (const l of lod) l.obj.visible = l.box.distanceToPoint(ctx.camera.position) < l.range;
      },
      setLayer(layer, v) {
        if (layer === 'buildings') root.visible = v;
      },
      setQuality(q) {
        for (const l of lod) l.range = q.level === 0 ? (l.range > 5000 ? 6000 : 1800) : l.range > 5000 ? 9000 : 3200;
      },
      dispose() {
        root.traverse((o) => o.geometry && o.geometry.dispose());
        ctx.scene.remove(root);
      },
    };
  },
};

