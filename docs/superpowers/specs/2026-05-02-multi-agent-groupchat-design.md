# Multi-Agent Group Chat — Design Spec

**Date**: 2026-05-02
**Branch**: `feat/multi-agent-groupchat`
**Status**: Approved (pending implementation plan)

## Goal

让用户在 cc-webui 里以"群聊"形态同时跟 Claude 和 Codex 协作。一个群聊会话里可以：

- `@claude` / `@codex` 单点对话
- `@all` 触发流水线协作（默认 Claude → Codex，可配置顺序）
- 每个 agent 各自配置 model / mode / effort / system prompt / skills / MCP servers
- 群聊会话独立于单聊，不影响现有 Claude / Codex 单聊功能

## Decisions（brainstorm 阶段已锁定）

| 维度 | 选择 |
|---|---|
| 协作语义 | **B. Pipeline / 串联**（一人做完输入给下一人） |
| 角色配置 | **A + B + D**：每 agent system prompt + pipeline 顺序可配 + 各自模型 / effort / mode 独立 |
| 会话归属 | **A. 独立 session 类型**（侧栏新分组，单聊不动） |
| Skill / MCP 作用域 | **Y. agent 维度**（每 agent 各选） |
| 上下文管理 | **方案 4. cc-webui 自维护 canonical session**（不依赖 native Claude/Codex session resume，每次 SDK 调用都是 single-shot） |

## Non-Goals (v1)

- 同条消息同时给两个 agent 派不同子任务（`@claude do X, @codex do Y`）
- agent 间自由 turn-taking（一人喊完另一人接，循环到任一方说 done）
- agent 主动调度对方（MCP 协议层 cross-agent 工具调用）
- 把现有单聊"升级"成群聊（一次性 import）
- transcript 超长时的自动摘要折叠
- 群聊导出 markdown
- 多于 2 个 agent

以上全是已识别的合理扩展，但 v1 严格不做。

## Architecture Overview

```
┌──────────────── Browser (React) ────────────────┐
│  Sidebar: [Single chats] [Group chats]          │
│  GroupChatView                                  │
│   ├── ParticipantsBar (Claude / Codex 配置面板) │
│   ├── MessageList (按 agent 分色 + provider 标) │
│   └── Composer (@autocomplete: claude/codex/all)│
└──────────────── /api/groups/* (SSE) ────────────┘
                       │
┌──────────────── server/ ────────────────────────┐
│  groups/                                        │
│   ├── store.ts        canonical jsonl R/W       │
│   ├── config.ts       group config R/W          │
│   ├── orchestrator.ts dispatch + pipeline       │
│   ├── input-builder.ts canonical → SDK input    │
│   └── stream.ts       multiplexed SSE fanout    │
│  groups.ts            HTTP routes (Hono)        │
│                                                 │
│  shared/ (从 chat.ts/codex-chat.ts 抽出)        │
│   ├── claude-runner.ts  单 shot Claude 调用     │
│   ├── codex-runner.ts   单 shot Codex 调用      │
│   ├── permission-flow.ts (复用现成的)           │
│   └── inflight.ts       (复用现成的，键改 gid)  │
└─────────────────────────────────────────────────┘
```

### 抽取重构范围

把 `server/chat.ts` (910 行) 和 `server/codex-chat.ts` (503 行) 里**与 native session 无关**的部分抽到 `server/shared/`：

- SDK 事件 → `ChatEvent` 映射逻辑
- Permission flow（`permission.ts` 已独立，沿用）
- In-flight chat 注册表（键参数化，支持 sessionId 或 groupId）
- bash / schedule MCP 装配
- streamSSEUnbuffered 工具

抽取作为 v1 的 prereq commit，只移代码不改语义，确保单聊零回归。

## §1 数据模型

### 目录布局

```
~/.cc-webui/
├── sessions.json              # 现有单聊索引（不动）
└── groups/
    ├── index.json             # 群聊索引
    └── <group-id>/
        ├── config.json        # 群聊配置
        └── transcript.jsonl   # canonical conversation, append-only
```

### `config.json` schema

```ts
{
  id: string;                   // ULID
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  participants: Participant[];  // v1 长度固定为 2
  pipeline: AgentId[];          // @all 时执行顺序，长度 == participants.length
  mcpCatalog?: Record<string, McpServerConfig>;  // group 私有 MCP 定义
}

type AgentId = "claude" | "codex";

type Participant = {
  id: AgentId;                  // v1 限定 "claude" | "codex"，二者各出现恰好一次
  model: string;
  mode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  systemPrompt?: string;        // 自定义 role；空 = SDK 默认
  skills: string[];
  mcpServers: string[];         // 引用 mcpCatalog key；未命中时回退查内置 (`bash`, `schedule`)；都没命中则配置校验失败
};
```

