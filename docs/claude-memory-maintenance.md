# Claude Code 后台记忆机制研究

2026-10-10，基线为本机 **Claude Code 2.1.283**。这份研究记录原生后台提取和 Auto Dream 的机制，不是 cc-webui 的实施方案。普通记忆规则及新会话、resume 索引注入见 [Prompt 对照](claude-memory-prompts.md)。

**原生机制分为主对话主动维护、后台增量提取、跨会话整理三层。后两层是同一 CLI 进程内部的对话 fork，继承父对话上下文和工具表，再以专用权限回调限制执行；不是每次保存时由存储层做语义 upsert。**

## 版本和证据范围

- 二进制：`~/.local/share/claude/versions/2.1.283`。
- SHA-256：`d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`，与 2026-10-03 已解包材料一致。此次复用模块，没有重新做 CLI 迁移调研。
- 源码真相：`~/.cc-webui/research/claude-memory/2.1.283-2026-10-03/modules/`。只解析源码，不执行解包后的 JS。
- 请求实测：隔离 HOME、配置、项目和记忆，虚拟 API key、本地假 Anthropic API。子进程 sandbox 禁止非回环外连，禁止读写真实 HOME，仅允许读取经过 hash 校验的 CLI 二进制；非回环 curl 负向对照失败。
- **24 个用例**覆盖入口开关、提取频率、直接写入跳过、实际文件更新、越界写拒绝、两类轮数上限、Dream 门槛，以及下一轮旧副本提醒。模型响应由探针确定性生成；这些验证不评价真实模型的查重、语义合并或事实判断质量。
- Auto Dream 正向用例使用**合成 GrowthBook 缓存和 `claude-desktop` 入口标识**，不是声称当前安装已经获得 rollout，也不是建议生产伪造入口。

记忆相关的实际请求原文和结果：

- [后台提取请求](research/claude-memory-2.1.283/maintenance/background-extraction-request.txt)
- [Auto Dream 请求](research/claude-memory-2.1.283/maintenance/autodream-request.txt)
- [24 用例校验结果](research/claude-memory-2.1.283/maintenance/maintenance-capture-summary.json)
- [追踪模块的文件 hash](research/claude-memory-2.1.283/maintenance/maintenance-source-index.json)

原文只替换合成目录、时间戳和 session UUID，没有将整个 system prompt 放进仓库。完整请求、日志和源码追踪记录位于 `~/.cc-webui/research/claude-memory/2.1.283-maintenance-2026-10-10/`，不参与运行时装配。

## 源码入口

| 模块 | 关键符号 | 职责 |
|---|---|---|
| `0684-chunk-rx5pzg1g.js.txt` | `I7n` | housekeeping 首次初始化，注册提取器和 Dream runner |
| `0573-chunk-td7fxg34.js.txt` | `Pi` | 主对话 turn 结束路径，调用提取和 Dream；bare 模式跳过这一组维护 |
| `0563-chunk-525qs7wc.js.txt` | `rrr`、`T3o`、`de`、`re`、`ICn`、`WVt` | 提取调度、提示、直接写入检测、受限工具、更新通知 |
| `0564-chunk-0wcm1gj1.js.txt` | `q_t`、`L2e`、`JYr`、`QYr`、`Q` | Dream availability、用户开关、门槛、任务注册和四阶段提示 |
| `0536-chunk-9hyxppty.js.txt` | `j2e`、`l7r`、`bJe`、`c7r` | 上次整理标记、PID 锁、标记恢复、会话扫描 |
| `0365-chunk-wyjbafrm.js.txt` | `lz`、`fv`、`HLn`、`VCt`、`R5o`、`cRt` | 继承父上下文、执行 fork、克隆读缓存、默认预算、旧副本提醒 |
| `0131-chunk-1vt3h958.js.txt` | `a$e`、`s$e`、`cl`、`Db` | 提取 gate、hosted 配置、原生记忆开关和目录 |
| `0255-chunk-hzevqd7x.js.txt` | `JMe`、`l0t`、`$B` | 主题文件 metadata 扫描及清单格式，清单最多 200 条 |
| `1284-chunk-r4xrzyvn.js.txt` | `drainPendingExtraction` 调用处 | headless 退出前等待提取任务 |

