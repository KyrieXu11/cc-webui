# 桌面客户端 — 设计文档

> **状态：服务端已实施，Electron 客户端未实施。** 这份文档是一次逐问逐答评审的产物，记录**全部决策及其理由**、
> **本轮实测出来的事实**，以及被否掉的方案（连同否掉的原因）。
>
> 给接手的人/agent：
> - 「已核实的事实」一节是跑过命令、搜过一手资料得来的，**不要重新调研**，直接用。
>   发现某条和现实不符，改这份文档并注明日期，不要默默绕过。
> - 「被否掉的方案」一节是防止把讨论重来一遍的。要推翻某条，先看它的否决理由还成不成立。
>
> 定稿日期：2026-08-29 · 相关：[`../AGENTS.md`](../AGENTS.md)、
> [`./cli-migration.md`](./cli-migration.md)、[`./user-permissions.md`](./user-permissions.md)

## ⚠️ 先读这条：这个模块的性质

**它让「你 Mac 上的 agent」获得「在家人 Windows 机器上执行代码」的能力。**
凭据一步不外移，runtime 也不外移 —— 外移的是**工具执行**。

由此得出两条必须写进管理界面、不能靠口口相传的话：

1. **系统里没有任何物理在场校验。** 拿到某个账号 cookie 的人，从世界上任何一个浏览器，
   都能在那台家人机器上跑代码，并且自己点掉权限卡（决策 6 + 决策 7 的合并后果）。
   唯一的缓解是托盘里那个「暂停本机工具」开关（决策 8）。
2. **服务端可以命令设备 spawn 任意进程**（决策 16 的固有性质，不是缺陷）。
   本地 MCP server 列表由服务端下发，设备端照单执行。

这两条在「用户是家人、机器是他们自己的、账号各自独立」的前提下是**站得住的取舍**，
但必须是**决定**，不是意外。前提一旦变（比如给非家人开账号），整个取舍要重算。

---

## 一句话

**Runtime 不动，只给它加一只远端的手。** 服务端 CLI 保持原样，通过一条 WebSocket
把 MCP 工具调用中继到家人 Windows 机器上的 Electron 客户端执行。

## 拓扑

```
家人的 Windows PC                              你的 Mac（服务端）
┌──────────────────────────────┐              ┌─────────────────────────────────┐
│ Electron app（托盘常驻）      │              │ cc-webui server                 │
│  ├ 渲染进程 = 远端 cc-webui ──┼──HTTPS──────▶│  /api/*                         │
│  ├ 主进程：WS 客户端 ─────────┼──WSS────────▶│  设备注册表（ownerId → 1 设备）  │
│  └ 主进程：MCP host           │              │  /api/mcp/local/:server         │◀─┐
│     ├ browser（系统 Chrome/Edge）            │  spawn claude CLI ────HTTP───────┘
│     ├ fs（本地读写）          │              └─────────────────────────────────┘
│     └ transfer（与服务端互传）│
└──────────────────────────────┘
```

**一次本地工具调用的完整链路：**

1. 家人在 app（**或任意浏览器**）里发消息 → `POST /api/chat`
2. 服务端查：该 `ownerId` 有没有在线设备？
   - 有 → 在 `--mcp-config` 里追加 `local-*` 条目，URL 指向 `/api/mcp/local/<server 名>`
     （token 走 `Authorization: Bearer`，**不在路径里** —— 见「实施期的修正」§1）
   - 无 → 不追加，并在 `appendSystemPrompt` 里显式告诉模型「本机工具不可用」
3. CLI spawn，初始化 MCP，`tools/list` 走 HTTP → 服务端 → WS → 设备 → 本地 stdio MCP 子进程
4. 模型调用 `mcp__local-browser__*` 等，沿同一条链下去执行
5. 权限卡走**现有**网页流程（`shared/permission-flow.ts`，scope=sessionId）
6. 设备中途掉线 → 挂起的调用**立即**返回错误结果，不等重连

