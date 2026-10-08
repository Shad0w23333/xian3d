// 西安地铁地下网络：全部已开通线路的隧道（官方线路色腰线）、车站（站台层 + 站厅层 + 屏蔽门 + 楼梯扶梯 + 站名导向）、
// 出入口通道、按站停靠的列车。两种浏览方式：
//   · 透视俯视（X 键 / 面板勾选）：城市压暗，线网按官方色叠加（独立 2D 画布，不经泛光/色调映射，粗细亮度一致），
//     车站圆点吸附线路中心线，只显示车站标注（含线路色标），其他地名/路名/小区名临时隐藏；再按 X 飞回原视点。
//   · 进入地下（U 键 / 面板按钮）：隐藏地面世界与全部地面标注，传送到最近车站站台中线（两柱之间、面朝站台纵深），
//     步行（G 切飞行）浏览站台、楼梯、站厅、出入口通道、隧道；再按 U 回到进站前的视点与模式，标注恢复原状。
//   地下照明固定：进站时锁定曝光、关闭泛光、去掉天空环境反射，半球光/主光改为站内灯光（受光材质 + 程序化贴图），
//   白天夜里进同一个站明暗一致；出站时恢复。
// 数据：public/data/metro.json（tools/build_metro.py）；载入时合并同名/同址重复站（如“建筑科技大学-李家村/·李家村”）。
// 性能：站体与隧道按需生成，只构建/显示相机附近的车站（约 11 次绘制/站）与 1 km 格隧道段；地面上不产生任何绘制。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import { buildStation, boxFloor, passageFloor, PLAT_H, HALL_L, HALL_W, TRACK_V } from '../arch/metro-station.js';
import { metroMaterials } from '../arch/metro-tex.js';
import { buildXrayData, XrayOverlay } from '../arch/metro-xray.js';

const TUN_STEP = 20;
const TUN_CELL = 1000;     // 隧道分块（米）
const STATION_R = 650;     // 地下时构建/显示的车站半径
const MAX_BUILT = 10;      // 最多缓存的车站数
const EXPOSURE = 0.68;     // 地下固定曝光（再乘画质面板的曝光倍率）

// —— 数据：载入 + 合并重复站 ——
let DATA = null;
function normName(n) {
  return String(n || '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[-－—–]/g, '·')
    .replace(/·?[A-Z]区$/, '')
    .trim();
}
function normalize(D) {
  if (!D || !D.lines?.length) return null;
  const groups = [];
  for (const s of D.stations || []) {
    const key = normName(s.n);
    let g = groups.find((q) => {
      const d = Math.hypot(q.x - s.x, q.z - s.z);
      return (q.key === key && d < 400) || d < 60;
    });
    if (!g) groups.push((g = { key, x: s.x, z: s.z, list: [] }));
    g.list.push(s);
  }
  const labeled = (s) => (s.exits || []).filter((e) => e[2]).length;
  const stations = groups.map((g) => {
    const L = g.list.slice().sort((a, b) => labeled(b) - labeled(a) || (normName(a.n) === a.n ? -1 : 1));
    const P = L[0];
    const name = (L.find((s) => s.n === g.key) || P).n;
    const lines = [], exits = [];
    for (const s of L) {
      for (const l of s.lines) if (!lines.some((q) => q.num === l.num)) lines.push(l);
      for (const e of s.exits || []) if (!exits.some((q) => Math.hypot(q[0] - e[0], q[1] - e[1]) < 3)) exits.push(e);
    }
    // 铁路客站同名站补“站”字（OSM 名为“西安”“西安北”，官方站名为“西安站”“北客站”等，这里只补字不改名）
    const n = /^西安[东南西北]?$/.test(name) ? name + '站' : name;
    return { n, x: P.x, z: P.z, lines, exits, merged: L.length > 1 ? L.map((s) => s.n) : undefined };
  });
  return { ...D, stations };
}
async function getData() {
  if (DATA === null) DATA = normalize(await loadJSON('metro.json', { optional: true })) || false;
  return DATA || null;
}

const c3 = (hex) => new THREE.Color(hex);

/** 列车车厢几何（单节，局部 x 沿车长）：车体/裙板/车门（受光）与车窗灯光（自发光）分开 */
function carGeometry() {
  const body = { p: [], c: [] }, glow = { p: [], c: [] };
  const q = (G, a, b, c, d, col) => { for (const P of [a, b, c, a, c, d]) { G.p.push(...P); G.c.push(col.r, col.g, col.b); } };
  const box = (G, x0, x1, y0, y1, z0, z1, col, top = col) => {
    q(G, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], top);
    q(G, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col);
    q(G, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col);
    q(G, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col);
    q(G, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], col);
  };
  box(body, -9.4, 9.4, 0.35, 0.95, -1.3, 1.3, c3('#3b3e42'));
  box(body, 9.4, 9.8, 1.0, 3.35, -0.95, 0.95, c3('#2a2c2f')); // 贯通道（车厢间风挡）
  box(body, -9.4, 9.4, 0.95, 3.7, -1.4, 1.4, c3('#e4e7ea'), c3('#b9bec3'));
  const doorC = c3('#c3c8ce'), win = c3('#ffefc8');
  for (const z of [-1.405, 1.405]) {
    const doors = [-7.1, -2.4, 2.4, 7.1];
    let x = -9.0;
    for (const dx of doors) {
      if (dx - 0.75 - x > 0.4) q(glow, [x, 1.85, z], [dx - 0.75, 1.85, z], [dx - 0.75, 2.85, z], [x, 2.85, z], win);
      q(body, [dx - 0.7, 1.05, z * 1.001], [dx + 0.7, 1.05, z * 1.001], [dx + 0.7, 3.05, z * 1.001], [dx - 0.7, 3.05, z * 1.001], doorC);
      for (const e of [-0.32, 0.32]) q(glow, [dx + e - 0.22, 1.95, z * 1.002], [dx + e + 0.22, 1.95, z * 1.002], [dx + e + 0.22, 2.8, z * 1.002], [dx + e - 0.22, 2.8, z * 1.002], win);
      x = dx + 0.75;
    }
    q(glow, [x, 1.85, z], [9.0, 1.85, z], [9.0, 2.85, z], [x, 2.85, z], win);
  }
  const mk = (G) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(G.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(G.c, 3));
    g.computeVertexNormals();
    return g;
  };
  return { body: mk(body), glow: mk(glow) };
}

