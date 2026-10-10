// 现代建筑合批（skyline、逐栋档案共用）：逐栋 BatchedMesh + 材质参数表。
//  · 材质参数表 MatTable（core/util.js）：只差颜色/粗糙度/金属度/自发光的纯色楼体、灯带材质并成一个共享材质（逐顶点表索引），
//    参数每帧从源材质同步（夜间发光照常由 ctx.night 驱动源材质）；
//  · 逐栋对象合批 ObjectBatcher（core/util.js）：每栋楼（每个对象）每种材质的几何作为 BatchedMesh 的一个实例，
//    同材质全模块一次绘制（WEBGL_multi_draw），仍逐栋做视锥裁剪（主视图、阴影各自裁剪）；
//  · 细部的距离 LOD 仍按“片区”判定（片区全部细部的外包盒距相机 < range），逐栋开关 BatchedMesh 里该片区的实例；
//  · 透明材质（泛光光幕，加色混合）保持“片区 × 材质”合并的普通网格（与原先排序语义一致），
//    标了 userData.nightOnly 的（uNight = 0 时片元全部丢弃）白天直接收起。
// 用法：
//   const B = new SkyBatch(ctx, { name, fmat, mats, signs, beacons });
//   B.run(zoneId, (E) => buildTower(E, spec));   // E 与原先的 env 字段相同：ctx, id, dk, fb, solid, detail, mats, signs, beacons
//   const { lod } = B.build(root);                 // 之后每帧 B.update()
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TableBatcher, MatTable, ObjectBatcher, drainBatcher, setRefVisible, hasMultiDraw } from '../core/util.js';
import { FacadeBuilder } from './sky-geom.js';

/** 有贴图的材质自动套“米制”UV（贴图自带 UV 的除外）；纯色材质并入材质参数表 */
export class SkyBatcher extends TableBatcher {
  add(g, m, mtx = null, o = {}) {
    if (m.map && !m.userData.ownUV && !o.worldUV) o = { ...o, worldUV: 1 };
    return super.add(g, m, mtx, o);
  }
}

export class SkyBatch {
  constructor(ctx, { name, fmat, mats, signs, beacons, detailRange = 3200 }) {
    this.ctx = ctx;
    this.name = name;
    this.fmat = fmat;
    this.base = { ctx, mats, signs, beacons };
    this.detailRange = detailRange;
    this.table = new MatTable(name + '.matTable');
    // 浏览器不支持多重绘制时退回“片区 × 材质”合并的普通网格（与原先的合批结构相同）
    const multiDraw = hasMultiDraw(ctx.renderer);
    this.obFacade = new ObjectBatcher({ multiDraw });
    this.obSolid = new ObjectBatcher({ multiDraw });
    this.obDetail = new ObjectBatcher({ multiDraw });
    this.zones = new Map();
    this.lod = [];
    this.nightOnly = [];
  }
  zone(id) {
    if (!this.zones.has(id)) this.zones.set(id, { id, dk: new Map(), detBox: new THREE.Box3(), solidT: [], detT: [], refs: [] });
    return this.zones.get(id);
  }
  /** 新对象的 env（与原先片区 env 字段一致；dk 材质缓存按片区共享） */
  env(zoneId) {
    const Z = this.zone(zoneId);
    return { ...this.base, id: Z.id, dk: Z.dk, fb: new FacadeBuilder(), solid: new SkyBatcher(this.table), detail: new SkyBatcher(this.table), _zone: Z };
  }
  /** 收取一个对象写入 env 的几何（构建出错时已写入的部分照旧保留，同原先按片区合批的行为） */
  collect(E) {
    const Z = E._zone;
    if (E.fb.count) this.obFacade.add(E.fb.geometry(), this.fmat, Z);
    for (const { material, geometry } of drainBatcher(E.solid)) {
      if (material.transparent) Z.solidT.push({ material, geometry });
      else this.obSolid.add(geometry, material, Z);
    }
    for (const { material, geometry } of drainBatcher(E.detail)) {
      geometry.computeBoundingBox();
      Z.detBox.union(geometry.boundingBox);
      if (material.transparent) Z.detT.push({ material, geometry });
      else this.obDetail.add(geometry, material, Z);
    }
  }
  /** 在片区 zoneId 里建一个对象：fn(E) 的返回值原样返回；异常照常抛出（调用方自己捕获） */
  run(zoneId, fn) {
    const E = this.env(zoneId);
    try {
      return fn(E);
    } finally {
      this.collect(E);
    }
  }
  /** 输出网格到 root：幕墙/实体/细部三组 BatchedMesh + 各片区透明网格；返回 { lod }（细部 LOD 项，可追加别的项） */
  build(root) {
    this.table.build();
    const fac = this.obFacade.build({ castShadow: true, receiveShadow: true, name: '幕墙' });
    const sol = this.obSolid.build({ castShadow: true, receiveShadow: true, name: '实体' });
    const det = this.obDetail.build({ castShadow: false, receiveShadow: false, name: '细部' });
    root.add(fac.group, sol.group, det.group);
    for (const r of det.refs) r.tag.refs.push(r);
    for (const Z of this.zones.values()) {
      const grp = new THREE.Group();
      grp.name = this.name + '-' + Z.id;
      if (Z.solidT.length) grp.add(mergeZone(Z.solidT, '实体·透明', true));
      const dT = mergeZone(Z.detT, '细部·透明', false);
      for (const m of dT.children) if (m.material.userData.nightOnly) this.nightOnly.push(m);
      grp.add(dT);
      if (grp.children.some((c) => c.children.length)) root.add(grp);
      if (!Z.detBox.isEmpty())
        this.lod.push({
          box: Z.detBox, range: this.detailRange, on: true,
          set(v) {
            dT.visible = v;
            for (const r of Z.refs) setRefVisible(r, v);
          },
        });
    }
    this.zones.clear();
    return { lod: this.lod };
  }
  /** 每帧：同步材质参数表、夜间专用网格、距离 LOD（只在状态变化时开关） */
  update() {
    const ctx = this.ctx;
    this.table.update();
    const night = ctx.uniforms.uNight.value > 0;
    for (const m of this.nightOnly) m.visible = night;
    const p = ctx.camera.position;
    for (const l of this.lod) {
      const v = l.box.distanceToPoint(p) < l.range;
      if (v !== l.on) l.set((l.on = v));
    }
  }
}

/** 同一片区同材质的几何按添加顺序合成一个普通网格（同原 Batcher.build） */
function mergeZone(list, name, cast) {
  const grp = new THREE.Group();
  grp.name = name;
  const by = new Map();
  for (const it of list) {
    if (!by.has(it.material.uuid)) by.set(it.material.uuid, { material: it.material, geos: [] });
    by.get(it.material.uuid).geos.push(it.geometry);
  }
  for (const { material, geos } of by.values()) {
    if (geos.some((g) => g.attributes.color))
      for (const g of geos) if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const m = new THREE.Mesh(merged, material);
    m.castShadow = cast;
    m.receiveShadow = cast;
    grp.add(m);
  }
  return grp;
}
