import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tilesPlugin } from './tools/range-static.mjs';

export default defineConfig({
  base: './',
  // 离线影像包在仓库根目录 tiles/（GB 级，不进 public/dist），开发/预览服务器挂到 /tiles/
  plugins: [tilesPlugin(path.dirname(fileURLToPath(import.meta.url)))],
  server: { port: 5173, strictPort: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
});
