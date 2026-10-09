先完整读 /Users/xiaochoumao/Documents/github repo/xian3d/docs/FIX_ROUND2.md（第二轮修复通用说明，照它的开工准备、验证、提交要求执行）。所有回复与输出一律用简体中文。

你的任务：「道路」。审查文件 MAIN/shots/audit2/all.json 里 module 为 roads 的条目（29 条，其中 P0/P1 10 条）都归你；另外审查员标成 terrain/其他、但实际是路面、人行道、分隔带、标线、路灯、桥梁、路口铺面的，也归你（先用 skip=roads 核实）。
独占文件：src/modules/roads.js、src/arch/roads_*.js、src/core/roadheight.js、public/data/roads.json、tools/roads_junctions.mjs（及其他 tools 下道路数据脚本，若需要新建也可）。注意：src/modules/weiyang.js 在 prepare 里改路网（张家堡环岛改十字），改 roads.json 后要确认 weiyang 的补丁仍能应用（启动日志有“[weiyang] 张家堡环岛改十字”）。
重点：人眼高度下的路面/人行道/路缘/分隔带/路口细节、夜景路灯、桥梁护栏。逐条照 all.json 修，P0/P1 必修。
验收：all.json 里涉及的截图机位重拍，另加 p1_night（全城夜景路网光带不能变差）、st_bell_east、st_weiyang_road。