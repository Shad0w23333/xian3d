export const meta = {
  name: 'xian3d-audit-fix',
  description: '西安3D 全城找茬：多代理逐图挑错并定位模块 → 去重分诊 → 按模块在独立工作树修复',
  phases: [
    { title: 'Audit', detail: '每个代理审 5~6 张巡检截图，必要时补拍近景、用模块开关定位来源' },
    { title: 'Triage', detail: '去重、定级、按文件归属拆成互不冲突的修复任务' },
    { title: 'Fix', detail: '每个任务一个独立工作树，修复并截图验收后提交' },
  ],
}

const P = '/Users/xiaochoumao/Documents/github repo/xian3d'
const shots = args.shots
const smoke = args.smoke || '（无）'
const BASE = args.base

const ENV = `
工程：西安 3D 城市模型（Three.js r186 + Vite），主仓库 ${P}，当前基线提交 ${BASE}。先读 ${P}/HANDOFF.md 第 3 节（目录结构）与第 11~12 节（近况），了解每个模块负责什么。
截图工具（Mac 本机 Metal GPU，与用户所见一致）：
  node tools/shot.mjs --w 1280 --h 720 --wait 150 --frames 60 --shot "online=0&ll=lon,lat,离地高,目标lon,目标lat,目标离地高&time=15|shots/x.png"
  参数：view=1..0 / !1..!5 预设视角；time=小时；modules=a,b 只加载这些模块；skip=a,b 跳过这些模块（用来判断某个瑕疵来自哪个模块）；q=0..3 画质。一律加 online=0。
  模块 id：water landuse roads dossier citywall belltower pagoda datang qujiang heritage heritage26 mixc skyline huimin sunken airports streetscape buildings vegetation signage traffic amapinfo metro pedestrians。
  批量：node tools/tour.mjs --list <机位json> --out <目录> 一次加载连续拍（格式见 tools/tour_spots.json）。
截图用 Read 查看。本机同时有多个代理在跑浏览器，截图偶尔慢或整幅纯白（GPU 上下文丢失），重拍即可。
所有回复与输出一律简体中文。`

const ISSUES = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          shot: { type: 'string', description: '截图 id' },
          where: { type: 'string', description: '画面中的位置（如“左下角”“中央那栋高楼的底部”）与世界/经纬度位置（尽量给出）' },
          what: { type: 'string', description: '具体是什么错（越具体越好：物体、现象、和真实西安的差别）' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'P0=一眼可见的明显错误（悬空/穿模/埋地/黑块/闪烁/错位/巨大缺失/错误光团）；P1=明显不真实或比例错；P2=打磨' },
          category: { type: 'string', description: '悬空埋地|穿模重叠|Z冲突闪烁|错位|比例|缺失|材质贴图|光照阴影|夜景灯光|LOD跳变|地面影像|植被|交通人物|标注界面|性能|其他' },
          module: { type: 'string', description: '负责的模块 id（用 skip=/modules= 截图验证过的写“已验证”，否则写“推测”）' },
          evidence: { type: 'string', description: '你为确认/定位补拍的截图路径与结论' },
          fix_hint: { type: 'string', description: '修复建议（可选）' },
        },
        required: ['shot', 'where', 'what', 'severity', 'category', 'module'],
      },
    },
  },
  required: ['issues'],
}

const TASKS = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: '此任务独占可改的文件/目录（任务之间不得重叠）' },
          issues: { type: 'string', description: '本任务要修的问题清单（编号、严重度、现象、位置、截图、定位证据、修复建议），原文要详细到修复者不用回头看原截图也能复现' },
          verify: { type: 'string', description: '验收机位与通过标准' },
        },
        required: ['id', 'title', 'files', 'issues', 'verify'],
      },
    },
    dropped: { type: 'string', description: '判定为误报/不修/超出范围的问题及原因' },
  },
  required: ['tasks', 'dropped'],
}