**校验规则**：`config.participants.length === 2`，`participants[].id` 集合必须等于 `{"claude", "codex"}`，否则配置加载阶段抛错（v1 不支持单 agent / 三 agent 群聊）。`config.pipeline` 必须是 `participants` 的一个排列。
```

### `transcript.jsonl` schema

每行一个 turn entry，append-only：

```ts
type TurnEntry = {
  id: string;                   // entry id (ULID)
  ts: number;
  type: "user" | "assistant" | "thinking" | "tool_call" | "tool_result"
      | "permission" | "summary" | "error";
  agent: "user" | AgentId;
  recipients?: AgentId[];       // 仅 user 消息
  text?: string;
  tool?: { name: string; input?: any; output?: string; status: "ok"|"pending"|"error" };
  images?: ImageAttachment[];
  meta?: {
    turnId: string;             // 同一用户 @all 触发的多 agent 输出共享 turnId
    pipelineStep?: number;
    error?: string;
  };
};
```

### `index.json`

```ts
{
  groups: Array<{
    id: string;
    title: string;
    cwd: string;
    lastTs: number;
    participantSummary: string;  // e.g. "Claude · Codex"
    lastSnippet: string;
    inFlight: boolean;
  }>;
}
```

## §2 Turn 生命周期

### HTTP 入口

| Method & Path | 用途 | Body / Response |
|---|---|---|
| `POST /api/groups` | 创建群聊（NewGroupDialog 提交） | Body: 全量 config（无 id / ts）；Response: `{ id }` |
| `GET /api/groups` | 列群聊（侧栏 / HomeView） | Response: `index.json` |
| `GET /api/groups/:gid` | 读单个群聊（config + 完整 transcript，懒加载分页同单聊） | Response: `{ config, messages, hasMore }` |
| `PATCH /api/groups/:gid/config` | 改群聊配置（ParticipantsBar 编辑） | Body: partial config |
| `DELETE /api/groups/:gid` | 删群聊（删目录 + 摘 index） | — |
| `POST /api/groups/:gid/turn` | 启动一个 turn，返回 SSE（边写边出） | Body: `{ text, images?, recipients }`；Response: SSE 流（§4） |
| `GET /api/groups/:gid/stream` | attach 已 in-flight 的 turn（刷新恢复用） | Response: 同上 SSE 流，从当前 cursor 续 |
| `POST /api/groups/:gid/permission/:pid` | 解析权限卡（同单聊） | Body: `{ decision, reason? }` |
| `POST /api/groups/:gid/stop` | 停止当前 in-flight turn | — |

`recipients == ["all"]` 等价于 `config.pipeline`。

### Composer @ 解析（前端）

用户键入 `@` 弹下拉（claude / codex / all）。选中后插入 `<mention agent="claude">@claude</mention>` 富文本节点（不可分割删除，Backspace 整段删）。提交时：

- 把 mentions 提取成 `recipients[]`
- 文本去掉 `@xxx ` 前缀剩纯 prompt
- 无 mention 时默认 `recipients = ["all"]`

v1 一条消息只能 mention 一个目标（claude / codex / all 三选一），不支持 `@claude do X @codex do Y`。

### Orchestrator 流程

```
1. 读 config + transcript
2. append user turn 到 transcript（含 recipients 字段）
3. 注册 in-flight (key: gid)，开 SSE channel
4. 展开 recipients：单 agent → [agent]，all → config.pipeline
5. for each agent in expanded sequence:
     a. inputBuilder.build(transcript_now, agent, config) → SDK input messages
     b. runner.run(provider, input, agentConfig) → async iterator of events
     c. 每个 event：
        - fan-out 到 SSE（带 agent 字段）
        - 终态事件（assistant 完成 / thinking 完成 / tool_result / permission resolved）同步 append 到 transcript
     d. agent 跑完 → 进下一个（input 重新 build 时已包含上一个 agent 的输出）
