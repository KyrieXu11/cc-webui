# 用户与权限模块 — 设计文档

> **状态:设计已定稿,未实施。** 这份文档是一次逐问逐答评审的产物,记录**全部决策及其理由**,
> 以及实施时要覆盖的完整清单。给接手的人/agent:先读下面那条边界声明,它决定这个模块的性质。
>
> 定稿日期:2026-08-22 · 相关:[`../AGENTS.md`](../AGENTS.md)、[`./cli-migration.md`](./cli-migration.md)

## ⚠️ 先读这条:文件夹白名单是护栏,不是隔离

**agent 以 server 进程的 OS 用户身份运行,并且拥有一个不受限的 shell。**
`server/bash-mcp.ts:415` 是 `spawn("bash", ["-lc", command], { cwd })`——`cwd` 只是**起始目录,不是牢笼**,
而整个仓库**没有任何路径包含性检查**。

所以:任何被允许打开**任意一个**文件夹的用户,都可以让 agent 执行 `cat ~/.ssh/id_rsa` 或 `cd / && …`,
读写这台机器上该 OS 用户能碰的一切。通配符白名单能控制的只是**"UI 从哪个目录起步"**。

这不是实现缺陷,是"把一个不受限编码 agent 交给用户"这件事的固有属性。因此:

- 本模块的定位是**多用户便利 + 防手滑**,面向**互相信任的同事**。
- **管理页面上必须明写这句话**,不能让管理员误以为配了白名单就等于隔离。
- 要真隔离,只有 per-user OS 账号 / 容器 / 每用户一个 server 进程这条路(见「留了什么后路」)。

## 决策表

| # | 决策 | 理由 |
|---|---|---|
| 1 | **白名单是护栏,不是安全边界**;前期简单做 | 见上。app 层沙箱化一个设计成不受限的 agent 是必输的仗 |
| 2 | **自建用户表**,但身份读取抽成一个函数 | 本机/小团队最短路径。抽 `identifyRequest(c)` 一个函数,以后换成读反代注入的 header 只改那一处 |
| 3 | **"项目"就是 cwd 路径**,权限=路径通配符;另新增服务端"谁打开过什么"记录 | 用户需求本身是路径导向的。引入独立 Project 实体会和 `cwd` 并行,心智负担翻倍 |
| 4 | 飞书 **open_id → cc-webui 用户映射表**;未映射的 sender **拒绝** | 顺带修掉「群里任何人 @ bot 都能触发 turn」;若归到固定服务账号,飞书就成了绕过所有权限的后门 |
| 5 | 会话隔离**只在列表层** | 磁盘文件是共享的,隔离到不了文件层 |
| 5b | **不按 `entrypoint` 分类**,孤儿会话(含机器主人自己终端里的)都归管理员 | 管理员就是机器主人,那些本来就是他的 |
| 6 | 在 executor 的 spawn 处**留一个 `wrapCommand` hook** | 十行成本,把"将来上沙箱"从重构降级成实现一个函数 |
| 7 | 首个管理员用**环境变量种子** `CC_WEBUI_ADMIN=user:pass`,首启建号后可移除 | — |
| 8 | 白名单 = `fs.realpath()` 归一化 → `path.matchesGlob()` | Node 24 内置,零依赖;`*` 单层、`**` 递归;realpath 自动挡住 symlink 逃逸 |
| 9 | **中间件只做认证**;授权由每条路由**显式调用**;外加一个**路由覆盖测试** | 中间件无法知道请求里哪个 id 是资源。最大风险不是设计错,是漏一条路由 |
| 10 | 孤儿数据**仅管理员可见**;未映射的飞书 sender **拒绝** | — |
| 11 | 管理员可以:看/停别人的 turn ✓、看别人的 bash 任务 ✓、**读别人的会话内容 ✓(静默,不留访问日志)** | **明确决策,不是遗漏。** 技术上三者成本一样。团队规模小、彼此清楚 |
| 12 | 普通用户**禁用 `bypassPermissions`**,保留 `auto` | 护栏至少要能被看见;`bypassPermissions` 下连权限卡都不出现 |
| 13 | 登录态用**签名 cookie**(HMAC `{userId, exp}`),无服务端 session 表 | 零状态、重启不掉线;开发时 `tsx watch` 频繁重启,session 表会反复踢人。代价:改密/踢人不能立即生效 |
| 14 | 普通用户**不允许选 Codex** | `codex exec` 上**没有 `--ask-for-approval`**,`auto` 在 Codex 侧等于无审批全写——禁 bypass 在那一侧只是纸面限制 |
| 15 | 存量数据**全部归首个管理员所有** | 现有数据本来就是他的;"可见但无主"会在删号时变成悬空状态 |
| 16 | 网页群聊对普通用户**隐藏**;飞书 **@codex 对普通用户报错** | 群聊按定义是 Claude+Codex 两个 participant,普通用户不能用 Codex 就不可能有 2-participant 会话。网页能藏就藏,飞书没 UI 可藏只能报错 |

