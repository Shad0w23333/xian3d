# 第三轮：全城网格修复（修复代理共读）

西安 3D 城市模型（Three.js r186 + Vite）。主仓库：/Users/xiaochoumao/Documents/github repo/xian3d（下称 MAIN）。
用户原话：“还是不完美，我要每一个角落都完美。”第二轮七路修复已合并（HANDOFF.md 第 15 节）。
这一轮的问题来自两处：
- 全城 444 格、960 张网格截图的找茬结果（截图 MAIN/shots/grid1/，审查说明 MAIN/docs/AUDIT3_GRID.md）；
- 第二轮没修完的条目（MAIN/shots/round3/backlog_fix2.json）。
总负责人已经把这些问题按模块分组、去重，归并成“问题单”，分块发给你。

## 工作树
每个模块组有一个固定的工作树：MAIN/.claude/worktrees/r3-<组名>，分支名也是 r3-<组名>。软链接 node_modules、tiles、data-src、.venv-tools 已建好。
同一组的问题单按块依次处理：你做完一块，下一块由下一位接着在同一个工作树里做。
**你可能是被中断的前任的接替者**：开工先看 git log --oneline main..HEAD 和 git diff。前任已经提交的条目不要重做；前任没提交的改动，核对后能用的就提交，不能用的撤掉。

## 独占文件
各组的独占文件清单沿用第二轮：MAIN/docs/fix2_tasks/<组名>.md 里的“独占文件”一段。只看这一段，那份文件里的 P0 清单是上一轮的，已经过时。
确实必须改清单外的文件时，改动要极小，并在汇报里写明。

## 每条问题的做法
1. 复现：用问题单里的截图 id，在 MAIN/tools/tour_grid.json、tour_spots.json、tour_fine.json 里查机位，或直接用 ll 参数拍。
   - 截图：node tools/shot.mjs --w 1280 --h 720 --wait 200 --frames 60 --shot "online=0&ll=lon,lat,离地高,目标lon,目标lat,目标离地高&time=15|shots/r3_<组名>/x.png"
   - 连拍：node tools/tour.mjs --list tools/tour_grid.json --out shots/r3_<组名>/before --only id1,id2
2. 查根因：拿不准是哪个模块画的，用 skip=模块 判断。不归本组的标 not_mine，写清楚归谁。
3. 修。同类问题要全城排查：问题单写的是几个格子，根因往往影响全城。
4. 同机位拍修后图（shots/r3_<组名>/after），用 Read 亲眼确认问题消失、没有引入新毛病。
5. 提交：每修好一条，或一组相关条目，就 git commit 一次。中文提交信息，末行写 Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>。不提交软链接和 shots/，不 push。

## 验证要求
- 每次拍图都要确认：moduleErrors 为空，没有 pageerror，没有 GL_INVALID 警告。
- 性能：改了几何数量或着色器的，跑 node tools/perf.mjs --views 2,4,7 与修前对比。预算：三角形 ≤ +10%，draw call ≤ +40，人眼高度机位帧率不能明显下降。
- 本机多路代理同时跑浏览器，加载要 1~3 分钟属正常；整幅纯白就重拍。

## 节省额度
额度紧张，会话随时可能中断：
- 提交要勤；
- 看图只看必要的：可以同时 Read 几张图，减少来回轮次；
- 不重复前任已经做过的排查。

## 汇报
按 schema 返回：
- 每条问题单的处理结果：fixed、partial、not_fixed、not_mine 或 disputed，附根因、改法、修后截图路径；
- 本组全部提交；
- 性能对比；
- 改了哪些清单外的文件。
所有文字用简体中文。
