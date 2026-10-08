// 地铁透视俯视叠加层（X）：
//   · 线网：每条线把上下行两条轨道合成一条中心线（分岔隧道如安定门处不再画成“眼睛”闭环），只有远离主线的支段单独画；
//   · 车站圆点吸附到所属线路中心线（换乘站取两线交点），同名/同址重复站已在 metro.js 合并；
//   · 绘制：独立的 2D 画布叠在 WebGL 画布之上（压暗城市 + 线网 + 车站点），不经过泛光与色调映射，
//     各线粗细一致、颜色就是官方线路色，白天夜里一个样。
import * as THREE from 'three';

/** 线段空间索引（200 m 格网） */
class SegIndex {
  constructor(polys, cell = 200) {
    this.cell = cell;
    this.grid = new Map();
    this.polys = polys;
    polys.forEach((p, pi) => {
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i];
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const z0 = Math.floor(Math.min(a[1], b[1]) / cell), z1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
          const k = cx * 100003 + cz;
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(pi, i);
        }
      }
    });
  }
  /** 最近点（maxD 之内），返回 {x, z, d, pi, i, t} 或 null */
  nearest(x, z, maxD) {
    const c = this.cell, r = Math.ceil(maxD / c);
    const cx = Math.floor(x / c), cz = Math.floor(z / c);
    let best = null, bd = maxD;
    for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) {
      const arr = this.grid.get(i * 100003 + j);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k += 2) {
        const p = this.polys[arr[k]], s = arr[k + 1];
        const a = p[s - 1], b = p[s];
        const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
        const px = a[0] + ex * t, pz = a[1] + ez * t, d = Math.hypot(px - x, pz - z);
        if (d < bd) { bd = d; best = { x: px, z: pz, d, pi: arr[k], i: s, t }; }
      }
    }
    return best;
  }
  /** 范围内所有线段（去重） */
  segsNear(x, z, R) {
    const c = this.cell, r = Math.ceil(R / c), cx = Math.floor(x / c), cz = Math.floor(z / c);
    const seen = new Set(), out = [];
    for (let i = cx - r; i <= cx + r; i++) for (let j = cz - r; j <= cz + r; j++) {
      const arr = this.grid.get(i * 100003 + j);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k += 2) {
        const key = arr[k] * 1e6 + arr[k + 1];
        if (seen.has(key)) continue;
        seen.add(key);
        const p = this.polys[arr[k]];
        out.push([p[arr[k + 1] - 1], p[arr[k + 1]]]);
      }
    }
    return out;
  }
}

const plen = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; };
function resample(p, step) {
  const out = [];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) { const t = k / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, t < 0.5 ? a[2] : b[2]]); }
  }
  out.push(p[p.length - 1].slice());
  return out;
}
/** Douglas-Peucker 抽稀 */
function dp(p, tol) {
  if (p.length < 3) return p.slice();
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const st = [[0, p.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const A = p[a], B = p[b], ex = B[0] - A[0], ez = B[1] - A[1], L = Math.hypot(ex, ez) || 1;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((p[i][0] - A[0]) * ez - (p[i][1] - A[1]) * ex) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return p.filter((_, i) => keep[i]);
}
/** 抽稀（地下/地面分段处保留，实线/虚线边界不移位） */
function simplify(p, tol) {
  const out = [];
  let s = 0;
  for (let i = 1; i <= p.length; i++) {
    if (i === p.length || (p[i][2] > 0) !== (p[i - 1][2] > 0)) {
      for (const q of dp(p.slice(s, i), tol)) out.push(q);
      s = i;
    }
  }
  return out;
}

/** 一条线的透视中心线：最长的一条轨道与其余轨道（220 m 内，安定门处上下行绕城门分开约 135 m）取中线；远离主线（>240 m）的部分单独成段。点为 [x, z, d] */
export function lineCenterRuns(L) {
  const P = L.paths.map((f) => { const p = []; for (let i = 0; i + 2 < f.length; i += 3) p.push([f[i], f[i + 1], f[i + 2]]); return p; })
    .filter((p) => p.length >= 2).sort((a, b) => plen(b) - plen(a));
  if (!P.length) return [];
  const main = resample(P[0], 25);
  const others = P.slice(1).filter((p) => plen(p) > 40);
  const idxO = others.length ? new SegIndex(others) : null;
  const center = main.map(([x, z, d]) => {
    const q = idxO && idxO.nearest(x, z, 220);
    return q ? [(x + q.x) / 2, (z + q.z) / 2, d] : [x, z, d];
  });
  // 中线再做一次 3 点平滑（两条轨道顶点不对齐时的锯齿）
  const sm = center.map((p, i) => (i === 0 || i === center.length - 1 ? p : [(center[i - 1][0] + 2 * p[0] + center[i + 1][0]) / 4, (center[i - 1][1] + 2 * p[1] + center[i + 1][1]) / 4, p[2]]));
  const runs = [simplify(sm, 2.5)];
  const idxM = new SegIndex([main]);
  for (const o of others) {
    const oo = resample(o, 25);
    let run = [], prev = null;
    for (const p of oo) {
      const q = idxM.nearest(p[0], p[1], 240);
      if (!q) {
        if (!run.length && prev) run.push(prev);
        run.push(p);
      } else {
        if (run.length) { run.push([q.x, q.z, p[2]]); if (plen(run) > 150) runs.push(simplify(run, 2.5)); run = []; }
        prev = [q.x, q.z, p[2]];
      }
    }
    if (run.length >= 2 && plen(run) > 150) runs.push(simplify(run, 2.5));
  }
  return runs;
}

/** 两条线段交点 */
function segX(a, b, c, d) {
  const r1 = b[0] - a[0], r2 = b[1] - a[1], s1 = d[0] - c[0], s2 = d[1] - c[1];
  const den = r1 * s2 - r2 * s1;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s2 - (c[1] - a[1]) * s1) / den, u = ((c[0] - a[0]) * r2 - (c[1] - a[1]) * r1) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + r1 * t, a[1] + r2 * t];
}

