// 浮动地名标注（DOM 叠加层，按距离淡入淡出）
//
// 三套标注（地名/地标 Labels、路名 RoadNames、小区名 Estates）共用一张屏幕占用表 LabelSpace：
//   每 2 帧由 main.js 依次调用 space.begin() → 地名 → 路名 → 小区名，先放的先占位，后放的只能放在空位里；
//   同一名称全屏只出现一次；按相机离地高度整体限量（人眼高度 ≤ 8 个）；界面面板所在区域不放标注（按实际 DOM 位置）。
// 视线遮挡：occ(ax,ay,az,bx,by,bz) 由 main.js 注入（通用建筑真实轮廓 + 精建模块遮挡体，见 core/occluders.js）。
import * as THREE from 'three';

const _p = new THREE.Vector3();
// 近地时（人眼高度/低空）收紧显示距离：楼群会挡住远处地名，不收紧就会在地平线上堆满标签。
// 地标/片区名保留更远距离（高出楼顶、本来就该远看），其余类别按离地高度缩放。
const FAR_CATS = new Set(['landmark', 'district', 'admin', 'airport']);
const _vs = new THREE.Vector3();
/** 点是否在相机前方（视空间 z < 0）。反向深度缓冲下投影后的 NDC z 不能用来判断“在相机后方”，否则背后的标注会被镜像投到画面上 */
export function inFront(camera, x, y, z, near = 0.5) {
  _vs.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  return _vs.z < -near;
}
export function aglScale(camera, far = false) {
  const agl = camera.userData.agl ?? 300;
  const k = Math.min(1, Math.max(0, (agl - 2) / 220));
  return far ? 0.45 + 0.55 * k : 0.18 + 0.82 * k;
}
/** 视线遮挡检查（带缓存）：obj 上记录上次结果，相机移动 >4 m、超过 15 帧或遮挡体数据更新才重算 */
export function occludedCached(obj, occ, cp, x, y, z, frame, ver = 0, m1 = undefined) {
  if (!occ) return false;
  const c = obj._occ;
  if (c && c.ver === ver && frame - c.f < 15 && Math.abs(c.x - cp.x) + Math.abs(c.y - cp.y) + Math.abs(c.z - cp.z) < 4) return c.v;
  const v = !!occ(cp.x, cp.y, cp.z, x, y, z, m1);
  obj._occ = { f: frame, x: cp.x, y: cp.y, z: cp.z, v, ver };
  return v;
}

// 两个旋转矩形（中心 x,y；单位方向 ux,uy；半宽 hw、半高 hh）分离轴检测，留 gx/gy px 间隙
export function obbOverlap(a, b, gx = 4, gy = 3) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const axes = [[a.ux, a.uy], [-a.uy, a.ux], [b.ux, b.uy], [-b.uy, b.ux]];
  for (const [ax, ay] of axes) {
    const ra = (a.hw + gx) * Math.abs(a.ux * ax + a.uy * ay) + (a.hh + gy) * Math.abs(-a.uy * ax + a.ux * ay);
    const rb = (b.hw + gx) * Math.abs(b.ux * ax + b.uy * ay) + (b.hh + gy) * Math.abs(-b.uy * ax + b.ux * ay);
    if (Math.abs(dx * ax + dy * ay) > ra + rb) return false;
  }
  return true;
}

const GCELL = 96;
/**
 * 屏幕占用表（三套标注共用）。box：{x, y, ux, uy, hw, hh}（中心、方向、半宽半高，像素）
 */
export class LabelSpace {
  constructor() {
    this.cells = new Map();
    this.names = new Set();
    this.ui = [];
    this._uiAt = -1e9;
    this.count = 0;
    this.budget = Infinity;
    this.caps = { labels: 110, roads: 44, estates: 60 };
    this.frame = 0;
    this.agl = 300;
    this.w = 1;
    this.h = 1;
  }

  /** 每轮开始：清空占用；按离地高度定总量与各类上限；必要时重读界面面板位置 */
  begin(camera, w, h) {
    this.frame++;
    this.cells.clear();
    this.names.clear();
    this.count = 0;
    const agl = (this.agl = camera.userData.agl ?? 300);
    // 人眼高度 ≤ 8 个；低空 ≤ 12；中空 ≤ 24；高空按屏幕面积
    if (agl < 12) (this.budget = 8), (this.caps = { labels: 4, roads: 4, estates: 1 });
    else if (agl < 40) (this.budget = 12), (this.caps = { labels: 6, roads: 5, estates: 2 });
    else if (agl < 150) (this.budget = 24), (this.caps = { labels: 12, roads: 10, estates: 6 });
    else if (agl < 600) (this.budget = 60), (this.caps = { labels: 30, roads: 24, estates: 16 });
    else (this.budget = 160), (this.caps = { labels: Math.min(110, Math.max(48, Math.floor((w * h) / 14000))), roads: 44, estates: 60 });
    if (w !== this.w || h !== this.h || this.frame - this._uiAt > 20) this._readUI(w, h);
    this.w = w;
    this.h = h;
  }

