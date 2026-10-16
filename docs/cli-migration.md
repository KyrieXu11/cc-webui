# CLI 驱动迁移 — 决策记录与接手指南

> **给接手的 agent**：这份文档记录一次设计评审的**全部结论 + 已核实的事实**。
> 事实部分是实测出来的（跑过命令、读过 `node_modules` 源码），**不要重新调研**，直接用。
> 如果你发现某条事实和现实不符，改这份文档并注明日期，不要默默绕过。
>
> 定稿日期：2026-08-22 · **两侧都已实施完毕（Claude 2026-08-30，Codex 2026-09-17）**
> 相关：架构总览见 [`../AGENTS.md`](../AGENTS.md)，飞书见 [`./feishu.md`](./feishu.md)。
> ⚠️ 不要参照 `docs/superpowers/`——那是设计期文档，AGENTS.md 已列出它与实现的漂移。
> **2026-10-10 更新**：仅 Codex 网页单聊改用 app-server 支持实时插话；引擎/飞书仍用 exec。
> 本文早期 exec-only 结论有时间边界，最新实现与验收见末节。

## 目标

1. **群聊变成环境变量可开关**（✅ 已完成，见下）
2. **扔掉 `@anthropic-ai/claude-agent-sdk` 和 `@openai/codex-sdk`，自己驱动 CLI 子进程**
   （✅ 已完成，两个依赖都已从 `package.json` 删除）

## 已完成：群聊开关

`CC_WEBUI_GROUPS_ENABLED`（默认关）。语义、执行点、为什么不在 `validateConfig` 层面拦，
全部记在 **AGENTS.md 的「3. 会话引擎」一节**，这里不重复。相关文件：`server/features.ts`、
`server/groups/orchestrator.ts`（`capToSoloWhenGroupsDisabled`）、`server/groups/group-flag.test.ts`。

---

## 决策表

| # | 决策 | 理由 |
|---|---|---|
| 1 | 群聊开关的动机是**产品聚焦**（设计不成熟先收敛），不是收安全面 | 决定了边界取最窄的那个 |
| 2 | 换 CLI 的动机是**版本跟随**（吃本机 CLI 的新能力）+ **实时拿模型列表** | 见「模型」一节，事实已证实版本确实落后 |
| 3 | **先做开关，再迁 CLI** | 两件事互相独立（飞书继续跑 → runner 仍是活代码，开关不缩小迁移面积），开关小且是当下想要的 |
| 4 | 开关**默认关** | 单用户自托管，没有"老用户无感升级"包袱；忘配的机器自动处在最小面 |
| 5 | executor 代码**写在 cc-webui 里，不抽 npm 包** | 只有一个消费者，抽包会在只见过一个用例时冻死接口。跨项目该复用的是**设计**，不是代码 |
| 6 | 开关管的是「**2 participant**」能力，不是引擎 | 飞书 p2p 是 1-participant 会话，跑在同一个引擎上，不能一起关 |
| 7 | flag 关闭时网页群聊入口**彻底不出现**；flag 经 `/api/meta` 运行时下发 | 编译期 flag 会让 `npm run dev` 改一次就得重启 vite |
| 8 | ~~SDK 落后哪个能力~~ | **已被事实取代**：不是缺能力，是版本钉子（见下） |
| 9 | 模型：Claude 用**家族别名**；Codex 读 `models_cache.json`**读不到则回退内置列表**；`XHIGH_CLAUDE_MODELS` **继续手维护** | CLI 完全不校验 `--effort`，当不了裁判 |
| 10 | **两个 SDK 都扔掉，自己写驱动** | 用户明确决定。注意：`pathToClaudeCodeExecutable` / `codexPathOverride` 是 SDK 的 option，本方案不用 SDK，故与它们无关 |
| 11 | 二进制定位：`CC_WEBUI_CLAUDE_BIN` / `CC_WEBUI_CODEX_BIN`，**为空则从 PATH 解析** | 版本跟随默认开 |
| 12 | 开关只在 turn 层面截断，**config 和 transcript 一行不改** | 改 `validateConfig` 会让已存 2-agent 群 `readConfig` 直接抛，并搞挂绑到它们的飞书 chat |
| 14 | Codex 驱动用 **`--experimental-json`**，不用文档化的 `--json` | 事件形状与现在完全相同 → `processor.ts` 的 Codex 分支零改动。启动日志记下用的是哪个 flag，哪天它没了好定位 |
| 15 | 重写时**顺手修 mode 语义**：`default` 接上真实审批、`dontAsk` 修正反向 | 详见「已知的坑 · mode 语义」 |
| 16 | 三个进程内 MCP → **迁到已有的 HTTP MCP 路由**（`mcp-bash-route.ts`） | **不要选 stdio 子进程**，原因见「MCP」一节——(a)/(c) 不等价 |
| 17 | `sessions.ts` 的三个 SDK 函数 → **自己写 jsonl 读取器** | `server/session-store.ts` 已有读 Codex native jsonl 的同类实现可照抄 |

---

## 已核实的事实（别重新调研）

### 1. 两个 SDK 本来就是 CLI 子进程包装器

这条推翻了"换成 CLI 驱动"的朴素理解：**现在就已经在跑 CLI 了**，只是跑的是 SDK 钉住的旧版本。
所以这次迁移不是 SDK→CLI，是**重新实现驱动层**。

| | 机制 | 版本 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `sdk.mjs:15` `spawn`；二进制来自 8 个平台 optionalDependencies；`sdk.mjs:117` 解析路径 | `manifest.json` 钉 **2.1.201**；darwin-arm64 的 `claude` = 231,708,784 字节 |
| `@openai/codex-sdk` | `dist/index.js:137` import spawn，`:250` spawn，`:174` argv = `["exec","--experimental-json", …]`；prompt 走 stdin；输出 readline 读 JSONL；`:289-292` 非零退出抛错 | 依赖 `@openai/codex@**0.142.5**` |

本机实际安装：`claude` **2.1.239**、`codex-cli` **0.144.1**。两边都比 SDK 新。

**SDK 在 argv 之上加了什么**：Claude 侧是一套**双向控制协议**（见下）+ 进程内 MCP 桥接 + 类型化事件
+ session 记账；Codex 侧几乎只有行分帧、`JSON.parse`、thread-id 跟踪和类型（约 250 行透明包装）。

### 2. CLI 能力

`claude` —— 需要的 flag 全都有：
`-p/--print`、`--output-format text|json|stream-json`、`--input-format text|stream-json`、
`--include-partial-messages`、`--resume [id]`、`-c/--continue`、`--fork-session`、`--session-id <uuid>`、
`--model`、`--effort`、`--permission-mode`（`acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`）、
`--mcp-config`、`--strict-mcp-config`、`--allowed-tools`/`--disallowed-tools`、`--tools`、
`--append-system-prompt`、`--system-prompt`、`--max-budget-usd`、`--include-hook-events`、
`--replay-user-messages`、`--settings`。

⚠️ **`--permission-prompt-tool` 不在 `--help` 里但真实可用**（实测 exit 0）。传 `stdio` 是**哨兵值**
而非工具名——SDK 的逻辑是：设了 `canUseTool` 就 push 字面量 `"stdio"`。

`codex exec` —— `--json`、`resume`、`-s/--sandbox {read-only,workspace-write,danger-full-access}`、
`-m/--model`、`-c/--config k=v`、`--output-schema`、`-o/--output-last-message`、`-C/--cd`、
`--add-dir`、`--skip-git-repo-check`、`--ephemeral`、`-i/--image`。
⚠️ `-a/--ask-for-approval` **只在顶层 TUI 上有，`codex exec` 上没有**。
⚠️ `codex exec` **没有 partial-message / delta 相关 flag**，Codex 侧增量事件未验证。

### 3. 控制协议（**无文档、无版本协商**）

权限卡和进程内 MCP 都跑在这上面。前提：`--input-format stream-json`。

子类型全集：`initialize`、`can_use_tool`、`hook_callback`、`mcp_message`、`interrupt`、
`set_permission_mode`、`mcp_set_servers`。

**权限（`can_use_tool`）线格式**——CLI 写 stdout：

```json
{"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":"…","input":{…},"permission_suggestions":…,"blocked_path":…}}
```

host 写 stdin（**CLI 在此期间真的阻塞，无上限**）：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}
```

deny 用 `{"behavior":"deny","message":"…"}`。这正是 cc-webui 权限卡需要的语义。

**进程内 MCP**：`createSdkMcpServer` 返回 `{type:"sdk",name,instance}`；通过 `initialize` 的
`sdkMcpServers:[names]` 和 `mcp_set_servers` 声明；之后每条 JSON-RPC 消息双向隧道成
`control_request{subtype:"mcp_message", server_name, message}`。**CLI 没有 in-process 的 flag，
只有这个隧道。** 本方案不重实现它（见 Q16）。

⚠️ **版本偏移完全无防护**：`claudeCodeVersion` 在 `sdk.mjs` 里出现 **0 次**，没有 `versionCheck` /
`MIN_CLI` / `protocol_version`，`initialize` 载荷里只有 feature 字段。所以哪天 CLI 改了这套协议，
不会有任何警告，症状会是权限卡或 MCP 静默失效。**驱动层务必在启动日志打印
`claude --version` / `codex --version`**，出问题第一眼能定位。

### 4. 流式保真度：`stream-json` == `query()` 吐的东西

实测捕获（`claude -p --output-format stream-json --include-partial-messages --verbose`）产出：

- `system/{init,status,thinking_tokens,hook_started,hook_response}`
- `stream_event/{message_start, content_block_start, content_block_delta(text_delta|thinking_delta|signature_delta|input_json_delta), content_block_stop, message_delta, message_stop}`
- `assistant/{text,thinking,tool_use}`、`user/{tool_result}`、`rate_limit_event`
- `result/success`（`usage`、`modelUsage`、`total_cost_usd`、`stop_reason`、`terminal_reason`、`permission_denials`）

`src/lib/processor.ts` 读的每个字段都在，**没找到任何"SDK 有而 stream-json 没有"的事件**。
`processor.ts` 里 SDK 侧独有的三个是 cc-webui 自己合成的，不是模型事件：
`permission_request`、`permission_resolved`（`:106`、`:129`）、`wakeup_turn_started`（`:93`）。
Codex 分支（`:63-88` 的 `thread.started` / `turn.failed` / `item.*`）本来就是原始 JSONL 直传。

**2026-09-29，Codex 0.157.1 的两条漂移（本机 rollout + 已落盘 exec 帧实测）**：

- `--experimental-json` 的 `item.id` 是 `item_N`，**每次 exec（包括 resume）重新编号**。
  它不是 session 内唯一 id，前端必须按 turn/user boundary 加 scope，不能直接跨轮 upsert。
- native rollout 不再使用 `event_msg/user_message` / `agent_message` / `exec_command_end`，
  而是 `event_msg/item_completed`，里面的 `item.type` 为 PascalCase（`UserMessage` / `AgentMessage` /
  `CommandExecution` / `McpToolCall` 等）。`response_item` 是另一路的重复记录且包含 CLI 注入的 user-role
  环境上下文，不能把所有 role=user 都当用户提问。`session-store.ts` 兼容新旧格式，只取公开消息/工具，
  不暴露 native 的 `Reasoning.raw_content`。

**结论：事件映射层基本不用改。** 唯一改动是 `permission_request` / `permission_resolved` 的来源
从 `canUseTool` 回调换成 `control_request` 帧。

#### 4b. ⚠️ Claude 5 家族的 thinking 是加密的：**只有 token 计数，没有明文**（2026-08-26 实测）

`thinking_delta` 照常来，但 `thinking` 字段恒为空串，真正的载荷是 `estimated_tokens`：

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,
 "delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}}}
```

