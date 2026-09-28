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
    if (this.composer) {
      for (const p of this.composer.passes) p.dispose?.();
      this.composer.dispose();
    }
    const r = this.renderer;
    const aa = aaMode(q);
    const want = aa.startsWith('msaa') ? parseInt(aa.slice(4)) || 4 : 0;
    const samples = Math.min(want, r.capabilities.maxSamples || 4);
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples,
    });
    if (this.reversedDepth) {
      // 反向深度需要浮点深度缓冲才能发挥精度
      rt.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.FloatType);
    }
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.sanitize = new ShaderPass(SanitizeShader);
    this.composer.addPass(this.sanitize);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.3, 0.55, 0.92);
    this.bloom.enabled = !!q.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    if (aa === 'fxaa') this.composer.addPass(new FXAAPass());
    else if (aa === 'smaa') this.composer.addPass(new SMAAPass());
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
    this.bloom.strength = (0.12 + night * 0.75) * this.bloomScale;
    this.bloom.radius = 0.45 + night * 0.25;
    this.bloom.threshold = 0.95 - night * 0.25;
  }

  render(dt) {
    this.composer.render(dt);
  }
}
