// 全城下沉广场：南门榴园（永宁门南广场下沉商业/酒吧街）、万众国际 WFive Park 下沉广场、钟鼓楼广场下沉广场、
// 大雁塔北广场、各商业综合体与地铁换乘站的下沉庭院……
// 数据：public/data/landmarks2026.json 的 sunken（tools/build_landmarks2026.py 由 research/refs/landmarks2026/sunken.json 生成：
//   中心、长宽、下沉深度、形状（矩形/圆形）、退台阶梯、水景、舞台、酒吧外摆、玻璃天窗、扶梯……）。
// 做法：prepare 里把地形在坑内压低到坑底（窄过渡带贴着挡墙），通用建筑/树木让位；build 生成坑底铺装、四周挡墙与环绕商铺
//   （玻璃橱窗夜间亮灯 + 店招带）、大台阶/退台看台、顶部玻璃栏杆、扶梯、水景/舞台/外摆桌椅/树池、夜间串灯。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';

const FEATHER = 4;
const OUT = 4;     // 压低范围超出挡墙的距离
const DECK = 10;   // 挡墙外地面铺装环宽度（≥ OUT + FEATHER）
const c3 = (h) => new THREE.Color(h);

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

/** 局部框架：u 沿长边、v 沿短边、y 相对坑顶地面 */
function frame(s, top) {
  const cu = Math.cos(s.rot), su = Math.sin(s.rot);
  return (u, v, y) => [s.x + u * cu - v * su, top + y, s.z + u * su + v * cu];
}