⚠️ **CLI 那一跳必须是 HTTP，服务端→设备那一跳才是 WS。** 这不是可选的，见「已核实的事实」§1。

---

## 决策表

| # | 决策 | 理由 |
|---|---|---|
| 1 | **Runtime 只在你 Mac 上，凭据零外移** | 订阅态共用；反代和凭据下发均被判定不合规 |
| 2 | **本地能力外挂**，内置 `Read`/`Edit`/`Bash` 一个不动 | 全量远程化要重写全部内置工具语义，且模型是围绕**内置工具名**调过的，换名字实打实掉能力 |
| 3 | **WS 只透传 MCP JSON-RPC**，客户端本身是 MCP host | 「任何能力外挂」= 往配置里加一条 MCP server，你不用写工具代码 |
| 4 | **WS 由客户端主动外连** | NAT 穿透白送；不用 Tailscale、不用写反连隧道协议 |
| 5 | **一账号一设备**，家人各用各的账号 | 否则 CLI 的 `--mcp-config` 里会出现两条同名 server，模型选哪个靠掷骰子 |
| 6 | **不区分入口**，设备在线即工具可用（浏览器发起的也算） | `X-CC-Client` 这类头**可伪造**（`curl -H` 即可），做入口区分是零安全收益；不区分则白送「人在外面指挥家里机器」 |
| 7 | **权限卡维持现状**（网页 UI，scope=sessionId） | 复用现有 `shared/permission-flow.ts`，v1 不写原生对话框 |
| 8 | 补偿：托盘菜单里放 **`⏸ 暂停本机工具`** | ~10 行代码，给机器主人一个物理闸；这是决策 6+7 之后**唯一**的在场控制 |
| 9 | **起 turn 前探测设备**，探测结果写进 `appendSystemPrompt` | 工具集在 CLI spawn 时就冻结了，模型必须知道自己有没有这只手 |
| 10 | **长阻塞调用用异步任务模式**（立即返回 task_id，再轮询） | 扫码登录要等几十秒；照抄现有 `bash-tasks.ts` 的心智，且同步阻塞会让 SSE 长时间无动静 |
| 11 | **中途掉线立即返回错误**，不等重连、不中止 turn | Windows 睡眠在家人机器上是**高频**而非边缘场景；模型处理「工具报错」远强于「工具卡住」 |
| 12 | **Electron 开远端 URL**，不打包前端 | 前端永远与服务端同版本，`npm run build` + 重启即全员生效，app 几个月不用动 |
| 13 | 渲染进程 `nodeIntegration:false` + `contextIsolation:true`，preload 只暴露极窄 IPC | 主进程握着「本机 spawn 任意进程」的能力，渲染层加载的又是远端页面 —— 一次前端 XSS 就是 RCE |
| 14 | **主进程读渲染进程登录后的 cookie** 开 WS（`session.defaultSession.cookies.get`） | 登录只有一处，登出即断连；不做配对码。cookie 过期要能感知并回到登录流程 |
| 15 | **托盘常驻，关窗口不退出** | 自启和常连才有意义；这个 app 本身就是 daemon，没有第二个东西要装 |
| 16 | **本地 MCP 配置由服务端下发**；v1 手动配，**不做管理界面** | 配置格式头两版几乎肯定要改，过早做界面是给自己上枷锁。等格式稳了再上 admin 页 |
| 17 | **v1 只给浏览器 + 文件读写，不给本机 shell** | 不是安全考量（决策已接受不设限），是**调试成本**：shell 一上，任何失败都可能来自远端环境差异，而你人不在那台机器前 |
| 18 | **必须配两个传输工具**（`upload_to_server` / `download_from_server`） | 否则本地成果永远困在家人机器上，「外挂」退化成一个孤立的浏览器。服务端复用已有 `/api/upload` 和取件台 |
| 19 | **v1 只有网页单聊能用本地工具**，群聊 / 飞书显式排除 | 飞书**没有 sender 白名单**且 turn 跑在管理员身份下（见 AGENTS.md），接上就等于「飞书群里任何人 @ 一下能碰家人机器」 |
| 20 | **每账号一个独立 skills/plugin 目录**，起 turn 时 `--plugin-dir` 指过去 + `--setting-sources` 排掉 user 级 | CLI 没有逐个 skill 开关（见事实 §2）；顺带修掉现状问题：家人的每个 turn 现在都全量加载了你的个人 skill 和插件 |
| 21 | 配置粒度 **per-account**，不做 per-session | per-session 会让决策 9 的「工具集冻结」变成用户可感知的怪事（同一人两个会话工具不一样） |
| 22 | **Windows only**；你自己那台 Mac **不装**客户端 | 家人全是 Windows；你就是服务端，CLI 本来就跑在你机器上、本来就有完整本地访问。macOS TCC 那套顾虑因此完全消失 |
| 23 | **MCP server 内置打包**（`ELECTRON_RUN_AS_NODE=1` 借 Electron 自带的 Node 跑）**+ 保留 npx 逃生口** | 默认路径零依赖，「只装一个客户端」字面成立；npx 首次运行要联网拉包，在家人机器上是首启体验杀手 |
| 24 | **系统浏览器优先**，Chrome / Edge 都要支持，避开下载 Chromium | 零下载；Windows 上 Edge 必然存在。**必须用专属持久 profile 目录**（不是家人日常那个）：扫一次码长期复用，且避开「浏览器已在运行」的独占锁 |
| 25 | **不签名 + NSIS 安装包 + 手动更新（有提示）+ 自启用户可配** | 几个家人、每次你在场；$200/年的证书买不到什么。NSIS 而非 portable，因为自启和托盘在 portable 下都要重写 |
| 26 | 安装包与版本信息由 cc-webui 自托管，版本挂现有 `/api/meta` | 不引入 GitHub 账号体系，不新开路由（`meta.ts` 已经在下发 `features`） |
| 27 | **下载由主进程带 cookie 拉，不用 `shell.openExternal`** | `openExternal` 打开的是家人的**默认浏览器**，那个浏览器很可能从没登录过 cc-webui → 下载失败。主进程本来就持有 WS 用的那份 cookie（决策 14），自己下完再 `shell.openPath` 拉起安装包。**副产品：安装包路由保持鉴权，公开面一条不加** |
| 28 | **启动时自动查一次版本 + 托盘可手动查** | 决策 25 说「有提示」，启动时查是这句话唯一的落点；只靠手点等于没提示 |

