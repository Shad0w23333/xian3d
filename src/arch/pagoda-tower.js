// 大雁塔（慈恩寺塔）程序化建模：七层方形楼阁式砖塔，写入古建构件库的 ArchBuilder（按材质合批）。
//
// 资料（西安市文物局、《中国古代建筑史》、维基百科“大雁塔”条目，并以 Esri 卫星影像核对平面）：
//   · 唐永徽三年（652）玄奘主持建造，长安年间重建为七层；明万历年间外包砖面，形成今日面貌。
//   · 通高 64.517 m；台基高 4.2 m，南北 48.7 m、东西 45.7 m；塔身底层边长 25.5 m，逐层收分。
//   · 塔身各层四面以砖砌扁柱（倚柱）与阑额分间：一、二层九间，三、四层七间，五至七层五间；柱头砖雕栌斗。
//   · 每层四面正中辟券门（拱券洞），可登临远眺；层间以叠涩出檐（平砖逐层外挑 + 菱角牙子），檐上反叠涩收进。
//   · 顶部四角攒尖式砖顶，上置宝葫芦形塔刹（约 4.87 m）。砖色黄灰（外包明代青砖风化后呈土黄灰色）。
//   · 夜景：金黄色投光泛光 + 各层檐口轮廓灯 + 券门内暖光。
//
// 局部坐标：原点 = 台基底面中心，Y 向上，+Z = 南（塔门正对南广场）。
import { clamp } from './chinese-core.js';
import { archOutline } from './chinese-wall.js';
import { steps } from './chinese-base.js';

// —— 实测/估算尺寸（米） ——
export const DAYANTA = {
  height: 64.5,
  base: { w: 45.7, d: 48.7, h: 4.2 },
  // w 本层塔身边长；h 塔身墙高（不含叠涩檐）；bays 分间数；door [券门宽, 券门高]
  levels: [
    { w: 25.5, h: 9.6, bays: 9, door: [3.0, 5.2] },
    { w: 23.9, h: 6.2, bays: 9, door: [2.3, 3.5] },
    { w: 22.4, h: 5.7, bays: 7, door: [2.2, 3.3] },
    { w: 21.0, h: 5.2, bays: 7, door: [2.1, 3.1] },
    { w: 19.6, h: 4.9, bays: 5, door: [2.0, 2.9] },
    { w: 18.3, h: 4.6, bays: 5, door: [1.9, 2.7] },
    { w: 17.0, h: 4.3, bays: 5, door: [1.8, 2.5] },
  ],
};

// 顶点色（sRGB），与构件库砖纹理相乘后呈黄灰砖色
// 色相往灰褐收（原先一水土黄，审查 g3）：明代外包砖风化后的黄灰色
const C = {
  wall: 0xcab593,
  pilaster: 0xc3ae8c,
  lane: 0xbda887, // 阑额
  dou: 0xb6a07e, // 砖雕栌斗
  eave: 0xc1ab89,
  tooth: 0xa6916f, // 菱角牙子
  back: 0xb5a07f, // 反叠涩
  arch: 0xb9a482, // 券脸
  base: 0xb4aa98, // 台基砖
  cap: 0xc9c2b4, // 台基压面石
  deck: 0x9a9285, // 台面方砖海墁
  finial: 0xb7a88c,
  doorStone: 0xd8d0c0,
};

const FACES = [0, Math.PI / 2, Math.PI, -Math.PI / 2]; // 南、东、北、西（正面朝 +Z 旋转）

/** 每面分间：中间一间加宽（券门所在），返回柱位 x 坐标数组（含两端角柱） */
function pilasterXs(w, bays) {
  const k = 1.6;
  const unit = w / (bays - 1 + k);
  const xs = [-w / 2];
  const c = (bays - 1) / 2;
  for (let i = 0; i < bays; i++) xs.push(xs[xs.length - 1] + (i === c ? unit * k : unit));
  return xs;
}

/** 带券门的墙板（面朝 +Z），x0..x1、y0..y1、z0..z1；券门宽 dw、高 dh，底部离地 sill */
function archSlab(b, x0, x1, y0, y1, z0, z1, dw, dh, sill, seg) {
  const poly = [[x0, y0]];
  const pts = archOutline(0, y0, dw, dh + sill, seg);
  for (const p of pts) poly.push(p);
  poly.push([x1, y0], [x1, y1], [x0, y1]);
  b.prism('brick', poly, 'z', z0, z1, C.wall);
  if (sill > 0) b.box('brick', -dw / 2, y0, z0, dw / 2, y0 + sill, z1, C.back, { skip: 'bottom' });
}

