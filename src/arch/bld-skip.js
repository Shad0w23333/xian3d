// 通用建筑让位（skip）与底高预处理（主线程）：从 src/modules/buildings.js 拆出，
// 供无浏览器的检查工具（tools/check_overlap_node.mjs）复用。
// 2026-09-29：部分落入排除区的判定在“顶点落入”之外再测包围盒中心与 1/4 点（精建区从楼中间横穿时顶点全在区外）。

// 兜底：地标模块已加载时，与其同名的 OSM 建筑让位（正常情况下地标模块会在 prepare 里注册排除区）
const LANDMARK_NAMES = [
  ['belltower', /^(西安)?(钟楼|鼓楼)$/],
  ['pagoda', /^(大雁塔|大慈恩寺.{0,6})$/],
  ['heritage', /^(小雁塔|荐福寺.{0,6}|西安博物院)$/],
  ['citywall', /(城墙|箭楼|闸楼|角楼|敌楼|魁星楼|^(永宁|安定|长乐|安远|朱雀|含光|勿幕|玉祥|尚武|尚德|解放|中山|文昌|和平|建国|朝阳|小南)门(城楼)?$)/],
];

const QUART = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
const EX_FRAC = 0.3; // 轮廓落入排除区的比例 ≥ 此值则让位
const EX_AREA = 100; // 或落入比例 ≥ 10% 且估算落入面积 ≥ 此值（m²）：大楼的一角插进精建楼/古建院落
/** 轮廓内 6×6 网格取样，落入排除区（buildings）的比例 */
function exFrac(ex, offs, s, e, ax, az, X0, X1, Z0, Z1, h) {
  let n = 0, hit = 0;
  for (let gx = 0; gx < 6; gx++)
    for (let gz = 0; gz < 6; gz++) {
      const x = X0 + ((gx + 0.5) / 6) * (X1 - X0), z = Z0 + ((gz + 0.5) / 6) * (Z1 - Z0);
      let c = false;
      for (let k = s, j = e - 2; k < e; j = k, k += 2) {
        const xi = ax + offs[k] * 0.1, zi = az + offs[k + 1] * 0.1, xj = ax + offs[j] * 0.1, zj = az + offs[j + 1] * 0.1;
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
      }
      if (!c) continue;
      n++;
      if (ex.test(x, z, 'buildings', h)) hit++;
    }
  return n ? hit / n : 0;
}