export default {
  id: 'metro',
  name: '地铁地下网络',
  /** 出入口让位：出入口 3.5 m 内的小体量通用建筑（≤8 m，多为被识别成楼的出入口雨棚）与树木让位，招牌模块据此做标准雨棚 */
  async prepare(ctx) {
    const D = await getData();
    if (!D || !ctx.exclusions) return;
    for (const s of D.stations) for (const [x, z, lab] of s.exits || []) {
      if (lab) ctx.exclusions.add({ circle: [x, z, 3.5], name: `地铁${s.n}${lab}口` }, { buildings: true, trees: true, roads: false, pois: false, maxHeight: 8 });
    }
  },
  async build(ctx) {
    const D = await getData();
    const root = new THREE.Group();
    root.name = 'metro';
    root.visible = false;
    ctx.scene.add(root);
    const stub = { update() {}, setLayer() {}, api: {}, dispose() { ctx.scene.remove(root); } };
    if (!D) return stub;
    const app = () => window.xian || {};
    const H = (x, z) => ctx.terrain.heightAt(x, z);
    const colorOf = new Map(D.lines.map((l) => [l.num, l.color]));
    // 有线号的显示“N号线”，西户线/云巴等无线号线路（num ≥ 100）显示线名
    const nameOf = new Map(D.lines.map((l) => [l.num, l.num < 100 ? `${l.num}号线` : l.name]));
    const badgeOf = (n) => (n < 100 ? String(n) : (nameOf.get(n) || '').replace(/^西安/, '').slice(0, 2));
    const lineColor = (n) => colorOf.get(n) || '#9aa4b0';
    const linePts = new Map(D.lines.map((L) => [L.num, L.paths.map((f) => { const p = []; for (let i = 0; i + 2 < f.length; i += 3) p.push([f[i], f[i + 1], f[i + 2]]); return p; })]));

    // —— 车站站体框架（每站每条地下线一个）：中心取上下行两条轨道之间、轴沿轨道 ——
    const nearestOn = (p, x, z) => {
      let best = null, bd = Infinity;
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
        if (Math.abs(a[0] - x) > 600 && Math.abs(b[0] - x) > 600) continue;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
        const px = a[0] + ex * t, pz = a[1] + ez * t, d = Math.hypot(px - x, pz - z);
        if (d < bd) { bd = d; best = { x: px, z: pz, d, dx: ex, dz: ez }; }
      }
      return best;
    };
    const boxes = [];
    for (const s of D.stations) for (const l of s.lines) {
      if (!(l.d > 0)) continue; // 高架/地面站由地面铁路模块表现
      let cx = l.x, cz = l.z, ux = l.dx, uz = l.dz;
      const near = (linePts.get(l.num) || []).map((p) => nearestOn(p, l.x, l.z)).filter((q) => q && q.d < 50).sort((a, b) => a.d - b.d);
      if (near.length >= 2) {
        const a = near[0], b = near.find((q) => Math.hypot(q.x - a.x, q.z - a.z) > 4) || near[1];
        const sep = Math.hypot(a.x - b.x, a.z - b.z);
        if (sep > 5 && sep < 45) { cx = (a.x + b.x) / 2; cz = (a.z + b.z) / 2; }
        const dl = Math.hypot(a.dx, a.dz);
        if (dl > 1) { ux = a.dx / dl; uz = a.dz / dl; }
      }
      const ul = Math.hypot(ux, uz) || 1;
      ux /= ul; uz /= ul;
      const vx = -uz, vz = ux;
      const g0 = H(cx, cz), yR = g0 - l.d;
      const F = (u, v, y) => [cx + ux * u + vx * v, yR + y, cz + uz * u + vz * v];
      boxes.push({ s, l, cx, cz, ux, uz, vx, vz, yR, g0, F });
    }
    const BCELL = 200, bgrid = new Map();
    for (const b of boxes) {
      const r = HALL_L / 2 + 10;
      for (let i = Math.floor((b.cx - r) / BCELL); i <= Math.floor((b.cx + r) / BCELL); i++)
        for (let j = Math.floor((b.cz - r) / BCELL); j <= Math.floor((b.cz + r) / BCELL); j++) {
          const k = i * 100003 + j;
          if (!bgrid.has(k)) bgrid.set(k, []);
          bgrid.get(k).push(b);
        }
    }
    const boxesAt = (x, z) => bgrid.get(Math.floor(x / BCELL) * 100003 + Math.floor(z / BCELL)) || [];
    /** 点所在的站体；padV：横向额外放宽（本线轨道吸附用：上下行在站内可能分开 20 多米） */
    const inBox = (x, z, pad = 0, num = null, padV = 0) => {
      for (const b of boxesAt(x, z)) {
        if (num != null && b.l.num !== num) continue;
        const dx = x - b.cx, dz = z - b.cz;
        const u = dx * b.ux + dz * b.uz, v = dx * b.vx + dz * b.vz;
        if (Math.abs(u) < HALL_L / 2 + pad && Math.abs(v) < HALL_W / 2 + pad + padV) return b;
      }
      return null;
    };

    // —— 轨道路径（隧道、列车、步行共用）：20 m 重采样、轨面高程平滑；站体内吸附到站台两侧股道 ——
    const paths = [];
    for (const L of D.lines) {
      const ps = linePts.get(L.num).slice().sort((a, b) => b.length - a.length);
      ps.forEach((p, pi) => {
        if (p.length < 2) return;
        const S = [];
        for (let i = 1; i < p.length; i++) {
          const [ax, az, ad] = p[i - 1], [bx, bz, bd] = p[i];
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / TUN_STEP));
          for (let k = 0; k < n; k++) { const t = k / n; S.push([ax + (bx - ax) * t, az + (bz - az) * t, ad + (bd - ad) * t]); }
        }
        S.push(p[p.length - 1].slice());
        const raw = S.map(([x, z, d]) => (d > 0 ? H(x, z) - d : H(x, z) + 0.5));
        const ys = raw.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - 4); k <= Math.min(raw.length - 1, i + 4); k++) { s += raw[k]; n++; } return s / n; });
        const pts = S.map(([x, z, d], i) => {
          const b = d > 0 ? inBox(x, z, 0, L.num, 14) : null;
          if (!b) return [x, ys[i], z, d > 0, null];
          const dx = x - b.cx, dz = z - b.cz, u = dx * b.ux + dz * b.uz, v = dx * b.vx + dz * b.vz;
          const vv = (v >= 0 ? 1 : -1) * TRACK_V;
          return [b.cx + b.ux * u + b.vx * vv, b.yR, b.cz + b.uz * u + b.vz * vv, true, b];
        });
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
        paths.push({ num: L.num, color: L.color, pts, cum, dir: pi % 2 ? -1 : 1, main: pi < 2 });
      });
    }
    // 隧道段索引（按 1 km 分块）与步行查询网格
    const tunCells = new Map(), tunGrid = new Map(), TG = 100;
    paths.forEach((P, pi) => {
      for (let i = 1; i < P.pts.length; i++) {
        const a = P.pts[i - 1], b = P.pts[i];
        if (!a[3] || !b[3] || a[4] || b[4]) continue;
        const k = Math.floor(b[0] / TUN_CELL) * 100003 + Math.floor(b[2] / TUN_CELL);
        if (!tunCells.has(k)) tunCells.set(k, []);
        tunCells.get(k).push(pi, i);
        const g = Math.floor(b[0] / TG) * 100003 + Math.floor(b[2] / TG);
        if (!tunGrid.has(g)) tunGrid.set(g, []);
        tunGrid.get(g).push([a[0], a[2], a[1], b[0], b[2], b[1]]);
      }
    });

    // —— 隧道分块生成（进站后按需） ——
    const RING = [[-2.2, 0], [2.2, 0], [2.7, 1.5], [2.6, 3.2], [1.6, 4.6], [0, 5.0], [-1.6, 4.6], [-2.6, 3.2], [-2.7, 1.5], [-2.2, 0]];
    const ringArc = [0];
    for (let k = 1; k < RING.length; k++) ringArc.push(ringArc[k - 1] + Math.hypot(RING[k][0] - RING[k - 1][0], RING[k][1] - RING[k - 1][1]));
    const tunnels = new Map(); // key → {group, used}
    const buildTunnel = (key) => {
      const M = metroMaterials();
      const list = tunCells.get(key);
      const pos = [], col = [], uv = [], lp = [], lc = [];
      const ringAt = (P, i) => {
        const [x, y, z] = P.pts[i];
        const j = Math.min(P.pts.length - 1, i + 1), h = Math.max(0, i - 1);
        let dx = P.pts[j][0] - P.pts[h][0], dz = P.pts[j][2] - P.pts[h][2];
        const dl = Math.hypot(dx, dz) || 1;
        dx /= dl; dz /= dl;
        return RING.map(([v, hh]) => [x - dz * v, y - 0.3 + hh, z + dx * v]);
      };
      for (let n = 0; n < list.length; n += 2) {
        const P = paths[list[n]], i = list[n + 1];
        const A = ringAt(P, i - 1), B = ringAt(P, i);
        const s0 = P.cum[i - 1], s1 = P.cum[i];
        const lcol = c3(P.color);
        for (let k = 0; k + 1 < RING.length; k++) {
          const cc = k === 0 ? c3('#4a4945') : k === 2 || k === 7 ? lcol.clone().multiplyScalar(0.8) : c3('#8a8984').multiplyScalar(0.62);
          const V = [[A[k], s0, ringArc[k]], [B[k], s1, ringArc[k]], [B[k + 1], s1, ringArc[k + 1]], [A[k + 1], s0, ringArc[k + 1]]];
          for (const t of [0, 1, 2, 0, 2, 3]) { pos.push(...V[t][0]); col.push(cc.r, cc.g, cc.b); uv.push(V[t][1], V[t][2]); }
        }
        // 拱顶灯：每段一盏
        const mx = (A[5][0] + B[5][0]) / 2, my = (A[5][1] + B[5][1]) / 2 - 0.05, mz = (A[5][2] + B[5][2]) / 2;
        const ex = (B[5][0] - A[5][0]) / 2 * 0.15, ez = (B[5][2] - A[5][2]) / 2 * 0.15, wx = -(B[5][2] - A[5][2]) / 2 * 0.03, wz = (B[5][0] - A[5][0]) / 2 * 0.03;
        const Q = [[mx - ex - wx, my, mz - ez - wz], [mx + ex - wx, my, mz + ez - wz], [mx + ex + wx, my, mz + ez + wz], [mx - ex + wx, my, mz - ez + wz]];
        for (const t of [0, 1, 2, 0, 2, 3]) { lp.push(...Q[t]); lc.push(1, 0.93, 0.8); }
      }
      const group = new THREE.Group();
      const mk = (p, c, t, mat, name) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
        if (t) g.setAttribute('uv', new THREE.Float32BufferAttribute(t, 2));
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, mat);
        m.name = name;
        m.matrixAutoUpdate = false;
        group.add(m);
      };
      if (pos.length) mk(pos, col, uv, M.conc, '地铁隧道');
      if (lp.length) mk(lp, lc, null, M.light, '隧道灯');
      root.add(group);
      return { group, used: 0 };
    };

    // —— 车站：按需生成 ——
    const stationRecs = new Map();
    for (const b of boxes) {
      let r = stationRecs.get(b.s);
      if (!r) stationRecs.set(b.s, (r = { s: b.s, boxes: [], x: 0, z: 0, built: null, used: 0, idx: stationRecs.size }));
      r.boxes.push(b);
    }
    for (const r of stationRecs.values()) { r.x = r.boxes.reduce((a, b) => a + b.cx, 0) / r.boxes.length; r.z = r.boxes.reduce((a, b) => a + b.cz, 0) / r.boxes.length; }
    const ensureStation = (r) => {
      if (!r.built) {
        r.built = buildStation(r.s, r.boxes, H, lineColor, badgeOf, r.idx + 1);
        root.add(r.built.group);
      }
      return r.built;
    };

    // —— 列车：沿轨道中心线按站停靠（停站 25 s），每条轨道单向运行，到终点后隐藏折返 ——
    const geo = carGeometry();
    // 线路色腰带：车体两侧各一条薄带（不用盒子，免得车厢间隙里露出色块端面）
    const stripeGeo = (() => {
      const P = [];
      for (const z of [-1.412, 1.412]) P.push(-9.3, 1.4, z, 9.3, 1.4, z, 9.3, 1.62, z, -9.3, 1.4, z, 9.3, 1.62, z, -9.3, 1.62, z);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.computeVertexNormals();
      return g;
    })();
    const trains = [];
    for (const P of paths) {
      const L = P.cum[P.cum.length - 1];
      if (L < 1500 || !P.pts.some((p) => p[3])) continue;
      // 停站位置：路径穿过本线站体处离站中心最近的点
      const stops = [];
      let cur = null;
      for (let i = 0; i < P.pts.length; i++) {
        const b = P.pts[i][4];
        if (b && b !== cur) {
          let bi = i, bd = Infinity, last = i;
          for (let k = i; k < P.pts.length && P.pts[k][4] === b; k++) { last = k; const d = Math.hypot(P.pts[k][0] - b.cx, P.pts[k][2] - b.cz); if (d < bd) { bd = d; bi = k; } }
          // 站内的点已吸附在股道上（沿站台轴），用局部 u 把停车位置精确对准站台中心（车门对准屏蔽门）
          const uOf = (k) => (P.pts[k][0] - b.cx) * b.ux + (P.pts[k][2] - b.cz) * b.uz;
          const k2 = bi < last ? bi + 1 : bi > i ? bi - 1 : bi;
          const sgn = k2 === bi ? 1 : Math.sign((uOf(k2) - uOf(bi)) * (k2 - bi)) || 1;
          stops.push(P.cum[bi] - sgn * uOf(bi));
        }
        cur = b;
      }
      const seq = P.dir > 0 ? stops : stops.slice().reverse();
      const ev = []; // [t0, t1, s0, s1]（s0 == s1 为停站）
      let t = 0;
      if (seq.length >= 2) {
        for (let k = 0; k < seq.length; k++) {
          ev.push([t, t + 25, seq[k], seq[k]]);
          t += 25;
          if (k + 1 < seq.length) { const T = Math.abs(seq[k + 1] - seq[k]) / 15 + 8; ev.push([t, t + T, seq[k], seq[k + 1]]); t += T; }
        }
        ev.push([t, t + 40, null, null]); // 折返（隐藏）
        t += 40;
      }
      const n = Math.max(1, Math.round(L / 1800)); // 行车间隔约 2~3 分钟
      for (let k = 0; k < n; k++) trains.push({ P, L, ev, cycle: t, phase: (k / n) * (t || L / 15), dir: P.dir });
    }
    const CARS = 6;
    const nInst = Math.max(1, trains.length * CARS);
    const stdTrain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.2, fog: false, side: THREE.DoubleSide });
    const bodyIM = new THREE.InstancedMesh(geo.body, stdTrain, nInst);
    const glowIM = new THREE.InstancedMesh(geo.glow, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, color: new THREE.Color(1.5, 1.5, 1.5) }), nInst);
    const stripeIM = new THREE.InstancedMesh(stripeGeo, new THREE.MeshStandardMaterial({ roughness: 0.5, fog: false, side: THREE.DoubleSide }), nInst);
    for (const m of [bodyIM, glowIM, stripeIM]) { m.frustumCulled = false; m.name = '地铁列车'; }
    trains.forEach((tr) => { tr.col = c3(tr.P.color); });
    stripeIM.setColorAt(0, trains[0]?.col || c3('#ffffff'));
    bodyIM.count = glowIM.count = stripeIM.count = 0;
    root.add(bodyIM, glowIM, stripeIM);
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    const at = (P, s) => {
      const c = P.cum;
      let lo = 0, hi = c.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
      const a = P.pts[lo], b = P.pts[hi], t = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, b[0] - a[0], b[2] - a[2], a[3] && b[3]];
    };
    const centerAt = (tr, time) => {
      if (!tr.ev.length) { let s = (tr.phase + time * 16) % (2 * tr.L); return s > tr.L ? 2 * tr.L - s : s; }
      const tau = (((time + tr.phase) % tr.cycle) + tr.cycle) % tr.cycle;
      let lo = 0, hi = tr.ev.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tr.ev[mid][0] <= tau) lo = mid; else hi = mid - 1; }
      const [t0, t1, s0, s1] = tr.ev[lo];
      if (s0 == null) return null;
      const k = Math.min(1, (tau - t0) / (t1 - t0)), e = k * k * (3 - 2 * k);
      return s0 + (s1 - s0) * e;
    };
    // 只把相机 2.5 km 内的列车写进实例（其余不画），实例数随之变化
    const updateTrains = (time) => {
      const cp = ctx.camera.position;
      let n = 0;
      for (const tr of trains) {
        const sc = centerAt(tr, time);
        if (sc == null) continue;
        const ctr = at(tr.P, Math.max(0, Math.min(tr.L, sc)));
        if (Math.abs(ctr[0] - cp.x) > 2500 || Math.abs(ctr[2] - cp.z) > 2500) continue;
        for (let c = 0; c < CARS; c++) {
          const s = sc + tr.dir * (2.5 - c) * 19.6;
          if (s < 0 || s > tr.L) continue;
          const [x, y, z, dx, dz, under] = at(tr.P, s);
          if (!under) continue;
          _p.set(x, y, z);
          _q.setFromAxisAngle(_up, Math.atan2(-dz, dx));
          _s.setScalar(1);
          _m.compose(_p, _q, _s);
          bodyIM.setMatrixAt(n, _m);
          glowIM.setMatrixAt(n, _m);
          stripeIM.setMatrixAt(n, _m);
          stripeIM.setColorAt(n, tr.col);
          n++;
        }
      }
      bodyIM.count = glowIM.count = stripeIM.count = n;
      bodyIM.instanceMatrix.needsUpdate = glowIM.instanceMatrix.needsUpdate = stripeIM.instanceMatrix.needsUpdate = true;
      if (stripeIM.instanceColor) stripeIM.instanceColor.needsUpdate = true;
    };

    // —— 透视俯视：2D 叠加层 + 车站标注（只在 X 模式显示） ——
    const xrData = buildXrayData(D.lines, D.stations);
    const overlay = new XrayOverlay(ctx.renderer.domElement, xrData, H, D.stations);
    if (!document.getElementById('metro-style')) {
      const st = document.createElement('style');
      st.id = 'metro-style';
      st.textContent = `.label-metrox .label-text{font-size:13px;background:rgba(8,14,30,.82);border-color:rgba(255,255,255,.38)}
.label-metrox .label-sub{display:flex;gap:3px;margin-top:2px}
.label-metrox .mx-b{display:inline-block;padding:0 4px;border-radius:3px;color:#fff;font-size:10px;font-weight:700;line-height:14px;font-style:normal;text-shadow:0 1px 1px rgba(0,0,0,.4)}
.label-metrox .label-dot{height:8px;background:rgba(255,255,255,.75)}
button.b-metro-under.on{box-shadow:0 0 0 2px rgba(232,181,74,.35)}`;
      document.head.appendChild(st);
    }
    for (const s of D.stations) {
      const [x, z] = xrData.pos.get(s) || [s.x, s.z];
      const nums = [...new Set(s.lines.map((l) => l.num))];
      const sub = nums.map((n) => `<i class="mx-b" style="background:${lineColor(n)}">${n < 100 ? n + '号线' : nameOf.get(n)}</i>`).join('');
      const it = ctx.labels.add(s.n, new THREE.Vector3(x, H(x, z) + 60, z), {
        category: 'metrox', sub, priority: nums.length > 1 ? 2.2 : 1.2, minDist: 0, maxDist: 60000,
      });
      // 线路色标比站名宽时按色标宽度做碰撞（换乘站两三个色标并排）
      if (it) it.labelWidth = Math.max(it.labelWidth, nums.length * 44 + 8);
    }
    ctx.labels.hidden.add('metrox');

    // —— 文字标注层：透视时隐藏路名/小区名（地名只留车站），地下时全部隐藏；用 visibility 隐藏，不改用户的开关状态 ——
    const textLayers = () => {
      const A = app();
      return [['labels', ctx.labels, ctx.labels.root], ['roads', A.roadNames, A.roadNames?.root], ['estates', A.estates?.labels, A.estates?.labels?.root]];
    };
    const applyText = () => {
      for (const [k, obj, el] of textLayers()) {
        if (!obj || !el) continue;
        const hide = state.under || (state.xray && k !== 'labels');
        el.style.visibility = hide ? 'hidden' : '';
        // 隐藏期间停掉其逐帧计算；恢复时以 DOM 的 display（即用户开关的最后状态）为准
        obj.visible = hide ? false : el.style.display !== 'none';
      }
    };
    const setButton = () => {
      const btn = document.querySelector('.b-metro-under');
      if (!btn) return;
      btn.textContent = state.under ? `返回地面（U）· ${state.station}站` : '进入地铁·地下浏览（U）';
      btn.classList.toggle('on', state.under);
    };

    // —— 模式切换 ——
    const state = { xray: false, under: false, saved: null, hidden: [], xrHid: [], surface: null, station: null, env: null, frame: 0 };
    const setXray = (on, fly = true) => {
      if (on === state.xray) return;
      state.xray = on;
      overlay.setVisible(on);
      const L = ctx.labels;
      if (on) {
        // 只显示车站标注：其他类别（地标、POI、片区、行政区……）暂时隐藏，记下是本模块隐藏的哪些
        state.xrHid = [];
        for (const it of L.items) if (it.category !== 'metrox' && !L.hidden.has(it.category)) { L.hidden.add(it.category); state.xrHid.push(it.category); }
        L.hidden.delete('metrox');
      } else {
        for (const c of state.xrHid) L.hidden.delete(c);
        state.xrHid = [];
        L.hidden.add('metrox');
      }
      applyText();
      const C = ctx.controls, cam = ctx.camera;
      if (!C || !fly) { if (!on) state.saved = null; return; }
      if (on) {
        state.saved = { p: cam.position.clone(), q: cam.quaternion.clone(), mode: C.mode };
        // 视线与地面交点（或相机正下方）作为俯视中心；高度按城区尺度
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        let tx = cam.position.x, tz = cam.position.z;
        if (dir.y < -0.05) { const t = (cam.position.y - H(tx, tz)) / -dir.y; tx += dir.x * Math.min(t, 20000); tz += dir.z * Math.min(t, 20000); }
        const h = Math.max(9000, Math.min(26000, cam.position.y - H(tx, tz) + 6000));
        C.flyTo(new THREE.Vector3(tx, H(tx, tz) + h, tz + 1), new THREE.Vector3(tx, H(tx, tz), tz), { duration: 2.2 });
      } else if (state.saved) {
        const s = state.saved;
        const tgt = new THREE.Vector3(0, 0, -100).applyQuaternion(s.q).add(s.p);
        const mode = s.mode;
        C.flyTo(s.p, tgt, {
          duration: 1.8,
          onArrive: () => { cam.quaternion.copy(s.q); C._syncAnglesFromCamera(); if (mode && mode !== 'fly') C.setMode(mode); },
        });
        state.saved = null;
      }
    };
    const floorAt = (x, z, y) => {
      const foot = y - (ctx.controls?.eye ?? 1.7);
      let best = null;
      for (const b of boxesAt(x, z)) {
        const f = boxFloor(b, x, z, foot);
        if (f != null && (best == null || (f <= foot + 0.7 && f > best) || (best > foot + 0.7 && f < best))) best = f;
      }
      if (best != null) return best;
      // 出入口通道（已生成的车站）
      for (const r of stationRecs.values()) {
        if (!r.built || Math.abs(r.x - x) > 700 || Math.abs(r.z - z) > 700) continue;
        const y = passageFloor(r.built.runs, x, z, foot);
        if (y != null) return y;
      }
      // 隧道
      let bd = 6, yy = null;
      const gi = Math.floor(x / TG), gj = Math.floor(z / TG);
      for (let i = gi - 1; i <= gi + 1; i++) for (let j = gj - 1; j <= gj + 1; j++) {
        for (const [ax, az, ay, bx, bz, by] of tunGrid.get(i * 100003 + j) || []) {
          const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
          const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
          if (d < bd) { bd = d; yy = ay + (by - ay) * t - 0.3; }
        }
      }
      return yy;
    };

    // 地下固定照明：半球光 = 站内漫射，主光 = 顶部灯具方向；曝光锁定、泛光关闭、去掉天空环境反射
    const _sun = new THREE.Vector3(0.3, 1, 0.18).normalize();
    const underLighting = () => {
      const sky = ctx.sky, cam = ctx.camera;
      if (sky) {
        sky.hemi.color.set(0xfff7ec);
        sky.hemi.groundColor.set(0xd3cdc3);
        sky.hemi.intensity = 2.2;
        sky.sun.color.set(0xfff3e2);
        sky.sun.intensity = 1.5;
        sky.sun.target.position.copy(cam.position);
        sky.sun.target.updateMatrixWorld();
        sky.sun.position.copy(cam.position).addScaledVector(_sun, 400);
        ctx.renderer.toneMappingExposure = EXPOSURE * (sky.exposureScale ?? 1);
      }
      const post = app().post;
      if (post?.bloom) post.bloom.enabled = false;
      if (ctx.scene.environment) { state.env = ctx.scene.environment; ctx.scene.environment = null; }
      // 用户在地下改了标注开关：保持隐藏（离开时按开关状态恢复）
      for (const [, obj, el] of textLayers()) if (obj && el && obj.visible) obj.visible = false;
    };

    /** keepCamera：出站但不动相机（地下时按了预设视角/俯视，相机已在飞往地面目标） */
    const setUnder = (on, station = null, { keepCamera = false } = {}) => {
      if (on === state.under) return;
      const C = ctx.controls, cam = ctx.camera;
      if (on) {
        let b = null;
        if (station) {
          // station：车站对象、站名，或“站名:线号”（换乘站指定站体）
          const [nm, num] = typeof station === 'string' ? station.split(':') : [null, null];
          b = boxes.find((q) => (q.s === station || q.s.n === nm) && (!num || q.l.num === +num)) || null;
        }
        if (!b) {
          let bd = Infinity;
          for (const q of boxes) { const d = Math.hypot(q.cx - cam.position.x, q.cz - cam.position.z); if (d < bd) { bd = d; b = q; } }
        }
        if (!b) return;
        // 进站前视点：从透视模式进站时取进入透视前的视点
        state.surface = state.xray && state.saved
          ? { p: state.saved.p.clone(), q: state.saved.q.clone(), mode: state.saved.mode || 'fly' }
          : { p: cam.position.clone(), q: cam.quaternion.clone(), mode: C ? C.mode : 'fly' };
        setXray(false, false);
        state.under = true;
        state.station = b.s.n;
        state.hidden = [];
        for (const o of ctx.scene.children) if (o !== root && o.visible && !o.isLight && !o.isCamera) { o.visible = false; state.hidden.push(o); }
        root.visible = true;
        state.env = ctx.scene.environment;
        ctx.scene.environment = null;
        state.bloomWas = app().post?.bloom?.enabled;
        const rec = stationRecs.get(b.s);
        if (rec) { ensureStation(rec); rec.used = state.frame; }
        streamNear(true);
        if (C) {
          C.tween = null;
          C.groundFn = (x, z, y) => floorAt(x, z, y);
          C.setMode('walk');
          C.velocity.set(0, 0, 0);
          C.vy = 0;
          // 出生点：站台中线、两排柱之间（u=0 那对柱子在身体两侧、视野外），面朝站台纵深（+u），前方 8 m 内无遮挡
          const p = b.F(1.0, 0, PLAT_H + C.eye);
          cam.position.set(p[0], p[1], p[2]);
          C.yaw = Math.atan2(-b.ux, -b.uz);
          C.pitch = -0.02;
          C._lastUnder = b.yR + PLAT_H;
        }
        underLighting();
      } else {
        state.under = false;
        for (const o of state.hidden) o.visible = true;
        state.hidden = [];
        root.visible = false;
        const sky = ctx.sky;
        ctx.scene.environment = sky && sky.envEnabled !== false ? (sky.envRT?.texture ?? state.env) : null;
        state.env = null;
        const post = app().post, dv = app().display?.values;
        if (post) {
          if (dv && post.setBloom) post.setBloom(dv.bloom, dv.bloomStrength);
          else if (post.bloom && state.bloomWas != null) post.bloom.enabled = state.bloomWas;
        }
        if (C && keepCamera) {
          C.groundFn = null;
          C._lastUnder = undefined;
        } else if (C) {
          C.groundFn = null;
          C._lastUnder = undefined;
          C.tween = null;
          C.velocity.set(0, 0, 0);
          C.vy = 0;
          const s = state.surface;
          if (s) {
            cam.position.copy(s.p);
            cam.quaternion.copy(s.q);
            C._syncAnglesFromCamera();
            if (C.mode !== s.mode) C.setMode(s.mode === 'walk' || s.mode === 'orbit' ? s.mode : 'fly');
          } else {
            C.setMode('fly');
            const p = cam.position;
            cam.position.set(p.x, H(p.x, p.z) + 60, p.z);
            C.pitch = -0.35;
          }
        }
        state.surface = null;
      }
      applyText();
      setButton();
    };

    // 地下：按相机位置生成/显示附近车站与隧道块
    const streamNear = (force = false) => {
      const cp = ctx.camera.position;
      const recs = [...stationRecs.values()].map((r) => [Math.hypot(r.x - cp.x, r.z - cp.z), r]).sort((a, b) => a[0] - b[0]);
      let built = 0;
      for (const [d, r] of recs) {
        const want = d < STATION_R;
        if (want && !r.built && (force || built < 1)) { ensureStation(r); built++; }
        if (r.built) { r.built.group.visible = want; if (want) r.used = state.frame; }
      }
      const live = recs.filter(([, r]) => r.built);
      if (live.length > MAX_BUILT) {
        live.sort((a, b) => a[1].used - b[1].used);
        for (const [d, r] of live.slice(0, live.length - MAX_BUILT)) if (d >= STATION_R) { root.remove(r.built.group); r.built.dispose(); r.built = null; }
      }
      const ci = Math.floor(cp.x / TUN_CELL), cj = Math.floor(cp.z / TUN_CELL);
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
        const k = i * 100003 + j;
        if (tunCells.has(k) && !tunnels.has(k) && (force || built < 2)) { tunnels.set(k, buildTunnel(k)); built++; }
      }
      for (const [k, t] of tunnels) {
        const i = Math.round(k / 100003), j = k - i * 100003;
        const near = Math.abs(i - ci) <= 1 && Math.abs(j - cj) <= 1;
        t.group.visible = near;
        if (near) t.used = state.frame;
      }
      if (tunnels.size > 40) {
        const old = [...tunnels].filter(([, t]) => !t.group.visible).sort((a, b) => a[1].used - b[1].used).slice(0, tunnels.size - 40);
        for (const [k, t] of old) { root.remove(t.group); t.group.traverse((o) => o.geometry?.dispose()); tunnels.delete(k); }
      }
    };

    const api = {
      setXray, setUnder,
      get xray() { return state.xray; },
      get underground() { return state.under; },
      get station() { return state.station; },
      stations: D.stations, lines: D.lines,
      /** 诊断：已生成的车站与隧道块 */
      /** 诊断：站体框架（截图脚本定位相机用） */
      frame: (name, num) => { const b = boxes.find((q) => q.s.n === name && (!num || q.l.num === num)); return b && { cx: b.cx, cz: b.cz, ux: b.ux, uz: b.uz, vx: b.vx, vz: b.vz, yR: b.yR, num: b.l.num }; },
      /** 诊断：已生成车站的出入口通道折线 [[x, z, s], ...] */
      passages: (name) => { for (const r of stationRecs.values()) if (r.s.n === name && r.built) return r.built.runs.map((q) => q.pts); return null; },
      /** 诊断：相机 r 米内的列车（车组中心距离、是否停站） */
      trainsNear: (r = 300) => {
        const cp = ctx.camera.position, time = (performance.now() - t0) / 1000, out = [];
        for (const tr of trains) {
          const sc = centerAt(tr, time);
          if (sc == null) continue;
          const [x, y, z] = at(tr.P, Math.max(0, Math.min(tr.L, sc)));
          const d = Math.hypot(x - cp.x, z - cp.z);
          if (d < r) out.push({ d: +d.toFixed(1), dy: +(y - cp.y).toFixed(1), x, z, stopped: Math.abs(centerAt(tr, time + 0.5) - sc) < 0.01, num: tr.P.num });
        }
        return out;
      },
      stats: () => ({ stations: [...stationRecs.values()].filter((r) => r.built).map((r) => r.s.n), tunnels: tunnels.size, boxes: boxes.length, trains: trains.length }),
    };
    ctx.metro = api;
    let exitsN = 0;
    for (const s of D.stations) exitsN += (s.exits || []).filter((e) => e[2]).length;
    console.log(`[metro] ${D.lines.length} 条线，${D.stations.length} 站（地下站体 ${boxes.length}），出入口 ${exitsN}，列车 ${trains.length}`);
    const t0 = performance.now();
    return {
      api,
      update() {
        state.frame++;
        if (state.xray) overlay.draw(ctx.camera);
        // 地下时按了预设视角 / 俯视（相机开始飞行）：自动回到地面世界，相机按飞行目标走
        if (state.under && ctx.controls?.tween) setUnder(false, null, { keepCamera: true });
        if (state.under) {
          underLighting();
          if (state.frame % 10 === 0) streamNear();
          updateTrains((performance.now() - t0) / 1000);
        }
      },
      setLayer(layer, v) {
        if (layer === 'metro') setXray(v);
        if (layer === 'trains') bodyIM.visible = glowIM.visible = stripeIM.visible = v; // 画质面板“列车”开关
      },
      dispose() {
        for (const r of stationRecs.values()) if (r.built) r.built.dispose();
        root.traverse((o) => o.geometry?.dispose());
        overlay.dispose();
        ctx.scene.remove(root);
      },
    };
  },
};
