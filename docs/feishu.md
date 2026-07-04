# 飞书机器人接入指南

cc-webui 通过 [LarkChannel SDK](https://github.com/larksuite/node-sdk) 把 Claude / Codex
agent 接到飞书 IM —— 在群里 / 私聊 @ 机器人就能跟对应 agent 对话，文字流式回复、
工具执行展示、文件 / 图片由 bot 直接发送。可以只启用 Claude bot，也可以再建一个
Codex bot；两个 bot 加到同一个飞书群时共享同一个 cc-webui group，@ 谁就只路由给谁。

## 它能做什么

- **群里 @ Claude/Codex bot / 私聊 bot** — 自动创建一个对应的 cc-webui group，绑定 chat_id → gid
- **流式 markdown 回复** — token 级打字机效果，含 thinking 占位、工具调用函数式行
- **工具权限审批卡** — Claude 调用 Bash / Edit 等危险工具时弹按钮，点允许 / 拒绝（Codex 走 Codex sandbox/approval 配置）
- **bot 主动发文件 / 图片 / @ 人或其他 bot** — 通过内置 `lark` MCP 工具，发送者是 bot 本身（无 OAuth）；Claude / Codex 均可用
- **引用图片 → agent 看图** — 用飞书的「回复」功能引用一张图，@ bot 时图片随 prompt 一起发给对应 agent
- **群里命令**:
  - `/cd <path>` 切目录（保留对话历史）
  - `/new` / `/new <path>` 重开会话
  - `/cwd` 看当前 cwd
  - `/model <opus|sonnet|haiku|codex|mini|完整ID>` 切当前 bot 对应 agent 的模型
  - `/effort <low|medium|high|xhigh|max>` 切 thinking effort
  - `/mode <default|auto|edits|yolo|dontAsk|plan>` 切权限模式
  - `/resume` / `/resume <id前缀>` 列 / 切会话
  - `/bind <gid>` 绑到 webui 已有的会话（高级）
  - `/unbind` / `/stop` / `/status` / `/help`

## 整体架构

```
飞书 IM
   │ ↑           ws over wss
   │ │
   ▼ │
[LarkChannel WS] ──┐
                   │  channel.on('message')   → handler.handleNormalizedMessage
                   │  channel.on('cardAction')→ card-action.handleCardAction
                   │  channel.send()          → bridge / lark-mcp
                   │  channel.updateCard()    → bridge.updatePermissionCard
                   ▼
        server/feishu/  (handler / bridge / cards / lark-mcp / ...)
                   │
                   ▼
        server/groups/orchestrator (startTurn / pipeline)
                   │
                   ▼
        Claude Agent SDK / Codex SDK
          - Claude: in-process MCP { bash, lark }
          - Codex: HTTP MCP /api/mcp/{bash,lark}
```

接收消息走 WebSocket（不需要公网入口），bot 发文件 / 图片走 `LarkChannel.send`，权限
卡和流式 markdown 都是 Card v1 with `update_multi:true`，由 `channel.updateCard()` 原地刷新。

---

## 接入步骤（约 15 分钟）

### 1. 在飞书开放平台创建应用

到 [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 创建企业自建应用：

- 命名建议：`cc-webui-claude`
- 如果要接 Codex bot，再按同样步骤建第二个应用，命名如 `cc-webui-codex`
- 添加应用能力 → 启用「机器人」

### 2. 申请权限

「权限管理」搜索并申请以下 scope（个人企业版自动通过，企业版需管理员审批）：

| Scope | 用途 |
|---|---|
| `im:message` | 接收 IM 消息（订阅 `im.message.receive_v1`） |
| `im:message:send_as_bot` | 以应用身份发消息、卡片、文件 |
| `cardkit:card:write` | 创建/更新流式 markdown 卡片和工具权限卡（`channel.stream` / `updateCard` 会用到） |
| `im:resource` | 下载用户引用的图片（让 Claude / Codex 看图） |
| `im:chat.members:read` 或 `im:chat:readonly` | 列群成员 open_id（`lark.list_chat_members` 用于 @ 人；飞书接口不会返回群内机器人） |
| `im:chat:readonly` | 查群名（`cli/feishu-bindings.mjs` 工具用） |

### 3. 配置事件订阅 + 卡片回调

**「事件与回调 → 事件配置」**：

- 订阅方式：**使用 长连接 接收事件**（推荐 — 无需公网入口）
- 已添加事件：搜索 `im.message.receive_v1`「接收消息」→ 添加

**「事件与回调 → 回调配置」**：

- 订阅方式：**使用 长连接 接收回调**
- 已订阅的回调：`卡片回传交互 card.action.trigger` — 通常自动加上，否则手动添加

> 「加密策略」tab 在 WebSocket 模式下**不需要**配置 Encrypt Key 和 Verify Token —
> 这两个是 HTTP webhook 模式才需要的。

### 4. 发布版本

「版本管理与发布」→ 创建版本 → 填版本号（随便如 `1.0.0`）→ 提交 → 等审核通过。

> ⚠️ **任何后台改动（加权限、加事件、改回调）都要重新发布版本**才会生效。

### 5. 本地配置 + 启动

复制 `.env.example` 为 `.env`。`.env.example` 里列了 `FEISHU_CLAUDE_*` 和可选的
`FEISHU_CODEX_*` 变量；**WS 模式每个 bot 只需要填 APP_ID + APP_SECRET**：

```bash
# 必填（WS 模式）
FEISHU_CLAUDE_APP_ID=cli_xxx
FEISHU_CLAUDE_APP_SECRET=xxx

# 可选：Codex bot（第二个飞书应用）
FEISHU_CODEX_APP_ID=cli_yyy
FEISHU_CODEX_APP_SECRET=yyy

# 下面两个是 webhook 模式才用，WS 模式留空即可（事件加密由 WS 协议层做了）
# FEISHU_CLAUDE_ENCRYPT_KEY=
# FEISHU_CLAUDE_VERIFY_TOKEN=
# FEISHU_CODEX_ENCRYPT_KEY=
# FEISHU_CODEX_VERIFY_TOKEN=
```

可选 env：

```bash
# 自动创建的会话默认 cwd（fallback 顺序：FEISHU_DEFAULT_CWD > CC_WEBUI_CWD > process.cwd()）
FEISHU_DEFAULT_CWD=/Users/yourname/code/myproj

# 权限卡片无响应时多久自动拒绝
CC_WEBUI_PERMISSION_TIMEOUT_MS=600000

# 可选：给人或外部 bot 配置 @ 别名（已加载的 Claude/Codex bot 会自动注册，无需手填）
FEISHU_MENTION_ALIASES='{"alice":{"open_id":"ou_xxx","name":"Alice","aliases":["pm"]}}'
```

启动 cc-webui server：

```bash
npm start
```

期望日志：

```
[feishu] loaded bots: claude, codex
[cc-webui] serving at http://127.0.0.1:8787
[feishu claude channel] connected (bot=claude-code-bot)
[feishu codex channel] connected (bot=codex-bot)
```

### 6. 把 bot 拉进群 / 开始私聊

群设置 → 群机器人 → 添加 → 搜应用名 → 添加。或者直接在飞书侧栏「+ 新会话」搜应用名开始私聊。

然后：

```
@cc-webui-claude 你好，列一下 cwd 下的文件
@cc-webui-codex 你好，检查一下当前项目
```

第一次发消息会自动创建一个 cc-webui group（cwd = `FEISHU_DEFAULT_CWD`），后续这个聊天里所有
@ 都路由到这个 group。Claude bot 和 Codex bot 在同一个飞书 chat 里会共用这条 binding。

---

## 工具权限审批卡

cc-webui group 默认 `mode = default`。Claude 调用任何危险工具（Bash / Edit / Write）都会
弹一张橙色卡：

```
🔒 工具权限请求
工具: Bash
```bash
cd /Users/xxx && ls -la
```
[✓ 允许] [🔁 本轮都允许] [✗ 拒绝]
```

点完按钮卡片立刻变绿 / 红，Claude 继续执行 / 拒绝。**10 分钟没人点会自动 deny**。
Codex bot 使用 Codex SDK 的 sandbox：默认是 `workspace-write + approvalPolicy=never`，
`/mode plan` 切只读，`/mode yolo` 切 `danger-full-access`。

切到无需审批的模式：

```
@bot /mode auto       # 模型分类器自动判断（推荐）
@bot /mode yolo       # 全部放行 (bypassPermissions)
```

---

## bot 发文件 / 图片 / 主动 @

Claude / Codex 都可以通过内置 `lark` MCP server 主动发文件、发图片、发文本并真正 @ 人或
机器人，发送者是 bot 本身：

```
@bot 把 /Users/xxx/report.pdf 发到群里
```

agent 会调用：

- `mcp__lark__send_file(file_path, chat_id?)`
- `mcp__lark__send_image(file_path, chat_id?)`
- `mcp__lark__list_chat_members(chat_id?, limit?)`：列当前群里人的 `open_id`（飞书接口不返回机器人）
- `mcp__lark__list_mention_targets()`：列已知 @ 别名；已加载的 `claude-bot` / `codex-bot` 会自动注册
- `mcp__lark__send_text(text, chat_id?, mention_open_ids?, mention_targets?)`

例子：Claude bot 规划完后主动把执行任务交给 Codex bot：

```json
{
  "text": "请按上面的计划打开 GUI 执行第 1-3 步，遇到权限弹窗先截图确认。",
  "mention_targets": ["codex-bot"]
}
```

如果要 @ 人，先 `list_chat_members` 拿到 `open_id`，然后：

```json
{
  "text": "这个 GUI 操作需要你确认一下。",
  "mention_open_ids": ["ou_xxx"]
}
```

`chat_id` 默认是当前对话的 chat_id，传别的 chat_id 可以让 bot 发到别的群（前提是 bot 在
那个群里）。文件大小上限 30MB。

自定义别名可以放进 `.env` 的 `FEISHU_MENTION_ALIASES`，格式是 JSON：

```json
{
  "alice": { "open_id": "ou_xxx", "name": "Alice", "aliases": ["pm"] },
  "ops-bot": "ou_yyy"
}
```

---

## 引用图片让 agent 看图

飞书手机端不能图文同发？没关系：

1. 先发一张图（不 @ bot）
2. 长按图片 → 回复 → 输入 `@cc-webui-claude 这是什么` 或 `@cc-webui-codex 这是什么` 发送

handler.ts 看到 `replyToMessageId` 存在时自动反查那条消息，从飞书消息资源 API 下载图，
连同你的文字一起塞给对应 agent（最多 4 张 / 单图 ≤ 5MB）。

支持引用 image / post（图文混合）/ text，文字会以 `> [引用]:` 前缀加到 prompt 里。

---

## 高级用法

### 把飞书群和 webui 网页共享会话

默认每个飞书 chat 自动建独立 group（独立 cwd / 历史）。想让飞书群 ↔ webui 共享：

1. 在 webui 网页建 group 拿到 `gid`（URL 里 `/groups/<uuid>` 的 uuid）
2. 飞书群里 `@bot /bind <gid>`
3. 现在飞书消息和 webui 网页的对话历史互通

### 给团队用多个 bot（多 tenant）

`server/feishu/config.ts` 当前固定两个 slot：`claude` / `codex`。想加"另一个 Claude bot"
（不同 App ID/Secret 但仍走 Claude agent），改 `BotKey` 类型为 string + 用 env 显式
指定 `agentId`。约 20 行改动，目前没需求所以未实现。

### 查看 binding

随时跑：

```bash
node cli/feishu-bindings.mjs
```

输出当前所有飞书 chat ↔ cc-webui gid 的映射，含群名 / cwd / 最近一条 user 消息片段，
方便认出"那个群对应哪个会话"。

### Webhook 模式（⚠️ 尚未实现）

> **现状**：webhook 模式当前**没有实现**。`server/feishu/config.ts` 里保留了
> `transportMode()` 以及 `encryptKey` / `verifyToken` 字段，但 `transportMode()`
> 没有任何调用方，`FEISHU_USE_WEBHOOK` 只在它内部被读到；`server/feishu/index.ts`
> 无条件为每个 bot 起 WebSocket 通道，唯一的 HTTP 路由 `/feishu/:bot/events`
> 固定返回 404。下面是**设计意图**，真要用需要先补实现（signature/verify-token
> 校验、事件解密、把 handler 挂到 HTTP 路由）。

将来如果不能用长连接（比如部署在某些受限环境），计划中的 HTTP webhook 接法是：

1. `.env` 加 `FEISHU_USE_WEBHOOK=1`
2. `.env` 加 `FEISHU_CLAUDE_ENCRYPT_KEY=...` + `FEISHU_CLAUDE_VERIFY_TOKEN=...`
3. 飞书后台「订阅方式」改成「将事件发送至开发者服务器」
4. 公网 URL 暴露 `https://<你的域名>/feishu/claude/events`
5. 网络层方案见 [`docs/superpowers/specs/`](./superpowers/) 或自己用 frp / cloudflared

---

## 已知限制

- 飞书 IM 客户端对 `update_multi:true` 卡片**可能有渲染缓存**，少数情况下点完允许卡片不立刻变色，关闭聊天再打开会刷新
- 流式 markdown 卡片的 token 节流默认 50ms / 8 字（`server/feishu/ws.ts` 里改），太密会触发飞书 patch 限速
- 一个 cc-webui server 进程可同时登录 `claude` / `codex` 两个 bot app；多 tenant / 更多 app slot 需要扩展配置或起多个 server
- 没做 sender 白名单 —— 群里任何人 @ bot 都能触发 turn（要严格控制谁能用，需在 handler 加 allowlist 检查）

---

## 调试日志

server log 关键标识：

| 模式 | 出现 | 含义 |
|---|---|---|
| `[feishu claude channel] connected` / `[feishu codex channel] connected` | 启动 | WS 握手成功 |
| `[feishu claude] inbound ...` / `[feishu codex] inbound ...` | 收消息 | 收到一条 IM 消息 |
| `[feishu bridge] send permission card id=...` | 调工具 | 发权限卡 |
| `[feishu bridge] permission card updated` | 用户点按钮后 | 卡片刷新成绿色/红色 |
| `[feishu claude cardAction] permission ... → allow by ...` | 用户点按钮 | 收到 cardAction 事件 |
| `[orch <gid>] step=N agent=claude/codex ok=true rawEvents=NN stepEvents=MM` | turn 跑完 | 一轮结束 |
| `[group <gid>] pipeline crash:` | turn 失败 | 完整 stack trace |

日志路径：取决于你怎么启动 server。`nohup npm start > /tmp/cc-webui-logs/server.log 2>&1 &` 是
开发时的常用方式。