/** 券脸（砖券环，略凸出墙面） */
function archFace(b, y0, dw, dh, sill, z, seg, k = 0.32) {
  const inner = archOutline(0, y0 + sill, dw, dh, seg).slice(1, -1);
  const outer = archOutline(0, y0 + sill, dw + 2 * k, dh + k, seg).slice(1, -1);
  b.prism('brick', [...inner, ...[...outer].reverse()], 'z', z - 0.02, z + 0.12, C.arch);
  // 两侧券脚（门颊）
  b.box('brick', -dw / 2 - k, y0 + sill - 0.02, z - 0.02, -dw / 2, y0 + sill + Math.max(0, dh - dw / 2), z + 0.1, C.arch, { skip: 'bottom' });
  b.box('brick', dw / 2, y0 + sill - 0.02, z - 0.02, dw / 2 + k, y0 + sill + Math.max(0, dh - dw / 2), z + 0.1, C.arch, { skip: 'bottom' });
}

/** 菱角牙子：沿一面的锯齿砖（俯视锯齿，竖向拉伸），面朝 +Z，齿尖在 zt */
function sawtooth(b, half, y0, y1, zt, depth, pitch, col) {
  const n = Math.max(2, Math.round((2 * half) / pitch));
  const p = (2 * half) / n;
  const zv = zt - depth;
  for (let i = 0; i < n; i++) {
    const xa = -half + i * p, xm = xa + p / 2, xb = xa + p;
    // 两个斜面
    b.quad('brick', [xa, y0, zv], [xm, y0, zt], [xm, y1, zt], [xa, y1, zv], col);
    b.quad('brick', [xm, y0, zt], [xb, y0, zv], [xb, y1, zv], [xm, y1, zt], col);
    // 底面三角（仰视可见）
    b.triangle('brick', [xa, y0, zv], [xb, y0, zv], [xm, y0, zt], col);
  }
}

/**
 * 在 builder 中生成大雁塔。o: {detail}（沿用 b.detail）。
 * 返回 info：{top, levels:[{y, w, h}], eaveRings:[{y, half}], doors:[{y, w, h, half}]}
 */
