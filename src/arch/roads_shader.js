// roads 模块路面统一着色器：沥青/人行道/路缘石/中央分隔带/道砟/轨道板/钢轨/铺装 共用一个材质，
// 车道线、斑马线、停止线、导向箭头、导流线全部在片元着色器里按道路 UV 程序化生成（无贴图、无额外几何）。
// 顶点属性（见 roads_mesh.SurfWriter）：
//   aUV   = (横向, 纵向米)。沥青：横向 0..1（行进方向左边缘 0 → 右边缘 1）；人行道/分隔带：距路缘米数；
//           道砟/轨道板：距轨道中心的有符号米数；钢轨：1=轨顶 0=轨腰。纵向 = 要素累计里程（米，全要素连续，保证虚线相位连续）。
//   aRoad = (种类, 车道数 | 灯距<<4, 标志位, 宽度cm)
//   aJunc = (距边起点米, 距边终点米, 起点路口半径, 终点路口半径)
// 夜间路灯光斑：按灯距在着色器里算（与 placeLamps 的灯位相位一致：s = (k+0.5)·S），远处解析平均，不需要真实点光源。
import * as THREE from 'three';

let _noise = null;

/** 可平铺多频噪声（RGBA）：R 细颗粒、G 中频斑驳、B 低频老化、A 细胞补丁 */
export function roadNoiseTexture() {
  if (_noise) return _noise;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const vnoise = (cells) => {
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const out = new Float32Array(N * N);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * cells, fy = (y / N) * cells;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        let tx = fx - x0, ty = fy - y0;
        tx = tx * tx * (3 - 2 * tx);
        ty = ty * ty * (3 - 2 * ty);
        const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
        const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
        out[y * N + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      }
    return out;
  };
  const oct = (list) => {
    const out = new Float32Array(N * N);
    let tw = 0;
    for (const [cells, w] of list) {
      const v = vnoise(cells);
      for (let i = 0; i < out.length; i++) out[i] += v[i] * w;
      tw += w;
    }
    for (let i = 0; i < out.length; i++) out[i] /= tw;
    return out;
  };
  const R = oct([[128, 1], [64, 0.6], [32, 0.3]]);
  const G = oct([[16, 1], [32, 0.5], [8, 0.5]]);
  const B = oct([[4, 1], [8, 0.6], [16, 0.25]]);
  const A = oct([[32, 1], [64, 0.35]]);
  const norm = (a) => {
    let lo = 1, hi = 0;
    for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return (v) => Math.round(((v - lo) / (hi - lo || 1)) * 255);
  };
  const nR = norm(R), nG = norm(G), nB = norm(B), nA = norm(A);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = nR(R[i]);
    data[i * 4 + 1] = nG(G[i]);
    data[i * 4 + 2] = nB(B[i]);
    data[i * 4 + 3] = nA(A[i]);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  _noise = t;
  return t;
}

let _glyph = null;
/** 路面文字图集（“公交专用”四字横排，每字 128×128，白字黑底，R 通道为覆盖率）；着色器里沿行车方向拉长 2.3 倍 */
export function roadGlyphTexture() {
  if (_glyph) return _glyph;
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 116px "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","SimHei",sans-serif';
  const T = '公交专用';
  for (let i = 0; i < 4; i++) g.fillText(T[i], i * 128 + 64, 68);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  _glyph = t;
  return t;
}

const GLSL_COMMON = /* glsl */ `
uniform sampler2D uRNoise;
uniform sampler2D uGlyph;
uniform float uNight;
uniform float uLampGain;
varying vec2 vUV;
flat varying vec4 vRoad;
varying vec4 vJunc;
varying vec3 vWP;
varying vec4 vDet;
flat varying vec4 vDetF;
// 盒式滤波的线覆盖率：d=到线中心的有符号距离，hw=半宽，fw=像素足迹
float lineC(float d, float hw, float fw) {
  fw = max(fw, 1e-4);
  return (clamp(d + hw, -0.5 * fw, 0.5 * fw) - clamp(d - hw, -0.5 * fw, 0.5 * fw)) / fw;
}
float pulseI(float x, float P, float D) { return floor(x / P) * D + min(mod(x, P), D); }
// 盒式滤波周期脉冲（虚线/条纹）：周期 P，实部长度 D
float dashC(float x, float P, float D, float fw) {
  fw = max(fw, 1e-3);
  if (fw > P * 2.0) return D / P;
  return (pulseI(x + 0.5 * fw, P, D) - pulseI(x - 0.5 * fw, P, D)) / fw;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// 导向箭头（GB 5768.3 6 m 型）：x 距车道中心（驾驶员右侧为正），y 距箭头尖端米数（越大越靠近驾驶员）；
// bits：1 左转、2 直行、4 右转，可组合（直行左转、直行右转、左直右）
float arrowM(float x, float y, int bits, float px) {
  if (y < -0.2 || y > 6.2 || abs(x) > 1.5) return 0.0;
  bool S = (bits & 2) != 0;
  float a = 0.0;
  float y0 = S ? 1.8 : 2.2;
  a = max(a, smoothstep(px, -px, abs(x) - 0.09) * smoothstep(px, -px, max(y0 - y, y - 6.0)));
  if (S) a = max(a, smoothstep(px, -px, abs(x) - 0.45 * (y / 1.8)) * smoothstep(px, -px, max(-y, y - 1.8)));
  float yb = S ? 3.3 : 2.4;
  for (int k = 0; k < 2; k++) {
    if ((bits & (k == 0 ? 1 : 4)) == 0) continue;
    float sx = k == 0 ? -x : x;
    a = max(a, smoothstep(px, -px, max(abs(y - yb) - 0.2, max(-0.09 - sx, sx - 0.56))));
    if (sx > 0.5 && sx < 1.4) a = max(a, smoothstep(px, -px, abs(y - yb) - 0.52 * (1.35 - sx) / 0.8) * step(0.55, sx));
  }
  return a;
}
// 车道 i（0 = 最内侧/最左）在 n 车道进口上的箭头：路口出口 m（1 左 2 直 4 右，0 = 未知按全有）
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
int laneBits(int i, int n, int m) {
  if (m == 0) m = 7;
  bool L = (m & 1) != 0, S = (m & 2) != 0, R = (m & 4) != 0;
  if (n <= 1) return m;
  if (i == 0) return L ? ((n == 2 && S) ? 3 : 1) : (S ? 2 : m);
  if (i == n - 1) return R ? ((S && n <= 3) ? 6 : 4) : (S ? 2 : m);
  return S ? 2 : (2 * i < n ? 1 : 4);
}
// 箭头（旧版，保留给其它调用）：x 横向距车道中心，y 距箭头尖端米数；turn: 0 直行，-1/1 左/右转（向 x 负/正方向）
float arrowC(float x, float y, float turn, float px) {
  float a = 0.0;
  // 直行箭头：头部三角 0..1.8m，杆 1.8..6m
  if (turn == 0.0) {
    if (y > 0.0 && y < 1.8) a = max(a, smoothstep(px, -px, abs(x) - 0.42 * (y / 1.8)));
    if (y >= 1.8 && y < 6.0) a = max(a, smoothstep(px, -px, abs(x) - 0.09));
  } else {
    // 转弯箭头：杆 2.6..6m，折向一侧的横杆，横向三角头
    float sx = x * turn;
    if (y > 2.2 && y < 6.0) a = max(a, smoothstep(px, -px, abs(x) - 0.09));
    if (y > 2.2 && y < 2.6 && sx > -0.09 && sx < 0.55) a = max(a, 1.0);
    if (sx >= 0.55 && sx < 1.35) a = max(a, smoothstep(px, -px, abs(y - 2.4) - 0.5 * (1.35 - sx) / 0.8));
  }
  return a;
}
`;

