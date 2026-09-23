# AGENTS.md — cc-webui 开发者 / Agent 上手指南

> 这份文件写给**接手开发的人和 AI agent**。目标：快速看懂架构、跑起来、知道雷在哪。
> 面向用户的功能说明在 [`README.md`](./README.md)，飞书接入在 [`docs/feishu.md`](./docs/feishu.md)，
> 群聊的原始设计/计划在 [`docs/superpowers/`](./docs/superpowers/)（**注意已与实现有漂移，见文末**）。
>
> **要动 SDK / CLI 驱动这块，先读 [`docs/cli-migration.md`](./docs/cli-migration.md)**——那里有
> 「扔掉两个 SDK、自己驱动 CLI」的全部决策 + **已实测的事实**（CLI flag 全集、无文档的控制协议线格式、
> 模型别名解析结果、lvshu 参考实现索引）。别重跑那轮调研。
>
> **要动桌面客户端 / 远端工具执行这块，先读 [`docs/desktop-client.md`](./docs/desktop-client.md)**——
> 「runtime 留在服务端、工具执行下沉到家人 Windows 机器」的全部决策 + 被否掉的方案（连否决理由）
> + 实测事实（MCP 无 WS transport、skill 的可控粒度、Chrome PNA 拦 localhost）。**设计已定稿，未实施。**

## 这是什么

一个自托管的 **Code Agent 网页客户端**。后端（Hono + TypeScript）**自己驱动 `claude` / `codex`
两个 CLI 子进程**，把它们的事件流统一包成 SSE；前端（React 18 + Vite + Tailwind 4）用一个工作台在浏览器里
切 provider、恢复会话、看流式工具时间线。额外还有**多 agent 群聊**（Claude + Codex 流水线协作）
和**飞书机器人**接入（@ 机器人在群里触发 agent）。

- 单进程、单用户、无鉴权（见「安全边界」）。
- Node 20+；本机需装好并登录 `claude` CLI；用 Codex 时需要装好并登录 `codex` CLI。
  **两个 SDK 都已经不在 `package.json` 里了**（2026-09-17），跑的就是 PATH 上那两个 CLI
  ——`CC_WEBUI_CLAUDE_BIN` / `CC_WEBUI_CODEX_BIN` 可以钉死具体二进制。启动日志会打印
  两个 CLI 的版本，协议漂移时那是唯一的线索。

## 快速开始

```bash
npm install
npm run dev        # 开发：vite 前端 :8787（HMR）+ api :8788，vite 把 /api 代理到 8788
npm start          # 生产：vite build 后单端口 :8787 同时托管 dist/ 和 /api/*（NODE_ENV=production）
npm run typecheck  # tsc --noEmit（提交前必过）
npm test           # tsx --test "server/**/*.test.ts" "src/**/*.test.ts"（纯 assert 脚本，不是 describe/it）
```

- 端口：`PORT`（默认 8787）、`CC_WEBUI_HOST`（默认 `127.0.0.1`，放 LAN 用 `0.0.0.0`）。
- 完整环境变量表见 README。飞书凭据放 `.env`（已 gitignore；`.env.example` 是模板）。
- **注意**：一旦 `.env` 里填了真实飞书凭据，`npm start` / `npm run dev` 启动即会连上线上 bot。

## 架构总览

### 请求流（单聊 Claude 为例）

```
浏览器 Composer 提交
  └─ App.handleSend (src/App.tsx)
       └─ streamChat POST /api/chat (src/lib/api.ts)
            └─ chat.post("/chat") (server/chat.ts) → claudeExecutor.exec() [spawn claude CLI]
                 └─ CLI 的 stream-json 帧 buffer 到 per-turn in-flight entry，fan-out 给所有 SSE 订阅者
                      └─ 前端 applySDKMessage (src/lib/processor.ts) 把事件映射成 UI 状态
```

关键点：**turn 与 HTTP 连接解耦**。executor 在后端独立跑，边跑边把事件写进内存 buffer；
刷新/切 tab 后用 `GET /api/chat/attach` 重放 buffer 续流。停止是 `AbortSignal` → SIGTERM
（`applySDKMessage` 这个名字是 SDK 时代留下的，帧的形状没变，所以没改名）。

### 后端目录地图（`server/`）

| 路由挂载（`index.ts`） | 文件 | 职责 |
|---|---|---|
| `/api` | `chat.ts` | **单聊 Claude** 的 SSE turn（核心，~900 行）：query 调用、in-flight 注册表、session 迁移、attach、cancel |
| `/api/codex` | `codex-chat.ts` | 单聊 Codex 的 SSE turn |
| `/api/groups` | `groups.ts` + `groups/*` | **多 agent 群聊**（见下） |
| `/api/fs` | `fs.ts` | 文件浏览器（懒加载目录树） |
| `/api/sessions` | `sessions.ts` + `session-store.ts` | 历史会话列表 / 单会话消息（读 `~/.claude/projects/`） |
| `/api/memory` | `memory-routes.ts` | **项目记忆（只读）**：`~/.claude/projects/<slug>/memory/` 的 MEMORY.md 索引 + 每条正文。⚠️ 只有 GET，**不许加写方法**（用户明确要求只读，这是 CLI 自己的存储）；能看哪个项目 = 能不能打开那个项目（policy 查 query 的 cwd），不收调用方给的文件名。前端是左栏那颗书本按钮 → `MemoryDialog.tsx`，只在项目里出现 |
| `/api/upload` | `upload.ts` | 文件上传落盘 |
| `/api/permission` | `permission.ts` | 权限卡 resolve；`shared/permission-flow.ts` 是 scope-keyed allowance |
| `/api/meta` | `meta.ts` | 目录扫描（列 `$HOME` 候选项目） |
| `/api/bash/tasks` | `bash-tasks.ts` | 后台 bash 任务面板的 SSE |
| `/api/mcp` | `mcp-bash-route.ts` | **HTTP 版** bash + lark + schedule MCP（bearer-token 网关），Claude / Codex / 飞书都走它 |
| `/api/mcp/local/:server` | `mcp-local-route.ts` | **桌面客户端中继**：把 CLI 的 MCP 调用透传到家人机器上的 Electron 客户端（见下「5. 桌面客户端」） |
| `/api/client` | `client-routes.ts` | 桌面客户端安装包下载（**要鉴权**，不是公开面） |
| `/ws/device` | `devices/ws.ts` | 设备 WebSocket。⚠️ **不是 Hono 路由** —— 挂在 http.Server 的 upgrade 事件上，绕开 authMiddleware |
| `/api/files` | `files-routes.ts` + `session-files.ts` + `zip.ts` | **取件台**：列「本对话文件」、保存文本（乐观锁）、批量删除（真删+留痕）、下载（多选打 zip）、上传到会话 cwd、新建文件夹（`POST /mkdir`，**名字不合法就拒、重名回 409**——和上传的「消毒改名 + 加序号」刻意不同）、移动（`POST /move`）、重命名（`POST /rename`）。⚠️ 后两条都**两头各查一次白名单**（白名单是 glob，`x/*.md` 下把 a.md 改成 a.txt 就越界了），且**同名一律拒**——`fs.rename` 在 POSIX 上会静默覆盖 |
| `/api/office` | `office.ts` | ONLYOFFICE：下发签名 EditorConfig（浏览器）+ 容器侧取文件/保存回调（**票据鉴权，无 cookie**） |
| `/feishu` | `feishu/*` | 飞书机器人（见下） |

