// 地铁站内程序化贴图与材质（Canvas 生成，进站时才创建）：
//   地面花岗岩（0.8 m 方砖 + 灰缝 + 斑点）、搪瓷钢板墙面（1.2 m 分缝）、铝格栅吊顶、拉丝金属、隧道管片混凝土、
//   盲道砖、中式窗棂装饰板（钟楼一带“古今长安”主题）；站名牌/导向牌/灯箱广告按站单独绘制（signTexture）。
// 材质全部受光（MeshStandardMaterial，双面，不参与雾），明暗由地下固定照明（见 metro.js underLighting）决定；
// 灯带/灯箱用无光照材质，亮度固定（地下不受日照/昼夜影响）。
import * as THREE from 'three';
import { canvas, rng } from '../core/textures.js';

function toTex(c, metersPerRepeat, { srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  // 几何体 UV 以“米”为单位，这里换算成每张贴图覆盖的米数
  if (metersPerRepeat) t.repeat.set(1 / metersPerRepeat[0], 1 / metersPerRepeat[1]);
  return t;
}

function speckle(g, w, h, r, n, cols, smax = 2) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = cols[(r() * cols.length) | 0];
    const s = 0.6 + r() * smax;
    g.fillRect(r() * w, r() * h, s, s);
  }
}

function noise(g, w, h, r, amp) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amp;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** 地面花岗岩：贴图覆盖 1.6×1.6 m（2×2 块 0.8 m 方砖） */
function floorTex() {
  const S = 512, c = canvas(S), g = c.getContext('2d'), r = rng(17);
  g.fillStyle = '#a7a39b';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const k = (r() - 0.5) * 14;
    g.fillStyle = `rgb(${167 + k},${163 + k},${155 + k})`;
    g.fillRect(i * 256, j * 256, 256, 256);
  }
  speckle(g, S, S, r, 26000, ['#7a766f', '#8c8880', '#c9c5bd', '#5d5a55', '#d8d4cc', '#6f6a62'], 1.6);
  noise(g, S, S, r, 10);
  g.fillStyle = '#6e6a63';
  for (const p of [0, 256]) { g.fillRect(p, 0, 3, S); g.fillRect(0, p, S, 3); }
  g.fillStyle = 'rgba(255,255,255,0.10)';
  for (const p of [3, 259]) { g.fillRect(p, 0, 1, S); g.fillRect(0, p, S, 1); }
  return toTex(c, [1.6, 1.6]);
}

/** 搪瓷钢板墙面：贴图覆盖 2.4×2.4 m（两块 1.2 m 宽通高板，上下各一道横缝） */
function panelTex() {
  const S = 512, c = canvas(S), g = c.getContext('2d'), r = rng(23);
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0, '#f1efea');
  grd.addColorStop(1, '#e2dfd8');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '90,85,80'},${0.02 + r() * 0.03})`;
    g.fillRect(r() * S, 0, 1, S);
  }
  noise(g, S, S, r, 5);
  g.fillStyle = '#8f8b84';
  for (const p of [0, 256]) g.fillRect(p, 0, 3, S);
  g.fillRect(0, 0, S, 3);
  g.fillStyle = 'rgba(0,0,0,0.10)';
  for (const p of [3, 259]) g.fillRect(p, 0, 2, S);
  g.fillRect(0, 3, S, 2);
  return toTex(c, [2.4, 2.4]);
}

/** 铝条格栅吊顶：贴图覆盖 1.2×1.2 m，条板沿贴图 x 向（站台纵向），每 0.1 m 一条 */
function grilleTex() {
  const S = 512, c = canvas(S), g = c.getContext('2d');
  // 条缝里是吊顶上方的设备层（深灰），条板本身浅色；对比度压低，远处不出摩尔纹
  g.fillStyle = '#7b7f84';
  g.fillRect(0, 0, S, S);
  const pitch = S / 12;
  for (let k = 0; k < 12; k++) {
    const y = k * pitch;
    const grd = g.createLinearGradient(0, y, 0, y + pitch * 0.72);
    grd.addColorStop(0, '#f4f5f5');
    grd.addColorStop(0.6, '#e2e4e5');
    grd.addColorStop(1, '#c4c7c9');
    g.fillStyle = grd;
    g.fillRect(0, y, S, pitch * 0.72);
  }
  // 横向龙骨
  g.fillStyle = '#9a9da0';
  g.fillRect(0, 0, 5, S);
  return toTex(c, [1.2, 1.2]);
}

/** 拉丝不锈钢/金属：贴图覆盖 1×1 m */
function metalTex() {
  const S = 256, c = canvas(S), g = c.getContext('2d'), r = rng(31);
  g.fillStyle = '#c4c7ca';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 700; i++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '60,62,66'},${0.04 + r() * 0.06})`;
    g.fillRect(0, r() * S, S, 1);
  }
  noise(g, S, S, r, 6);
  return toTex(c, [1, 1]);
}

