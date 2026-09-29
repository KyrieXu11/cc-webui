# 项目记忆 / Memory MCP — v1 最终设计方案

> 2026-09-29。**v1 已实施并发布到本机正式服务，生产已启用；其它部署默认不开启**。采用独立 Memory MCP，不让 CLI 原生文件写入成为第二条写入路径。
> 日常界面仅展示统一项目记忆；旧 `/api/memory` 仍严格 GET-only，供兼容与显式迁移。

## 1. 目标和边界

让有权打开同一项目的账号，换会话或从 Claude 切到 Codex 后，仍能使用已保存的长期记忆。

固定边界：

- namespace = **规范化的会话 cwd**（2026-09-29 用户确认不按账号隔离），不是 session ID，不含 provider。
- 项目沿用 CONTEXT.md 的定义：作为会话 cwd 打开的文件夹，不强制归并到 Git 根目录。
- 路径通过现有 `assertCanOpen` / `normalizePath` 规范化，`/tmp` 与 `/private/tmp` 等别名不产生两份记忆。
- 有权打开同一项目的账号共用一份库；调用者 actor 仍必须通过当前目录白名单和 provider 授权。会话 reader 续聊按会话 cwd 使用项目库；会话分享不自动增加目录白名单。
- 跨项目不能使用记忆 ID 读取另一项目；知道 ID、拥有别处的会话或登录管理员身份都不代替当前项目的目录访问授权。
- v1 只接网页单聊 Claude / Codex。群聊、飞书不给 memory capability，不能凭它们恰好有管理员 actor 就放行。
- v1 无向量库、embedding、额外 selector 模型、逐 turn 后台摘要、团队共享或用户全局记忆。
- MCP 是**受管理功能的唯一写入口**。项目现有 shell/白名单是护栏，不是 OS 隔离；不声称能阻止同 OS 账号的外部程序手工改存储。

## 2. 来自 Claude Code 的已核实事实

本机 Claude Code **2.1.283**，二进制 SHA-256：
`d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`。

从 Mach-O 的 Bun 数据中提取了 2153 个内嵌 JS 模块，并用临时 HOME、虚拟凭据和本地假 Anthropic API 捕获新会话 / resume 的请求，没有调用线上模型。

核实结果：

1. 行为规则在 system prompt；MEMORY.md 索引另放进 user-role 提醒上下文。
2. 普通模式只注入索引，不自动注入所有正文；模型判断相关性后用 Read 读详情。
3. 新 CLI 进程 resume 会重读索引。有更新时，提醒声明新副本替换旧副本，历史里的旧副本并未被物理删除。
4. 普通索引截到 200 行 / 25000 个 JS 字符串长度单位。代码名为 byteCount，但实际用 `.length`，不是 UTF-8 byte count。
5. Sonnet 4.6 捕获的是约 12.8k 字符完整提示，Opus 5.5 是约 2.1k 字符精简提示；不是所有模型一个固定原生 prompt。
6. 自动正文预取还有 BM25 / selector 模型分支，受灰度开关控制；分析时本机缓存中的相关开关关闭。v1 不假定这条路径已经普遍启用。

采用：记忆类型、保存质量标准、索引与正文分离、按需召回、查重和更新、核实旧事实。
替换：原生文件工具写入、模型手工维护 MEMORY.md、provider 专属目录。

本次解包及捕获原件暂存在 `/private/tmp/cc-webui-claude-memory-2.1.283/`，该目录是临时研究材料，不是产品运行依赖。

## 3. 架构

```text
网页发起 turn
  └─ 账号 + 已授权 cwd → ProjectMemoryScope
       ├─ store → 有界的索引快照
       ├─ 固定 Memory Prompt v1 + 动态索引 → CLI
       └─ per-turn token → /api/mcp/memory
                              ├─ list / search / read
                              └─ save / delete
                                   └─ store：校验、并发、文件、DB、更新通知

Claude 和 Codex 共用以上 store / prompt 规则；provider 只存在于来源元数据里。
```