其它：`bash-mcp.ts`（bash 任务注册表 + `runBashTool`，被上面那条 HTTP 路由消费）、`schedule-mcp.ts`（wakeup/定时）、
`wakeup.ts`、`codex-mcp-config.ts` / `codex-mcp-context.ts`（Codex 的 MCP 装配与上下文）。

### 前端目录地图（`src/`）

- `App.tsx` — 中枢：路由/视图切换、发送、session 打开、attach、in-flight 轮询。
- `lib/` — `api.ts`（SSE 客户端）、`processor.ts`（**SDK 事件 → UI 状态映射**，很关键）、
  `settings.ts`（**model / mode / effort 选项与默认值**）、`groups.ts`、`sessions.ts`、`types.ts` 等。
- `components/` — 单聊 UI；`components/group/` — 群聊 UI（`GroupChatView` / `GroupComposer` /
  `GroupConfigDialog` / `AgentTunePopover` / `ParticipantsBar` / `GroupSidebar`）。
- **搜索只有两面，别加第三面**：`HeaderSearch.tsx` 是**项目内**顶栏那个下拉浮层
  （分组 项目/对话、↑↓ 选、Enter 开、Esc 关）；首页「最近项目」那一行是**就地过滤**
  （`HomeView` 里的 `SearchField`）—— 那一页本身就是结果列表，另开浮层去盖它没意义。
  两处共用 `Highlighted.tsx` 画命中段，共用 `sessions.ts` 的 `SEARCH_WINDOW`
  （**默认列表 60 条 ≠ 搜索范围**：搜索必须能翻到底，本机 786 个会话全拿是 ~677ms，
  实测数据记在那个常量的注释里；聚焦搜索框才拉，首屏不拉）。
- **文件树的拖拽**（`FileExplorer.tsx` + `lib/file-drag.ts`）：拖文件 → 文件夹＝移动，
  拖文件 → 对话框＝插入相对路径（Composer 的 drop 要先认我们的 MIME，再落到上传那条）。
  **「@ 插入」那颗按钮已经删掉**（每行一颗 + 多选里的「@ N」），拖拽就是同一件事；
  `insertFile` 只剩 Composer 的 drop 这一个调用方，别顺手把它也删了。
  ⚠️ 行内改名的时候 `draggable` 必须关掉：draggable 元素里的 input 选不了文字
  （按住拖选被解释成开始拖拽）。
  ⚠️ **dragover 阶段读不到 `dataTransfer` 的内容**（浏览器的 protected mode，只能读
  `types`），而「这儿能不能放」必须在 dragover 就答出来 —— 所以载荷另外记在模块级的
  `dragging` 里，`canDropInto` 读它。⚠️ 文件夹行的 `onDragOver` 里 `stopPropagation`
  和 `setRootOver(false)` **缺一不可**：只 stop 会让外层那个「放到根目录」的落点熄不掉
  （指针移进子元素不算 dragleave），两处一起亮。
- `UserBubble.tsx` — 非图片附件是以「附件：- 路径  (名字)」写进正文发给 agent 的（它要靠路径去读），
  气泡里由 `lib/attachments.ts` 认出那段、渲染成文件名卡片（悬停看路径）；服务端的标题兜底
  （`claude-sessions.ts` 的 `summarize`）用同一个函数剥掉它。⚠️ 改 Composer 那边的格式要三处一起改。
  另：这些附件存在系统临时目录，**macOS 的 dirhelper 会清掉 3 天前的**（用户知情，选了保持现状）。
- `ImageView.tsx` — 唯一的图片查看器（缩放/拖动/旋转/适应/原图），弹出式预览窗
  （`FilePreviewWindow`）和右侧栏（`files/DockFileView`）共用。
  **倍率只有一套刻度，且以「原图 100%」为基准**：`fitScale` 由 JS 量出来（不是交给
  CSS 的 `max-width:100%`），否则「适应」和 `scale(1.25)` 是两套刻度，点一下「＋」
  能跳 3.5 倍。另外两条也别退回去：滚轮必须挂**原生**监听（React 的 wheel 是被动的，
  `preventDefault` 不生效），原图尺寸不能只靠 `onLoad`（缓存命中时 `complete` 早就
  true，事件永远不来 ⇒ 适应倍率退化成 1）。PDF 不走它，直接 `<iframe>` 交给浏览器
  自带的 viewer（`lib/filepreview.ts` 的 `isPdfFile`；`/api/fs/raw` 必须回
  `application/pdf`，回 octet-stream 浏览器会当下载）。
- **html 预览**（`lib/filepreview.ts` 的 `isHtmlFile` / `renderedHtmlUrl` /
  `HTML_SANDBOX`）——和 `.md` 一样是「渲染 / 源码」两档（默认渲染），
  `DockFileView` 和 `FilePreviewWindow` 共用，渲染档是一个 `<iframe>`。
  ⚠️⚠️ **`allow-scripts` 和 `allow-same-origin` 绝不能同时出现在那个 sandbox 上**：
  两个一起给，页面里的脚本可以把父文档上这个 iframe 的 sandbox 属性抹掉再重载，
  自己把自己放出来 —— 而里面装的是 agent 写出来的文件，放出来就是本站的同源 XSS
  （读登录 cookie、以登录身份打所有 `/api/*`）。
  服务端那一半在 `fs.ts` 的 `/raw`：**只有 `?render=1` 才回 `text/html`**（缺省
  octet-stream），并且同时回 `Content-Security-Policy: sandbox …` —— 那个查询参数
  谁都能自己拼，没有这条 header 的话「在新标签页直接打开」就绕过了 iframe 上的沙箱。
  两处的档位字符串**必须一字不差**（浏览器取交集），`server/fs-raw-html.test.ts`
  钉死了这一条和「缺省不回 text/html」。
  已知限制：相对路径的资源（`<img src="./a.png">`）解析不出来，主场景是自包含单文件 html；
  **不要**为它另开一条按路径的静态路由，那会绕开 `/raw` 的目录白名单。
