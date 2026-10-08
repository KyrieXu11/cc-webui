# 前端视觉：液态玻璃工作台

参考 `~/code/python/quant/design/liquid-glass-kit/`，以及
[Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials)。
移植的是“控制层浮在内容之上”的设计语言，不是全站套背景图或全屏玻璃化。
此前 soft-card 的内容层和布局约束保留；`soft-*` 类名是兼容钩子，不代表还在加载两套皮肤。

## 统一入口

- `src/index.css`：Tailwind 语义令牌、明暗配色、字体、代码高亮变量。
- `src/liquid-glass.css`：玻璃导航/顶栏/弹层，以及稳定内容面板、控件、降级样式。
- `src/soft-card.css`：上一版参考，**不再由入口引入**；不能继续往这里加当前样式。
- `src/lib/soft-card-theme.test.ts`：保留历史文件名，检查正文、控件、原字体和语法配色。
- `src/lib/liquid-glass-theme.test.ts`：合成后的玻璃文字对比度、内容层与降级护栏。
- `scripts/verify-liquid-glass.mjs`：可选的 Playwright 浏览器回归，全部 API 用合成 fixture。

浅色底色按用户指定的 `~/code/python/quant/design/soft-card-dashboard-kit/src/Snippet.dc.html`：
基础 `#EEF2F8`、内容面纯白 `#FFFFFF`、内层 `#F7F9FC`、凹槽 `#E3E9F3`。
只换背景/表面，不换字体、品牌和交互。主操作蓝仍为 `#1663BF`；深色独立调整为
蓝墨/青灰步进。外层圆角 24px、内层 18px、输入 12px，按钮/分段控件偏胶囊。
浅色工作台使用平整 softcard 底色，不再叠青蓝环境光渐变；深色保留原来的静态环境光。

玻璃用在侧栏、顶栏、菜单和登录壳：4px Clear / 12px Regular 的背景模糊，低透明度
填充，上边迎光/下边回光，软投影表达空气间隙。全文、项目列表、代码、文件编辑器和
对话区仍用**不透明内容面**。卡内分区用 `surface-2`，不叠玻璃；用户气泡用 `wash`。
主色仍用于主操作和选中提示；助理回复与工具行不逐条卡片化。

**实现是 Liquid-inspired CSS 基础材质，不宣称真实背景折射。** 本项目的正文、编辑器、
PDF、Office 与任意 HTML 背景无法用 kit 的“静态图采样”安全地替代；没有复制 Canvas
去假扮实时 DOM 折射，也不依赖浏览器支持不一致的 SVG backdrop displacement。

⚠️ **backdrop-filter 只能放在装饰伪元素，不能放在 Header / 导航容器本身。** 它会
建立 fixed 后代的 containing block，把 Header 内的共享弹窗、侧栏内的弹窗锁到一小块
区域；“看起来像是 fixed”不代表实际还是窗口。根 `.app-workbench` 的 `isolation:isolate`
让负 z 装饰层位于根背景之上，宿主不加 transform/filter/contain，不改业务弹层坐标。
伪元素 pointer-events:none，不能盖住按钮或拖拽落点。

消息区与输入区在**同一张对话面板**内，只有消息区滚动，输入区固定在面板底部。
输入框用 `surface-2` 区分，不再独立加浮起阴影；模型 / 模式 / effort 也留在这个
外层面板里。不要给整个面板加 `overflow:hidden`，否则向上展开的模型和斜杠菜单会
被裁掉；圆角裁切只由 `.conversation-messages` 承担。