关闭 cc-webui 进程后，记忆仍保留；HTTP attach 重放不重新召回、不重复保存。

## 4. 存储与唯一真相

遵守现有规则：**DB 存索引与关系，文件存正文**。

```text
~/.cc-webui/
├── cc-webui.db
└── project-memory/
    └── <actorId>/
        └── <sha256(canonicalCwd)>/
            └── <memoryId>/
                ├── <version-file-id>.md
                └── ...
```

- `memoryId` / `version-file-id` 是服务端 UUID；工具不接受文件名、绝对路径或相对路径。
- 正文版本不可变。每个版本是一个完整 Markdown 文件；文件 frontmatter 由服务端生成。
- DB 的 active revision 指针决定什么能被读取或召回；孤立文件不是有效记忆。
- 不让模型写真实 MEMORY.md。**MEMORY.md 风格的索引是 DB 生成的只读投影，不是第二份 canonical。**
- 不将文件存储目录告诉模型，也不给 Codex 增加该目录的 --add-dir。
- 正文根有 `.cc-webui-project-memory` 标记，拒绝把非空的未知目录当作库；恢复只清扫 UUID/hash/UUID/UUID.md 形状的孤立版本，不能清扫任意 Markdown。
- 新增 `CC_WEBUI_PROJECT_MEMORY_DIR` 用于部署与测试覆盖。测试必须同时隔离 CC_WEBUI_DB 与此目录；涉及建账号时还要隔离工作区。

DB 增量迁移增加：

- `project_memory_scopes`：canonical cwd、project key、scope revision，不关联账号生命周期。
- `project_memories`：ID、scope、name、description、type、当前 revision、当前正文版本指针。
- `project_memory_revisions`：版本、parent revision、文件相对定位、正文 hash、来源 provider/session、提交时间。正文不放这里。
- `project_memory_operations`：actor ID、operation ID、请求 hash、结果元数据，供写操作幂等。**不存正文、token 或完整工具输入。**

唯一约束 `(scope, name)` 防止同名重复；CAS 版本约束防止覆盖他人刚写的更新。

## 5. MCP 接口

server name：`memory`；HTTP endpoint：`/api/mcp/memory`。

| 工具 | 输入 | 输出与行为 |
|---|---|---|
| `list` | cursor?、limit?（默认 50，上限 100） | 当前 scope 的分页条目、scope revision、总数；不返回正文 |
| `search` | query、limit?（默认 10，上限 20） | 在**完整 scope**的 name / description 中搜索，返回条目和命中信息 |
| `read` | id | 当前有效正文、完整元数据与 revision；不存在或已删除明确失败 |
| `save` | operation_id、name、description、type、body；更新时加 id + expected_revision | 新建或更新；成功后返回 id、revision、scope revision，不让模型再维护索引 |
| `delete` | operation_id、id、expected_revision | 删除指定记忆、所有正文版本；不提供通配符或批量 clear 工具 |

这里的 `memory.save` 是概念名；实际 CLI 工具通常为 `mcp__memory__save` 等，由工具装配适配层验证，不把不存在的工具名塞进提示。

### 一条记忆

- `name`：scope 内唯一、稳定的小写 kebab-case slug。
- `description`：具体的一行相关性提示，不是模糊的“项目情况”。
- `type`：user / feedback / project / reference。
- `body`：Markdown，一条聚焦一个长期事实、偏好或规则；feedback / project 建议包含 Why 与 How to apply。
- `revision`、provider、session、actor、timestamps：服务端确定，agent 不能伪造来源。

写入建议每条不超过约 4 KiB，硬上限 32 KiB（包括服务端生成的 frontmatter）；超限拒绝，**不静默截断保存**。

### 搜索范围

v1 使用字面匹配和明确的排序，支持中文子串，不声称是语义搜索；query 长度有上限，SQL 用绑定参数并转义 LIKE 通配字符。
不在每次搜索时悄悄扫描全部正文。模型可换关键词、分页 list 后 read。