- `lib/stale-build.ts` — **生产是「构建即上线」**（服务直接托管仓库里的 `dist/`，
  不重启），所以一个开着不动的标签页随时比服务端旧一个版本，之后任何 `import()`
  （这里就是 CodeMirror 的语言包）都会拿到 404，报成「Failed to fetch dynamically
  imported module」。这不是缓存坏了，唯一的修法是 reload —— `watchForStaleBuild()`
  在 `main.tsx` 挂一次兜住全局，`TextEditor` 自己再 catch 一次。
  带 30s 冷却防转圈：刷完还是同样的错就说明不是陈旧构建，让它正常报出来。
- `Markdown.tsx` — 唯一的 markdown 渲染器（聊天正文 + .md 预览共用）。
  **GFM autolink 在中文里会吞掉整句**（中文没空格，`（www.x.cn）、后面一大段…` 全进
  href），修在 `lib/cjk-autolink.ts`：一个 remark 插件，在 **GFM 产出的 link 节点上**
  把越界的尾巴挪回正文。⚠️ 别退回"用正则改源文本"那种写法 —— 那等于自己重实现一遍
  GFM 的 URL 匹配规则，上一版就漏了裸 `www.` 这一种形式，用户报的例子完全没修到。
- `components/files/TextEditor.tsx` — CodeMirror 包装。语言在 `LANG` 那张表里
  （**加语言就加表，别堆 if**：上一版三个 if + `return null`，打开 .py 完全没高亮）。
  语法配色在 `files/highlight.ts`，颜色是 `var(--syn-*)` CSS 变量（index.css 里明暗
  两套），所以换主题即时生效；**必须显式加**，`basicSetup` 自带的是亮色配色，在本项目
  近黑底上读不出来。

## 三个子系统

### 1 & 2. 单聊 Claude / Codex
- **中途插话（`POST /api/chat/steer`）**：把一条消息塞进**正在跑的**那一轮，不等它结束。
  底下不是自造的插队机制——跑的就是 claude 命令行、**它自己带排队**，起进程时就带了
  `--input-format stream-json`（权限确认那一路早在用），往那根已经开着的 stdin 多写一行就行
  （句柄由 `ExecOptions.onSteer` 在 CLI 起来后交出、关管子时收回）。这条路和它的教训抄自
  律枢 `server/internal/service/steer.go`。⚠️ `clientTurnId` 是**乐观锁**（插进另一轮＝答非所问）；
  ⚠️ 三种「插不进去」合流成同一个 409 `steer_unavailable`，**日志里分开记**，且对用户
  **不许报成错**（那条留在排队里等下一轮）；⚠️ **Codex 没有这条路**（`codex exec` 的 stdin
  不是控制协议）。`server/executors/claude-steer.test.ts` 起一个假 CLI 钉住「那一行真的写进去了」
  和「结束时句柄被收回」——别删，现有 executor 测试全是纯函数，覆盖不到进程那一侧。
- Claude：`chat.ts` → `executors/claude-executor.ts`（spawn `claude -p --output-format stream-json`），
  用 **native session resume**（`--resume <id>`）续会话；`bash` MCP 替换被 `disallowedTools` 禁掉的
  内置 `Bash/BashOutput/KillBash`。它走 HTTP `/api/mcp`（回环一跳，注册表还是同一个进程里的同一批对象）。
- Codex：`codex-chat.ts` → `executors/codex-executor.ts`（spawn `codex exec --experimental-json`），
  同样走 **HTTP** `/api/mcp` 的 bash MCP（`mcp-bash-route.ts`）——MCP server 以 `-c mcp_servers.*`
  覆盖的形式进 argv，**bearer token 只走环境变量**（argv 是 `ps` 可见的）。
  ⚠️ Codex 只挂 `bash` 一条：**没有** Claude 那条 `schedule`（所以 Codex 单聊没有 wakeup），
  更没有桌面客户端的 `local-*`（决策 19）。
- 权限：`permissionMode: default` 时每个工具弹卡；`本次会话都允许` 缓存进 `permission-flow` 的
  allowance Set（scope = sessionId）；10 分钟无响应自动 deny。

### 3. 会话引擎：群聊 + 单 agent 会话（`server/groups/`）

> **⚠️ 先分清四个词**，它们指的是不同东西，混用会让人改错地方：
>
> | 词 | 指什么 | 代码 |
> |---|---|---|
> | **会话引擎** | 1..2 participant 的引擎（transcript.jsonl / orchestrator / input-builder） | `server/groups/*` |
> | **群聊** | 引擎上 **2 participant** 的会话——即"一个 turn 里多个 agent 接话" | `participants.length === 2` |
> | **单 agent 会话** | 同一个引擎上 **1 participant** 的会话（飞书 p2p 就是这个） | `participants.length === 1` |
> | **网页单聊** | 完全另一套代码：native session resume、无 transcript | `server/chat.ts` / `codex-chat.ts` |
>
> 另外为将来的 CLI 驱动工作预留区分：**runner**（`claude-runner.ts` / `codex-runner.ts`）指"跑 pipeline
> 里一步、吐 `ChatEvent`"；**executor** 留给"驱动一个 CLI 子进程"那层。一个 runner 内部**用**一个
> executor，两者不是同义词，别都叫 runner。

- **`CC_WEBUI_GROUPS_ENABLED` 开关**（`server/features.ts`，**默认关**）：管的是**群聊**这个能力，
  不是引擎。关闭时——`orchestrator.startTurn` 的收件人展开处经 `capToSoloWhenGroupsDisabled()` 截到
  1 个（**config 和 transcript 一行不改**，已有 2-agent 群照样能开、只是单 agent 答）、`/api/groups`
  不挂载（网页群聊是它唯一消费者，飞书走直接 import）、前端经 `/api/meta` 的 `features.groups` 让
  群聊入口**彻底不出现**。飞书和网页单聊完全不受影响。
  故意**不**在 `validateConfig` 层面禁 2 participant：那会让所有已存 2-agent 群 `readConfig` 直接抛，
  并搞挂绑到它们的飞书 chat。开关是"功能不可用"，不是"数据不兼容"。
  副作用（非安全控制）：关闭时 `groups.ts` 的 DELETE 路由不可达，那条 gid traversal 也就摸不到——
  但**打开就回来**，别把它当防护。
- **会话模型**：一个会话有 **1 或 2 个 agent**。2 个 = 群聊（Claude + Codex 协作）；1 个 = 单 agent
  会话（如飞书 p2p 私聊，只有一个 bot）。`gid` 是会话 id。（v1 上限 2 个。）
- 独立于网页单聊。canonical 真相是 `~/.cc-webui/groups/<gid>/transcript.jsonl`（append-only），
  格式与 agent 数无关。
- `store.ts` 读写 jsonl + `index.json`；`config.ts` 会话配置 + 校验（**1 或 2 个 participant**，id ∈
  {claude, codex} 且唯一；`defaultParticipant(id)` 造单个）；`lifecycle.ts` CRUD（`createGroup` 可传
  participants，pipeline 缺省按 participants 顺序推导）；`runtime.ts` in-flight 运行态 + per-agent
  native session id 持久化。