别混淆不同模块里恰好同名的压缩符号，必须同时记录模块名。源码模块的 SHA-256 可由既有 `manifest.json` 对照。

## 三层维护之间的关系

```text
主对话
  ├─ 普通 memory 提示 → 主模型按需 Read / Write / Edit / 删除
  └─ turn 结束
       ├─ 后台提取 eligible → 增量对话 fork → 保存或更新记忆
       └─ Auto Dream eligible → 整理 fork → 聚合新信号、修正、清理索引

后台成功写入
  └─ 同步主对话读缓存 → 排队 memory_update
       └─ 下一模型请求提醒：已加载的旧副本过期，需要时重新 Read
```

主对话正常保存前的“同主题优先更新”来自普通 system 规则。后台提取负责避免漏掉近期对话教给它的长期信息；Dream 负责跨会话的组织、合并与维护。**二者都不是 `Write` 成功后必然触发的同步合并函数。**

## 原生 fork 如何运行

`lz(context)` 取父对话的 system prompt、user/system context、消息、工具上下文、advisor 设置及 sticky betas。`fv` 将专用维护 user prompt 追加到这些消息后，调用父上下文的 `runQuery`。

- 继承父上下文和工具列表，而不是另起一个 CLI 子进程，也不是只把几条候选记忆交给独立 selector 模型。
- 两个维护调用都没有指定另一主模型；实测请求模型和父对话一致，system 文本、工具名称列表相同。这不构成真实服务端缓存命中率测量。
- 模型**仍能看见** Agent、Bash、WebFetch 等父工具名称；专用 `canUseTool` 在执行时拒绝不允许的请求。不能把“提示写了只准用这些工具”理解成真的删掉了其它工具 schema。
- fork 的 `readFileState` 为克隆，后台有自己的 agent 标识，`requireCanUseTool` 生效。
- 两个调用使用 `skipTranscript: true`，不单独持久化完整维护 fork transcript，也不把其全部工具历史塞回主对话；主对话原有历史不会被擦除。

## 后台增量提取

### 启用和频率

普通本地文件分支的入口条件为：

1. 主对话，不是一个已经 fork 的 agent；不是 bare 模式。
2. `tengu_passport_quail` 为 true。
3. 非交互 headless 还要求 `tengu_slate_thimble` 为 true。
4. 原生记忆 `cl()` 可用，没有本轮 memory off、restricted session 或环境禁用。
5. 不是 remote link；开启“禁止读工作目录外”且记忆目录由被限制的项目设置提供时，也跳过。

然后检查增量窗口：

- 检测到主对话对原生记忆目录的 Write/Edit 调用，就跳过该窗口并前移游标。
- 至少存在一条合格的非 meta 用户文字消息：按空白切词后至少 3 个词。合成的无空格中文消息未通过此过滤；这只说明该后台过滤条件，**不意味着主对话不能保存中文记忆**。
- 频率取 `tengu_bramble_lintel`，未配置回退 1。计数器属于本次 host 的提取器，不是跨重启的全项目持久计数。

**直接写入检测并不等价于“写入成功”。** 普通文件分支的 `re` 只识别工具调用和路径；实测 Edit 因 old_string 不存在而失败后，该窗口仍被当作“已经写过记忆”跳过。真正收集后台落盘路径时则会排除 tool_result 的错误项。

### 输入和整理行为

实际请求给出的指令是：分析最近约 N 条新增消息，更新持久记忆；只从这段新增消息获取要保存的内容。**这是一条使用范围指令，不是把父消息数组裁成仅 N 条**，fork 仍继承完整父上下文。

附带现有主题文件清单，含文件名、type、mtime 和 description，最多 200 条；不是预取全部正文。指令要求检查清单、优先更新已有文件，继承 system 里的类型、格式和排除标准。

提取器明确不应花预算调查代码或用 Git 再验证这些新增对话内容。工具权限本身仍允许只读探索，因此“不要读源码核实”是任务指令，不是独立的文件读取路径封锁。

### 工具和预算

