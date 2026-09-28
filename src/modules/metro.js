// 西安地铁地下网络：全部已开通线路的隧道（按官方线路色）、车站（站台层 + 站厅层 + 屏蔽门 + 站名）、出入口通道、运行中的列车；
// 两种浏览方式：
//   · 透视俯视（X 键 / 面板按钮）：城市压暗，地铁线网按官方色发光叠加在最上层，车站圆点 + 站名，一键飞到正上方俯视；
//   · 进入地下（U 键 / 面板按钮）：隐藏地面世界，传送到最近车站的站台，步行（G）或飞行在站台、站厅、隧道、出入口通道里浏览。
// 数据：public/data/metro.json（tools/build_metro.py：OSM 地铁线与 layer、pois 出入口聚类成站，可叠加调研清单与高德线路）。
// 地下部分全部用无光照材质 + 顶点色“烘焙”照明（地下不受日照/昼夜影响，夜里也亮），不参与雾。
import * as THREE from 'three';
import { loadJSON } from '../core/data.js';

const PLAT_L = 124;   // 站台长（B 型车 6 节编组约 120 m）
const HALL_L = 150;   // 车站主体长
const HALL_W = 22;    // 车站主体宽（岛式站台 12 m + 两侧轨行区）
const PLAT_W = 12;
const PLAT_H = 1.05;  // 站台面高出轨面
const LVL_H = 4.6;    // 站台层净高
const SLAB = 0.8;
const CONC_H = 5.2;   // 站厅层净高
const TUN_STEP = 20;

const c3 = (hex) => new THREE.Color(hex);

/** 顶点色网格拼装器：quad(四点, 颜色或四色) → 非索引三角形 */
class Mesher {
  constructor() { this.pos = []; this.col = []; this.uv = []; }
  tri(a, b, c, ca, cb, cc) {
    this.pos.push(...a, ...b, ...c);
    this.col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
  }
  quad(a, b, c, d, ca, cb = ca, cc = cb, cd = ca) {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }
  /** 轴对齐于局部框架的长方体（只画内/外六个面，双面材质） */
  box(F, u0, u1, v0, v1, y0, y1, col, top = col) {
    const P = (u, v, y) => F(u, v, y);
    const [a, b, c, d] = [P(u0, v0, y0), P(u1, v0, y0), P(u1, v1, y0), P(u0, v1, y0)];
    const [e, f, g, h] = [P(u0, v0, y1), P(u1, v0, y1), P(u1, v1, y1), P(u0, v1, y1)];
    this.quad(e, f, g, h, top);
    this.quad(a, b, f, e, col); this.quad(b, c, g, f, col); this.quad(c, d, h, g, col); this.quad(d, a, e, h, col);
  }
  build(mat, name) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    return m;
  }
}