const FIXSUM = {
  type: 'object',
  properties: {
    commit: { type: 'string' },
    fixed: { type: 'string', description: '逐条：问题 → 根因 → 改法 → 验收截图路径' },
    not_fixed: { type: 'string', description: '没修的及原因' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['commit', 'fixed', 'not_fixed', 'files'],
}

const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

phase('Audit')
const groups = chunk(shots, 6)
const audits = await parallel(groups.map((g, i) => () => agent(`${ENV}

你是挑剔的审查员（用户已经说了“还是很多错误、不满意”）。下面是全城巡检截图中的 ${g.length} 张（1280×720，白天 15:00 或夜景 20:48，online=0 本地离线高清卫星影像）。请逐张用 Read 仔细看，找出**所有**具体错误——不要客气、不要泛泛而谈、不要夸。重点关注：悬空/埋地的物体、建筑互相穿插或压在路上、Z 冲突闪烁的贴图、地标位置/朝向/比例错误、和真实西安明显不符的地方（你对西安的了解 + 可用 WebSearch 查证）、缺失的应有物体、奇怪的材质/颜色/贴图拉伸、阴影与灯光异常、夜景过曝/过暗、人眼高度下地面看起来像糊的卫星照片、植被/车辆/行人位置不合理、标注或界面问题。
每发现一个疑似问题，尽量补拍 1~2 张近景确认并用 skip=/modules= 判断来自哪个模块（每人补拍总数 ≤ 10 张，存到 shots/audit/g${i + 1}/）。截图里的日志字段若有报错也算问题。
截图清单（id / 文件 / 说明 / 机位 / 日志）：
${g.map((s) => `- ${s.id}｜${P}/${s.file}｜${s.note}｜${s.ll ? 'll=' + s.ll.join(',') : 'view=' + s.view}｜time=${s.time ?? '预设'}｜日志：${(s.logs || []).join(' ; ') || '无'}`).join('\n')}
只输出结构化问题清单（不修改任何代码）。`, { label: `审查${i + 1}`, phase: 'Audit', schema: ISSUES })))

const all = audits.filter(Boolean).flatMap((r) => r.issues || [])
log(`审查完成：共 ${all.length} 条问题（P0 ${all.filter((x) => x.severity === 'P0').length}，P1 ${all.filter((x) => x.severity === 'P1').length}）`)
if (!all.length) return { issues: [], tasks: [], fixes: [] }

phase('Triage')
const triage = await agent(`${ENV}

你是总负责人助理。下面是 ${groups.length} 个审查员对全城巡检截图挑出的 ${all.length} 条问题（JSON），以及交互冒烟测试的结果摘要。请：
1) 去重合并（同一根因的多条合成一条），剔除误报（必要时自己补拍验证，最多 8 张，存 shots/audit/triage/）；
2) 按“负责的文件”拆成 4~8 个**文件互不重叠**的修复任务（同一文件只能属于一个任务；核心文件 src/core/* 与 src/main.js 若需要改，集中到一个“核心”任务里）；每个任务内按 P0→P1→P2 排序，P2 只保留成本低的；
3) 每个任务写清：独占文件清单、问题清单（要详细到修复者不用回看原截图就能复现：位置坐标、机位参数、现象、定位证据）、验收机位与通过标准。
问题清单：
${JSON.stringify(all, null, 1)}
交互冒烟测试摘要：
${smoke}`, { label: '分诊', phase: 'Triage', schema: TASKS })

if (!triage || !triage.tasks || !triage.tasks.length) return { issues: all, triage, fixes: [] }
log(`分诊完成：${triage.tasks.length} 个修复任务`)

phase('Fix')
const fixes = await parallel(triage.tasks.map((t) => () => agent(`${ENV}

你在一个独立的 git 工作树里修复问题（工作目录就是工作树根，分支基于 ${BASE}）。准备工作（必须先做）：
  ln -s "${P}/node_modules" node_modules; ln -s "${P}/tiles" tiles; ln -s "${P}/data-src" data-src; ln -s "${P}/.venv-tools" .venv-tools
（这些目录不在 git 里；tiles 是本地离线高清影像包，没有它截图的地面会和用户看到的不一样。）
你的任务：「${t.title}」。你**只能修改**以下文件/目录（其他代理同时在改别的文件）：
${t.files.map((f) => '  - ' + f).join('\n')}
如果确实必须改清单外的文件，改动要极小，并在汇报里写明。
问题清单：
${t.issues}
验收：${t.verify}
要求：每个问题先复现（截图）、找根因、再修；修完用同一机位重拍对比（修前/修后截图存 shots/fix_${t.id}/），确认 moduleErrors 为空、无 pageerror、帧率不明显下降（可用 node tools/perf.mjs --views ... 对比）。修不了的写明原因。
最后 git add 你改的文件并提交（中文提交信息，末尾一行 Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>），不要 push，不要提交那四个软链接。`, { label: `修复:${t.title}`.slice(0, 40), phase: 'Fix', schema: FIXSUM, isolation: 'worktree' }).then((r) => ({ id: t.id, title: t.title, ...(r || {}) }))))

return { issues: all, triage, fixes }
