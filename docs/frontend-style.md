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

浅色基础 `#EAF0F4`，内容面 `#FBFDFE`，主操作蓝 `#1663BF`；深色独立调整为
蓝墨/青灰步进。外层圆角 24px、内层 18px、输入 12px，按钮/分段控件偏胶囊。
背景是低对比静态青蓝环境光，不会动画漂移，也不是给正文加有色纹理。

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
  `turn-activity`；不要为了视觉统一改变事件或计时逻辑。
- 搜索仍然只有首页就地过滤与项目顶栏浮层两面。
- 手机侧栏还是抽屉；发送 / 排队 / 停止的位置、文件拖拽、图片缩放、编辑器的
  内部滚动、Office / HTML 的安全策略均不变。
- 手机抽屉的关闭是 React 状态控制的普通 `display:none`，不是只靠 Tailwind 的
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