这是与原生“文件名＋description 帮助判断相关性”一致的轻量召回；BM25 或更强检索是后续独立版本，不是 v1 隐含承诺。

## 6. 统一 Prompt v1

**两 provider 使用同一份业务规则模板**，以提取出的 Opus 精简版本为骨架，补入 Sonnet 明确的“何时召回”和“何时保存”条件。
不是分别维护两段 prompt；也不是把旧的 Write / MEMORY.md 保存指令原封不动复制给 MCP。

保留的规则：

1. 记忆类型为 user、feedback、project、reference。
2. 用户明确要求记住，且符合长期记忆标准时，在同一 turn 调用 save；用户明确要求忘记时找到目标再 delete。
3. 遇到相关任务、用户提及过去工作或明确要求回忆时，通过 read/search 读取相关记录。
4. 保存前先查重；更新已有条目胜过新建重复条目。
5. 不保存代码/Git/项目文档已经能提供的内容、临时执行进度或未核实推测。
6. 不保存密码、凭据、API key；显然的密钥模式可拒绝，但不把它宣传成完整 DLP。
7. 记忆是旧背景数据，不拥有高于当前用户指示和系统规则的优先级。引用文件/函数/flag 前核实是否仍存在。
8. 用户说不使用记忆时，不据其作答或调用召回工具；若需要技术上完全不注入，后续可加独立的本轮开关，不能拿自然语言指令当物理擦除。

替换的规则：

- 所有读写只用 memory MCP；不得使用 Write/Edit/shell 修改新记忆库或原生目录。
- save 一次完成正文保存和索引更新，不再有“先写文件、再手工改索引”两次模型工具调用。
- 更新带 expected_revision；冲突必须重新 read 后重新决策，不准覆盖或无限重试。
- 不把旧 turn 的 read 结果当作永久有效缓存：本轮要据其作答时重新 read 确认仍有效；已删除/不存在的记录不得继续作为记忆使用。
- 相同逻辑写入的网络重试复用 operation_id；改了内容或版本则用新的 operation_id。
- 工具未成功前不得回答“已经记住/忘记”。权限拒绝、只读、存储失败需要如实说明。

模板固定版本 `project-memory-v1`，保存 prompt fixture。路径、可用工具名、只读状态和索引快照是参数，业务规则不是每个模型临时发挥。

## 7. 注入与召回的精确时机

### 固定规则与动态数据分开

- Claude：固定规则用既有 appendSystemPrompt 加入，不替换整个系统提示。
- Codex：与现有 CODEX_RUNTIME_PROMPT 统一装配，加入相同业务规则。
- 动态索引作为有边界、版本化的背景段放进**同一轮请求**，不另外往 Claude stdin 发送一条会被当作额外 turn 的 user message。
- 使用 provider-neutral runtime envelope，将“背景”和“用户原文”分开；历史读取与标题/UI 映射要认这个 envelope，只展示原文。不回写或清洗 CLI 原生 jsonl。
- 索引用结构化/转义格式，不能由记忆正文中的关闭标签或伪造指令打破边界；正文仅经 read 工具返回，不拼入高权限指令模板。

这是在现有两 CLI 接口下可控的注入适配，不声称两者拥有完全相同的消息角色或推理效果。须用假 CLI / 假 API 测实际请求。

### 哪些时机刷新

| 时机 | 行为 |
|---|---|
| 新会话 | 在 spawn 前加载当前索引 |
| native resume / 换 provider / 下一普通 turn | 重新加载索引；注明当前快照替换以前的记忆快照 |
| Claude 同轮 steer | 没有重新 spawn；在原有那一条 steer 消息中附上新快照，不单独排一个“记忆消息” |
| HTTP attach / SSE 重放 | 只重放，不重复读写或启动 agent |
| 同一 turn 内 save 后 | 工具返回当前 scope revision；模型已知道自己刚保存的内容，不必重复全量注入 |
| 另一会话并发更新 | MCP read/list/search 总是当前数据；静态快照到下个 turn/steer 更新，不承诺毫秒级自动推入正在跑的上下文 |

