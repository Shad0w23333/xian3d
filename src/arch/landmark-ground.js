// 地标周边的地面构件（城墙/历史建筑/钟楼等模块共用）：贴地石材铺装、夜间地埋灯与贴地光斑。
//   pavedGround(ctx, polys, opts)  多边形（世界坐标 [[x,z],...]，可多个）按地形铺一层石材（细分到边长 ≤ step，贴地 + lift）
//   groundGlow(ctx, spots, opts)   夜间贴地光斑（加法混合的径向渐变圆片，实例化；白天不可见）
//   uplights(ctx, pts, opts)       地埋灯灯头（小发光方片，夜间亮）
import * as THREE from 'three';

const TEX = new Map();
/** 花岗岩分格铺装贴图：tile（米，单块边长）、颜色、灰缝；一张贴图 = 4×4 块 */
export function graniteTexture({ color = '#a39b8e', joint = 'rgba(40,36,30,0.55)', seed = 7, vary = 0.08, long = 1 } = {}) {
  const key = color + joint + seed + vary + long;
  if (TEX.has(key)) return TEX.get(key);
  const S = 512, n = 4;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, S, S);
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const base = new THREE.Color(color);
  const cw = S / n, ch = S / (n * long);
  for (let j = 0; j < n * long; j++) {
    const off = long > 1 && j % 2 ? cw / 2 : 0;
    for (let i = -1; i <= n; i++) {
      const k = 1 + (r() - 0.5) * 2 * vary;
      const col = base.clone().multiplyScalar(k);
      g.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
      g.fillRect(i * cw + off + 1, j * ch + 1, cw - 2, ch - 2);
      // 石材颗粒
      for (let q = 0; q < 60; q++) {
        g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.07)';
        g.fillRect(i * cw + off + r() * cw, j * ch + r() * ch, 1.5, 1.5);
      }
    }
  }
  g.strokeStyle = joint;
  g.lineWidth = 2;
  for (let j = 0; j <= n * long; j++) {
    g.beginPath(); g.moveTo(0, j * ch); g.lineTo(S, j * ch); g.stroke();
    const off = long > 1 && j % 2 ? cw / 2 : 0;
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * cw + off, j * ch); g.lineTo(i * cw + off, (j + 1) * ch); g.stroke(); }
  }
  // 低频污渍（雨水、磨损）
  for (let q = 0; q < 10; q++) {
    g.fillStyle = r() < 0.6 ? `rgba(30,26,20,${0.03 + r() * 0.04})` : `rgba(255,250,240,${0.03 + r() * 0.03})`;
    g.beginPath();
    g.ellipse(r() * S, r() * S, 30 + r() * 120, 20 + r() * 60, r() * 3, 0, 6.3);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  TEX.set(key, t);
  return t;
}

/**
 * 贴地铺装材质：map 为 graniteTexture，tile = 单块边长（米）；夜间保留少量环境亮度（城市天光 + 周边泛光），
 * 不至于整片死黑（night：夜间自发光系数，× 贴图颜色）
 */
export function pavingMaterial(ctx, { tile = 1.2, night = 0.12, nightColor = 0xffcf9a, bias = 0.0006, ...texOpts } = {}) {
  const map = graniteTexture(texOpts).clone();
  map.needsUpdate = true;
  map.repeat.set(1 / (tile * 4), 1 / (tile * 4));
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0, emissive: nightColor, emissiveMap: map, emissiveIntensity: 0 });
  ctx.night.register(m, { day: 0, night });
  ctx.overlay(m, bias);
  m.name = 'landmark-paving';
  return m;
}

