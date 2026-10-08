# 第二轮找茬修复：通用说明（7 个修复代理共读）

你在西安 3D 城市模型工程（Three.js r186 + Vite）的一个**独立 git 工作树**里修复问题。主仓库：/Users/xiaochoumao/Documents/github repo/xian3d（下称 MAIN）。基线提交 3a520a1（工作树应包含它，`git log --oneline -3` 可见；不包含且没有你的改动时先 `git reset --hard 3a520a1`）。

## 背景
已做完两轮修复与一轮精修（HANDOFF.md 第 13、14 节），并接入了高德全量店铺（public/data/local/，src/core/data.js 优先读取）。
用户说“提升很大，但还不满意，继续往精细方向做”。我们对最新的 89 张巡检截图做了第二轮审查，共 293 条问题（P0 12、P1 111、P2 170），
全部在 **MAIN/shots/audit2/all.json**（每条：shot / where / what / severity / category / module / evidence / fix_hint / _g 组号）。
截图：巡检 MAIN/shots/tour3/<id>.png（机位表 tools/tour_spots.json）、精细巡检 MAIN/shots/fine2/<id>.png（tools/tour_fine.json）、审查补拍 MAIN/shots/audit2/gN/。
**只修属于你文件范围的条目**（按 module 字段与你自己的判断；审查员标的模块是推测时要先核实）。P0、P1 必修，P2 视成本取舍。

## 开工准备（必须先做）
在工作树根目录执行（这些目录不在 git 里）：
    ln -s "MAIN/node_modules" node_modules; ln -s "MAIN/tiles" tiles; ln -s "MAIN/data-src" data-src; ln -s "MAIN/.venv-tools" .venv-tools
（MAIN 换成上面的绝对路径，路径含空格要加引号。）然后读 HANDOFF.md 第 3 节（目录结构）与第 13、14 节。

## 截图与验证
    node tools/shot.mjs --w 1280 --h 720 --wait 200 --frames 60 --shot "online=0&ll=lon,lat,离地高,目标lon,目标lat,目标离地高&time=15|shots/fix2_<任务>/x.png"
批量：node tools/tour.mjs --list tools/tour_spots.json --out shots/fix2_<任务>/after --only id1,id2（一次加载连拍，工具内置 Vite 不热更新，可边改边拍）。
参数：view=1..0 预设视角；time=小时；modules=a,b 只加载；skip=a,b 跳过（判断来源）；q=0..3；labels=1 显示标注；一律加 online=0。
性能：node tools/perf.mjs --views 2,4,7（改前改后各一次）；预算：三角形 ≤ +10%、draw call ≤ +40。
本机同时有 7 个代理在跑浏览器，截图慢属正常；整幅纯白就重拍。截图用 Read 查看。
每项：先复现 → 找根因 → 修 → 同机位拍修前/修后（存 shots/fix2_<任务>/before、after）。moduleErrors 为空、无 pageerror、无 GL_INVALID 警告。
**机位问题不归你**（审查里 category=机位 的条目由总负责人改机位表）；如果某张截图因机位不好看不清你的问题，自己另选机位验证。
临时文件放你自己的目录（不要用会话共用的 scratchpad 公共目录）。

## 提交
只改你“独占文件”清单里的文件，新建文件随意；必须改清单外文件时改动要极小，并在汇报里写明。
git add 你改的文件（不要提交那四个软链接，也不要提交 shots/）→ git commit（中文提交信息，末尾一行 Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>），不要 push。
最终回复（简体中文）：提交号；逐条“问题 → 根因 → 改法 → 修后截图路径”；没修的及原因；性能对比；改动文件清单。
