先完整读 /Users/xiaochoumao/Documents/github repo/xian3d/docs/FIX_ROUND2.md（第二轮修复通用说明，照它的开工准备、验证、提交要求执行）。所有回复与输出一律用简体中文。

你的任务：「小区与校园内部、未央城市广场、片区街景」。审查文件 MAIN/shots/audit2/all.json 里 module 为 compounds、weiyang、streetscape、sunken 的条目（约 20 条）都归你。
独占文件：src/modules/compounds.js、src/arch/compound-*.js、tools/build_sports.py、public/data/sports.json、src/modules/weiyang.js、src/modules/streetscape.js、src/arch/streetscape-*.js、src/modules/sunken.js、src/arch/sunken-*.js。
P0 必修：
1. 小区停放车辆是空壳/碎片（fe_兴庆老小区、fs_凤城八路、土门老小区等所有 40 m 低空机位）：src/arch/compound-props.js 的 carNear() 里顶/前/后/前挡后窗和两侧车窗的四边形顶点顺序反了，法线朝内被背面剔除。修好并检查本模块所有自建几何的绕向（或材质 DoubleSide 只在必要处）。
其余 P1/P2 照 all.json 修（花坛是平贴彩色圆点、草坪边缘锯齿台阶、小乔木方棱柱树干、围墙大门位置等）。
另外，高德住宅小区数据（小区真实名称 + 出入口坐标）正在抓取，暂时只在 MAIN/data-src/amap/compounds.json 里有一小块（兴庆路一带 36 条，字段 name/typecode/location(GCJ-02)/navi.entr_location(GCJ-02)）。请把 compounds 模块改成“有高德小区数据时，大门放到 entr_location 最近的围墙边、门头写高德小区名”的结构（坐标转换用 tools/amap_fetch.py 的 gcj2wgs 同款算法；前端读取文件用 src/core/data.js 的 loadJSON，文件建议放 public/data/local/compounds_amap.json，并写一个 tools/ 下的脚本从 data-src/amap/compounds.json 生成它），先用这 36 条验证。
验收：tools/tour_fine.json 的 fe_* 全部、tools/tour_spots.json 的 wy_plaza_air、wy_plaza_eye、st_weiyang_air，以及 all.json 里涉及的其他截图机位。