2026-08-23 追加的四条:

| # | 决策 | 理由 |
|---|---|---|
| 17 | **飞书的 sender 映射先不接线**,飞书一律**以首个管理员的身份**跑 | 决策 4 的表和管理页面都在,只是 `handler.ts` 还没读 `msg.senderId`。在接线之前,飞书 turn 必须有一个确定的身份,否则 MCP 侧无从判断权限。孤儿群 = 管理员(决策 10)本来就蕴含这个结果,现在只是把它写成显式规则 |
| 18 | MCP token **绑账号**,不做 TTL | 见「既有洞 #3」。问题从来不是 token 活多久,而是它代表谁;固定 TTL 反而会打断长 turn |
| 19 | `/api/chat` 图片、`/api/upload` 的大小上限**不做** | 自己人用,DoS 面不值当花成本 |
| 20 | 删会话:**普通用户拿不到别人的和无主的**(已成立),**管理员保留删自己终端会话的能力** | 管理员就是机器主人;他不会去删自己的历史,给他加一道守卫的收益低于它带来的意外(比如挡掉他真想删的东西) |

### 用户工作区(2026-08-23 第二轮评审)

**先加一个词。** 这块地和已有的两个概念都不是一回事,混用会改错地方:

| 词 | 指什么 |
|---|---|
| **项目** | 一个被打开的 cwd(决策 3)。磁盘上任何被授权的目录都可以是项目 |
| **白名单** | 管理员给某个账号的一组 glob |
| **工作区** | 系统建的、和账号一起出生的**一个目录**。它同时是白名单里的一条「系统条目」**和**一个装项目的容器 |

