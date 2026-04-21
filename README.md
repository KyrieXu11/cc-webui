# cc-webui (Web Code)

一个自托管的 Claude Code 网页客户端。把 `@anthropic-ai/claude-agent-sdk` 包成 SSE 流，配一个 React 前端，用浏览器跟 Claude Code 对话。

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

## 功能

- **项目管理** — 扫描 `$HOME` 列出所有候选目录，可搜索打开；最近项目按会话归类展示
- **会话恢复** — 直接打开 `~/.claude/projects/` 里已有的历史会话并继续聊
- **流式渲染** — SDK 的 token 级 deltas、工具调用时间线、tool_result 结果
- **Tool-call 展开** — 点每一步或按 **Ctrl+O** 全局展开/收起，查看完整 input / output
- **权限确认** — `permissionMode: default` 时每次工具调用会弹琥珀色权限卡，Allow / Deny + 拒绝理由
- **文件浏览器** — 右侧栏显示 cwd 文件树，点文件以 `@relpath` 插入到 composer
- **文件上传** — composer 支持点击 / 拖拽 / 粘贴上传，落盘到 `/tmp/cc-webui-uploads/`，自动在 prompt 里带上路径
- **模型 / 模式 / Effort 切换** — 底栏直接选 Opus / Sonnet / Haiku、Default / Accept Edits / Plan / Bypass、Low / Medium / High / xHigh / Max
- **日夜主题** — 左侧栏底部太阳/月亮按钮切换，配置保存在 localStorage
- **历史懒加载** — 首次打开一个会话只渲染最后 200 条消息，向上滚自动加更早

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
│   ├── chat.ts         # /api/chat SSE：包装 SDK query()，串 canUseTool
│   ├── fs.ts           # /api/fs/*：scan / tree / recents
│   ├── sessions.ts     # /api/sessions/*：list / messages / delete
│   ├── upload.ts       # /api/upload：multipart 落盘
│   └── permission.ts   # /api/permission/:id：用 Map<id, Promise> 串权限回调
├── src/
│   ├── App.tsx
│   ├── lib/
│   │   ├── api.ts        # 浏览器侧 SSE 解析
│   │   ├── processor.ts  # SDK 消息 → 前端 ChatEvent 状态机（流式 + 历史回放复用）
│   │   ├── sessions.ts
│   │   ├── settings.ts   # localStorage 持久化
│   │   ├── upload.ts
│   │   ├── permission.ts
│   │   ├── fs.ts
│   │   └── types.ts
│   └── components/       # Header / Sidebar / Composer / MessageList / …
├── public/favicon.png
├── index.html
├── vite.config.ts
└── package.json
```

## 键盘快捷键

- `Ctrl+O` — 全局展开 / 收起所有 tool_call 详情
- `⌘↵ / Ctrl↵` — 在 composer 里发送消息
- `↑ ↓ ↵` — 在项目选择对话框 / header 搜索里导航
- `Esc` — 关闭弹窗 / 搜索下拉

## 已知局限

- **单用户 / 无鉴权** — API 全部公开，适合本地或用 Cloudflare Access 这类前置保护。裸暴露在公网会被利用上传 / 读写文件
- **上传文件落在 `/tmp`** — 不在项目 cwd 里，Edit 修改不会进项目仓库。适合读、查、引用，不适合作为项目素材
- **ProjectSidebar 的 `…` 菜单** — 占位按钮，目前点了没反应
- **搜索只搜项目路径** — 还不能按会话标题 / 内容搜
