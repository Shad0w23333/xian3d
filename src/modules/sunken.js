// 全城下沉广场：南门榴园（专门精建，见 src/arch/sunken-liuyuan.js）、万众国际 WFive Park、钟鼓楼广场、各商业综合体与地铁站的下沉庭院……
// 数据：public/data/landmarks2026.json 的 sunken（tools/build_landmarks2026.py 由 research/refs/landmarks2026/sunken.json 生成：
//   中心、长宽、下沉深度、形状（矩形/圆形）、退台阶梯、水景、舞台、酒吧外摆、玻璃天窗、扶梯……）。
//
// 做法（2026-09-29 重做，消除穿模）：
//   · 不再用平整区把地形压成坑：地形网格 4~21 m 一格，压低后坑壁是一两格宽的斜面，会爬上挡墙、盖住坑底商铺，
//     外扩压低范围又把坑外的道路/步道一起拉下去，还得用 10 m 宽的铺装环去盖。改为 terrain.addHole 在坑口挖洞，
//     坑外地形原样，坑内（坑底、台阶、挡墙、商铺）全部由本模块几何补齐；挡墙顶按洞口一圈的实际地形高度（holeRimTop）封口。
//   · 调研清单里多数下沉广场只有估计坐标/估计尺寸：挖坑前核验坑口不压机动车道、不压其他模块的精建区（档案建筑、
//     城墙、钟鼓楼、大唐不夜城……）、不压成片的通用建筑与水面。不通过的只记录原因（diag），不再在错误位置挖坑。
//   · 坑口内的步道（footway/pedestrian）按排除区隐藏；通用建筑、树木在坑口外 2.5 m 内让位。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';
import * as G from '../arch/sky-geom.js';
import { buildLiuyuan, liuyuanFootprints } from '../arch/sunken-liuyuan.js';

const c3 = (h) => new THREE.Color(h);
// 核验阈值
const ROAD_OK = new Set(['footway']); // 坑口可以覆盖的道路等级（按排除区隐藏；步行街 pedestrian 是正经街道，不能挖）
const ZONE_MAX = 0.02; // 与其他模块精建区重叠比例上限
const BLD_MAX = 0.1; // 被通用建筑覆盖比例上限
const WATER_MAX = 0.02;

class Mesher {
  constructor() { this.pos = []; this.col = []; }
  quad(a, b, c, d, col) {
    this.pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) this.col.push(col.r, col.g, col.b);
  }
  box(F, u0, u1, v0, v1, y0, y1, col, top = col) {
    const P = F;
    const a = P(u0, v0, y0), b = P(u1, v0, y0), c = P(u1, v1, y0), d = P(u0, v1, y0);
    const e = P(u0, v0, y1), f = P(u1, v0, y1), g = P(u1, v1, y1), h = P(u0, v1, y1);
    this.quad(e, h, g, f, top);
    this.quad(a, b, f, e, col); this.quad(b, c, g, f, col); this.quad(c, d, h, g, col); this.quad(d, a, e, h, col);
  }
  mesh(mat, name) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.receiveShadow = true;
    return m;
  }
}

/** 局部框架：u 沿长边、v 沿短边、y 相对坑顶压顶高度 */
function frame(s, top) {
  const cu = Math.cos(s.rot), su = Math.sin(s.rot);
  return (u, v, y) => [s.x + u * cu - v * su, top + y, s.z + u * su + v * cu];
}

/** 通用下沉广场的坑口轮廓（世界坐标，CCW） */
function rimOf(s) {
  const F = frame(s, 0), hl = s.L / 2, hw = s.W / 2;
  let pts;
  if (s.round) {
    pts = [];
    for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; const p = F(Math.cos(a) * hl, Math.sin(a) * hw, 0); pts.push(p[0], p[2]); }
  } else pts = [F(-hl, -hw, 0), F(hl, -hw, 0), F(hl, hw, 0), F(-hl, hw, 0)].flatMap((p) => [p[0], p[2]]);
  return G.ccw(pts);
}

