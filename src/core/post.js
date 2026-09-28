// 后期：HDR 多重采样渲染 → 泛光（夜景增强）→ 色调映射/输出 → FXAA（无 MSAA 时）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
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

export class Post {
  constructor(renderer, scene, camera, quality, reversedDepth) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.reversedDepth = reversedDepth;
    this.build(quality);
  }

  build(q) {
    if (this.composer) this.composer.dispose();
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: q.msaa || 0,
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
    if (!q.msaa) this.composer.addPass(new FXAAPass());
    this.quality = q;
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
  }

  setPixelRatio(pr) {
    this.composer.setPixelRatio(pr);
  }

  update(night) {
    if (!this.bloom) return;
    this.bloom.strength = 0.12 + night * 0.75;
    this.bloom.radius = 0.45 + night * 0.25;
    this.bloom.threshold = 0.95 - night * 0.25;
  }

  render(dt) {
    this.composer.render(dt);
  }
}