export default {
  id: 'sunken',
  name: '下沉广场',
  async prepare(ctx) {
    const raw = await loadJSON('landmarks2026.json', { optional: true });
    this.sites = [];
    for (const s of raw?.sunken || []) {
      // 与精建模块（W 酒店/万众国际等）重合时仍然做：下沉广场本身是它们没有的部分；只避开城墙/钟楼等古建本体
      const top = ctx.terrain.rawHeightAt(s.x, s.z);
      const F = frame(s, top);
      // 地形网格较粗：压低范围外扩到挡墙外 OUT 米，保证墙面前的地形完全落到坑底；墙外多压下去的一圈由 build 的地面铺装环盖住
      const hl = s.L / 2 + OUT, hw = s.W / 2 + OUT;
      let pts;
      if (s.round) {
        pts = [];
        for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2; const p = F(Math.cos(a) * hl, Math.sin(a) * hw, 0); pts.push(p[0], p[2]); }
      } else {
        pts = [F(-hl, -hw, 0), F(hl, -hw, 0), F(hl, hw, 0), F(-hl, hw, 0)].flatMap((p) => [p[0], p[2]]);
      }
      ctx.terrain.addFlatten({ points: pts, height: top - s.depth, feather: FEATHER, mode: 'min' });
      const E = DECK + 1;
      const outer = [F(-s.L / 2 - E, -s.W / 2 - E, 0), F(s.L / 2 + E, -s.W / 2 - E, 0), F(s.L / 2 + E, s.W / 2 + E, 0), F(-s.L / 2 - E, s.W / 2 + E, 0)].flatMap((p) => [p[0], p[2]]);
      ctx.exclusions.add({ points: outer, name: 'sunken' }, { buildings: true, trees: true, pois: false });
      this.sites.push({ ...s, top });
    }
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
    let lights = 0;
    for (const s of this.sites || []) {
      const F = frame(s, s.top);
      const D = s.depth, hl = s.L / 2, hw = s.W / 2;
      const rnd = (k) => ((Math.sin((s.x * 0.13 + s.z * 0.07 + k) * 12.9898) * 43758.5453) % 1 + 1) % 1;
      // 大台阶所在边：朝短边 -u（一端）；退台看台时两端都有
      const stairL = Math.min(s.L * 0.3, D * 2.2);
      // 坑底铺装（棋盘纹）
      const g = 6;
      for (let u = -hl; u < hl - 0.01; u += g) for (let v = -hw; v < hw - 0.01; v += g) {
        const u1 = Math.min(hl, u + g), v1 = Math.min(hw, v + g);
        solid.quad(F(u, v, -D + 0.04), F(u, v1, -D + 0.04), F(u1, v1, -D + 0.04), F(u1, v, -D + 0.04), ((Math.round(u / g) + Math.round(v / g)) & 1) ? pave : paveB);
      }
      if (s.round) {
        // 圆形：环形退台看台 + 一侧大台阶
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
        // 四周挡墙 + 环绕商铺（大台阶端除外）
        const sides = [
          [[-hl, -hw], [hl, -hw]], [[hl, -hw], [hl, hw]], [[hl, hw], [-hl, hw]],
        ];
        if (!s.terrace) sides.push([[-hl, hw], [-hl + 0, -hw]]);
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
        // 大台阶（-u 端）：台阶 + 两侧挡墙 + 中间绿化带
        const nStep = Math.max(6, Math.round(D / 0.16));
        for (let k = 0; k < nStep; k++) {
          const u0 = -hl + (k / nStep) * stairL, u1 = -hl + ((k + 1) / nStep) * stairL;
          const y = -D * (k + 1) / nStep;
          solid.box(F, u0, u1, -hw + 0.3, hw - 0.3, -D, y, k & 1 ? stone : paveB, stone);
        }
        solid.box(F, -hl, -hl + stairL, -1.2, 1.2, -D, 0.35, c3('#8a8074'), green);
        if (s.terrace) {
          // 退台看台（+u 端也做一组宽台阶座位）
          const nT = Math.max(3, Math.round(D / 0.9));
          for (let k = 0; k < nT; k++) {
            const u0 = hl - ((k + 1) / nT) * stairL, u1 = hl - (k / nT) * stairL;
            solid.box(F, u0, u1, -hw + 0.3, hw - 0.3, -D, -D * (k + 1) / nT, k & 1 ? wood : stone);
          }
        }
        if (s.escal) for (const v of [-hw * 0.55, hw * 0.55]) {
          solid.box(F, -hl + stairL, -hl + stairL + D * 1.8, v - 0.6, v + 0.6, -D, -D + 0.3, c3('#50565c'));
          const a = F(-hl + stairL, v - 0.6, -D + 0.3), b = F(-hl + stairL + D * 1.8, v - 0.6, 0.3), c = F(-hl + stairL + D * 1.8, v + 0.6, 0.3), d = F(-hl + stairL, v + 0.6, -D + 0.3);
          solid.quad(a, d, c, b, c3('#2f3337'));
        }
      }
      // 挡墙外地面铺装环（盖住外扩压低的地形）
      {
        const deckC = c3('#bdb5a8');
        if (s.round) {
          for (let i = 0; i < 48; i++) {
            const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2;
            const P = (a, k, y) => F(Math.cos(a) * (hl + k), Math.sin(a) * (hw + k), y);
            solid.quad(P(a0, 0, 0.03), P(a1, 0, 0.03), P(a1, DECK, 0.03), P(a0, DECK, 0.03), deckC);
            solid.quad(P(a0, DECK, 0.03), P(a1, DECK, 0.03), P(a1, DECK, -OUT - 3), P(a0, DECK, -OUT - 3), deckC);
          }
        } else {
          const X = hl + DECK, Z = hw + DECK;
          for (const [a, b, c, d] of [
            [[-X, -Z], [X, -Z], [X, -hw], [-X, -hw]], [[-X, hw], [X, hw], [X, Z], [-X, Z]],
            [[-X, -hw], [-hl, -hw], [-hl, hw], [-X, hw]], [[hl, -hw], [X, -hw], [X, hw], [hl, hw]],
          ]) solid.quad(F(...a, 0.03), F(...b, 0.03), F(...c, 0.03), F(...d, 0.03), deckC);
          // 铺装环外缘向下的裙边（外缘地形若略低，不露缝）
          for (const [[ua, va], [ub, vb]] of [[[-X, -Z], [X, -Z]], [[X, -Z], [X, Z]], [[X, Z], [-X, Z]], [[-X, Z], [-X, -Z]]])
            solid.quad(F(ua, va, 0.03), F(ub, vb, 0.03), F(ub, vb, -3), F(ua, va, -3), deckC);
        }
      }
      // 坑底地灯（沿挡墙内侧，夜间点亮）
      for (let k = 0; k < Math.max(4, Math.round(s.L / 8)); k++) {
        const u = -hl + stairL + 3 + k * 8;
        if (u > hl - 2) break;
        for (const v of [-hw + 1.2, hw - 1.2]) lampM.box(F, u - 0.15, u + 0.15, v - 0.15, v + 0.15, -D, -D + 0.9, c3('#ffe2a8'));
      }
      // 顶部玻璃栏杆 + 压顶
      const perim = s.round
        ? Array.from({ length: 49 }, (_, i) => { const a = (i / 48) * Math.PI * 2; return [Math.cos(a) * hl, Math.sin(a) * hw]; })
        : [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]];
      for (let i = 0; i + 1 < perim.length; i++) {
        const [ua, va] = perim[i], [ub, vb] = perim[i + 1];
        solid.quad(F(ua, va, 0.02), F(ub, vb, 0.02), F(ub, vb, 0.25), F(ua, va, 0.25), stone);
        railM.quad(F(ua, va, 0.25), F(ub, vb, 0.25), F(ub, vb, 1.15), F(ua, va, 1.15), c3('#cfe3ea'));
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
      // 夜间串灯：长边之间来回拉线，每 2.5 m 一颗灯泡
      if (s.bar || s.stage || s.L * s.W > 1500) {
        for (let k = 0; k < 5; k++) {
          const u = -hl + stairL + ((k + 0.5) / 5) * (s.L - stairL);
          for (let t = 0; t <= 1; t += 2.5 / s.W) {
            const v = -hw + t * s.W, sag = Math.sin(t * Math.PI) * 1.2;
            lampM.box(F, u - 0.12, u + 0.12, v - 0.12, v + 0.12, -D + 4.2 - sag, -D + 4.45 - sag, c3('#ffd58a'));
          }
        }
      }
      // 暖光点光源（灯光池限量）
      const [lx, ly, lz] = F(cu, 0, -D + 3);
      ctx.lights.add({ position: new THREE.Vector3(lx, ly, lz), color: 0xffc27a, intensity: 3, distance: Math.max(s.L, s.W) * 0.9, nightOnly: true, priority: 1 });
      lights++;
      const lp = F(0, 0, 12);
      ctx.labels.add(s.name.replace(/（.*?）|\(.*?\)/g, ''), new THREE.Vector3(lp[0], lp[1], lp[2]), { category: 'landmark', sub: '下沉广场', priority: 1.5, minDist: 40, maxDist: 3000 });
    }
    const matSolid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    const matGlass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.75, emissive: 0xffc890, emissiveIntensity: 0, side: THREE.DoubleSide });
    const matLamp = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffc070, emissiveIntensity: 0 });
    const matWater = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.4 });
    ctx.night.register(matGlass, { day: 0.05, night: 0.9 });
    ctx.night.register(matLamp, { day: 0, night: 2.4 });
    const matRail = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    for (const [M, mat, name] of [[solid, matSolid, '下沉广场'], [glassM, matGlass, '商铺橱窗'], [lampM, matLamp, '串灯'], [waterM, matWater, '水景'], [railM, matRail, '玻璃栏杆']]) {
      const m = M.mesh(mat, name);
      if (m) root.add(m);
    }
    console.warn(`[sunken] ${this.sites?.length || 0} 处下沉广场`);
    return {
      update() {},
      setLayer(layer, v) { if (layer === 'buildings') root.visible = v; },
      dispose() { root.traverse((o) => o.geometry?.dispose()); ctx.scene.remove(root); },
    };
  },
};
