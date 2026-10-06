// 天空与时间：Preetham 大气散射 + 云 + 夜空（星星、月亮、城市光污染辉光）、太阳/月亮光、雾、IBL 环境贴图
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { LAT0, LON0 } from './geo.js';
import { DAY_OF_YEAR, DEFAULT_HOURS } from './config.js';

const DEG = Math.PI / 180;

/** 太阳方向（世界坐标：x 东、y 上、z 南），hours 为北京时间 */
export function sunDirection(hours, day = DAY_OF_YEAR, out = new THREE.Vector3()) {
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (day + 10)) * DEG;
  const B = ((2 * Math.PI) / 364) * (day - 81);
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // 分钟
  const solar = hours + (LON0 - 120) / 15 + eot / 60;
  const H = (solar - 12) * 15 * DEG;
  const phi = LAT0 * DEG;
  const east = -Math.cos(decl) * Math.sin(H);
  const north = Math.sin(decl) * Math.cos(phi) - Math.cos(decl) * Math.cos(H) * Math.sin(phi);
  const up = Math.sin(decl) * Math.sin(phi) + Math.cos(decl) * Math.cos(H) * Math.cos(phi);
  return out.set(east, up, -north).normalize();
}

function moonDirection(hours, out) {
  // 简化：月亮落后太阳约 150°（上弦后的盈凸月），赤纬 +8°
  const decl = 8 * DEG;
  const H = ((hours + (LON0 - 120) / 15 - 12) * 15 - 150) * DEG;
  const phi = LAT0 * DEG;
  const east = -Math.cos(decl) * Math.sin(H);
  const north = Math.sin(decl) * Math.cos(phi) - Math.cos(decl) * Math.cos(H) * Math.sin(phi);
  const up = Math.sin(decl) * Math.sin(phi) + Math.cos(decl) * Math.cos(H) * Math.cos(phi);
  return out.set(east, up, -north).normalize();
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function makeSkyMaterial() {
  const sh = Sky.SkyShader;
  const vert = sh.vertexShader.replace(
    'gl_Position.z = gl_Position.w; // set z to camera.far',
    `#ifdef USE_REVERSED_DEPTH_BUFFER
      gl_Position.z = 0.0;
    #else
      gl_Position.z = gl_Position.w;
    #endif`
  );
  const frag = sh.fragmentShader
    .replace(
      'uniform float time;',
      `uniform float time;
      uniform float uNight;
      uniform vec3 uMoonDir;
      uniform float uStarRot;
      uniform vec2 uSkyKnee;
      uniform float uSkyGain;
      float shash(vec3 p){ p = fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }`
    )
    .replace(
      'vec3 texColor = ( Lin + L0 ) * 0.04 + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );',
      `vec3 skyLin = ( Lin + L0 ) * 0.04 * uSkyGain;
      {
        // 晴天压缩：three 的 Preetham 在太阳高时天顶 ~0.6、低仰角飙到 3~6，经 ACES 后蓝色通道先饱和，
        // 整片天空发白。先按太阳高度整体降增益（uSkyGain，天顶回到真实的深蓝区间），再对超过 uSkyKnee.x
        // 的亮度做 Reinhard 软肩（斜率 uSkyKnee.y）并保持色相，让地平线成为淡蓝而不是白；
        // 太阳圆盘在之后相加，不受压缩，泛光仍正常。
        float skyY = dot( skyLin, vec3( 0.2126, 0.7152, 0.0722 ) );
        float over = max( skyY - uSkyKnee.x, 0.0 );
        float skyC = skyY - over + over / ( 1.0 + over * uSkyKnee.y );
        skyLin *= skyC / max( skyY, 1e-5 );
      }
      vec3 texColor = skyLin + sundiscColor + vec3( 0.0, 0.0003, 0.00075 );`
    )
    .replace('cloudColor *= max( dayFactor, 0.03 );', 'cloudColor *= max( dayFactor, 0.03 ) * uSkyGain;')
    .replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      `{
        vec3 dir = direction;
        float hz = clamp(dir.y, -0.2, 1.0);
        // 夜空：天顶深蓝，地平线带城市光污染的暖褐色辉光
        vec3 nZen = vec3(0.0025, 0.0045, 0.012);
        vec3 nHor = vec3(0.030, 0.026, 0.030);
        vec3 nightCol = mix(nHor, nZen, smoothstep(0.0, 0.45, hz));
        nightCol += vec3(0.075, 0.040, 0.020) * exp(-max(dir.y, 0.0) * 12.0);
        // 星星（随时间缓慢旋转）
        float ca = cos(uStarRot), sa = sin(uStarRot);
        vec3 sd = vec3(ca*dir.x - sa*dir.z, dir.y, sa*dir.x + ca*dir.z) * 380.0;
        vec3 cell = floor(sd);
        float h = shash(cell);
        float star = 0.0;
        if (h > 0.9965) {
          vec3 c = cell + 0.5 + (vec3(shash(cell+1.3), shash(cell+2.1), shash(cell+3.7)) - 0.5) * 0.6;
          float d = length(sd - c);
          star = smoothstep(0.38, 0.0, d) * (h - 0.9965) / 0.0035;
          star *= 0.6 + 0.4 * sin(time * 2.7 + h * 100.0);
        }
        star *= smoothstep(0.02, 0.25, dir.y);
        // 月亮
        float md = dot(dir, normalize(uMoonDir));
        float disc = smoothstep(0.99983, 0.99990, md);
        vec3 moon = vec3(1.0, 0.96, 0.88) * disc * 1.6 + vec3(0.35, 0.40, 0.55) * pow(max(md, 0.0), 800.0) * 0.12;
        texColor = mix(texColor, texColor * 0.2, uNight) + (nightCol + vec3(0.9, 0.93, 1.0) * star * 0.9 + moon) * uNight;
      }
      gl_FragColor = vec4( texColor, 1.0 );`
    );
  const uniforms = THREE.UniformsUtils.clone(sh.uniforms);
  uniforms.uNight = { value: 0 };
  uniforms.uMoonDir = { value: new THREE.Vector3(0, 1, 0) };
  uniforms.uStarRot = { value: 0 };
  uniforms.uSkyKnee = { value: new THREE.Vector2(0.3, 1.5) }; // (软肩起点亮度, 压缩斜率)；y=0 即关闭
  uniforms.uSkyGain = { value: 1 }; // 白天整体增益（update 中按太阳高度设置）
  return new THREE.ShaderMaterial({
    name: 'XianSky',
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
}

const C = (hex) => new THREE.Color(hex);
// 按太阳高度角（度）插值的颜色表
// 白天的雾色取天空地平线颜色的 ~0.7 倍（亮度略低于地平线天空、偏淡蓝），远景向它收敛时呈薄霾而不是发白
const FOG_KEYS = [
  [-18, C('#06080d')], [-8, C('#0a0e17')], [-3, C('#343a52')], [1, C('#8c7b78')], [6, C('#b9a592')], [15, C('#afbccb')], [35, C('#b2c6dc')], [90, C('#b6c9de')],
];
// 太阳色（sRGB）与强度。白天天空整体增益压到 ~0.4 后，太阳直射需相应抬高，使直射:天光 ≈ 3~4:1（晴天的阴影对比）
const SUN_KEYS = [
  [-4, C('#ff6a3a'), 0], [0, C('#ff8248'), 0.9], [4, C('#ffa262'), 2.4], [10, C('#ffd4a4'), 3.9], [25, C('#ffeacc'), 6.0], [60, C('#fff3e4'), 6.8],
];
const HEMI_SKY = [[-10, C('#2a3656')], [0, C('#6f7ea6')], [10, C('#a9bddb')], [40, C('#c9d6e6')]];

function lerpKeys(keys, x, out) {
  if (x <= keys[0][0]) return out.copy(keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const t = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      return out.copy(keys[i - 1][1]).lerp(keys[i][1], t);
    }
  }
  return out.copy(keys[keys.length - 1][1]);
}
function lerpScalar(keys, x) {
  if (x <= keys[0][0]) return keys[0][2];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const t = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      return keys[i - 1][2] + (keys[i][2] - keys[i - 1][2]) * t;
    }
  }
  return keys[keys.length - 1][2];
}