### 托盘菜单（决策 8 / 15 / 25 的落点）

```
连接状态：已连接 / 未连接
⏸ 暂停本机工具
☑ 开机自启
检查更新…            → 有新版则原生 dialog，点「下载并安装」
打开 cc-webui        → 拉默认浏览器
退出
```

### 更新链路（决策 25 / 26 / 27 / 28）

**不做静默自动更新**，只提示 + 用户手点一下。完整流程：

1. app 启动时（以及用户手点托盘「检查更新…」时）请求 `/api/meta`
2. `/api/meta` 在现有响应里追加：

   ```jsonc
   {
     "desktopClient": {
       "version": "1.2.0",        // 语义化版本，用 semver 比较，不做字符串不等
       "url": "/api/client/download/cc-webui-setup-1.2.0.exe",  // 需鉴权
       "notes": "……"              // 可选，显示在 dialog 里
     }
   }
   ```

3. 版本更高 → 原生 `dialog` 提示（附 `notes`）
4. 用户点「下载并安装」→ **主进程带 cookie 下载**（决策 27），下完 `shell.openPath` 拉起安装包
5. NSIS 装新版

⚠️ **第 5 步有个必踩的坑**：NSIS 会检测到旧进程在跑并要求关闭，而这个 app 是**关窗口不退出的托盘常驻**
（决策 15）—— 家人很容易以为「我已经关了」。安装引导和 dialog 文案里都要写明**从托盘退出**。
更省事的做法是主进程在拉起安装包前先自己退出。