`content_block_start` 的 thinking block 是 `{"type":"thinking","thinking":"","signature":""}`，
末尾一条 `signature_delta` 带 13.8KB 签名 blob。落盘的 `assistant` 消息里也一样是
`{"type":"thinking","thinking":"","signature":"CAIS…"}`。

- **`estimated_tokens` 是增量，不是累计值**：一次思考的 38 条 delta 累加 4350，对上同条消息
  `usage.output_tokens_details.thinking_tokens = 4403`。要显示总量必须自己累加。
- 最后一条 delta 可能**不带**这个字段，按 0 处理。
- 历史回放没有 delta 可累加，但 `usage.output_tokens_details.thinking_tokens` 落盘了，用它。

扫 `~/.claude/projects` 最近 120 个会话（按模型统计 thinking block）：

| 模型 | block 数 | 明文为空 | 最长明文 |
|---|---|---|---|
| `claude-opus-5` | 2334 | **2334** | 0 |
| `claude-sonnet-5` | 1 | 1 | 0 |
| `claude-fable-5` | 2 | 2 | 0 |
| `claude-sonnet-4-6` | 266 | 0 | 15638 |
| `claude-haiku-4-5` | 66 | 4 | 2288 |

**分界线就是 Claude 5 家族。** 4-6 / 4-5 仍给明文，5 一律不给。所以任何「渲染思考正文」的 UI
在默认模型（`opus`）下都会退化成空白 —— 终端 Claude Code 显示的也不是正文，而是
`✻ Whirring… (7m24s · ↓ 19.2k tokens · thinking with max effort)` 这种**状态行**。
cc-webui 的对应实现是 `src/components/ThinkingRow.tsx`。

### 5. 模型

**Claude 家族别名可用，且会 server-side 解析成当前版本**（8 个全部实测）：

| 别名 | 实际跑的 |
|---|---|
| `default` | `claude-opus-5[1m]` |
| `fable` | `claude-fable-5` |
| `opus` / `opus[1m]` | `claude-opus-5` / `claude-opus-5[1m]` |
| `sonnet` / `sonnet[1m]` | `claude-sonnet-5` / `claude-sonnet-5[1m]` |
| `opusplan` | `claude-sonnet-5` |
| `haiku` | `claude-haiku-4-5-20251001` |

**这是别名方案最强的论据**：`src/lib/settings.ts:82-120` 现在钉的是 `claude-opus-4-8` /
`claude-sonnet-4-6`，而 `opus`/`sonnet` 已经解析到 **opus-5 / sonnet-5**——硬编码列表**已经落后一代**。
用别名就自动跟随了。

顺带：`DEFAULT_SETTINGS.model = "sonnet"` 在别名方案下**本来就是合法的**。AGENTS.md 里
「默认模型 sonnet 不是合法 id → 静默改写成 fable-5」那条 bug，根源就是当初从别名改成了钉版本 id，
改回别名即自动消失，不需要单独修。

⚠️ 不带前缀的日期 id **会失败**：`sonnet-4-6` → 404。

**`--effort` CLI 完全不校验**——`haiku`+`xhigh`、`sonnet`+`max`、甚至 `bogustier` 这种瞎写的档位
全部静默通过。所以 `settings.ts:186-196` 的 `XHIGH_CLAUDE_MODELS` **必须继续手维护**。

**Codex 没有别名，只能精确 id**（实测 `codex`/`mini`/`gpt-5`/`gpt-5-codex`/`sonnet` 全失败）。
但机器上有 **`~/.codex/models_cache.json`**（每模型 38 个字段，含 `supported_reasoning_levels` /
`visibility` / `context_window` / `supported_in_api` / `display_name` / `description`）。
⚠️ **它是服务端拉的缓存，会坏**——2026-08 调研时这台机器上它就是坏的（从一条泄漏的 stderr
`codex_models_manager::cache: failed to load models cache: missing field base_instructions` 发现的），
schema 是 Codex 内部的。**所以要回退路径。**

**2026-09-17 复测**：这份缓存这次是好的（`client_version` 0.144.1，与安装版本一致），
`visibility: "list"` 的恰好四个：`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5`，
**逐个真跑一轮全部通过**；而仓库当时硬编码的五个里有四个已经死了
（`gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex` / `gpt-5.2` → 400 `not supported when using Codex
with a ChatGPT account`）。`gpt-5.6` / `gpt-5.6-codex` 这种猜的 id 也是 400。
**缓存里的 `visibility` 和真实可用性这次完全对得上**，这就是决策 #9 那条路线的最强证据。
顺带：5.6 那三个的 `supported_reasoning_levels` 含 `max`（sol/terra 还有 `ultra`），
所以 `settings.ts` 里「max 是 Claude 独有、Codex 顶档是 xhigh」这句**已经不再准确**——
executor 现在仍把 `max` 折到 `xhigh`（保持旧行为），想放开是另一件事。

**两个 CLI 都无法枚举模型**：`claude models` 会被当成 prompt 真跑一轮；`codex models` →
`Error: stdin is not a terminal`；非法值的报错也不列出合法集。`~/.claude/` 下和 SDK 包里
**没有** 带 capability 元数据的 Claude 模型清单（`sdk.d.ts` 只有一个不完整、非权威的 id union，
连 `claude-sonnet-4-6` / `claude-haiku-4-5` 都缺）。

---

## 工作清单

### 要替换的 SDK 调用点

**`@anthropic-ai/claude-agent-sdk`**

| API | 调用点 | 迁移 |
|---|---|---|
| `query()` | `server/chat.ts:426`、`server/groups/claude-runner.ts:60`、**`cli/subagent-mcp/index.ts:77`**（别漏这个独立小工具） | spawn + stream-json 解析 |
| `createSdkMcpServer()` / `tool()` | `server/bash-mcp.ts:470`、`server/schedule-mcp.ts:98`、`server/feishu/lark-mcp.ts:210`（共 **9** 处 `tool()`） | 迁到 HTTP 传输，见下 |
| `listSessions` / `getSessionMessages` / `deleteSession` | `server/sessions.ts:27,63,78` | 自己写 jsonl 读取器（Q17=a） |
| 类型 `McpSdkServerConfigWithInstance` | `bash-mcp.ts:4`、`schedule-mcp.ts:4`、`lark-mcp.ts:7`、`groups/runner-types.ts:1`、`groups/orchestrator.ts:84,219` | 自己声明 |
| 类型 `PermissionUpdate` | `shared/permission-flow.ts:1` | 自己声明 |

`query()` 用到的 option（11 个）：`resume`、`cwd`、`model`、`permissionMode`、`effort`、
`includePartialMessages`、`mcpServers`、`disallowedTools`、`systemPrompt{type:"preset",preset:"claude_code",append}`、
`canUseTool`，外加 `cli/subagent-mcp` 的 `allowedTools`。迭代器侧只用了 `.return?.()`
（`chat.ts:539`、`claude-runner.ts:180`）——对应子进程的 kill。
`canUseTool` 回调消费 `suggestions,title,displayName,description,toolUseID,signal`（`chat.ts:464-491`），
返回 `{behavior:"allow",updatedInput[,updatedPermissions]}`（`chat.ts:519-523`）。

**`@openai/codex-sdk`**：`new Codex({config,env})`（`codex-chat.ts:366`、`groups/codex-runner.ts:117`）、
`resumeThread`/`startThread`/`runStreamed({signal})`（`codex-chat.ts:382-385`、`codex-runner.ts:139-143`）。
threadOptions 6 个：`model`、`workingDirectory`、`skipGitRepoCheck`、`sandboxMode`、`approvalPolicy`、
`modelReasoningEffort`。注意 `codex-runner.ts` 没 import 类型，`:135`/`:142` 有 `as any`。

### MCP：为什么必须选 HTTP，不能选 stdio 子进程

评审时以为「HTTP 路由」和「stdio 子进程」等价。**不等价**——那三个 MCP server 有两个是
**进程内有状态**的：

- `server/bash-mcp.ts` 持有模块级任务注册表，而 `server/bash-tasks.ts` 的 `/api/bash/tasks` SSE
  面板**直接读同进程的它**（`subscribeListChanges`、`subscribeTaskOutput`、`subscribeForegroundEvents`、
  `listBackgroundTasks`、`getBackgroundTaskById`、`killBackgroundTaskById`、`relabelTasksSessionId`）。
  挪进子进程 → 后台任务面板直接瞎。
- `server/feishu/lark-mcp.ts` 是**每 turn 现造**的（`handler.ts:564`），绑定当轮那个飞书 chat。
  子进程拿不到这个绑定。

而 `server/mcp-bash-route.ts` 用 **bearer token 携带 per-turn 上下文**
（`registerCodexMcpContext` / `getCodexMcpContext`，`codex-mcp-context.ts:18,45`），
**服务端仍在同一个进程里**——所以它只是换传输，模块状态全部保留。这也正是它今天能给
Codex / 飞书用的原因。

顺带收益：这一步把 AGENTS.md 那条「两套 Bash MCP，改 bash 行为两边都要看」**合并成一套**。
代价是 bash 工具多一跳 localhost，单机可忽略。

⚠️ 迁之前先修 `mcp-bash-route.ts:362-388` 的泄漏：`/bash` 和 `/lark` **每个 HTTP 请求**都 new 一个
`McpServer` + transport 且都不 close。现在只有 Codex/飞书在用，迁完 Claude 也走这条，泄漏会放大。

---

## 已知的坑

### lvshu 已经付过学费的三个（不处理会原样继承）

1. **"API Error" 是以一条合成的 `assistant` 消息到达的**，不是协议错误。不拦就直接变成回答给用户。
   lvshu 为此开了整个 `claude_apierror.go`（156 行）。
2. **`result.terminal_reason == "api_error"` 会置 `is_error`，但 `subtype` 仍是 `"success"`**
   （`lvshu/.../claude.go:270-274`）。只看 `subtype` 会把失败当成功。
3. **result 事件里的原因要盖过进程退出码**，且超时和主动取消必须分开
   （`claude.go:319-336`：`DeadlineExceeded`→timeout、`Canceled`→aborted）。

（lvshu 那个 10MB `scanner.Buffer`（`claude.go:220-221`）是 Go 独有问题——Node 的 `readline`
没有行长上限，这条不用抄。）

另外 `system/thinking_tokens` 是 lvshu 在代码里标注为「唯一的跨模型 is-it-thinking 信号，且无文档」。

### mode 语义（Q15=a：重写时修）

`server/codex-chat.ts:187-198` 和 `server/groups/codex-runner.ts:44-51` 都把 4 个 mode 塌成
`{sandboxMode:"workspace-write", approvalPolicy:"never"}`：