6. pipeline 全完 → 关 SSE / 清 in-flight / 更新 index.json
```

### `input-builder.ts` 映射规则

输入 canonical transcript + 目标 agent，输出 SDK input messages 数组。以"现在跑 Claude"为例：

| canonical entry | 给 Claude SDK 的 input |
|---|---|
| user (任意 recipients) | `{role: "user", content: text + images}` |
| assistant from claude | `{role: "assistant", content: text}` |
| thinking from claude | 跳过 |
| tool_call/result from claude | 跳过 |
| assistant from codex | `{role: "user", content: "[来自 Codex 的回复]\n\n" + text}` |
| thinking from codex | 跳过 |
| tool_call/result from codex | 跳过 |
| error / summary | 跳过 |

**关键决策：不重放工具历史**。Claude SDK 严格校验 `tool_use_id` 配对，重放老 turn 的工具 use/result 会因为新 SDK call 没在内部记录 id 而失败。把每个 agent 的工具调用视为它**那个 turn 内的私事**，对后续 turn 不可见——他们只能看到 assistant 的最终文字结论。这与"和真人协作"的语义贴合：你不会把 IDE 操作录像扔给同事看，你把结论给他。

跨注入前缀：`[来自 Codex 的回复]` / `[来自 Claude 的回复]`（与项目语调一致）。

### System prompt 组装

```
{participant.systemPrompt || ""}

---
你正在参与一个多 agent 群聊。其他参与者：{peer_descriptions}。
对方的发言会以"[来自 X 的回复]"前缀的 user message 形式出现在历史里——那不是用户说的，是另一个 agent 说的，你可以认同 / 反驳 / 补充。
本次群聊的实际用户（人）只通过不带前缀的 user message 出现。
```

`peer_descriptions` 从 config 算出来，例如 `"Codex (gpt-5.3-codex), 角色: 你是 reviewer，专注挑刺"`。

## §3 UI 表面

### 侧栏

`ProjectSidebar` 已按 provider 分组；新增第三组 **"群聊"**，列出 `index.json` 里所有 group。

### 新建群聊

HomeView 加 `新建群聊` 按钮，弹 `NewGroupDialog`：

- title 输入
- cwd 输入（默认当前 cwd）
- 两个 `ParticipantConfigCard`（Claude / Codex），每张含 model 选 / mode 选 / effort 选 / systemPrompt textarea / skills 复选 / mcp 复选
- pipeline 顺序可拖拽（默认 claude → codex）

### `GroupChatView` 布局

```
┌────────────────────────────────────┐
│ Header: <群聊标题> [⚙ 配置]         │
├────────────────────────────────────┤
│ ParticipantsBar (折叠条):           │
│  [🟣 Claude · Opus] [🟢 Codex · 5.3]│
│  pipeline: claude → codex          │
├────────────────────────────────────┤
│ MessageList (按 agent 分色 bubble): │
│  user bubble (右)                  │
│  └─ recipients: @all               │
│  claude bubble (左, 紫边)          │
│  └─ pipeline-step 1/2 indicator    │
│  codex bubble (左, 绿边)           │
│  └─ pipeline-step 2/2 indicator    │
├────────────────────────────────────┤
│ Composer:                          │
│  默认 placeholder "@all (pipeline)"│
│  [+] [↑ / ■]                       │
│  (model menu 隐藏 — 用群聊配置)    │
└────────────────────────────────────┘
```

复用现有组件：`MessageList` / `AssistantText` / `ThinkingBlock` / `StepTimeline` / `EditDiff` / `PermissionCard` / `UserBubble` / `Composer` 等。每个渲染组件加可选 `agentBadge?: "claude"|"codex"` prop，左 bubble 多一条颜色边 + provider tag。

### Composer @ 自动补全

键入 `@` 弹小菜单（claude / codex / all），↑↓ 选中、↵ 或 Tab 确认插入 mention 节点；Backspace 整个 mention 一次删（沿用现有 `@path` 原子删除模式）。

### Stop 按钮语义

- 默认：停止当前 agent step + pipeline 后续 step 不跑（一停全停）
- Shift+Stop 仅停当前 step、跳到下一 step → v2，不做

## §4 SSE 协议

`/api/groups/:gid/stream` 每 turn 一个 turnId 串起来：

```
event: turn_begin
data: {"turnId":"...", "userText":"...", "recipients":["claude","codex"]}

event: agent_begin
data: {"turnId":"...", "agent":"claude", "step":0, "totalSteps":2}

event: assistant_delta
data: {"turnId":"...", "agent":"claude", "text":"..."}

event: thinking_delta
data: {"turnId":"...", "agent":"claude", "text":"..."}

event: step
data: {"turnId":"...", "agent":"claude", "tool":"Read", ...}

event: permission
data: {"turnId":"...", "agent":"claude", "permissionId":"...", ...}

event: agent_end
data: {"turnId":"...", "agent":"claude", "ok":true}