左栏用一个玻璃壳，内部 rail / 会话栏透明，不再叠两层玻璃；右侧文件与编辑器用稳定
`surface`，不再给文件树单独铺 `surface-2`。会话行与文件树行
共用 `wash` 选中态、`raised` 悬停态；展开 / 收起按钮共用 `.panel-toggle`。不要
在右栏另外拼 `blue/10` 作为普通选中色。拖拽落点仍有单独的加强色和描边反馈。
桌面右栏由 `dock-frame` 在 **`--dockw` 量尺内部**留出上/下/右 12px，`dock-surface`
用完整四角 `radius-card`、实底和同款阴影，并裁切树/编辑器的实底，避免子元素盖成直角。
圆角只裁切内容面，不包外侧 Splitter；不加 filter/transform/contain，文件删除确认仍铺满
窗口。手机文件抽屉、最大化和幻灯片放映不使用这套留白/圆角壳，仍占满屏幕；切档不卸载编辑器。
文件开关仍是窗口右上角唯一一颗同图标按钮，不随分隔条横移。桌面右内缩 24px，
top 始终 24px（32px 按钮中心 y=40），**开/关不能改变坐标**；主栏整个顶栏也留出 12px
上边距，与文件表头在同一水平轴，不再只有按钮浮到圆角边上。手机顶栏上边距为 0，
开关 top 6/right 12、44px 触摸面积。文档操作按钮同样居中；桌面最大化模式用表头内留白维持
同一轴，放映时表头仍完全隐藏，不减少幻灯片画布。
主栏/文件树/文档标签栏必须同步预留按钮空间，不能只改按钮坐标让它压住「新对话」或文件操作。
左右面板外侧使用 quiet Splitter：悬停也不画分隔线，9px 热区、调整光标、拖动与双击复位保留；
树/编辑器的内部分隔仍保留。左侧会话栏桌面默认 260px、最低 220px，`--sidebarw` 直接调宽并存
`ccwebui.sidebar_w`；左右面板互相测量并夹取，给对话留出下限。手机仍是 316px 抽屉（栏宽 260），
不继承保存的桌面宽度。记忆弹窗用独立 24px 毛玻璃装饰层与更透的填充，标题/索引显出材质，
正文继续实底；阴影遮罩不再先加一层 blur，不能把对话框自身 backdrop 再盖成近乎不透明。

图片浮窗（2026-10-08）使用独立 28px 毛玻璃 sheet、28px 圆角和宿主浮影，标题栏与
分组胶囊控件透明取底，不再两条硬直线工具栏。图片本身放在稳定的 `surface-2` 画布，
透明图仍有轻棋盘底；不模糊原图、不把滤镜放在窗口/图片宿主，不新增动效或依赖。
工具栏可换行，窄屏初始窗口和关闭按钮保持在视口内；缩放/指针锚点/拖动/旋转/适应/原图
继续共用 ImageView 原算法，PDF/HTML/Markdown 预览正文仍实底。高对比/低透明/不支持
backdrop-filter 都由现有渐进降级规则接住；小字使用足够对比度的 muted。

用户进一步明确「液态玻璃」必须有切换流动，不只是 blur。`LiquidSelection.tsx` 在记忆
导航和图片「适应 / 原图」上复用**同一块移动玻璃层**：按真实目标位置/尺寸移动，440ms
弹性拉伸/回弹与短促高光扫过。外层滚动与窗口缩放重新测量，不使用持续 RAF 或让每行
单独做动画；装饰层 pointer-events:none，不能挡按钮。减少动态效果时关闭弹性/滑动，
降低透明度/强制色仍有稳定选中态。筛选后无目标时隐藏，不能留下旧位置的玻璃层。
记忆外框/标题/搜索/导航同时采用浮影、光边和轻透填充，正文保持单独实底。
左侧项目对话列表随后复用同款流动层：按 provider + sessionId 定位，列表排序/删除/分页后
重测；新建对话无选中层，切项目/provider 重建装饰 rail，不从旧项目滑进新项目。
列表滚动容器和分页 sentinel 不变，玻璃不挡共享/删除按钮，分享弹窗仍按窗口定位。

左右展开按钮（2026-10-08）采用共享 `usePaneMotion`：桌面 280ms 宽度过渡与短促淡入淡出，
中栏随真实布局变化，按钮有轻微按压反馈。开场先建立收起布局；退场短暂保留内容，
但逻辑关闭立即设 inert、aria-hidden、pointer-events:none，普通 CSS 也禁止后代重新
命中。手机抽屉只做淡入淡出，结束后仍 display:none，不靠 offscreen translate 隐藏。
拖动调宽关闭过渡；右侧编辑器不卸载，最大化/放映不走缩栏动画；减少动态效果时静态。
不在包含 fixed 弹窗的宿主上加 transform/filter/contain。快速反向切换会取消旧帧/定时器。