/**
 * 透视数据：每条线的中心线 + 每站在线网上的位置。
 * lines：metro.json 的线路；stations：已去重的车站；返回 {runs:[{num,color,runs}], pos: Map(station → [x, z])}
 */
export function buildXrayData(lines, stations) {
  const out = [], idx = new Map();
  for (const L of lines) {
    const runs = lineCenterRuns(L);
    if (!runs.length) continue;
    out.push({ num: L.num, color: L.color, runs });
    idx.set(L.num, new SegIndex(runs));
  }
  const pos = new Map();
  for (const s of stations) {
    const nums = [...new Set(s.lines.map((l) => l.num))].filter((n) => idx.has(n));
    const near = nums.map((n) => idx.get(n).nearest(s.x, s.z, 450)).filter(Boolean);
    if (!near.length) { pos.set(s, [s.x, s.z]); continue; }
    if (nums.length === 1 || near.length === 1) { pos.set(s, [near[0].x, near[0].z]); continue; }
    // 换乘站：两两求中心线交点（站点 450 m 内），取离各线最近点均值最近的那个
    const mx = near.reduce((a, q) => a + q.x, 0) / near.length, mz = near.reduce((a, q) => a + q.z, 0) / near.length;
    const xs = [];
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) {
      const A = idx.get(nums[i]).segsNear(mx, mz, 450), B = idx.get(nums[j]).segsNear(mx, mz, 450);
      let best = null, bd = 450;
      for (const [a, b] of A) for (const [c, d] of B) {
        const p = segX(a, b, c, d);
        if (p) { const dd = Math.hypot(p[0] - mx, p[1] - mz); if (dd < bd) { bd = dd; best = p; } }
      }
      if (best) xs.push(best);
    }
    pos.set(s, xs.length ? [xs.reduce((a, p) => a + p[0], 0) / xs.length, xs.reduce((a, p) => a + p[1], 0) / xs.length] : [mx, mz]);
  }
  return { lines: out, pos };
}