- `input-builder.ts`（纯函数，最关键）把 transcript 渲染成给某个 agent 的 prompt；跨 agent 发言以
  `[来自 X 的回复]` 前缀注入；**不重放工具历史**（只给结论文字）。**单 agent 会话没有 peer**，会
  跳过"多 agent 群聊"系统前言 + 跨注入框架（单聊不会被塞群聊人格）。
- `orchestrator.ts` 编排：`@claude`/`@codex` 单点，`@all` 按 `config.pipeline` 顺序跑；每 agent 单次
  SDK 调用。**session/thread 失效自愈**：resume 的 native session（Claude）/ thread（Codex）不存在时
  （"No conversation found" / "no rollout found"），清掉坏 id + 用全量历史起新会话重跑一次。
- `claude-runner.ts` / `codex-runner.ts` 输出直接是 `ChatEvent`（**和网页单聊同构**），orchestrator
  原样 fan-out 到 SSE。
- **飞书 p2p → 单 agent**：新 p2p 聊直接建 1-participant 会话；已有的 2-agent p2p 群在**下条消息惰性
  裁剪**成单 agent（`handler.normalizeSoloGroup`，护栏：被删 agent 若有历史则跳过，不孤立其回复）。
- ⚠️ **已偏离 spec**：现在用**隐藏 native session resume 做 prompt 缓存**（非 spec 的纯 single-shot
  全量重放）——`input-builder` 有 `buildResumeCatchup` 增量路径。改这块前先读代码，别信 spec。

### 4. 飞书机器人（`server/feishu/`，**仅 WS 模式**）
- `index.ts` 从 env 读 bot 凭据，每个 bot 起一个 `LarkChannel`（WebSocket 长连接）。
- `ws.ts` 连接；`handler.ts` 收事件 → 解析命令 / `startTurn` → **fire-and-forget** `bridgeTurn`
  流式回一张 markdown 卡片；`bridge.ts` 把 group SSE 事件桥成飞书卡片；`parse.ts` / `mentions.ts`
  解析 @；`quote.ts` 引用图片/消息缓存；`lark-mcp.ts` 提供 bot 身份主动发文件/图片/@人的 MCP 工具。
- 绑定：`@bot /bind <gid>` 把飞书 chat 关到某个 cc-webui group。

### 5. 桌面客户端 / 远端工具执行（`server/devices/` + `mcp-local-route.ts`）

> **设计与全部决策见 [`docs/desktop-client.md`](./docs/desktop-client.md)。服务端已实施，
> Electron 客户端未实施。** 那份文档末尾的「实施期的修正」一节优先于它自己的决策表。

让「你 Mac 上的 agent」多一只手，落在**家人的 Windows 机器**上。runtime 和凭据一步不动，
外移的只有**工具执行**。

```
claude CLI（你 Mac 上的子进程）
  --HTTP--> /api/mcp/local/:server   （bearer = per-turn token，和 bash MCP 同款）
              --WS--> /ws/device     （家人机器主动外连，NAT 穿透白送）
                        --stdio--> 家人机器上的本地 MCP server（playwright 等）
```

- `devices/protocol.ts` —— **两边共享的线协议**。改它就是改协议，必须 bump `PROTOCOL_VERSION`。
- `devices/registry.ts` —— 在线设备的**唯一真相**（纯内存）。刻意不 import `ws`、不 import `auth`，
  只认一个 `Transport` 接口，所以掉线/超时这两条最难测的路径不起真 socket 就能测。
- `devices/store.ts` —— 耐久事实（设备身份、上次出现、per-account 本地 MCP 配置）。
  **在线状态不落库**，理由和 `groups_index` 砍掉 `in_flight` 一样，`db.test.ts` 有断言钉死。
- `devices/ws.ts` —— upgrade 端点 + **手写的 cookie 鉴权**。
- `mcp-local-route.ts` —— **纯 JSON-RPC 透传**，不用 `McpServer`/SDK transport（中继没有自己的工具）。

**改这块前必须知道的四条：**

1. ⚠️⚠️ **决策 19（群聊/飞书不得用本地工具）是靠「只有 `chat.ts` 一处装配 `local-*`」实现的，
   不能靠检查 `ownerId`。** 飞书 turn 的 ownerId 会被 `auth/actor.ts` 解析成一个**真实存在的
   管理员账号 id**，而那个管理员很可能正好有在线设备。任何 ownerId 黑名单都会漏，
   后果是飞书群里任何人 @ 一下 bot 就能碰家人的电脑（飞书至今没有 sender 白名单）。
2. ⚠️ **`/ws/device` 完全绕开 Hono 和 `authMiddleware`**：不在 `app.routes` 里，
   `policy.ts` 管不到，`policy.test.ts` **看不见它**。这条通道上忘了验 cookie
   **不会有任何测试变红** —— 唯一的安全网是 `devices/ws.test.ts`，别删。
3. ⚠️ **设备 WS 绝不能挂在 `/api/mcp/` 下**：反代把那个前缀一律 404，放进去家人永远连不上，
   而现场只能看到一个 404。中继路由放在那儿则正好（前缀规则自动覆盖，nginx 一行不用改）。
4. ⚠️ **session cookie 是无状态 HMAC，没有服务端吊销**。握手时验过一次的 WS 会活过登出和改密码，
   所以 registry 每次心跳都跑一遍 `revalidate()`。当前实现只能抓到销号；抓登出还需要一张
   服务端 session 表或 token 版本号，**尚未做**。

## 关键约定 / 设计模式

- **Bash MCP 只剩 HTTP 一套**：`mcp-bash-route.ts`（bearer-token），Claude / Codex / 飞书都走它。
  `bash-mcp.ts` 现在只提供任务注册表和 `runBashTool`，不再自己起 MCP server——CLI 迁移前那套
  「进程内 vs HTTP 两套」的说法已经作废（旧文档里还能看到）。
- **MCP 的 per-turn token 带身份**：`McpSessionContext.ownerId` 是这个 turn 代表的账号。
  这三条路由**看不到登录 cookie**，是全仓唯一绕开 `authMiddleware` 的面，所以路径护栏要在
  `mcp-bash-route.ts` 里按 `ownerId` 再查一次；解析不出账号就拒。起 turn 的一侧负责填它
  （网页 = 登录用户；群聊/飞书 = `server/auth/actor.ts`）。
