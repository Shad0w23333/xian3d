@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist dist\index.html (
  echo 首次运行：正在构建……
  call npm install || exit /b 1
  call npm run build || exit /b 1
)
start "" http://localhost:4173/
where python >nul 2>nul && (python -m http.server 4173 --directory dist) || (npx --yes serve -l 4173 dist)
