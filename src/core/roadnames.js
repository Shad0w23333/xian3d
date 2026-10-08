// 路名标注：沿道路走向旋转的 DOM 文字（离近了才出现），同名路段合并去重，只处理相机附近的锚点。
//
//   · 预处理：roads.json 中有名称的路段按长度从长到短，每隔 spacing 米取一个锚点（短路段取中点），
//     同名锚点在 0.75×spacing 半径内去重（双向分幅道路/多段同名道路只留一个）；急弯处不放
//   · 显示距离（相机到锚点的三维距离）：高速/快速/主干道 1.5 km，次干道 1.15 km，支路 900 m，街巷/匝道 650 m
//   · 每 2 帧：查询相机附近网格 → 投影 → 屏幕上的道路方向角（文字始终正读，不倒置）→ 按等级/距离排序
//     → 与地名、小区名共用屏幕占用表（LabelSpace，旋转矩形碰撞）+ 同名全屏只留一个 → 复用 DOM 节点池
//   · 道路模块不画的路段（排除区 roads=true：步行街、档案建筑/下沉广场内部）不显示机动车路名；
//     步行街排除区改为沿街显示步行街名（如“大唐不夜城步行街”）
import * as THREE from 'three';
import { roadY } from './roadheight.js';
import { aglScale, occludedCached, inFront, LabelSpace } from './labels.js';