记忆搜索位于弹窗内部：按名称、文件名、描述和正文做不区分大小写的字面匹配，多词
要求全部命中，可跨字段；正文命中给上下文摘要。输入查询后顺序补取全部剩余分页，
失败显示未完成/重试，不把首 100 条当完整范围。Enter 打开首条，Esc 先清空搜索再关闭。
这是记忆浏览的筛选，不是第三个项目/会话搜索面；不新增 API 或写入口。

旧记忆里 `**落实：**逐题` 等不满足 CommonMark 边界，会显示星号，并非 Markdown
渲染器没挂上。记忆浏览通过 `memoryCompat` 对解析后的普通文本节点做窄兼容；原文、
代码、链接和转义例子不改，也不把兼容行为扩到普通聊天。用真实选中记忆只读核对了
粗体渲染与文件哈希不变。相关测试为 `server/memory-markdown.test.ts`、
`server/image-preview-material.test.ts`、`server/memory-material.test.ts` 和 `src/lib/memory.test.ts`。

**字体沿用原项目**：IBM Plex Sans（含原来的系统 / 中文回退）用于界面，IBM Plex
Mono 用于代码、路径和工具时间线；像素 Logo 保留 Press Start 2P。用户已明确偏好
原字体，不再随设计参考更换字体。深色是独立调过步进的同语言配色，不是浅色自动
反色。小字检查包含灰蓝底、凹槽和环境光叠加后的玻璃面，不只比较“白底上的文字”。
不把有意义的元数据再降成半透明；主题改变后语法颜色仍即时更新。

主色按钮文字用 `on-brand`，状态圆标的描边用 `on-status`，不能写死白色或深色。
Provider 标识使用 `provider-claude` / `provider-codex`；主题色变量不能再拼接十六进制
透明度后缀，透明色用 `color-mix()`。

## 不能改丢的交互

- 思考动词与 sparkle 动画、真实 reasoning / 工具 / 未知处理中三种状态继续沿用
  `turn-activity`；不要为了视觉统一改变事件判定。2026-10-08 用户要求精简 Codex：
  **可见文案只保留动态词和省略号**（如 `Considering…`），不加「处理中 / 思考中」前缀。
  阶段语义保留在 aria-label 与悬停说明，只有显式 pending reasoning 才标思考。
  **本轮总耗时独立放在灰色
  `TurnStatus` 行**，同时可见「含工具与等待」；不用橙色思考行承载总计时。只认服务端
  startedAt，缺失就不显示计时，不能拿组件挂载时间冒充本轮起点；没有可靠的单轮
  reasoning 累计时长，不做「总耗时减工具耗时」的猜测。effort 显示成「推理档位」，不是实测指标。
- 搜索仍然只有首页就地过滤与项目顶栏浮层两面。
- 手机侧栏还是抽屉；发送 / 排队 / 停止的位置、文件拖拽、图片缩放、编辑器的
  内部滚动、Office / HTML 的安全策略均不变。
- 手机抽屉关闭立即停止命中/聚焦，短促退场后由 React 控制普通 `display:none`，不是只靠 Tailwind 的
  `translate` 把它移走。部分 Android/WebView 忽略位移时，后者会留在屏幕上挡住整个
  应用。关闭按钮至少 44×44px；侧栏与文件抽屉互斥，关闭后遮罩也必须消失。
- `data-railcol` 仍是 Splitter 的量尺。侧栏新增留白在该元素内部，计入测量宽度。
  对话卡右侧 12px 间隔由外层 Splitter 一并预留，不能把主面板挤到 400px 以下。
- 文件预览只改外层框架，不尝试给 Office、PDF 或用户 HTML 内部注入样式。
- 会话行是容器 + 同级的打开/共享/删除按钮，不能再把按钮嵌进按钮；键盘 focus 和
  触摸设备也要能看到操作。
- 首页默认列表与全量搜索的旧请求必须失效：切 provider 或离开首页以后不能覆盖新结果。
- attach 的服务端 error 帧保留 `message`；只有实际断线/坏帧才用泛化断线提示。

## 可访问性与性能

- 不支持 backdrop-filter 时用不透明内容面；降低透明度、提高对比度和强制色也会退回稳定面。
- 手机抽屉默认不透明，避免遮罩透过导航二次降低可读性。
- 减少动效时关闭皮肤过渡/入场动画/按压缩放；普通模式仍保留原 thinking / sparkle 动效。
- 环境光全是静态 CSS；没有 shader、DOM 捕获、持续 RAF 或给全部工具行加 blur。