| # | 决策 | 理由 |
|---|---|---|
| 21 | 工作区是**容器**不是单个项目,白名单条目形如 `<ws>/**`;它是默认发的一块地,**不是上限**,管理员照样能额外授权别的目录 | 普通用户拿不到别的目录,如果连"自己分几个项目"都做不到,这块地很快会变成什么都往里塞的垃圾堆 |
| 22 | 位置 `~/.cc-webui/workspaces/{username}`,根可由 `CC_WEBUI_WORKSPACES_DIR` 覆盖 | **不能**直接放 `~/.cc-webui/{username}`:一个叫 `groups` 或 `feishu` 的账号会**撞上已有目录**,白名单会合法地把所有群聊 transcript 交给他——不需要 shell,文件浏览器就能读。至于 `cookie-secret` 在不在隔壁:agent 本来就有 shell,对**有意的**攻击没区别(决策 1),但天天在文件浏览器里看着应用数据目录是另一种暗示 |
| 23 | 建号时同时写一条 `opened_projects` | 否则新人登录看到的还是空首页,得自己去打开项目对话框里翻,白瞎了这块地 |
| 24 | 创建表单里那个复选框**默认勾选**,且**只对普通用户出现**(管理员不需要) | 这正是提案的价值。它不违反"default-closed":发给他的是一个**系统新建的空目录**,不是任何既有内容 |
| 25 | 目录**已存在就拒绝建号**,提示先改名或手动处理 | 删号保留目录(决策 5b 的同类)+ 用户名可复用 = 新人会**静默继承**前任的全部文件。拒绝的成本是管理员多花十秒 |
| 26 | 工作区那条是**系统条目**:按约定判定(`pattern === workspacePatternFor(username)`,不加列),保存白名单时服务端自动保留它;移除是一个**显式动作**(只删 pattern,目录留着) | 不加列就不会出现"库里标着 managed 但路径早变了"的漂移。"不可删"守的是**误删**(编辑器是整体替换的文本框),不是"不许"——后者会逼管理员去改数据库 |
| 27 | 它**不出现在白名单文本框里**,单独渲染成一枚 chip | 一个 textarea 里做不到"某一行只读",硬做会退化成"你删了它、保存、它自己回来了"——最难受的一类 UI |
| 28 | 顺序:校验用户名 → 目录不存在则建 → 一个事务里插 users + allowed_paths + opened_projects → 事务失败则删掉刚建的**空**目录 | 反过来会在磁盘说不的时候留下半成品账号。回滚用 `rmdir`(非空即失败),而刚建的工作区一定是空的(决策 30),所以不可能误删数据 |
| 29 | **降级 admin → user 会把白名单重写成只剩工作区**(没有就建);前端二次确认写明会丢多少条。**升级不做镜像操作** | 否则降级只是装饰:他仍然揣着 `**`。不做镜像是因为**静默放宽**权限和收紧是两种性质的意外 |
| 30 | 工作区里**什么都不放**(不放 README) | 代价是"白名单是护栏不是隔离"这句话**普通用户全程看不到**(只有管理员在管理页面看得到)。明确接受 |

- 用户名从此是**路径的一段**,所以 `createUser` 强制 `^[a-z0-9][a-z0-9_-]{0,31}$`(在 DB 层而不是路由层,这样 `CC_WEBUI_ADMIN` 环境变量种子走同一道闸)。**没有改名接口**,所以库里的值只可能来自创建那一刻。
- `/api/fs/scan` 会**额外把调用者的工作区加进结果**:目录扫描跳过点开头的目录,而工作区在 `~/.cc-webui` 下面——不加这一下,一个只有工作区的账号打开项目对话框会看到空列表。
- ⚠️ **写测试时凡是会 `createUser` 的都要设 `CC_WEBUI_WORKSPACES_DIR`**,否则会往你真实的 `~/.cc-webui` 里 mkdir。

### 实施时打出来的两个既有 bug

两个都不是工作区引入的,是工作区**让它们变得可见**:

1. **`/api/fs/scan` 原来是「走完整个 `$HOME` 再按白名单过滤」。** 对一个只被授权一个目录的
   账号,那两千次 readdir 全是白干的——更要命的是它会碰到 `~/Documents`,而**从 launchd 起的
   进程读这类目录会被 macOS TCC 永久挂起**(没有前台可以弹授权框)。挂起一次就永久占掉一个
   libuv 线程池线程(默认 4 个),四次之后这个进程里所有文件读写全部排队等死,连静态首页都发
   不出来。现在改成**只遍历白名单推导出来的根**(`patternRoot`);只有「哪儿都行」的模式
   (管理员的 `**`)才退回走 `$HOME`。另外 `readdirOrGiveUp` 给每个目录 800ms 超时并把不回话
   的目录记进进程级黑名单——超时**取消不了那个 syscall**,所以必须记下来别再碰。
2. **`path.matchesGlob` 的通配符不匹配点开头的目录。** 于是管理员的 `**` 匹配不到 `~/.claude`,
   也匹配不到**他自己刚发出去的、位于 `~/.cc-webui/workspaces/` 下的工作区**。目录白名单里
   「隐藏」不该有特殊含义:写 `**` 的人就是要全部。现在 `matchesAnyPattern` 在 glob 之外多跑
   一遍**逐段匹配**(`**` 任意段数、`*` 恰好一段、对点不敏感),glob 那一遍留着继续支持
   `?` / `[]` / `{}`。

实施时直接定掉的三条(不值得单独讨论):