export function dayanta(b) {
  const D = DAYANTA;
  const det = b.detail;
  const seg = det >= 2 ? 12 : det === 1 ? 8 : 4;
  const info = { levels: [], eaveRings: [], doors: [] };

  // ───── 台基：砖砌台身 + 压面石 + 矮护墙 + 南北踏道 ─────
  const bw = D.base.w / 2, bd = D.base.d / 2, bh = D.base.h;
  b.box('brick', -bw, 0, -bd, bw, bh - 0.3, bd, C.base, { skip: 'bottom' });
  // 台面：方砖海墁（暖灰，砖纹）+ 外沿一圈压面石（原先整面浅色石材 → 远看一块发白的无纹理平板）
  b.box('brick', -bw + 0.6, bh - 0.3, -bd + 0.6, bw - 0.6, bh - 0.02, bd - 0.6, C.deck, { skip: 'bottom' });
  b.box('stone', -bw - 0.15, bh - 0.3, -bd - 0.15, bw + 0.15, bh, -bd + 0.6, C.cap, { skip: 'bottom' });
  b.box('stone', -bw - 0.15, bh - 0.3, bd - 0.6, bw + 0.15, bh, bd + 0.15, C.cap, { skip: 'bottom' });
  b.box('stone', -bw - 0.15, bh - 0.3, -bd + 0.6, -bw + 0.6, bh, bd - 0.6, C.cap, { skip: 'bottom' });
  b.box('stone', bw - 0.6, bh - 0.3, -bd + 0.6, bw + 0.15, bh, bd - 0.6, C.cap, { skip: 'bottom' });
  // 台身下碱（青石勒脚）
  b.box('stone', -bw - 0.08, 0, -bd - 0.08, bw + 0.08, 0.6, bd + 0.08, 0xbfb8aa, { skip: 'bottom' });
  const stairW = 11;
  // 台基护墙（带缺口）
  const pH = 0.95, pT = 0.5;
  const par = (x0, z0, x1, z1) => {
    b.box('brick', x0, bh, z0, x1, bh + pH, z1, C.base, { skip: 'bottom' });
    if (det >= 1) b.box('stone', x0 - 0.06, bh + pH, z0 - 0.06, x1 + 0.06, bh + pH + 0.14, z1 + 0.06, C.cap, { skip: 'bottom' });
  };
  par(-bw, bd - pT, -stairW / 2, bd);
  par(stairW / 2, bd - pT, bw, bd);
  par(-bw, -bd, -stairW / 2, -bd + pT);
  par(stairW / 2, -bd, bw, -bd + pT);
  par(-bw, -bd + pT, -bw + pT, bd - pT);
  par(bw - pT, -bd + pT, bw, bd - pT);
  // 南、北踏道（垂带踏跺）
  for (const [z, yaw] of [[bd, 0], [-bd, Math.PI]]) {
    b.push(0, 0, z, yaw);
    steps(b, { w: stairW, h: bh, y0: 0, band: 0.7, color: 0xcfc8ba });
    b.pop();
  }

  // ───── 塔身七层 ─────
  let y = bh;
  const L = D.levels;
  for (let li = 0; li < L.length; li++) {
    const lv = L[li];
    const w = lv.w, hw = w / 2, h = lv.h;
    const yb = y;
    const t = clamp(w * 0.13, 2.2, 3.4); // 墙厚
    const s = clamp(w / 25.5, 0.72, 1); // 构件比例
    const [dw, dh] = lv.door;
    const sill = li === 0 ? 0.35 : 0.9;
    info.levels.push({ y: yb, w, h });
    // 室内（暗色，夜间暖光，经券门可见）
    b.box('pwin', -hw + t - 0.02, yb, -hw + t - 0.02, hw - t + 0.02, yb + h, hw - t + 0.02, 0xffffff, { skip: 'bottom' });
    // 塔身基座线（地栿）
    b.box('brick', -hw - 0.1, yb, -hw - 0.1, hw + 0.1, yb + 0.32 * s, hw + 0.1, C.lane, { skip: 'bottom' });
    const xs = pilasterXs(w, lv.bays);
    const pw = 0.62 * s, pj = 0.15;
    const laneH = 0.42 * s, douH = 0.36 * s;
    const colTop = yb + h - laneH - douH;
    for (let f = 0; f < 4; f++) {
      b.push(0, 0, 0, FACES[f]);
      const Lw = f % 2 === 0 ? w : w - 2 * t;
      archSlab(b, -Lw / 2, Lw / 2, yb, yb + h, hw - t, hw, dw, dh, sill, seg);
      // 倚柱（扁砖柱，两端角柱另做）
      for (let i = 1; i < xs.length - 1; i++) {
        b.box('brick', xs[i] - pw / 2, yb + 0.32 * s, hw, xs[i] + pw / 2, colTop, hw + pj, C.pilaster, { skip: 'bottom top' });
      }
      // 阑额
      b.box('brick', -hw - pj, colTop, hw, hw + pj, colTop + laneH, hw + pj, C.lane, { skip: 'top' });
      // 柱头栌斗（砖雕）+ 补间小斗
      if (det >= 1) {
        for (let i = 0; i < xs.length; i++) {
          const x = clamp(xs[i], -hw + pw * 0.3, hw - pw * 0.3);
          b.frustum('brick', x, hw + 0.08, colTop + laneH, 0.62 * s, 0.34, colTop + laneH + douH, 0.9 * s, 0.46, C.dou);
          if (det >= 2 && i < xs.length - 1) {
            // 补间斗（小砖斗）
            const xm = (xs[i] + xs[i + 1]) / 2;
            b.frustum('brick', xm, hw + 0.06, colTop + laneH, 0.4 * s, 0.26, colTop + laneH + douH * 0.8, 0.6 * s, 0.34, C.dou);
          }
        }
      }
      // 券脸
      if (det >= 1) archFace(b, yb, dw, dh, sill, hw, seg, 0.3 * s);
      // 首层南门：石门框 + 门楣
      if (li === 0 && det >= 1) {
        const fw = 0.38;
        b.box('stone', -dw / 2 - fw - 0.3, yb, hw + 0.08, -dw / 2 - 0.3, yb + sill + dh - dw / 2, hw + 0.2, C.doorStone, { skip: 'bottom' });
        b.box('stone', dw / 2 + 0.3, yb, hw + 0.08, dw / 2 + fw + 0.3, yb + sill + dh - dw / 2, hw + 0.2, C.doorStone, { skip: 'bottom' });
        b.box('stone', -dw / 2 - 0.2, yb, hw - 0.2, dw / 2 + 0.2, yb + sill, hw + 0.25, C.doorStone, { skip: 'bottom' });
      }
      info.doors.push({ y: yb + sill, w: dw, h: dh, half: hw, face: f });
      b.pop();
    }
    // 角柱
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x0 = sx < 0 ? -hw - pj : hw - pw * 0.6, x1 = sx < 0 ? -hw + pw * 0.6 : hw + pj;
      const z0 = sz < 0 ? -hw - pj : hw - pw * 0.6, z1 = sz < 0 ? -hw + pw * 0.6 : hw + pj;
      b.box('brick', x0, yb + 0.32 * s, z0, x1, colTop, z1, C.pilaster, { skip: 'bottom top' });
    }
    y = yb + h;

    // ───── 叠涩出檐 ─────
    const courses = [
      [0.12, 0.13], [0.28, 0.13], ['t', 0.44, 0.16], [0.58, 0.13], [0.76, 0.13], [0.94, 0.13], ['t', 1.12, 0.16], [1.26, 0.13], [1.42, 0.13], [1.58, 0.17],
    ];
    const es = clamp(s * 1.05, 0.78, 1);
    let lastOut = 0;
    for (let ci = 0; ci < courses.length; ci++) {
      const c = courses[ci];
      if (c[0] === 't') {
        const out = c[1] * es, hc = c[2] * es;
        if (det >= 1) {
          for (let f = 0; f < 4; f++) {
            b.push(0, 0, 0, FACES[f]);
            sawtooth(b, hw + out, y, y + hc, hw + out, 0.16, 0.34, C.tooth);
            b.pop();
          }
        } else b.box('brick', -hw - out, y, -hw - out, hw + out, y + hc, hw + out, C.tooth, { skip: 'top' });
        y += hc;
        continue;
      }
      const out = c[0] * es, hc = c[1] * es;
      b.box('brick', -hw - out, y, -hw - out, hw + out, y + hc, hw + out, C.eave, { skip: ci < courses.length - 1 ? 'top' : '' });
      lastOut = out;
      y += hc;
    }
    const eaveY = y;
    info.eaveRings.push({ y: eaveY, half: hw + lastOut });
    // 反叠涩：自檐口外沿逐级收进到上一层塔身
    const nextHalf = li < L.length - 1 ? L[li + 1].w / 2 : 5.2;
    const nb = li < L.length - 1 ? 6 : 12;
    const top0 = hw + lastOut;
    for (let k = 0; k < nb; k++) {
      const hh = top0 - ((top0 - nextHalf + 0.15) * (k + 1)) / nb + 0.15;
      const hc = li < L.length - 1 ? 0.1 * es : 0.19;
      b.box('brick', -hh, y, -hh, hh, y + hc, hh, C.back, { skip: 'bottom' });
      y += hc;
    }
  }

  // ───── 塔顶与塔刹（宝葫芦） ─────
  const yt = y;
  b.box('brick', -4.6, yt, -4.6, 4.6, yt + 0.35, 4.6, C.back, { skip: 'bottom' });
  b.frustum('brick', 0, 0, yt + 0.35, 6.4, 6.4, yt + 0.9, 3.6, 3.6, C.finial);
  const fp = [
    [1.9, 0], [1.9, 0.35], [1.5, 0.45], [1.7, 0.75], [1.75, 1.1], [1.5, 1.45], [1.0, 1.65], [0.62, 1.8], [0.7, 2.05], [0.95, 2.4], [1.02, 2.75], [0.85, 3.1],
    [0.5, 3.35], [0.35, 3.55], [0.52, 3.8], [0.56, 4.0], [0.4, 4.2], [0.14, 4.4], [0.06, 4.8], [0.001, 4.95],
  ];
  b.lathe('stone', fp.map(([r, yy]) => [r, yt + 0.9 + yy]), det >= 2 ? 20 : 12, C.finial);
  info.top = yt + 0.9 + 4.95;
  info.base = { w: D.base.w, d: D.base.d, h: bh };
  return info;
}