/** 隧道管片/结构混凝土：贴图覆盖 1.5×1.5 m（环缝 + 螺栓孔） */
function concreteTex() {
  const S = 256, c = canvas(S), g = c.getContext('2d'), r = rng(41);
  g.fillStyle = '#8d8c87';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(${r() > 0.5 ? '255,255,250' : '40,38,35'},${0.03 + r() * 0.05})`;
    g.beginPath();
    g.arc(r() * S, r() * S, 6 + r() * 30, 0, Math.PI * 2);
    g.fill();
  }
  noise(g, S, S, r, 22);
  g.fillStyle = '#4a4946';
  g.fillRect(0, 0, 3, S);
  g.fillRect(0, S / 2, S, 2);
  g.fillStyle = '#3b3a37';
  for (const y of [S * 0.25, S * 0.75]) { g.fillRect(S * 0.12, y - 5, 10, 10); g.fillRect(S * 0.62, y - 5, 10, 10); }
  return toTex(c, [1.5, 1.5]);
}

/** 盲道砖（行进条形砖）：贴图覆盖 0.3×0.3 m */
function tactileTex() {
  const S = 128, c = canvas(S), g = c.getContext('2d');
  g.fillStyle = '#d9a514';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#b8870c';
  g.fillRect(0, 0, S, 2);
  g.fillRect(0, 0, 2, S);
  // 行进盲道：条形凸起沿贴图 x 向（几何 UV 的 x 即站台纵向）
  for (let k = 0; k < 4; k++) {
    const y = 14 + k * 28;
    const grd = g.createLinearGradient(0, y, 0, y + 14);
    grd.addColorStop(0, '#f6cf4a');
    grd.addColorStop(1, '#b98a12');
    g.fillStyle = grd;
    g.fillRect(12, y, S - 24, 14);
  }
  return toTex(c, [0.3, 0.3]);
}

/** 中式窗棂装饰板（步步锦格心 + 外框），木色；贴图覆盖 1.2×1.2 m */
function latticeTex() {
  const S = 512, c = canvas(S), g = c.getContext('2d'), r = rng(53);
  g.fillStyle = '#4a3220';
  g.fillRect(0, 0, S, S);
  // 背衬灯光（格心后透出暖光）
  const grd = g.createRadialGradient(S / 2, S / 2, 20, S / 2, S / 2, S * 0.7);
  grd.addColorStop(0, '#f3d9a4');
  grd.addColorStop(1, '#c99a5a');
  g.fillStyle = grd;
  g.fillRect(24, 24, S - 48, S - 48);
  g.strokeStyle = '#7a4e2a';
  g.lineCap = 'square';
  const bar = (x0, y0, x1, y1, w) => { g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  // 步步锦：由外向内的回字形套格
  for (let k = 0; k < 4; k++) {
    const m = 24 + k * 56;
    g.lineWidth = 14;
    g.strokeRect(m, m, S - 2 * m, S - 2 * m);
  }
  for (let k = 0; k < 4; k++) {
    const m = 24 + k * 56, n = 24 + (k + 1) * 56;
    bar(S / 2, m, S / 2, n, 12); bar(S / 2, S - m, S / 2, S - n, 12);
    bar(m, S / 2, n, S / 2, 12); bar(S - m, S / 2, S - n, S / 2, 12);
  }
  g.lineWidth = 24;
  g.strokeStyle = '#5a3a20';
  g.strokeRect(12, 12, S - 24, S - 24);
  noise(g, S, S, r, 10);
  return toTex(c, [1.2, 1.2]);
}

let MATS = null;
/** 共享材质（第一次进站时创建） */
export function metroMaterials() {
  if (MATS) return MATS;
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false, metalness: 0, ...o });
  MATS = {
    floor: std({ map: floorTex(), roughness: 0.38 }),
    wall: std({ map: panelTex(), roughness: 0.42, metalness: 0.05 }),
    ceil: std({ map: grilleTex(), roughness: 0.55, metalness: 0.15 }),
    metal: std({ map: metalTex(), roughness: 0.32, metalness: 0.35 }),
    conc: std({ map: concreteTex(), roughness: 0.92 }),
    tactile: std({ map: tactileTex(), roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    deco: std({ map: latticeTex(), roughness: 0.6 }),
    paint: std({ roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    // 灯带、指示灯：无光照，顶点色 × 2.2（色调映射后接近纯白，但不受昼夜曝光影响——进站时曝光被锁定）
    light: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false, color: new THREE.Color(2.2, 2.2, 2.2) }),
    glass: new THREE.MeshStandardMaterial({ color: 0xd6eef6, transparent: true, opacity: 0.16, roughness: 0.08, metalness: 0, side: THREE.DoubleSide, depthWrite: false, fog: false }),
  };
  return MATS;
}

const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
const POSTERS = [
  ['千年古都 · 常来长安', '#7b2418', '#d39a3c'],
  ['大唐不夜城 · 盛唐天街', '#26184f', '#d24f7b'],
  ['西安城墙 · 环城骑行', '#2c4a3a', '#c8b273'],
  ['陕西历史博物馆', '#3a2a1e', '#b68a52'],
  ['秦岭 · 中华祖脉', '#173a4a', '#6fb3a0'],
  ['碑林 · 书法长廊', '#2a2a2a', '#b9a37a'],
];
/** 本站贴图：站名牌 / 导向吊牌 / 两幅灯箱广告；返回 {tex, rect:{name, guide, ad0, ad1}}（UV 矩形 [u0,v0,u1,v1]） */
export function signTexture(st, lineColor, badgeOf, seed = 1) {
  const Wd = 1024, Ht = 512, c = canvas(Wd, Ht), g = c.getContext('2d');
  const rect = (x, y, w, h) => [x / Wd, 1 - (y + h) / Ht, (x + w) / Wd, 1 - y / Ht];
  // —— 站名牌（0,0,1024,160）：深蓝底 + 线路色块 + 站名 ——
  g.fillStyle = '#123150';
  g.fillRect(0, 0, Wd, 160);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 150, Wd, 10);
  let bx = 26;
  for (const l of st.lines) {
    g.fillStyle = lineColor(l.num);
    g.fillRect(bx, 34, 84, 84);
    g.fillStyle = '#fff';
    const bt = badgeOf(l.num);
    g.font = `bold ${bt.length > 1 && !/^\d+$/.test(bt) ? 36 : 58}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(bt, bx + 42, 78);
    bx += 98;
  }
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.font = `bold ${st.n.length > 7 ? 60 : 84}px ${FONT}`;
  g.fillText(st.n, bx + 18, 80, Wd - bx - 230);
  // 右侧：西安地铁标识字样
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.textAlign = 'right';
  g.font = `bold 30px ${FONT}`;
  g.fillText('西安地铁', Wd - 30, 66);
  g.font = 'bold 20px sans-serif';
  g.fillText("XI'AN METRO", Wd - 30, 102);
  g.textAlign = 'left';
  // —— 导向吊牌（0,160,1024,128）：黑底，左“出口”绿底白字 + 箭头，右换乘信息 ——
  g.fillStyle = '#16181b';
  g.fillRect(0, 160, Wd, 128);
  g.fillStyle = '#1f8f4e';
  g.fillRect(20, 178, 250, 92);
  g.fillStyle = '#fff';
  g.font = `bold 54px ${FONT}`;
  g.textAlign = 'left';
  g.fillText('出口', 40, 226);
  g.font = 'bold 30px sans-serif';
  g.fillText('EXIT', 168, 228);
  g.font = 'bold 70px sans-serif';
  g.fillText('↑', 290, 226);
  g.fillStyle = '#e8e8e8';
  g.font = `bold 44px ${FONT}`;
  if (st.lines.length > 1) {
    g.fillText('换乘', 400, 226);
    let x = 510;
    for (const l of st.lines) {
      g.fillStyle = lineColor(l.num);
      g.fillRect(x, 190, 140, 72);
      g.fillStyle = '#fff';
      g.font = `bold 40px ${FONT}`;
      g.fillText(badgeOf(l.num).length > 2 ? badgeOf(l.num) : `${badgeOf(l.num)}号线`, x + 10, 228, 124);
      x += 156;
      if (x > Wd - 150) break;
    }
  } else {
    g.fillText(`${st.n}站`, 400, 226, Wd - 420);
  }
  // —— 灯箱广告（两幅，各 512×224） ——
  const r = rng(seed * 7919 + 13);
  for (let k = 0; k < 2; k++) {
    const [txt, c0, c1] = POSTERS[(seed + k * 3 + ((r() * 6) | 0)) % POSTERS.length];
    const x = k * 512, y = 288, w = 512, h = 224;
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, c0);
    grd.addColorStop(1, c1);
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(x + r() * w, y + r() * h, 20 + r() * 70, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#fff';
    g.font = `bold 46px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(txt, x + w / 2, y + h / 2, w - 40);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x, y + h - 30, w, 30);
    g.fillStyle = '#fff';
    g.font = `22px ${FONT}`;
    g.fillText('西安地铁 · 文化长廊', x + w / 2, y + h - 15);
    g.strokeStyle = '#c9ccd0';
    g.lineWidth = 8;
    g.strokeRect(x + 4, y + 4, w - 8, h - 8);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, rect: { name: rect(0, 0, Wd, 150), guide: rect(0, 160, Wd, 128), ad0: rect(0, 288, 512, 224), ad1: rect(512, 288, 512, 224) } };
}