- **SSE 事件与 turn 解耦**：turn 在后端跑到完整才写 jsonl；刷新靠 attach 重放 buffer。
- **权限 allowance 是 scope-keyed 的**：单聊 scope=sessionId，群聊 scope=`gid:agentId`（见 `shared/permission-flow.ts`）。
- **归属有两级：owner 和 reader**（`server/auth/ownership.ts` 的 `AccessLevel`，决策 31-40 在
  [`docs/user-permissions.md`](./docs/user-permissions.md)）。owner 来自 `ownership` 表，
  reader = owner ∪ `shares` 表里被共享的人。
  ⚠️ **区分只落在 `policy.ts` 的 `OwnsSpec.access` 上，缺省是严格的 `"owner"`**——
  只有显式标了 `access: "reader"` 的路由才认共享（读消息、attach、cancel、续聊）；
  DELETE 和所有改配置的路由必须留在缺省级。**读得到 ≠ 删得掉**是这个功能唯一的不变量，
  `server/auth/sharing.test.ts` 走真实 `app.request()` 把它钉死了，别删。
  被共享者续聊是安全的，因为 turn 里每个权限判断都是按**调用者**重新推导的
  （cwd 白名单在中间件、权限卡取 `currentUser(c)`、bash 护栏读 MCP token 的 `ownerId`），
  跟会话归谁无关。
  **谁能发起共享 = 只有管理员**（决策 41）：`/api/sessions/:id/{shares,transfer}` 和
  `/api/auth/directory` 都是 `auth: "admin"`。**但它们仍然带着 `owns`** —— UUID 格式
  守卫长在 owns 里且刻意跑在管理员 bypass 之前，只写 `auth: "admin"` 会把它一起丢掉
  （决策 42）。谁能**被**共享则不看角色，所以 `visibilityFor` / `canAccessResource`
  里一行角色判断都没有。
- **测试是纯脚本风格**（top-level `await` + `node:assert`，不是 `describe/it`），但 `tsx --test` 能发现并跑。
  绝大多数在 `server/`；`src/` 下只跑**纯逻辑**（`processor.test.ts`），要 DOM / React 的别往这里塞。
  加测试就照 `server/groups/*.test.ts` 的样子写。
- **模型/权限/effort 选项集中在 `src/lib/settings.ts`**——新增模型只改这里。
  除了四个家族别名，还有三个**固定版本**（Opus 5 / Opus 4.8 / Sonnet 4.6，2026-09-23 加的：
  opus 那天变成 5.5，同档 effort 下想得更多）。⚠️ 固定版本是精确 slug，**迟早会下线报错**，
  加新的之前先真跑一轮（那段注释里有命令）；effort 规则按**家族**算（`claudeFamily`），
  所以固定版本不用改 `XHIGH_CLAUDE_MODELS`。
- **账号默认模型 / effort**（管理 → 用户；决策 45-47 在 [`docs/user-permissions.md`](./docs/user-permissions.md)）
  是**默认值不是限制**：服务端不拿它覆盖请求，只随 `/api/auth/me` 下发；浏览器按 `updatedAt`
  每一版只套用一次（`src/lib/user-defaults.ts`），之后用户自己改的会保留，直到管理员再保存。
  ⚠️ 别改成「每次加载都套用」——那等于把用户的选择锁死，而用户确认过要的是「她还能改」。
  校验用的是和输入框同一张表（`admin-routes.ts` 直接 import `src/lib/settings.ts`）。

## 数据与存储布局

> **规则**：**DB 存索引与关系，文件存内容与 append-only 真相。**

```
~/.claude/projects/<slug>/*.jsonl   # 原生 Claude 会话。Claude Code CLI 自己的存储，
                                    # 和你终端里的 claude 共用同一棵树，cc-webui 只读
~/.codex/sessions/                  # 同理，Codex 自己的
~/.cc-webui/
├── cc-webui.db                      # SQLite（server/db.ts）：
│                                    #   opened_projects  取代 recents.json
│                                    #   feishu_bindings  取代 feishu/bindings.json
│                                    #   groups_index     取代 groups/index.json
│                                    #   codex_sessions / codex_turns  取代 sessions.json
│                                    #   session_files    「本对话文件」registry（取件台）
│                                    #   file_deletions   删除留痕（**不是**通用审计日志）
│                                    #   ownership        一条资源恰好一个 owner
│                                    #   shares           owner 之外还能**读**到它的人
│                                    #   user_defaults    管理员给账号设的默认模型 / effort（默认值，不是限制）
├── *.json.migrated                  # 迁移前的原文件，保留备查（不再被读取）
├── workspaces/<username>/           # 用户工作区：建普通账号时发的一块空地。它既是
│                                    #   白名单里的一条「系统条目」，也是一个装项目的
│                                    #   容器（决策 21-30）。根可用 CC_WEBUI_WORKSPACES_DIR 覆盖
└── groups/<gid>/
    ├── config.json                  # 群配置
    ├── runtime.json                 # per-agent native session id
    └── transcript.jsonl             # canonical 群聊记录（append-only，**留在文件里**）
```

- **为什么上 SQLite**：每个 JSON 存储都是"整文件读-改-写"，两个写者并发就丢更新
  （旧 `upsertIndexRow` 是典型）。单用户时罕见，多用户后是常态。
- **为什么 transcript 不进 DB**：append-only jsonl 对它是真的合适（一事件一 append、
  不重写、写一半崩了也不烂），而且它是唯一的 canonical 真相，搬它风险最大收益最小。
- 只有 `server/db.ts` 碰 SQLite 驱动（现为内置 `node:sqlite`，实验性 API），
  换成 `better-sqlite3` 只改那一个文件。
- 路径覆盖：`CC_WEBUI_DB` / `CC_WEBUI_GROUPS_DIR` / `CC_WEBUI_SESSION_INDEX`
  （后者现在只用于一次性导入）/ `CC_WEBUI_CLAUDE_PROJECTS_DIR` / `CC_WEBUI_WORKSPACES_DIR`。
  **写测试时凡是碰索引的都要设 `CC_WEBUI_DB`**，凡是会 `createUser` 的都要设
  `CC_WEBUI_WORKSPACES_DIR` —— 否则会读写你的真实库、往你真实的 `~/.cc-webui` 里 mkdir。

## 已知问题 / 粗糙边缘（handoff 重点）

以下是审计确认的**当前状态**，按影响排序。位置仅供起点，改前请复核。

**单聊 Claude**
- **[已修] 默认模型不再是非法 id**。原来 `DEFAULT_SETTINGS.model="sonnet"` 而选项 id 是钉死的全名
  （`claude-sonnet-4-6` 等），`App.openSession` 匹配失败 → 静默 fallback 到列表第一个（fable-5）。
  现在选项本身就是**家族别名** `opus` / `fable` / `sonnet` / `haiku`（CLI 自己解析成当前版本，实测
  opus→opus-5、sonnet→sonnet-5；2026-09-23 复测 CLI 2.1.280：opus→opus-5-5、fable→fable-5-1），
  默认 `opus` 是合法 id，改写路径消失。钉版本正是这份列表落后一整代
  的原因，所以标签里也不再写版本号。详见 [`docs/cli-migration.md`](./docs/cli-migration.md)。