/** 多边形内均匀取样点（步长 step 米） */
function samples(poly, step) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
    z0 = Math.min(z0, poly[i + 1]); z1 = Math.max(z1, poly[i + 1]);
  }
  const out = [];
  for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) if (G.pointIn(x, z, poly)) out.push(x, z);
  return out;
}
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}
/** 线段是否压进多边形（按半宽 hw 缓冲） */
function segHitsPoly(ax, az, bx, bz, hw, poly) {
  if (G.pointIn(ax, az, poly) || G.pointIn(bx, bz, poly) || G.pointIn((ax + bx) / 2, (az + bz) / 2, poly)) return true;
  const n = poly.length / 2, h2 = hw * hw;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, px = poly[i * 2], pz = poly[i * 2 + 1], qx = poly[j * 2], qz = poly[j * 2 + 1];
    if (segDist2(px, pz, ax, az, bx, bz) < h2 || segDist2(ax, az, px, pz, qx, qz) < h2 || segDist2(bx, bz, px, pz, qx, qz) < h2) return true;
    // 真正相交
    const d1 = (qx - px) * (az - pz) - (qz - pz) * (ax - px), d2 = (qx - px) * (bz - pz) - (qz - pz) * (bx - px);
    const d3 = (bx - ax) * (pz - az) - (bz - az) * (px - ax), d4 = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}
// 与 src/arch/roads_net.js 的渲染路宽规则一致（不含人行道）
const MIN_W = { motorway: 7.5, trunk: 7, primary: 7, secondary: 6.5, tertiary: 6, residential: 5, service: 3.5, unclassified: 5, motorway_link: 4.5, trunk_link: 4.5, primary_link: 4.5, secondary_link: 4 };
function roadHalfW(f, cls) {
  const c = cls[f.c];
  let W = +f.w || MIN_W[c] || 5;
  W = Math.max(W, MIN_W[c] || 5, Math.max(1, Math.min(8, f.l | 0 || 1)) * (c === 'motorway' || c === 'trunk' || c === 'primary' ? 3.4 : 3.1));
  return Math.min(W, 42) / 2;
}
/** buildings.bin 轮廓（只解析 center 附近 r 米内的楼） */
function nearBuildings(buf, cx, cz, r) {
  if (!buf) return [];
  const dv = new DataView(buf);
  const ver = dv.getUint32(4, true), N = dv.getUint32(8, true);
  let o = 16;
  const ax = new Float32Array(buf, o, N); o += N * 4;
  const az = new Float32Array(buf, o, N); o += N * 4;
  const vs = new Uint32Array(buf, o, N); o += N * 4;
  const vc = new Uint16Array(buf, o, N); o += N * 2;
  o += N * 4 + N * 2 + (ver >= 2 ? N : 0);
  o += (4 - (o % 4)) % 4;
  const offs = new Int16Array(buf, o);
  const out = [];
  for (let i = 0; i < N; i++) {
    if (Math.abs(ax[i] - cx) > r || Math.abs(az[i] - cz) > r) continue;
    const p = [];
    for (let k = vs[i] * 2, e = k + vc[i] * 2; k < e; k += 2) p.push(ax[i] + offs[k] * 0.1, az[i] + offs[k + 1] * 0.1);
    out.push(p);
  }
  return out;
}

