# cc-webui

一个自托管的 Claude Code 网页客户端。把 `@anthropic-ai/claude-agent-sdk` 包成 SSE 流，配一个 React 前端，用浏览器跟 CC 对话。

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

## 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `PORT` | 服务端口 | `8787` |
| `CC_WEBUI_CWD` | claude 的工作目录 | `process.cwd()` |
| `NODE_ENV` | `production` 时启用静态托管 | 由 `npm start` 设置 |

## 目录

```
cc-webui/
├── server/
│   ├── index.ts        # Hono 入口：/api/* + 生产静态托管
│   └── chat.ts         # /api/chat SSE 路由，包装 SDK query()
├── src/
│   ├── App.tsx
│   ├── lib/
│   │   ├── api.ts        # 浏览器侧 SSE 解析器
│   │   ├── processor.ts  # SDK 消息 → 前端事件的状态机
│   │   └── types.ts
│   └── components/       # Header / Composer / MessageList / …
├── index.html
├── vite.config.ts
└── package.json
```

## 目前限制（MVP）

- `permissionMode` 固定为 `acceptEdits`，前端权限卡片已经有 UI 但后端没串起来（SSE 单向，做权限需要 bidirectional 通道）
- 只支持单会话；`sessionId` 保存在浏览器内存，刷新就丢。可以接 `resume` 参数恢复历史会话（SDK 已支持）
- 工作目录是服务启动时的目录，没有 UI 切换
