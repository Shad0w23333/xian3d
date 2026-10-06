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

const GLSL_COMMON = /* glsl */ `
uniform sampler2D uRNoise;
uniform float uNight;
uniform float uLampGain;
varying vec2 vUV;
flat varying vec4 vRoad;
varying vec4 vJunc;
varying vec3 vWP;
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
// 箭头（车道局部坐标：x 横向距车道中心，y 距箭头尖端米数，朝尖端行驶）；turn: 0 直行，-1/1 左/右转（向 x 负/正方向）
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
  float rough = 0.9;
  float metal = 0.0;
  float lampL = 1e4; // 到最近路灯光斑中心线的横向距离
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
    float dS = vJunc.x, dE = vJunc.y, R0 = vJunc.z, R1 = vJunc.w;
    bool inJ = (R0 > 0.0 && dS < R0) || (R1 > 0.0 && dE < R1);
    bool marks = (fl & 16) == 0 && !inJ;
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
    float inLane = (fract(laneF) - 0.5) * lw; // 距车道中心
    if (pix < 2.5 && !inJ && a > 0.0 && laneI < nSide) {
      // 轮迹带（深色、略光滑）与车道中央油迹
      float wt = lineC(abs(inLane) - 0.85, 0.32, fwM);
      base *= 1.0 - 0.13 * wt * (0.6 + 0.4 * n2);
      base *= 1.0 - 0.06 * lineC(inLane, 0.35, fwM) * n1;
      rough -= 0.08 * wt;
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
    }
    col = base;
    if (marks) {
      bool median = (fl & 2) != 0;
      bool dashLong = (fl & 4) != 0;
      bool edges = (fl & 512) != 0;
      float P = dashLong ? 15.0 : 6.0;
      float D = dashLong ? 6.0 : 2.0;
      bool approach = (R1 > 0.0 && dE < R1 + 40.0) || (R0 > 0.0 && dS < R0 + 40.0);
      // 边线
      if (edges) {
        white = max(white, lineC(W - m - 0.3, 0.075, fwM));
        float le = lineC(m - 0.3, 0.075, fwM);
        if (oneway && median) yellow = max(yellow, le);
        else white = max(white, le);
      }
      // 同向分道线
      if (a > 0.0 && nSide > 1.0) {
        float k = floor(laneF + 0.5);
        if (k >= 1.0 && k <= nSide - 1.0) {
          float d = (laneF - k) * lw;
          float along = approach ? 1.0 : dashC(s + 3.0 * float(fl & 1), P, D, fwS);
          white = max(white, lineC(d, 0.075, fwM) * along);
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
      // 人行横道 + 停止线 + 导向箭头
      if (pix < 3.0) {
        if ((fl & 128) != 0 && R0 > 0.0) {
          float band = lineC(dS - (R0 + 3.5), 2.5, fwS);
          white = max(white, band * dashC(m - 0.3, 1.0, 0.45, fwM) * step(0.25, m) * step(m, W - 0.25));
          if (!oneway) white = max(white, lineC(dS - (R0 + 7.5), 0.2, fwS) * step(c, -0.3) * step(0.3, m));
          // 反向车道箭头（左半幅，朝起点行驶）
          if (!oneway && c < -0.3 && laneI < nSide && a > 0.0) {
            float turn = (laneI == 0.0 && nSide >= 2.0) ? 1.0 : 0.0;
            white = max(white, arrowC(-inLane, dS - (R0 + 12.0), turn, pix * 0.7));
          }
        }
        if ((fl & 256) != 0 && R1 > 0.0) {
          float band = lineC(dE - (R1 + 3.5), 2.5, fwS);
          white = max(white, band * dashC(m - 0.3, 1.0, 0.45, fwM) * step(0.25, m) * step(m, W - 0.25));
          if (oneway) white = max(white, lineC(dE - (R1 + 7.5), 0.2, fwS) * step(0.3, m) * step(m, W - 0.3));
          else white = max(white, lineC(dE - (R1 + 7.5), 0.2, fwS) * step(0.3, c) * step(m, W - 0.3));
          if ((oneway || c > 0.3) && laneI < nSide && a > 0.0) {
            // 最内侧车道左转、其余直行（单行道最左侧为内侧）
            float turn = (laneI == 0.0 && nSide >= 2.0) ? -1.0 : 0.0;
            white = max(white, arrowC(inLane, dE - (R1 + 12.0), turn, pix * 0.7));
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
  } else if (kind == 1) {
    // ===== 人行道：灰色方砖 + 黄色盲道 =====
    float u = vUV.x;
    float fwU = max(fwidth(u), 1e-4);
    float T = 0.3;
    vec2 cellId = floor(vec2(u / T, s / T));
    float tone = hash12(cellId + floor(wp / 500.0));
    col = vec3(0.19, 0.18, 0.168) * (0.86 + 0.22 * tone) * (0.9 + 0.2 * n2);
    float joint = max(dashC(u + 0.008, T, 0.016, fwU), dashC(s + 0.008, T, 0.016, fwS));
    col *= 1.0 - 0.35 * joint;
    // 盲道（黄色条砖）
    float tb = 1.25;
    float blind = lineC(u - tb, 0.15, fwU) * step(u, W - 0.4);
    col = mix(col, vec3(0.36, 0.25, 0.04) * (0.9 + 0.2 * n1), blind);
    // 路缘石顶面
    float curbTop = 1.0 - smoothstep(0.17, 0.19, u);
    col = mix(col, vec3(0.26, 0.255, 0.245) * (0.9 + 0.2 * n1), curbTop);
    col *= 0.94 + 0.12 * n1;
    rough = 0.86;
    lampL = u + 1.8;
  } else if (kind == 2) {
    // ===== 路缘石立面（花岗岩，1m 一块） =====
    col = vec3(0.26, 0.255, 0.245) * (0.88 + 0.24 * n1);
    col *= 1.0 - 0.3 * dashC(s, 1.0, 0.012, fwS);
    rough = 0.75;
    lampL = 2.0;
  } else if (kind == 3) {
    // ===== 中央分隔带顶面：灌木绿篱 =====
    float u = vUV.x;
    col = vec3(0.045, 0.075, 0.03) * (0.6 + 0.8 * n2) * (0.75 + 0.5 * n1);
    col = mix(col, vec3(0.08, 0.075, 0.06), 0.35 * nA);
    col = mix(vec3(0.26, 0.255, 0.245), col, smoothstep(0.17, 0.2, u));
    rough = 0.95;
    lampL = u + 1.0;
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
    // ===== 步行街/人行铺装：大块石板 =====
    float u = vUV.x;
    float fwU = max(fwidth(u), 1e-4);
    vec2 cellId = floor(vec2(u / 0.6, s / 0.6));
    float tone = hash12(cellId + 7.0);
    col = vec3(0.2, 0.19, 0.178) * (0.85 + 0.25 * tone) * (0.9 + 0.2 * n2);
    col *= 1.0 - 0.3 * max(dashC(u + 0.01, 0.6, 0.02, fwU), dashC(s + 0.01, 0.6, 0.02, fwS));
    rough = 0.82;
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
    float lat = exp(-lampL * lampL / (2.0 * 5.0 * 5.0));
    rRoadPool = along * lat * (0.3 + 0.24 * lampLvl);
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
  const uLampGain = { value: 1.9 };
  mat.userData.uLampGain = uLampGain;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRNoise = { value: noise };
    shader.uniforms.uNight = ctx.uniforms.uNight;
    shader.uniforms.uLampGain = uLampGain;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aUV;
attribute vec4 aRoad;
attribute vec4 aJunc;
varying vec2 vUV;
flat varying vec4 vRoad;
varying vec4 vJunc;
varying vec3 vWP;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vUV = aUV; vRoad = aRoad; vJunc = aJunc * 0.1;
vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\nfloat rRoadRough; float rRoadMetal; float rRoadPool;`)
      .replace('#include <map_fragment>', GLSL_SURFACE)
      // 兜底钳位：粗糙度/金属度越界（NaN 或 >1）会产生超亮高光像素
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(rRoadRough, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(rRoadMetal, 0.0, 1.0);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// 暖黄路灯光斑：照度 × 反照率（标线更亮），再加少量散射底光避免黑洞
totalEmissiveRadiance += (min(diffuseColor.rgb, vec3(0.28)) + vec3(0.01)) * vec3(1.0, 0.6, 0.27) * rRoadPool * uNight * uLampGain;`
      );
  };
  mat.customProgramCacheKey = () => name + '|v4';
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
