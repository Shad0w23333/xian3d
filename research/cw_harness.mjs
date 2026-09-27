// 临时自测：node 下用桩 ctx 跑 citywall.build（不渲染）
import fs from 'fs';
const mkCtx2d = (c) => new Proxy({}, { get(t, k) {
  if (k === 'getImageData' || k === 'createImageData') return (x, y, w, h) => { const W = (typeof w === 'number' ? w : x) || c.width, H = (typeof h === 'number' ? h : y) || c.height; return { data: new Uint8ClampedArray(W * H * 4), width: W, height: H }; };
  if (k === 'measureText') return (s) => ({ width: 10 * String(s).length, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
  if (k === 'canvas') return c;
  if (k in t) return t[k];
  return () => ({ addColorStop() {} });
}, set(t, k, v) { t[k] = v; return true; } });
globalThis.document = { createElement: () => { const c = { width: 1, height: 1, style: {} }; c.getContext = () => mkCtx2d(c); return c; } };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return mkCtx2d(this); } };
const THREE = await import('three');
const mod = (await import('../src/modules/citywall.js')).default;
const textures = await import('../src/core/textures.js');
const data = { landmarks: JSON.parse(fs.readFileSync('public/data/landmarks.json')), water: JSON.parse(fs.readFileSync('public/data/water.json')) };
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 50000);
camera.position.set(-250, 480, 1480);
const ctx = { THREE, scene, camera, data, tex: textures, uniforms: { uNight: { value: 0 }, uTime: { value: 0 } },
  terrain: { heightAt: (x, z) => 405 + Math.sin(x * 0.001) * 3 + Math.cos(z * 0.0013) * 2, addFlatten() {} },
  exclusions: { add() {} }, night: { register() {} }, lights: { add() {} }, labels: { add() {} }, quality: { level: 2 } };
mod.prepare(ctx);
const t0 = performance.now();
const api = await mod.build(ctx);
console.log('build ms', (performance.now() - t0).toFixed(0));
api.update(0, 0);
let meshes = 0, vis = 0, tris = 0;
const byName = {};
scene.traverse((o) => { if (o.isMesh) { meshes++; const g = o.geometry; const t = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); tris += t; const top = o.parent?.name || ''; byName[top] = (byName[top] || 0) + t; } });
console.log('meshes', meshes, 'tris', (tris / 1e6).toFixed(2) + 'M');
console.log(Object.entries(byName).map(([k, v]) => k + ':' + (v / 1000).toFixed(0) + 'k').join('  '));