⚠️ 每次更新都会**重新撞一遍 SmartScreen**（信誉按文件哈希积累，见事实 §4）。

---

## 被否掉的方案

**要推翻其中任何一条，先确认它的否决理由还成不成立。**

| 方案 | 否决理由 |
|---|---|
| 凭据网关 / 反代（`ANTHROPIC_BASE_URL` 指向你 Mac，代理注入 token） | **协议上不合规**（用户判定）。技术上可行 —— `claude setup-token` 能出长期 token，代理注入 `Authorization` 即可，客户端永远看不到凭据 —— 但不走这条 |
| 凭据下发到各机器 | 不合规 + 多机并发刷新同一个 refresh token 会互踢（这是实打实的技术问题）+ 凭据落在别人磁盘上收不回来 |
| sshfs / 挂载家人文件系统到服务端 | **给不了显示器**。微信扫码登录必须有真实浏览器窗口跑在家人的图形会话里，挂载解决不了。（纯文件场景它其实够用且零代码，但覆盖不了核心需求） |
| 全量工具面远程化（禁掉内置 Read/Write/Edit/Glob/Grep，换 `mcp__local__*`） | 要在桌面端重新实现 `Edit` 的精确匹配语义、`Read` 的「改前必读」状态跟踪、图片处理、`Glob/Grep` 遍历；且模型的系统提示词是围绕**内置工具名**调过的 |
| 网页直接连本机 daemon（`http://127.0.0.1:PORT`，不经服务器） | **Chrome 142 起完整执行 PNA/LNA，HTTPS 页面 fetch localhost 默认直接拦**，需显式权限提示。见事实 §3 |
| Tailscale / mesh VPN / 反向隧道 | WS 客户端外连已经解决 NAT，多一个要装的东西 |
| WebSocket 作为 MCP transport 直连 CLI | **MCP 规范里没有 WS transport**，CLI 只认 stdio / sse / http。见事实 §1 |
| 入口区分（`X-CC-Client` 头） | 头可伪造，零安全收益；且「窗口关着但托盘还在」算不算客户端登录，语义含糊 |
| Windows 代码签名证书 | 见决策 25 |

---

## 已核实的事实（2026-08-29，本机实测 / 一手资料）

### §1 MCP transport 与 CLI 参数

- `claude` CLI 版本 **2.1.250**。
- `--mcp-config` 接受 `{type:"http", url, headers:{authorization:"Bearer …"}}`。
  构造代码在 [`server/executors/claude-executor.ts`](../server/executors/claude-executor.ts) 的 `buildMcpConfig`。
- `McpServerSpec` 是 `{ name, url, bearerToken? }`（[`server/executors/types.ts`](../server/executors/types.ts)）
  —— **这个类型不用改就够用**。
- 现有 MCP 路由用官方 `WebStandardStreamableHTTPServerTransport`
  （[`server/mcp-bash-route.ts`](../server/mcp-bash-route.ts)）。
- **MCP 规范没有 WebSocket transport**，CLI 只认 stdio / sse / http。
  → 所以 CLI 那一跳必须 HTTP；WS 只能用在**服务端→设备**那一跳，那是你自己的协议。
- `--strict-mcp-config` 挡住 CLI 去读用户自己的 `~/.claude` MCP 配置，
  但**不挡 skill 和插件**。

### §2 skill / 插件的可控粒度

CLI **没有「逐个 skill 开关」的 flag**。能用的抓手只有：

| flag | 作用 |
|---|---|
| `--setting-sources <user,project,local>` | 逗号分隔，选择加载哪些设置来源 —— **可以排掉 user 级** |
| `--settings <file-or-json>` | 按次注入额外设置 |
| `--plugin-dir <path>` | 从目录或 .zip 加载插件（可重复） |
| `--plugin-url <url>` | 按 session 从 URL 拉插件 .zip（可重复） |
| `--disable-slash-commands` | **全关**所有 skill |
| `--add-dir <directories...>` | 追加允许的工作目录 |
| `--agents <json>` | 内联定义自定义 agent |

