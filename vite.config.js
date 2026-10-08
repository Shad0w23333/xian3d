import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tilesPlugin } from './tools/range-static.mjs';

export default defineConfig({
  base: './',
  // 离线影像包在仓库根目录 tiles/（GB 级，不进 public/dist），开发/预览服务器挂到 /tiles/
  plugins: [tilesPlugin(path.dirname(fileURLToPath(import.meta.url)))],
  server: {
    port: 5173,
    strictPort: false,
    // 不监听大目录：截图（上万张）、影像包、数据源、代理工作树。批量增删这些文件时文件监听事件会把开发服务器
    // （以及 tools/tour.mjs、shot.mjs 进程内的 Vite）内存撑爆（2026-10-07 巡检中途 4 GB 堆溢出）
    watch: { ignored: ['**/shots/**', '**/tiles/**', '**/tiles_*/**', '**/data-src/**', '**/.claude/**', '**/research/**', '**/dist/**', '**/.venv-tools/**'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
});
