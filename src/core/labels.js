// 浮动地名标注（DOM 叠加层，按距离淡入淡出）
import * as THREE from 'three';

const _p = new THREE.Vector3();
const CELL = 84;
const CATEGORY_WEIGHT = { landmark: 5, airport: 4, district: 3, station: 2, street: 1 };

export class Labels {
  constructor(container) {
    this.root = document.createElement('div');
    this.root.className = 'labels';
    container.appendChild(this.root);
    this.items = [];
    this.visible = true;
    this.hidden = new Set();
    this._frame = 0;
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
      labelWidth: Math.min(300, Math.max(56, 18 + Array.from(text).length * (opts.category === 'district' ? 15 : 13))),
      labelHeight: opts.sub ? 48 : opts.category === 'district' ? 42 : 38,
      shown: false,
    };
    this.items.push(it);
    return it;
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  update(camera, w, h) {
    if (!this.visible) return;
    if (++this._frame % 2) return;
    const cp = camera.position;
    const candidates = [];
    for (const it of this.items) {
      const d = it.pos.distanceTo(cp);
      let show = !this.hidden.has(it.category) && d > it.minDist && d < it.maxDist;
      if (show) {
        _p.copy(it.pos).project(camera);
        if (_p.z > 1 || _p.z < -1 || Math.abs(_p.x) > 1.05 || Math.abs(_p.y) > 1.05) show = false;
      }
      if (show) {
        const x = (_p.x * 0.5 + 0.5) * w;
        const y = (-_p.y * 0.5 + 0.5) * h;
        const fade = Math.min(1, (it.maxDist - d) / (it.maxDist * 0.25), (d - it.minDist) / 40);
        if (fade > 0.08) candidates.push({ it, d, x, y, fade,
          score: it.priority * 100 + (CATEGORY_WEIGHT[it.category] || 0) * 10 - d * 0.001 });
      }
    }

    // 高优先级地标先占位；屏幕网格碰撞检测避免城区地名互相遮挡。
    candidates.sort((a, b) => b.score - a.score || a.d - b.d);
    const occupied = new Map();
    const accepted = new Set();
    const maxVisible = Math.min(110, Math.max(48, Math.floor((w * h) / 14000)));
    const overlaps = (a, b) => a.x0 < b.x1 + 8 && a.x1 + 8 > b.x0 && a.y0 < b.y1 + 6 && a.y1 + 6 > b.y0;
    for (const c of candidates) {
      if (accepted.size >= maxVisible) break;
      const { it, x, y, fade, d } = c;
      const box = { x0: x - it.labelWidth / 2, x1: x + it.labelWidth / 2, y0: y - it.labelHeight, y1: y + 2 };
      if (box.x0 < 4 || box.x1 > w - 4 || box.y0 < 4 || box.y1 > h - 4) continue;
      // 留出信息栏、控制面板、小地图和底部操作提示区域。
      if ((box.x0 < 292 && box.y0 < 202) || box.x1 > w - 322 ||
          (box.x0 < 224 && box.y1 > h - 214) || (box.y1 > h - 62 && box.x1 > 250 && box.x0 < w - 320)) continue;
      const gx0 = Math.floor(box.x0 / CELL), gx1 = Math.floor(box.x1 / CELL);
      const gy0 = Math.floor(box.y0 / CELL), gy1 = Math.floor(box.y1 / CELL);
      let collision = false;
      for (let gy = gy0; gy <= gy1 && !collision; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const cell = occupied.get(`${gx}:${gy}`);
        if (cell && cell.some((other) => overlaps(box, other))) { collision = true; break; }
      }
      if (collision) continue;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const key = `${gx}:${gy}`;
        if (!occupied.has(key)) occupied.set(key, []);
        occupied.get(key).push(box);
      }
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
  }
}