- Read、Grep、Glob：允许只读操作，但先查用户显式阻断规则及目录外读取限制，不是无限读权限。
- Bash 或 PowerShell：只读命令允许；另允许在记忆目录中删除具体 `.md`。POSIX `rm` 不允许递归和通配符，只接受 `-f`/`--force` 等该解析器允许的形式。
- Write/Edit：只准记忆目录内且通过受保护子目录检查的 `.md`；Edit 仍须先 Read。
- 普通分支不允许 MCP、Agent 或写状态的 shell；另有少数终止控制工具例外。
- **最多 5 个 agentic turns**，不是最多 5 个工具调用；一轮可以并行调用多个工具。实测持续请求被拒的写工具时，第 5 个后台模型请求后结束。

这些是权限回调能接受的工具，不代表当前父工具表一定包含每一种。此次父工具表没有 Grep/Glob，fork 也没有凭空补出它们，尽管提取提示仍列出了这些名称。

### 并发和失败

每个 host 有提取中的布尔标记和 pending Promise 集合。运行中收到更新的上下文时合流到最新一份；频率为 1 时在结束后跑 trailing extraction，较低频率的普通分支不立即尾随。只有 hosted 配置分支另有 idle flush。

成功或明确跳过后前移 UUID 游标。异常由提取器捕获；已经成功写入的文件仍保留并尝试通知主对话。没有整库事务、正文回滚或固定指数退避逻辑。

Headless 退出前会 drain 提取任务，默认最多等 60 秒。这是退出等待上限，不是给每个原生提取任务设置了 60 秒超时。

## Auto Dream 跨会话整理

### 触发门槛

Auto Dream 是**主 turn 结束时检查是否到期**，不是独立 daemon 每 24 小时无条件启动。

| 条件 | 本版本普通文件分支 |
|---|---|
| 可用性 | `tengu_onyx_plover.enabled` 或 `.available` 为 true 才可用 |
| 用户开关 | 可用后再读 `autoDreamEnabled`；没设置则采用服务端 `.enabled`。用户 true 不能绕过完全 unavailable |
| 入口 | 不允许 remote link；排除 `sdk-ts`、`sdk-py`、`sdk-cli`；原生记忆关闭和受限项目目录情形也跳过 |
| 时间 | 源码默认距标记至少 24 小时，服务端可覆盖 `minHours` |
| 扫描节流 | 时间门槛通过后，每个 runner 至少相隔 10 分钟才再扫会话 |
| 会话数量 | 源码默认 5 个，服务端可覆盖 `minSessions`；统计 transcript mtime 晚于标记的会话，排除当前 session，并非要求 5 个刚新建的会话 |
| 锁 | `.consolidate-lock` 的 PID、mtime 检查；一小时内的活 PID 视为持锁 |

**普通 `claude -p` 的本机请求实际带 `sdk-cli` 入口，因此即使 gate 和设置已开，Dream 仍不运行。** 合成 desktop 入口在其它条件满足后才捕获到 Dream 请求。不能将“源码中有 Dream”写成“cc-webui 的 CLI 子进程天然在跑 Dream”。

### 四阶段提示

1. **Orient**：列记忆目录，读 MEMORY.md、浏览已有主题；列近期 logs，可能还查看 sessions 子目录。
2. **Gather**：优先看最近 1–3 天的活动日志，再看与当前代码矛盾的旧记忆，必要时窄范围搜索 JSONL transcript；不穷尽重读全部历史。
3. **Consolidate**：遵守 system 的记忆质量规则，将新信号并入既有主题，避免近似重复，把相对日期改为绝对日期，修正被新证据反驳的事实。
4. **Prune and index**：移除过期或被取代的指针、解决矛盾、维护短索引；保持 200 行和约 25KB 以下，将正文细节移到主题文件。

还会对照 CLAUDE.md：能证实记忆旧了则修正或删除；记忆明确晚于文档且纠正文档时，**不在 Dream 内修改 CLAUDE.md**，而是标记冲突并在摘要提醒用户核实。“Why 是用户纠正”本身不证明它更晚。

本地文件分支直接 Write/Edit/删除，不先生成可审批计划；普通语义合并由模型判断，没有 embedding 相似度阈值或服务端确定性去重算法。实验 team/stone-shell 等变体另有模板插值，不混入此次普通分支基线。

### 预算和任务生命周期

Dream 注册为 task registry 的 `dream` 任务，记录阶段、涉及会话、触及路径及最近最多 30 轮展示信息。**30 是展示保留数量，不是执行轮数上限。**