- 密码哈希用 **`node:crypto` 的 scrypt**,不引 bcrypt/argon2 依赖。
- `~/.cc-webui/recents.json` 改成**按用户分**。现在是**一个共享文件、上限 20 条**——多用户下不只是隐私问题,
  一个人开几个项目就把别人的挤没了,功能直接坏掉。
- **public 路由只有登录接口和静态资源。** `/api/meta` 也要认证(它会泄露装了哪些 skill / slash command)。

## 数据模型(全部是新增状态)

现有存储 grep `userId|owner|email` **零命中**——"谁拥有什么"完全是新的。

**已经不是 JSON 文件了**:SQLite 迁移(`server/db.ts`)已先行落地,`opened_projects` /
`feishu_bindings` / `groups_index` / `codex_sessions`+`codex_turns` 都已是表。
本模块只需在同一个库里**追加迁移**:

```sql
-- 追加为 MIGRATIONS[1]
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,      -- node:crypto scrypt
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL,      -- 'admin' | 'user'
  created_at    INTEGER NOT NULL
);
CREATE TABLE allowed_paths (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,            -- glob，交给 path.matchesGlob
  PRIMARY KEY (user_id, pattern)
);
CREATE TABLE ownership (
  resource_id TEXT PRIMARY KEY,     -- Claude sessionId / Codex threadId / gid，都是 UUID 不会撞
  kind        TEXT NOT NULL,        -- 'claude' | 'codex' | 'group'
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE TABLE feishu_senders (
  open_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
```

- `opened_projects.user_id` 已经存在(现在填 `''` 表示无主),本模块只需开始写真实 user id。
  它是 `TEXT NOT NULL DEFAULT ''` 而不是 nullable,正是因为 SQLite 在 UNIQUE 索引里把 NULL
  当彼此不同,可空的 owner 会静默放进重复行。
- **签名密钥**:`~/.cc-webui/cookie-secret`(首启生成),不进 env,不进 git,不进 DB。
- 会话**内容**仍不进 DB:`~/.claude/projects/*.jsonl` 是 Claude Code CLI 自己的格式
  (和用户终端里的会话共用同一棵树),`<gid>/transcript.jsonl` 是 append-only canonical 真相。
  归属信息放 `ownership` 表,不往那些文件里写字段。

## 授权模型

```
identifyRequest(c) → User | null        // 中间件:读签名 cookie。唯一的身份入口
assertCanOpen(user, rawPath) → string  // realpath + matchesGlob;返回归一化后的路径
assertOwns(user, resourceId, kind)     // admin 短路通过(决策 11)
scopeToUser(user, list)                // 服务端强制过滤,不接受调用方给的 filter
```

**关键收敛点**:`expandHome` 现在在 **5 处重复**(`chat.ts:61`、`codex-chat.ts:73`、`groups.ts:37`、
`meta.ts:50`、`groups/store.ts:51`),只展开 `~`、不归一化、不做包含性检查——**而每个 `cwd` 参数就只经过它**。
把这 5 份合并成一个 `resolveUserPath(user, raw)`,白名单就只有一个入口。

**为什么必须在服务端**:`OpenProjectDialog.tsx:89-95` **接受手敲的绝对路径**,前端过滤是装饰。

`<dir>/**` **也授权 `<dir>` 本身**:`path.matchesGlob("/a/b", "/a/b/**")` 是 `false`(Node 要求
`**` 后面至少还有一段),照搬会让写了 `~/code/**` 的管理员把用户锁在 `~/code` 外面。
`matchesAnyPattern` 因此两个方向都补:字面目录蕴含子树,子树模式蕴含它自己的根。
两条都只针对**目录白名单**这个语义,`"/code/*"` 仍然只是"直接子目录",不会被悄悄变成递归。

**方向是反的,这是本模块真正的技术风险**:底层文件本来就共享且无归属,所以**默认状态是暴露**——
漏一个过滤器就泄露,而不是漏一个授权就拒绝。这就是那个路由覆盖测试要防的东西:

> 枚举 `server/index.ts` 挂载的所有路由,断言每条要么显式登记为 public,要么调用了上面四个函数之一。
> 新增路由若两者都没有 → 测试失败。

