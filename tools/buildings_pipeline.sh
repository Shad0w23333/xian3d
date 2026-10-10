#!/bin/bash
# 通用建筑数据流水线（就地改写 public/data/buildings.bin 及其附属文件；每一步幂等，可整条重跑）。
# 固定顺序：buildings_patch → cnbh_boost → bstage_missing（补缺楼、去假楼）→ bstage_heights（楼高与层数）
#           → bstage_colors（逐栋影像取色）→ amap_buildings（高德楼名）。某一步的脚本不存在就跳过。
# build_buildings_v2.py 是从源数据重建，耗时且会重排下标，不在本流水线内。
# 用法：bash tools/buildings_pipeline.sh
cd "$(dirname "$0")/.." || exit 1
PY=.venv-tools/bin/python
for s in buildings_patch cnbh_boost bstage_missing bstage_heights bstage_colors amap_buildings; do
  if [ -f "tools/$s.py" ]; then
    echo "=== $s $(date '+%F %T')"
    $PY "tools/$s.py" || { echo "（$s 失败，流水线中止）"; exit 1; }
  fi
done
echo "=== 流水线完成 $(date '+%F %T')"
