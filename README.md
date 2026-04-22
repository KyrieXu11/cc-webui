# cc-webui (Web Code)

一个自托管的 Claude Code 网页客户端。把 `@anthropic-ai/claude-agent-sdk` 包成 SSE 流，配一个 React 前端，用浏览器跟 Claude Code 对话。

## 功能

- **项目管理** — 扫描 `$HOME` 列出所有候选目录，可搜索打开；最近项目按会话归类展示
- **会话恢复** — 直接打开 `~/.claude/projects/` 里已有的历史会话并继续聊
- **搜索** — Header 中央搜索框同时匹配 **最近项目路径** 和 **会话标题**（`summary / firstPrompt / customTitle`），↑↓ 键盘导航
- **流式渲染** — SDK 的 token 级 deltas、工具调用时间线、tool_result 结果
- **Extended thinking** — 模型的思考内容以折叠块形式穿插显示，橙色 sparkle 图标 + 动词轮播（`Pondering / Thundering / Brewing / …`），Ctrl+O 全局展开
- **Tool-call 展开** — 点每一步查看完整 input / output
  - **Edit / Write / NotebookEdit** 走专用 diff 视图：`Update /path (+24 -1)`，红底 `−` / 绿底 `+` 分行展示
  - 其他工具 fallback 到通用 JSON / 文本视图
- **权限确认** — `permissionMode: default` 时每次工具调用会弹琥珀色权限卡，Allow / Deny + 拒绝理由；10 分钟无响应自动视为 deny
- **文件浏览器** — 右侧栏显示 cwd 文件树，懒加载子目录，点文件以 `@relpath` 插入到 composer
- **文件上传** — composer 支持点击 / 拖拽 / 粘贴：
  - **图片** → base64 直接作为 image content block 发给模型，1 个回合看见（等价于终端粘贴）
  - **其他文件** → 落盘 `/tmp/cc-webui-uploads/`，路径以 `附件:` 形式带进 prompt，Claude 用 Read 访问
- **`@path` 原子删除** — composer 里 Backspace 到 `@path` 末尾时整段一次性删掉，不用逐字符退
- **模型 / 模式 / Effort** — 底栏直接选：
  - 模型：Opus 4.7 / Sonnet 4.6 / Haiku 4.5
  - 权限：Default / Accept Edits / Plan / Bypass
  - Effort：Low / Medium / High / xHigh / Max（`xHigh` 只在 Opus 下显示；切换到其他模型会自动降到 High）
- **Markdown 渲染** — `react-markdown + remark-gfm`，支持标题 / 列表 / 表格 / 代码块 / 链接；中英混排下中文标点紧邻 URL 时自动分隔，autolink 不再吞中文
- **日夜主题** — 左侧栏底部太阳/月亮按钮切换，配置保存在 localStorage
- **历史懒加载** — 首次打开一个会话只渲染最后 200 条消息，向上滚自动加更早

## 前置

- Node 20+
- 本机已安装并登录 `claude` CLI（`claude --version` 能通过）

## 安装

```bash
npm install
```

## 运行

```bash
# 一键起（生产模式，单端口 :8787）
npm start

# 开发模式（vite :5173 + api :8787，前端 HMR）
npm run dev
```

`npm start` 先 `vite build` 再用 Hono 同时托管 `dist/` 和 `/api/*`，浏览器打开 http://localhost:8787 就能用。

## AI Assistant 自动部署

> 这一节是写给 AI 助手（Claude Code / Codex / 其他 agent）的指令，不是给人读的。
> 用户让你部署这个项目时直接按下面的流程走。

### Step 1 — 先问用户，再动手

**不要凭猜测选路径。** 用 `AskUserQuestion` 或等价的交互工具先问清楚以下两点，
所有答案都得从用户那里拿到：

1. **项目目录在哪里？** 给用户三个候选：
   - `A. 已经 clone 到本地，路径是：___`（用户填绝对路径）
   - `B. 还没 clone，请帮我 clone 到：___`（用户填目标路径）
   - `C. 在当前 shell 的 `pwd` 下`
2. **发现端口 `8787` 被占用时怎么办？**
   - `A. 杀掉旧进程后启动`
   - `B. 改用另一个端口（用户填）`
   - `C. 不要启动，让我自己排查`

拿到答案后把项目路径存成 `$PROJECT_DIR`、端口存成 `$PORT`（默认 `8787`）。

### Step 2 — 幂等执行