  /** 界面面板（信息栏、控制面板、时讯卡片、小地图、底部提示、版权栏）的屏幕矩形 */
  _readUI() {
    this._uiAt = this.frame;
    this.ui.length = 0;
    if (typeof document === 'undefined') return;
    for (const el of document.querySelectorAll('#app > .panel, #app > .hints, #app > .attrib')) {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) this.ui.push([r.left - 6, r.top - 6, r.right + 6, r.bottom + 6]);
    }
  }

  get full() {
    return this.count >= this.budget;
  }

  /** box 是否可放（不出屏、不压界面、不与已放标注重叠） */
  fits(b, margin = 4) {
    const ex = Math.abs(b.ux) * b.hw + Math.abs(b.uy) * b.hh, ey = Math.abs(b.uy) * b.hw + Math.abs(b.ux) * b.hh;
    const x0 = b.x - ex, x1 = b.x + ex, y0 = b.y - ey, y1 = b.y + ey;
    if (x0 < margin || y0 < margin || x1 > this.w - margin || y1 > this.h - margin) return false;
    for (const r of this.ui) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return false;
    const gx0 = Math.floor((x0 - 8) / GCELL), gx1 = Math.floor((x1 + 8) / GCELL);
    const gy0 = Math.floor((y0 - 8) / GCELL), gy1 = Math.floor((y1 + 8) / GCELL);
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const l = this.cells.get(gx * 4096 + gy);
        if (l) for (const o of l) if (obbOverlap(b, o, 6, 4)) return false;
      }
    return true;
  }

  add(b, name) {
    const ex = Math.abs(b.ux) * b.hw + Math.abs(b.uy) * b.hh, ey = Math.abs(b.uy) * b.hw + Math.abs(b.ux) * b.hh;
    const gx0 = Math.floor((b.x - ex) / GCELL), gx1 = Math.floor((b.x + ex) / GCELL);
    const gy0 = Math.floor((b.y - ey) / GCELL), gy1 = Math.floor((b.y + ey) / GCELL);
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = gx * 4096 + gy;
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(b);
      }
    if (name) this.names.add(name);
    this.count++;
  }
}

const CATEGORY_WEIGHT = { landmark: 5, airport: 4, admin: 3.5, district: 3, biz: 2.5, station: 2, metro: 2, town: 1, street: 1 };

export class Labels {
  constructor(container) {
    this.root = document.createElement('div');
    this.root.className = 'labels';
    container.appendChild(this.root);
    this.items = [];
    this.visible = true;
    this.hidden = new Set();
    /** 视线遮挡函数 (ax,ay,az,bx,by,bz) → bool，由 main.js 注入 */
    this.occ = null;
    /** 遮挡数据版本（遮挡体栅格化有新数据时变化，令缓存失效） */
    this.occVersion = () => 0;
    /** 在 LabelSpace 中用哪一类上限：labels | estates */
    this.capKey = 'labels';
    /** 地面高度 (x,z) → y，由 main.js 注入；用于把遮挡检测点从“悬浮锚点”降到物体顶部附近 */
    this.groundAt = null;
    this._frame = 0;
    this._own = new LabelSpace();
  }

  /**
   * text: 名称；pos: 世界坐标 Vector3；opts: {category, minDist, maxDist, priority, sub}
   * category: landmark | district | airport | station | street
   */
  add(text, pos, opts = {}) {
    const el = document.createElement('div');
    el.className = `label label-${opts.category || 'landmark'}`;
    el.innerHTML = `<span class="label-dot"></span><span class="label-text">${text}</span>${opts.sub ? `<span class="label-sub">${opts.sub}</span>` : ''}`;
    el.style.display = 'none'; // 首次通过碰撞检测后才显示
    this.root.appendChild(el);
    const it = {
      text,
      el,
      pos: pos.clone(),
      category: opts.category || 'landmark',
      minDist: opts.minDist ?? 60,
      maxDist: opts.maxDist ?? 12000,
      priority: opts.priority ?? 1,
      labelWidth: Math.min(300, Math.max(56, 18 + Array.from(text).length * (opts.category === 'district' ? 15 : opts.category === 'admin' ? 20 : opts.category === 'town' || opts.category === 'metro' ? 11 : 13))),
      labelHeight: opts.sub ? 48 : opts.category === 'district' ? 42 : 38,
      shown: false,
    };
    this.items.push(it);
    return it;
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
    if (!v) for (const it of this.items) if (it.shown) (it.el.style.display = 'none'), (it.shown = false);
  }

