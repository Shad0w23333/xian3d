// 后期：HDR 多重采样渲染 → 泛光（夜景增强）→ 色调映射/输出 → FXAA/SMAA（可选，见“画质与显示”）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * NaN/Inf 钳制：任何一个 NaN 像素进入泛光模糊后都会扩散成整屏黑（Metal 默认 fast-math，
 * isnan()/x!=x 可能被优化掉，所以用位运算判断指数位全 1）。HalfFloat 溢出（>65504 → +Inf）是“极亮”，
 * 饱和到上限而不是变黑；NaN 与 -Inf 置 0（符号位同样用位运算判断，不依赖浮点比较）。
 */
const SanitizeShader = {
  name: 'SanitizeShader',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    float sane(float x) {
      uint b = floatBitsToUint(x);
      if ((b & 0x7f800000u) == 0x7f800000u) return (b & 0x807fffffu) == 0u ? 256.0 : 0.0; // +Inf → 上限；NaN / -Inf → 0
      return clamp(x, 0.0, 256.0);
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(sane(c.r), sane(c.g), sane(c.b), 1.0);
    }`,
};

/**
 * 泛光取亮（替换 UnrealBloomPass 自带的 LuminosityHighPass）：
 *  · three 自带的高通是“亮度过阈值就整像素原样送进泛光”，阈值附近的墙面、近处整块招牌会把全部能量糊出去；
 *    这里改为减去阈值后的超出部分（带软膝，过渡平滑），亮度刚过阈值的像素只贡献一点点；
 *  · 超出部分再做软封顶（uCap）：近处占大半屏的招牌、灯笼、车灯不会把半个画面糊成一团，远处小光点照样有辉光。
 */
const BrightPassShader = {
  name: 'XianBrightPass',
  uniforms: {
    tDiffuse: { value: null },
    luminosityThreshold: { value: 1.0 },
    smoothWidth: { value: 0.01 },
    uKnee: { value: 0.5 },
    uCap: { value: 2.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float luminosityThreshold;
    uniform float uKnee;
    uniform float uCap;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float v = max(max(c.r, c.g), c.b);                 // 用最大通道：饱和的红/蓝灯不会因亮度低而漏掉，也不会放过头
      float t = luminosityThreshold, k = max(uKnee, 1e-4);
      float soft = clamp(v - t + k, 0.0, 2.0 * k);
      soft = soft * soft / (4.0 * k);
      float over = max(soft, v - t);                     // 超出阈值的部分（软膝）
      over = over / (1.0 + over / uCap);                   // 软封顶
      gl_FragColor = vec4(c * (over / max(v, 1e-4)), 1.0);
    }`,
};

/** 画质对象 → 抗锯齿方式（兼容旧字段 msaa） */
export function aaMode(q) {
  if (q.aa) return q.aa;
  return q.msaa ? 'msaa' + q.msaa : 'fxaa';
}