## 44 条现有路由,各要什么

**需要路径检查**(`assertCanOpen`):
`GET /api/fs/read`、`/api/fs/raw`、`/api/fs/tree`、`POST /api/fs/recents`、
`POST /api/chat`(cwd)、`POST /api/codex/chat`(cwd)、`POST /api/groups`(cwd)。
`GET /api/fs/scan` 要**按白名单过滤结果**(它 `walkDirs(os.homedir())`,深度 3、≤2000 目录)。

**需要拥有者检查**(`assertOwns`):
`GET /api/sessions/:id/messages`、`DELETE /api/sessions/:id`、
`GET /api/groups/:gid`、`PATCH /api/groups/:gid/config`、`DELETE /api/groups/:gid`、
`POST /api/groups/:gid/turn`、`GET /api/groups/:gid/stream`、`POST /api/groups/:gid/stop`、
`POST /api/chat/cancel`、`GET /api/chat/attach`、`POST /api/chat/wakeups/cancel`、
`POST /api/codex/chat/cancel`、`GET /api/codex/chat/attach`、
`GET /api/bash/tasks/:id/output`、`POST /api/bash/tasks/:id/kill`、`GET /api/bash/tasks/:id/stream`、
`POST /api/bash/tasks/foreground/:fgId/detach`、`POST /api/permission/:id`。

**需要服务端强制过滤**(现在的 filter 是调用方给的,默认返回全量):
`GET /api/sessions/`、`GET /api/groups/`、`GET /api/groups/inflight/all`、
`GET /api/chat/inflight`、`GET /api/chat/wakeups`、`GET /api/codex/chat/inflight`、
`GET /api/bash/tasks/`、`GET /api/bash/tasks/stream`、`GET /api/bash/tasks/foreground`、
`GET /api/fs/recents`。

**只需认证**:`GET /api/fs/home`、`GET /api/meta`、`POST /api/upload`(另见下面的大小上限)。

**不走用户认证,是 capability**:`/api/mcp/bash`、`/api/mcp/schedule`、`/api/mcp/lark`
——per-turn bearer token。但**里面的 bash 任务 id 要按拥有者收口**(见下)。

**不变**:`/feishu/:bot/events`(固定 404,webhook 未实现)。

**需要新增的路由**:
`POST /api/auth/login`(唯一 public)、`POST /api/auth/logout`、`GET /api/auth/me`、
`GET|POST|PATCH|DELETE /api/admin/users`、`GET /api/admin/opened-projects`、
`GET|PUT /api/admin/feishu-senders`。全部 `/api/admin/*` 要求 `role === "admin"`。

## 前端

**现在没有任何 React context**(`main.tsx` 渲染裸 `<App/>`),没有 role/isAdmin/useAuth。

⚠️ **不要照抄 `features.groups` 那个模式**:它是一个 boolean、prop 往下钻一层、默认 false 且**异步到达**。
用来"隐藏"是 fail-closed,但任何必须隐藏的东西**会在首帧闪一下**。角色门需要一个真的 provider
(`AuthProvider` + `useAuth()`),并且在身份就绪前**不渲染主界面**。

需要按角色收窄的面(审计确认会展示跨用户数据):

| 组件 | 现在泄露什么 |
|---|---|
| `HeaderSearch.tsx:34-35` | 全部 recents + 最新 100 个会话,可搜索 |
| `HomeView.tsx:58,83` | 全部会话→全部项目、全部群、摘要;还能删(`:96,119`) |
| `OpenProjectDialog.tsx:21,89-95` | 整个 home 目录树,且**接受手敲绝对路径** |
| `FileExplorer.tsx:22,96` | 任意可读目录 |
| `GroupSidebar.tsx:31,157` | 全部群 + 3 秒轮询 + 删除(`:50`) |
| `TasksModal.tsx:80-81,155,313,318` | 全部命令、cwd、实时 stdout、kill |
| `ProjectSidebar.tsx:50,67` | 每 cwd 200 个会话 + **全局** in-flight id |
| `App.tsx:641,656,292` | 未校验的 cwd setter |