- **[已修] thinking 状态回来了（且时间线不再断线）**。Claude 5 家族的 thinking **是加密的**：
  `thinking_delta` 里 `thinking` 恒为空串，只带 `estimated_tokens`（实测 opus-5 的 2334 个 thinking
  block 全空，sonnet-4-6 则全有明文，分界线就是 5 系；线格式与统计见
  [`docs/cli-migration.md`](./docs/cli-migration.md) §4b）。旧 UI 只有 `ThinkingBlock` 一个入口，
  而它是**正文渲染器**（`if (!ev.text.trim()) return null`），转圈动画只是挂在正文上的表头——
  正文没了，状态也一起没了；而 `PendingHint` 的条件是「本 turn 还什么都没发生」，第一个工具调用
  一落地就永久关闭，于是 turn 中途的思考完全无反馈（实测一次 36.5s 空屏）。
  现在：`src/components/ThinkingRow.tsx` 用累加的 `estimated_tokens` 渲染
  `✻ Tinkering… (49s · ↓ 2.0k tokens · max effort)`，和终端 Claude Code 同构；历史回放取
  `usage.output_tokens_details.thinking_tokens`，刷新不丢。
  **顺带修掉断线**：空 thinking 事件以前被 push 成独立 block，把 `step-group` 切成两截（渲染出来
  是「一段空隙 + 两截断线」）。现在 `MessageList.rendersNothing()` 让渲染不出东西的事件根本不进
  blocks，空 thinking 则作为状态行留在时间线内部（`StepTimeline` 收 `rows: (step|thinking)[]`）。
  ⚠️ **新增只渲染型事件时记住这条**：任何可能渲染成 `null` 的事件都不能进 `blocks`，否则它会切断
  时间线的竖线。
- **[已修] `buildClaudeArgs` 的 positional prompt 会被变长 flag 吃掉**。`--allowedTools` /
  `--disallowedTools` 是 `<tools...>`（commander 变长），贪心吞掉后面所有 positional；prompt 原来
  push 在最后 → prompt 被解析成 deny 规则，CLI 报一句和真因无关的 `Input must be provided…`。
  没炸是因为两个调用方都传 `onPermissionAsk` → 走 stdin，那行是死代码。已把 prompt 移到变长 flag
  之前并加回归断言。**规则：变长 flag 之后只能追加 flag。** 详见 cli-migration.md「已知的坑」。
- **[已修·安全] `POST /api/chat` 现在校验 resume 的 sessionId 归属**。`body.sessionId` 直通 CLI 的
  `resume:`，而 `policy.ts` 上这条路由**只有 `paths` 没有 `owns`** —— 任何账号只要知道会话 id
  就能接着聊别人的会话，唯一的阻碍是路径白名单，而两个账号指向同一个目录时它天然对得上
  （管理员在某人工作区里开的会话正是这种情况）。现在是
  `owns: { key: "sessionId", optional: true, access: "reader" }`：新会话不受影响（optional），
  被共享者放行（reader），陌生人 404。
- **[已修] chat 的非 2xx 现在带上原因**：`api.ts` 原来一律抛 `HTTP 403`，而中间件回的
  `detail`（「这个目录不在你账号可以打开的范围内」）是唯一能解释发生了什么的那句话。
  共享会话让这条路径变得常见：会话读得好好的，一发消息就死。（attach 那一侧仍未修，见下条。）
- **[已修·串台] 切会话会把上一个会话的流灌进新会话**。`activeTurn` 是 localStorage 里
  **全局一条**（「这个浏览器最近起的那个 turn」，不是「当前会话的 turn」），而 attach、
  历史裁剪、提问气泡注入、cancel 四处都直接拿它用，只比 cwd —— 同一个项目下几个会话的
  cwd 全一样，等于没比。加上 `handleSend` 的 POST 流**无条件** `setAllEvents`，于是：
  在 A 发消息 → 切到 B → A 的事件流进 B 的列表；来回切几次，attach 每次重放整个
  buffer，就是用户看到的**又重复又错位**；B 的历史还会被 `beforeMs: A.startedAt` 截断；
  在 B 按停止会掐掉 A（服务端 cancel 优先按 clientTurnId 查）。
  现在：`turnForSession(turn, sessionId, cwd)` 是唯一入口（**必须比 id，cwd 挡不住**），
  `liveTurn` / `streamingHere` 从它派生；POST 流一旦发现用户切走就**永久交棒给 attach**
  （`handedOff`，不再写界面 —— 半路再抢回来会缺中间那一段，而 attach 重放整个 buffer）。
  服务端同样收紧：`pickInFlight()` 在 sessionId 与 clientTurnId **指向不同 turn 时当没找到**，
  `server/chat-inflight.test.ts` 钉死（老写法是 `a ?? b`，不一致时静默串台）。
- **[已修·重复] 打开一个正在跑的会话，正文会渲染两遍**。和上一条同一天报的，但**根因完全
  不同**（上一条是串台，这条是 id 撞不上）：CLI 把**一条 API 消息拆成一行一个 content
  block** 写进 jsonl（实测 2.1.267，thinking / text / tool_use 三行共用同一个 `message.id`，
  每行 `content` 长度都是 1），于是行内下标恒为 0；真实下标只在**行上**的 `apiBlockIndex`
  里，而 `claude-sessions.ts` 的投影把它丢了。历史事件因此拼成 `a-<mid>-0`，流式那一侧
  （`stream_event`）用的是 `event.index` ⇒ `a-<mid>-1` —— 两个事件、同一段话。
  平时看不见，因为 `applySDKMessage` 的 `assistant` 分支有个按正文前缀兜的模糊匹配；
  但 `content_block_start` 那条路**只认 id，认不出就直接 append**。触发条件很日常：
  **从侧栏打开一个正在跑的会话** —— `openSession` 先灌整段历史，紧接着 attach 把整条 turn
  的 buffer 又重放一遍。（刷新页面反而没事：那条路用 `beforeMs` 把本 turn 的历史截掉了。）
  现在 `api_block_index` 一路透传到 `sessionMessagesToEvents`，两边对齐，
  `src/lib/processor.test.ts` 钉死（"正文被渲染了 2 遍"）。
  ⚠️ **推论：thinking 永远是 block 0，所以它从来没暴露过这个 bug——正文几乎永远暴露。**
  加任何新的「历史 → 事件」映射时，id 必须用真实块下标，别用数组下标。