// ———— 主线程预处理：地面高程、底部高程、排除标记、包围盒 ————
export function preprocess(ctx, P) {
  const N = P.count, offs = P.offs, T = ctx.terrain, ex = ctx.exclusions;
  const ga = new Float32Array(N), base = new Float32Array(N), skip = new Uint8Array(N), bb = new Float32Array(N * 4);
  // skyline 模块渲染的已调研高楼（h ≥ 34 m）：带 flags bit3 且与其轮廓对应的通用建筑让位
  const sky = ctx.modules && ctx.modules.skyline
    ? (ctx.data.skyline?.features || []).filter((f) => f.outer?.length >= 6 && f.h >= 34 && Math.hypot(f.x, f.z) < 47000)
    : [];
  const inPoly = (x, z, p) => {
    let c = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
    }
    return c;
  };
  const names = ctx.data.buildingNames || {};
  const lmRe = LANDMARK_NAMES.filter(([id]) => ctx.modules && ctx.modules[id]).map((x) => x[1]);
  let nEx = 0, nSky = 0;
  for (let i = 0; i < N; i++) {
    const ax = P.anchorX[i], az = P.anchorZ[i];
    const s = P.vertStart[i] * 2, e = s + P.vertCount[i] * 2;
    let x0 = 32767, x1 = -32768, z0 = 32767, z1 = -32768;
    for (let k = s; k < e; k += 2) {
      const dx = offs[k], dz = offs[k + 1];
      if (dx < x0) x0 = dx;
      if (dx > x1) x1 = dx;
      if (dz < z0) z0 = dz;
      if (dz > z1) z1 = dz;
    }
    const X0 = ax + x0 * 0.1, X1 = ax + x1 * 0.1, Z0 = az + z0 * 0.1, Z1 = az + z1 * 0.1;
    bb[i * 4] = X0;
    bb[i * 4 + 1] = Z0;
    bb[i * 4 + 2] = X1;
    bb[i * 4 + 3] = Z1;
    if (sky.length && P.flags[i] & 8) {
      for (const f of sky) {
        if (Math.abs(f.x - ax) < 150 && Math.abs(f.z - az) < 150 && (Math.hypot(f.x - ax, f.z - az) < 45 || inPoly(ax, az, f.outer))) {
          skip[i] = 1;
          nSky++;
          break;
        }
      }
    }
    if (!skip[i] && ex && ex.test(ax, az, 'buildings', P.heightDm[i] * 0.1)) {
      skip[i] = 1;
      nEx++;
    }
    // 锚点（质心）在排除区外、但轮廓有相当一部分伸进排除区（精建地标/片区的边缘）：只测锚点会漏掉，
    // 结果通用楼一半插在精建楼里。先测顶点，有顶点落入再用轮廓内网格取样估算落入比例，≥ EX_FRAC 让位
    if (!skip[i] && ex && ex.items.length) {
      const hm = P.heightDm[i] * 0.1;
      let any = false;
      for (let k = s; k < e && !any; k += 2) any = ex.test(ax + offs[k] * 0.1, az + offs[k + 1] * 0.1, 'buildings', hm);
      // 顶点都在区外、但精建区（长条形站房平台、广场台地……）从楼中间横穿过去时，顶点测试会漏掉：再测包围盒中心与四个 1/4 点
      for (const [fx, fz] of QUART) {
        if (any) break;
        any = ex.test(X0 + (X1 - X0) * fx, Z0 + (Z1 - Z0) * fz, 'buildings', hm);
      }
      if (any) {
        const f = exFrac(ex, offs, s, e, ax, az, X0, X1, Z0, Z1, hm);
        let A = 0;
        for (let k = s, j = e - 2; k < e; j = k, k += 2) A += offs[j] * offs[k + 1] - offs[k] * offs[j + 1];
        A = Math.abs(A) * 0.005; // 分米² → m²（×0.01 / 2）
        if (f >= EX_FRAC || (f >= 0.1 && f * A >= EX_AREA)) {
          skip[i] = 1;
          nEx++;
        }
      }
    }
    if (!skip[i] && lmRe.length && P.flags[i] & 2) {
      const nm = names[i];
      if (nm && lmRe.some((re) => re.test(nm))) {
        skip[i] = 1;
        nEx++;
      }
    }
    const h0 = T.heightAt(ax, az);
    ga[i] = h0;
    // 底高 = 轮廓各顶点（长边再加中点）地面最低处：原先小楼只取质心、大楼取包围盒四角，
    // 坡地上小楼一侧悬空、L 形大楼取到轮廓外的低点而整体埋深
    let b = h0, top = h0;
    for (let k = s; k < e; k += 2) {
      const vx = ax + offs[k] * 0.1, vz = az + offs[k + 1] * 0.1;
      const hv = T.heightAt(vx, vz);
      b = Math.min(b, hv);
      top = Math.max(top, hv);
      const k2 = k + 2 < e ? k + 2 : s, wx = ax + offs[k2] * 0.1, wz = az + offs[k2 + 1] * 0.1;
      if (Math.abs(wx - vx) + Math.abs(wz - vz) > 24) b = Math.min(b, T.heightAt((vx + wx) * 0.5, (vz + wz) * 0.5));
    }
    base[i] = b;
    // 陡坡/崖边：楼顶（锚点地面 + 楼高）低于轮廓上坡侧地面时整栋被埋进山体；把顶面参考抬到上坡地面以上 3 m
    const H = Math.max(3, P.heightDm[i] * 0.1);
    if (P.minHeightDm[i] === 0 && top > h0 + H - 3) ga[i] = top - H + 3;
  }
  return { ga, base, skip, bb, nEx, nSky };
}