新增:登录页、管理页面(用户 CRUD / 白名单编辑 / 谁打开了什么 / 飞书 sender 映射),
管理页面对普通用户**不出现**(不是灰掉)。群聊入口对普通用户**不出现**(决策 16)。

## 顺带必须修的既有洞

这些是路由审计查出来的,不修的话权限模块建在沙子上:

1. ~~`POST /api/permission/:id` 的全局 pending Map~~ —— **已修**。pending 条目现在记 `ownerId`
   和 `gid`;HTTP 路由按调用者身份校验(管理员可代答,决策 11),而飞书的卡片点击**按 gid** 校验
   ——一次点击带的是聊天而不是账号,所以只能回答本聊天绑定群里的卡。"未授权"和"没这个 id"
   返回同一个 false,不泄露 id 空间。
2. ~~bash 任务 id 全局裸查~~ —— **已修**。任务通过它的 session 归属:web 单聊是 session UUID,
   群聊是 `gid:agentId`(取冒号前那段)。`:id/output|kill|stream` 不属于你就是 404;
   列表 / stream / foreground / detach 全部按可见性过滤。无 session 的任务归不了属,只有管理员可见。
3. ~~MCP bearer token 不受用户权限约束~~ —— **已修,但修的不是 TTL**(2026-08-23 决策 18)。
   这三条路由**永远看不到登录 cookie**,所以真正的问题不是"token 活多久",而是"token 代表谁"——
   在此之前它谁也不代表,于是一个 turn 的能力和触发它的账号无关。现在 `McpSessionContext` 带
   `ownerId`,由起 turn 的那一侧解析(网页 = 登录调用者;群聊 = `server/auth/actor.ts` 的
   `actorForResource(gid)` = 群主,孤儿群 = 首个管理员,这也是飞书跑成管理员的原因),
   `mcp__bash__run` 和 `mcp__lark__send_file/send_image` 都按这个账号的白名单再查一次路径,
   **解析不出用户就直接拒**(fail-closed:漏传 ownerId 不能等于无限制)。
   `output`/`kill` 同时收口到**本 turn 的 session**——任务 id 是给模型看的,泄到另一段对话里
   不该变成句柄;拒绝话术与"没这个任务"完全一致。
   **仍未做 TTL**:固定 TTL 会在长 turn 中途把 agent 的 bash 打断,而 `unregister` 已经在
   `finally` 里做了 turn 级失效。剩余风险是 Codex 把 token 落进子进程环境变量(`printenv` 可读),
   现在它至少被绑在一个具体账号的护栏内。
4. **`DELETE /api/groups/:gid` 的 gid 未校验** → `fs.rm(groupDir(gid), {recursive,force})`,
   已用 PoC 证过可以 `rm -rf $HOME`。群聊 flag 关着时路由不挂载,**打开就回来**。
5. **`POST /api/chat` 的图片无大小上限**(Codex 那条有 10MB,`codex-chat.ts:244`)。
   `c.req.json()` 在校验之前就把整个请求体读进内存,全仓也没有 `bodyLimit`,所以一个大请求能 OOM
   掉整个进程、连带打死所有人正在跑的 turn。→ **不修(2026-08-23 决策 19)**:自己人用,不值当。
6. **`POST /api/upload` 无大小/数量/mime 上限**,且响应**返回绝对服务端路径**(`upload.ts:48`)
   ——那正是客户端得知真实绝对路径、再喂进 prompt 的途径;文件也从不清理,同毫秒同名会互相覆盖。
   → **不修(同上)**。
