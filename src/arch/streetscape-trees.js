// 院落树（回坊街巷院落里的国槐 / 榆树等）：交叉叶片卡片树冠 + 树干，实例化（每棵随机缩放、朝向、叶色）。
// 植被模块只按用地种树、且避让回坊逐户轮廓，回坊院内几乎没有树（审查 g1：俯视像一层噪点，真实院里树木不少）。
import * as THREE from 'three';

let _tex = null;
function leafTexture() {
  if (_tex) return _tex;
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  let s = 17;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 220; i++) {
    const x = S * (0.12 + r() * 0.76), y = S * (0.06 + r() * 0.8);
    const d = Math.hypot(x - S / 2, (y - S * 0.46) * 1.1) / (S * 0.44);
    if (d > 1) continue;
    const t = r();
    g.fillStyle = t < 0.35 ? '#3f6e2c' : t < 0.7 ? '#4f8233' : t < 0.88 ? '#2f5522' : '#6a9a45';
    g.beginPath();
    g.ellipse(x, y, 6 + r() * 12, 4 + r() * 8, r() * 3.14, 0, 6.3);
    g.fill();
  }
  _tex = new THREE.CanvasTexture(c);
  _tex.colorSpace = THREE.SRGBColorSpace;
  _tex.anisotropy = 4;
  return _tex;
}

function merged(parts) {
  const p = [], n = [], u = [];
  for (const g0 of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    p.push(...g.attributes.position.array);
    n.push(...g.attributes.normal.array);
    u.push(...g.attributes.uv.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  out.computeBoundingSphere();
  return out;
}

/**
 * 院落树：pts [[x, y(地面), z, 缩放], ...]。返回 Group（树冠 + 树干两个实例网格）。缩放 1 ≈ 树高 7 m、冠幅 5 m。
 */
export function courtyardTrees(ctx, pts, { name = '院落树' } = {}) {
  const grp = new THREE.Group();
  grp.name = name;
  if (!pts.length) return grp;
  const card = (w, h, y, ry, rx = 0) => {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateX(rx);
    g.rotateY(ry);
    g.translate(0, y, 0);
    return g;
  };
  const crown = merged([
    card(5.2, 4.4, 4.9, 0), card(5.2, 4.4, 4.9, Math.PI / 3), card(5.2, 4.4, 4.9, (2 * Math.PI) / 3),
    card(4.4, 4.4, 6.0, 0.3, -Math.PI / 2 + 0.3), card(3.8, 3.8, 4.0, 1.2, -Math.PI / 2 - 0.25),
  ]);
  const trunk = new THREE.CylinderGeometry(0.13, 0.22, 3.4, 6, 1, true).translate(0, 1.7, 0);
  const leafMat = new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
  leafMat.name = name + '-叶';
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x4e3d30, roughness: 0.95 });
  barkMat.name = name + '-干';
  const n = pts.length;
  const ic = new THREE.InstancedMesh(crown, leafMat, n), it = new THREE.InstancedMesh(trunk, barkMat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  const Y = new THREE.Vector3(0, 1, 0);
  pts.forEach(([x, y, z, s], i) => {
    const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
    q.setFromAxisAngle(Y, h * Math.PI * 2);
    v.set(x, y, z);
    sc.set(s * (0.9 + h * 0.25), s, s * (0.9 + h * 0.25));
    m.compose(v, q, sc);
    ic.setMatrixAt(i, m);
    it.setMatrixAt(i, m);
    // 叶色：国槐翠绿 ~ 秋色偏黄
    col.setRGB(0.85 + h * 0.2, 0.92 + h * 0.1, 0.8 + (1 - h) * 0.15);
    ic.setColorAt(i, col);
  });
  for (const im of [ic, it]) {
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
  }
  if (ic.instanceColor) ic.instanceColor.needsUpdate = true;
  ic.name = name + '-树冠';
  it.name = name + '-树干';
  grp.add(ic, it);
  return grp;
}