/** 估计坐标的下沉广场挖坑前核验：返回不通过的原因列表（空 = 通过） */
function validate(ctx, s, rim) {
  const why = [];
  const cls = ctx.data.roads?.classes || [];
  const R = Math.max(s.L, s.W) + 60;
  // a) 机动车道
  for (const f of ctx.data.roads?.features || []) {
    if (f.t || ROAD_OK.has(cls[f.c])) continue;
    const p = f.p;
    let near = false;
    for (let i = 0; i < p.length && !near; i += 2) near = Math.abs(p[i] - s.x) < R && Math.abs(p[i + 1] - s.z) < R;
    if (!near) continue;
    const hw = roadHalfW(f, cls);
    for (let i = 0; i + 3 < p.length; i += 2)
      if (segHitsPoly(p[i], p[i + 1], p[i + 2], p[i + 3], hw, rim)) {
        why.push(`压道路 ${cls[f.c]}${f.n ? ' ' + f.n : ''}`);
        break;
      }
    if (why.length >= 3) break;
  }
  const S = samples(rim, 2.5), nS = S.length / 2 || 1;
  // b) 其他模块精建区
  const hitBy = new Map();
  for (const it of ctx.exclusions.items) {
    if (!it.flags.buildings || it.name === 'sunken') continue;
    const b = it.bb;
    if (b.x1 < s.x - R || b.x0 > s.x + R || b.z1 < s.z - R || b.z0 > s.z + R) continue;
    let k = 0;
    for (let i = 0; i < S.length; i += 2) if (S[i] >= b.x0 && S[i] <= b.x1 && S[i + 1] >= b.z0 && S[i + 1] <= b.z1 && G.pointIn(S[i], S[i + 1], it.p)) k++;
    if (k) hitBy.set(it.name || '精建区', (hitBy.get(it.name || '精建区') || 0) + k);
  }
  for (const [nm, k] of hitBy) if (k / nS > ZONE_MAX) why.push(`压精建区 ${nm}（${Math.round((k / nS) * 100)}%）`);
  // c) 成片通用建筑
  const B = nearBuildings(ctx.data.buildings, s.x, s.z, R);
  let kb = 0;
  for (let i = 0; i < S.length; i += 2) if (B.some((p) => G.pointIn(S[i], S[i + 1], p))) kb++;
  if (kb / nS > BLD_MAX) why.push(`压通用建筑 ${Math.round((kb / nS) * 100)}%`);
  // d) 水面
  let kw = 0;
  for (const w of ctx.data.water?.polys || []) {
    const o = w.outer;
    if (!o || o.length < 6) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    if (x1 < s.x - R || x0 > s.x + R || z1 < s.z - R || z0 > s.z + R) continue;
    for (let i = 0; i < S.length; i += 2) if (G.pointIn(S[i], S[i + 1], o)) kw++;
  }
  if (kw / nS > WATER_MAX) why.push(`压水面 ${Math.round((kw / nS) * 100)}%`);
  return why;
}