- **`default`**：UI 上写着「每次弹权限」，实际从不问，且有 workspace 写权限。
  `codex-chat.ts` 里**根本没有权限卡代码**。
- **`dontAsk`**：飞书 `/mode` 帮助文案（`server/feishu/parse.ts:66`）写的是「不询问，未预批一律拒」，
  实际是**无审批全写**——语义反了。`handler.ts:67` 的 `MODE_ALIASES` 真的接受 `dontask`/`deny`。

修 `default` 和 `dontAsk` 这两个说谎的；`auto`/`acceptEdits` 保持现状。
另外 `validateConfig`（`groups/config.ts:39-81`）既不校验 `mode` 也不校验 `model`，任意字符串
都能进 config 并直达 SDK/CLI——顺手加上。

### ⚠️ `--allowedTools` / `--disallowedTools` 是变长参数，会吃掉 positional prompt

`claude --help` 写的是 `--disallowedTools, --disallowed-tools <tools...>` —— 三个点是 commander
的变长语法，它会贪心吞掉后面**所有不是 flag 的 argv**。而 prompt 就是个 positional：

```bash
# 坏：prompt 排在变长 flag 后面（CLI 2.1.246 实测）
$ claude -p --disallowedTools Bash "say hi"
Permission deny rule "say" matches no known tool — check for typos.
Permission deny rule "hi" matches no known tool — check for typos.
Error: Input must be provided either through stdin or as a prompt argument when using --print

# 好：prompt 在变长 flag 之前
$ claude -p "say hi" --disallowedTools Bash
Hi! 👋 What can I help you with today?
```

报错信息和真实原因**毫无关系**（它说没给 prompt，其实是 prompt 被当成了两条 deny 规则），
所以踩上去很难查。更阴的情况：prompt 里恰好有个词等于真实工具名（`Read` / `Bash` / `Write`…）
时**不报错**，那个工具被静默禁用，表现为「agent 莫名其妙不会用某个工具」。

`buildClaudeArgs` 原来把 prompt push 在最后，正是坏形状；没炸只因为两个调用方
（`chat.ts` / `claude-runner.ts`）都传 `onPermissionAsk` → `needsStdinProtocol()` 为真 →
prompt 走 stdin，那行是死代码。**已修**：prompt 移到固定 flag 之后、变长 flag 之前，
`claude-executor.test.ts` 加了「prompt 下标必须小于两个变长 flag」+「argv 末项不得是 positional」
的回归断言（旧断言 `plain.at(-1) === "say hi"` 恰好把坏形状固化了，已换掉）。

**规则：`buildClaudeArgs` 里在变长 flag 之后追加的东西必须是 flag，永远不能是 positional。**

### 别再重复的死 flag

仓库里有一个 `FEISHU_USE_WEBHOOK`：`.env.example` 和 `docs/feishu.md` 都写了，`config.ts` 的
`transportMode()` **零调用方**，webhook 端点固定 404。新增 flag 时别再造一个这样的。

---

## 参考实现：lvshu（Go，生产在跑）

`/Users/xuqiang/code/ts/lvshu/server/internal/agent/` —— **不用 SDK，直接驱动 `claude` CLI**。
Go 代码不能直接搬，**设计可以**。索引：

| 关注点 | 位置 |
|---|---|
| 定位二进制 / 起进程 | `claude.go:34` `exec.LookPath`、`:54` `exec.CommandContext`、`:74/:79` pipes、`:87` Start |
| argv 构造（交互模式） | `claude.go:104-112`：`-p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --strict-mcp-config --permission-prompt-tool stdio --permission-mode default --tools default` |
| argv 构造（一次性模式） | `claude.go:120-125`：prompt 走位置参数、无 `--input-format`、`--disallowedTools AskUserQuestion` |
| 解析结构（`RawMessage` 懒解码） | `claude.go:391-420`（`claudeEvent`）、`:444-461`、`:475-494` |
| 跳过无法解析的行 | `claude.go:224` |
| 控制协议应答 | `claude.go:566-591` `answerClaudeControl` |
| 权限策略（路径牢笼，**不是问人**） | `claude.go:578-613` |
| MCP（真 stdio 传输 + 自动 `--allowedTools`） | `claude.go:145`、`:150-175`、`:164`；`agent.go:46-52` |
| `--resume` + session id 采集 | `claude.go:129`、`:226-228` |
| provider 中立抽象 | `agent.go:16-19` `Backend`、`:60-63` `Session`、`:67-118` `Message`/`MessageType`、`:150-160` `Result`/`RunStatus`/`FailureKind` |

⚠️ **lvshu 没验证 cc-webui 特有的两件事**：它的权限阻塞是路径牢笼、**从没等过一个真人**；
它的 MCP 是 stdio 子进程、**没有进程内等价物**。另外它的 "provider 中立" 只有一个实现——
`agent.go:190` `SupportedTypes = []string{"claude"}`，**没有 Codex backend**，而
`LVSHU_EXECUTOR=mock` 换的是更上层的 `service.AgentRuntime`，不是 `agent.Backend`。
所以那层抽象是**有依据的设计意图，不是经过两个实现验证的接缝**。

值得抄的设计：两模式 argv 构造器、扁平事件结构 + 懒解码、跳过坏行、"result 原因盖过退出码"、
超时/取消分离、合成 API 错误拦截、`control_response` 信封、`FailureKind` 重试分类。
Node 侧对应物：`child_process.spawn`、`readline.createInterface`、`AbortSignal`（codex-sdk 的
`dist/index.js:250` 就是这么做的）、async generator 代替 channel。
**没有 npm 库做那套控制协议**——`can_use_tool` 和 `mcp_message` 的分帧得手写。

---

## 落地顺序与接口（已定）

**18. 先做 Claude 侧**，抽成一个 **executor**（不是 runner——两个词的区分见 AGENTS.md）。
Codex 侧随后。

**19. 接口参考 lvshu 的 `Backend` / `Session`**。但注意：**cc-webui 现有的 `RunnerEvent`
（`server/groups/runner-types.ts:16-33`）已经是那个结构了**——

| lvshu | cc-webui 现状 |
|---|---|
| `Session.Messages` 流 | `{kind:"raw", payload:unknown}` |
| `Session.Result`（恰好一个终态） | `{kind:"ended", ok, error, events, sessionId, sessionNotFound}` |
| `FailureKind: transient` | `sessionNotFound`（同一个想法的特化版，触发一次重试） |
| `RunStatus` 五态 | ❌ 只有 `ok: boolean` |
| `FailureKind` 三态 | ❌ 只有那一个布尔 |

所以这一步是**把已有的泛化**，不是新造一层规范化事件。具体见下面两条。

**20. stream 的元素保持 raw stream-json 帧**（`payload: unknown`），**不引入 lvshu 的
`Message`/`MessageType`**。理由：stream-json 就是 SDK 原本吐的东西（已实测，见「流式保真度」），
而 cc-webui 的 raw 帧是**客户端和服务端用同一个函数折叠**成 `ChatEvent` 的
（`runner-types.ts:6-14` 有说明）。照搬 lvshu 的 `Message` 会变成
`stream-json → Message → ChatEvent` 两层映射——lvshu 需要那一层是因为它没有 `ChatEvent`。

**21. 权限回调**：executor 接口收一个 **`canUseTool` 形状的 async 回调**，
executor 内部负责 `control_request` ↔ 回调 ↔ `control_response` 的分帧。
这样两个调用方（`chat.ts` 的权限卡、`claude-runner.ts` 的 group 权限卡）逻辑都不用改，
只是产出方换了。
⚠️ **lvshu 在这一点上帮不上忙**——它的权限策略是路径牢笼（`claude.go:578-613`），
从不等一个真人；它的人在环走的是完全另一套机制（`tool_deferred` + 环境变量 + server hook）。

**22. 目录 = `server/executors/`**（不放 `server/shared/`：那里只有一个横切工具
`permission-flow.ts`，而 executor 是有多文件的子系统；且 `server/shared/` 这名字在 plan 里
曾想用而没落地，见 AGENTS.md 漂移表）。

**23. `ended` 全套照搬 lvshu**：`RunStatus` + `FailureKind` 三态都上。
唯一省掉的是 lvshu 的第五态 `deferred`——那个状态存在正是因为 lvshu **不阻塞等人**
（走 `tool_deferred` + 环境变量 + hook），而 cc-webui 靠控制协议**中途真阻塞**，永远不会 defer。

### 已落地（**未接线**——`chat.ts` / `claude-runner.ts` 仍在用 SDK）

| 文件 | 内容 |
|---|---|
| `server/executors/types.ts` | 中立契约：`Executor` / `ExecOptions` / `ExecFrame` / `ExecResult` / `PermissionAsk` / `McpServerSpec` |
| `server/executors/permission-types.ts` | `PermissionUpdate` 等从 SDK `sdk.d.ts` 原样转录到本地（扔 SDK 后仍有效，它们描述的是 **CLI 的**线上词汇） |
| `server/executors/claude-executor.ts` | Claude 实现：argv 构造、readline 分帧、控制协议收发、终态分类、合成 API 错误拦截 |
| `server/executors/contract.test.ts` | 契约测试：两个 stub 证明 claude/codex 都能实现同一接口；两个 option 字面量证明现有调用点每个参数都表达得出来 |
| `server/executors/claude-executor.test.ts` | 纯函数单测，含用**真实捕获载荷**写的回归用例 |

### 实测通过（真 CLI 2.1.239）

| 场景 | 结果 |
|---|---|
| 普通一轮 | `completed`，`session_id` 采集到 |
| **控制协议 / 权限卡** | `onPermissionAsk` 收到 `Write`，拒绝后模型改试 `Bash`、又收到一次；**两次都被遵守，文件没被创建** |
| resume | 上一轮记的数字下一轮能答出来，上下文延续 |
| 坏 resume handle | `sessionNotFound: true` + `failureKind: transient` |
| 主动取消 | `status: "aborted"`（**不是** `failed`） |
| **HTTP MCP 往返** | `--mcp-config` 指向 `mcp-bash-route.ts` + bearer token → `mcp__bash__run` 真的执行、结果回来；`autoAllow` 正确短路权限询问。**决策 #16 的承重假设实测成立** |

### 实现时踩到并修掉的三个真 bug（猜不出来，只能实测）

1. **`--input-format stream-json` 下进程跑完不退出。** 保持 stdin 打开是控制协议的需要，但 CLI
   会一直等更多输入 → 回答早就流完了却撞超时。修法：`result` 事件就是"本轮结束"的信号，
   此时关 stdin（语义上正好：控制请求只可能发生在轮次进行中），另加 5s 宽限 kill 兜底，
   否则长驻服务每轮泄漏一个子进程。
2. **stale session 的原因在 `result.errors`（数组），不是 `result.error`（字符串）。**
   实测载荷 `{"type":"result","subtype":"error_during_execution","is_error":true,
   "errors":["No conversation found with session ID: …"]}`。只读单数字段就拿不到任何原因，
   于是一个**可自愈**的 stale session 被静默降级成 `permanent`。stderr 也带同一句，已作兜底。