/** 站名贴图集：每个站名一格（站名 + 线路色块） */
function nameAtlas(stations, lineColor) {
  const CW = 512, CH = 96, COLS = 8;
  const rows = Math.ceil(stations.length / COLS);
  const cv = document.createElement('canvas');
  cv.width = CW * COLS;
  cv.height = Math.min(8192, THREE.MathUtils.ceilPowerOfTwo(Math.max(CH, rows * CH)));
  const g = cv.getContext('2d');
  const cells = new Map();
  stations.forEach((s, i) => {
    const x = (i % COLS) * CW, y = Math.floor(i / COLS) * CH;
    if (y + CH > cv.height) return;
    g.fillStyle = '#16324f';
    g.fillRect(x, y, CW, CH);
    let bx = x + 12;
    for (const l of s.lines) {
      g.fillStyle = lineColor(l.num);
      g.fillRect(bx, y + 18, 60, 60);
      g.fillStyle = '#fff';
      g.font = 'bold 40px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(l.num), bx + 30, y + 49);
      bx += 68;
    }
    g.fillStyle = '#ffffff';
    g.font = `bold ${s.n.length > 6 ? 40 : 52}px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(s.n, bx + 10, y + CH / 2 + 2, CW - (bx - x) - 20);
    cells.set(s, [x / cv.width, 1 - (y + CH) / cv.height, (x + CW) / cv.width, 1 - y / cv.height]);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.flipY = true;
  return { tex, cells };
}

export default {
  id: 'metro',
  name: '地铁地下网络',
  async build(ctx) {
    const D = await loadJSON('metro.json', { optional: true });
    const root = new THREE.Group();
    root.name = 'metro';
    root.visible = false;
    ctx.scene.add(root);
    const stub = { update() {}, setLayer() {}, api: {}, dispose() { ctx.scene.remove(root); } };
    if (!D || !D.lines?.length) return stub;
    const H = (x, z) => ctx.terrain.heightAt(x, z);
    const colorOf = new Map(D.lines.map((l) => [l.num, l.color]));
    const lineColor = (n) => colorOf.get(n) || '#9aa4b0';

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false });
    const glass = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false, transparent: true, opacity: 0.32, depthWrite: false });

    // —— 车站框架（每站每线一个站体） ——
    const boxes = []; // {s, l, cx, cz, ux, uz, yR, F}
    for (const s of D.stations) for (const l of s.lines) {
      if (!(l.d > 0)) continue; // 高架/地面站由地面铁路模块表现
      const ux = l.dx, uz = l.dz, vx = -uz, vz = ux;
      const g0 = H(l.x, l.z);
      const yR = g0 - l.d;
      const F = (u, v, y) => [l.x + ux * u + vx * v, yR + y, l.z + uz * u + vz * v];
      boxes.push({ s, l, cx: l.x, cz: l.z, ux, uz, vx, vz, yR, g0, F });
    }
    const inBox = (x, z, pad = 0) => {
      for (const b of boxes) {
        const dx = x - b.cx, dz = z - b.cz;
        if (Math.abs(dx) > 120 || Math.abs(dz) > 120) continue;
        const u = dx * b.ux + dz * b.uz, v = dx * b.vx + dz * b.vz;
        if (Math.abs(u) < HALL_L / 2 + pad && Math.abs(v) < HALL_W / 2 + pad) return b;
      }
      return null;
    };

    // —— 隧道 ——
    const tun = new Mesher();
    const RING = [[-2.2, 0], [2.2, 0], [2.7, 1.5], [2.6, 3.2], [1.6, 4.6], [0, 5.0], [-1.6, 4.6], [-2.6, 3.2], [-2.7, 1.5]];
    const tunSegs = []; // 步行地面查询：[ax, az, ay, bx, bz, by]
    const conc = c3('#7d8185'), dark = c3('#3a3c3f'), lamp = c3('#fff3d6'), rail = c3('#55575a');
    const paths = []; // 列车路径 {num, pts:[[x,y,z,under]], cum}
    for (const L of D.lines) {
      const lc = c3(L.color);
      const ringCol = RING.map((_, i) => (i === 5 ? lamp : i === 2 || i === 8 ? lc : i < 2 ? rail : i === 4 || i === 6 ? conc.clone().lerp(lamp, 0.35) : conc));
      for (const p of L.paths) {
        // 重采样
        const S = [];
        for (let i = 0; i + 5 < p.length; i += 3) {
          const ax = p[i], az = p[i + 1], ad = p[i + 2], bx = p[i + 3], bz = p[i + 4], bd = p[i + 5];
          const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / TUN_STEP));
          for (let k = 0; k < n; k++) {
            const t = k / n;
            S.push([ax + (bx - ax) * t, az + (bz - az) * t, ad + (bd - ad) * t]);
          }
        }
        S.push([p[p.length - 3], p[p.length - 2], p[p.length - 1]]);
        // 轨面高程：地面高程 − 埋深，前后平滑（地形起伏不传给轨道）
        const raw = S.map(([x, z, d]) => (d > 0 ? H(x, z) - d : H(x, z) + 0.5));
        const ys = raw.map((_, i) => {
          let s = 0, n = 0;
          for (let k = Math.max(0, i - 4); k <= Math.min(raw.length - 1, i + 4); k++) { s += raw[k]; n++; }
          return s / n;
        });
        const pts = S.map(([x, z, d], i) => [x, ys[i], z, d > 0]);
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
        paths.push({ num: L.num, color: L.color, pts, cum });
        // 隧道环
        let prev = null;
        for (let i = 0; i < pts.length; i++) {
          const [x, y, z, under] = pts[i];
          const j = Math.min(pts.length - 1, i + 1), h = Math.max(0, i - 1);
          let dx = pts[j][0] - pts[h][0], dz = pts[j][2] - pts[h][2];
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl; dz /= dl;
          const vx = -dz, vz = dx;
          const ok = under && !inBox(x, z);
          const ring = ok ? RING.map(([v, hh]) => [x + vx * v, y - 0.3 + hh, z + vz * v]) : null;
          if (ring && prev) {
            for (let k = 0; k < RING.length; k++) {
              const k2 = (k + 1) % RING.length;
              tun.quad(prev[k], ring[k], ring[k2], prev[k2], ringCol[k], ringCol[k], ringCol[k2], ringCol[k2]);
            }
            tunSegs.push([pts[i - 1][0], pts[i - 1][2], pts[i - 1][1], x, z, y]);
          }
          prev = ring;
        }
      }
    }
    const tunMesh = tun.build(mat, '地铁隧道');
    if (tunMesh) root.add(tunMesh);

    // —— 车站 ——
    const st = new Mesher(), gl = new Mesher();
    const floorC = c3('#cfcac0'), wallC = c3('#e7e4dc'), ceilC = c3('#b9bcc0'), colC = c3('#dcd8cf'), trackC = c3('#45474a');
    const lightC = c3('#ffffff'), gateC = c3('#8c939a'), stairC = c3('#a8a49c');
    for (const b of boxes) {
      const F = b.F, lc = c3(lineColor(b.l.num));
      const hl = HALL_L / 2, hw = HALL_W / 2, pl = PLAT_L / 2, pw = PLAT_W / 2;
      const yTop = PLAT_H + LVL_H, yC0 = yTop + SLAB, yC1 = yC0 + CONC_H;
      // 站台层：轨行区地面、岛式站台、侧墙（带线路色腰线）、顶棚、端墙
      st.box(F, -hl, hl, -hw, hw, -0.6, -0.5, trackC);
      st.box(F, -pl, pl, -pw, pw, -0.5, PLAT_H, c3('#9c978d'), floorC);
      st.quad(F(-hl, -hw, -0.5), F(hl, -hw, -0.5), F(hl, -hw, yTop), F(-hl, -hw, yTop), wallC, wallC, wallC.clone().multiplyScalar(0.85), wallC.clone().multiplyScalar(0.85));
      st.quad(F(-hl, hw, -0.5), F(hl, hw, -0.5), F(hl, hw, yTop), F(-hl, hw, yTop), wallC, wallC, wallC.clone().multiplyScalar(0.85), wallC.clone().multiplyScalar(0.85));
      for (const v of [-hw + 0.02, hw - 0.02]) st.quad(F(-hl, v, 2.2), F(hl, v, 2.2), F(hl, v, 2.8), F(-hl, v, 2.8), lc);
      st.quad(F(-hl, -hw, yTop), F(hl, -hw, yTop), F(hl, hw, yTop), F(-hl, hw, yTop), ceilC);
      for (const u of [-hl, hl]) st.quad(F(u, -hw, -0.5), F(u, hw, -0.5), F(u, hw, yC1), F(u, -hw, yC1), wallC.clone().multiplyScalar(0.8));
      // 站台柱列、灯带、屏蔽门（玻璃 + 线路色门楣）
      for (let u = -pl + 6; u <= pl - 6; u += 9) for (const v of [-2.6, 2.6]) st.box(F, u - 0.45, u + 0.45, v - 0.45, v + 0.45, PLAT_H, yTop, colC);
      for (const v of [-4.2, 0, 4.2]) st.quad(F(-pl, v - 0.35, yTop - 0.05), F(pl, v - 0.35, yTop - 0.05), F(pl, v + 0.35, yTop - 0.05), F(-pl, v + 0.35, yTop - 0.05), lightC);
      for (const v of [-pw, pw]) {
        gl.quad(F(-pl, v, PLAT_H), F(pl, v, PLAT_H), F(pl, v, PLAT_H + 2.3), F(-pl, v, PLAT_H + 2.3), c3('#bfe3f2'));
        st.quad(F(-pl, v, PLAT_H + 2.3), F(pl, v, PLAT_H + 2.3), F(pl, v, PLAT_H + 2.75), F(-pl, v, PLAT_H + 2.75), lc);
        for (let u = -pl; u <= pl; u += 4.2) st.box(F, u - 0.06, u + 0.06, v - 0.06, v + 0.06, PLAT_H, PLAT_H + 2.3, gateC);
      }
      // 楼梯/扶梯（站台中部两组，通往站厅）
      for (const u0 of [-30, 18]) {
        const a = F(u0, -1.6, PLAT_H), bb = F(u0 + 12, -1.6, yC0), c = F(u0 + 12, 1.6, yC0), d = F(u0, 1.6, PLAT_H);
        st.quad(a, bb, c, d, stairC);
        for (const v of [-1.6, 1.6]) st.quad(F(u0, v, PLAT_H), F(u0 + 12, v, yC0), F(u0 + 12, v, yC0 + 1.1), F(u0, v, PLAT_H + 1.1), c3('#6f757b'));
      }
      // 站厅层：楼板、地面、顶棚灯格、闸机、侧墙
      st.box(F, -hl, hl, -hw, hw, yTop, yC0, ceilC, floorC);
      st.quad(F(-hl, -hw, yC1), F(hl, -hw, yC1), F(hl, hw, yC1), F(-hl, hw, yC1), ceilC);
      for (let u = -hl + 8; u < hl - 4; u += 12) for (const v of [-6, 0, 6]) st.quad(F(u - 2, v - 1, yC1 - 0.05), F(u + 2, v - 1, yC1 - 0.05), F(u + 2, v + 1, yC1 - 0.05), F(u - 2, v + 1, yC1 - 0.05), lightC);
      for (const v of [-hw, hw]) st.quad(F(-hl, v, yC0), F(hl, v, yC0), F(hl, v, yC1), F(-hl, v, yC1), wallC);
      for (const u of [-44, 44]) for (let v = -8; v <= 8; v += 1.6) st.box(F, u - 0.9, u + 0.9, v - 0.15, v + 0.15, yC0, yC0 + 1.0, gateC, c3('#2f3439'));
      // 顶板（覆土下的结构顶，透视/外部观看时的外壳）
      st.quad(F(-hl, -hw, yC1 + 0.8), F(hl, -hw, yC1 + 0.8), F(hl, hw, yC1 + 0.8), F(-hl, hw, yC1 + 0.8), c3('#6d6a64'));
      b.levels = { plat: PLAT_H, conc: yC0 };
    }
    // —— 出入口通道：站厅 → 地面出入口（水平段 + 末段斜坡） ——
    const pass = new Mesher();
    const exitsLog = [];
    for (const s of D.stations) {
      const bs = boxes.filter((b) => b.s === s);
      if (!bs.length) continue;
      const b = bs.reduce((a, c) => (c.yR > a.yR ? c : a)); // 最浅的站体
      const yC0 = b.yR + PLAT_H + LVL_H + SLAB;
      for (const [ex, ez] of s.exits || []) {
        const dx = ex - b.cx, dz = ez - b.cz, dist = Math.hypot(dx, dz);
        if (dist < 20 || dist > 420) continue;
        const ux = dx / dist, uz = dz / dist, vx = -uz, vz = ux;
        const g1 = H(ex, ez);
        const rise = g1 - yC0;
        const ramp = Math.max(12, Math.min(dist * 0.6, rise * 1.9));
        const m0 = Math.max(10, dist - ramp);
        const W = 2.4, HH = 3.4;
        const sec = [[0, yC0], [m0, yC0], [dist, g1 - 0.2]];
        for (let k = 0; k < 2; k++) {
          const [s0, y0] = sec[k], [s1, y1] = sec[k + 1];
          const P = (s_, v, y) => [b.cx + ux * s_ + vx * v, y, b.cz + uz * s_ + vz * v];
          pass.quad(P(s0, -W, y0), P(s1, -W, y1), P(s1, W, y1), P(s0, W, y0), floorC);
          pass.quad(P(s0, -W, y0 + HH), P(s1, -W, y1 + HH), P(s1, W, y1 + HH), P(s0, W, y0 + HH), ceilC);
          for (const v of [-W, W]) pass.quad(P(s0, v, y0), P(s1, v, y1), P(s1, v, y1 + HH), P(s0, v, y0 + HH), wallC);
          pass.quad(P(s0, -0.4, y0 + HH - 0.04), P(s1, -0.4, y1 + HH - 0.04), P(s1, 0.4, y1 + HH - 0.04), P(s0, 0.4, y0 + HH - 0.04), lightC);
        }
        exitsLog.push([b, ux, uz, m0, dist, yC0, g1]);
      }
    }
    for (const [m, n] of [[st.build(mat, '地铁车站'), 0], [gl.build(glass, '屏蔽门'), 1], [pass.build(mat, '出入口通道'), 0]]) if (m) { m.renderOrder = n; root.add(m); }

    // —— 站名牌（站台侧墙每 24 m 一块、站厅两端） ——
    const { tex, cells } = nameAtlas(D.stations, lineColor);
    const sp = [], su = [];
    const signQuad = (a, b, c, d, r) => {
      sp.push(...a, ...b, ...c, ...a, ...c, ...d);
      su.push(r[0], r[1], r[2], r[1], r[2], r[3], r[0], r[1], r[2], r[3], r[0], r[3]);
    };
    for (const b of boxes) {
      const r = cells.get(b.s);
      if (!r) continue;
      const F = b.F, hw = HALL_W / 2 - 0.05;
      for (let u = -PLAT_L / 2 + 10; u <= PLAT_L / 2 - 10; u += 24) {
        signQuad(F(u + 3.2, -hw, 3.1), F(u - 3.2, -hw, 3.1), F(u - 3.2, -hw, 4.3), F(u + 3.2, -hw, 4.3), r);
        signQuad(F(u - 3.2, hw, 3.1), F(u + 3.2, hw, 3.1), F(u + 3.2, hw, 4.3), F(u - 3.2, hw, 4.3), r);
      }
      const yC = PLAT_H + LVL_H + SLAB;
      for (const [u, sgn] of [[-HALL_L / 2 + 0.05, 1], [HALL_L / 2 - 0.05, -1]]) {
        signQuad(F(u, 4 * sgn, yC + 2.6), F(u, -4 * sgn, yC + 2.6), F(u, -4 * sgn, yC + 4.1), F(u, 4 * sgn, yC + 4.1), r);
      }
    }
    if (sp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, fog: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      m.name = '站名牌';
      root.add(m);
    }

    // —— 列车（6 节编组，车体 + 线路色腰带 + 亮窗） ——
    const trainGeo = (() => {
      const m = new Mesher();
      const body = c3('#e9ecef'), win = c3('#fff4cf'), under = c3('#3a3d40');
      const F = (u, v, y) => [u, y, v];
      m.box(F, -9.4, 9.4, -1.4, 1.4, 0.35, 0.9, under);
      m.box(F, -9.4, 9.4, -1.4, 1.4, 0.9, 3.7, body);
      for (const v of [-1.41, 1.41]) m.quad(F(-8.8, v, 1.9), F(8.8, v, 1.9), F(8.8, v, 2.9), F(-8.8, v, 2.9), win);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
      return g;
    })();
    const stripeGeo = new THREE.BoxGeometry(18.8, 0.35, 2.84).translate(0, 1.55, 0);
    const trains = [];
    for (const P of paths) {
      const L = P.cum[P.cum.length - 1];
      if (L < 1500 || !P.pts.some((p) => p[3])) continue;
      const n = Math.max(1, Math.round(L / 3500));
      for (let k = 0; k < n; k++) for (const dir of [1, -1]) trains.push({ P, L, s0: (k / n) * 2 * L + (dir < 0 ? L * 0.37 : 0), dir, v: 19 + ((k * 7) % 5) });
    }
    const CARS = 6;
    const nInst = Math.max(1, trains.length * CARS);
    const bodyIM = new THREE.InstancedMesh(trainGeo, mat, nInst);
    const stripeIM = new THREE.InstancedMesh(stripeGeo, new THREE.MeshBasicMaterial({ fog: false }), nInst);
    bodyIM.frustumCulled = stripeIM.frustumCulled = false;
    bodyIM.name = '地铁列车';
    trains.forEach((t, i) => { for (let c = 0; c < CARS; c++) stripeIM.setColorAt(i * CARS + c, c3(t.P.color)); });
    root.add(bodyIM, stripeIM);
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    const at = (P, s) => {
      const c = P.cum;
      let lo = 0, hi = c.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
      const a = P.pts[lo], b = P.pts[hi], t = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, b[0] - a[0], b[2] - a[2], a[3] && b[3]];
    };
    const updateTrains = (time) => {
      trains.forEach((t, i) => {
        // 往返运行：0..L 正向，L..2L 反向；进站（车站中心 ±60 m）减速停靠效果用速度调制近似
        let s = (t.s0 + time * t.v) % (2 * t.L);
        let dir = 1;
        if (s > t.L) { s = 2 * t.L - s; dir = -1; }
        for (let c = 0; c < CARS; c++) {
          const sc = Math.min(t.L, Math.max(0, s - dir * c * 19.6));
          const [x, y, z, dx, dz, under] = at(t.P, sc);
          const dl = Math.hypot(dx, dz) || 1;
          const off = 2.2 * dir; // 上下行各走一侧
          _p.set(x - (dz / dl) * off, y, z + (dx / dl) * off);
          _q.setFromAxisAngle(_up, Math.atan2(-dz, dx));
          _s.setScalar(under ? 1 : 0);
          _m.compose(_p, _q, _s);
          bodyIM.setMatrixAt(i * CARS + c, _m);
          stripeIM.setMatrixAt(i * CARS + c, _m);
        }
      });
      bodyIM.instanceMatrix.needsUpdate = stripeIM.instanceMatrix.needsUpdate = true;
    };

    // —— 透视俯视叠加层：压暗城市 + 发光线网 + 车站圆点 ——
    const xray = new THREE.Group();
    xray.name = 'metro-xray';
    xray.visible = false;
    ctx.scene.add(xray);
    const dim = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(0.01, 0.02, 0.05, 0.62); }',
    }));
    dim.frustumCulled = false;
    dim.renderOrder = 990;
    xray.add(dim);
    const uW = { value: 20 };
    const ribbonMat = new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, vertexColors: true,
      uniforms: { uW },
      vertexShader: `attribute vec3 aSide; attribute float aDash; varying vec3 vC; varying float vD;
        void main(){ vC = color; vD = aDash; vec3 p = position + aSide * uW; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`.replace('attribute vec3 aSide;', 'uniform float uW; attribute vec3 aSide;'),
      fragmentShader: `varying vec3 vC; varying float vD;
        void main(){ float a = vD > 0.5 ? 0.95 : (mod(gl_FragCoord.x + gl_FragCoord.y, 10.0) < 5.0 ? 0.9 : 0.35); gl_FragColor = vec4(vC * 1.25, a); }`,
    });
    {
      const pos = [], side = [], col = [], dash = [];
      for (const P of paths) {
        const cc = c3(P.color);
        for (let i = 1; i < P.pts.length; i++) {
          const a = P.pts[i - 1], b = P.pts[i];
          const dx = b[0] - a[0], dz = b[2] - a[2], dl = Math.hypot(dx, dz) || 1;
          const nx = -dz / dl, nz = dx / dl;
          const ya = H(a[0], a[2]) + 4, yb = H(b[0], b[2]) + 4;
          const q = [[a[0], ya, a[2], -1], [b[0], yb, b[2], -1], [b[0], yb, b[2], 1], [a[0], ya, a[2], 1]];
          for (const k of [0, 1, 2, 0, 2, 3]) {
            pos.push(q[k][0], q[k][1], q[k][2]);
            side.push(nx * q[k][3], 0, nz * q[k][3]);
            col.push(cc.r, cc.g, cc.b);
            dash.push(a[3] && b[3] ? 1 : 0); // 地下实线，高架/地面段虚线
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('aDash', new THREE.Float32BufferAttribute(dash, 1));
      const m = new THREE.Mesh(g, ribbonMat);
      m.frustumCulled = false;
      m.renderOrder = 995;
      xray.add(m);
    }
    {
      const pos = [], col = [], size = [];
      for (const s of D.stations) {
        pos.push(s.x, H(s.x, s.z) + 6, s.z);
        const tr = s.lines.length > 1;
        const cc = tr ? c3('#ffffff') : c3(lineColor(s.lines[0].num));
        col.push(cc.r, cc.g, cc.b);
        size.push(tr ? 15 : 10);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
      const m = new THREE.Points(g, new THREE.ShaderMaterial({
        transparent: true, depthTest: false, depthWrite: false, vertexColors: true,
        vertexShader: 'attribute float aSize; varying vec3 vC; void main(){ vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize; }',
        fragmentShader: 'varying vec3 vC; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; vec3 c = r > 0.62 ? vec3(0.08, 0.1, 0.14) : vec3(1.0); if (r < 0.62 && r > 0.4) c = vC; gl_FragColor = vec4(c, 1.0); }',
      }));
      m.frustumCulled = false;
      m.renderOrder = 996;
      xray.add(m);
    }
    for (const s of D.stations) {
      ctx.labels.add(s.n, new THREE.Vector3(s.x, H(s.x, s.z) + 8, s.z), {
        category: 'metrox', sub: s.lines.map((l) => `${l.num}号线`).join(' · '),
        priority: s.lines.length > 1 ? 1.6 : 1.0, minDist: 0, maxDist: 60000,
      });
    }
    ctx.labels.hidden.add('metrox');

    // —— 模式切换 ——
    const state = { xray: false, under: false, saved: null, hidden: [], floorY: null };
    const setXray = (on, fly = true) => {
      if (on === state.xray) return;
      state.xray = on;
      xray.visible = on;
      on ? ctx.labels.hidden.delete('metrox') : ctx.labels.hidden.add('metrox');
      const C = ctx.controls, cam = ctx.camera;
      if (!C || !fly) return;
      if (on) {
        state.saved = { p: cam.position.clone(), q: cam.quaternion.clone() };
        // 视线与地面交点（或相机正下方）作为俯视中心；高度按城区尺度
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        let tx = cam.position.x, tz = cam.position.z;
        if (dir.y < -0.05) { const t = (cam.position.y - H(tx, tz)) / -dir.y; tx += dir.x * Math.min(t, 20000); tz += dir.z * Math.min(t, 20000); }
        const h = Math.max(9000, Math.min(26000, cam.position.y - H(tx, tz) + 6000));
        C.flyTo(new THREE.Vector3(tx, H(tx, tz) + h, tz + 1), new THREE.Vector3(tx, H(tx, tz), tz), { duration: 2.2 });
      } else if (state.saved) {
        const s = state.saved;
        const tgt = new THREE.Vector3(0, 0, -100).applyQuaternion(s.q).add(s.p);
        C.flyTo(s.p, tgt, { duration: 1.8 });
        state.saved = null;
      }
    };
    const floorAt = (x, z, y) => {
      const b = inBox(x, z, 0.5);
      if (b) {
        const dx = x - b.cx, dz = z - b.cz, v = Math.abs(dx * b.vx + dz * b.vz);
        const yC = b.yR + b.levels.conc;
        if (y > yC - 0.5) return yC;                       // 站厅层
        return v < PLAT_W / 2 ? b.yR + PLAT_H : b.yR - 0.5; // 站台 / 轨行区
      }
      // 出入口通道
      for (const [bb, ux, uz, m0, dist, yC0, g1] of exitsLog) {
        const dx = x - bb.cx, dz = z - bb.cz, s = dx * ux + dz * uz, v = Math.abs(-dx * uz + dz * ux);
        if (v < 2.6 && s > 0 && s < dist) {
          const yy = s < m0 ? yC0 : yC0 + (g1 - 0.2 - yC0) * ((s - m0) / (dist - m0));
          if (Math.abs(yy - (y - 1.7)) < 4) return yy;
        }
      }
      // 隧道
      let best = null, bd = 6;
      for (const [ax, az, ay, bx, bz, by] of tunSegs) {
        if (Math.abs(ax - x) > 30 || Math.abs(az - z) > 30) continue;
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
        const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
        if (d < bd) { bd = d; best = ay + (by - ay) * t - 0.3; }
      }
      return best;
    };
    const setUnder = (on, station = null) => {
      if (on === state.under) return;
      const C = ctx.controls, cam = ctx.camera;
      if (on) {
        setXray(false, false);
        let b = null;
        if (station) b = boxes.find((q) => q.s === station) || null;
        if (!b) {
          let bd = Infinity;
          for (const q of boxes) { const d = Math.hypot(q.cx - cam.position.x, q.cz - cam.position.z); if (d < bd) { bd = d; b = q; } }
        }
        if (!b) return;
        state.under = true;
        state.surface = { p: cam.position.clone(), q: cam.quaternion.clone() };
        state.hidden = [];
        for (const o of ctx.scene.children) if (o !== root && o.visible && !o.isLight && !o.isCamera) { o.visible = false; state.hidden.push(o); }
        root.visible = true;
        state.labelsWere = ctx.labels.visible;
        ctx.labels.setVisible(false);
        if (C) {
          C.tween = null;
          C.groundFn = (x, z, y) => floorAt(x, z, y);
          C.setMode('walk');
          cam.position.set(b.cx + b.vx * 2, b.yR + PLAT_H + C.eye, b.cz + b.vz * 2);
          C.yaw = Math.atan2(-b.ux, -b.uz);
          C.pitch = 0;
        }
        state.station = b.s.n;
      } else {
        state.under = false;
        for (const o of state.hidden) o.visible = true;
        state.hidden = [];
        root.visible = false;
        ctx.labels.setVisible(state.labelsWere !== false);
        if (C) {
          C.groundFn = null;
          C.setMode('fly');
          const p = cam.position;
          cam.position.set(p.x, H(p.x, p.z) + 60, p.z);
          C.pitch = -0.35;
        }
      }
    };

    const api = {
      setXray, setUnder,
      get xray() { return state.xray; },
      get underground() { return state.under; },
      get station() { return state.station; },
      stations: D.stations, lines: D.lines,
    };
    ctx.metro = api;
    console.warn(`[metro] ${D.lines.length} 条线，${D.stations.length} 站（地下站体 ${boxes.length}），出入口通道 ${exitsLog.length}，列车 ${trains.length}`);
    let t0 = performance.now();
    return {
      api,
      update() {
        const time = (performance.now() - t0) / 1000;
        if (state.xray) uW.value = THREE.MathUtils.clamp((ctx.camera.position.y - H(ctx.camera.position.x, ctx.camera.position.z)) * 0.0022, 3, 60);
        if (state.under) updateTrains(time);
      },
      setLayer(layer, v) {
        if (layer === 'metro') setXray(v);
      },
      dispose() {
        root.traverse((o) => o.geometry?.dispose());
        xray.traverse((o) => o.geometry?.dispose());
        tex.dispose();
        ctx.scene.remove(root, xray);
      },
    };
  },
};
