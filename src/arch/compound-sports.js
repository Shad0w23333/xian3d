// 运动场地（public/data/sports.json，OSM leisure=track/pitch，tools/build_sports.py 生成）：
// 田径场（塑胶跑道 + 分道线 + 人工草坪内场 + 足球场线 + 球门；校园大跑道加看台）、足球场、篮球场（含篮球架）、网球场（含球网）、排球/羽毛球等硬地场。
// 尺寸：400 m 标准跑道外沿约 176×92 m、8 条分道各 1.22 m，内场足球场 105×68 m（小场按比例缩）；
//       篮球场 28×15 m、网球场双打 23.77×10.97 m；看台每排高 0.42 m、深 0.85 m。
// 场地局部坐标：a 沿长边、b 沿短边，世界 x = cx + a·cos − b·sin，z = cz + a·sin + b·cos。
import { K, C, PAL, hoop } from './compound-props.js';

const RED = C('#a8453a'), TURF = C('#3f7a3a'), TURF2 = C('#4b8a42'), WHITE = C('#eceae4');

export function drawField(W, f, T, opts = {}) {
  const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
  const X = (a, b) => f.cx + a * ca - b * sa, Z = (a, b) => f.cz + a * sa + b * ca;
  const G = W.ground;
  const yAt = (a, b) => T.heightAt(X(a, b), Z(a, b));
  // 平整：场地整体取中心高度（贴地误差小于 0.3 m 的场地按平面画，否则逐点贴地）
  const y0 = yAt(0, 0);
  let flat = true;
  for (const [a, b] of [[-f.L / 2, -f.B / 2], [f.L / 2, -f.B / 2], [f.L / 2, f.B / 2], [-f.L / 2, f.B / 2]]) if (Math.abs(yAt(a, b) - y0) > 0.3) flat = false;
  const Y = (a, b, lift) => (flat ? y0 : yAt(a, b)) + lift;
  const P = (a, b, lift) => [X(a, b), Y(a, b, lift), Z(a, b)];
  const rect = (a0, a1, b0, b1, lift, kind, col, step = 12) => {
    G.k = kind;
    const na = Math.max(1, Math.ceil((a1 - a0) / step)), nb = Math.max(1, Math.ceil((b1 - b0) / step));
    for (let i = 0; i < na; i++)
      for (let j = 0; j < nb; j++) {
        const aa = a0 + ((a1 - a0) * i) / na, ab = a0 + ((a1 - a0) * (i + 1)) / na, ba = b0 + ((b1 - b0) * j) / nb, bb = b0 + ((b1 - b0) * (j + 1)) / nb;
        G.quadW(P(aa, bb, lift), P(ab, bb, lift), P(ab, ba, lift), P(aa, ba, lift), col, [[aa, bb], [ab, bb], [ab, ba], [aa, ba]]);
      }
  };
  // 局部折线条带（白线）：pts [[a,b],...]
  const line = (pts, w, lift, closed = false) => {
    const G = W.gdetail;
    G.k = K.PAINT;
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const na = (-(q[1] - p[1]) / L) * w / 2, nb = ((q[0] - p[0]) / L) * w / 2;
      // 顶点顺序须与 rect 一致（法线朝上）：原先反了，全部白线朝下被背面剔除，球场/跑道一条线都看不见
      G.quadW(P(p[0] + na, p[1] + nb, lift), P(q[0] + na, q[1] + nb, lift), P(q[0] - na, q[1] - nb, lift), P(p[0] - na, p[1] - nb, lift), WHITE, [[p[0], p[1]], [q[0], q[1]], [q[0], q[1]], [p[0], p[1]]]);
    }
  };
  const arc = (ca0, cb0, r, t0, t1, n = 16) => {
    const out = [];
    for (let i = 0; i <= n; i++) { const t = t0 + ((t1 - t0) * i) / n; out.push([ca0 + Math.cos(t) * r, cb0 + Math.sin(t) * r]); }
    return out;
  };
  const S = W.coarse;
  const put = (a, b, lift, yaw) => S.setXf(X(a, b), Y(a, b, lift), Z(a, b), yaw - f.ang);

  // 足球场线 + 球门（中心 (0,0)，长 FL 宽 FW）
  const soccerLines = (FL, FW, lift) => {
    const k = Math.min(1, FL / 105);
    const hl = FL / 2, hw = FW / 2;
    line([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]], 0.12, lift, true);
    line([[0, -hw], [0, hw]], 0.12, lift);
    line(arc(0, 0, 9.15 * k, 0, Math.PI * 2, 24), 0.12, lift, true);
    for (const s of [-1, 1]) {
      const pa = s * hl, pd = s * (hl - 16.5 * k), ga = s * (hl - 5.5 * k);
      const pw = Math.min(hw - 1, 20.16 * k), gw = Math.min(hw - 2, 9.16 * k);
      line([[pa, -pw], [pd, -pw], [pd, pw], [pa, pw]], 0.12, lift);
      line([[pa, -gw], [ga, -gw], [ga, gw], [pa, gw]], 0.12, lift);
      // 球门（7.32×2.44 m，白色方管 + 后撑）
      const gwid = 7.32 * Math.max(0.6, k) / 2, gh = 2.44 * Math.max(0.75, k);
      put(pa, 0, lift, 0);
      const out = s;
      S.box(-0.06, 0, -gwid - 0.06, 0.06, gh, -gwid + 0.06, WHITE);
      S.box(-0.06, 0, gwid - 0.06, 0.06, gh, gwid + 0.06, WHITE);
      S.box(-0.06, gh - 0.12, -gwid, 0.06, gh, gwid, WHITE);
      S.bar([0, gh, -gwid], [out * 1.8, 0, -gwid], 0.05, PAL.gray);
      S.bar([0, gh, gwid], [out * 1.8, 0, gwid], 0.05, PAL.gray);
      S.bar([out * 1.8, 0.03, -gwid], [out * 1.8, 0.03, gwid], 0.05, PAL.gray);
    }
  };
  const turf = (FL, FW, lift) => {
    // 人工草坪：沿长边 5 m 一条深浅相间
    const n = Math.max(2, Math.round(FL / 5));
    for (let i = 0; i < n; i++) rect(-FL / 2 + (FL * i) / n, -FL / 2 + (FL * (i + 1)) / n, -FW / 2, FW / 2, lift, K.LAWN, i & 1 ? TURF : TURF2, 14);
  };

  if (f.kind === 'track') {
    const Ro = f.B / 2, h = Math.max(0, (f.L - f.B) / 2);
    const tw = Math.min(9.8, Math.max(4.9, f.B * 0.105));
    const lanes = Math.max(4, Math.min(8, Math.round((tw - 0.3) / 1.22)));
    const m = 18;
    const outline = (R) => [...arc(h, 0, R, -Math.PI / 2, Math.PI / 2, m), ...arc(-h, 0, R, Math.PI / 2, (Math.PI * 3) / 2, m)];
    const Ri = Ro - tw;
    const po = outline(Ro), pi = outline(Ri);
    // 跑道（塑胶）
    G.k = K.RUBBER;
    for (let i = 0; i < po.length; i++) {
      const j = (i + 1) % po.length;
      G.quadW(P(pi[i][0], pi[i][1], 0.09), P(pi[j][0], pi[j][1], 0.09), P(po[j][0], po[j][1], 0.09), P(po[i][0], po[i][1], 0.09), RED, [po[i], po[j], po[j], po[i]]);
    }
    // 内场（扇形三角化，凸）
    G.k = K.LAWN;
    for (let i = 0; i < pi.length; i++) {
      const j = (i + 1) % pi.length;
      G.triW(P(0, 0, 0.085), P(pi[j][0], pi[j][1], 0.085), P(pi[i][0], pi[i][1], 0.085), TURF, [0, 0], pi[j], pi[i]);
    }
    // 分道线
    for (let k = 0; k <= lanes; k++) line(outline(Ro - 0.25 - (k * (tw - 0.5)) / lanes), 0.05, 0.1, true);
    // 终点线
    line([[h - 8, Ri], [h - 8, Ro]], 0.12, 0.1);
    // 内场足球场
    const FL = Math.min(105, 2 * h + Ri * 1.25), FW = Math.min(68, 2 * Ri - 6);
    if (FW > 25) {
      turf(FL, FW, 0.095);
      soccerLines(FL, FW, 0.1);
    }
    // 看台：校园大跑道，一侧直道外（西侧或北侧，看台面朝场内）
    if (opts.stand && h > 30) {
      const nbx = -sa, nbz = ca; // +b 方向的世界向量
      const side = Math.abs(nbx) > 0.3 ? (nbx < 0 ? 1 : -1) : nbz < 0 ? 1 : -1;
      const SL = Math.min(2 * h * 0.8, 90);
      const rows = 8, rd = 0.85, rh = 0.42;
      const b0 = side * (Ro + 1.2);
      const ok = !opts.blocked || !opts.blocked(X(0, b0 + side * 4), Z(0, b0 + side * 4));
      if (ok) {
        put(0, b0, 0.0, side > 0 ? 0 : Math.PI);
        // 局部：x 沿跑道、z 向外（远离场地）——put 的 yaw 让局部 +z 指向 ±b
        const seat = [C('#2f6fb3'), C('#c8372d'), C('#e8e6e0')];
        for (let r = 0; r < rows; r++) {
          const z0 = r * rd, z1 = z0 + rd, y1 = (r + 1) * rh;
          S.box(-SL / 2, 0, z0, SL / 2, y1, z1, C('#b9b4aa'), { colTop: C('#c9c4ba') });
          // 座椅（按块着色）
          const nb = 12;
          for (let q = 0; q < nb; q++) {
            const x0 = -SL / 2 + (q * SL) / nb + 0.3, x1 = -SL / 2 + ((q + 1) * SL) / nb - 0.3;
            S.box(x0, y1, z0 + 0.15, x1, y1 + 0.18, z0 + 0.5, seat[(q + (r >> 2)) % 2]);
          }
        }
        // 后墙 + 雨棚
        const zb = rows * rd, yt = rows * rh;
        S.box(-SL / 2, 0, zb, SL / 2, yt + 1.4, zb + 0.3, C('#d4cfc4'));
        for (let q = 0; q <= 6; q++) S.boxC(-SL / 2 + (q * SL) / 6, yt + 1.4, zb + 0.15, 0.3, 3.2, 0.3, PAL.gray);
        S.box(-SL / 2 - 1, yt + 4.6, -1.5, SL / 2 + 1, yt + 4.85, zb + 0.6, C('#e6e8ea'), { bottom: true });
      }
    }
    return;
  }
  if (f.kind === 'soccer') {
    const FL = f.L - 3, FW = f.B - 3;
    rect(-f.L / 2, f.L / 2, -f.B / 2, f.B / 2, 0.08, K.LAWN, TURF2);
    turf(FL, FW, 0.085);
    if (FW > 12) soccerLines(FL - 1, FW - 1, 0.09);
    return;
  }
  if (f.kind === 'basketball' || f.kind === 'multi' || f.kind === 'volleyball' || f.kind === 'badminton' || f.kind === 'table_tennis') {
    const outer = f.kind === 'basketball' ? (opts.seed & 1 ? C('#9a4a3c') : C('#4c7f58')) : C('#7a8a8e');
    const inner = f.kind === 'basketball' ? (opts.seed & 2 ? C('#3f6fa0') : C('#4c7f58')) : C('#4f7f9e');
    rect(-f.L / 2, f.L / 2, -f.B / 2, f.B / 2, 0.08, K.COURT, outer);
    const cw = f.kind === 'basketball' ? 30 : 15, cb = f.kind === 'basketball' ? 17 : 9;
    const nL = Math.max(1, Math.floor((f.L + 2) / cw)), nB = Math.max(1, Math.floor((f.B + 2) / cb));
    const sl = f.L / nL, sb = f.B / nB;
    const CL = Math.min(f.kind === 'basketball' ? 28 : 18, sl - 1.6), CB = Math.min(f.kind === 'basketball' ? 15 : 9, sb - 1.6);
    if (CL < 8 || CB < 5) return;
    for (let i = 0; i < nL; i++)
      for (let j = 0; j < nB; j++) {
        const ca0 = -f.L / 2 + (i + 0.5) * sl, cb0 = -f.B / 2 + (j + 0.5) * sb;
        rect(ca0 - CL / 2, ca0 + CL / 2, cb0 - CB / 2, cb0 + CB / 2, 0.085, K.COURT, inner);
        const hl = CL / 2, hb = CB / 2;
        line([[ca0 - hl, cb0 - hb], [ca0 + hl, cb0 - hb], [ca0 + hl, cb0 + hb], [ca0 - hl, cb0 + hb]], 0.06, 0.09, true);
        line([[ca0, cb0 - hb], [ca0, cb0 + hb]], 0.06, 0.09);
        if (f.kind === 'basketball') {
          line(arc(ca0, cb0, 1.8, 0, Math.PI * 2, 16), 0.06, 0.09, true);
          for (const s of [-1, 1]) {
            const ea = ca0 + s * hl;
            line([[ea, cb0 - 2.45], [ea - s * 5.8, cb0 - 2.45], [ea - s * 5.8, cb0 + 2.45], [ea, cb0 + 2.45]], 0.06, 0.09);
            line(arc(ea - s * 1.575, cb0, Math.min(6.75, hb - 0.9), s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? (Math.PI * 3) / 2 : Math.PI / 2, 14), 0.06, 0.09);
            put(ea, cb0, 0.08, Math.atan2(-s, 0));
            hoop(S);
          }
        } else {
          // 球网
          put(ca0, cb0, 0.08, 0);
          const nh = f.kind === 'volleyball' ? 2.3 : 1.55;
          S.box(-0.03, 0, -hb - 0.3, 0.03, nh + 0.1, -hb - 0.24, PAL.gray);
          S.box(-0.03, 0, hb + 0.24, 0.03, nh + 0.1, hb + 0.3, PAL.gray);
          S.box(-0.01, nh - 0.8, -hb - 0.24, 0.01, nh, hb + 0.24, C('#2a2c2e'));
        }
      }
    return;
  }
  if (f.kind === 'tennis') {
    rect(-f.L / 2, f.L / 2, -f.B / 2, f.B / 2, 0.08, K.COURT, C('#4c7f58'));
    const nL = Math.max(1, Math.floor((f.L + 2) / 35)), nB = Math.max(1, Math.floor((f.B + 2) / 17));
    const sl = f.L / nL, sb = f.B / nB;
    for (let i = 0; i < nL; i++)
      for (let j = 0; j < nB; j++) {
        const ca0 = -f.L / 2 + (i + 0.5) * sl, cb0 = -f.B / 2 + (j + 0.5) * sb;
        const hl = Math.min(11.885, sl / 2 - 3), hb = Math.min(5.485, sb / 2 - 1.5);
        if (hl < 5 || hb < 2.5) continue;
        rect(ca0 - hl - 1, ca0 + hl + 1, cb0 - hb - 1, cb0 + hb + 1, 0.085, K.COURT, C('#3a6a96'));
        line([[ca0 - hl, cb0 - hb], [ca0 + hl, cb0 - hb], [ca0 + hl, cb0 + hb], [ca0 - hl, cb0 + hb]], 0.06, 0.09, true);
        const hs = hb * 0.75;
        line([[ca0 - hl, cb0 - hs], [ca0 + hl, cb0 - hs]], 0.05, 0.09);
        line([[ca0 - hl, cb0 + hs], [ca0 + hl, cb0 + hs]], 0.05, 0.09);
        line([[ca0 - 6.4, cb0 - hs], [ca0 - 6.4, cb0 + hs]], 0.05, 0.09);
        line([[ca0 + 6.4, cb0 - hs], [ca0 + 6.4, cb0 + hs]], 0.05, 0.09);
        line([[ca0 - 6.4, cb0], [ca0 + 6.4, cb0]], 0.05, 0.09);
        put(ca0, cb0, 0.08, 0);
        S.box(-0.04, 0, -hb - 0.9, 0.04, 1.07, -hb - 0.82, PAL.dgray);
        S.box(-0.04, 0, hb + 0.82, 0.04, 1.07, hb + 0.9, PAL.dgray);
        S.box(-0.01, 0.15, -hb - 0.82, 0.01, 0.95, hb + 0.82, C('#1e2022'));
        S.box(-0.02, 0.95, -hb - 0.82, 0.02, 1.0, hb + 0.82, WHITE);
      }
  }
}
