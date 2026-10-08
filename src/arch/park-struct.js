// 公园近景：中式亭廊与公园大门（复用 src/arch/chinese*.js 构件库，只读 import）。
// 模板只建一次（detail 1，按材质烘焙），已加载块里的全部亭廊/大门按材质合并成一组网格（约 10 个 draw call，与数量无关），
// 块集合变化时重建（几何拷贝 + 变换，十几座以内几毫秒）。
//   · 六角亭：对边距 4.6 m，柱高约 2.6 m，青灰筒瓦攒尖、朱红柱、倒挂楣子、美人靠（公园湖边最常见的样式）；
//   · 四角亭：4.2 m 见方，攒尖顶；
//   · 游廊：长 12 m、宽 2.8 m 的卷棚顶直廊，带坐凳栏杆（湖边、园路交汇处）；
//   · 大门：三间四柱木牌楼（宽 12 m、明间净高 5.2 m，青灰瓦庑殿顶），园名牌由本模块的园名槽位另贴（不进构件库匾额图集，
//     这样所有大门共用材质、能合批）。
// 夜景：亭子檐口暖白轮廓灯（构件库 led 材质，夜间自动亮），只给亭子，不给游廊和大门（“少量”）。
import * as THREE from 'three';
import { buildArch, pavilion, paifang, corridor } from './chinese.js';

function extract(group) {
  group.updateMatrixWorld(true);
  const parts = [];
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    parts.push({ mat: o.material, geo: g, shadow: o.castShadow });
  });
  return parts;
}

export function buildTemplates(ctx) {
  const t0 = performance.now();
  const opt = { detail: 1, style: 'ming', instancing: false };
  const T = {};
  const mk = (fn, r, name) => {
    const g = buildArch(ctx, fn, { ...opt, name });
    T[name] = { parts: extract(g), r };
  };
  mk((b) => pavilion(b, { style: 'ming', sides: 6, size: 4.6, roofColor: 'gray', platformH: 0.45, eaveLights: { color: 0xffe2b0, width: 0.05, columns: false } }), 3.4, 'pav6');
  mk((b) => pavilion(b, { style: 'ming', sides: 4, size: 4.2, roofColor: 'gray', platformH: 0.4, eaveLights: { color: 0xffe2b0, width: 0.05, columns: false } }), 3.3, 'pav4');
  mk((b) => corridor(b, [[-6, 0], [6, 0]], { style: 'ming', w: 2.8, colH: 2.8, bay: 3, roof: 'juanpeng', roofColor: 'gray', platformH: 0.3 }), 7.5, 'lang');
  mk((b) => paifang(b, { style: 'ming', bays: 3, width: 12, h: 5.2, roofColor: 'gray' }), 7.0, 'gate');
  T.ms = Math.round(performance.now() - t0);
  return T;
}

export class StructureSet {
  constructor(root, templates) {
    this.root = root;
    this.T = templates;
    this.meshes = [];
    this.key = '';
  }
  /** list: [{tpl, x, y, z, yaw}] —— 全部已加载块的亭廊大门 */
  rebuild(list) {
    const key = list.map((s) => `${s.tpl}@${s.x.toFixed(1)},${s.z.toFixed(1)}`).sort().join('|');
    if (key === this.key) return;
    this.key = key;
    for (const m of this.meshes) { this.root.remove(m); m.geometry.dispose(); }
    this.meshes = [];
    if (!list.length) return;
    const byMat = new Map();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    for (const s of list) {
      const tp = this.T[s.tpl];
      if (!tp) continue;
      m4.compose(v.set(s.x, s.y, s.z), q.setFromAxisAngle(up, s.yaw), one);
      for (const p of tp.parts) {
        let e = byMat.get(p.mat);
        if (!e) byMat.set(p.mat, (e = { list: [], shadow: p.shadow }));
        e.list.push({ geo: p.geo, m: m4.clone() });
      }
    }
    for (const [mat, e] of byMat) {
      const g = mergeXf(e.list);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = '公园亭廊·' + (mat.name || '');
      mesh.castShadow = e.shadow;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.meshes.push(mesh);
    }
  }
}

/** 合并带变换的几何（属性集合取第一件的；法线按旋转变换） */
function mergeXf(list) {
  if (!list.length) return null;
  const names = Object.keys(list[0].geo.attributes).filter((n) => list.every((x) => x.geo.attributes[n]));
  let nv = 0, ni = 0;
  for (const x of list) { nv += x.geo.attributes.position.count; ni += x.geo.index ? x.geo.index.count : x.geo.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  const arrs = {};
  for (const n of names) arrs[n] = new Float32Array(nv * list[0].geo.attributes[n].itemSize);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  const nm = new THREE.Matrix3(), v = new THREE.Vector3();
  for (const x of list) {
    const g = x.geo, cnt = g.attributes.position.count;
    nm.getNormalMatrix(x.m);
    for (const n of names) {
      const a = g.attributes[n], it = a.itemSize, dst = arrs[n];
      if (n === 'position') {
        for (let i = 0; i < cnt; i++) { v.fromBufferAttribute(a, i).applyMatrix4(x.m); dst[(vo + i) * 3] = v.x; dst[(vo + i) * 3 + 1] = v.y; dst[(vo + i) * 3 + 2] = v.z; }
      } else if (n === 'normal') {
        for (let i = 0; i < cnt; i++) { v.fromBufferAttribute(a, i).applyMatrix3(nm).normalize(); dst[(vo + i) * 3] = v.x; dst[(vo + i) * 3 + 1] = v.y; dst[(vo + i) * 3 + 2] = v.z; }
      } else dst.set(a.array.subarray(0, cnt * it), vo * it);
    }
    if (g.index) { const s = g.index.array; for (let i = 0; i < s.length; i++) idx[io + i] = s[i] + vo; io += s.length; }
    else { for (let i = 0; i < cnt; i++) idx[io + i] = vo + i; io += cnt; }
    vo += cnt;
  }
  for (const n of names) out.setAttribute(n, new THREE.BufferAttribute(arrs[n], list[0].geo.attributes[n].itemSize));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
