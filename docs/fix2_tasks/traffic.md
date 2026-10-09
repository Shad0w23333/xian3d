先完整读 /Users/xiaochoumao/Documents/github repo/xian3d/docs/FIX_ROUND2.md（第二轮修复通用说明，照它的开工准备、验证、提交要求执行）。所有回复与输出一律用简体中文。

你的任务：「交通、行人、停车场与街道设施」。审查文件 MAIN/shots/audit2/all.json 里 module 为 traffic、pedestrians、parking、streetfurniture 的条目（约 27 条）都归你。
独占文件：src/modules/traffic.js、src/arch/traffic_*.js、src/arch/vehicle-*.js、src/modules/pedestrians.js、src/arch/people-geo.js、src/modules/parking.js、tools/build_parking.py、public/data/parking.json、src/modules/streetfurniture.js、src/arch/furniture-*.js、tools/build_furniture_data.mjs。
P0 必修：
1. 鼓楼门洞前（st_drum：南侧通往门洞的路段与城台东侧广场）停了一排私家车。鼓楼门洞连北院门步行街，门前是步行广场。根因多半是 src/arch/vehicle-parking.js 的路边停车没避开地标/步行区。全城排查：路边停车与车流不得进入任何精建模块的排除区（ctx.exclusions，buildings/roads 标记）、回民街（huimin）街区、步行街（pedestrian）、寺院景区；**回民街西羊市（机位 st_oldtown_alley）也停着汽车**，一并修。
其余 P1/P2 照 all.json 修（行人位置、车辆穿模、开在绿化带上、设施位置等）。
验收：all.json 里涉及的截图机位重拍，另加 st_drum、st_oldtown_alley、st_beiyuanmen、st_bell_east、st_xiaozhai、fs_长安南路。