⚠️ **当前状态**：CLI 以你的 OS 用户身份跑，所以 `~/.claude/skills/` 和你装的所有插件，
**家人的每个 turn 现在都已经全量加载了**。决策 20 顺带修这个。

### §3 浏览器侧的两条事实

- **Chrome 142 起完整执行 Private Network Access / Local Network Access**：
  HTTPS 页面 fetch `http://127.0.0.1:PORT` **默认被拦**，需要显式权限提示
  （或 iframe 上的 `allow="local-network-access"`）。判定依据包括私有 IP 字面量、`.local` 域名、
  以及 fetch 的 `targetAddressSpace:"local"` 标注。
  → **这才是「必须做客户端」的真实理由**，不是沙盒逃逸。
  来源：<https://developer.chrome.com/blog/local-network-access> ·
  <https://developer.chrome.com/blog/private-network-access-update>
- **浏览器沙盒逃逸确实存在且被在野利用**（CVE-2025-2783，Chrome 的 Mojo IPC 逃逸，
  Operation ForumTroll 中与渲染器漏洞串成完整链）。**但与本设计无关** ——
  本设计任何一处都不依赖浏览器沙盒做隔离，浏览器只是触发器，执行方永远是那个 Electron app。
  来源：<https://www.sangfor.com/farsight-labs-threat-intelligence/cybersecurity/cve-2025-2783-google-chrome-sandbox-escape>

### §4 Windows 侧要注意的

- `npx` 在 Windows 上实际是 `npx.cmd`，`child_process.spawn` 不带 `shell:true` **找不到** —— 经典坑。
  决策 23 的内置打包路径绕过了它，npx 逃生口用到时要处理。
- 不签名的 exe 会撞 **SmartScreen**（「Windows 已保护你的电脑」），要点「更多信息 → 仍要运行」；
  Defender 也可能隔离。**每次更新的新版本都会重来一遍** —— SmartScreen 的信誉按文件哈希积累。
