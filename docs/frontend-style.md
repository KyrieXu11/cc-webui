# 前端视觉：软卡片工作台

参考 `~/code/python/quant/design/soft-card-dashboard-kit/` 的 README、Tokens、Components
与 Snippet。移植的是设计语言，不是金融仪表盘的布局或图表。

## 统一入口

- `src/index.css`：Tailwind 语义令牌、明暗配色、字体、代码高亮变量。
- `src/soft-card.css`：面板、弹层、输入、按钮、分段控件以及工作台区域样式。
- `src/lib/soft-card-theme.test.ts`：两个主题的正文、控件和语法高亮对比度检查。

浅色底 `#EEF2F8`，白色面板，靛蓝 `#2B49CE`。外层圆角 18px、内层 12px、控件
9px。面板主要靠柔和阴影分隔；输入边界、表格行、文件树分区与键盘焦点仍可用线。
卡内分区用 `surface-2`，不要再叠阴影。品牌色用于主操作与选中提示，用户气泡用
`wash`，不再铺实心品牌色。助理回复和工具行不逐条卡片化。

消息区与输入区在**同一张对话面板**内，只有消息区滚动，输入区固定在面板底部。
输入框用 `surface-2` 区分，不再独立加浮起阴影；模型 / 模式 / effort 也留在这个
外层面板里。不要给整个面板加 `overflow:hidden`，否则向上展开的模型和斜杠菜单会
被裁掉；圆角裁切只由 `.conversation-messages` 承担。

左右导航面板都用 `surface`，不再给文件树单独铺 `surface-2`。会话行与文件树行
共用 `wash` 选中态、`raised` 悬停态；展开 / 收起按钮共用 `.panel-toggle`。不要
在右栏另外拼 `blue/10` 作为普通选中色。拖拽落点仍有单独的加强色和描边反馈。

**字体沿用原项目**：IBM Plex Sans（含原来的系统 / 中文回退）用于界面，IBM Plex
Mono 用于代码、路径和工具时间线；像素 Logo 保留 Press Start 2P。用户已明确偏好
原字体，不再随设计参考更换字体。深色是独立调过步进的同语言配色，不是浅色自动
反色。小字经常落在灰蓝底或
凹槽上，因此浅色 `subtle` 比参考的 ink-3 更深；不把有意义的元数据再降成半透明。

主色按钮文字用 `on-brand`，状态圆标的描边用 `on-status`，不能写死白色或深色。
Provider 标识使用 `provider-claude` / `provider-codex`；主题色变量不能再拼接十六进制
透明度后缀，透明色用 `color-mix()`。

## 不能改丢的交互

- 思考动词与 sparkle 动画、真实 reasoning / 工具 / 未知处理中三种状态继续沿用
  `turn-activity`；不要为了视觉统一改变事件或计时逻辑。
- 搜索仍然只有首页就地过滤与项目顶栏浮层两面。
- 手机侧栏还是抽屉；发送 / 排队 / 停止的位置、文件拖拽、图片缩放、编辑器的
  内部滚动、Office / HTML 的安全策略均不变。
- `data-railcol` 仍是 Splitter 的量尺。侧栏新增留白在该元素内部，计入测量宽度。
  对话卡右侧 12px 间隔由外层 Splitter 一并预留，不能把主面板挤到 400px 以下。
- 文件预览只改外层框架，不尝试给 Office、PDF 或用户 HTML 内部注入样式。

## 验证和上线

先跑 `npm run typecheck`、`npm test`，再检查桌面 / 390px 窄屏、深浅主题、菜单和
记忆弹窗、工具详情、文件面板与 CodeMirror。截图要等有限的入场 / 切换动画结束，
不要把主题过渡中途的颜色误认成最终配色。

生产直接托管仓库 `dist/`。**仅验证时**构建到隔离目录，例如
`npm run build -- --outDir /tmp/cc-webui-style-preview`，不要用默认 build 意外上线。
预览可只启动 Vite preview 并用浏览器 fixture 拦截 `/api/**`；不启动 agent 后端或
真实飞书 bot。