/** 檐口轮廓灯（夜景）：每层叠涩外沿一圈 LED */
export function dayantaLights(b, info, color = 0xffd08a) {
  for (const r of info.eaveRings) {
    const h = r.half + 0.04, y = r.y - 0.06;
    b.led([[-h, y, -h], [h, y, -h], [h, y, h], [-h, y, h]], { color, width: 0.08, closed: true });
  }
}

/**
 * 塔身砖面风化（叠加在泛光材质上，需先 floodlit 以获得 vFloodW）：低频修补色差 + 檐下竖向雨水痕 + 底部返碱偏深 +
 * 下层偏冷灰、上层偏暖。原先七层同一土黄色、近看像整块涂色模型（审查 g3）。
 */
export function weatherBrick(mat, baseY) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  const uBase = { value: baseY };
  mat.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.uniforms.uWBase = uBase;
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uWBase;
        float wHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float wNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y); }`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 wp = vFloodW;
          float hy = wp.y - uWBase;
          float u = wp.x + wp.z;
          float n1 = wNoise(vec2(u, wp.y) * 0.3);
          float n2 = wNoise(vec2(wp.x - wp.z, wp.y) * 1.7);
          float streak = smoothstep(0.55, 0.92, wNoise(vec2(u * 1.9, wp.y * 0.07))) * (0.6 + 0.4 * wNoise(vec2(u * 0.4, 7.0)));
          float k = 1.0 - 0.12 * n1 - 0.06 * n2 - 0.14 * streak;
          k *= mix(0.82, 1.0, smoothstep(0.0, 12.0, hy));
          diffuseColor.rgb *= k;
          float grey = dot(diffuseColor.rgb, vec3(0.333));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(grey), 0.08 + 0.14 * (1.0 - smoothstep(4.0, 45.0, hy)));
        }`
      );
  };
  mat.customProgramCacheKey = () => prevKey() + '|weather';
  mat.needsUpdate = true;
  return mat;
}
