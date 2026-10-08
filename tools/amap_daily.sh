#!/bin/bash
# 高德数据每日续抓：核心区（默认范围 108.84~109.08E, 34.17~34.40N）→ 外圈四条带（长安 / 高新西 / 浐灞东 / 北客站北），
# 每块依次：全部类别 POI → 汽车/摩托第二遍 → 住宅小区第三遍（小区名 + 出入口）→ 交通态势道路；最后地铁/区划/地标，再合并进 public/data。
# 不设本地请求上限，一直跑到高德返回账号日配额用尽（各接口配额独立：某一步配额用尽只停那一步、其余照跑）；
# 已缓存的请求不再消耗配额，每天运行一次直到全部抓完。
# 用法：bash tools/amap_daily.sh   （Key 读仓库根 .env 的 AMAP_KEY）
cd "$(dirname "$0")/.." || exit 1
PY=.venv-tools/bin/python
run() { echo "=== $* $(date '+%F %T')"; $PY tools/amap_fetch.py "$@" --max-requests 1000000 || echo "（未完成：配额用尽或出错，明天续跑）"; }
BOXES=(
  "108.84,34.17,109.08,34.40"   # 核心区（与脚本默认范围一致，续用已有缓存）
  "108.80,34.08,109.10,34.17"   # 南：长安区（韦曲、郭杜、大学城）
  "108.78,34.17,108.84,34.40"   # 西：高新西区、沣东
  "109.08,34.17,109.12,34.40"   # 东：浐灞、灞桥
  "108.80,34.40,109.10,34.46"   # 北：北客站以北、渭河
)
for b in "${BOXES[@]}"; do run poi --bbox "$b"; done
for b in "${BOXES[@]}"; do run poi2 --bbox "$b"; done
for b in "${BOXES[@]}"; do run poi3 --bbox "$b"; done
for b in "${BOXES[@]}"; do run roads --bbox "$b"; done
run metro; run district; run place
$PY tools/amap_fetch.py status
echo "=== merge $(date '+%F %T')"
$PY tools/amap_fetch.py merge --core-cap 300000
echo "=== 楼名 $(date '+%F %T')"
$PY tools/amap_buildings.py