event: agent_begin
data: {"turnId":"...", "agent":"codex", "step":1, "totalSteps":2}
... (重复)

event: turn_end
data: {"turnId":"...", "ok":true}
```

每个 agent 内部事件**与现有单聊 ChatEvent 类型完全一致**，外层包 `agent` 字段。前端 `MessageList` 按 agent 字段路由到对应 bubble。

### Permission 卡片

和单聊一致，卡片头加 `[Claude]` / `[Codex]` 来源标。`allow_session` 只对该 agent 在该 group 生效。

`server/shared/permission-flow.ts` 抽取时把 allowance Set 的 key 参数化成 `scope: string`：
- 单聊调用方传 `scope = sessionId`（保持现有行为）
- 群聊调用方传 `scope = ${gid}:${agentId}`

这样同一个 module 同时服务两种调用语境，不需要 fork 两份。

## §5 错误处理 / 恢复 / 测试

### Recovery（刷新 / 切 session 不打断）

- canonical jsonl 是单一真相，刷新后 GET `/api/groups/:gid` 返回完整 transcript，UI 重建
- 若有 in-flight turn，attach 到现有 SSE channel（沿用 `server/shared/inflight.ts`）
- pipeline 中途崩溃重启：jsonl 已落到第几步就从第几步恢复显示；**不重跑剩余步**（避免重复副作用如文件写入）；UI 显示 `第 1 步已完成 · 第 2 步未开始 (中断)`，用户可点 "Resume from step 2" 显式触发

### 单 agent 失败

- pipeline 第 1 步失败 → append error turn 到 jsonl，pipeline 终止，第 2 步不跑；UI 显示红色 step 1 + "继续 / 重试 / 跳过 step 1 直接跑 step 2" 三个按钮
- 第 2 步失败 → 同理，第 1 步成果保留

### Token 成本控制

- v1：直接每轮塞全量历史；保持 input 数组前缀（system prompt + 第一批 user/assistant）稳定，自动吃 prompt cache
- v2（YAGNI）：transcript 超过 N 条 / M tokens 时压最早 K 条成单条 `[历史摘要]`

### Skill / MCP 装载

- `groups/config.ts` 提供 `resolveAgentRunOptions(group, agentId)` → `{ skills: SkillDef[], mcpServers: McpServerConfig[] }`
- skill 解析复用 `~/.claude/skills/` 等现有发现机制
- MCP catalog：v1 提供 `bash`, `schedule` 内置；用户可在 group config 里声明额外 MCP（连接 url / command）；每 agent 选用哪几个独立配
- 每次 SDK call 时把这些 options 传进去；不需要 runtime 切换 —— single-shot 本来就是"会话级 = 每次重设"

### 测试

- `input-builder.ts` 单测（最关键）：
  - 单 agent 无跨注入
  - 跨注入前缀正确
  - 工具历史跳过
  - 图片附件穿透
  - 空 transcript
  - thinking 跳过
- `orchestrator.ts` 集成测：mock claude-runner / codex-runner，验证 pipeline 顺序、jsonl append 时机、SSE 事件序列
- `store.ts` 单测：append concurrency、tail 解析、损坏行容错
- `config.ts` 单测：默认值填充、participant 字段校验
- 端到端：项目无 e2e 框架，手测覆盖

### 安全 / 边界

- 群聊 cwd 与单聊一致：受 `CC_WEBUI_CWD` / 用户传值约束
- transcript.jsonl 单文件锁不需要：node 单进程 append，已有项目惯例
- 删除群聊：删整个 `~/.cc-webui/groups/<gid>/` 目录 + 从 index.json 摘掉
- 导出群聊为 markdown：v2，不做

## 实现切片建议（给 writing-plans 阶段参考）

1. **Prereq**：从 `chat.ts` / `codex-chat.ts` 抽 `server/shared/` 共享模块（pure refactor，单聊零回归）
2. `server/groups/store.ts` + `config.ts` 数据层 + 单测
3. `server/groups/input-builder.ts` 纯函数 + 单测（最关键，先跑通）
4. `server/groups/orchestrator.ts` 编排逻辑 + mock 集成测
5. `server/groups.ts` HTTP/SSE 路由
6. UI：`NewGroupDialog` + `GroupChatView` 骨架
7. UI：Composer @ 自动补全 + mention 节点
8. UI：sidebar "群聊" 分组 + index.json 索引
9. UI：MessageList agent 分色渲染 + permission 卡片来源标
10. 失败恢复 / Stop 语义打磨
11. 手测全流程