索引投影按稳定规则（更新时间降序、ID 打破同值）生成，**最多 200 行且最多 25000 个 JS 字符串长度单位**，只在完整条目边界截断。
快照含 scope revision、总数、已显示数和 truncated；未展示条目仍可由 search / list 访问。

v1 不自动注入 top-5 正文，也不额外起模型召回。模型根据索引与问题按需用工具；这是复现已核实的普通模式，而不是依赖灰度功能。

## 8. 单一写入路径与原生记忆禁用

新功能开启时，只对 cc-webui 起的 CLI 做 per-process 覆盖：

- Claude：`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`，不把共享路径设成 autoMemoryDirectory。
- Codex：关闭本次调用的 `features.memories`；如有必要，同步覆盖 `memories.use_memories=false` / `generate_memories=false`。本机 0.157.1 features list 已确认 `memories` 存在，注入/生成确实关闭仍是实施期的集成验收项。[官方配置](https://learn.chatgpt.com/docs/config-file/config-reference)
- 不编辑用户全局配置，不影响终端里独立使用 CLI；不删除旧原生目录。
- 开关关闭时不装配 memory MCP、不注入新 prompt、也不禁用 CLI 原生记忆。
- 开启前须确认两个驱动的原生记忆禁用适配可用；不允许失败后静默留下两套正在工作的记忆规则。

入口开关建议 `CC_WEBUI_PROJECT_MEMORY_ENABLED`（默认关闭，导入与验收后启用）。该开关管 runtime 接入，登录后的只读浏览/显式导入仍可用于启用前的准备，面板明确标示当前未启用。开启后该运行态只使用新库。已有会话里的历史原生记忆不会被擦除，prompt 明确新库为当前受管理来源。

## 9. 权限与安全

- per-turn context 显式携带 `projectMemory` capability；仅网页单聊装配时创建，缺失即 403。
- capability 绑定 actor、canonical cwd、scope、read/write 状态。不接收工具调用方给的账号或项目。
- 每次工具调用复查账号仍存在、cwd 仍在其白名单；不能只信启动时的一次授权。
- 缺少身份、无效 token、过期 token、外 scope memory ID 均拒绝。memory ID 猜到了也不授予访问。
- **Plan 模式只读**；服务端拒绝 save/delete，不能只靠 CLI 说自己是 read-only。
- 其它模式，新记忆功能启用即授权该账号当前 scope 的受限记忆读写。为保留原生“要求记住便保存”的体验，这五个固定 memory 工具不额外弹通用文件权限卡；这是明确的新例外，要写入 README，不能变成所有 MCP / 文件工具自动放行。
- 自动放行不代替上述服务端 scope 校验。不要按 `mcp__*` 前缀放行；仅明确工具名及有效 capability。
- memory.save 的正文不得进入服务端诊断日志。现有 chat.ts 打印 tool input 的位置需对 memory 工具脱敏，截断 200 字符不算脱敏。
- 目录/正文采用私有文件权限；读取按 DB 版本指针并校验 hash，外部篡改明确报 memory_corrupt，不悄悄让 DB 索引和正文分叉。
- 删除账号后它的 token / scope capability 不可再使用，**项目正文与索引保留**，其它有项目访问权的账号仍能召回；不得级联删除项目库或以旧 actor 目录名推断归属。

## 10. 并发、幂等与错误恢复

### save 提交流程

1. 身份、scope、输入、当前版本和 operation_id 校验。
2. 在 scope 内序列化文件阶段；新建 UUID 版本文件，写临时文件、fsync、原子 rename。
3. DB transaction 中用 expected_revision 做 CAS，写版本关系和新指针，递增 scope revision，记录幂等结果。
4. transaction commit 后返回成功、发更新通知。

DB CAS / 唯一约束是最终裁决，不是“先 SELECT、以后随意 UPDATE”。
两次并发从 revision 3 更新，只有一个成功；另一个拿到 `revision_conflict` 和当前 revision，必须重读。

- 文件成功、DB 未提交的版本是孤立文件，不可被召回；失败时清理，崩溃遗留由启动清扫回收。
- DB 不得先指向还未落盘的文件。
- 同一 operation_id + 同一请求 hash 返回之前的结果；同 ID 不同 payload 为 idempotency_conflict。
- 只回传稳定的结果元数据，不因重试重复递增版本、制造副本或重复通知。

### delete

CAS 先把条目移出可见索引并保存不含正文的 tombstone/幂等结果；在 scope 序列化边界内清除所有正文版本。
只有物理清理完成才能回答完全删除。清理失败明确返回已停止召回但清理未完成，重试同 operation_id 继续清理，不能伪报成功。
不做隐藏的永久正文软删除库。

**忘记不等于擦除已有聊天历史**：已经进入旧会话/工具结果的内容仍可能在 transcript 中。提示要求不再使用已删除记忆；用户要求不带旧上下文时需要新建会话。

### 错误契约

工具业务失败返回 `isError: true` + 稳定 code + 可操作的短解释，例如：
`scope_unavailable`、`read_only`、`not_found`、`name_conflict`、`revision_conflict`、`idempotency_conflict`、`content_too_large`、`memory_corrupt`、`storage_unavailable`、`delete_cleanup_pending`。
401/403 是入口授权失败；不把正常冲突伪装成写成功。

索引为空是正常。索引加载失败不是为空：MCP 如仍可用，提示模型用 list 获取；存储整体不可用时显式提示，不能假装记忆功能有效。

## 11. 原生记忆导入与界面

导入是用户明确触发的独立管理操作，不是每个 turn 自动同步：

1. 从现有只读入口能展示的 Claude 记忆枚举来源。
2. 使用明确的账号 / cwd 迁移清单枚举来源；不扫描整个 HOME，也不接受任意 source path。
3. 校验格式，按来源标识 + 内容 hash 幂等导入新库。
4. 同名不同内容在迁移报告中明确报冲突，不静默覆盖。
5. 不修改原文件，不做双向同步，不自动导入 Codex 全局库的所有内容。

用户可以不开导入，新库从空开始。

界面沿用现有 MemoryDialog 的入口，**仅展示统一项目记忆**（2026-09-29 用户确认）。有权打开项目的账号、Claude / Codex 共用一份库；访问边界是项目，不是账号。正文与索引只读；不再显示 Claude 原生标签或前端导入按钮。

旧 `/api/memory` 仍为 GET-only 兼容入口及迁移来源，不给它增加写方法。新增 `/api/project-memory` 只读入口与独立导入接口。
显式批量迁移使用 `npx tsx scripts/import-project-memory.ts --apply --manifest /absolute/plan.json --report /absolute/report.json`。清单形状为 `{"projects":[{"username":"rebecca","cwd":"/absolute/project"}]}`，必须明确执行导入的账号以复查目录访问权，但保存到项目共用 scope；报告不含正文。没有项目目录的旧记忆保留原文件、待原目录恢复后再导入，不擅自并入其它项目。

MCP 调用自然进入已有工具时间线。可用 `memory_updated` 控制事件刷新已打开面板，但不把空渲染事件塞进 MessageList blocks 而切断时间线。

## 12. 文件职责与实施顺序

| 文件 | 职责 |
|---|---|
| `server/project-memory/scope.ts`（新） | 身份、cwd、namespace 和 capability |
| `server/project-memory/store.ts`（新） | 索引、正文版本、CAS、幂等、删除、恢复 |
| `server/project-memory/prompt.ts`（新） | 唯一规则模板、索引投影、长度限制 |
| `server/project-memory/import.ts`（新） | 只读来源枚举、幂等导入 |
| `shared/project-memory-envelope.ts`（新） | runtime 背景与用户原文的编码/解码契约 |
| `server/mcp-memory-route.ts`（新） | MCP schema、token、工具授权、错误映射 |
| `server/project-memory-routes.ts`（新） | 登录用户只读浏览与显式导入 |
| `server/mcp-http.ts`（新） | 从当前 MCP 路由提取 transport 生命周期 helper，关闭/取消时释放，避免复制协议代码 |
| `server/db.ts` | 增量 migrations；不改旧 migration |
| `server/mcp-context.ts` / `codex-mcp-config.ts` | capability、memory endpoint URL |
| `server/chat.ts` / `codex-chat.ts` | scope、快照、提示与原生关闭适配；steer；日志脱敏 |
| `server/executors/*` | 必要的 provider-neutral runtime 覆盖适配，不重写协议驱动 |
| `server/app.ts` / `auth/policy.ts` / `features.ts` / `meta.ts` | 新接口分类、开关和状态下发 |
| `server/claude-sessions.ts` 与前端消息/标题处理 | 不展示 runtime envelope；不改原生 jsonl |
| `MemoryDialog.tsx` / memory client | 新来源、来源标识、只读展示 |
| README / AGENTS / 模式提示文案 | 开关、明确的 memory 权限例外、存储与使用说明；不能继续让文案暗示 memory 工具也必弹卡 |

顺序：

1. 存储与 scope，先测身份、路径、并发、幂等和崩溃恢复。
2. MCP route，用真实 JSON-RPC/MCP 请求测协议与越权。
3. 两个 turn 接入、统一 prompt、原生记忆禁用，用 fake CLI / 假 API 捕获验证。
4. envelope 的历史与标题过滤、steer 和 attach 回归。
5. 只读 UI 与导入，最后补文档、启用开关。

记忆能力不扩到群聊/飞书、不增加第三个搜索面、不修改原生记忆写接口。另按 2026-09-28 的后续要求，管理员可明确授予成员 Codex 使用权限并选择默认 AI / 模型 / effort，见 user-permissions.md 新决策。

## 13. 验收标准

采用仓库现有 top-level await + node:assert 测试风格；不为 DOM 测试塞进纯逻辑测试路径。

- Claude 保存 → 新 Claude 会话可读 → 新 Codex 会话可读；反向也成立。
- 另一项目或无目录白名单的人无法用 ID 访问原 scope；同项目的两个有权限账号读写同一条记忆；撤销路径 / 删除账号后旧 capability 拒绝。
- 普通目录 / 符号链接别名得到相同 scope；cwd 超白名单、账号删除、过期 token 均拒绝。
- 新会话 / resume / steer 有当前快照；attach 不重复创建 turn 或写记忆。
- 系统规则固定；普通索引只含 metadata，正文只有 read 才给；截断明确且 search/list 覆盖全库。
- 原生 auto memory 在 WebUI 启用新功能时确实不注入、不生成；功能关闭时不影响原生。
- 两 provider 使用同一业务规则模板，工具名称真实可用；不保留“用 Write 写记忆目录”的矛盾指令。
- 同名创建和同版本并发更新只有一个赢家；retry 不重复写、operation_id 误用拒绝。
- 文件落盘 / DB commit 间故障不产生可见半成品，损坏 hash 报错；delete 失败不伪报成功。
- 原生目录、全局 CLI 配置、原生 jsonl 只读；导入幂等且不会静默覆盖。
- save/delete 只在非 Plan 且有 capability 时允许；所有工具不收 caller 指定的 namespace。
- 日志无记忆正文/token；UI 不暴露 runtime envelope，也不切断工具时间线。
- 实施后 `npm run typecheck` 与测试通过；测试不启动真实 bot、不动真实 DB / workspace / memory。

**验收不把模型行为确定性与协议保证混为一谈**：服务端能保证写入成功与持久化、scope 和版本；是否主动选择正确记忆仍受模型影响，需要少量真实模型行为测试，不能只靠 fake API 宣称召回效果达标。


## 实施验证与上线

- 新增 store / MCP / 导入 / CLI 注入 / provider 授权与 envelope 测试，使用临时 DB、记忆目录和假 CLI，不消耗真实模型额度。
- 校验两个 CLI 都装配 memory，只有索引进入 prompt；同一份业务规则、CLI 原生记忆关闭、功能关闭后恢复旧行为。
- 索引超过显示预算仍可搜索/分页；真实版本冲突只有一个赢家；重试不重复写；正文损坏拒读；清理失败可重试；进程恢复只清理本库的版本文件。
- 浏览器 QA 使用 `127.0.0.1:9898` 的独立临时数据库与禁用的 CLI，确认管理员设置、成员 Codex 默认值、只读记忆面板和项目共用。
- 正式服务真实 Codex（gpt-5.6-sol / low / Plan）已完成 `memory.list` + `memory.read`，成功读回迁移的 `feedback-infra-config`。这是基础连通性/读取验收，不代替广泛召回质量评估；Claude CLI 当前不可用，未做其线上模型验收。
- 部署需重启后端，并设置 `CC_WEBUI_PROJECT_MEMORY_ENABLED=1` 才启用运行时记忆；默认关闭可先完成导入和成员 AI 配置；本机生产部署明确设为 1。
- 本机正式服务 8789 已重启，公网 HTTPS 返回 200；生产 `.env` 显式设置 `CC_WEBUI_PROJECT_MEMORY_ENABLED=1`。
- 显式导入 9 个现存项目的 175 条旧记忆，首次导入按旧规则将 rebecca 工作区 22 条放在 rebecca 库，其余 153 条放在本机管理员库；随后按用户确认的新规则自动合并为 9 个项目库。4 个已消失项目的 8 条保留原件及待迁移清单；没有擅自归并。194 个原生 Markdown 文件（含索引）逐字节校验未改。
- rebecca 保持普通成员角色，可用 AI 切为 Codex，默认 gpt-5.6-sol / xhigh；管理员仍可在用户设置中调整。CLI 全局配置未改。
- 上线前备份 DB（SQLite 一致性快照）、旧 dist、`.env` 与原生记忆至私有 `~/.cc-webui/backups/project-memory-<timestamp>/`；迁移清单、逐条报告和源文件校验记录保存在该目录。数据库升级后为 schema 10，回滚旧代码须同时还原备份 DB / dist / env，不能只切 Git 分支。

### 2026-09-29 项目共享修正

- namespace 改为规范化 cwd，去掉 scopes 对账号的外键。schema 10 在事务内合并旧账号库，保留全部 memory ID、版本、正文定位、hash、来源和幂等结果，不重写正文。
- 同名记录全部保留：较新条目保留原名，其余加稳定 ID 后缀；预留所有已有名称，避免 suffix 覆盖第三条。幂等键仍带 actor，避免两个账号恰好都用 `save-1` 时串请求。
- 新版本正文写入 `project-memory/projects/<project-key>/<memory-id>/`。旧不可变版本继续按原指针读取；forget 同时清理新布局与全部旧 actor 布局。账号删除不删除项目记忆。
- 每次调用仍复查账号存在、provider 可用、目录白名单、Plan 限制；群聊 / 飞书仍无 capability。
- 修正版本已直接发布：正式服务 schema 10，175 条 / 9 个项目保留，外键检查通过；管理员和 rebecca 的正式 GET 均在 rebecca 项目返回 22 条。
- 56 项测试及 typecheck / build 通过；以真实 rebecca actor、Codex gpt-5.6-sol / low / Plan 调用 `memory.list` 成功并返回 22，SSE 没有配置兼容错误项；既有 greeting 历史的 2 个误报在 UI 回放中为 0，正常答复仍保留。
- 变更前私有备份 DB schema 9、全部记忆正文、dist 与 `.env`；迁移先在备份副本演练，再重启正式服务自动提交 schema 10。CLI 全局配置没有修改。
