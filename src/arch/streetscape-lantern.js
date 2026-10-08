// 红灯笼 + 夜间光晕 + 地面暖光斑（streetscape 的灯笼串与 huimin 的檐下灯笼共用）。
//   · 灯笼：竹骨椭球灯身（Canvas 贴图：红绸 + 竖向竹骨 + 上下渐暗；自发光贴图中心亮、骨架暗，夜里不再是平涂圆片）
//     + 黑漆描金上下木托 + 提梁 + 金黄流苏（顶点色，同一实例网格）
//   · 光晕：朝向相机的方片（着色器里按 uNight 淡入，叠加混合，向相机前移避免插进墙面）
//   · 地面暖光斑：贴地方片 + 径向渐变自发光（叠加混合），模拟灯笼、店面、摊位照到石板路上的暖光
import * as THREE from 'three';

let _tex = null;
/** 灯身贴图：map（白天红绸 + 竹骨）/ emis（夜间：中心亮、骨架与上下端暗） */
function lanternTextures() {
  if (_tex) return _tex;
  const W = 256, H = 128;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const c = mk(), g = c.getContext('2d');
  const e = mk(), ge = e.getContext('2d');
  // 白天：红绸，上下略暗
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#7a1410'); gr.addColorStop(0.18, '#c4231a'); gr.addColorStop(0.5, '#d42c1f'); gr.addColorStop(0.82, '#c4231a'); gr.addColorStop(1, '#7a1410');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  // 夜间：暖橙，中段最亮，上下压暗
  const ger = ge.createLinearGradient(0, 0, 0, H);
  ger.addColorStop(0, '#3a0800'); ger.addColorStop(0.2, '#c8400e'); ger.addColorStop(0.5, '#ff9a4a'); ger.addColorStop(0.8, '#c8400e'); ger.addColorStop(1, '#3a0800');
  ge.fillStyle = ger;
  ge.fillRect(0, 0, W, H);
  // 竖向竹骨（12 根）
  for (let i = 0; i < 12; i++) {
    const x = (i / 12) * W;
    g.fillStyle = 'rgba(60,10,6,0.55)';
    g.fillRect(x - 1.5, 0, 3, H);
    ge.fillStyle = 'rgba(40,6,0,0.75)';
    ge.fillRect(x - 2, 0, 4, H);
  }
  // 上下金边
  for (const y of [H * 0.08, H * 0.9]) {
    g.fillStyle = '#c9a24a';
    g.fillRect(0, y, W, 3);
    ge.fillStyle = '#ffcf6a';
    ge.fillRect(0, y, W, 2);
  }
  // 两面“福”字（白天金字，夜间透光更亮）
  for (const x of [W * 0.25, W * 0.75]) {
    for (const [gg, col] of [[g, '#e8c25a'], [ge, '#ffe0a0']]) {
      gg.fillStyle = col;
      gg.font = '700 40px "PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",serif';
      gg.textAlign = 'center';
      gg.textBaseline = 'middle';
      gg.fillText('福', x, H * 0.52);
    }
  }
  const t = (cv) => {
    const tx = new THREE.CanvasTexture(cv);
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.wrapS = THREE.RepeatWrapping;
    tx.anisotropy = 4;
    return tx;
  };
  _tex = { map: t(c), emis: t(e) };
  return _tex;
}

function toNonIndexed(g) {
  return g.index ? g.toNonIndexed() : g;
}
function merge(list) {
  const p = [], n = [], u = [], c = [];
  for (const [g0, col] of list) {
    const g = toNonIndexed(g0);
    const cnt = g.attributes.position.count;
    p.push(...g.attributes.position.array);
    n.push(...g.attributes.normal.array);
    u.push(...(g.attributes.uv ? g.attributes.uv.array : new Float32Array(cnt * 2)));
    for (let i = 0; i < cnt; i++) c.push(col[0], col[1], col[2]);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  out.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  out.computeBoundingSphere();
  return out;
}

let _geo = null;
/** 几何（原点在灯身中心，灯身半径 0.26 m、高约 0.55 m）：body 灯身；trim 木托 + 提梁 + 流苏（顶点色） */
function lanternGeometry() {
  if (_geo) return _geo;
  // 面数从简（回坊街区约 2000 盏）：灯身 8×5 分段（64 三角形），木托 / 提梁 / 流苏合计约 50 三角形
  const body = new THREE.SphereGeometry(0.26, 8, 5);
  body.scale(1, 1.05, 1);
  const BLACK = [0.05, 0.04, 0.035], GOLD = [0.72, 0.52, 0.18], TASSEL = [0.95, 0.72, 0.18];
  const capT = new THREE.CylinderGeometry(0.11, 0.145, 0.09, 6, 1, true).translate(0, 0.28, 0);
  const lidT = new THREE.CircleGeometry(0.11, 6).rotateX(-Math.PI / 2).translate(0, 0.325, 0);
  const capB = new THREE.CylinderGeometry(0.145, 0.11, 0.08, 6, 1, true).translate(0, -0.28, 0);
  const lidB = new THREE.CircleGeometry(0.11, 6).rotateX(Math.PI / 2).translate(0, -0.32, 0);
  const hook = new THREE.CylinderGeometry(0.012, 0.012, 0.16, 3, 1, true).translate(0, 0.40, 0);
  const tassel = new THREE.CylinderGeometry(0.025, 0.075, 0.34, 5, 1, true).translate(0, -0.49, 0);
  _geo = {
    body,
    trim: merge([[capT, BLACK], [lidT, GOLD], [capB, BLACK], [lidB, GOLD], [hook, BLACK], [tassel, TASSEL]]),
  };
  return _geo;
}

const _mats = new WeakMap();
function lanternMaterials(ctx) {
  let M = _mats.get(ctx);
  if (M) return M;
  const T = lanternTextures();
  const body = new THREE.MeshStandardMaterial({ map: T.map, emissiveMap: T.emis, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.62 });
  body.name = 'lantern-body';
  ctx.night.register(body, { day: 0.08, night: 0.8 });
  const trim = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25, emissive: 0x3a2400, emissiveIntensity: 0, side: THREE.DoubleSide });
  trim.name = 'lantern-trim';
  ctx.night.register(trim, { day: 0, night: 0.25 });
  M = { body, trim, halo: haloMaterial(ctx, 0xff8a3c, 0.1), glow: null };
  _mats.set(ctx, M);
  return M;
}