- **[已修] 思考状态行的「· max effort」是看的人自己的设置，不是这一轮的**。`MessageList` 原来收的是
  `settings.effort` —— 看别人正在跑的一轮时（管理员打开 rebecca 的会话），显示的是**管理员输入框里**
  的档位（用户 2026-09-23：「她是 xhigh，我显示 max」）。CLI 的 `system/init` 帧里有 model 没有
  effort，所以现在由 `chat.ts` 在每一轮 buffer 的**第一条**补一帧 `turn_meta { effort }`，POST 流和
  attach 重放都先拿到它，状态行只认它（App 的 `turnEffort`）。⚠️ `turn_meta` 在 `connectAttach` 的
  事件白名单里，别删；`server/chat-turn-meta.test.ts` 用假 CLI 钉住「第一帧、值来自请求」。
  同一天顺手修的：首页上文件面板关不掉（开关只在项目里有，面板却按 `dockOpen` 在哪都显示；
  现在 `open={inProject && dockOpen}`）。
- **[低] attach/重连路径吞掉真实错误**：`api.ts` 的 attach error 监听器丢弃 payload，前端只显示固定的
  「流式连接中断」。首屏和重连行为不一致。
- **[低] 打开任意非 in-flight 会话会闪一下 busy**：`App` 同步 `setAttachedStreaming(true)` 后服务端
  才回 `no-inflight`，Composer 短暂禁用。

**Codex（网页单聊 + 群聊共有）**
- **[已修] 模型列表整体过期，5 个里 4 个是死 id**。`gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` /
  `gpt-5.2` 全部实测返回 400 `The '<id>' model is not supported when using Codex with a ChatGPT
  account.`，能用的只剩 `gpt-5.5`。Claude 侧靠家族别名自动跟随，**Codex 没有别名、只认精确 slug**，
  所以这份表必然会再过期。现在列的是 `~/.codex/models_cache.json` 里 `visibility: "list"` 的四个
  （sol / terra / luna / 5.5），每个都真跑过一轮验证。四处注册表已对齐：`src/lib/settings.ts`、
  `groups/config.ts` 的 `defaultParticipant`、飞书 `MODEL_ALIASES`（`mini` 原来指向早就死掉的
  `gpt-5.1-codex-mini`）、`GroupConfigDialog` 兜底值。
  ⚠️ **改这份表必须按同样的方式验**：CLI 既不能枚举模型（`codex models` → "stdin is not a
  terminal"），也不在客户端校验 `--model`。运行时读那个 cache 是 cli-migration.md 决策 #9，仍未做
  （要一条服务端路由 + 回退，因为那个文件是服务端拉的缓存，坏过一次）。
- **[低] resume 一个已失效的 thread 会在侧栏留下一条幽灵会话**：`codex-chat.ts` 的
  `appendCodexTurn` 用请求里那个 threadId 落盘，而这条路径只产出一个 `{type:"error"}` 事件。
  迁 CLI 之前就是这样（SDK 那时也是抛错→同样落盘），不是回归。

**群聊**
- **[中] 首个 turn 用户消息被塞两遍**：`orchestrator` 先把 user entry append 进 transcript，再把同一段
  `currentText` 传给 `buildPrompt`，于是既出现在 `[群聊历史] USER:` 又出现在 `[当前用户消息]`。每个 agent
  的首次调用必现（后续走 resume-catchup 路径不受影响）。单测没抓到是因为它喂的 transcript 不含 currentText。
- **[中] `startTurn` 有 TOCTOU 竞态**：`activeGroupTurns.has(gid)` 检查和注册之间隔了个 `await readConfig`，
  两个并发 turn（网页 + 飞书，或两个 tab）可能都通过 → 同一 group 双开、`stopTurn` 只能停最后一个。
- **[已修] 改 participant 模型现在会清 resumed session**：换 model 后旧 native session/thread 是按旧
  model 录的，resume 它会 mis-route，Codex 还会把「recorded with model X but resuming with Y」当 `error`
  item 吐进聊天。语义已统一为**换 model → 起新会话**（mode/effort 不动 session）：`lifecycle.clearSessionsForModelChanges`
  在 web PATCH（`groups.ts`）和飞书 `/model`（`handler.ts`）两处调用，`GroupConfigDialog` 文案已对齐。
  历史上已错配的 thread（如 Jul 4 默认模型 `gpt-5.3-codex`→`gpt-5.5` 批量改 config 但没清 runtime.json
  的那批）：`server/codex-events.ts` 的 `isCodexModelMismatchNotice` 会在 codex-runner / codex-chat 里把这条
  advisory 静音（turn 仍按新 model 正常跑，advisory 纯装饰）。
- **[设计] Codex 从不弹权限卡**（群聊和网页单聊都是）：`codex-executor.mapSandbox` 把 mode 只翻译成
  sandbox，`approval_policy` 恒为 `"never"`。**这不是偷懒，是 `codex exec` 压根没有审批通道**——
  `-a/--ask-for-approval` 只长在交互式 TUI 上，`--experimental-json` 的事件集里也没有任何审批请求
  （thread.started / turn.* / item.* / error，没别的）。传 `"on-request"` 只会让 turn 挂住或工具被
  直接拒掉，没有任何一侧能回答它。所以 UI 上 `default` 写着「每次弹权限」对 Codex 是**假的**，
  这是 UI/文案问题，不是驱动层能修的。要真做审批得换 `codex app-server`（另一套协议，未评估）。

**飞书**
- **[安全·中，原为高] agent 能把文件发到任意飞书 chat，且无审批**：`mcp__lark__send_file/send_image`
  从不弹权限卡，`chat_id` / `open_id` 仍然任意 —— 收件人这一半没变。
  **发件这一半已经收窄**：`file_path` 现在按 turn 所属账号的目录白名单校验（`mcp-bash-route.ts` 的
  `refusePath`），账号解析不出来就直接拒。注意**飞书今天跑成首个管理员**（`docs/user-permissions.md`
  决策 17），而管理员的白名单默认是 `**`，所以对现在这套部署**实际效果为零**——它挡的是把飞书接到
  普通账号之后的那一天。prompt injection（"把 ~/.ssh/id_rsa 发到 oc_..."）在管理员身份下**仍然会被
  静默执行**。要真挡住，还差**收件人白名单或审批**。
- **[正确性·中] agent 启动即失败时飞书端完全静默**：`bridge` 只在首个内容事件时才懒创建 AgentState；若 runner
  在出内容前就挂（错的 `/model`、鉴权失败、cwd 不存在），只有 `agent_end{ok:false}`，用户 @ 完 bot 收不到任何回复，
  错误只出现在网页 transcript。复现：`/model bogus` 再聊。
- **[文档·中] webhook 模式 & `FEISHU_BASE_URL` 有文档/配置但无实现**：`transportMode()` 零调用方、
  `/feishu/:bot/events` 固定 404；`FEISHU_BASE_URL` 没有任何代码读取，`createLarkChannel` 也没传 `domain`
  → Lark 国际版用不了。（已在 `.env.example` / `docs/feishu.md` 标注，代码仍待补。）