3. **坏 handle 不能回传。** 原本把已死的 handle 原样放进 `sessionHandle`，调用方一持久化，
   下一轮又 resume 同一个死 session，自愈永不收敛。（SDK 时代的 runner 特意清掉过，
   见 `server/groups/claude-runner.ts:234`。）

设计时发现的一个洞（已补进接口）：**两个 CLI 收图片的方式根本不同**——Claude 是 base64
内联进 prompt 的 content block（`chat.ts:392-404`），Codex 必须**落成磁盘临时文件**再用
`-i/--image` 传路径、跑完还要清理（`codex-chat.ts:210+`）。所以中立层只有
`images?: ImageAttachment[]`，两边各自翻译，临时目录的生命周期由 executor 在 generator 的
finally 里自己管。

## 已接线（Claude 侧完成）

`server/chat.ts`（网页单聊）和 `server/groups/claude-runner.ts`（群聊 / 飞书）都已改为
`claudeExecutor.exec()`。**服务端已完全不 import SDK**（只剩 `cli/subagent-mcp/index.ts`）。

### 连带完成的前置改造

| 改动 | 为什么 |
|---|---|
| `codex-mcp-context.ts` → **`mcp-context.ts`**，`registerMcpSessionContext` 等中立命名 | Claude 也用它了，留 `Codex` 前缀就是命名谎言 |
| context 新增 `onForegroundEvent` / `wakeupSlot` | 前台 bash 事件要打进本轮 SSE；`schedule` MCP 需要 wakeup 槽 |
| `mcp-bash-route.ts` 新增 **`/schedule`** 端点 | 原来的 `schedule` MCP 建在 SDK 的 `createSdkMcpServer` 上，扔 SDK 就必须有传输版 |
| `getCodexMcpUrl` → **`getMcpRouteUrl`**，`McpRouteName` 加 `"schedule"` | 同上，不再是 Codex 专用 |
| **删掉** `server/schedule-mcp.ts`、`server/feishu/lark-mcp.ts`；`bash-mcp.ts` 删 `createBashMcpServer` | 三个进程内 MCP 构造器全部零调用方 |
| `RunnerCtx.extraMcpServers` 及 orchestrator / handler 的透传全部删除 | 飞书原来给 Claude 和 Codex 各注入一份 lark（进程内 + HTTP）；现在两者都走 HTTP，**AGENTS.md 那条「两套 Bash MCP」真的合并成一套了** |
| 新增 **`server/claude-sessions.ts`** 替代 SDK 的 `listSessions` / `getSessionMessages` / `deleteSession` | 决策 #17。CLI 没有对应命令 |
| `shared/permission-flow.ts` 的 `PermissionUpdate` 改用本地声明 | 最后一个 type-only SDK 依赖 |

### 修掉的泄漏，以及为什么不能用缓存

`mcp-bash-route.ts` 原来每个 HTTP 请求 new 一个 `McpServer` + transport 且从不 close。
先试了「按 token 缓存复用」——**实测直接失败**：
`Error: Stateless transport cannot be reused across requests. Create a new transport per request.`
所以 per-request 是强制的，泄漏只能靠**响应流结束后再 close**（`TransformStream` 的 `flush`）。
已实测 MCP 往返仍然工作。

### 实测通过（真 CLI，隔离进程，绝不启动整个 server）

| 路径 | 场景 | 结果 |
|---|---|---|
| `/api/chat` | 普通轮 | `PONG`，SSE 事件类型齐全，`done` |
| `/api/chat` | bash 经 HTTP MCP | `mcp__bash__run` 调用成功，返回 `CHAT_MCP_OK` |
| `/api/chat` | `default` 模式权限卡 | 卡片带 `toolUseId` 弹出 → `/api/permission` 批准 → 命令执行 |
| 群聊引擎 | 1-participant 轮 | 转录里 `GROUP_PONG` |
| 群聊引擎 | bash 经 HTTP MCP | `GROUP_MCP_OK`，工具时间线正常持久化 |
| 群聊引擎 | session 持久化 | runtime.json 里有 claude session id |
| `claude-sessions.ts` | **对 SDK 差分测试** | 12 个会话：`summary` 12/12、`customTitle` 12/12、`firstPrompt` 11/12（那一个是测试期间正在被追加写入的活会话）；33 条消息**规范化后 100% 相同**（仅键插入顺序不同） |

### 差分测试挖出来的隐性契约（这些猜不出来）

1. **`summary` / `customTitle` 来自 `type: "ai-title"` 的行**（`{aiTitle, sessionId, type}`）。
   CLI 每轮追加一条、内容相同，所以**取最后一条**。没有它才退回首个 prompt。
2. **SDK 隐藏了两类 user 行**：`isMeta: true`（caveat / skill 前言 / 注入上下文），以及
   **斜杠命令回显**（正文以 `<command-message>` / `<command-name>` / `<local-command-*>` 开头）。
   不过滤的话历史里会出现一坨 XML，看起来像用户自己打的。
3. **`<task-notification>` / `<system-reminder>` 这类系统注入的 user 轮 SDK 是保留在历史里的**，
   但**不能**当成 `firstPrompt`（那会污染侧栏标签和搜索索引）。
4. 消息字段 `parentToolUseId` → `parent_tool_use_id`、`sessionId` → `session_id`（前端要 snake_case）。
5. **project 目录 slug = `cwd.replace(/[^A-Za-z0-9-]/g, "-")`**，对着磁盘上 706 个真实目录验过
   705 命中（唯一例外是目录名带额外后缀的会话，不是规则问题）。
   ⚠️ **有损、不可逆**（中文全变横线）——只能 cwd→slug 单向用；要真 cwd 就从文件里读。

### 一个既有 bug：先保留、再单独修（已修）

群聊的 bash MCP **从来没收到过 cwd**（`claude-runner.ts` 建 `createBashMcpServer({getSessionId})`
时就没传），所以 `mcp__bash__run` 一直在 server 的 cwd 里执行，而 Claude 自己的文件工具拿的是
`config.cwd`——agent 读一棵树、shell 进另一棵树，而且完全静默。

迁移时**故意原样保留**，因为在换驱动的同一个改动里顺手"修正"行为，会让任何回归都无法归因。
迁移验证通过后单独改掉（`registerMcpSessionContext` 加 `cwd: config.cwd`），并实测确认：
群聊里跑 `pwd` 现在报的是群的 cwd，不再是 cc-webui。

## 已接线（Codex 侧完成，2026-09-17）

`server/executors/codex-executor.ts`（+ 同名 `.test.ts`）。`server/codex-chat.ts`（网页单聊）和
`server/groups/codex-runner.ts`（群聊 / 飞书）都改为 `codexExecutor.exec()`。
**`@openai/codex-sdk` 和 `@anthropic-ai/claude-agent-sdk` 都已从 `package.json` 删除**
（`node_modules` 从 ~680MB 掉到 202MB——两个 SDK 各自带着一份完整 CLI 二进制）。

### 实测事实（真 CLI 0.144.1，别重新调研）

| 事 | 结果 |
|---|---|
| `--experimental-json` 在 0.144.1 上还在吗 | **在**，但 `codex exec --help` 里只列 `--json`（隐藏 flag，所以启动日志要打它） |
| 事件形状 | 和 SDK 时代逐字节相同：`thread.started` / `turn.started` / `item.started` / `item.completed` / `turn.completed` / `turn.failed` / `error`。**`processor.ts` 零改动** |
| 增量事件 | **没有**。一次回答就是一条 `item.completed`，没有 delta |
| prompt 走 stdin | 是。`codex exec` 和 `codex exec resume <id>` 在不给 positional prompt 时都读 stdin（stderr 会打一行 `Reading prompt from stdin...`，是噪声，要从 stderr tail 里滤掉） |
| 坏 thread id | **exit 1 + stdout 一帧 JSON 都没有**，原因只在 stderr：`Error: thread/resume: thread/resume failed: no rollout found for thread id … (code -32600)`。所以 Codex 侧的 `sessionNotFound` 必须查 stderr，不像 Claude 有 `result.errors` 可读 |
| 取消 | `AbortSignal` → SIGTERM，`status: "aborted"`（thread id 仍然拿得到） |
| MCP 往返 | `-c mcp_servers.bash.url=…` + `bearer_token_env_var` → `mcp__bash__run` 真的执行，前台事件正常 fan-out |
| resume 保上下文 | 保：上一轮记的数字下一轮答得出来 |

### 实现时的几个不显然的点

1. **`resume` 是 subcommand，不是 flag。** `codex exec [OPTIONS] resume <ID>` —— 所有选项必须排在
   `resume` **之前**（clap 允许父命令的选项出现在那里），`--image` 则排在之后（它绑到子命令）。
   SDK 就是这么拼的，生产跑了几个月。
2. **`-i/--image <FILE>...` 是变长的**，和 `buildClaudeArgs` 踩过的 `--disallowedTools` 同一个形状。
   现在安全只因为 prompt 走 stdin、后面没有任何 positional。**以后要加 positional prompt，必须排在
   它前面。**
3. **bearer token 只走环境变量**（`mcp_servers.<name>.bearer_token_env_var`），argv 里只有变量名。
   argv 是 `ps` 可见的，而一个 MCP token 等价于一个 shell（见 AGENTS.md 安全边界）。每个 server
   一个变量名，因为 `McpServerSpec` 允许 per-server token。
4. **迁移当时只能用 `"never"`；2026-10-09 已按 0.162.0 修正。** `codex exec` 仍没有
   网页手动审批控制通道，但现在 CLI 内部支持 `on-request` + `approvals_reviewer="auto_review"`。
   Auto 用原生自动审查，其他模式仍 never。不能只开 on-request、让 headless CLI 等用户。
   决策 #15 的「`default` 接上用户权限卡」仍**对 Codex 不成立**，见文末实测。
5. ⚠️ **`node_modules/.bin/codex` 会遮住真的 CLI。** `@openai/codex-sdk` 依赖 `@openai/codex`，后者
   在 `.bin` 里放了一个 `codex`；而 npm scripts 会把 `node_modules/.bin` 前置到 PATH。所以在
   `npm run dev` / `npm start` 下 `resolveCodexBin()` 解析到的是**它钉住的 0.142.5**，不是机器上的
   0.144.1 —— 正好抵消掉「版本跟随」这个迁移动机。删掉依赖之后这个影子就没了。
   （launchd 那条生产路径不经 npm，PATH 里 `~/.local/bin` 在前，本来就拿的是真 CLI。）
6. **图片的所有权在 executor**：落临时文件 + `-i` 传路径 + `finally` 里删目录。两个调用方各自那份
   temp-dir 记账都删掉了。顺带统一了两边不一致的处理：认识的图片类型但超限/不支持 → **失败**
   （原来群聊那侧是静默跳过，等于让模型对着一张它没收到的图回答）；非图片附件仍然跳过。

### 实测通过（真 CLI，隔离进程，绝不启动整个 server）

