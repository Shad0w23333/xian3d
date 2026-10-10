# 数据精度专项（第三轮）：缺建模、楼高、颜色、穿模

西安 3D 城市模型（Three.js r186 + Vite）。主仓库：/Users/xiaochoumao/Documents/github repo/xian3d（下称 MAIN）。所有输出用简体中文。

## 用户原话
- 2026-10-09：“还是不完美，我要每一个角落都完美。”
- 2026-10-10：“还有很多地方没做好：穿模和缺失建模！以及楼层高度不对、细节建筑错误、颜色错误！我要像素级别精准。”

全城网格巡检（MAIN/shots/grid1/，960 张，机位 MAIN/tools/tour_grid.json）里能看到的典型问题：
- 城中村整片屋顶只画在影像上，没有 3D 楼；
- 在建高层整片缺失；
- 小区被树阵顶替；
- 住宅塔楼被画成黑玻璃楼；
- 一栋楼整栋压在车道上；
- 围栏圈进人行道；
- 灯杆穿过树冠；
- 树种在步道中间；
- 远处楼块是深棕色色块。

看图只能抽查，**这一轮要用算法逐栋、逐个物体覆盖全城**，并用量化指标证明改好了。

## 共同规则
1. **工作树**：MAIN/.claude/worktrees/r3-acc-<任务>，分支同名，软链接已建。开工先看 git log --oneline main..HEAD 和 git diff，你可能是被中断的前任的接替者。
2. **建筑数据 public/data/buildings.bin 的修改一律写成可重复运行的处理脚本（幂等）**。规则沿用 tools/buildings_patch.py：
   - 不重排已有建筑的下标；
   - 删除用 flags bit7；
   - 补楼追加到末尾；
   - 重跑时先去掉自己上次追加的那段，用你自己的标记区分。
   全城流水线的固定顺序（tools/buildings_pipeline.sh）：
   build_buildings_v2.py（不重跑）→ buildings_patch.py → cnbh_boost.py → **bstage_missing.py** → **bstage_heights.py** → **bstage_colors.py** → amap_buildings.py
   你的脚本必须能在“前面各步已跑完”的任意 buildings.bin 上运行。合并时由总负责人在主线上按顺序重跑整条流水线，所以三项可以并行开发。
   你的工作树里的 buildings.bin 只是你这一步在当前主线数据上的输出，用于自己验证。
3. **量化验证**：每项都要有修前和修后的全城指标（下面各任务里定义），并在至少 12 个随机格子（tour_grid.json 的 ga_/ge_ 机位）拍修后图，与影像或修前图并排对比，用 Read 亲眼看。
4. 提交要勤：每完成一步就提交。中文提交信息，末行写 Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>。不提交软链接、shots/ 和 data-src/，不 push。
5. 每次拍图都要确认：moduleErrors 为空、无 pageerror、无 GL_INVALID。性能预算：三角形 ≤ +10%，draw call ≤ +40（node tools/perf.mjs --views 2,4,7）。补楼导致三角形增加时，必须同时说明并控制在预算内，例如低层楼用更简模型。

## 可用数据（MAIN/data-src，未入库）
- heights/raw/：cmab（China Multi-Attribute Building：屋顶轮廓、高度、层数、功能、年代，2022 影像）、cnbh（10 m 建筑高度栅格）、ghsl（建成区与建筑高度）、globfp（3D-GloBFP 逐栋轮廓与高度，CC BY 4.0）、osm；
- heights/：cnbh_main.npy、ghsl_main.npy（含 .json 地理参数）、cmab_xian.npz、eval_rows.csv（OSM 实测高度的楼，可做高度真值）；
- buildings_v2/：stage_footprints.pkl、stage_features.pkl（构建中间产物，含各源匹配信息）、osm_buildings_main.json、对齐检查图；
- tiles_hd/：高清影像缓存（esri_clarity、esri、google、bing、amap_wgs、tencent_wgs 等），离线影像包读取方法见 tools/imagery_pack.py；
- 工具：tools/bldbin.py（读写 buildings.bin）、tools/geo.py（投影）、tools/height_source.py、tools/heights_eval.py、tools/verify_buildings.py。