const GLSL_SURFACE = /* glsl */ `
{
  int kind = int(vRoad.x + 0.5);
  int lp = int(vRoad.y + 0.5);
  int lanes = lp & 15;
  float lampS = float((lp >> 4) & 63);
  float lampLvl = float((lp >> 10) & 3);
  int fl = int(vRoad.z + 0.5);
  float W = max(vRoad.w * 0.01, 0.5);
  vec2 wp = vWP.xz;
  float n1 = texture2D(uRNoise, mod(wp, 230.0) / 2.3).r;
  float n2 = texture2D(uRNoise, mod(wp, 3100.0) / 31.0).g;
  float n3 = texture2D(uRNoise, mod(wp, 17300.0) / 173.0).b;
  float nA = texture2D(uRNoise, mod(wp, 900.0) / 9.0).a;
  float s = vUV.y;
  float fwS = fwidth(s);
  float pix = max(length(fwidth(wp)), 1e-3);
  vec3 col = vec3(0.07);
  rBumpH = 0.0;
  rBumpOn = 0.0;
  float rough = 0.9;
  float metal = 0.0;
  float lampL = 1e4; // 到最近路灯光斑中心线的横向距离
  float jLit = 0.0;  // 路口范围（路口铺面、进口道路口半径内）：夜里按均匀照度（路口灯多，不按单盏灯的光斑起伏）
  bool lampOK = (fl & 2048) != 0 || (fl & 4096) != 0 || (fl & 8192) != 0;
  const vec3 PAINT_W = vec3(0.52, 0.52, 0.50);
  const vec3 PAINT_Y = vec3(0.52, 0.33, 0.035);

  if (kind == 0) {
    // ===== 沥青车行道 =====
    float m = vUV.x * W;               // 距左边缘米
    float fwM = max(fwidth(m), 1e-4);
    float c = m - 0.5 * W;             // 距中心（右为正）
    vec3 base = vec3(0.05, 0.047, 0.042);
    base *= mix(0.78, 1.45, n3);       // 新旧路面（老化发灰）
    base *= 0.84 + 0.32 * n2;
    base *= 0.88 + 0.24 * n1;
    bool oneway = (fl & 1) != 0;
    int mk = int(vDetF.y + 0.5);
    float dS = vJunc.x, dE = vJunc.y, R0 = vJunc.z, R1 = vJunc.w;
    float Le = dS + dE;                // 边长
    bool inJ = (R0 > 0.0 && dS < R0) || (R1 > 0.0 && dE < R1);
    if (R0 > 90.0) jLit = 1.0; // 路口铺面（凸包）顶点 R0=R1=99
    else if (inJ) jLit = 1.0 - smoothstep(-3.0, 0.0, min(R0 > 0.0 ? dS - R0 : 1e4, R1 > 0.0 ? dE - R1 : 1e4));
    bool marks = (fl & 16) == 0 && !inJ;
    bool edges = (fl & 512) != 0;      // 主次干道：两侧有路缘石
    float white = 0.0, yellow = 0.0;
    // —— 车道几何 ——
    const float EM = 0.35;             // 边线距路缘
    float nSide, a, lw, laneF, sideSgn;
    if (oneway) {
      nSide = float(max(lanes, 1));
      a = m - EM;
      lw = (W - 2.0 * EM) / nSide;
      sideSgn = 1.0;
    } else {
      float nR = float(max((lanes + 1) / 2, 1));
      float nL = float(max(lanes - (lanes + 1) / 2, 1));
      sideSgn = c >= 0.0 ? 1.0 : -1.0;
      nSide = c >= 0.0 ? nR : nL;
      a = abs(c) - 0.25;
      lw = (0.5 * W - 0.25 - EM) / nSide;
    }
    lw = max(lw, 1.5);
    laneF = a / lw;
    float laneI = floor(laneF);
    float inLane = (fract(laneF) - 0.5) * lw; // 距车道中心（驾驶员右侧为正）
    float sDrv = s * sideSgn;          // 沿行车方向的里程
    // 驶向的路口：右半幅/单行驶向终点（R1），左半幅驶向起点（R0）
    float dAhead = sideSgn > 0.0 ? dE : dS, RA = sideSgn > 0.0 ? R1 : R0;
    bool cwAhead = sideSgn > 0.0 ? (fl & 256) != 0 : (fl & 128) != 0;
    float nearW = 1.0 - smoothstep(0.1, 0.22, pix); // 近景细节（井盖、雨水箅子、修补）权重
    if (pix < 2.5 && !inJ && a > 0.0 && laneI < nSide) {
      // 轮迹带（深色、略光滑）与车道中央油迹（路口进口停车处更重）
      float wt = lineC(abs(inLane) - 0.85, 0.32, fwM);
      base *= 1.0 - 0.13 * wt * (0.6 + 0.4 * n2);
      float stopZone = (RA > 0.0 && cwAhead) ? smoothstep(RA + 40.0, RA + 12.0, dAhead) * step(RA + 7.0, dAhead) : 0.0;
      base *= 1.0 - (0.06 + 0.22 * stopZone * smoothstep(0.35, 0.75, nA)) * lineC(inLane, 0.4, fwM) * (0.5 + n1);
      rough -= 0.08 * wt + 0.12 * stopZone * lineC(inLane, 0.4, fwM);
      // 分车道罩面：按车道、按 70~120 m 分段的新旧沥青（新罩面更黑、旧路面发灰），段间横缝、车道间纵缝；远处回到平均色
      float segL = 70.0 + 50.0 * hash12(vec2(laneI + 3.0, floor(W)));
      float segI = floor((sDrv + laneI * 23.0) / segL);
      float hr = hash12(vec2(segI, laneI * 7.0 + sideSgn * 3.0 + floor(vWP.z / 4000.0) * 11.0));
      float tone = hr < 0.3 ? 0.8 + 0.1 * fract(hr * 11.0) : hr > 0.86 ? 1.14 : 1.0;
      float farK = 1.0 - smoothstep(0.8, 2.2, pix);
      base *= mix(1.0, tone, farK);
      base *= 1.0 - 0.25 * lineC(fract((sDrv + laneI * 23.0) / segL) * segL - 0.03, 0.025, fwS) * step(0.05, abs(tone - 1.0)) * nearW;
      // 刹车印：路口进口停车区里个别车道的轮迹上有深色长条（5~15 m）
      if (stopZone > 0.0) {
        float hk = hash12(vec2(floor(sDrv / 17.0), laneI + 40.0));
        if (hk > 0.62) {
          float ks = fract(sDrv / 17.0) * 17.0;
          float kl = 5.0 + 10.0 * fract(hk * 13.0);
          float kx = 0.78 + 0.08 * sin(sDrv * 0.35 + hk * 20.0);
          float skid = lineC(abs(inLane) - kx, 0.07, fwM) * step(1.0, ks) * step(ks, 1.0 + kl) * smoothstep(1.0, 3.0, ks);
          base *= 1.0 - 0.45 * skid * nearW * (0.6 + 0.4 * n1);
        }
      }
      // 修补块（矩形补丁）
      float cell = floor(s / 9.0);
      float h = hash12(vec2(cell, laneI + sideSgn * 17.0 + floor(vWP.x / 3000.0)));
      if (h > 0.95) {
        float ps = fract(s / 9.0) * 9.0;
        float pl = 1.5 + 5.0 * fract(h * 37.0);
        float inP = step(1.0, ps) * step(ps, 1.0 + pl) * step(abs(inLane), 0.35 * lw + 0.3 * fract(h * 91.0));
        base = mix(base, base * (fract(h * 13.0) > 0.5 ? 0.72 : 1.18), inP);
      }
      // 灌缝裂纹（细黑线）
      float crack = smoothstep(0.035, 0.0, abs(nA - 0.5) - 0.0) * step(0.82, n2);
      base *= 1.0 - 0.35 * crack * step(pix, 0.12);
      // 井盖：污水干管井固定走某一条车道（按片区散列）约 40 m 一座，其余车道零星有雨水/电力/通信井（圆形铸铁，少量方形）
      if (nearW > 0.0) {
        float seed = floor(vWP.x / 2500.0) * 7.0 + floor(vWP.z / 2500.0) * 13.0 + floor(W);
        float sewer = floor(hash12(vec2(seed, sideSgn + 3.0)) * nSide);
        bool isSewer = laneI == sewer;
        float P = isSewer ? 40.0 : 57.0;
        float cellM = floor((sDrv + 11.0) / P);
        float hm = hash12(vec2(cellM * 1.7 + laneI * 31.0, seed + sideSgn * 5.0));
        float prob = isSewer ? (lampLvl >= 2.0 ? 0.85 : 0.6) : (lampLvl >= 2.0 ? 0.16 : 0.08);
        if (hm < prob) {
          float sc = (cellM + 0.25 + 0.5 * fract(hm * 17.3)) * P - 11.0;
          float xc = (fract(hm * 41.7) - 0.5) * 0.4 * lw;
          vec2 dd = vec2(sDrv - sc, inLane - xc);
          bool sq = !isSewer && fract(hm * 7.1) > 0.7;
          float rr = sq ? max(abs(dd.x), abs(dd.y)) : length(dd);
          float Rm = sq ? 0.32 : 0.36;
          if (rr < Rm + 0.12) {
            float pw = max(pix, 0.004);
            float cov = smoothstep(Rm + pw, Rm - pw, rr);
            float ring = smoothstep(Rm + 0.09 + pw, Rm + 0.09 - pw, rr) - cov;
            // 铸铁盖面：同心圆/方格防滑纹（近处才画，远处按平均色）
            float pat = sq ? max(dashC(dd.x + 0.5, 0.08, 0.03, fwS), dashC(dd.y + 0.5, 0.08, 0.03, fwM))
                           : dashC(length(dd) + 0.5, 0.055, 0.022, max(fwS, fwM));
            pat = mix(0.35, pat, smoothstep(0.03, 0.012, pix));
            vec3 iron = vec3(0.04, 0.038, 0.035) * (0.85 + 0.3 * n1) * (1.0 - 0.3 * pat);
            iron = mix(iron, vec3(0.07, 0.045, 0.03), 0.25 * smoothstep(0.55, 0.8, nA)); // 锈迹
            vec3 rim = vec3(0.085, 0.082, 0.078) * (0.9 + 0.2 * n1);
            base = mix(base, rim, ring * nearW);
            base = mix(base, iron, cov * nearW);
            rough = mix(rough, 0.5, cov * nearW);
            metal = mix(metal, 0.35, cov * nearW);
          }
        }
        // 管线开挖后的横向补条（全幅，约每 150 m 一处）：新沥青更黑、两侧接缝
        float tc = floor((s + 37.0) / 150.0);
        float ht = hash12(vec2(tc, floor(W) + 91.0));
        if (ht < 0.3) {
          float st = (tc + 0.2 + 0.6 * fract(ht * 23.0)) * 150.0 - 37.0;
          float tw = 0.6 + 0.7 * fract(ht * 57.0);
          float inT = lineC(s - st, tw, fwS);
          base = mix(base, base * 0.68, inT * nearW);
          base *= 1.0 - 0.3 * lineC(abs(s - st) - tw, 0.03, fwS) * nearW;
        }
      }
    }
    // 雨水箅子：两侧有路缘石的路段贴路缘每 30 m 一个（0.75 m × 0.45 m 铸铁格栅）；路缘边 0.3 m 混凝土平石
    if (edges && nearW > 0.0 && !inJ) {
      bool leftCurb = !oneway || (fl & 1024) == 0;
      float dEdge = W - m;
      float onL = 0.0;
      if (leftCurb && m < dEdge) { dEdge = m; onL = 1.0; }
      float gut = smoothstep(0.32 + fwM, 0.32 - fwM, dEdge);
      vec3 gcol = vec3(0.105, 0.1, 0.092) * (0.85 + 0.3 * n1) * (1.0 - 0.3 * dashC(s + 0.01, 1.0, 0.012, fwS));
      base = mix(base, gcol, gut * nearW * 0.85);
      float gs = mod(s + 9.0 + onL * 13.0, 30.0);
      if (gs < 0.75 && dEdge < 0.5 && dEdge > 0.04) {
        float bars = dashC(dEdge + 0.01, 0.045, 0.02, fwM);
        bars = mix(0.45, bars, smoothstep(0.03, 0.012, pix));
        float frame = max(lineC(gs - 0.375, 0.33, fwS) * lineC(dEdge - 0.27, 0.19, fwM), 0.0);
        vec3 grate = mix(vec3(0.012), vec3(0.06, 0.057, 0.052), bars);
        base = mix(base, grate, frame * nearW);
        metal = mix(metal, 0.3, frame * nearW);
      }
    }
    col = base;
    if (marks) {
      bool median = (fl & 2) != 0;
      bool dashLong = (fl & 4) != 0;
      float P = dashLong ? 15.0 : 6.0;
      float D = dashLong ? 6.0 : 2.0;
      bool approach = (R1 > 0.0 && dE < R1 + 40.0) || (R0 > 0.0 && dS < R0 + 40.0);
      // 公交专用道：最外侧车道（单向 ≥3 车道），驶近路口 50 m 内与驶出路口 20 m 内取消（让右转车辆进入）
      bool busOK = (mk & 1) != 0 && nSide >= 3.0 && !(RA > 0.0 && dAhead < RA + 50.0) && !((sideSgn > 0.0 ? R0 : R1) > 0.0 && (sideSgn > 0.0 ? dS : dE) < (sideSgn > 0.0 ? R0 : R1) + 20.0);
      // 边线
      if (edges) {
        white = max(white, lineC(W - m - 0.3, 0.075, fwM));
        float le = lineC(m - 0.3, 0.075, fwM);
        if (oneway && median) yellow = max(yellow, le);
        else white = max(white, le);
      }
      // 同向分道线（公交专用道分界：黄色虚线 4 m / 4 m，线宽 20 cm）
      if (a > 0.0 && nSide > 1.0) {
        float k = floor(laneF + 0.5);
        if (k >= 1.0 && k <= nSide - 1.0) {
          float d = (laneF - k) * lw;
          if (busOK && k == nSide - 1.0) {
            yellow = max(yellow, lineC(d, 0.1, fwM) * dashC(sDrv, 8.0, 4.0, fwS));
          } else {
            float along = approach ? 1.0 : dashC(s + 3.0 * float(fl & 1), P, D, fwS);
            white = max(white, lineC(d, 0.075, fwM) * along);
          }
        }
      }
      // “公交专用”字样：每 160 m 一组，四字沿行车方向由近及远排列，字长 3 m、宽 1.3 m（纵向拉长便于远读）
      if (busOK && laneI == nSide - 1.0 && pix < 0.6) {
        float tb = mod(sDrv, 160.0) - 24.0;
        if (tb > 0.0 && tb < 14.4) {
          float ci = floor(tb / 3.8);
          float yc = tb - ci * 3.8;
          float gx = inLane / 1.3 + 0.5;
          if (yc < 3.0 && gx > 0.0 && gx < 1.0) {
            float lod = log2(max(pix / 0.0102, 1.0));
            float g = textureLod(uGlyph, vec2((ci + gx) * 0.25, yc / 3.0), lod).r;
            yellow = max(yellow, smoothstep(0.25, 0.6, g) * (1.0 - smoothstep(0.3, 0.6, pix)));
          }
        }
      }
      // 对向中心线
      if (!oneway) {
        if (lanes >= 4 || W >= 13.0) {
          yellow = max(yellow, max(lineC(c - 0.15, 0.075, fwM), lineC(c + 0.15, 0.075, fwM)));
          // 路口前导流线（宽路中央黄色斜纹导流带）
          if ((lanes >= 6 || W >= 20.0) && approach) {
            float zoneA = (R1 > 0.0 && dE > R1 + 8.0 && dE < R1 + 40.0) ? 1.0 : 0.0;
            float zoneB = (R0 > 0.0 && dS > R0 + 8.0 && dS < R0 + 40.0) ? 1.0 : 0.0;
            float zone = max(zoneA, zoneB);
            if (zone > 0.0) {
              float hw = 1.1;
              yellow = max(yellow, max(lineC(c - hw, 0.075, fwM), lineC(c + hw, 0.075, fwM)));
              if (abs(c) < hw) yellow = max(yellow, dashC(s + c * 1.2, 3.0, 0.4, max(fwS, fwM)));
            }
          }
        } else if (lanes >= 2) {
          yellow = max(yellow, lineC(c, 0.075, fwM) * dashC(s, 10.0, 4.0, fwS));
        }
      }
      // 人行横道 + 停止线 + 导向箭头（按车道数与路口实际可走的方向排布，进口道重复 1~3 组）
      if (pix < 3.0) {
        if ((fl & 128) != 0 && R0 > 0.0) {
          float band = lineC(dS - (R0 + 3.5), 2.5, fwS);
          white = max(white, band * dashC(m - 0.3, 1.0, 0.45, fwM) * step(0.25, m) * step(m, W - 0.25));
          if (!oneway) white = max(white, lineC(dS - (R0 + 7.5), 0.2, fwS) * step(c, -0.3) * step(0.3, m));
        }
        if ((fl & 256) != 0 && R1 > 0.0) {
          float band = lineC(dE - (R1 + 3.5), 2.5, fwS);
          white = max(white, band * dashC(m - 0.3, 1.0, 0.45, fwM) * step(0.25, m) * step(m, W - 0.25));
          if (oneway) white = max(white, lineC(dE - (R1 + 7.5), 0.2, fwS) * step(0.3, m) * step(m, W - 0.3));
          else white = max(white, lineC(dE - (R1 + 7.5), 0.2, fwS) * step(0.3, c) * step(m, W - 0.3));
        }
        if (cwAhead && RA > 0.0 && a > 0.0 && laneI < nSide && (oneway || abs(c) > 0.3)) {
          float y0 = dAhead - (RA + 10.5);
          float k = clamp(floor((y0 + 7.0) / 20.0), 0.0, 2.0);
          float y = y0 - 20.0 * k;
          if (Le > RA + 10.5 + 20.0 * k + 26.0) {
            int tm = int((sideSgn > 0.0 ? vDetF.w : vDetF.z) + 0.5);
            int bits = laneBits(int(laneI), int(nSide), tm);
            white = max(white, arrowM(inLane, y, bits, pix * 0.7));
          }
        }
      }
      float wear = 0.72 + 0.28 * smoothstep(0.2, 0.7, n1 * 0.6 + n2 * 0.4);
      col = mix(col, PAINT_Y * (0.85 + 0.15 * n1), clamp(yellow, 0.0, 1.0) * wear);
      col = mix(col, PAINT_W * (0.85 + 0.15 * n1), clamp(white, 0.0, 1.0) * wear);
      rough = mix(rough, 0.62, clamp(white + yellow, 0.0, 1.0));
    }
    // 路灯横向位置
    if ((fl & 2048) != 0) lampL = min(lampL, abs(m - 1.8));
    if ((fl & 4096) != 0) lampL = min(lampL, abs(W - m - 1.8));
    if ((fl & 8192) != 0) lampL = min(lampL, abs(abs(c) - 2.2));
  } else if (kind == 10) {
    // ===== 路段人行横道贴花（步道横穿主次干道处）：斑马线 5 m + 两侧停止线，其余透明 =====
    float m = vUV.x * W;
    float fwM = max(fwidth(m), 1e-4);
    float c = m - 0.5 * W;
    bool oneway = (fl & 1) != 0;
    float d = (vJunc.x - vJunc.y) * 0.5; // 距过街中心（沿里程方向为正）
    // 带 NOMARK 位的是分隔带开口里的接续段（u 为负、不裁两侧）
    float edgeK = (fl & 16) != 0 ? 1.0 : step(0.25, m) * step(m, W - 0.25);
    float wv = lineC(d, 2.5, fwS) * dashC(m - 0.3, 1.0, 0.45, fwM) * edgeK;
    if (oneway) wv = max(wv, lineC(d + 4.3, 0.2, fwS) * step(0.3, m) * step(m, W - 0.3));
    else wv = max(wv, max(lineC(d + 4.3, 0.2, fwS) * step(0.3, c) * step(m, W - 0.3), lineC(d - 4.3, 0.2, fwS) * step(c, -0.3) * step(0.3, m)));
    wv *= 1.0 - smoothstep(1.0, 2.0, pix);
    if (wv < 0.02) discard;
    float wear = 0.72 + 0.28 * smoothstep(0.2, 0.7, n1 * 0.6 + n2 * 0.4);
    // 不透明材质：涂料覆盖率 < 1 处（抗锯齿边、磨损）与按同一噪声重算的沥青底色混合，接缝看不出来
    vec3 asp = vec3(0.05, 0.047, 0.042) * mix(0.78, 1.45, n3) * (0.84 + 0.32 * n2) * (0.88 + 0.24 * n1);
    float cov = clamp(wv * wear, 0.0, 1.0);
    col = mix(asp, PAINT_W * (0.85 + 0.15 * n1), cov);
    rough = mix(0.9, 0.62, cov);
    if ((fl & 2048) != 0) lampL = min(lampL, abs(m - 1.8));
    if ((fl & 4096) != 0) lampL = min(lampL, abs(W - m - 1.8));
    if ((fl & 8192) != 0) lampL = min(lampL, abs(abs(c) - 2.2));
  } else if (kind == 1) {
    // ===== 人行道：路缘侧设施带（树池/灯杆，60×30 深灰花岗岩）+ 步行带（30×30 浅灰透水砖）+ 行进盲道（避开树池）
    //       + 缘石坡道（降坡面浅色混凝土，过街坡道顶与转角坡道铺提示盲道点状砖）+ 禁停黄线（缘石顶面） =====
    float u = vUV.x;
    float fwU = max(fwidth(u), 1e-4);
    float Wl = vDet.w > 0.5 ? vDet.w * 0.1 : W; // 本断面实际宽度（遇并行辅路收窄）
    int mk = int(vDetF.y + 0.5);
    float zoneB = Wl >= 3.6 ? 2.45 : 0.0; // 设施带外缘
    bool inB = u < zoneB;
    // 人非共板非机动车道：设施带外侧 2.0 m（本断面宽 ≥ 6 m 时才有）
    bool bikeL = (mk & 8) != 0 && Wl >= 6.0;
    float bk0 = zoneB + 0.1, bk1 = zoneB + 2.1;
    float TX = inB ? 0.6 : 0.3, TY = 0.3;
    vec2 cellId = floor(vec2(s / TX, u / TY));
    float tone = hash12(cellId + floor(wp / 500.0) + (inB ? 3.0 : 0.0));
    col = (inB ? vec3(0.15, 0.145, 0.138) : vec3(0.19, 0.18, 0.168)) * (0.86 + 0.22 * tone) * (0.9 + 0.2 * n2);
    float joint = max(dashC(u + 0.008, TY, 0.016, fwU), dashC(s + 0.008, TX, 0.016, fwS));
    col *= 1.0 - 0.35 * joint * (1.0 - smoothstep(0.03, 0.08, pix));
    col *= 1.0 - 0.18 * lineC(u - zoneB, 0.04, fwU) * step(0.1, zoneB); // 带间收边条
    // 行进盲道（黄色条纹砖 0.4 m 宽）：设施带（及非机动车道）外 0.45~0.65 m；窄人行道靠外缘
    float ub = bikeL ? bk1 + 0.65 : Wl >= 3.6 ? min(Wl - 0.65, zoneB + 0.45) : Wl - 0.5;
    float blind = lineC(u - ub, 0.2, fwU) * step(u, Wl - 0.2);
    float ramp = vDet.x / 255.0;
    int rtype = int(vDet.z + 0.5);
    float RW = min(1.5, Wl * 0.45);
    if (bikeL) {
      // 绿色彩色沥青 + 两侧白实线 + 自行车图标（侧视剪影平铺在地面：图形“上方”朝骑行方向，骑车人看是正的；约 25 m 一个）
      float inBk = smoothstep(bk0 - fwU, bk0 + fwU, u) * smoothstep(bk1 + fwU, bk1 - fwU, u);
      vec3 gb = vec3(0.045, 0.085, 0.05) * (0.8 + 0.3 * n2) * (0.88 + 0.24 * n1);
      col = mix(col, gb, inBk);
      float lines = max(lineC(u - (bk0 + 0.12), 0.05, fwU), lineC(u - (bk1 - 0.12), 0.05, fwU));
      float sgn = (mk & 16) != 0 ? -1.0 : 1.0;
      float a = mod(s * sgn, 25.0) - 12.5;          // 沿行车方向，图标中心在 0
      float b = u - 0.5 * (bk0 + bk1);              // 横向
      float icon = 0.0;
      if (abs(a) < 0.8 && abs(b) < 0.95 && pix < 0.25) {
        vec2 q = vec2(b, a) / 1.15;                 // 图标坐标：x 骑车人右侧（车头），y 骑行方向（图形的“上”）
        float lw0 = 0.045;
        float d = abs(length(q - vec2(-0.5, -0.18)) - 0.3);
        d = min(d, abs(length(q - vec2(0.5, -0.18)) - 0.3));
        d = min(d, sdSeg(q, vec2(-0.5, -0.18), vec2(-0.05, -0.18)));
        d = min(d, sdSeg(q, vec2(-0.05, -0.18), vec2(-0.2, 0.22)));
        d = min(d, sdSeg(q, vec2(-0.5, -0.18), vec2(-0.2, 0.22)));
        d = min(d, sdSeg(q, vec2(-0.2, 0.22), vec2(0.38, 0.22)));
        d = min(d, sdSeg(q, vec2(-0.05, -0.18), vec2(0.38, 0.22)));
        d = min(d, sdSeg(q, vec2(0.38, 0.22), vec2(0.5, -0.18)));
        d = min(d, sdSeg(q, vec2(0.38, 0.22), vec2(0.34, 0.36)));
        d = min(d, sdSeg(q, vec2(0.26, 0.38), vec2(0.44, 0.38)));
        d = min(d, sdSeg(q, vec2(-0.28, 0.3), vec2(-0.1, 0.3)));
        float px2 = max(pix, 0.006);
        icon = smoothstep(lw0 + px2, lw0 - px2, d) * (1.0 - smoothstep(0.12, 0.25, pix));
      }
      float wpaint = max(lines * inBk, icon);
      col = mix(col, PAINT_W * (0.85 + 0.15 * n1), wpaint * (0.75 + 0.25 * smoothstep(0.2, 0.7, n1)));
    }
    vec3 yel = vec3(0.36, 0.25, 0.04) * (0.9 + 0.2 * n1);
    float bars = mix(0.5, dashC(u - ub + 0.2, 0.1, 0.035, fwU), smoothstep(0.03, 0.012, pix));
    col = mix(col, yel * (0.85 + 0.25 * bars), blind * (1.0 - step(0.5, ramp) * step(2.5, float(rtype))));
    // 缘石坡道：降坡面浅色混凝土（拉毛纹）
    float rampSurf = rtype == 3 ? step(0.05, ramp) : step(0.05, ramp) * smoothstep(RW + 0.05, RW - 0.05, u);
    vec3 conc = vec3(0.23, 0.225, 0.215) * (0.88 + 0.24 * n1) * (1.0 - 0.15 * dashC(s, 0.05, 0.015, fwS) * (1.0 - smoothstep(0.01, 0.03, pix)));
    col = mix(col, conc, rampSurf * smoothstep(0.0, 0.25, ramp));
    // 提示盲道（点状砖）：过街坡道顶部 0.6 m、转角坡道整幅
    float warn = 0.0;
    if (rtype == 1) warn = step(0.5, ramp) * step(RW, u) * step(u, RW + 0.6);
    else if (rtype == 3) warn = step(0.45, ramp) * step(0.2, u);
    if (warn > 0.0) {
      vec2 g = fract(vec2(s, u) / 0.075) - 0.5;
      float dot_ = smoothstep(0.32, 0.22, length(g));
      dot_ = mix(0.45, dot_, smoothstep(0.03, 0.012, pix));
      col = mix(col, yel * (0.8 + 0.35 * dot_), warn);
    }
    // 路缘石顶面（禁停：黄色实线 / 禁止长时停车：黄色虚线 1 m / 1 m）
    float curbTop = 1.0 - smoothstep(0.17, 0.19, u);
    vec3 ctop = vec3(0.26, 0.255, 0.245) * (0.9 + 0.2 * n1);
    float paint = (mk & 2) != 0 ? 1.0 : (mk & 4) != 0 ? dashC(s, 2.0, 1.0, fwS) : 0.0;
    paint *= step(ramp, 0.3) * (0.75 + 0.25 * smoothstep(0.3, 0.6, n2));
    ctop = mix(ctop, PAINT_Y * 0.95, paint);
    col = mix(col, ctop, curbTop);
    col *= 0.94 + 0.12 * n1;
    rough = 0.86;
    lampL = u + 1.8;
  } else if (kind == 2) {
    // ===== 路缘石立面（花岗岩，1m 一块）；禁停路段刷黄 =====
    col = vec3(0.26, 0.255, 0.245) * (0.88 + 0.24 * n1);
    col *= 1.0 - 0.3 * dashC(s, 1.0, 0.012, fwS);
    int mk = int(vDetF.y + 0.5);
    float paint = (mk & 2) != 0 ? 1.0 : (mk & 4) != 0 ? dashC(s, 2.0, 1.0, fwS) : 0.0;
    paint *= step(vDet.x / 255.0, 0.3) * (0.75 + 0.25 * smoothstep(0.3, 0.6, n2));
    col = mix(col, PAINT_Y * 0.95, paint);
    rough = 0.75;
    lampL = 2.0;
  } else if (kind == 3) {
    // ===== 中央分隔带路缘顶石（0.25 m 花岗岩，1 m 一块）；更宽处为种植土 =====
    float u = vUV.x;
    col = vec3(0.26, 0.255, 0.245) * (0.88 + 0.24 * n1);
    col *= 1.0 - 0.3 * dashC(s, 1.0, 0.012, fwS);
    col = mix(col, vec3(0.06, 0.05, 0.04) * (0.8 + 0.4 * n2), smoothstep(0.24, 0.27, u));
    rough = 0.8;
    lampL = u + 1.0;
  } else if (kind == 11) {
    // ===== 宽中央分隔带草坪：低频深浅 + 细碎草叶噪声，远处回到平均色 =====
    vec2 gc = vec2(s, vUV.x);
    float g1 = texture2D(uRNoise, gc / 7.0 + 0.13).r, g2 = texture2D(uRNoise, gc / 1.3 + 0.57).g;
    col = mix(vec3(0.045, 0.075, 0.025), vec3(0.085, 0.11, 0.04), g1) * (0.82 + 0.36 * mix(g2, 0.5, smoothstep(0.03, 0.15, pix)));
    col = mix(col, vec3(0.11, 0.1, 0.06), smoothstep(0.7, 0.9, g1) * 0.35);
    rough = 0.95;
    lampL = 1.2;
  } else if (kind == 8) {
    // ===== 绿篱（箱形修剪灌木，黄杨/冬青）：叶片(~4 cm) + 叶簇(~25 cm) + 修剪起伏(~1 m) 三级明暗，
    //       叶簇间缝隙压暗（模拟自遮蔽），侧面下部偏暗，顶面受光偏黄绿；每 6~9 m 一段换个色相 =====
    float h = vUV.x;
    bool topF = h > 0.8; // 顶面 u = 绿篱高 + 横向距离（>0.9）；侧面 u = 离路缘顶的高度
    vec2 lc = vec2(s, vWP.y + h);
    float leaf = texture2D(uRNoise, lc / 2.6).r;
    float clump = texture2D(uRNoise, lc / 4.2 + 0.37).g;
    float wave = texture2D(uRNoise, lc / 9.0 + 0.71).b;
    float gapD = smoothstep(0.30, 0.62, clump * 0.7 + leaf * 0.3); // 叶簇凸起处亮、缝隙暗
    float seg = hash12(vec2(floor(s / 7.5), 3.0));
    vec3 g0 = mix(vec3(0.022, 0.05, 0.016), vec3(0.04, 0.058, 0.018), seg); // 段间色相差（深绿 ↔ 橄榄绿）
    col = g0 * (0.5 + 1.0 * gapD) * (0.75 + 0.5 * leaf) * (0.8 + 0.4 * wave);
    // 叶簇凹凸（屏幕空间导数凹凸，见 normal_fragment_maps 注入）：阳光下一簇簇有明暗，不再像平铺的草皮
    rBumpH = (0.045 * clump + 0.015 * leaf) * (1.0 - smoothstep(0.02, 0.12, pix));
    rBumpOn = 1.0;
    if (topF) col = mix(col, vec3(0.085, 0.1, 0.03) * (0.5 + 1.0 * gapD), 0.3 * leaf);
    else col *= mix(0.35, 1.0, smoothstep(0.0, 0.5, h));
    // 远处叶片级细节已不可辨：按像素足迹回到平均色，避免闪烁
    col = mix(col, g0 * 0.95, smoothstep(0.08, 0.5, pix));
    rough = 0.95;
    lampL = 1.4;
  } else if (kind == 9) {
    // ===== 中线金属隔离护栏：立柱（2.5 m）+ 上下横杆 + 竖栏杆（0.15 m），按像素足迹盒式滤波后丢弃空隙 =====
    float h = vUV.x;
    float fwH = max(fwidth(h), 1e-4);
    float post = dashC(s + 0.03, 2.5, 0.07, fwS);
    float rail = max(lineC(h - 0.95, 0.04, fwH), lineC(h - 0.13, 0.035, fwH));
    float bars = dashC(s + 0.01, 0.15, 0.022, fwS) * step(0.13, h) * step(h, 0.95);
    float cov = max(max(post, rail), bars);
    if (cov < 0.42) discard;
    col = vec3(0.58, 0.6, 0.62) * (0.92 + 0.12 * n1);
    // 横杆中部的蓝白反光带（城市道路护栏常见）
    col = mix(col, vec3(0.08, 0.2, 0.45), lineC(h - 0.95, 0.012, fwH) * 0.6);
    metal = 0.45;
    rough = 0.4;
    lampL = 1.0;
  } else if (kind == 4 || kind == 6) {
    // ===== 道砟 / 无砟轨道板（钢轨、轨枕） =====
    float l = vUV.x;
    float fwL = max(fwidth(l), 1e-4);
    float al = abs(l);
    if (kind == 4) {
      col = vec3(0.085, 0.079, 0.072) * (0.7 + 0.6 * n1) * (0.85 + 0.3 * n2);
      col = mix(col, vec3(0.11, 0.07, 0.045), 0.35 * (1.0 - smoothstep(0.4, 1.3, abs(al - 0.72))));
      col *= mix(0.8, 1.0, smoothstep(2.4, 1.8, al));
      float sl = dashC(s, 0.6, 0.24, fwS) * (1.0 - smoothstep(1.25, 1.35, al));
      col = mix(col, vec3(0.19, 0.185, 0.175) * (0.9 + 0.2 * n1), sl);
      rough = 0.95;
    } else {
      col = vec3(0.16, 0.156, 0.148) * (0.88 + 0.2 * n1) * (0.9 + 0.2 * n2);
      col *= 1.0 - 0.3 * dashC(s, 6.45, 0.03, fwS) * step(al, 1.3);
      col *= 1.0 - 0.25 * lineC(al - 1.3, 0.02, fwL);
      float fas = dashC(s, 0.63, 0.18, fwS) * lineC(al - 0.72, 0.16, fwL);
      col = mix(col, vec3(0.12), fas * 0.6);
      rough = 0.85;
    }
    float rail = lineC(al - 0.7175, 0.036, fwL);
    col = mix(col, vec3(0.42, 0.42, 0.44), rail);
    metal = 0.7 * rail;
    rough = mix(rough, 0.35, rail);
  } else if (kind == 5) {
    // ===== 钢轨：轨顶磨亮，轨腰锈 =====
    // vUV.x 必须钳到 [0,1]：个别轨段的 UV 异常（远大于 1）会让金属度/反照率算出上百的值，
    // 夜里把月光反射成一个过曝像素，经泛光放大成全城俯视里一团蓝白“假太阳”
    float top = clamp(vUV.x, 0.0, 1.0);
    col = mix(vec3(0.16, 0.095, 0.06), vec3(0.62, 0.62, 0.64), top);
    metal = mix(0.3, 0.95, top);
    rough = mix(0.8, 0.22, top);
  } else {
    float u = vUV.x;
    float fwU = max(fwidth(u), 1e-4);
    if ((fl & 16384) != 0) {
      // ===== 公园/小区步道：中灰偏暖的透水砖/石材（反照率 ~0.11，不再是一条亮白细带），两侧压暗收边 =====
      vec2 cellId = floor(vec2(u / 0.3, s / 0.45));
      float tone = hash12(cellId + 3.0);
      col = vec3(0.118, 0.106, 0.09) * (0.85 + 0.25 * tone) * (0.85 + 0.3 * n2) * (0.9 + 0.2 * n3);
      col *= 1.0 - 0.25 * max(dashC(u + 0.01, 0.3, 0.015, fwU), dashC(s + 0.01, 0.45, 0.015, fwS));
      float edge = min(u, W - u);
      col *= mix(0.7, 1.0, smoothstep(0.05, 0.25, edge));
      rough = 0.9;
    } else {
      // ===== 步行街/人行铺装：大块石板 =====
      vec2 cellId = floor(vec2(u / 0.6, s / 0.6));
      float tone = hash12(cellId + 7.0);
      col = vec3(0.17, 0.162, 0.15) * (0.85 + 0.25 * tone) * (0.9 + 0.2 * n2);
      col *= 1.0 - 0.3 * max(dashC(u + 0.01, 0.6, 0.02, fwU), dashC(s + 0.01, 0.6, 0.02, fwS));
      rough = 0.82;
    }
  }
  diffuseColor.rgb = col;
  rRoadRough = rough;
  rRoadMetal = metal;
  // —— 夜间路灯光斑（贴地、加法；远处解析平均）——
  rRoadPool = 0.0;
  if (lampOK && lampS > 1.0 && uNight > 0.02) {
    float ph = (fract(s / lampS) - 0.5) * lampS;
    float sigA = 0.19 * lampS;
    float along = exp(-ph * ph / (2.0 * sigA * sigA));
    float avg = sigA * 2.5066 / lampS;
    along = mix(along, avg, smoothstep(0.08 * lampS, 0.45 * lampS, fwS));
    float lat = exp(-lampL * lampL / (2.0 * 6.0 * 6.0));
    rRoadPool = along * lat * (0.3 + 0.24 * lampLvl);
    if (kind == 8) rRoadPool *= 0.4; // 绿篱叶面吸光，光斑弱一些（否则夜里中分带像一条发亮的草坪）
  }
  if (jLit > 0.0 && uNight > 0.02) rRoadPool = mix(rRoadPool, 0.3, jLit);
  // —— 远景路网光带：像素足迹 > ~1.5 m 后（几百米外），整条车行道按等级发暖橙光，代替看不清的单个光斑 ——
  // （路面窄于一个像素时由 MSAA 覆盖率自然压暗，相当于按像素大小限亮，不会叠出光团）
  rRoadFar = 0.0;
  if (kind == 0 && (lampOK || jLit > 0.5) && uNight > 0.02) {
    // 亮度按等级，再按路段（~300 m 一档）与低频噪声起伏 ±30%：远看是有明有暗的光网，不是一张均匀描边的地图
    float rv = 0.75 + 0.5 * hash12(vec2(floor(s / 300.0), floor(W))) ;
    rRoadFar = smoothstep(1.2, 7.0, pix) * (0.3 + 0.32 * lampLvl) * rv * (0.7 + 0.6 * n3);
  }
}
`;