| 路径 | 场景 | 结果 |
|---|---|---|
| executor 直调 | 普通轮 / resume / 坏 handle / 取消 / 坏图片 | `completed` / 上下文延续 / `sessionNotFound+transient` / `aborted` / `failed` |
| `/api/codex/chat` | bash 经 HTTP MCP | `mcp__bash__run` 执行成功，回 `CODEX_MCP_OK`，`foreground_started/ended` 正常进 SSE |
| `/api/codex/chat` | resume | 第二轮答得出第一轮跑的命令 |
| `/api/codex/chat` | 坏 thread id | SSE 出 `error` 事件（不是挂住） |
| 群聊引擎 | 1-participant Codex 轮 | 转录里 `GROUP_MCP_OK`，工具时间线持久化 |
| 群聊引擎 | resume | `runtime.json` 里有 thread id，第二轮上下文延续 |

## 已落地：模型改用家族别名（决策 #9 的 Claude 半边）

`src/lib/settings.ts` 的 `CLAUDE_MODEL_OPTIONS` 从钉版本改成四个别名
**`opus` / `fable` / `sonnet` / `haiku`**，`DEFAULT_SETTINGS.model = "opus"`。
经真实服务端逐个实测：`opus`→**claude-opus-5**、`fable`→claude-fable-5、
`sonnet`→**claude-sonnet-5**、`haiku`→claude-haiku-4-5-20251001。

同时统一了另外三份注册表：`server/groups/config.ts` 的 `defaultParticipant`、
`server/feishu/handler.ts` 的 `MODEL_ALIASES`（改成对同一批 id 的透传，不再自己钉版本——
`/model haiku` 曾因此写进一个网页选择器匹配不上的 id）、`GroupConfigDialog` 的兜底值、
以及 `cli/subagent-mcp` 的 enum。

`CLAUDE_LEGACY_ALIAS` **方向反转**：以前是「别名 → 钉死 id」，现在是「旧钉死 id → 别名」。
方向很关键——原来的方向正是存量 `"sonnet"` 匹配不上任何选项、被静默改写成列表第一项的成因。

`XHIGH_CLAUDE_MODELS` 保持手维护（现在键是别名，不用再随版本编辑）。**CLI 完全不校验
`--effort`**（`haiku --effort xhigh` 甚至 `--effort bogustier` 都静默通过），所以它当不了裁判。

## 下一步（2026-09-17 的历史计划）

> **状态更新**：下面的模型目录计划已在 2026-09-29 落地，2026-10-07 又升级为真实 CLI
> model/list 查询，见文末对应日期；不能把这一节的「仍未做」当成当前 TODO。

全部完成。剩下的是**新工作**，不是迁移的尾巴：

1. **Codex 模型列表运行时化**（决策 #9 的 Codex 半边，仍未做）。现在还是硬编码，而 Codex 没有
   家族别名，所以它必然会再过期 —— 2026-09-17 那次就是五个里死了四个。要做的是一条服务端路由
   读 `~/.codex/models_cache.json` 的 `visibility: "list"` 项 + 回退到硬编码（那个文件是服务端
   拉的缓存，schema 是 Codex 内部的，调研时就坏过一次）。
2. **Codex 的审批**。见下面「明确没定的」。

## 明确没定的

- **`ended` 的新字段怎么灌回上层**：`orchestrator.ts` 和 `chat.ts` 现在按 `ok: boolean` 处理错误。
  `status` / `failureKind` 到位后要不要真的按 `aborted` / `timeout` 分开呈现（例如用户取消不显示
  成红色错误）。**两个 executor 都已经在产出这些字段了，只是上层还没用。**
- ~~**Codex 侧增量事件**~~ —— 已实测：`codex exec --experimental-json` **没有** delta 级事件，
  一次回答就是一条 `item.completed`（`item.started` 只在工具调用那类 item 上出现）。和 SDK 时代
  完全一样（SDK 跑的就是同一条命令），所以迁移没有带来任何流式粒度上的回退；要更细的粒度只能
  换 `codex app-server`。
- **Codex 的用户审批卡**：`codex exec` 没有网页审批控制通道（`-a/--ask-for-approval` 只长在 TUI 上，
  `--experimental-json` 的事件集里也没有审批请求），所以决策 #15 的「`default` 接上真实审批」
  这半条**对 Codex 不成立**，只对 Claude 落地了。要给 Codex 做权限卡，得评估
  `codex app-server`（另一套 JSON-RPC 协议）。**这不等于不能自动审查**：2026-10-09
  按 CLI 0.162.0 将 Auto 接到内部 reviewer，见文末；不新增用户卡/自建浏览器代理。

### 2026-09-29：ignored feature 设置不是 turn 失败

实测 Codex CLI 0.157.1 会将 user config 的 `features.child_agents_md` / `features.goal` 不认识提示输出成两条重复 `item.completed` + `item.type=error`，后续仍有正常的 `agent_message` 和 `turn.completed`。它读取的是服务端 OS 用户的 `~/.codex/config.toml`，不是网页 rebecca 账号的配置。

`shared/codex-notices.ts` 仅过滤这两个非安全 feature 的完整 ignored 提示，以及既有 model-mismatch advisory；未知 key、审批/沙箱配置警告、top-level error、turn.failed 都保留。网页 live / history、群聊使用同一判定，不修改原生 rollout 或用户全局配置。官方全局/项目配置层次见 [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)。

### 2026-09-29：Codex 反馈与动态模型目录已实施

- 保留 `codex exec --experimental-json`，不伪造 delta 或 reasoning token。工具前后无输出的阶段用运行态 activity 行显示旋转 sparkle、回合耗时与请求的真实 effort；工具 started → spinner / 可展开参数，completed → 输出 / 绿勾（isError 则红色）。历史 reasoning 摘要不自动冒充 live 思考。
- 2026-10-02 UI 语义修正：用户要求保留原思考动态文案。显式 pending reasoning item 用原 `Decoding` 等效果（空正文也不能丢掉这个阶段信号），工具/回答 started 则结束该阶段；只有阶段未知时用「处理中」。「回合已用」是累计耗时，不作为 reasoning 时长；不推断无工具执行就一定在思考。
- 单聊第一帧新增控制 `turn_meta { effort, startedAt, provider: "codex" }`，POST / attach 共享 buffer；不进原生历史内容。群聊共用 MessageList 的同款临时状态，未收到首个事件时也能显示。
- 决策 #9 的模型目录路径已完成：`server/codex-models.ts` 读受大小约束的 CLI 缓存，/api/meta 每次单独刷新模型（不受 slashCommands 60s 缓存影响）；浏览器初始化后再应用账号默认值。管理员 API 从同一目录校验 model + effort。
- 本机缓存（client_version 0.158.0）已列 GPT-6 Astra / Sol / Luna；CLI 实际二进制为 0.157.1，支持 ultra 配置解析。模型展示及 tiers 以缓存为准，未宣称逐模型/逐档位均已做真实请求验收；用户要求先发布自测。59 项测试及 typecheck/build 通过。

### 2026-10-07：旧 CLI 覆盖模型缓存，改为运行时 CLI 枚举

- 实测同一 `~/.codex/models_cache.json` 在本轮检查中先出现 GPT-6.1-Sol，随后被 client_version
  `0.158.0` 覆盖而消失；服务实际运行的 CLI 是 `0.160.1`。因此 9 月方案不是可靠的实时目录。
- 用同一 `resolveCodexBin()` 短暂运行 `codex app-server --listen stdio://`，只发 initialize / initialized /
  model/list，**不起 thread/turn，不改聊天 executor，不接审批或工具通道**。实测约 3 秒返回 GPT-6.1-Sol
  和 low/medium/high/xhigh/max/ultra；这只是模型目录与配置档位，不是逐模型推理成功验收。
