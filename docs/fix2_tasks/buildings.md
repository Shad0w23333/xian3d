先完整读 /Users/xiaochoumao/Documents/github repo/xian3d/docs/FIX_ROUND2.md（第二轮修复通用说明，照它的开工准备、验证、提交要求执行）。所有回复与输出一律用简体中文。

你的任务：「通用建筑」。审查文件 MAIN/shots/audit2/all.json 里 module 为 buildings 的条目（58 条，其中 P0/P1 28 条）都归你。
独占文件：src/modules/buildings.js、src/arch/bld-*.js、src/arch/apt_data.js、public/data/buildings.bin、public/data/buildings_names.json、public/data/local/buildings_names.json、public/data/estates_style.json、tools/build_buildings_v2.py、tools/buildings_patch.py、tools/cnbh_boost.py、tools/amap_buildings.py。保留 buildings.js 导出的 occluded()/nearestFacade() 接口。

三条 P0 必修：
1. 含光路东侧（fs_含光路）一片 OSM/CMAB 轮廓整体比离线影像（z19）向西偏约 12.5 m、向南约 2.5 m，西墙被裁到车行道边线上，没有人行道。请查清偏移范围（是单个数据源块的系统偏移？），在 tools/buildings_patch.py 里做可复现的局部平移校正（按影像核对，别误伤正确的楼），并排查全城还有没有类似整片偏移。
2. 汉城湖岸（st_res_north）三栋 26~32 m 住宅塔楼凭空立在湖边，一栋一半压在水面里；影像上没有这些楼，湖南岸是汉长安城遗址保护区。查来源（cnbh_boost？GloBFP 补楼？原始数据？），删掉（flags bit7）并排查同类：落在水面里的楼、遗址保护区里的高楼。
3. 南大街东侧人行道（st_bell_south）一块 3 m 厚 12 m 长 16 m 高的黑色薄板“楼”：OSM 碎片轮廓。全城排查这种细条碎片（外接矩形窄边 < 4 m 且高 > 8 m 且离主楼有缝、或落在道路/人行道上），删掉或并回主楼。
其余 P1/P2 照 all.json 修（立面、屋顶、高度、配色、夜景亮窗等）。另外，public/data/local/buildings_names.json 是用高德楼名补的（tools/amap_buildings.py），如审查里有楼名/楼顶字放错楼的条目也归你。
验收：all.json 里涉及的截图机位重拍（tools/tour_spots.json、tools/tour_fine.json 对应 id），另加 p2_day、p7_day。