/**
 * 创建路面材质（MeshStandardMaterial 派生）。
 * opts.bias：覆盖层深度偏移（overlay）
 */
export function createSurfaceMaterial(ctx, { bias = 0.0004, name = 'roadSurface' } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.name = name;
  const noise = roadNoiseTexture();
  const glyph = roadGlyphTexture();
  const uLampGain = { value: 3.0 };
  const uFarGain = { value: 0.5 };
  mat.userData.uLampGain = uLampGain;
  mat.userData.uFarGain = uFarGain;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRNoise = { value: noise };
    shader.uniforms.uGlyph = { value: glyph };
    shader.uniforms.uNight = ctx.uniforms.uNight;
    shader.uniforms.uLampGain = uLampGain;
    shader.uniforms.uFarGain = uFarGain;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aUV;
attribute vec4 aRoad;
attribute vec4 aJunc;
attribute vec4 aDet;
varying vec2 vUV;
flat varying vec4 vRoad;
varying vec4 vJunc;
varying vec3 vWP;
varying vec4 vDet;
flat varying vec4 vDetF;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vUV = aUV; vRoad = aRoad; vJunc = aJunc * 0.1; vDet = aDet; vDetF = aDet;
vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\nuniform float uFarGain;\nfloat rRoadRough; float rRoadMetal; float rRoadPool; float rRoadFar; float rBumpH; float rBumpOn;`)
      .replace('#include <map_fragment>', GLSL_SURFACE)
      // 兜底钳位：粗糙度/金属度越界（NaN 或 >1）会产生超亮高光像素
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(rRoadRough, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(rRoadMetal, 0.0, 1.0);')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (rBumpOn > 0.5) {
  // 导数凹凸（Mikkelsen 2010）：高度场 rBumpH（米）的屏幕空间梯度扰动法线
  vec3 bvp = -vViewPosition;
  vec3 bdx = dFdx(bvp), bdy = dFdy(bvp);
  float bhx = dFdx(rBumpH), bhy = dFdy(rBumpH);
  vec3 br1 = cross(bdy, normal), br2 = cross(normal, bdx);
  float bdet = dot(bdx, br1);
  vec3 bgrad = sign(bdet) * (bhx * br1 + bhy * br2);
  normal = normalize(abs(bdet) * normal - bgrad);
}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// 暖黄路灯光斑：照度 × 反照率（标线更亮），再加少量散射底光避免黑洞
totalEmissiveRadiance += (min(diffuseColor.rgb, vec3(0.28)) + vec3(0.01)) * vec3(1.0, 0.6, 0.27) * rRoadPool * uNight * uLampGain;
totalEmissiveRadiance += vec3(1.0, 0.46, 0.13) * rRoadFar * uNight * uFarGain;`
      );
  };
  mat.customProgramCacheKey = () => name + '|v7';
  return mat;
}

/** 结构物（桥梁、路基、箱梁）材质：顶点色 aCol.rgb × 混凝土纹理，aCol.a 为夜间 LED 轮廓灯强度 */
export function createStructMaterial(ctx, concreteMap) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0, map: concreteMap || null });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = ctx.uniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aCol;\nvarying vec4 vCol;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCol = aCol;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec4 vCol;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vCol.rgb * 1.05;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.75, 0.85, 1.0) * vCol.a * 4.0 * uNight;'
      );
  };
  mat.customProgramCacheKey = () => 'roadStruct|v1';
  return mat;
}
