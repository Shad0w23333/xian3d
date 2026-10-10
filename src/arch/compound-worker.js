// 小区草坪纯计算 Worker：栅格分类、角点解析距离、等值线、底层铺装、路缘串线、花木撒点（compound-gen.js lawnOps），
// 结果是出图指令（Float64Array），主线程按原顺序回放（replayLawns）。不碰地形高度与几何写入器。
// 输入与主线程逐位相同：楼轮廓数组、楼/路网格（打包后原样还原，格内 id 顺序不变）、路段、运动场地轮廓、让建筑的排除区。
import { lawnOps } from './compound-gen.js';
import { unpackBoxGrid } from './compound-plan.js';
import { pointInPoly } from '../core/util.js';

let S = null;
let ex = [];
const comps = new Map();

/** 与主线程 compounds.js 的 S.excludedIn 同义：外接框内的“点是否落在让建筑的排除区里” */
function excludedIn(x0, z0, x1, z1) {
  const cand = [];
  for (const it of ex) {
    const b = it.bb;
    if (b.x1 >= x0 && b.x0 <= x1 && b.z1 >= z0 && b.z0 <= z1) cand.push(it);
  }
  if (!cand.length) return null;
  return (x, z) => {
    for (const it of cand) {
      const b = it.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (pointInPoly(x, z, it.p)) return true;
    }
    return false;
  };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    const rs = m.rsegs, n = rs.length / 8;
    const rsegs = new Array(n);
    for (let i = 0; i < n; i++) rsegs[i] = rs.subarray(i * 8, i * 8 + 8);
    S = {
      index: { B: m.B, bgrid: unpackBoxGrid(m.bgrid), rgrid: unpackBoxGrid(m.rgrid), rsegs, sports: m.sports },
      excluded: (x, z) => { const f = excludedIn(x, z, x, z); return !!f && f(x, z); },
      excludedIn,
    };
    ex = m.ex;
    return;
  }
  if (m.t === 'ex') {
    ex = m.ex;
    return;
  }
  if (m.t === 'job') {
    try {
      if (m.c) comps.set(m.cid, m.c);
      const c = comps.get(m.cid);
      const it = lawnOps(S, c, m.x0, m.z0, m.x1, m.z1);
      let r;
      while (!(r = it.next()).done);
      const ops = r.value || null;
      self.postMessage({ id: m.id, ops }, ops ? [ops.buffer] : []);
    } catch (err) {
      self.postMessage({ id: m.id, err: String((err && err.stack) || err) });
    }
  }
};