export class SkySystem {
  constructor(renderer, scene, uniforms, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.uniforms = uniforms;
    this.hours = DEFAULT_HOURS;
    this.playing = false;
    this.speed = 1 / 60; // 游戏小时 / 真实秒（1 秒 = 1 分钟）
    this.night = 0;
    this.sunElev = 0;
    this._tween = null;
    // —— 画质与显示设置（core/display.js 写入）——
    this.fogScale = 1; // 雾浓度倍率（0 = 无雾）
    this.fogFloor = 0; // 雾浓度下限（视距受限时用来遮住远裁剪面）
    this.exposureScale = 1; // 曝光倍率
    this.shadowRange = 1; // 阴影覆盖范围倍率
    this.envEnabled = true; // 环境反射（IBL）
    this.cloudsEnabled = true;

    this.skyMat = makeSkyMaterial();
    const u = this.skyMat.uniforms;
    // 晴天大气：浑浊度低、瑞利散射强一些（天顶更蓝）、米氏散射弱（地平线不发白）
    u.turbidity.value = 2.4;
    u.rayleigh.value = 2.0;
    u.mieCoefficient.value = 0.0035;
    u.mieDirectionalG.value = 0.8;
    u.cloudCoverage.value = 0.2;
    u.cloudDensity.value = 0.28;
    u.cloudElevation.value = 0.55;
    this.sky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.skyMat);
    this.sky.scale.setScalar(90000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 1e6; // 最后画，节省填充率
    this.sky.name = 'sky';
    scene.add(this.sky);

    // 环境贴图用的独立天空场景
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.skyMat.clone());
    this.envSky.scale.setScalar(50);
    this.envSky.material.uniforms.showSunDisc.value = 0;
    this.envScene.add(this.envSky);
    // 环境里加一块“地面”，让反射下半球不是纯黑
    const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x6d6457 }));
    ground.position.y = -2;
    this.envGround = ground;
    this.envScene.add(ground);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;
    this._lastEnv = { el: 999, night: -1, t: -10 };

    // 太阳 / 月亮平行光（同一盏，按时段切换）
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = !!quality.shadows;
    this.sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 12000;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xc2d5ee, 0x5d5446, 0.8);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(0xb4c3d2, 3e-5);
    this.shadowSize = 800;

    this._sunDir = new THREE.Vector3();
    this._moonDir = new THREE.Vector3();
    this._tmpC = new THREE.Color();
    this.update(0, null);
  }

  setQuality(q) {
    this.sun.castShadow = !!q.shadows;
    if (q.shadowRange != null) this.shadowRange = q.shadowRange;
    if (this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
  }

  /** 环境反射（IBL）开关：关闭后不再渲染 PMREM 环境贴图，并略提高半球光补偿 */
  setEnvironment(on) {
    on = !!on;
    if (on === this.envEnabled) return;
    this.envEnabled = on;
    if (!on) {
      this.scene.environment = null;
      if (this.envRT) { this.envRT.dispose(); this.envRT = null; }
    } else {
      this._lastEnv.el = 999; // 下一帧立即重建
      this._lastEnv.t = -10;
    }
  }

  setClouds(on) {
    this.cloudsEnabled = !!on;
    this.skyMat.uniforms.cloudCoverage.value = on ? 0.2 : 0;
  }

  setHours(h, animate = false) {
    h = ((h % 24) + 24) % 24;
    if (!animate) {
      this._tween = null;
      this.hours = h;
      return;
    }
    // 走最短路径（跨午夜）
    let d = h - this.hours;
    if (d > 12) d -= 24;
    if (d < -12) d += 24;
    this._tween = { from: this.hours, delta: d, t: 0, dur: 2.5 };
  }

  toggleDayNight() {
    this.setHours(this.night > 0.5 ? 13.5 : 20.6, true);
  }

  update(dt, camera) {
    if (this._tween) {
      const tw = this._tween;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.hours = (((tw.from + tw.delta * e) % 24) + 24) % 24;
      if (k >= 1) this._tween = null;
    } else if (this.playing) {
      this.hours = (this.hours + dt * this.speed) % 24;
    }

    const sd = sunDirection(this.hours, DAY_OF_YEAR, this._sunDir);
    const md = moonDirection(this.hours, this._moonDir);
    const el = Math.asin(sd.y) / DEG;
    this.sunElev = el;
    this.night = 1 - smooth(-7, 5, el);

    const u = this.skyMat.uniforms;
    u.sunPosition.value.copy(sd).multiplyScalar(450000);
    u.uNight.value = this.night;
    u.uMoonDir.value.copy(md);
    u.uStarRot.value = (this.hours / 24) * Math.PI * 2;
    u.time.value += dt;
    // 太阳高度因子 hi：高太阳（≥40°）=1，低太阳（≤8°）=0，黄昏/清晨的色彩与亮度基本保持原样
    const hi = smooth(8, 40, el);
    // 白天天空增益：太阳高时 0.4（天顶回到深蓝、天光不压过直射光），低太阳回到 1
    u.uSkyGain.value = 1 - 0.6 * hi;
    // 软肩起点：高太阳 0.3（压住发白的地平线），低太阳 0.6（傍晚地平线的暖亮不被压暗）
    u.uSkyKnee.value.x = 0.6 - 0.3 * hi;
    const eu = this.envSky.material.uniforms;
    eu.sunPosition.value.copy(u.sunPosition.value);
    eu.uSkyGain.value = u.uSkyGain.value;
    eu.uSkyKnee.value.copy(u.uSkyKnee.value);
    eu.uNight.value = this.night;
    eu.uMoonDir.value.copy(md);
    eu.cloudCoverage.value = u.cloudCoverage.value;
    eu.time.value = u.time.value;

    // 共享 uniform
    this.uniforms.uNight.value = this.night;
    this.uniforms.uSunDir.value.copy(sd);

    // 平行光：白天=太阳，夜里=月亮
    const moonMode = el < -4;
    const lightDir = moonMode ? md : sd;
    if (moonMode) {
      this.sun.color.set(0x8fa6d8);
      this.sun.intensity = 0.32 * smooth(-4, -10, el) * smooth(-0.05, 0.25, md.y);
    } else {
      lerpKeys(SUN_KEYS, el, this.sun.color);
      this.sun.intensity = lerpScalar(SUN_KEYS, el);
    }
    this.hemi.color.copy(lerpKeys(HEMI_SKY, el, this._tmpC));
    this.hemi.groundColor.set(0x5d5446).lerp(C('#141210'), this.night);
    // 半球光：高太阳时减到 0.64（晴天直射为主、阴影有层次），低太阳时保持原来的 0.84
    this.hemi.intensity = 0.22 + (0.62 - 0.2 * hi) * (1 - this.night) + (this.envEnabled ? 0 : 0.3 * (1 - this.night) + 0.04);
    this.scene.environmentIntensity = 0.3 + 0.55 * (1 - this.night);

    // 雾（高度雾，见 core/fog.js）：颜色随太阳高度，并在朝向太阳时偏暖
    lerpKeys(FOG_KEYS, el, this.scene.fog.color);
    let agl = 0;
    if (camera) {
      agl = camera.userData.agl ?? camera.position.y - 400;
      this.sky.position.copy(camera.position);
      camera.getWorldDirection(this._fwd || (this._fwd = new THREE.Vector3()));
      const toward = Math.max(0, this._fwd.x * sd.x + this._fwd.z * sd.z) / Math.max(1e-3, Math.hypot(sd.x, sd.z));
      const warm = toward * toward * smooth(25, 2, el) * (1 - this.night);
      this.scene.fog.color.lerp(this._tmpC.copy(this.sun.color).multiplyScalar(0.9), warm * 0.45);
    }
    this.scene.fog.density = Math.max((2.4e-5 + this.night * 1.4e-5) * this.fogScale, this.fogFloor);

    // 曝光（Preetham 天空亮度高，白天需压低曝光，太阳光相应调强）
    this.renderer.toneMappingExposure = (0.6 + this.night * 0.55) * this.exposureScale;

    // 阴影相机跟随
    if (camera && this.sun.castShadow) this._updateShadow(camera, lightDir, agl);
    else if (camera) {
      this.sun.position.copy(camera.position).addScaledVector(lightDir, 5000);
      this.sun.target.position.copy(camera.position);
    }

    // 环境贴图（节流）
    const now = performance.now() / 1000;
    const L = this._lastEnv;
    if (this.envEnabled && (Math.abs(L.el - el) > 1.2 || Math.abs(L.night - this.night) > 0.04) && now - L.t > 0.35) {
      this._renderEnv();
      L.el = el;
      L.night = this.night;
      L.t = now;
    }
  }

  _updateShadow(camera, dir, agl) {
    // 阴影范围随高度变化：地面行走 ~350 m，高空 ~3.5 km
    const size = THREE.MathUtils.clamp(Math.max(agl, 20) * 2.2, 350, 3600) * this.shadowRange;
    this.shadowSize = size;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const focus = camera.position.clone().addScaledVector(fwd, size * 0.35);
    focus.y = camera.position.y - Math.max(agl, 0);
    // 以阴影贴图像素为步长对齐，避免移动时阴影闪烁
    const texel = (size * 2) / this.sun.shadow.mapSize.x;
    const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const up2 = new THREE.Vector3().crossVectors(dir, right).normalize();
    const r = Math.round(focus.dot(right) / texel) * texel;
    const u2 = Math.round(focus.dot(up2) / texel) * texel;
    const f = focus.dot(dir);
    focus.copy(right).multiplyScalar(r).addScaledVector(up2, u2).addScaledVector(dir, f);
    const cam = this.sun.shadow.camera;
    cam.left = -size;
    cam.right = size;
    cam.top = size;
    cam.bottom = -size;
    cam.far = 12000;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(dir, 6000);
    this.sun.target.updateMatrixWorld();
  }

  _renderEnv() {
    const night = this.night;
    this.envGround.material.color.set(0x6d6457).lerp(C('#0d0c0b'), night);
    const prev = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
    this.scene.environment = this.envRT.texture;
    if (prev) prev.dispose();
  }
}