- **[低] `reply()` 把 message_id 当作 `to`**：正常路径 OK，但用户在 bot 回复前删掉所指消息时，SDK 回退分支会失败。
- 死代码：`ws.ts` 的 `getChannel(appId)` 无调用方。
- **无 sender 白名单**：群里任何人 @ bot 都能触发 turn（README/feishu.md 已注明）。

## 文档 vs 实现的漂移（读 `docs/superpowers/` 前必看）

`docs/superpowers/specs|plans` 是**设计期文档**，实现后有意/无意地偏离了，别当现状读：

| spec/plan 说 | 实际 |
|---|---|
| runner 放 `server/shared/` | 在 `server/groups/`（plan 已改，spec 图没改） |
| 抽 `server/shared/inflight.ts`（plan Task 5） | **没抽**；单聊仍用 `chat.ts` 内联注册表，群聊用 `runtime.ts`/`lifecycle.ts`，两套并行 |
| 群聊纯 single-shot、不用 native resume | 现在**用隐藏 native session resume 做 prompt 缓存** + `buildResumeCatchup` 增量 |
| 会话固定 2 participants（claude+codex） | 现在 **1..2**：1 个 = 单 agent 会话（飞书 p2p 自动建/迁移），2 个 = 群聊 |
| `NewGroupDialog.tsx` | 实际是 `GroupConfigDialog.tsx`；另有 `AgentTunePopover` / `GroupSidebar` |
| runner 用独立 `RunnerEvent` 类型 | 收敛成直接吐 `ChatEvent`（`runner-types.ts`） |
| 飞书 webhook 模式「保留但可能落后」 | **未实现**（见上） |

## 安全边界（部署前必读）

- **已经不是「无鉴权」了**：登录 + 每用户目录白名单 + 声明式路由授权都在
  （`server/auth/`，设计与全部决策见 [`docs/user-permissions.md`](./docs/user-permissions.md)）。
  但白名单是**护栏不是隔离**——agent 有 shell，能读写服务进程那个 OS 用户能碰的一切。
  给谁开账号 = 把这台机器交给谁。
- 公开的路由只有：登录 / 登出 / `GET /api/auth/me` / **四条** `/api/mcp/*`（per-turn capability token，
  含桌面客户端中继 `/api/mcp/local/:server`）
  / 两条 `/api/office/{download,callback}`（签名票据）/ `/feishu/:bot/events`（固定 404）。
  **`/api/mcp/*` 拿到 token 就等于一个 shell**，它的合法调用方只有本机 CLI 子进程，
  反代上应当直接拒掉。
  两条 office 路由同理：调用方是本机的 DocumentServer 容器（走 `host.docker.internal`
  到回环，**不经 nginx**），凭证是查询串里的签名票据、回调再验一次请求体 JWT。
  **反代上应当和 `/api/mcp/*` 一样 404 掉。** 这张公开面清单被 `policy.test.ts` 钉住，
  加公开路由必须显式改那条断言。
  ⚠️ `/api/office/callback` **永远返回 HTTP 200 + `{"error":0}`**，哪怕票据无效——
  返回别的会让容器反复重试并最终扣留文件，用户的修改就悬空了（律枢在生产上付过这个学费）。
  别把它误读成「鉴权失效」。
- 飞书路径：无 sender 白名单（群里任何人 @ 一下就能触发，且**这个 turn 跑在管理员身份下**）
  + lark 发送工具无审批 + 收件人任意（见「已知问题·安全·中」）。接入真实群前先处理。
- 非图片上传落 `/tmp`，不在项目 cwd，Edit 改动不进仓库。

### 当前这台机器的对外部署（2026-08-23）

```
浏览器 → https://cc-webui.freeaitech.top:8443        (VPS nginx，SNI 复用 8443)
       → 127.0.0.1:10199                            (frps 的 tcp proxy "cc-webui")
       → frpc 隧道 → Mac 127.0.0.1:8789             (launchd com.xuqiang.cc-webui，生产)
```

- **生产在 8789，开发的 `npm run dev` 在 8787/8788，公网只指向 8789。**
  分端口不是洁癖：vite dev 会拒绝陌生 Host，而且带源码映射、HMR、`/@fs/` 任意读文件。
- 改完代码要 `npm run build` + `launchctl kickstart -k gui/501/com.xuqiang.cc-webui`——
  服务里**不**跑 build（KeepAlive 会让每次重启都重构一遍）。
- **生产实例现在读的是仓库里的 `.env`**（plist 的 `CC_WEBUI_DOTENV` 指过去），也就是说
  **它一起来，两个真实飞书 bot 就上线**。`~/.cc-webui/prod.env` 是那份**不含凭据**的备选，
  现在只剩注释——想让生产不带飞书，把 plist 指回它。
  ⚠️ 同一份飞书凭据只能被一个进程持有：本地再 `npm start` / `npm run dev` 时**必须**把
  `CC_WEBUI_DOTENV` 指到一个不含凭据的文件（如 `prod.env`），否则同一条飞书消息会被回两遍。
- nginx 侧三条不是可选项：`/api/mcp/*` 返回 404、`/api/auth/login` 限流、
  `client_max_body_size 64m`（nginx 默认 1m，而应用层有意不做上限）。
- 桌面客户端上线后还要第四条：`/ws/device` 的 location 必须带 `Upgrade` / `Connection "upgrade"`
  和一个够长的 `proxy_read_timeout`（默认 60s 会把长连接切掉）。**注意它和上面那条 404 规则冲突
  的风险**——`/ws/device` 不在 `/api/mcp/` 下正是为了避开它。
- ⚠️ **launchd + macOS TCC**：从 launchd 起的进程读 `~/Documents` / `~/Desktop` /
  `~/Downloads` 会**永久挂起**（没有前台可以弹授权框），挂住的 libuv 线程收不回来。
  `server/fs.ts` 的 `readdirOrGiveUp` 用 800ms 超时 + 进程级黑名单兜住了，
  `UV_THREADPOOL_SIZE=16` 留了余量。想让这些目录真能用：系统设置 → 隐私与安全性 →
  完全磁盘访问权限 → 加上 plist 里那个 node 可执行文件，然后重启服务。
- ⚠️ **frps 的 `proxyBindAddr = "0.0.0.0"`**：10199 / 10299 / 10399 在**主机层面**是敞开的。
  实测（绕开本机代理直连）这三个口加 7700 **全部超时**，而 10133（SSH 回连）和 8443 通
  ——腾讯云安全组按端口放行，公网目前进不来。**风险不在现在，在于它靠的是云控制台里的一条
  规则**：安全组一放宽、或者机器搬家，裸端口就回来了。要彻底断：改 `proxyBindAddr`（会一起
  干掉 10133）或在 VPS 上按端口加防火墙规则。
