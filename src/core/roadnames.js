// 路名标注：沿道路走向旋转的 DOM 文字（离近了才出现），同名路段合并去重，只处理相机附近的锚点。
//
//   · 预处理：roads.json 中有名称的路段按长度从长到短，每隔 spacing 米取一个锚点（短路段取中点），
//     同名锚点在 0.75×spacing 半径内去重（双向分幅道路/多段同名道路只留一个）；急弯处不放
//   · 显示距离（相机到锚点的三维距离）：高速/快速/主干道 1.5 km，次干道 1.15 km，支路 900 m，街巷/匝道 650 m
//   · 每 2 帧：查询相机附近网格 → 投影 → 屏幕上的道路方向角（文字始终正读，不倒置）→ 按等级/距离排序
//     → 旋转矩形分离轴碰撞检测 + 同名屏幕间距 → 复用 DOM 节点池
import * as THREE from 'three';
import { roadY } from './roadheight.js';

const CELL = 300;
// 等级：0 高速/快速/主干 1 次干道 2 支路 3 街巷/匝道/步行街
const TIER_OF_CLASS = [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3];
const TIER_MAXD = [1500, 1150, 900, 650];
const TIER_SPACING = [420, 340, 260, 200];
const TIER_FONT = [15, 14, 13, 12];
const MAX_VISIBLE = 44;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class RoadNames {
  /** container：DOM 父节点；roads：roads.json；terrain：地形（heightAt） */
  constructor(container, roads, terrain) {
    this.root = document.createElement('div');
    this.root.className = 'rnames';
    container.appendChild(this.root);
    this.visible = true;
    this.pool = [];
    this.used = 0;
    this._frame = 0;
    this.grid = new Map();
    this.anchors = [];
    const t0 = performance.now();
    this._build(roads, terrain);
    console.log(`[roadnames] 路名锚点 ${this.anchors.length} 个（${this.names.length} 条路名），${(performance.now() - t0).toFixed(0)} ms`);
  }

  _build(roads, terrain) {
    const feats = (roads?.features || []).filter((f) => f.n && !f.t && f.p && f.p.length >= 4 && /[一-龥]/.test(f.n));
    // 每条要素的长度
    const lens = new Map();
    for (const f of feats) {
      let L = 0;
      for (let i = 2; i < f.p.length; i += 2) L += Math.hypot(f.p[i] - f.p[i - 2], f.p[i + 1] - f.p[i - 1]);
      lens.set(f, L);
    }
    // 同名道路取最高等级（匝道沿用主路名时不降级）
    const bestTier = new Map();
    for (const f of feats) {
      const t = TIER_OF_CLASS[f.c] ?? 3;
      bestTier.set(f.n, Math.min(bestTier.get(f.n) ?? 9, t));
    }
    feats.sort((a, b) => (TIER_OF_CLASS[a.c] ?? 3) - (TIER_OF_CLASS[b.c] ?? 3) || lens.get(b) - lens.get(a));
    const nameIdx = new Map();
    this.names = [];
    const byName = new Map(); // name → Map(cellKey → [x,z,...])
    const NC = 200;
    const tooClose = (n, x, z, r) => {
      const m = byName.get(n);
      if (!m) return false;
      const ci = Math.floor(x / NC), cj = Math.floor(z / NC), k = Math.ceil(r / NC);
      for (let i = ci - k; i <= ci + k; i++)
        for (let j = cj - k; j <= cj + k; j++) {
          const a = m.get(i * 100003 + j);
          if (a) for (let q = 0; q < a.length; q += 2) if ((a[q] - x) ** 2 + (a[q + 1] - z) ** 2 < r * r) return true;
        }
      return false;
    };
    const mark = (n, x, z) => {
      let m = byName.get(n);
      if (!m) byName.set(n, (m = new Map()));
      const key = Math.floor(x / NC) * 100003 + Math.floor(z / NC);
      let a = m.get(key);
      if (!a) m.set(key, (a = []));
      a.push(x, z);
    };
    // 折线上按里程取点
    const at = (p, cum, s) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const s0 = cum[i - 1], s1 = cum[i];
      const k = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      const x0 = p[(i - 1) * 2], z0 = p[(i - 1) * 2 + 1], x1 = p[i * 2], z1 = p[i * 2 + 1];
      return [x0 + (x1 - x0) * k, z0 + (z1 - z0) * k];
    };
    for (const f of feats) {
      const L = lens.get(f);
      const tier = bestTier.get(f.n);
      const sp = TIER_SPACING[tier];
      const textLen = Array.from(f.n).length * 9; // 贴路所需的最短长度（米，粗估）
      if (L < Math.min(60, textLen)) continue;
      const n = f.p.length / 2;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(f.p[i * 2] - f.p[i * 2 - 2], f.p[i * 2 + 1] - f.p[i * 2 - 1]);
      const ss = [];
      if (L < sp) ss.push(L / 2);
      else for (let s = ((L % sp) + sp) / 2; s < L - 20; s += sp) ss.push(s);
      for (const s of ss) {
        const [x, z] = at(f.p, cum, s);
        if (tooClose(f.n, x, z, sp * 0.75)) continue;
        const [xa, za] = at(f.p, cum, Math.max(0, s - 22));
        const [xb, zb] = at(f.p, cum, Math.min(L, s + 22));
        const [xm0, zm0] = at(f.p, cum, Math.max(0, s - 6));
        const [xm1, zm1] = at(f.p, cum, Math.min(L, s + 6));
        const d1 = Math.atan2(zm0 - za, xm0 - xa), d2 = Math.atan2(zb - zm1, xb - xm1);
        let bend = Math.abs(d1 - d2);
        if (bend > Math.PI) bend = 2 * Math.PI - bend;
        if (bend > 0.6 && L > 60) continue; // 急弯/路口转角
        let dx = xb - xa, dz = zb - za;
        const dl = Math.hypot(dx, dz) || 1;
        dx /= dl;
        dz /= dl;
        const y = roadY(terrain, f, x, z, s, L) ?? terrain.heightAt(x, z);
        let ni = nameIdx.get(f.n);
        if (ni == null) {
          ni = this.names.length;
          nameIdx.set(f.n, ni);
          this.names.push(f.n);
        }
        mark(f.n, x, z);
        const an = { x, y: y + 1.2, z, dx, dz, tier, name: f.n, ni };
        this.anchors.push(an);
        const key = Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
        let a = this.grid.get(key);
        if (!a) this.grid.set(key, (a = []));
        a.push(an);
      }
    }
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  _el(i) {
    let e = this.pool[i];
    if (!e) {
      e = document.createElement('div');
      e.className = 'rname';
      e.style.display = 'none';
      this.root.appendChild(e);
      e._text = '';
      e._tier = -1;
      this.pool[i] = e;
    }
    return e;
  }

  update(camera, w, h) {
    if (!this.visible) return;
    if (++this._frame % 2) return;
    const cp = camera.position;
    const R = TIER_MAXD[0];
    const ci = Math.floor(cp.x / CELL), cj = Math.floor(cp.z / CELL), k = Math.ceil(R / CELL);
    const cand = [];
    // 相机右向量（用于判断道路在屏幕上的透视压缩）
    const e = camera.matrixWorld.elements;
    const rx = e[0], ry = e[1], rz = e[2];
    for (let i = ci - k; i <= ci + k; i++)
      for (let j = cj - k; j <= cj + k; j++) {
        const arr = this.grid.get(i * 100003 + j);
        if (!arr) continue;
        for (const an of arr) {
          const d = Math.hypot(an.x - cp.x, an.y - cp.y, an.z - cp.z);
          const maxD = TIER_MAXD[an.tier];
          if (d > maxD) continue;
          _a.set(an.x, an.y, an.z).project(camera);
          if (_a.z > 1 || _a.z < -1 || Math.abs(_a.x) > 1 || Math.abs(_a.y) > 1) continue;
          const sx = (_a.x * 0.5 + 0.5) * w, sy = (-_a.y * 0.5 + 0.5) * h;
          const step = Math.max(4, d * 0.02);
          _b.set(an.x + an.dx * step, an.y, an.z + an.dz * step).project(camera);
          let ex = (_b.x * 0.5 + 0.5) * w - sx, ey = (-_b.y * 0.5 + 0.5) * h - sy;
          const lenAlong = Math.hypot(ex, ey);
          _b.set(an.x + rx * step, an.y + ry * step, an.z + rz * step).project(camera);
          const lenRef = Math.hypot((_b.x * 0.5 + 0.5) * w - sx, (-_b.y * 0.5 + 0.5) * h - sy) || 1;
          let ang;
          if (lenAlong / lenRef < 0.3) ang = 0; // 道路几乎沿视线方向：文字正放
          else {
            if (ex < 0) (ex = -ex), (ey = -ey); // 始终从左往右读
            ang = Math.atan2(ey, ex);
            if (ang > 1.4) ang -= Math.PI; // 接近竖直时统一成从下往上读
          }
          const fade = Math.min(1, (maxD - d) / (maxD * 0.2));
          cand.push({ an, d, sx, sy, ang, fade, score: an.tier * 10000 + d });
        }
      }
    cand.sort((a, b) => a.score - b.score);

    const acc = [];
    const lastByName = new Map();
    const inUI = (x, y) => (x < 292 && y < 202) || x > w - 322 || (x < 224 && y > h - 214) || y > h - 62;
    for (const c of cand) {
      if (acc.length >= MAX_VISIBLE) break;
      const fs = TIER_FONT[c.an.tier];
      const hw = (Array.from(c.an.name).length * (fs + 2.5) + 10) / 2, hh = fs * 0.8;
      if (inUI(c.sx, c.sy)) continue;
      // 同名路：屏幕上至少相隔 260 px
      const same = lastByName.get(c.an.ni);
      if (same && same.some((o) => Math.hypot(o.sx - c.sx, o.sy - c.sy) < 260)) continue;
      const ca = Math.cos(c.ang), sa = Math.sin(c.ang);
      c.box = { x: c.sx, y: c.sy, ux: ca, uy: sa, hw, hh };
      let hit = false;
      for (const o of acc) if (obbOverlap(c.box, o.box)) { hit = true; break; }
      if (hit) continue;
      acc.push(c);
      if (!same) lastByName.set(c.an.ni, [c]);
      else same.push(c);
    }
    for (let i = 0; i < acc.length; i++) {
      const c = acc[i];
      const el = this._el(i);
      if (el._text !== c.an.name) {
        el.textContent = c.an.name;
        el._text = c.an.name;
      }
      if (el._tier !== c.an.tier) {
        el.className = 'rname rname-t' + c.an.tier;
        el._tier = c.an.tier;
      }
      el.style.transform = `translate(${c.sx.toFixed(1)}px, ${c.sy.toFixed(1)}px) rotate(${c.ang.toFixed(3)}rad) translate(-50%, -50%)`;
      el.style.opacity = c.fade.toFixed(2);
      if (el.style.display) el.style.display = '';
    }
    for (let i = acc.length; i < this.used; i++) this.pool[i].style.display = 'none';
    this.used = acc.length;
    this.shown = acc.length;
  }
}

// 两个旋转矩形（中心 x,y；单位方向 ux,uy；半宽 hw、半高 hh）分离轴检测，留 4 px 间隙
function obbOverlap(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const axes = [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]];
  for (const [ax, ay] of axes) {
    const ra = (a.hw + 4) * Math.abs(a.ux * ax + a.uy * ay) + (a.hh + 3) * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = (b.hw + 4) * Math.abs(b.ux * ax + b.uy * ay) + (b.hh + 3) * Math.abs(-b.uy * ax + b.ux * ay);
    if (Math.abs(dx * ax + dy * ay) > ra + rb) return false;
  }
  return true;
}