/** 光晕材质：InstancedMesh 的单位方片，在视空间里展开成朝向相机的圆斑（半径 = 实例缩放 × 0.5 m） */
function haloMaterial(ctx, color, gain) {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: ctx.uniforms.uNight, uColor: { value: new THREE.Color(color) }, uGain: { value: gain } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float s = length(instanceMatrix[0].xyz);
        // 向相机前移，避免方片插进身后的墙面被截断
        c.xyz += normalize(-c.xyz) * min(0.7 * s, max(0.0, length(c.xyz) - 1.0));
        c.xy += position.xy * s;
        gl_Position = projectionMatrix * c;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uNight, uGain; uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        #include <logdepthbuf_fragment>
        float r = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - r), 2.4) * smoothstep(0.25, 0.8, uNight) * uGain;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

function instanced(geo, mat, pos, scale, name, { shadow = false, yOff = 0 } = {}) {
  const n = pos.length / 3;
  const im = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(scale, scale, scale);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.set(pos[i * 3], pos[i * 3 + 1] + yOff, pos[i * 3 + 2]);
    // 绕竖轴随机转一点，免得“福”字全部朝同一方向
    q.setFromAxisAngle(_Y, ((i * 2654435761) % 1000) / 1000 * Math.PI * 2);
    m.compose(v, q, s);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.castShadow = shadow;
  im.receiveShadow = false;
  im.name = name;
  return im;
}
const _Y = new THREE.Vector3(0, 1, 0);

/**
 * 一组灯笼（pos：扁平 [x,y,z,...]，y 为灯身中心）。返回 Group（灯身、木托流苏、光晕三个实例网格）。
 * opts.scale 灯笼缩放（1 = 直径 0.52 m）；opts.halo 光晕直径（米，0 不要）
 */
export function lanternGroup(ctx, pos, { scale = 1, halo = 1.5, name = '红灯笼' } = {}) {
  const g = new THREE.Group();
  g.name = name;
  if (!pos.length) return g;
  const G = lanternGeometry(), M = lanternMaterials(ctx);
  g.add(instanced(G.body, M.body, pos, scale, name + '-灯身'));
  g.add(instanced(G.trim, M.trim, pos, scale, name + '-木托流苏'));
  if (halo > 0) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const h = instanced(plane, M.halo, pos, halo * scale, name + '-光晕');
    h.renderOrder = 3;
    h.frustumCulled = true;
    g.add(h);
  }
  return g;
}

let _poolTex = null;
function poolTexture() {
  if (_poolTex) return _poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.3, 'rgba(255,255,255,0.55)');
  gr.addColorStop(0.65, 'rgba(255,255,255,0.16)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  _poolTex = new THREE.CanvasTexture(c);
  _poolTex.colorSpace = THREE.SRGBColorSpace;
  return _poolTex;
}

/**
 * 夜间地面暖光斑（实例化贴地方片，叠加混合，白天强度 0）。pts：[[x, y, z, 直径, (sx 拉伸, yaw)], ...]
 */
export function groundGlow(ctx, pts, { color = 0xffa24e, night = 0.55, name = '地面暖光' } = {}) {
  const t = poolTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: color, emissiveMap: t, emissiveIntensity: 0, alphaMap: t, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, roughness: 1, metalness: 0,
  });
  ctx.overlay(mat, 0.0008);
  ctx.night.register(mat, { day: 0, night });
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, pts.length));
  const d = new THREE.Object3D();
  pts.forEach(([x, y, z, s, sx = 1, yaw = 0], i) => {
    d.position.set(x, y, z);
    d.rotation.set(0, yaw, 0);
    d.scale.set(s * sx, 1, s);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  });
  im.count = pts.length;
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  im.renderOrder = 2;
  im.castShadow = false;
  im.receiveShadow = false;
  im.name = name;
  return im;
}