/** 2D 叠加画布 */
export class XrayOverlay {
  /** after：插在该元素之后（WebGL 画布）；data：buildXrayData 结果；H：地面高程函数；stations：车站数组 */
  constructor(after, data, H, stations) {
    const cv = document.createElement('canvas');
    cv.className = 'metro-xray';
    Object.assign(cv.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '3', display: 'none' });
    after.after(cv);
    this.cv = cv;
    this.g = cv.getContext('2d');
    this.visible = false;
    this._key = '';
    this._M = new THREE.Matrix4();
    // 世界坐标（含高程）预先算好
    this.lines = data.lines.map((L) => ({
      color: L.color,
      runs: L.runs.map((r) => {
        const xyz = new Float64Array(r.length * 3), under = new Uint8Array(r.length);
        r.forEach((p, i) => { xyz[i * 3] = p[0]; xyz[i * 3 + 1] = H(p[0], p[1]) + 4; xyz[i * 3 + 2] = p[1]; under[i] = p[2] > 0 ? 1 : 0; });
        return { xyz, under, n: r.length };
      }),
    }));
    this.dots = stations.map((s) => {
      const [x, z] = data.pos.get(s) || [s.x, s.z];
      const nums = [...new Set(s.lines.map((l) => l.num))];
      return { x, y: H(x, z) + 4, z, transfer: nums.length > 1, color: data.lines.find((L) => L.num === nums[0])?.color || '#9aa4b0' };
    });
  }
  setVisible(v) {
    this.visible = v;
    this.cv.style.display = v ? '' : 'none';
    this._key = '';
  }
  draw(camera) {
    if (!this.visible) return;
    const cv = this.cv, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); this._key = ''; }
    const M = this._M.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), e = M.elements;
    const key = e.map((v) => v.toFixed(4)).join(',') + w + 'x' + h;
    if (key === this._key) return;
    this._key = key;
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(3,7,16,0.62)';
    g.fillRect(0, 0, w, h);
    const EPS = 1;
    const sx = (cx, cw) => (cx / cw * 0.5 + 0.5) * w, sy = (cy, cw) => (-cy / cw * 0.5 + 0.5) * h;
    const agl = Math.max(50, camera.userData.agl ?? 9000);
    const lw = THREE.MathUtils.clamp(2.6 + 9000 / agl, 3.2, 7);
    // 路径：按段的地下/地面分成实线、虚线两组
    const paths = this.lines.map((L) => {
      const solid = new Path2D(), dash = new Path2D();
      for (const r of L.runs) {
        const { xyz, under, n } = r;
        let pcx = 0, pcy = 0, pcw = 0;
        for (let i = 0; i < n; i++) {
          const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
          const cx = e[0] * x + e[4] * y + e[8] * z + e[12], cy = e[1] * x + e[5] * y + e[9] * z + e[13], cw = e[3] * x + e[7] * y + e[11] * z + e[15];
          if (i > 0 && (cw > EPS || pcw > EPS)) {
            let ax = pcx, ay = pcy, aw = pcw, bx = cx, by = cy, bw = cw;
            if (aw <= EPS) { const t = (EPS - aw) / (bw - aw); ax += (bx - ax) * t; ay += (by - ay) * t; aw = EPS; }
            if (bw <= EPS) { const t = (EPS - bw) / (aw - bw); bx += (ax - bx) * t; by += (ay - by) * t; bw = EPS; }
            const P = under[i] && under[i - 1] ? solid : dash;
            P.moveTo(sx(ax, aw), sy(ay, aw));
            P.lineTo(sx(bx, bw), sy(by, bw));
          }
          pcx = cx; pcy = cy; pcw = cw;
        }
      }
      return { solid, dash, color: L.color };
    });
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // 深色描边打底，再画线路色
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = lw + 3;
    g.setLineDash([]);
    for (const p of paths) { g.stroke(p.solid); g.stroke(p.dash); }
    for (const p of paths) {
      g.strokeStyle = p.color;
      g.lineWidth = lw;
      g.setLineDash([]);
      g.stroke(p.solid);
      g.setLineDash([lw * 2.2, lw * 1.6]);
      g.stroke(p.dash);
    }
    g.setLineDash([]);
    // 车站点
    for (const d of this.dots) {
      const cw = e[3] * d.x + e[7] * d.y + e[11] * d.z + e[15];
      if (cw <= EPS) continue;
      const X = sx(e[0] * d.x + e[4] * d.y + e[8] * d.z + e[12], cw), Yp = sy(e[1] * d.x + e[5] * d.y + e[9] * d.z + e[13], cw);
      if (X < -20 || X > w + 20 || Yp < -20 || Yp > h + 20) continue;
      g.beginPath();
      if (d.transfer) {
        g.arc(X, Yp, lw * 0.9 + 3, 0, Math.PI * 2);
        g.fillStyle = '#ffffff';
        g.fill();
        g.lineWidth = 2.2;
        g.strokeStyle = '#0d1424';
      } else {
        g.arc(X, Yp, lw * 0.55 + 1.6, 0, Math.PI * 2);
        g.fillStyle = '#ffffff';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = d.color;
      }
      g.stroke();
    }
  }
  dispose() { this.cv.remove(); }
}