const CELL = 300;
// 等级：0 高速/快速/主干 1 次干道 2 支路 3 街巷/匝道/步行街
const TIER_OF_CLASS = [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3];
const TIER_MAXD = [1500, 1150, 900, 650];
const TIER_SPACING = [420, 340, 260, 200];
const TIER_FONT = [15, 14, 13, 12];
// 排除区名称 → 显示的步行街名
const WALK_ALIAS = [[/不夜城步行街/, '大唐不夜城步行街']];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class RoadNames {
  /** container：DOM 父节点；roads：roads.json；terrain：地形（heightAt）；exclusions：排除区（可选） */
  constructor(container, roads, terrain, exclusions = null) {
    this.root = document.createElement('div');
    this.root.className = 'rnames';
    container.appendChild(this.root);
    this.visible = true;
    /** 视线遮挡函数，由 thematic.js 注入（建筑模块的 occluded） */
    this.occ = null;
    this.occVersion = () => 0;
    this._own = new LabelSpace();
    this.pool = [];
    this.used = 0;
    this._frame = 0;
    this.grid = new Map();
    this.anchors = [];
    const t0 = performance.now();
    this._noRoad = (exclusions?.items || []).filter((it) => it.flags && it.flags.roads);
    this._build(roads, terrain);
    this._walkStreets(terrain);
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
        if (this._inNoRoad(x, z)) continue; // 道路模块不画的路段（步行街 / 楼内 / 下沉广场）
        const y = roadY(terrain, f, x, z, s, L) ?? terrain.heightAt(x, z);
        let ni = nameIdx.get(f.n);
        if (ni == null) {
          ni = this.names.length;
          nameIdx.set(f.n, ni);
          this.names.push(f.n);
        }
        mark(f.n, x, z);
        this._push({ x, y: y + 1.2, z, dx, dz, tier, name: f.n, ni, bi: this._baseIdx(f.n) });
      }
    }
    this._nameIdx = nameIdx;
  }

  /** 路名主干（去掉“东段/西段/辅路”等后缀）的编号：中低空时同一主干全屏只标一次（“环城北路”“环城北路西段”不交替重复） */
  _baseIdx(name) {
    if (!this._bases) this._bases = new Map();
    const b = name.replace(/(?:[东西南北中]段)?(?:辅路)?$/, '') || name;
    let i = this._bases.get(b);
    if (i == null) this._bases.set(b, (i = this._bases.size));
    return i;
  }

  _push(an) {
    this.anchors.push(an);
    const key = Math.floor(an.x / CELL) * 100003 + Math.floor(an.z / CELL);
    let a = this.grid.get(key);
    if (!a) this.grid.set(key, (a = []));
    a.push(an);
  }

  _inNoRoad(x, z) {
    for (const it of this._noRoad) {
      const b = it.bb;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const p = it.p;
      let c = false;
      for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
        if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
      }
      if (c) return true;
    }
    return false;
  }

  /** 步行街排除区：沿长轴每 260 m 放一个步行街名锚点（方向 = 排除区长轴） */
  _walkStreets(terrain) {
    for (const it of this._noRoad) {
      const alias = WALK_ALIAS.find(([re]) => re.test(it.name || ''));
      if (!alias) continue;
      const b = it.bb;
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      const alongZ = d >= w;
      const L = alongZ ? d : w;
      const name = alias[1];
      let ni = this._nameIdx.get(name);
      if (ni == null) {
        ni = this.names.length;
        this._nameIdx.set(name, ni);
        this.names.push(name);
      }
      const n = Math.max(1, Math.round(L / 260));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = alongZ ? (b.x0 + b.x1) / 2 : b.x0 + w * t;
        const z = alongZ ? b.z0 + d * t : (b.z0 + b.z1) / 2;
        this._push({ x, y: terrain.heightAt(x, z) + 1.2, z, dx: alongZ ? 0 : 1, dz: alongZ ? 1 : 0, tier: 2, name, ni, bi: this._baseIdx(name), walk: true });
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

  /** space：与地名/小区名共用的屏幕占用表（调用方每轮 begin）；不传时自用一张并隔帧更新 */
  update(camera, w, h, space = null) {
    if (!this.visible) return;
    if (!space) {
      if (++this._frame % 2) return;
      space = this._own;
      space.begin(camera, w, h);
    } else this._frame++;
    const cp = camera.position;
    const agl = camera.userData.agl ?? 300;
    const kD = aglScale(camera, false);
    // 人眼高度/低空：锚点抬到离路面约 4.5 m（不压在车顶上），只看近处
    const lift = agl < 30 ? 3.3 : 0;
    const R = TIER_MAXD[0] * kD;
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
          const ay = an.y + lift;
          const d = Math.hypot(an.x - cp.x, ay - cp.y, an.z - cp.z);
          const maxD = TIER_MAXD[an.tier] * kD;
          if (d > maxD) continue;
          if (!inFront(camera, an.x, ay, an.z)) continue;
          _a.set(an.x, ay, an.z).project(camera);
          if (Math.abs(_a.x) > 1 || Math.abs(_a.y) > 1) continue;
          const sx = (_a.x * 0.5 + 0.5) * w, sy = (-_a.y * 0.5 + 0.5) * h;
          const step = Math.max(4, d * 0.02);
          _b.set(an.x + an.dx * step, ay, an.z + an.dz * step).project(camera);
          let ex = (_b.x * 0.5 + 0.5) * w - sx, ey = (-_b.y * 0.5 + 0.5) * h - sy;
          const lenAlong = Math.hypot(ex, ey);
          _b.set(an.x + rx * step, ay + ry * step, an.z + rz * step).project(camera);
          const lenRef = Math.hypot((_b.x * 0.5 + 0.5) * w - sx, (-_b.y * 0.5 + 0.5) * h - sy) || 1;
          let ang;
          // 道路几乎沿视线方向：人眼高度时文字正放；高处俯看时仍沿道路在屏幕上的走向（竖排感，从下往上读）
          if (lenAlong < 0.5 || (lenAlong / lenRef < 0.3 && agl < 20)) ang = 0;
          else {
            if (ex < 0) (ex = -ex), (ey = -ey); // 始终从左往右读
            ang = Math.atan2(ey, ex);
            if (ang > 1.4) ang -= Math.PI; // 接近竖直时统一成从下往上读
          }
          const fade = Math.min(1, (maxD - d) / (maxD * 0.2));
          cand.push({ an, ay, d, sx, sy, ang, fade, score: an.tier * 10000 + d - (an.walk ? 20000 : 0) });
        }
      }
    cand.sort((a, b) => a.score - b.score);

    const acc = [];
    const cap = space.caps.roads ?? 44;
    const lastByName = new Map();
    const ver = this.occVersion();
    let checks = 0;
    for (const c of cand) {
      if (acc.length >= cap || space.full) break;
      const fs = TIER_FONT[c.an.tier];
      const hw = (Array.from(c.an.name).length * (fs + 2.5) + 10) / 2, hh = fs * 0.8;
      // 同名路：高空时屏幕上至少相隔 420 px；中低空同一主干（含东段/西段/辅路）全屏只留一个；与地名同名的也不重复
      const same = lastByName.get(agl < 400 ? -1 - c.an.bi : c.an.ni);
      if (same && (agl < 400 || same.some((o) => Math.hypot(o.sx - c.sx, o.sy - c.sy) < 420))) continue;
      if (!same && space.names.has(c.an.name)) continue;
      const ca = Math.cos(c.ang), sa = Math.sin(c.ang);
      c.box = { x: c.sx, y: c.sy, ux: ca, uy: sa, hw, hh };
      if (!space.fits(c.box)) continue;
      // 被建筑挡住的路名不显示（锚点抬高 2 m，避免路面本身遮挡判定）；每轮最多新算 40 次
      if (c.d > 30 && this.occ) {
        const o = c.an._occ;
        const cached = o && o.ver === ver && this._frame - o.f < 15 && Math.abs(o.x - cp.x) + Math.abs(o.y - cp.y) + Math.abs(o.z - cp.z) < 4;
        if (!cached && checks++ > 40) continue;
        if (occludedCached(c.an, this.occ, cp, c.an.x, c.ay + 2, c.an.z, this._frame, ver)) continue;
      }
      space.add(c.box, c.an.name);
      acc.push(c);
      if (!same) lastByName.set(agl < 400 ? -1 - c.an.bi : c.an.ni, [c]);
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