## 验证和上线

2026-10-08 早先修复：类型检查、78 项脚本测试、隔离构建及发布后本机/公网静态资源一致性
核验通过；当时浏览器控制通道不可用，**没有把源码几何检查或用户反馈截图称作自动化实屏验收**。
后续图片材质/记忆搜索/旧粗体兼容增加回归后，80 项脚本测试与类型检查、隔离构建通过。
流动选中层另有 `src/lib/liquid-selection.test.ts`，覆盖滚动坐标、真实尺寸和减少动态效果。
最终前端发布：81 项脚本测试、类型检查、隔离构建通过；本机/公网 HTML、JS、CSS 与
已验证构建逐字节一致，不重启后端。独立 Vite 样例服务已停止。
随后按用户「先完成动效」收尾：左侧对话流动选中与两侧开合动画通过 82 项脚本测试、
类型检查和隔离构建；只发布动效，静态资源本机/公网一致，不重启后端。
本轮原生浏览器窗口通道报 `cgWindowNotFound`，没有完成新开合效果的实屏复验；
不要把上一轮记忆/图片样例的截图和用户确认挪作这轮侧栏开合的验收证据。
本机 Chrome 原生界面已用**独立合成 fixture**检查图片浮窗外观、缩放/旋转/适应/100%，
以及第101条正文搜索、Enter 打开和旧 CJK 粗体；没有操作真实记忆数据，用户也手动确认
切换效果。未宣称覆盖 Safari/iOS、全部窄屏或录制逐帧折射动画。
下面的 Playwright fixture 已同步早先回归条件，但没有执行其自动化截图回归。

随后「编辑工具 JSON / 首页慢」修复通过 **87 项**脚本测试、类型检查与隔离构建。
`ApplyPatchDiff` 是工具详情内的不透明逐文件代码面：双行号、红绿增删、头部统计、
可折叠文件和原始 JSON 诊断；不把工具本身/助理每条回复改成卡片，不读当前文件伪造旧 diff。
600 行初始上限避免大补丁直接挂满 DOM；缺差异/失败状态明确提示。
Chrome 窗口通道此次恢复，原生 UI 在合成 fixture 实屏检查差异视图，并确认首页首屏
用 compact=1、窗口外会话搜索仍走完整请求。没有将其称作真实账号/API 的端到端性能验收；
存储层 profile、schema 11 可重建索引与正式部署记录见 `docs/cli-migration.md`。

先跑 `npm run typecheck`、`npm test`，再检查桌面 / 390px 窄屏、深浅主题、菜单和
记忆弹窗、工具详情、文件面板与 CodeMirror。截图要等有限的入场 / 切换动画结束，
不要把主题过渡中途的颜色误认成最终配色。

生产直接托管仓库 `dist/`。**仅验证时**构建到隔离目录，例如
`npm run build -- --outDir /tmp/cc-webui-style-preview`，不要用默认 build 意外上线。
预览可只启动 Vite preview 并用浏览器 fixture 拦截 `/api/**`；不启动 agent 后端或
真实飞书 bot。

```bash
npm run build -- --outDir /tmp/cc-webui-liquid-glass-preview
npx vite preview --outDir /tmp/cc-webui-liquid-glass-preview --host 127.0.0.1 --port 8796
# 需环境中有 Playwright；无法按包名解析时设 PLAYWRIGHT_MODULE 为其 index.mjs。
PLAYWRIGHT_CHANNEL=chrome node scripts/verify-liquid-glass.mjs http://127.0.0.1:8796/
```

截图与报告进 `.playwright-mcp/`。验证范围包括 1440px / 390px、明暗、搜索请求竞态、
固定共享弹窗的窗口范围、记忆弹窗、向上模型菜单、文件栏/CodeMirror 与分隔条下限。
安卓触摸模拟另外检查深/浅主题的首页与项目页：重复点叉叉、重新打开、禁用 individual
translate 的兼容路径、点外部遮罩、文件抽屉切换，以及关闭后真实可操作的搜索/输入框。
不能用 `force:true` 的点击绕过 hit-testing，也不能把“点了关闭按钮”当作“已经关掉”。
Safari / Firefox / iOS 真机未验证；没有宣称复刻 Apple 原生材质或任意背景的 WCAG 保证。
