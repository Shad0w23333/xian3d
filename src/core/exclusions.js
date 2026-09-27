// 排除区：地标位置让通用 OSM 建筑/树木/道路让位
import { pointInPoly, polyBBox, rectPoly, circlePoly } from './util.js';

export class Exclusions {
  constructor() {
    this.items = [];
    this.cell = 500;
    this.grid = new Map();
  }

  /**
   * shape: {points:[x,z,...]} | {rect:[cx,cz,w,d,rotRad]} | {circle:[cx,cz,r]}
   * flags: {buildings=true, trees=true, roads=false, pois=true, maxHeight}
   *   maxHeight（可选，米）：只让高度 ≤ maxHeight 的通用建筑让位（片区精建替换低层街区、保留其中高楼）
   */
  add(shape, flags = {}) {
    let p = shape.points;
    if (shape.rect) p = rectPoly(...shape.rect);
    if (shape.circle) p = circlePoly(shape.circle[0], shape.circle[1], shape.circle[2], 28);
    const it = {
      p: Float64Array.from(p),
      bb: polyBBox(p),
      flags: { buildings: true, trees: true, roads: false, pois: true, ...flags },
      name: shape.name || '',
    };
    this.items.push(it);
    const b = it.bb;
    for (let cx = Math.floor(b.x0 / this.cell); cx <= Math.floor(b.x1 / this.cell); cx++)
      for (let cz = Math.floor(b.z0 / this.cell); cz <= Math.floor(b.z1 / this.cell); cz++) {
        const k = cx * 100003 + cz;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(it);
      }
    return it;
  }

  /** 点是否落在某类排除区内；h 为建筑高度（仅 buildings 用于 maxHeight 判断） */
  test(x, z, kind = 'buildings', h = 0) {
    const list = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell));
    if (!list) return false;
    for (const it of list) {
      if (!it.flags[kind]) continue;
      if (kind === 'buildings' && it.flags.maxHeight != null && h > it.flags.maxHeight) continue;
      const b = it.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (pointInPoly(x, z, it.p)) return true;
    }
    return false;
  }
}