- 协议依据：[官方 model/list 文档](https://learn.chatgpt.com/docs/app-server#list-models-modellist)。支持分页，
  过滤 hidden，8 秒总超时、2MiB 输出上限、200 模型上限；结束/失败终止进程，不回传 CLI 原始错误或账号字段。
- 服务缓存 60 秒并合流请求，强制刷新可绕过 TTL；新目录成功后，失败只标 stale，不能让旧共享文件把它降级。
  `CC_WEBUI_CODEX_MODELS_CACHE` 显式覆盖仍是离线/测试入口。独立 `/api/meta/models` 无需等 skills 扫描。
- 浏览器保留账号默认值与用户选择；模型菜单可以刷新。修正 max→xhigh / ultra→medium 的旧翻译，按目录保留档位。
- 回合状态恢复用户要求的动态词组（每 1.8 秒），但 elapsed 仍标「回合已用」；不伪造 reasoning 事件或独立思考耗时。

### 2026-10-08：整轮耗时与 reasoning 状态分离

- 当前 exec 接入没有可验证的单轮累计 reasoning 时长。原生 rollout 的 Reasoning
  完成记录可以证明发生过推理，但不能用相邻完成记录的间隔或「总耗时减工具时间」
  当作模型推理用时。
- 保留动态词与 sparkle；初版在阶段未知时写「处理中」，显式 pending reasoning 时写
  「思考中」。同日用户要求精简后，可见文案只保留 `Considering…` 等动态词，阶段语义
  留在 aria-label/title，不再加中文前缀。整轮计时移到独立灰色 `TurnStatus` 行，写「本轮总耗时」和「含工具与等待」，
  在工具/推理/回答阶段都持续显示，不冒充思考计时；effort 标明为「推理档位」。
- 总计时只使用 `turn_meta.startedAt`。未收到可靠起点（例如当前群聊路径）就不显示时间，
  不以组件挂载时间替代；刷新/attach 也不会把累计时间重置成零。Claude 的 token 活动行不改。

### 2026-10-08：仅在 cc-webui 禁用 PPT/PDF 插件

- 用户要求只关 `presentations@openai-primary-runtime` 与 `pdf@openai-primary-runtime`。
  executor 每次 spawn（含 resume）通过 `--config plugins.<id>.enabled=false` 覆盖，
  **不改 `~/.codex/config.toml`、不关整个 plugins feature、不影响原生 Codex/Claude**。
- 网页单聊与会话引擎的 Codex 每轮附带当前插件政策，防止 resume 时把此前读过的 skill
  正文当成仍启用的工作流。项目脚本/普通已装库可继续制作和检查 PPT/PDF；禁用并非
  删除缓存或文件访问沙箱。配置机制见 [官方插件开关](https://developers.openai.com/plugins/build/plugins#enable-or-disable-a-plugin-for-a-repo)。
- **CLI key 不带 TOML 表头的引号**。本机 0.161.0 仅用临时 app-server 的 config/read +
  skills/list 实测：带引号的形式仍列出启用的 PPT/PDF；无引号形式的有效配置为 false，
  两个 skill 不再出现，spreadsheets 等其它 skill 保留；普通 Codex 不带覆盖仍列出 PPT/PDF。
  全局 config 的 SHA-256 前后一致，验证未起 thread/turn。

### 2026-10-08：Codex 问题排查汇总与防回归

这轮用户反馈的现象均已对照原始 assistant 帧、工具读取记录或实际 CLI metadata
核查。下表集中保存原因与处理边界，不把产品能力缺失、模型输出错误和网页 UI 混为一谈。

| 现象 | 已确认的原因 | 已实施的处理 / 仍需遵守的边界 |
|---|---|---|
| 回复显示「下载」，点了却打不开 | 原始回复把 `成品/…docx` 等磁盘相对路径写成 Markdown href；浏览器将它解析为网站路径。创建/移动文件本身不提供下载 URL | 每轮注入 `server/web-output-rules.ts`：位置用行内 code 报告，不编站点/API URL、不冒充附件。**没有新增下载功能，也没有改写历史链接** |
| 中文正文露出 `**` | 原文如 `**how to do：如何做某事。**这里用…`；结束标记前的标点和后续中文使其不满足当前 CommonMark 强调边界 | 输出规范要求首尾标点在强调标记外，如 `**how to do**：如何做某事。这里用…`。测试使用真实 `Markdown.tsx` 验证正例；**没有更换解析器或正则修补源文本** |
| 项目记忆正文露出 `**落实：**逐题` 等星号 | 旧记忆内容包含同类中文粗体边界；不是没有挂 Markdown 渲染器，正常列表/链接等仍在渲染 | 仅记忆浏览启用 `memoryCompat`，在已解析的普通 text 节点上补 strong；跳过代码/链接/转义例子，不写回旧记忆、不改原生库，也不改变普通聊天解析。`server/memory-markdown.test.ts` 验证；新输出仍应遵守规范 |
| 最终回复露出 `:codex-followup[...]{prompt="..."}` | 这轮实际读取的 presentations skill 明确要求该语法（26.909.12148 版本，第 234 行）；cc-webui 没有这个宿主控件的渲染器 | 网页回复只能用普通 Markdown，有用的后续建议改为普通文字/列表。只适配最终回复，不改全局 skill，也不新增这种按钮 |
| 用户以为文档 skill 已全部禁用，PPT skill 却仍被使用 | 排查当时全局配置只关闭 `documents`；`presentations`、`pdf` 等是独立插件且仍开启，原始会话的技能目录确实列出了 presentations | 用户随后确认：**只在 cc-webui 的 Codex 子进程关闭 PPT/PDF**，不改全局开关，不影响原生 Codex/Claude；表格等未被要求关闭的插件保留 |
| 局部禁用的参数看起来正确，实际上仍能发现 PPT/PDF skill | CLI 0.161.0 实测：在逐级 key 中照搬 TOML 表头的引号没有关掉目标插件。只测 argv 拼接会漏掉这个问题 | `plugins.presentations@openai-primary-runtime.enabled=false` / `plugins.pdf@openai-primary-runtime.enabled=false` 随每次 spawn 传入；用真实 config/read + skills/list 核对有效配置和可用技能，不能只看单元测试或缓存目录 |
| 禁用后旧会话可能继续照过去读过的 skill 做事 | resume 保留历史内容；禁用发现不是清除历史或磁盘访问隔离 | `server/codex-plugin-policy.ts` 每轮说明旧 skill 指引不再适用，不手动加载被禁用 skill；已有项目脚本/普通库仍可用于制作和检查 PPT/PDF。不宣称缓存被删除或变成不可访问 |
| 刚发送时有图片，重新打开对话后只剩文字 | 0.161.0 的 `response_item` 用户消息含内嵌 `input_image`；`UserMessage` 事件只记 executor 随后删除的临时 `local_image` 路径。历史读取器只读文字，DB 的 CLI 输出也没有图片字节 | native 历史从同一 task 的用户 `response_item` 恢复内嵌图片并透传到气泡；新带图 turn 在既有 DB events 中保存 `turn_user` 作为兜底。支持多图/纯图片/重复问题，不改原生记录、不读任意本地图片路径或请求远程 URL，仍走会话读取授权；`codex-history.test.ts` / `codex-attach.test.ts` / `codex-turn.test.ts` 防回归 |
| `Whirring… (5m… · xhigh effort)` 让人以为连续推理了 5 分钟 | 动态词是运行反馈，原计时来自整轮 startedAt；包括模型等待、工具和生成。当前 **exec 接入**没有可靠的单轮累计 reasoning 用时，完成记录的间隔也不能当作推理时间 | Codex 可见活动文案按用户要求只保留动态词；阶段区别留在 aria-label/title，不能把未知阶段标成已确认思考；灰色 `TurnStatus` 独立显示「本轮总耗时 / 含工具与等待」，effort 标为配置档位。**Claude 的原思考行、token 活动计时和动画不改** |

**排查顺序**：先从实际服务日志或 DB 的会话 metadata 确认 provider 和 cwd，再查对应
原始存储。Codex 需要同时看 `~/.codex/sessions/` 的 rollout 与 DB 的
`codex_sessions` / `codex_turns`；只查 `~/.claude/projects/` 不足以判断「本机没有记录」。
取不到记录先核对来源，不能仅凭截图猜模型原文；不把整段真实对话、凭据或工具结果复制进仓库。

**回归入口**：`server/web-output-rules.test.ts` 验证规范中的渲染正例；
`server/project-memory-turn.test.ts` 用假 CLI 检查 memory 开/关、Plan 和 resume 都有规范与
局部插件覆盖，且 Claude 调用不受影响；`server/executors/codex-executor.test.ts` 钉住 key
和 resume 之前的参数位置；`src/lib/turn-activity.test.ts` / `server/turn-status.test.ts`
检查阶段信号与独立总计时。真实插件有效性另以只读 metadata 查询确认，**不启动模型 turn**。

图片历史回放另由 `server/codex-history.test.ts` 验证原生 inline 图片、临时路径不可依赖与
task 隔离；`server/codex-attach.test.ts` 验证带图 POST → attach → 完成后 DB 回放及陌生人
拒绝；`src/lib/codex-turn.test.ts` 验证多轮图片、纯图片和重放不重复。历史中已存在 inline
字节的旧消息可以直接恢复，不需重发；只有旧临时路径且已被清理的记录不能凭空恢复。

输出规范是对后续模型回复的约束，**不是确定性的渲染修复，也不是从此保证模型绝不写错**。
遇到复现应继续检查原始帧和实际收到的本轮规范，而不是悄悄降档、补不存在的接口或改旧历史。
相关圆角、固定开关、quiet 分隔条、左栏拖拽、记忆弹窗材质属于网页 UI，记录在
`docs/frontend-style.md` / `docs/file-manager.md`，不要归因于 Codex reasoning 或 CLI 协议。

### 2026-10-08：后续问题的排查与进度

- 管理页会话数误用 `resourceIdsOwnedBy(...).size`。只读现场比对 Rebecca：归属记录
  69 条（Claude 60 / Codex 9），原生文件或 Codex DB 实际存在 11 条（Claude 5 / Codex 6）；
  58 条无对应实体，不能断言都是「没删成功」，也可能是失效/换号的遗留。计划修统计
  口径，**尚未实施/发布，不为修计数删除权限归属或用户数据**。
- Codex `ApplyPatch` 的 input.changes 已含 `file/type/unified_diff/move_path`，但旧网页
  `StepDetails` 没接差异视图分支，退回通用 JSON。用户后续要求修复：现已接入
  `ApplyPatchDiff.tsx` / `patch-diff.ts` 并发布，逐文件显示旧/新行号、红绿差异和 +/− 统计。
  支持 native/exec 形状、移动、新建/删除；原始数据折叠保留，超 600 行先限量显示。
  CLI 缺 diff 时明确告知，失败时不声称应用成功；**不读取当前文件冒充历史修改**。
  Claude 原有 Edit/Write/NotebookEdit 渲染与 thinking 展示均未改。
- 首页「最近项目」加载慢：首屏短摘录 + Codex 跨重启元数据索引已实施/发布；见下方验证。
- 整个文件夹打包下载：用户此次明确要求，排在动效之后；尚未实施。用户早先的
  「不要增加下载」仅针对模型编造的聊天下载链接，不得把新文件树打包需求混作同一件事。

#### 首页性能探查（2026-10-08）

`HomeView` 首屏请求 `listSessions(60, undefined, provider)`，但 Codex 的 limit 在
`listNativeCodexSessions` **读取所有可见 native 元数据之后**才截取；扫描器逐行读到 EOF。
本机共有 Codex 324 份 / 1195.5 MiB、Claude 1144 份 / 950.1 MiB 的 jsonl。
`SessionSummaryCache` 已存在，但只要文件 size/mtime/ctime 改变，就会重新解析整个文件；
活跃大文件持续追加也会失效，因此不能说「有缓存就不可能慢」。

只读原生文件 + **隔离测试 DB**（仅复制会话 id/cwd/时间/长度，首问用占位字符串，不复制
凭据或真实消息）的存储函数剖析如下。它不是公网 HTTP/浏览器端到端耗时，也不含登录
模型目录的初始化；“冷”指本进程元数据缓存未命中，不指 OS 磁盘缓存冷启动。

| 场景 | 本机耗时 | 返回条数 | 原始 JSON 量级 |
|---|---:|---:|---:|
| Codex 管理员，首次 limit=60 | 2898 ms | 60 | 986 KiB |
| Codex 管理员，同进程热缓存 | 6 ms | 60 | 986 KiB |
| Codex Rebecca 可见范围，缓存已预热 | 4 ms | 6 | 11 KiB |
| Claude 管理员，首次 limit=60 | 177 ms | 60 | 4369 KiB |
| Claude 管理员，热缓存 | 21 ms | 60 | 4369 KiB |

修复前首页没有用已有 `compact=1`：首问全文对初始列表无用，却随 60 条全部传回。对同一批
rows 仅截断 firstPrompt 到 256 字符，Codex 由 986 KiB 降到 **24 KiB**，Claude 由
4369 KiB 降到 **51 KiB**。修复应区分首屏/搜索：首屏短摘录，搜索仍保留完整范围；
不能简单只读头尾而丢掉中间改名和后续 cwd 更新。授权仍每次重新算、先可见性再
limit，不缓存跨账号可见结果。

#### 首页修复与验收（2026-10-08）

- `HomeView` 初始 60 条用 `compact=1`，聚焦/输入搜索仍请求完整 `SEARCH_WINDOW=1000`，
  不复用短摘录。两种请求都有 AbortSignal/过期回包守卫；加载错误显示重试，不伪装成空列表。
- schema **11** 只新增可重建的 `native_session_summaries` 索引，不改写任何 CLI 文件、
  会话、归属或记忆正文。索引仅允许路径/id/cwd/标题/首问/时间等原始 metadata，
  不保存 mine/owner/shares/图片/工具内容。每个 parser namespace 最多 1024 条 / 32MiB，
  LRU 淘汰；文件消失清索引。parser 语义变化必须更新 namespace。
- Codex `SessionSummaryCache` 启用持久索引；每次请求仍枚举/stat，并按
  dev/inode/size/mtime/ctime 验证。**任何变化都重新完整扫描**，不假设文件只追加，
  因而重写/截断/换 inode 和中间标题/cwd 仍可靠。索引故障回退原生文件。
- `summary-jsonl.ts` 对有明确 CLI 头部的无关记录只保留 1024-byte header，后续字节
  直接流过，减少巨大工具/图片/reasoning 行的拼接/解码。相关记录完整读取，
  不熟悉的字段顺序回退全行；所有行的 timestamp 仍参与最后更新时间。
- 真实 native 文件 + 隔离 DB 的对比：旧冷元数据缓存 **2478ms**；新首次建索引
  **2213ms**、同进程热缓存 **7ms**；**新进程复用已建索引 71ms**。60 条样本首屏
  从约 983KiB 降至 24KiB；前后扫描版本的静态 summary 内容 hash 一致。
  这些是本机存储层数据，**不是公网端到端承诺**。首次索引仍须读完整日志，活跃文件
  变化仍会失效重扫；没有用限制搜索范围来掩盖慢请求。
- 类型检查、**87 项**完整脚本测试、隔离构建通过。Chrome 原生 UI 用合成 fixture
  检查逐文件红绿差异/双行号/统计、首屏 compact 请求、窗口外搜索的非 compact 请求；
  未调用模型或操作真实用户数据。正式服务 idle 校验后重启加载后端，
  本机/公网 HTML/JS/CSS 与已验证构建逐字节一致。
- rollback：`/tmp/cc-webui-edit-home-rollback.XjZo5k/`，含旧 dist 和私有一致性 SQLite
  快照。正式 schema 10→11、外键正常；用户2/归属90/Codex会话13/turn73/
  记忆scope9/条目178/版本206 的前后计数一致。旧代码可忽略新增索引表；
  不要为前端回滚恢复旧 DB 而丢弃发布后的用户写入。

#### 文件夹打包探查（2026-10-08）

前端 `FileExplorer` 在 pickedHasDir 时显式禁用下载；后端 `/api/files/download` 对
`!st.isFile()` 回 400「只能下载文件」。不是没有打包能力：已有多文件 `zipStream`，
中文名/相对目录/CRC/流式发送已由 `files-routes.test.ts` 与 `zip.test.ts` 验证。
目前是 Store 模式的 ZIP（打包、不重新压缩），无 ZIP64、无目录条目表示；新增整目录
不能只把按钮解除禁用。需要递归逐项授权、符号链接与越界处理、目录结构/空目录条目、
重复选择去重、文件数和整体包大小上限（不只单文件 <4GiB）。两项现有测试通过，
功能尚未实现/发布；没有建立匿名下载路由或让模型编造链接。

### 2026-10-09：cc-webui Codex 固定普通档位，不继承 Fast

用户明确要求线上 Codex **不是 Fast 模式**。现场仅提取相关配置/参数，未输出凭据：

- 全局 `~/.codex/config.toml` 为 `service_tier="fast"`；旧 executor 未覆盖该字段。
  metadata-only `config/read` 在 Rebecca cwd 确认有效值仍是 fast。线上 Codex 进程只有
  插件/effort 覆盖，没有 service_tier 覆盖；不能凭「argv 没有 --fast」说它没开 Fast。
- `buildConfigOverrides` 每次 spawn（新建与 exec resume、网页与会话引擎）固定
  `service_tier="default"` 与 `features.fast_mode=false`，保留 model/effort/沙箱/插件策略。
  **不修改全局 config、不改变原生 Codex 或 Claude**。只关 feature 并不等于改了请求档位。
- 官方配置定义见 [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)：
  service_tier 与 reasoning effort 是不同设置；Fast 选择映射请求中的 priority。
- 真实 CLI **0.161.0** 的 config/read 确认覆盖后的 `service_tier=default` /
  `features.fast_mode=false`；全局文件 SHA-256 前后一致，未启动真实模型轮次。
- 另用临时 CODEX_HOME + **localhost 假 Responses 服务**实测线路：此前 fast 发
  `service_tier=priority`，补丁新建会话与从 fast 历史 resume 均**省略 service_tier 字段**。
  CLI 的 default 是普通模式的内部表示，**不是在 HTTP 上发送字面 default**；不能把
  config/read 或 argv 测试写成「抓到了 HTTP service_tier=default」。没有调用真实模型。
- 当前 metadata-only account/read 确认为 **ChatGPT 登录**。若以后改成 API key，省略字段
  可能继承 API Project Service Tier；届时必须核对项目设置/实际返回档位，不能沿用这次
  ChatGPT 模式的结论去保证任意 API 项目。参见 [Responses service_tier](https://developers.openai.com/api/reference/resources/responses/methods/create)。
- 单测增加真实 spawn 假 CLI 的 fresh/resume 捕获，防止 executor 绕过参数构造；
  类型检查与 87 项完整回归通过。已经启动的轮次不能改档位，用户选择**等当前轮结束
  后重启**，不杀正在执行的模型/工具。后端重启验收完成前不能声称已在线生效。
- PR #2 已由用户在远端 rebase 合并；本机安全快进并切到 `main@ce44a6e`，同步时
  原功能分支文件树与远端完全一致，未临时检出旧版源码，原功能分支保留。
- 安全重启监测在当前轮及工具自然退出后才执行：正式服务 PID 10576→70653，
  启动日志确认 codex-cli 0.161.0，生产 HTTP 健康、前端未变。普通档位补丁已加载；
  已结束旧轮不追溯改档位。补丁/测试/文档尚未提交，不自动推送 main。

#### 同日：原生 Playwright MCP 被 never 审批策略拒绝

用户截图 `playwright.browser_navigate` 返回 `MCP tool call requires approval, but approval policy is never`。
这发生在 Codex 调用审批层，**尚未调用浏览器**，不能归因于网页网络或 file:// 支持。
全局 `mcp_servers.playwright` 已启用，但只有 command/args/startup_timeout_sec，
没有 `default_tools_approval_mode` 或逐工具策略。cc-webui 为 `codex exec` 固定
`approval_policy=never`（它没有逐工具审批控制通道）；`mcpConfigOverrides` 只对
应用显式装配的 bash/memory 等 server 配 approve，遗漏了从全局继承的 Playwright。
因此「never」不是自动允许，缺少显式许可的工具会被拒绝。

初始诊断时未修改 Playwright 权限。用户随后明确要**自动审查，不要用户审批，也不要一律
放行**；0.162.0 的方案见下节。不改全局 config、不无差别给所有原生 MCP 配 approve，
也不把 on-request 单独拿来假装已有可交互审批。file:// 支持、浏览器启动等仍是不同层
的验证，不能从这次权限报错断言它们正常。

### 2026-10-09：Codex Auto 接原生自动审查（0.162.0）

用户自行升级后，线上 PATH 优先解析的 `~/.local/bin/codex` 实测为 **0.162.0**。
之前“exec 的审批只能 never”的总结不够完整：**没有宿主手动审批通道**仍成立，
但新版 CLI 已支持内部 Auto-review（`exec --help` 有 `--approve-for-me`）。
官方 [Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) 说明它是 reviewer
替换而非权限授予；只审查本来就需要审批的请求，不检查沙箱里原本已允许的所有动作。

- `codexApprovalOverrides` 仅对 `mode="auto"` 成对设置 `approval_policy="on-request"`
  与 `approvals_reviewer="auto_review"`。CLI 处理 Playwright 等原生 MCP 的可审查调用，
  审查允许才执行；拒绝或审查失败不兜底 approve。不新增 cc-webui 用户审批卡。
- 不用 `--approve-for-me` 的 workspace-write 预设去覆写自定义沙箱；用等价的两个配置字段。
  Auto 的 sandbox 仍 workspace-write；Plan 仍 read-only + never，其他模式保留既有
  never 策略。**不能为修浏览器而扩大 Plan 写权限或使用 danger-full-access**。
- 明确按调用者的 Auto 选择启用；不会给全局 Playwright 配 `approve`，也不会凭空创建
  一个缺 command/url 的 Playwright server。继承的原生 MCP 仍遵循工具/管理策略；
  显式装配的 bash/memory 等 capability 网关保持原来的许可和逐次账号护栏，
  **不宣称这些自定义网关里的每条操作也会经过 CLI reviewer**。Claude 完全不改。
- `service_tier=default` / `features.fast_mode=false`、主模型/effort、插件局部禁用均保留。
  reviewer 使用 CLI 自己的 `codex-auto-review` 模型，会有额外用量/延迟；不是更换用户主模型。
- 单测覆盖 Auto/严格模式、fresh/resume 的真实 spawn argv、Plan 只读和非 Fast。
  `scripts/verify-codex-auto-review.py` 是**可选真实 CLI**集成验证：临时 CODEX_HOME、
  仅回环 Responses 假服务、假 stdio Playwright，无真实模型调用、用户数据或真实浏览器操作。
  它使用仓库实际 argv builder，而不是复制一份配置。
- 0.162.0 的模型工具定义可能位于 `input/additional_tools`，code-mode-only 模型要走
  `functions.exec` 的 custom_tool_call，不能硬发旧的 flat function_call；否则只是
  unsupported call，不能当作权限验证。审查结构输出必须有 `outcome: allow|deny`，
  不是 decision。实测 reviewer HTTP 请求没有 priority/fast/ultrafast，根 turn_context
  记录 on-request / auto_review；审批错误通过原有 MCP 失败工具行返回，不混入用户正文。
- 实测六场景通过：旧 never（0 review/0 调用）、旧会话 resume Auto（1/1）、新会话
  Auto（1/1）、reviewer deny（1/0）、malformed review（重试3次/0）、Plan（0/0）。
  reviewer 的结果是 fixture 给定的，**这是审批路由/失败关闭的验证，不是实际风险判断
  准确率或真实浏览器导航的验收**；MCP 也可能因 file:// 规则、启动失败等另行拒绝。
- 类型检查、87 项完整回归通过。确认正式服务只有空闲 Node/esbuild 子进程后上线，
  PID 70653→95009；日志确认 codex-cli 0.162.0、本机/公网 HTTP 正常，前端和 DB 未改。
  Auto-review 与非 Fast 补丁仍在工作区未提交，不自动推送 main；不追溯改变已经结束的轮次。

### 2026-10-10：网页单聊补齐两端原生实时插话（0.162.1）

用户反馈 Codex 输入只排到下一轮，并选择「Codex 网页改用原生 app-server；Claude 保留 stdin」。
并非给 `codex exec` 继续写 stdin：该命令不是双向控制通道。官方协议为
[Steer an active turn](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)，
本机 0.162.1 `generate-json-schema` 同时核对 `turn/steer`、`expectedTurnId` 与
`clientUserMessageId` 等线格式。早期文档关于 exec 不支持 delta/插话的事实仍成立，
但不再代表网页单聊的驱动。

- **范围最窄**：`codex-chat.ts` 使用新的 `executors/codex-app-server.ts`，每轮一个本地
  stdio 进程，initialize → thread/start 或 thread/resume → turn/start；不暴露监听端口，
  不跨账号共享线程或进程。会话引擎/飞书保留原 `codex-executor.ts`。
- Claude 使用既有 stream-json stdin，Codex 等待 `turn/steer` ACK；都把原始用户气泡
  排入同一事件队列，不能抢到已接收的原生工具帧前面。ACK 与 completed/cancel 竞争时
  先排完已确认输入，再发终止帧/保存。Claude 的最终耐久历史仍由原生 CLI 写入。
- `/api/{codex/}chat/steer` 校验 clientTurnId + sessionId 的**严格乐观锁**，不回退到
  同会话后来开的轮次；messageId 幂等，改 payload 用同 id 回 400。每次仍重查 provider、
  cwd 授权和项目记忆快照；只能原 turn actor 追加，不把阅读者的记忆或权限送给运行者。
- 每个连接单独发 `steer_target`（不写全局 buffer，不暴露 ownerId）：同账号别的标签页
  即使没有本地 ActiveTurn 也能获取当前目标；共享阅读者显示排队而非可插话。
  新轮次与自动 wakeup 没带 clientTurnId 时由服务端生成，不放松乐观锁。
- 前端串行发送、防双击、防跨会话迟到 ACK。启动未就绪等待 `steer_available` 后再试；
  确实结束才回退下一轮。未知网络结果回 503/暂停待核对，**不能当 409 自动重发**。
  切视图清本地队列，停止冻结待发送，图片暂保留下一轮；不强行杀掉正在执行的工具。
- `codex-app-events.ts` 将 camel-case item/公开摘要/text/output delta 转换为既有 UI
  事件。native turn/item ID 在插话气泡前后稳定，不能把未完成工具复制成第二行。
  buffer 存实际 text/output delta，避免长输出的累积前缀造成平方级占用；不读取 raw reasoning。
- 新驱动复用旧配置 builder：普通 service tier + fast_mode=false，Auto 的
  on-request/auto_review 成对，Plan 只读、其他模式 never，插件局部禁用、原生记忆关闭、
  HTTP bash/memory per-turn 网关全部保留。bearer 只进环境，不进 argv；不写全局 config。
  effective thread 配置与关键策略冲突即失败；意外宿主审批拒绝，未知 server request
  -32601，未知 config/security warning 保留为提示。不添加 schedule/local-* 给 Codex。
- `scripts/verify-codex-steering.py` 使用**实际新 executor + 本机 CLI**，临时 HOME/
  CODEX_HOME、只允许回环网络的 macOS sandbox、假 Responses 与合成 pause MCP。
  在工具尚未返回时 steer，下一次模型请求确实含 STEER_SENTINEL，仍为同一 native turn，
  输出 STEERED_OK。0 次真实模型调用，1 次合成工具调用；无 priority/fast 字段，全局
  config 哈希不变。这验证原生路由/驱动，不是实际模型执行质量的测量。
  加 `--inherited-review` 还验证从临时 config 继承的 prompt-policy MCP 确实先经过
  `codex-auto-review`，随后执行合成工具并接受同轮插话。测试先等 fixture 真收到
  tools/call：仅看到 item/started 可能还在审批，新插话可以原生取消待决审批，不能
  把那种「工具根本没执行」误记为正在执行工具期间的验证。
- 单测覆盖 ACK/拒绝/迟到 ACK、进程退出/超时/取消、resume/图片清理、事件顺序/稳定 ID、
  幂等/权限/跨标签页回放和前端串行/迟到结果。隔离浏览器 UI 验证工作中提交中文反馈后
  当前轮即时回显，不再遗留待发送；删除浏览器本地 ActiveTurn 后刷新仍能插话，
  3 个用户气泡各出现一次。类型检查与 96 项完整回归通过。
- **10 月 10 日验收时尚未部署**：构建使用 `/private/tmp/cc-webui-steering-build`，没有写生产 `dist/` 或
  重启线上服务，不影响截图里正在跑的旧轮。上线须等线上任务安全结束再更新前后端；
  已启动的旧 exec 轮次不能凭空切成 app-server。

#### 2026-10-11：用户确认上线，已安全部署

- 上线前确认生产进程只有 Node 父子、无 agent/工具子进程；本次启动日志中的网页轮次
  都已结束，没有待执行的内存 wakeup。再次类型检查与 96 项完整回归通过。
- 先构建到隔离 release 目录，再通过同文件系统 rename 切换 `dist/`，保留上一版前端
  于 `/private/tmp/cc-webui-steering-release-5j74g604/previous-dist`；未动数据库/会话/全局
  CLI 配置，也没有提交或推送源码。生产 launchd PID **95009 → 84439**。
- 启动日志确认 Claude **2.1.296** / Codex **0.162.1**，Codex 明确打印
  `web=app-server/stdio, engine=exec --experimental-json`；两个飞书 bot 正常连接，
  项目记忆仍启用。真实 CLI 的隔离 inherited-review 插话验证亦通过，未调用真实模型。
- 发布前公网已 502，本机正常；查到现有 app-sync FRP 在早间 DNS 故障后重连卡住，
  日志约 2 小时未推进。用户另行明确同意重启共享隧道后，仅 kickstart
  `com.xuqiang.app-sync`，PID **72015 → 84732**；不改配置、不动独立 visitor，
  不重启律枢/OnlyOffice 等应用。隧道重新登录并注册 cc-webui，公网恢复 **HTTP 200**。
- 本机与公网 HTML/主 JS/CSS 均与 release 一致；两端 steer 端点未登录仍 **401**。
  没有伪造管理员 cookie 或在生产创建模型轮次。旧浏览器标签页需要刷新才能用新前端。

### 2026-10-12：续聊 hydration 弃用提示修复与一次慢轮次诊断

- Codex 0.162.1 `thread/resume` 未设置 `excludeTurns` 时发出 Full-history hydration
  弃用提示。executor 并不消费返回的 `thread.turns`，显示历史仍由既有 session-store
  读取。因此仅在 resume 加 `excludeTurns: true`，不改 thread/start，不传自造 history，
  不删除/压缩用户会话，也不过滤未知警告来假装修好。
- 单测要求所有 resume 都携带该字段，假 CLI 缺字段才发警告，验证从源头不再触发。
  `scripts/verify-codex-steering.py --inherited-review --resume-check` 用实际 installed
  CLI + 实际 executor 验证：同一 thread 的续聊模型请求仍含初始输入和插话 sentinel，
  返回 RESUMED_CONTEXT_OK，且没有 hydration 警告。Auto-review/非 Fast/实时插话不变，
  临时 HOME 和 loopback fixture，无真实模型调用；类型检查与 96 项完整回归通过。
- 用户截图对应服务端 request **92480092**。只读核对 cc-webui DB、目标 native rollout
  的公开事件/用量以及 Codex `logs_2.sqlite` 的基础设施诊断，未读取 raw reasoning。
  warning 在 **0.27s**，thread.started 在 **0.83s**，turn.started 在 **0.87s**：
  历史 hydration 并没有占掉截图中的几分钟。
- 模型连接在 **08:56:33 UTC**（约第 90 秒）记录
  `websocket closed by server before response.completed`，CLI 自动重试 **1/5**，
  **215ms** 后重试，08:56:34 重新连接成功。不能仅凭这条日志区分 OpenAI 服务端
  与中间网络的具体责任，不能归因为用户浏览器 SSE 或已经证实的 Wi-Fi 故障。
- 该轮是 `gpt-6.1-sol` / **xhigh**，成功完成的两个采样请求输入分别 **166284 / 171659**
  tokens（绝大部分缓存命中），最终 turn_token_usage 的 reasoning_output_tokens 为
  **7907**。不能把中途 token_count 的旧 last_token_usage 再累加来虚增本轮用量。
  第一条可见正文 delta 约 **574.6s**，整轮 **649.22s（10 分 49 秒）** 完成。
  唯一工具调用 exec → bash.run 总时长约 **1896ms**，不是工具/文档渲染卡了数分钟。
  主要等待处在模型推理阶段，另有一次上游断流重试；大上下文与 xhigh 是延迟风险，
  不能把长上下文缓存命中请求的全部耗时都单独归因于历史体积。
- 展示侧另有可观察性缺口：executor 对 `error.willRetry=true` 当前不发 UI 帧；
  该轮 reasoning 的公开 summary 为空，界面只能显示活动词。故“长推理/上游重连”看起来
  像静止，但原生事件持续产生，最终成功。后续若补重连状态，必须使用真实原生信息，
  不伪造重试次数/等待时间，不暴露 raw reasoning；本次未顺手更换模型、降低档位、开 Fast。
- 生产当时还有另一轮 Codex 活跃，用户确认仅在全部轮次/工具自然结束后加载修复。
  `/private/tmp/cc-hydration-safe-restart.py` 为单次、有期限的 idle guard；不改前端构建、
  数据库或隧道配置，若持续忙或验证后的源码变化则不重启。该轮自然完成后，guard
  连续确认空闲再重启，PID **84439 → 62471**；本机/公网均 **HTTP 200**，前端 index
  哈希前后一致，Claude 2.1.296 / Codex 0.162.1。修复已加载，不追溯删除旧轮的 warning。

#### 同日：补上原生重连 / 重试提示

- `error.willRetry=true` 不再丢弃。`server/executors/codex-retry.ts` 跟踪当前 native turn，
  仅转发公开 message/additionalDetails 和可用 HTTP 状态为 `codex_retry` 控制帧。
  CLI 原生消息含 `Reconnecting... 1/5` 时原样显示；协议没给结构化次数/等待时间，
  就不自行推测或套 Claude 的 0/0、0 秒重试文案。其他不可重试错误保持原失败路径。
- 同一 turn 新模型 item、公开 summary 或回答 delta 表明重新收到响应时清提示；
  旧 partial item 完成、用户插话 echo、工具 stdout 和控制/RPC 消息都不算恢复。
  end/abort/failure 清状态；服务端总会记录 model_retry 的阶段与实际 elapsed。
- `shared/codex-retry.ts` 是纯状态协议，前端使用现有 retry 槽位和新的 CodexRetryHint，
  原因用 React 纯文本转义、长详情可展开。重试时暂停 Codex 思考动画，但 pending row
  保持挂载；原生工具继续执行时不假装停掉工具时钟。Claude RetryHint 和思考完全不改。
- refresh/attach 回放同一控制帧，跨会话/轮次迟到的 recovery 不会清新轮提示；done/
  error/no-inflight 清活动状态。控制帧不写成助手聊天气泡，历史重开不显示“正在重试”。
- 新增 tracker、前端状态和 SSR 渲染测试，覆盖原生原因/HTTP、没有假计数/倒计时、
  转义、旧帧不算恢复、取消/最终失败、attach/授权/历史、Claude 兼容和 pending row
  不卸载。类型检查、**99 项完整回归**、隔离 Vite 构建通过。
- `verify-codex-steering.py --retry-check --resume-check --inherited-review` 主动截断一次
  localhost SSE response；真实 CLI 0.162.1 自己发原生 error/自动重试，driver 输出
  retrying → resumed，随后工具/同轮插话、旧上下文恢复均通过。0 次真实模型调用、
  1 次合成工具调用；全局 config 哈希不变，没有碰模型/effort/Fast/审批策略。
- 隔离浏览器确认：重试时显示原生 `Reconnecting... 1/5` 和可展开原因，刷新且删除
  本地 ActiveTurn 后仍显示，收到模型新响应后消失，整轮结束无过期提示或假错误气泡。
  构建验收使用 `/private/tmp/cc-webui-retry-build`。
- 空闲 guard 连续核对无运行轮次/工具/待执行 wakeup 后，通过同文件系统 rename 发布
  前端并重启后端，PID **62471 → 69904**；本机与公网 **HTTP 200**，公网主 JS/CSS
  与 release 一致，steer 未登录仍 401。Claude 2.1.296 / Codex 0.162.1，不动数据库、
  全局 config、共享 FRP 或模型配置，未在生产创建验证用模型轮次。上一版前端保留于
  `/private/tmp/cc-webui-retry-release-wzbn16tz/previous-dist`，旧标签页需刷新。
