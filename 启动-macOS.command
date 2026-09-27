#!/bin/bash
# 双击运行：在本机起一个静态服务器并打开浏览器（需要 Python3 或 Node.js 其一）
cd "$(dirname "$0")"
DIR="dist"
if [ ! -f "$DIR/index.html" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "首次运行：正在构建（npm install && npm run build）……"
    npm install && npm run build || exit 1
  else
    echo "未找到 dist/，也没有 Node.js。请直接双击 dist-standalone/ 里的单文件版 HTML。"; read -r; exit 1
  fi
fi
PORT=4173
URL="http://localhost:$PORT/"
( sleep 1.2; open "$URL" ) &
# 优先用 Node 的零依赖服务器（支持 HTTP Range，离线影像包需要）；否则用 Python 版
if command -v node >/dev/null 2>&1; then
  node tools/serve.mjs "$DIR" $PORT
else
  python3 tools/serve.py "$DIR" $PORT
fi
