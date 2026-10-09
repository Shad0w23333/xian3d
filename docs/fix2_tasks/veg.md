先完整读 /Users/xiaochoumao/Documents/github repo/xian3d/docs/FIX_ROUND2.md（第二轮修复通用说明，照它的开工准备、验证、提交要求执行）。所有回复与输出一律用简体中文。

你的任务：「植被、用地与公园水岸」。审查文件 MAIN/shots/audit2/all.json 里 module 为 vegetation、landuse、parks 的条目（约 36 条）都归你。
独占文件：src/modules/vegetation.js、src/arch/veg*.js、src/modules/landuse.js、src/modules/parks.js、src/arch/park-*.js、src/arch/water-banks.js、tools/build_parks.py、public/data/parks.json。（src/modules/water.js 归渲染核心任务，你不要改；如需它配合在汇报里说明。）
P0 必修：
1. 大雁塔北广场（st_dayanta_sq）一道汉白玉栏杆架在深色桥身上横跨音乐水池，把看大雁塔的中轴视线拦腰截断。根因：parks.json 里一条 4 m 宽园路正好压在水池北沿，被判成园桥并抬高加栏杆。修法：精建模块（pagoda/datang/qujiang 等登记了排除区的地标）范围内不做园桥/栏杆；园桥判定要求真的跨越水面（两端在岸上、中段在水上）且不在喷泉水池/景观水池上。全城排查同类误判的“园桥”。
另外审查里提到渭河边一排白色半拱（g1，来源未查清，已排除植被）——先用 skip=parks / skip=water 核实是不是你的护岸或亲水平台。
其余 P1/P2 照 all.json 修（树种植位置、穿模、树型、草丛、花境、公园设施等）。
验收：all.json 里涉及的截图机位重拍，另加 st_dayanta_sq、st_qujiangchi、st_walltop、st_weihe_bridge。