export default {
  id: 'sunken',
  name: '下沉广场',
  async prepare(ctx) {
    const raw = await loadJSON('landmarks2026.json', { optional: true });
    this.sites = [];
    this.rejected = [];
    const T = ctx.terrain;
    for (const s of raw?.sunken || []) {
      if (ctx.exclusions.test(s.x, s.z, 'sunken')) continue; // 已由精建模块做了自己的下沉庭院（如 mixc 生命之树圆坑）
      if (/榴园/.test(s.name)) {
        // 南门榴园：按影像/照片精建的不规则坑口（不用清单里的估计矩形）
        const fp = liuyuanFootprints();
        const top = T.holeRimTop(fp.rim);
        T.addHole(fp.rim);
        ctx.exclusions.add({ points: G.inset(fp.rim, -2.5), name: 'sunken' }, { buildings: true, trees: true, pois: true });
        // 道路排除区只外扩 0.3 m：坑口内的台阶段步道隐藏，贴着 J–A 边外侧的环形步道 23107 保持连续
        ctx.exclusions.add({ points: G.inset(fp.rim, -0.3), name: 'sunken' }, { buildings: false, trees: false, pois: false, roads: true });
        for (const b of fp.buildings) ctx.exclusions.add({ points: G.inset(G.ccw(b), -1.5), name: 'sunken' }, { buildings: true, trees: true, pois: false });
        for (const p of fp.props) ctx.exclusions.add({ points: G.inset(G.ccw(p), -1.0), name: 'sunken' }, { buildings: true, trees: true, pois: false });
        this.sites.push({ ...s, kind: 'liuyuan', rim: fp.rim, top, depth: 5.5 });
        continue;
      }
      const rim = rimOf(s);
      const why = validate(ctx, s, rim);
      if (why.length) {
        this.rejected.push({ name: s.name, x: s.x, z: s.z, why });
        continue;
      }
      const top = T.holeRimTop(rim);
      T.addHole(rim);
      ctx.exclusions.add({ points: G.inset(rim, -2.5), name: 'sunken' }, { buildings: true, trees: true, pois: false });
      ctx.exclusions.add({ points: G.inset(rim, -1.2), name: 'sunken' }, { buildings: false, trees: false, pois: false, roads: true });
      this.sites.push({ ...s, kind: 'generic', rim, top });
    }
    if (this.rejected.length)
      console.warn(`[sunken] ${this.rejected.length} 处估计坐标的下沉广场核验未通过，未挖坑：` + this.rejected.map((r) => `${r.name}（${r.why.join('；')}）`).join('、'));
  },

  build(ctx) {
    const root = new THREE.Group();
    root.name = '下沉广场';
    ctx.scene.add(root);
    const solid = new Mesher(), glassM = new Mesher(), lampM = new Mesher(), waterM = new Mesher(), railM = new Mesher();
    const pave = c3('#b9b2a6'), paveB = c3('#a39b8e'), wall = c3('#c8c0b2'), stone = c3('#d6d0c4'), frameC = c3('#3e4247');
    const rail = c3('#8a9096'), wood = c3('#8a6a4a'), green = c3('#4f7a3c'), umb = [c3('#e8e1d2'), c3('#c9442f'), c3('#2f5d8a')];
    const shopGlass = [c3('#ffd9a0'), c3('#ffe6c4'), c3('#fff0d8'), c3('#ffc98a')];
    const signC = [c3('#c9302c'), c3('#1f4e79'), c3('#2d6a4f'), c3('#b8860b'), c3('#6a2c70'), c3('#222222')];
    const addLabel = (name, p) => ctx.labels.add(name.replace(/（.*?）|\(.*?\)/g, ''), p, { category: 'landmark', sub: '下沉广场', priority: 1.5, minDist: 40, maxDist: 3000 });
    for (const s of this.sites || []) {
      if (s.kind === 'liuyuan') {
        const r = buildLiuyuan(ctx, { top: s.top, ground: (x, z) => ctx.terrain.heightAt(x, z) });
        root.add(r.group);
        for (const L of r.lights) ctx.lights.add({ ...L, nightOnly: true, priority: 1 });
        addLabel('南门榴园', r.label);
        continue;
      }
      const F = frame(s, s.top);
      const D = s.depth, hl = s.L / 2, hw = s.W / 2;
      const rnd = (k) => ((Math.sin((s.x * 0.13 + s.z * 0.07 + k) * 12.9898) * 43758.5453) % 1 + 1) % 1;
      const stairL = Math.min(s.L * 0.3, D * 2.2);
      // 坑底铺装（棋盘纹）
      const g = 6;
      if (!s.round) {
        for (let u = -hl; u < hl - 0.01; u += g) for (let v = -hw; v < hw - 0.01; v += g) {
          const u1 = Math.min(hl, u + g), v1 = Math.min(hw, v + g);
          solid.quad(F(u, v, -D + 0.04), F(u, v1, -D + 0.04), F(u1, v1, -D + 0.04), F(u1, v, -D + 0.04), ((Math.round(u / g) + Math.round(v / g)) & 1) ? pave : paveB);
        }
      }
      if (s.round) {
        // 圆形：坑底 + 环形退台看台（最外圈挡墙顶 = 压顶高度）
        for (let i = 0; i < 48; i++) {
          const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2, r = 0.72;
          solid.quad(F(0, 0, -D + 0.04), F(Math.cos(a1) * hl * r, Math.sin(a1) * hw * r, -D + 0.04), F(Math.cos(a0) * hl * r, Math.sin(a0) * hw * r, -D + 0.04), F(0, 0, -D + 0.04), pave);
        }
        const rings = Math.max(3, Math.round(D / 0.9));
        for (let k = 0; k < rings; k++) {
          const t0 = k / rings, t1 = (k + 1) / rings;
          const ra = 1 - 0.28 * t0, rb = 1 - 0.28 * t1, y = -D * t1;
          for (let i = 0; i < 48; i++) {
            const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2;
            const P = (a, r, yy) => F(Math.cos(a) * hl * r, Math.sin(a) * hw * r, yy);
            solid.quad(P(a0, ra, -D * t0), P(a1, ra, -D * t0), P(a1, ra, y), P(a0, ra, y), wall);
            solid.quad(P(a0, ra, y), P(a1, ra, y), P(a1, rb, y), P(a0, rb, y), k & 1 ? stone : wood);
          }
        }
      } else {
        // 三面挡墙 + 环绕商铺；-u 端是大台阶（端墙只做素墙，下部被台阶挡住）
        const sides = [[[-hl, -hw], [hl, -hw]], [[hl, -hw], [hl, hw]], [[hl, hw], [-hl, hw]]];
        solid.quad(F(-hl, hw, -D), F(-hl, -hw, -D), F(-hl, -hw, 0), F(-hl, hw, 0), wall);
        for (const [[ua, va], [ub, vb]] of sides) {
          const len = Math.hypot(ub - ua, vb - va), n = Math.max(1, Math.floor(len / 7));
          solid.quad(F(ua, va, -D), F(ub, vb, -D), F(ub, vb, 0), F(ua, va, 0), wall);
          for (let i = 0; i < n; i++) {
            const t0 = (i + 0.08) / n, t1 = (i + 0.92) / n;
            const A = (t, y) => { const u = ua + (ub - ua) * t, v = va + (vb - va) * t; const L = Math.hypot(ub - ua, vb - va); const nu = (vb - va) / L, nv = -(ub - ua) / L; return F(u - nu * 0.15, v - nv * 0.15, y); };
            const topY = Math.min(-0.6, -D + 3.6 * s.levels);
            glassM.quad(A(t0, -D + 0.1), A(t1, -D + 0.1), A(t1, topY - 0.9), A(t0, topY - 0.9), shopGlass[Math.floor(rnd(i) * 4)]);
            solid.quad(A(t0, topY - 0.9), A(t1, topY - 0.9), A(t1, topY), A(t0, topY), signC[Math.floor(rnd(i + 9) * signC.length)]);
            solid.quad(A(t1, -D), A((i + 1.08) / n, -D), A((i + 1.08) / n, topY), A(t1, topY), frameC);
          }
        }
        // 大台阶（-u 端）：台阶 + 中间绿化带
        const nStep = Math.max(6, Math.round(D / 0.16));
        for (let k = 0; k < nStep; k++) {
          const u0 = -hl + (k / nStep) * stairL, u1 = -hl + ((k + 1) / nStep) * stairL;
          const y = -D * (k + 1) / nStep;
          solid.box(F, u0, u1, -hw, hw, -D, y, k & 1 ? stone : paveB, stone);
        }
        solid.box(F, -hl, -hl + stairL, -1.2, 1.2, -D, 0.35, c3('#8a8074'), green);
        if (s.terrace) {
          const nT = Math.max(3, Math.round(D / 0.9));
          for (let k = 0; k < nT; k++) {
            const u0 = hl - ((k + 1) / nT) * stairL, u1 = hl - (k / nT) * stairL;
            solid.box(F, u0, u1, -hw, hw, -D, -D * (k + 1) / nT, k & 1 ? wood : stone);
          }
        }
        if (s.escal) for (const v of [-hw * 0.55, hw * 0.55]) {
          solid.box(F, -hl + stairL, -hl + stairL + D * 1.8, v - 0.6, v + 0.6, -D, -D + 0.3, c3('#50565c'));
          const a = F(-hl + stairL, v - 0.6, -D + 0.3), b = F(-hl + stairL + D * 1.8, v - 0.6, 0.3), c = F(-hl + stairL + D * 1.8, v + 0.6, 0.3), d = F(-hl + stairL, v + 0.6, -D + 0.3);
          solid.quad(a, d, c, b, c3('#2f3337'));
        }
      }
      // 坑底地灯
      for (let k = 0; k < Math.max(4, Math.round(s.L / 8)); k++) {
        const u = -hl + stairL + 3 + k * 8;
        if (u > hl - 2) break;
        for (const v of [-hw + 1.2, hw - 1.2]) lampM.box(F, u - 0.15, u + 0.15, v - 0.15, v + 0.15, -D, -D + 0.9, c3('#ffe2a8'));
      }
      // 压顶（盖住洞口外缘：内侧面、顶面、外侧面压到地形以下）+ 玻璃栏杆
      const perim = s.round
        ? Array.from({ length: 49 }, (_, i) => { const a = (i / 48) * Math.PI * 2; return [Math.cos(a) * hl, Math.sin(a) * hw]; })
        : [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]];
      const out = (u, v, k) => { const l = Math.hypot(u, v) || 1; return s.round ? [u * (1 + k / l), v * (1 + k / l)] : [u + Math.sign(u) * k, v + Math.sign(v) * k]; };
      for (let i = 0; i + 1 < perim.length; i++) {
        const [ua, va] = perim[i], [ub, vb] = perim[i + 1];
        const [oa, oA] = out(ua, va, 0.6), [ob, oB] = out(ub, vb, 0.6);
        solid.quad(F(ua, va, -0.12), F(ub, vb, -0.12), F(ub, vb, 0.14), F(ua, va, 0.14), stone);
        solid.quad(F(ua, va, 0.14), F(ub, vb, 0.14), F(ob, oB, 0.14), F(oa, oA, 0.14), stone);
        solid.quad(F(oa, oA, -0.9), F(ob, oB, -0.9), F(ob, oB, 0.14), F(oa, oA, 0.14), stone);
        if (!s.round && ua === -hl && ub === -hl) continue; // 大台阶顶不设栏杆
        railM.quad(F(ua, va, 0.14), F(ub, vb, 0.14), F(ub, vb, 1.15), F(ua, va, 1.15), c3('#cfe3ea'));
        solid.quad(F(ua, va, 1.15), F(ub, vb, 1.15), F(ub, vb, 1.22), F(ua, va, 1.22), rail);
      }
      // 坑底：水景 / 舞台 / 外摆 / 树池
      const cu = s.round ? 0 : stairL / 2;
      if (s.water) waterM.quad(F(cu - hl * 0.25, -hw * 0.3, -D + 0.12), F(cu - hl * 0.25, hw * 0.3, -D + 0.12), F(cu + hl * 0.25, hw * 0.3, -D + 0.12), F(cu + hl * 0.25, -hw * 0.3, -D + 0.12), c3('#3b6f8c'));
      if (s.stage) solid.box(F, hl * 0.55, hl * 0.95, -hw * 0.45, hw * 0.45, -D, -D + 0.9, c3('#5a5048'), c3('#3a3531'));
      const nTab = s.bar ? Math.round((s.L * s.W) / 90) : Math.round((s.L * s.W) / 400);
      for (let i = 0; i < Math.min(60, nTab); i++) {
        const u = cu + (rnd(i * 3) - 0.5) * (s.L - stairL) * 0.8, v = (rnd(i * 3 + 1) - 0.5) * s.W * 0.8;
        if (s.water && Math.abs(u - cu) < hl * 0.3 && Math.abs(v) < hw * 0.35) continue;
        solid.box(F, u - 0.45, u + 0.45, v - 0.45, v + 0.45, -D, -D + 0.75, wood);
        if (s.bar) {
          solid.box(F, u - 0.04, u + 0.04, v - 0.04, v + 0.04, -D + 0.75, -D + 2.3, frameC);
          solid.box(F, u - 1.2, u + 1.2, v - 1.2, v + 1.2, -D + 2.3, -D + 2.45, umb[i % 3]);
        }
      }
      for (let i = 0; i < Math.round(s.L / 14); i++) {
        const u = -hl + stairL + 4 + i * 14, v = (i & 1 ? 1 : -1) * hw * 0.62;
        if (u > hl - 3) break;
        solid.box(F, u - 1.2, u + 1.2, v - 1.2, v + 1.2, -D, -D + 0.5, stone, c3('#4a3a2a'));
        solid.box(F, u - 0.15, u + 0.15, v - 0.15, v + 0.15, -D + 0.5, -D + 2.8, c3('#5b4632'));
        solid.box(F, u - 1.6, u + 1.6, v - 1.6, v + 1.6, -D + 2.8, -D + 5, green);
      }
      if (s.bar || s.stage || s.L * s.W > 1500) {
        for (let k = 0; k < 5; k++) {
          const u = -hl + stairL + ((k + 0.5) / 5) * (s.L - stairL);
          for (let t = 0; t <= 1; t += 2.5 / s.W) {
            const v = -hw + t * s.W, sag = Math.sin(t * Math.PI) * 1.2;
            lampM.box(F, u - 0.12, u + 0.12, v - 0.12, v + 0.12, -D + 4.2 - sag, -D + 4.45 - sag, c3('#ffd58a'));
          }
        }
      }
      const [lx, ly, lz] = F(cu, 0, -D + 3);
      ctx.lights.add({ position: new THREE.Vector3(lx, ly, lz), color: 0xffc27a, intensity: 3, distance: Math.max(s.L, s.W) * 0.9, nightOnly: true, priority: 1 });
      const lp = F(0, 0, 12);
      addLabel(s.name, new THREE.Vector3(lp[0], lp[1], lp[2]));
    }
    const matSolid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    const matGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.2, emissive: 0xffc890, emissiveIntensity: 0, side: THREE.DoubleSide });
    const matLamp = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffc070, emissiveIntensity: 0 });
    const matWater = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.4 });
    ctx.night.register(matGlass, { day: 0.05, night: 0.9 });
    ctx.night.register(matLamp, { day: 0, night: 2.4 });
    const matRail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    for (const [M, mat, name] of [[solid, matSolid, '下沉广场'], [glassM, matGlass, '商铺橱窗'], [lampM, matLamp, '串灯'], [waterM, matWater, '水景'], [railM, matRail, '玻璃栏杆']]) {
      const m = M.mesh(mat, name);
      if (m) root.add(m);
    }
    console.warn(`[sunken] ${this.sites?.length || 0} 处下沉广场（核验未通过 ${this.rejected?.length || 0} 处）`);
    const sites = this.sites || [], rejected = this.rejected || [];
    return {
      /** 诊断：已挖坑的坑口（世界坐标）、压顶高、坑底高；核验未通过的清单 */
      diag: () => ({
        pits: sites.map((s) => ({ name: s.name, kind: s.kind, rim: Array.from(s.rim), top: s.top, floor: s.top - (s.kind === 'liuyuan' ? 5.5 : s.depth) })),
        rejected,
      }),
      update() {},
      setLayer(layer, v) {
        if (layer !== 'buildings') return;
        root.visible = v;
        // 坑体随“建筑”图层隐藏时，地形洞也要合上，否则坑口透空（目前只有本模块调用 addHole，整体清零安全）
        ctx.terrain.holeU.n.value = v ? ctx.terrain.holes.length : 0;
      },
      dispose() { root.traverse((o) => o.geometry?.dispose()); ctx.scene.remove(root); },
    };
  },
};