- `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制当普通 Node 进程跑，是决策 23 的实现手段。

---

## 实施期的修正（2026-08-30，服务端落地时发现）

设计评审时的几处判断和代码实际情况对不上。**这一节优先于上面的决策表** ——
上面留着原文是为了保住理由的完整性，但实现按这里走。

### §1 token 走 bearer 头，不在路径里

原文把中继端点写成 `/api/mcp/local/<per-turn token>`。现状是：**现有三条 MCP 路由
（bash / schedule / lark）全部用 `Authorization: Bearer`**（`mcp-bash-route.ts:592/600/612`），
而 `McpServerSpec` 早就有 `bearerToken` 字段，`buildMcpConfig` 会把它拼成
`headers: { authorization: "Bearer …" }`。跟现状走更省事，公开面清单里也只多一个
干净的路径字面量。

实际形状：**`ALL /api/mcp/local/:server`**，路径参数是**本地 MCP server 名**
（`browser` / `fs` / `transfer`），token 在头里。一个 turn 有几个本地 server 就装配
几条 `--mcp-config` 条目，共用同一个 per-turn token。

### §2 ⭐⭐ 决策 19 不能靠检查 ownerId 实现

这是实施期发现的**最危险的一条**。

飞书 turn 的 `ownerId` 不是空的，也不是什么特殊值 —— `auth/actor.ts` 的
`actorForResource()` 会把它解析成 `ownerOf(gid) ?? serviceAdmin()?.id`，也就是
**一个真实存在的管理员账号 id**。而那个管理员（今天就是你）很可能正好有在线设备。

所以任何形如「起 turn 时按 ownerId 查设备，飞书的 ownerId 特殊处理」的写法都会漏，
后果是：**飞书群里任何人 @ 一下 bot，就能在家人的电脑上执行代码**（飞书至今没有
sender 白名单，见 AGENTS.md）。

**正确的实现是结构性的**：只有 `server/chat.ts` 那一处装配 `local-*` 条目。
`groups/claude-runner.ts`、`groups/codex-runner.ts`、`codex-chat.ts` 一律不加。
代码里那一段有对应的 ⚠️ 注释，别删。

### §3 设备 WS 端点不能放在 `/api/mcp/` 下

AGENTS.md 的部署一节要求反代把 `/api/mcp/*` **一律 404**。中继路由放进去正好
（它只被本机 CLI 子进程调用，前缀规则自动覆盖，nginx 一行不用改），但**设备自己的
WebSocket 必须能从公网连上**。放进去的话家人的客户端永远连不上，而现场只能看到一个 404。

实际路径：**`/ws/device`**。反代那条 location 需要：

```nginx
location /ws/device {
    proxy_pass http://127.0.0.1:8789;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;      # 默认 60s 会把长连接切掉
}
```

⚠️ 开发期（`npm run dev`）前端在 8787、API 在 8788，而 vite 的代理**没有开 `ws: true`**，
所以走 8787 的 WebSocket 会失败。开发时让客户端直连 8788。

### §4 session cookie 没有服务端吊销，必须在心跳里重验

`server/auth/session.ts` 的 cookie 是**无状态 HMAC**，没有服务端 session 表，TTL 30 天。
一条只在 upgrade 时验过一次的 WS 会活过登出、活过改密码 —— 决策 14 说的「登出即断连」
在服务端一侧**根本不成立**（`clearedSessionCookie()` 只是让浏览器丢掉 cookie，
已建立的连接毫无感知）。

所以 registry 的每次心跳都跑一遍 `revalidate()`（当前实现是 `getUserById(userId) !== null`，
能抓到销号；要抓到登出还需要一个服务端 session 表或 token 版本号，**尚未做**）。
`revalidate` 自己抛异常时按「不能用」处理 —— fail-closed。

### §5 决策 20 需要改 `server/executors/types.ts`

原文「要动的地方」表里写着这个文件不用改。那句话对**MCP 那一半**是对的
（`McpServerSpec` 确实够用），但决策 20 的 `--plugin-dir` / `--setting-sources`
必须在 `ExecOptions` 上加字段。已加 `pluginDirs?: string[]` 和 `settingSources?: string[]`。

⚠️ 两者 arity 不同，**不能照 `allowedTools` 建模**：`--plugin-dir <path>` 取单值且可重复；
`--setting-sources <sources>` 取一个逗号串且至多出现一次。两者都**不是** variadic。

⚠️ 顺带核实到一条源码注释没写的事实：**`--mcp-config <configs...>` 也是 variadic**
（CLI 2.1.251 的 `--help`）。它今天没炸只是因为 `--strict-mcp-config` 这个 flag
紧跟在它后面。

### §6 `ws` 之前是幻影依赖

`ws@8.20.1` 一直在 `node_modules` 里，但那是 `@larksuiteoapi/node-sdk` 带进来的
**传递依赖** —— 直接 import 属于 phantom dependency，飞书 SDK 换个版本就可能消失。
已显式写进 `package.json` 的 `dependencies`（外加 `@types/ws`）。

### §7 中继不用 MCP SDK 的 transport

其它三条 MCP 路由都用 `McpServer` + `WebStandardStreamableHTTPServerTransport`，
那套东西的用途是「在本进程里实现一个 MCP server」，要先把工具一个个 register 上去。
中继**没有自己的工具** —— 工具在家人机器上，清单只有设备知道。用 SDK 的话得先向设备
`tools/list`、再动态造一个 `McpServer` 把结果 register 一遍，而 `serveMcp` 的 `make`
还是同步签名（`mcp-bash-route.ts:547`），塞不进一次 await。

所以中继是**纯 JSON-RPC 透传**。一个由此产生的、要记住的细节：
**设备不可用时，`tools/call` 回 `result + isError:true`，其它方法回 JSON-RPC error。**
混用的话，一个 `initialize` 失败会被模型当成「工具返回了错误文本」然后一直重试。

---

## 要动的地方

| 动作 | 位置 | 内容 |
|---|---|---|
| **新增** | `server/mcp-local-route.ts` | Streamable HTTP ↔ WS 中继。紧挨 [`mcp-bash-route.ts`](../server/mcp-bash-route.ts)，抄它的 transport 装配 |
| **新增** | `server/devices/` | WS 注册表、一账号一设备约束、心跳 / 重连退避、掉线时挂起调用的错误返回 |
| **改** | [`server/chat.ts`](../server/chat.ts) | 起 turn 时按 `ownerId` 查在线设备 → 动态追加 `mcpServers` 条目 + 改写 `appendSystemPrompt`；skills 侧加 `--plugin-dir` / `--setting-sources` |
| **改** | [`server/db.ts`](../server/db.ts) | 新表：设备（account / 在线状态 / 最后心跳）、per-account 本地 MCP 配置 |
| ~~**不用改**~~ **要改** | [`server/executors/types.ts`](../server/executors/types.ts) | `McpServerSpec` 对 MCP 那一半确实够，但决策 20 要加 `pluginDirs` / `settingSources` —— 见「实施期的修正」§5 |
| **不用改** | [`server/mcp-context.ts`](../server/mcp-context.ts) | per-turn token 已带 `ownerId`，正好当路由键 |
| **不用改** | `shared/permission-flow.ts` | 决策 7 复用现状 |
| **新仓库** | — | Electron 客户端（主进程：WS + MCP host + 托盘；渲染进程：远端 URL 壳） |

### 公开面清单

本设计**不新增公开路由**。`/api/mcp/local/*` 与现有 `/api/mcp/*` 同性质
（per-turn capability token，绕开 `authMiddleware`），因此：

- ⚠️ **反代上必须和 `/api/mcp/*` 一样 404 掉**。
- ⚠️ `policy.test.ts` 里那条公开面断言**必须显式改**，别默默放行。
- 设备 WS 端点**不是**公开面，走正常 cookie 鉴权。
- **安装包下载路由也不是公开面**：由 app 主进程带 cookie 请求（决策 27）。
  ⚠️ 别为了「让家人在浏览器里点链接下载」把它改成公开的 —— 那会同时打破这条清单和
  `policy.test.ts` 的断言。真要改，先改断言并在这里记一笔。

---

## 本设计之外，建议另立项

1. **那个「把文件工具限制在工作目录（含 `--add-dir`）」的 CLI flag** ——
   `claude --help` 里有一段这样的描述（同段还提到「忽略 user/project/local 设置文件」），
   但**没 pin 住 flag 名字**（查的时候权限分类器超时了）。⚠️ 未核实。
   如果属实，它能把 [`user-permissions.md`](./user-permissions.md) 里那句
   「白名单是护栏，不是隔离」变成**真隔离**，价值远超本模块。
2. **飞书 sender 白名单** —— 决策 19 把飞书挡在本地工具之外是权宜。
   哪天想开，先补这个，否则就是「飞书群里任何人能碰家人的电脑」。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-29 | 初版定稿。逐问逐答评审产物，26 条决策 + 8 条否决方案，未实施 |
| 2026-08-30 | 补更新链路。新增决策 27（下载走主进程带 cookie，修掉与「不新增公开路由」的矛盾）、决策 28（启动时自动查版本）；新增「更新链路」一节，写死 `/api/meta` 的 `desktopClient` 字段形状、semver 比较、NSIS 撞托盘常驻进程的坑；公开面清单补一条安装包下载路由 |
| 2026-08-30 | **服务端落地**。新增「实施期的修正」一节（7 条），其中 §2「决策 19 不能靠 ownerId 实现」是实施期发现的最危险的一条。状态从「未实施」改为「服务端已实施，Electron 客户端未实施」 |