  /** space：共用的屏幕占用表（由调用方每轮 begin）；不传时自用一张并隔帧更新 */
  update(camera, w, h, space = null) {
    if (!this.visible) return;
    if (!space) {
      if (++this._frame % 2) return;
      space = this._own;
      space.begin(camera, w, h);
    } else this._frame++;
    const cp = camera.position;
    const candidates = [];
    const kNear = aglScale(camera, false), kFar = aglScale(camera, true);
    const cap = space.caps[this.capKey] ?? 60;
    for (const it of this.items) {
      const d = it.pos.distanceTo(cp);
      const maxD = it.maxDist * (FAR_CATS.has(it.category) ? kFar : kNear);
      let show = !this.hidden.has(it.category) && d > it.minDist && d < maxD;
      if (show && !inFront(camera, it.pos.x, it.pos.y, it.pos.z)) show = false;
      if (show) {
        _p.copy(it.pos).project(camera);
        if (Math.abs(_p.x) > 1.05 || Math.abs(_p.y) > 1.05) show = false;
      }
      if (show) {
        const x = (_p.x * 0.5 + 0.5) * w;
        const y = (-_p.y * 0.5 + 0.5) * h;
        const fade = Math.min(1, (maxD - d) / (maxD * 0.25), (d - it.minDist) / 40);
        if (fade > 0.08) candidates.push({ it, d, x, y, fade,
          score: it.priority * 100 + (CATEGORY_WEIGHT[it.category] || 0) * 10 - d * 0.001 });
      }
    }

    // 高优先级地标先占位；与路名、小区名共用屏幕占用表，互不压字
    candidates.sort((a, b) => b.score - a.score || a.d - b.d);
    const accepted = new Set();
    const ver = this.occVersion();
    let checks = 0;
    for (const c of candidates) {
      if (accepted.size >= cap || space.full) break;
      const { it, x, y, fade, d } = c;
      if (space.names.has(it.text)) continue;
      const box = { x, y: y - it.labelHeight / 2 + 1, ux: 1, uy: 0, hw: it.labelWidth / 2, hh: it.labelHeight / 2 };
      if (!space.fits(box)) continue;
      // 被建筑/城墙/城楼等挡住的不显示（锚点本身所在物体由 occ 的终点留空处理）；每轮最多新算 40 次
      if (this.occ) {
        const cached = it._occ && it._occ.ver === ver && this._frame - it._occ.f < 15 &&
          Math.abs(it._occ.x - cp.x) + Math.abs(it._occ.y - cp.y) + Math.abs(it._occ.z - cp.z) < 4;
        if (!cached && checks++ > 40) { if (!it.shown) continue; }
        else {
          // 检测点：锚点一般悬在物体顶上 6~10 m（如档案建筑 top+8），降 8 m 到物体顶部附近再看是否被挡，
          // 否则城墙后面的小庙、小区，标注会越过墙头“浮”出来；大型地标（城门群、园区）终点留更长的空段，避免被自身前部挡住
          if (it.occY == null) {
            const g = this.groundAt ? this.groundAt(it.pos.x, it.pos.z) : it.pos.y - 20;
            it.occY = Math.max(it.pos.y - 8, Math.min(it.pos.y, g + 3));
          }
          const big = it.priority >= 2.4 || it.category === 'district' || it.category === 'admin' || it.category === 'airport';
          const m1 = big ? Math.min(150, Math.max(30, d * 0.2)) : undefined;
          if (occludedCached(it, this.occ, cp, it.pos.x, it.occY, it.pos.z, this._frame, ver, m1)) continue;
        }
      }
      space.add(box, it.text);
      accepted.add(it);
      it.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      it.el.style.opacity = Math.max(0, fade).toFixed(2);
      it.el.style.zIndex = String(Math.round(100000 - d));
    }
    for (const it of this.items) {
      const show = accepted.has(it);
      if (show !== it.shown) {
        it.el.style.display = show ? '' : 'none';
        it.shown = show;
      }
    }
    this.shown = accepted.size;
  }
}