export class Post {
  constructor(renderer, scene, camera, quality, reversedDepth) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.reversedDepth = reversedDepth;
    this.bloomScale = 1;
    this.build(quality);
  }

  /**
   * 重建后期管线（抗锯齿方式 / 像素比变化时调用；泛光开关与强度用 setBloom，不必重建）。
   * 顺序：RenderPass（HDR，可 MSAA）→ Sanitize（NaN 钳制，必须紧跟 RenderPass）→ 泛光 → Output（色调映射/sRGB）→ FXAA/SMAA
   */
  build(q) {
    const r = this.renderer;
    const aa = aaMode(q);
    const want = aa.startsWith('msaa') ? parseInt(aa.slice(4)) || 4 : 0;
    const samples = Math.min(want, r.capabilities.maxSamples || 4);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const makeRT = () => {
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        samples,
      });
      if (this.reversedDepth) {
        // 反向深度需要浮点深度缓冲才能发挥精度
        rt.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.FloatType);
      }
      return rt;
    };
    if (this.composer) {
      // 已有管线：泛光/输出/NaN 钳制通道原样复用（原先整条重建，换 MSAA 档位首帧卡 0.15~3 s），
      // 只换主渲染目标（采样数或尺寸变了才换）和末尾的 FXAA/SMAA 通道
      if (samples !== this.samples) this.composer.reset(makeRT());
      // 像素比/窗口尺寸可能也变了（像素比调整会走到这里）：按渲染器当前尺寸重设各通道
      const css = r.getSize(new THREE.Vector2());
      this.composer.setPixelRatio(r.getPixelRatio());
      this.composer.setSize(css.x, css.y);
      if (aa !== this.aa) {
        if (this.aaPass) {
          this.composer.removePass(this.aaPass);
          this.aaPass.dispose?.();
          this.aaPass = null;
        }
        if (aa === 'fxaa') this.aaPass = new FXAAPass();
        else if (aa === 'smaa') this.aaPass = new SMAAPass();
        if (this.aaPass) this.composer.addPass(this.aaPass);
      }
      this.bloom.enabled = !!q.bloom;
      this.aa = aa;
      this.samples = samples;
      this.bloomScale = q.bloomStrength ?? 1;
      this.quality = q;
      return;
    }
    const rt = makeRT();
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.sanitize = new ShaderPass(SanitizeShader);
    this.composer.addPass(this.sanitize);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.3, 0.55, 0.92);
    {
      // 换掉自带的高通取亮（见 BrightPassShader）
      const hp = this.bloom.materialHighPassFilter;
      hp.fragmentShader = BrightPassShader.fragmentShader;
      hp.uniforms.uKnee = { value: 0.5 };
      hp.uniforms.uCap = { value: 2.0 };
      hp.needsUpdate = true;
      this.bloom.highPassUniforms = hp.uniforms;
    }
    this.bloom.enabled = !!q.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.aaPass = aa === 'fxaa' ? new FXAAPass() : aa === 'smaa' ? new SMAAPass() : null;
    if (this.aaPass) this.composer.addPass(this.aaPass);
    this.aa = aa;
    this.samples = samples;
    this.bloomScale = q.bloomStrength ?? 1;
    this.quality = q;
  }

  /** 泛光开关与强度倍率（立即生效；关闭时整条泛光通道跳过，不再占用填充率） */
  setBloom(on, scale = this.bloomScale) {
    this.bloomScale = scale;
    if (this.bloom) this.bloom.enabled = !!on && scale > 0;
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
  }

  setPixelRatio(pr) {
    this.composer.setPixelRatio(pr);
  }

  update(night) {
    if (!this.bloom) return;
    // 室内/地下（天空被隐藏，例如进入地铁站）：按白天的泛光参数（灯带不糊成白雾），与 sky.js 的室内曝光对应
    if (!this._sky || this._sky.parent !== this.scene) this._sky = this.scene.children.find((o) => o.material && o.material.name === 'XianSky') || null;
    if (this._sky && !this._sky.visible) night = 0;
    // 取亮已改为“减阈值 + 软封顶”（BrightPassShader），进入泛光的能量比原来小得多，强度相应提高。
    // 夜里半径收小（原 0.7：最宽的两级模糊权重最大，每盏灯/每块招牌都是一个大光团），光晕集中在灯具附近。
    this.bloom.strength = (0.25 + night * 0.65) * this.bloomScale;
    this.bloom.radius = 0.4 - night * 0.15;
    // 白天阈值 1.3：天空经软肩后 ≤1、向阳白墙 ~1.3，只让太阳盘/高光泛光，避免地平线与屋顶糊成白雾；夜里 0.85
    this.bloom.threshold = 1.3 - night * 0.45;
    const hp = this.bloom.highPassUniforms;
    if (hp.uKnee) {
      hp.uKnee.value = 0.25 + night * 0.15;
      // 软封顶：夜里超出阈值的部分最多约 1.6（近处大块发光体不再把能量全部糊出去）
      hp.uCap.value = 5.0 - night * 3.4;
    }
  }

  render(dt) {
    this.composer.render(dt);
  }
}
