先完整读 /Users/xiaochoumao/Documents/github repo/xian3d/docs/FIX_ROUND2.md（第二轮修复通用说明，照它的开工准备、验证、提交要求执行）。所有回复与输出一律用简体中文。

你的任务：「渲染核心、地面影像与水面」。审查文件 MAIN/shots/audit2/all.json 里 module 为 terrain、imagery、sky、post、water、core 及“推测：渲染核心近景地面”的条目（约 33 条）都归你。
独占文件：src/core/terrain.js、src/core/imagery.js、src/core/tilepack.js、src/core/sky.js、src/core/fog.js、src/core/post.js、src/core/lightpool.js、src/core/materials.js、src/core/textures.js、src/modules/water.js、src/arch/water-shader.js、tools/imagery_pack.py（影像包重打可以，重打后 tiles/ 不入库）。
P0 必修：
1. 永宁门 30 m 近水机位（p5_day，view=5）整座永宁门、东段城墙、相机脚下楼顶全部纯黑（像素 0~3），同画面树和路正常；同机位 skip=water 正常。高度怀疑 water.js 的近水镜面倒影那一遍渲染破坏了主渲染状态（阴影贴图/灯池/材质程序/渲染目标/深度设置/曝光等）。查清根因并修好，倒影保留。全城近水机位都验一遍（护城河、兴庆湖、曲江池、渭河）。
2. 浐灞（st_chanba_air 及附近）离线影像是冬季带雪的照片，楼间空地、绿地一片白斑，和 15 点秋季光照矛盾。方案二选一或组合：a) 影像包里按片区把带雪瓦片换成无雪源（data-src/tiles_hd 下已有 esri_clarity、bing、esri 缓存，缺的用 imagery_pack.py 下载），写成可复现的命令；b) 着色器里对“高亮低饱和的地面斑块”做去雪（只在无建筑的地面，别把白屋顶、水泥广场也灰掉）。先用 imagery_pack.py 的 bench/compare 量一下哪些片区有雪。
其余 P1/P2 照 all.json 修（近景地面、影像压阴影、天空、雾、夜景亮度等）。
验收：p5_day、p5_night、st_chanba_air、st_chanba_road、st_walltop、st_qujiangchi、st_furong、p1_day、p1_night，以及 all.json 里涉及的其他截图机位。