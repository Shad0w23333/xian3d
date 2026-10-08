# 修复轮通用说明（10 个修复代理共读）

你在西安 3D 城市模型工程（Three.js r186 + Vite）的一个**独立 git 工作树**里修复问题。主仓库：/Users/xiaochoumao/Documents/github repo/xian3d（下称 MAIN）。基线提交 bc5813a。

## 开工准备（必须先做）
在你的工作树根目录执行（这些目录不在 git 里）：
    ln -s "MAIN/node_modules" node_modules; ln -s "MAIN/tiles" tiles; ln -s "MAIN/data-src" data-src; ln -s "MAIN/.venv-tools" .venv-tools
（MAIN 换成上面的绝对路径，路径含空格要加引号。tiles 是本地离线高清影像包，没有它截图的地面会和用户看到的不一样。）
然后读 HANDOFF.md 第 3 节（目录结构）与第 11~12 节。

## 问题来源
用户说“还是很多错误、不满意”。我们做了全城 56 机位巡检 + 交互冒烟测试，11 个审查员逐张挑错，结果在 **MAIN/shots/audit/g1.json ~ g11.json**（部分还在写入；开工时读一遍，收尾前再读一遍，后来的条目里属于你文件范围的也要修）。每条有 shot / where / what / severity(P0>P1>P2) / module / evidence / fix_hint。截图在 MAIN/shots/tour1/、MAIN/shots/audit/gN/。
**只修属于你文件范围的条目**；你的任务说明里列了重点，但审查文件里其余属于你范围的条目也要处理（P2 视成本取舍）。

## 已由总负责人修好（不要重复）
- 相机背后的标注被镜像投到画面（labels.js / roadnames.js 已改用视空间判断）
- 标注按离地高度收紧距离、被通用建筑遮挡时隐藏、labels=0 联动关闭路名/小区名
- 人眼高度地面是糊掉的蓝色卫星图 → terrain.js 近景改为程序化铺装/草地/土面，全距离压蓝
注意：审查截图多是在这些修复**之前**拍的，复现时以当前代码为准。

## 截图与验证
    node tools/shot.mjs --w 1280 --h 720 --wait 200 --frames 60 --shot "online=0&ll=lon,lat,离地高,目标lon,目标lat,目标离地高&time=15|shots/fix/x.png"
参数：view=1..0 / !1..!5 预设视角；time=小时；modules=a,b 只加载；skip=a,b 跳过（判断来源）；q=0..3；labels=1 显示标注；一律加 online=0。
批量：node tools/tour.mjs --list <机位json> --out <目录>（格式见 tools/tour_spots.json，一次加载连续拍，快）。
性能：node tools/perf.mjs --views 2,4,7 [--night]（改动后三角形/帧率不能明显变差）。
本机有约 10 个代理同时在跑浏览器，截图慢属正常；整幅纯白（GPU 上下文丢失）就重拍。截图用 Read 查看。
每个问题：先复现 → 找根因 → 修 → 同机位重拍对比（修前/修后存 shots/fix_<任务>/）。moduleErrors 必须为空、无 pageerror。

## 提交
只改你“独占文件”清单里的文件；确实必须改清单外文件时改动要极小，并在汇报里写明。
git add 你改的文件（不要提交那四个软链接）→ git commit（中文提交信息，末尾一行 Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>），不要 push。
最终回复（简体中文）：提交号；逐条“问题 → 根因 → 改法 → 修后截图路径”；没修的及原因；改动文件清单。
