@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist dist\index.html (
  echo 首次运行：正在构建……
  call npm install || exit /b 1
  call npm run build || exit /b 1
)
start "" http://localhost:4173/
where node >nul 2>nul && (node tools\serve.mjs dist 4173) || (python tools\serve.py dist 4173)