/** 多边形（[[x,z],...]）三角化后细分到边长 ≤ step，顶点贴地（heightAt + lift）；UV = 世界米；skip(x,z) 为真的小三角形不铺（如水面） */
export function groundGeometry(ctx, polys, { step = 6, lift = 0.06, heightFn = null, skip = null } = {}) {
  const H = heightFn || ((x, z) => ctx.terrain.heightAt(x, z));
  const pos = [];
  const pushTri = (a, b, c, depth) => {
    const ab = Math.hypot(a[0] - b[0], a[1] - b[1]), bc = Math.hypot(b[0] - c[0], b[1] - c[1]), ca = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const m = Math.max(ab, bc, ca);
    if (m > step && depth < 10) {
      // 沿最长边二分
      if (m === ab) { const d = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; pushTri(a, d, c, depth + 1); pushTri(d, b, c, depth + 1); }
      else if (m === bc) { const d = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]; pushTri(a, b, d, depth + 1); pushTri(a, d, c, depth + 1); }
      else { const d = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; pushTri(a, b, d, depth + 1); pushTri(d, b, c, depth + 1); }
      return;
    }
    if (skip && skip((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3)) return;
    // 法线朝上：从上往下看 (x,z) 的绕序
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const P = cr < 0 ? [a, b, c] : [a, c, b];
    for (const p of P) pos.push(p[0], H(p[0], p[1]) + lift, p[1]);
  };
  for (const poly of polys) {
    const contour = poly.map(([x, z]) => new THREE.Vector2(x, z));
    if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [i, j, k] of tris) pushTri([contour[i].x, contour[i].y], [contour[j].x, contour[j].y], [contour[k].x, contour[k].y], 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0, k = 0; i < pos.length; i += 3, k += 2) { uv[k] = pos[i]; uv[k + 1] = pos[i + 2]; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 便捷：铺装网格（receiveShadow） */
export function pavedGround(ctx, polys, opts = {}) {
  const mesh = new THREE.Mesh(groundGeometry(ctx, polys, opts), opts.material || pavingMaterial(ctx, opts));
  mesh.receiveShadow = true;
  mesh.name = opts.name || '地标铺装';
  return mesh;
}

let glowTex = null;
function radialTex() {
  if (glowTex) return glowTex;
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.62)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/**
 * 夜间贴地光斑：spots = [[x, z, 半径, 强度(0~2)?]]；color 暖黄。加法混合、不写深度，亮度 × uNight。
 * 用来表现地埋灯/庭院灯/投光灯照亮的地面（点光源池只有十来盏，大广场上的几十盏灯靠它）。
 */
export function groundGlow(ctx, spots, { color = 0xffc27a, intensity = 0.55, lift = 0.12, heightFn = null } = {}) {
  const H = heightFn || ((x, z) => ctx.terrain.heightAt(x, z));
  const geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({ map: radialTex(), color: new THREE.Color(color).multiplyScalar(intensity), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = ctx.uniforms.uNight;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight;').replace('#include <opaque_fragment>', 'outgoingLight *= uNight;\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'lm-glow';
  ctx.overlay(m, 0.0012);
  const im = new THREE.InstancedMesh(geo, m, spots.length);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  spots.forEach(([x, z, r, k = 1], i) => {
    p.set(x, H(x, z) + lift, z);
    sc.set(r, 1, r);
    M.compose(p, q, sc);
    im.setMatrixAt(i, M);
    im.setColorAt(i, col.setScalar(k));
  });
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.castShadow = im.receiveShadow = false;
  im.renderOrder = 2;
  im.name = '贴地光斑';
  return im;
}

/** 地埋灯灯头：pts = [[x,z]]，0.32 m 见方的发光片（白天为深色金属盖） */
export function uplights(ctx, pts, { size = 0.32, color = 0xffd8a0, lift = 0.08, heightFn = null } = {}) {
  const H = heightFn || ((x, z) => ctx.terrain.heightAt(x, z));
  const geo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
  const m = new THREE.MeshStandardMaterial({ color: 0x3a3836, emissive: color, emissiveIntensity: 0, roughness: 0.4, metalness: 0.5 });
  ctx.night.register(m, { day: 0, night: 6 });
  ctx.overlay(m, 0.0012);
  const im = new THREE.InstancedMesh(geo, m, pts.length);
  const M = new THREE.Matrix4();
  pts.forEach(([x, z], i) => im.setMatrixAt(i, M.makeTranslation(x, H(x, z) + lift, z)));
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.name = '地埋灯';
  return im;
}
