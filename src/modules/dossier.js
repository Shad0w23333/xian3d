// 逐栋档案建筑：按 research/refs/dossiers（逐栋档案 + 照片）精建的商场、小区、公共建筑、地标。
// spec：src/arch/dossier-specs/*.js；建模库：src/arch/dossier-kit.js；轮廓：public/data/dossier_fp.json（tools/build_dossier_fp.py）。
// 替代机制：prepare 时登记 ctx.superseded = {names:Set, keys:Set, polys:[…]}，并为每栋加排除区（通用建筑/树木让位）；
//   skyline 用其内部的 isSuperseded(ctx, spec)、其他模块可用 dossier-kit.js 导出的 isSuperseded，跳过被档案替代的旧定义
//   （按 key / 名称，或质心落在档案建筑轮廓内）。
//   本模块须注册在 skyline（及其他会被替代的地标模块）之前——见 src/modules/index.js。
import * as THREE from 'three';
import * as G from '../arch/sky-geom.js';
import { createFacadeMaterial } from '../arch/sky-facade.js';
import { SignAtlas, Beacons, solidMats } from '../arch/sky-towers.js';
import { loadJSON } from '../core/data.js';
import { setFootprints, resolveSpec, buildDossier } from '../arch/dossier-kit.js';
import { DOSSIER_SPECS } from '../arch/dossier-specs/index.js';
import { SkyBatch } from '../arch/sky-batch.js';

const CELL = 6000; // 细部距离 LOD 的片区：6 km 网格（合批已改为逐栋 BatchedMesh，片区只用于 LOD 判定与泛光光幕合并）
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
        // 楼体内部的路段（OSM 路线穿过落地体块：数据错位或未标注的门洞）不画路面；贴墙 1.5 m 以内保留，
        // 真正的过街门洞（体块架空 base > 0.5，见时代盛典大厦）不受影响
        for (const P of R.parts) {
          if (P.base > 0.5 || P.part.kind === 'pave') continue;
          const q = G.inset(P.pts, 1.5);
          if (G.area(q) > 10) ctx.exclusions.add({ points: q, name: 'dossier:' + spec.id }, { buildings: false, trees: false, pois: false, roads: true });
        }
        // 落地体块下的地形：档案建筑以轮廓最低点为底（groundMin）。FABDEM 在大屋面/站房/老厂房处常残留几米到十几米的“屋顶地形”，
        // 上坡侧地形高出底板就成了埋地（墙脚被地形吞掉、地形从楼里冒出来）。轮廓一圈地形起伏 > 2.5 m 或 spec.flatten 时，
        // 全栋按同一高度（轮廓采样最低点）只压低不抬高；原先 spec.flatten 按每块轮廓各自的平均高度压平，同一栋的柱子/体块互相不齐。
        const gp = R.parts.filter((P) => P.base <= 0.5 && P.part.kind !== 'pave').map((P) => P.pts); // 铺装贴地形，不压平
        if (gp.length) {
          let lo = Infinity, hi = -Infinity;
          for (const p of gp)
            for (let i = 0, n = p.length / 2; i < n; i++) {
              const j = (i + 1) % n, ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
              const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 6));
              for (let s = 0; s < k; s++) {
                const h = ctx.terrain.heightAt(ax + ((bx - ax) * s) / k, az + ((bz - az) * s) / k);
                if (h < lo) lo = h;
                if (h > hi) hi = h;
              }
            }
          if (spec.flatten || hi - lo > 2.5)
            for (const p of gp) if (G.area(p) > 0.1) ctx.terrain.addFlatten({ points: G.inset(p, -4), height: lo, feather: spec.flatten ? 20 : 12, mode: 'min' });
        }
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
    // 招牌图集：4096×2048、行高 110（每页约 140 条），写满自动开新页；字牌双面正读（背面不是镜像字）
    const signs = new SignAtlas(ctx, 4096, 2048, { rowH: 110, tag: 'dossier' });
    const beacons = new Beacons(ctx);
    // 合批（第三轮性能修复，见 src/arch/sky-batch.js）：材质参数表 + 逐栋 BatchedMesh，同材质全模块一次绘制、仍逐栋视锥裁剪；
    // 细部距离 LOD 仍按 6 km 片区判定；泛光光幕按片区合并、白天收起。原先每片区每材质一个网格，人眼机位约 290 次绘制/帧。
    const B = new SkyBatch(ctx, { name: 'dossier', fmat, mats, signs, beacons });
    const zoneOf = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
    const errors = [];
    const built = [];
    for (const R of RESOLVED) {
      try {
        const r = B.run(zoneOf(R.center.x, R.center.z), (E) => buildDossier(E, R));
        built.push({ id: R.spec.id, name: R.spec.name, ...r });
      } catch (e) {
        console.error('[dossier] 构建失败', R.spec.id, e);
        errors.push(R.spec.id);
      }
    }
    const { lod } = B.build(root);
    const sm = signs.build();
    if (sm) {
      root.add(sm);
      lod.push({ box: new THREE.Box3().setFromObject(sm), range: 9000, on: true, set: (v) => (sm.visible = v) });
    }
    root.add(beacons.build());
    const stats = { count: built.length, errors, ms: Math.round(performance.now() - t0) };
    console.warn('[dossier] 构建完成 ' + JSON.stringify(stats));
    return {
      stats,
      built,
      /** 诊断（tools/check_overlap.mjs）：各体块世界轮廓与底/顶高度（R.ground 由 buildDossier 写入） */
      diag: () =>
        RESOLVED.filter((R) => Number.isFinite(R.ground)).flatMap((R) =>
          R.parts.filter((P) => P.part.kind !== 'pave').map((P) => ({ id: R.spec.id, name: R.spec.name, part: P.name, pts: P.pts, bot: R.ground + P.base, top: R.ground + P.top, ground: P.base <= 0.5 })) // 铺装贴地形，不按建筑体块诊断
        ),
      update() {
        beacons.update(ctx.renderer, ctx.camera);
        B.update(); // 材质参数表、夜间专用网格、细部与招牌的距离 LOD
      },
      setLayer(layer, v) {
        if (layer === 'buildings') root.visible = v;
      },
      setQuality(q) {
        for (const l of lod) l.range = q.level === 0 ? (l.range > 5000 ? 6000 : 1800) : l.range > 5000 ? 9000 : 3200;
      },
      dispose() {
        root.traverse((o) => (o.isBatchedMesh ? o.dispose() : o.geometry && o.geometry.dispose()));
        ctx.scene.remove(root);
      },
    };
  },
};