```bash
PROJECT_DIR="${PROJECT_DIR:?ask user first}"
PORT="${PORT:-8787}"

# 1. 如果目录不存在且用户选了 clone，执行 clone；否则 cd 进去
if [ ! -d "$PROJECT_DIR/.git" ]; then
  git clone https://github.com/KyrieXu11/cc-webui.git "$PROJECT_DIR" \
    || { echo "clone failed; if SSH preferred try git@github.com:KyrieXu11/cc-webui.git"; exit 1; }
fi
cd "$PROJECT_DIR" || exit 1

# 2. 校验前置
node --version | grep -E "^v(2[0-9]|[3-9][0-9])\." >/dev/null \
  || { echo "need Node 20+ (got $(node --version))"; exit 1; }
claude --version >/dev/null 2>&1 \
  || { echo "claude CLI not installed or not logged in; run 'claude' interactively first"; exit 1; }

# 3. 依赖（只在缺 node_modules 时跑）
[ -d node_modules ] || npm ci

# 4. 处理端口占用（按用户 Step 1 的第二问来决定是否跑这一步）
lsof -ti :"$PORT" 2>/dev/null | xargs -r kill -9

# 5. 构建 + 后台启动
PORT="$PORT" nohup npm start >/tmp/cc-webui.log 2>&1 &

# 6. 等待就绪（最多 15 秒）
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null | grep -q 200 && break
  sleep 1
done

# 7. 验证
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:$PORT/"
```

### Step 3 — 向用户反馈

跑完后明确返回：

- **服务状态**：`http 200` = 正常；其他码或连不上 = 读 `/tmp/cc-webui.log` 最后 30 行给用户
- **访问 URL**：`http://localhost:$PORT`
- **远程访问提示**（如果检测到用户在 SSH 会话里）：
  - SSH 端口转发：`ssh -L $PORT:127.0.0.1:$PORT user@host`
  - 或建议 Tailscale 之类的 mesh VPN

### 停止服务

```bash
lsof -ti :"$PORT" | xargs -r kill -9
```

## 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `PORT` | 服务端口 | `8787` |
| `CC_WEBUI_CWD` | claude 的默认工作目录（UI 里也能切） | `process.cwd()` |
| `CC_WEBUI_UPLOAD_DIR` | 文件上传落盘目录 | `os.tmpdir()/cc-webui-uploads` |
| `CC_WEBUI_PERMISSION_TIMEOUT_MS` | 权限卡无响应时的超时（到时视为 deny） | `600000`（10 分钟） |
| `NODE_ENV` | `production` 时启用静态托管 | 由 `npm start` 设置 |

## 目录

```
cc-webui/
├── server/
│   ├── index.ts        # Hono 入口 + 生产静态托管
│   ├── chat.ts         # /api/chat SSE：包装 SDK query()，串 canUseTool；图片走 async iterable 分支
│   ├── fs.ts           # /api/fs/*：scan / tree / recents
│   ├── sessions.ts     # /api/sessions/*：list / messages / delete
│   ├── upload.ts       # /api/upload：multipart 落盘 + 回传 MIME
│   └── permission.ts   # /api/permission/:id：用 Map<id, Promise> 串权限回调，带超时
├── src/
│   ├── App.tsx
│   ├── lib/
│   │   ├── api.ts        # 浏览器侧 SSE 解析 + 图片附件打包
│   │   ├── processor.ts  # SDK 消息 → 前端 ChatEvent 状态机（流式 + 历史回放复用，含 thinking / tool_use / permission_request）
│   │   ├── sessions.ts
│   │   ├── settings.ts   # localStorage 持久化，含主题、effort 与模型联动
│   │   ├── upload.ts     # 客户端 FileReader 读 base64（仅图片）
│   │   ├── permission.ts
│   │   ├── fs.ts
│   │   └── types.ts
│   └── components/
│       ├── Header.tsx / HeaderSearch.tsx
│       ├── Sidebar.tsx / ProjectSidebar.tsx / EmptyProjectSidebar.tsx
│       ├── Composer.tsx
│       ├── MessageList.tsx
│       ├── UserBubble.tsx / AssistantText.tsx / SummaryCard.tsx
│       ├── StepTimeline.tsx / EditDiff.tsx
│       ├── ThinkingBlock.tsx
│       ├── PermissionCard.tsx
│       ├── FileExplorer.tsx
│       ├── OpenProjectDialog.tsx
│       ├── ModelSelector.tsx / ModeSelector.tsx / EffortSelector.tsx
│       └── HomeView.tsx / Popover.tsx
├── public/favicon.png
├── index.html
├── vite.config.ts
└── package.json
```

## 键盘快捷键

- `Ctrl+O` — 全局展开 / 收起所有 tool_call + thinking 详情
- `⌘↵ / Ctrl↵` — 在 composer 里发送消息
- `Backspace`（光标在 `@path` 末尾） — 整段删除该引用，附带一个相邻空格
- `↑ ↓ ↵` — 在项目选择对话框 / header 搜索里导航
- `Esc` — 关闭弹窗 / 搜索下拉

## 已知局限

- **单用户 / 无鉴权** — API 全部公开，适合本地或前置加一层鉴权（反代 + OAuth、Tailscale 之类）再用。裸暴露在公网会被利用上传 / 读写文件
- **非图片上传文件落在 `/tmp`** — 不在项目 cwd 里，Edit 修改不会进项目仓库。适合读、查、引用，不适合作为项目素材（图片走 inline 直接给模型，不受此限制）
- **Edit diff 不带真实行号 / 上下文** — 只显示 `old_string` → `new_string` 的纯变更行，没有读原文件去补上下文和真实行号
- **没有语法高亮** — 代码块和 diff 都是纯等宽黑字，暂未引入 shiki 等高亮库（bundle 体积考虑）