Dream 调用 `fv` 没有传 `maxTurns`，因此继承默认 **50 个 agentic turns**；持续请求被拒写工具的实测在第 50 个 Dream 请求结束。不是我之前提出的“统一每任务 5 轮、2 分钟”。工具执行权限复用提取器的 `ICn`，没有放行任意 shell 或原生 MCP。

本地锁在取得时写 PID 并更新 mtime。正常完成后保留此标记，**没有改动记忆的正常完成也会推进冷却**。特定异常路径尝试恢复原先的 mtime，或删除首次创建的标记；这只恢复调度标记，不回滚已经写过的正文。中止分支不会统一执行该恢复，不能声称所有失败都会回滚。

原生没有多记忆 CAS 原子合并、人工审批或全局预算队列。文件 PID 锁也不等价于跨进程原子事务锁；另有 storage-v5 条件分支，不能拿其 CAS 锁当作普通本地文件分支的保证。

## 写入后如何更新主对话

`WVt` 收集成功变更路径，并调用 `cRt` 将主对话的读缓存同步到磁盘。内容改变时标注先前读已过期、必要时重新读取才能写入；不把后台新内容伪装成主模型已经读过。

随后排队 `memory_update`。下一次附件构造列出变更文件，并对主对话已加载的文件提醒“旧副本相对磁盘已过期，需要当前内容时重新 Read”。**不是每次后台写入都把全部正文或索引自动塞回 system。**

两类后台都实测完成了 Read → Write；之后同一主对话的下一模型请求收到对应旧副本提醒。普通提取按成功 tool_result 统计写入；Dream 的 task 路径展示部分来自观察 tool_use，不应把“触及文件数”解释成每个文件均已成功写入。

## 当前安装和 cc-webui 的差异

2026-10-10 只读查看本机缓存得到：

- `tengu_passport_quail=false`、`tengu_slate_thimble=false`。
- `tengu_bramble_lintel=7`，但提取 gate 关闭，所以不是“每 7 轮一定会提取”。
- `tengu_onyx_plover={enabled:false,minHours:24,minSessions:3,remoteEnabled:false}`。本机缓存的 3 与源码 fallback 的 5 要分开说。
- `tengu_stone_shell=false`、`tengu_moth_copse=false`。

缓存只是本机当时的 rollout 数据。正向探针是在**隔离配置**中打开指定 gate，不修改这些真实设置。

cc-webui 目前只移植普通 memory 规则，仍有这些必要差异：项目共用 canonical cwd、Memory MCP 是唯一写入口、索引由 DB 生成、版本 CAS、Plan 由服务端拒绝写入。启用项目记忆时 `chat.ts` 设置 `disableNativeMemory`，executor 注入 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`，因此原生本地维护不会替 MCP 库整理。

后续等价移植需要明确映射：增量对话窗口和游标、原生 fork 的上下文继承、可授权的近期信号来源、受限工具、退出等待与旧副本提醒。不能把“另起全新 CLI＋只给索引”称作完全等价；也不能把人工审批、MCP 批量原子提交、只整理现存记忆等新策略包装成原生机制。**此次没有实现任何后台维护功能。**

## 重现和验证

先确认二进制仍匹配上述 hash，新版本不能沿用本矩阵结论。完整捕获放新建的私有目录，避免覆盖旧研究：

```bash
OUT="$HOME/.cc-webui/research/claude-memory/new-maintenance-research"
python3 scripts/research/probe-claude-memory-maintenance.py \
  "$(command -v claude)" "$OUT/probe"
python3 scripts/research/verify-claude-memory-maintenance.py \
  "$OUT/probe" "$OUT/fixtures"
```

探针仅支持 macOS sandbox-exec，无法建立沙箱时直接失败，不能退回不受限的真实 CLI。假 API 的主回复保留短延迟，让 lazy housekeeping 完成初始化；Dream 用 stream-json stdin 保持进程存活，防止极快假回复和进程退出造成假阴性。desktop 标识还会触发独立标题请求，校验将其与主对话、提取和 Dream 分开计数。

已验证的是普通文件分支的上述 24 个机制用例。真实模型的语义整理质量、跨进程锁竞态、故障时正文部分提交、Windows 命令解析、hosted/connected-store 和实验变体的实际行为仍不在这组验收范围内。