7. **`deleteClaudeSession` 能删掉机器主人自己终端里的会话** —— **普通用户这一半已关死**,
   管理员那一半**有意保留**(2026-08-23 决策 20:管理员就是机器主人,他不会去删自己的)。
   `~/.claude/projects` 与终端 `claude` 共用,那些文件无主,而无主 = 仅管理员可见/可动
   (决策 5b),所以中间件的 `owns` 检查已经让普通用户拿到 404;`policy.test.ts` 里现在有一条
   实打实的断言(建一个无主 jsonl → 普通用户删 → 404 且文件仍在 → 管理员删 → 文件消失)。
   ⚠️ **原来写在这里的修法(只删 `entrypoint: "sdk-cli"`)在 CLI 迁移之后已经不成立**,别照抄:
   实测 CLI 的 `entrypoint` 直接来自环境变量(`process.env.CLAUDE_CODE_ENTRYPOINT && {entrypoint: W5() ?? "other"}`,
   `W5` 对着白名单校验,**变量没设就整个字段不写**),而 `claude-executor.ts` 是 `env: process.env`
   原样透传、自己不设——普通 shell 起的服务写不出这个字段,从 Claude Code 会话里起的服务会写成
   `cli`,和终端会话无法区分。盘上那些 `sdk-cli` 全是 SDK 时代的遗留。真要做这个守卫,得**先在
   executor 里显式设** `CLAUDE_CODE_ENTRYPOINT: "sdk-cli"`。

## 迁移

1. 追加 `MIGRATIONS[1]`(上面那批表)。
2. 首启读 `CC_WEBUI_ADMIN=user:pass` → 建管理员(scrypt 哈希)→ 日志提示可以移除该变量。
3. 生成 `~/.cc-webui/cookie-secret`。
4. 扫描现有 Claude 会话 / Codex 会话 / 群,全部在 `ownership` 表里记为**首个管理员所有**(决策 15)。
5. 把 `opened_projects` 里 `user_id = ''` 的行改归首个管理员。
6. 管理员的 `allowed_paths` 默认 `["**"]`(全开);普通用户默认 `[]`(全关,由管理员显式配)。
7. **先建好管理员再开放端口**——在建号之前,任何能访问端口的人都能把自己变成管理员。

## 留了什么后路

- **反代认证**:身份只从 `identifyRequest(c)` 一处进,换成读 `X-Forwarded-User` 只改那个函数。
- **沙箱**:executor 的 spawn 处有 `wrapCommand` hook。Linux 上可接 Landlock / bubblewrap,
  macOS 上可接 `sandbox-exec`(Seatbelt,`/usr/bin/sandbox-exec` 存在但已 deprecated)。
  **Landlock 是 Linux LSM(kernel 5.13+),在 macOS 上不存在**,所以本机开发期一定是护栏形态。
  注意包住 **CLI 子进程**这一层就同时覆盖了 bash 和 CLI 内置的 Read/Write/Edit,比逐个工具加检查干净。
- Codex 侧一旦有真审批通道(`codex exec` 支持 `--ask-for-approval`),决策 14 可以放开。

## 实施进度

| 阶段 | 状态 |
|---|---|
| 认证基础(users / scrypt / 签名 cookie / 白名单匹配 / identifyRequest) | ✅ |
| 声明式路由授权 + 覆盖测试,强制已开启 | ✅ |
| 登录页 + 前端身份门 + 角色门 | ✅ |
| 管理页面(用户 / 白名单 / 打开记录 / 飞书成员 / 认领无主) | ✅ |
| 10 条列表接口按 owner 过滤 | ✅ |
| 上面 7 个既有洞里的 #1 #2 | ✅ |
| #3 MCP token 绑账号(路径护栏 + 任务收口,决策 18) | ✅ |
| #4 gid 校验(由中间件的 UUID 守卫覆盖) | ✅ |
| #7 删会话:普通用户已关死,管理员保留(决策 20) | ✅ |
| #5 / #6 大小上限 | ❌ 决策 19,不做 |
| 飞书 sender 映射的**执行**(表和管理页面已有,handler 还没读它) | ⏸ 决策 17,先都跑成管理员 |

## 明确不做的

- 不做真隔离(per-user OS 账号 / 容器)。
- 不做密码找回(单机无邮件通道);忘记密码 = 管理员重置,或改 `CC_WEBUI_ADMIN` 重新种子。
- 不做审计日志(决策 11 明确选了静默)。
- 不做细到文件级的权限——单位是目录 glob。
