# 取件台（文件管理）— 决策记录与实施计划

> 本文是**设计期文档**。术语看 [CONTEXT.md](../CONTEXT.md)，架构看 [AGENTS.md](../AGENTS.md)。
> 决策来自 2026-08-26 的一轮 grilling，逐条都有理由，改之前先看理由还成不成立。

## 定位

**取件台**，不是文件管理器。agent 已经有完整 shell——「删掉第 3 节」直接说就行。所以这块
界面只该承载**人自己动手比让 agent 动手更快或更可信**的那部分：校对错字、决定要不要发出去。
真实用户是不写代码的老师（`workspaces/rebecca`），不是开发者。

**v1 做**：列本对话文件、预览、文本编辑、Office 编辑、批量删除、下载、上传到本文件夹。
**v1 不做**：重命名、新建文件/文件夹、移动、多选拖拽、目录树导航、群聊会话的文件、回收站。

> **v1 之后补上的（2026-09-10）**：**新建文件夹**（`POST /api/files/mkdir`）和
> **移动**（`POST /api/files/move`）。两条都长在项目文件面板（`FileExplorer.tsx`）上，
> 不是取件台列表。移动的手势就是**拖拽**：拖到文件夹＝移动（悬停 600ms 自动展开，
> 拖到树的空白处＝移回根目录），拖到对话框＝插入相对路径（顺带取代了那颗 `@` 按钮的
> 一半用途）。一度做过的「选中 → 移动按钮 → 目录选择弹窗」已经删掉——拖拽覆盖了它，
> 而那条工具条在 180px 下放不下第五颗按钮。同一批还加了**重命名**
> （`POST /api/files/rename`，悬停出现的铅笔 → 行内输入框，文件和文件夹都行），
> 并**删掉了「@ 插入路径」那颗按钮**（拖到对话框是同一件事）。仍然不做：回收站。
>
> **删空文件夹（2026-09-23）**：文件夹行也能右键进多选，`POST /api/files/delete` 对目录
> 只用 **`rmdir`**（不递归）——它自己拒绝非空目录，「空不空」和「删」是同一个系统调用，
> 所以非空的一律原样留下并回「文件夹不是空的」。只剩 Finder 塞的 `.DS_Store` 算空；
> 白名单规则的根目录本身不删。**递归删目录仍然不做**（这个仓库出过事故的形状）。
> 选中里有文件夹时「下载」灰掉（`/download` 只收文件）。测试在 `server/files-delete-dir.test.ts`。

## 决策表

| # | 决定 | 理由（一句） |
|---|---|---|
| 1 | 定位＝取件台 | 用户是老师不是开发者，IDE 侧栏那套他用不上而你有终端 |
| 2 | 入口＝顶栏一颗按钮开右侧格；**唯一的文件列表就是项目树**，操作挂在树上；**树常驻左栏、打开的文档在右栏**（不是两个标签） | **返工过两次**（2026-08-27）：① 原来做成「左侧栏的对话/文件 tab」，而项目文件树在右边 ⇒ 按钮在右上角、开出来的东西在左边；② 挪进右侧格后变成「项目 / 本对话」两个都叫文件的标签，用户直接问「项目和文件不是一样的吗」。定论是用户原话：「我要的只是项目文件，然后要有对项目文件做操作的这些模块」 |
| 3 | 呈现＝右侧格（照律枢 `RightDock`），可拖宽、可折叠 | Office 编辑器是 iframe，需要真画布；同时保住「边看对话边看产出」 |
| 3a | **宽度按内容分两档，两档各记各的**：列表档 22%/min 260，编辑器档 52% | 律枢原来是「只放不收」的棘轮——打开过一次文档就把 52% 记死，此后关掉所有文档、那一格只剩一张列表也还占半屏（它真机被说了两次「太宽」）。我第一版照抄了那个 bug 而不是它的修复 |
| 3f | **开关只有一颗、窗口右上角固定、图标永不变**，状态只用背景色。2026-10-08 圆角适配：桌面始终 right 24/top 24，主栏整个顶栏加 12px 上边距，与文件栏动作共用 y=40 中线；手机始终 top 6/right 12、44px 触摸面积。各表头同步预留按钮空间 | 不能再单独挪按钮：先前状态相关坐标会漂移，而仅固定旧坐标又让按钮贴到文件栏圆角上。本次统一所有桌面工具栏的基线；开/关位置完全不变 |
| 3g | 编辑器**必须让 `.cm-scroller` 自己滚**：`.cm-editor` 给 `height:100%`，外层容器不许挂 overflow | CodeMirror 官方的「内部滚动」配方。原来是外层 `overflow-auto` + 编辑器不限高 ⇒ `.cm-editor` 长到整份文档的高度、外层在滚 ⇒ **视口虚拟化被绕过、整份文档一次全渲染**。用户反馈「编辑器有点不跟鼠标、总是卡卡的」 |
| 3c | **树和预览并排**：左栏树（默认 240px，可拖，min 180）＋ 右栏文档（标签叠在上面）；只有树时树占满整格，宽度回窄档 | 用户原话「点击项目文件名称之后，左边是项目树右边是预览，这样才方便」——树是导航，点一个文件不该把导航换掉。宽档默认 0.5：试过 0.62，1600px 窗口下主栏只剩 292px，顶栏和输入框开始互相叠 |
| 3d | 内层分隔条要 `originFrom="parent"` + ResizeObserver 跟着父容器重夹 | 按窗口算会把左侧栏和主栏宽度算进去、一拖就跳；而 `.dockcol` 有 140ms 宽度过渡 ⇒ 挂载那刻量到的是过渡前的宽度，min/maxRatio 按错的跨度夹（实测树栏第一次打开总是 180→211px，改默认值没用） |
| 3e | 主栏顶栏要能**让位**：地方不够时依次藏搜索框、via 徽标、「新对话」文字、会话 id | 右侧格能拖到很宽，主栏可以只剩两三百像素。那几块原来是 `shrink-0`，结果不是变窄而是互相叠（真机截图上是「W▓b.Co▓Claude」，看着像坏了） |
| 3b | 分隔条：宽度写 CSS 变量、不走 React state；拖动时盖全屏透明遮罩 + 关掉宽度过渡；存绝对像素并在 resize 时重夹 | 四条全是律枢 `Splitter.tsx` 踩出来的：每帧 setState 会重渲染整条对话（发涩）；ONLYOFFICE 的 iframe 会吞掉鼠标事件（拖到一半断连）；140ms 过渡会让面板慢一拍（线不跟手）；存的是像素，换小屏不重夹会把另一侧挤没 |
| 4 | ~~「本对话文件」＝ turn 收尾快照比对 + SQLite registry~~ **已撤（2026-08-27）** | 做出来之后用户看着空列表说「这个本对话似乎没有用啊」。UI 撤掉，**每个 turn 收尾扫一遍 cwd 的那次登记也撤掉**——它按目录规模计费（实测 0.2ms / 307ms / 3.05s），没有消费者就是纯开销。`session_files` 表、`GET /api/files`、`session-files.ts` 留在原地但**再没有写入方**；要恢复就把 `chat.ts` 里那段 `recordTouchedFiles` 接回去（见 git `5ba4202`）。当时的判断（agent 主要走 `mcp__bash__run` 写盘、只认 `Write`/`Edit` 会漏）没错，错的是「用户需要按会话过滤的第二个列表」 |
| 5 | registry 每路径一行，挂进 sessionId relabel 链 | 首个 turn 的 id 会被 CLI 换掉，不 relabel 就查不出来 |
| 6 | 白名单外的路径直接过滤不显示 | 列一个碰不了的路径只制造困惑；也别把「agent 写到哪儿了」漏给别的账号 |
| 7 | 文本编辑＝CodeMirror 6，**动态 import 懒加载** | 用户要高亮；主 bundle（488KB）不为一个校对场景涨 200KB |
| 8 | Office 编辑＝ONLYOFFICE，复用现成容器 | `office.freeaitech.top:8443` 已公网可达，基建成本≈0 |
| 9 | Office 预览降级＝先只用浏览器原生（Edge） | 用户选择；实测掉成下载再补 `soffice→PDF`（本机已装） |
| 10 | 保存只认 `status=6`（forcesave） | 这块地没 git 没回收站，「看一眼手滑关窗」不该变成静默覆盖 |
| 11 | **原路径永远是 agent 那份**；人的版本冲突时旁存 | 用户定的「以 agent 为主」；旁存保证人白改一小时不凭空消失 |
| 12 | 文本保存＝乐观锁（`ifMatch` mtime+size） | 人写半小时的东西不能被静默覆盖，成本只是多带一个字段 |
| 13 | 删除＝真删、批量、确认弹窗、**留痕**（见下「更正：审计」） | 不做回收站的前提就是留痕；多用户+批量+真删，「谁删的」必须查得到 |
| 13a | **多选靠右键进入**，勾选框平时连位置都不占；退出＝取消按钮 / Esc / 取消到一个不剩 | 用户原话「多选框应该去掉，应该做一个右键点击多选之后，才出现动态加载多选框」——常驻勾选框让一棵目录树看着像一排表单 |
| 14 | 上传新按钮落会话 cwd；Composer 那条**不动** | Composer 落 `/tmp` 是有意的（不污染项目目录），那是另一笔账 |
| 15 | 打开的 tab ＝内存态，刷新即清 | 取件台是「进去取件、改完出来」，不欠「tab 指向的文件被删了」这类状态债 |
| 16 | 列表刷新＝turn 结束自动刷 + 手动按钮，**不上 watcher** | 递归 watcher 在 launchd + macOS TCC 的雷区里（见 AGENTS.md） |
| 17 | 去掉预览窗的「@ 插入」 | 用户定的 |
| 18 | **下载＝右键多选里的一颗按钮**；选一个下那个文件，选多个由**服务端**打成一个 zip（`server/zip.ts`，store 不压缩、data descriptor、全程流式） | 用户原话「右键增加一个下载功能吧，现在只能删除不能下载呢」——操作挂在右键那套多选上（决策 13a），不另开一层右键菜单。**不做「连着触发 N 次下载」**：浏览器会把第二个之后的当弹窗拦，用户误点一次「阻止」之后所有下载都**静默**失败、页面这边收不到任何事件。zip 自己写而不加依赖，是因为只需要「把几个盘上的文件塞进一个壳」；不压缩是因为取件台里多半是 xlsx/docx/png（自身已压过），换来的是不用管压缩流的背压 |
| 19 | **幻灯片多一颗「放映」按钮：最大化 + 真·全屏（Fullscreen API 打在我们自己的容器上）**，只对 `.pptx/.ppt/.odp` 且 ONLYOFFICE 在跑时出现；「最大化」保持原样（只铺满窗口） | 用户 2026-09-20 的原话「放映没有全屏啊」——原来只有「最大化」这一档，放映跑在右侧那一格里，16:9 的幻灯片按那格宽度缩成一小块、上下两条大黑边。**分成两颗而不是升级那一颗**：编辑 docx 时把地址栏一起吞掉只会碍事，而全屏这一层是有代价的——Esc 要按两下（容器自己的 zh.json 写着：「第一次按 Esc 键会退出浏览器全屏模式，第二次按 Esc 键会退出放映模式」），只让放映付。⚠️ **「开始放映」那一下只能用户自己点 ONLYOFFICE 工具栏的「开始幻灯片放映」**：api.js 的公开方法表里没有任何启动放映的命令（整表查过），跨源也没法替它按键——所以进去之后有一行 6 秒的提示。⚠️ 退出全屏时**只摘全屏、`maxed` 留着**：那时放映器多半还开着，这就缩回右侧那格等于又变回用户报的那张图 |

## 数据模型

```sql
CREATE TABLE session_files (
  session_id      TEXT    NOT NULL,
  path            TEXT    NOT NULL,   -- 绝对路径
  first_seen_ms   INTEGER NOT NULL,
  last_touched_ms INTEGER NOT NULL,
  size            INTEGER,
  mtime_ms        INTEGER,
  PRIMARY KEY (session_id, path)
);
CREATE INDEX idx_session_files_recent ON session_files(session_id, last_touched_ms DESC);
```

**只有 `server/db.ts` 碰 SQLite 驱动**（既有约定），这张表照 `groups_index` 的写法加。

### 判定「这个 turn 碰过哪些文件」

turn 开始时记 `turnStartMs`；turn 收尾扫一遍 cwd，**`mtime >= turnStartMs` 即算这个 turn 碰过**。
一次扫描搞定，不需要开头再扫一次做内存快照。同一趟顺手把 registry 里已不存在的行删掉。

护栏（缺一个都会在代码仓库当 cwd 时炸）：

- 跳过表：`node_modules` `.git` `dist` `build` `.venv` `__pycache__` `.next` `target`
- 深度上限
- 文件数上限（建议 2 万）：超了就**退化成只认 `Write`/`Edit` 报告过的路径**，并在日志里说清降级了
- 一个 turn 只扫一次，在收尾处，不是每个事件

实测成本（本机，全量 `os.walk` + `stat`）：

| cwd | 文件数 | 耗时 |
|---|---|---|
| `~/.cc-webui/workspaces` | 6 | **0.2 ms** |
| `~/code/cc-webui`（含 node_modules） | 14225 | 307 ms |
| `~/tmp` | 122442 | 3.05 s |

开销全在文件系统，不在 DB。目标场景（老师的工作区）等于免费。

### relabel 链

`chat.ts` 里 CLI 发出真 `session_id` 时，已经在一处把 allowance / tasks / ownership 一起改名
（`relabelScope` / `relabelTasksSessionId` / `relabelOwner`）。**`session_files` 必须加入同一处**，
否则首个 turn 的文件永远挂在一个死 id 下。

## 服务端端点

全部经 `assertCanOpen(path, 当前 actor 的白名单)`，**返回值用它返回的规范化路径**，不要再自己拼。

| 端点 | 用途 | 备注 |
|---|---|---|
| `GET /api/files?sessionId=` | 本对话文件列表 | 白名单外的行过滤掉 |
| `PUT /api/files/content` | 保存文本 | 带 `ifMatch: {mtimeMs,size}`，不匹配回 409 |
| `POST /api/files/delete` | 批量删除 | 真删 + 写 `file_deletions`；⚠️ 白名单在处理器里逐个查（见下） |
| `GET /api/files/download?path=&path=` | 下载 | 一个＝原文件，多个＝zip；⚠️ `path` 可重复，而中间件只看第一个 → 白名单在处理器里逐个查（见下） |
| `POST /api/files/upload` | 上传到会话 cwd | multipart |
| `POST /api/files/mkdir` | 新建文件夹 | 落点过白名单（policy 声明 `paths: body.dir`）。**名字不合法就拒、重名回 409**——和上传的「消毒改名 + 加序号」刻意不同：上传的名字来自文件系统，这里的名字是用户刚敲的 |
| `POST /api/files/rename` | 原地改名 | ⚠️ **同目录换名字也可能越界**（白名单是 glob，`x/*.md` 下 a.md→a.txt 就掉出去了），所以源和「改完之后」各查一次。撞名回 409（`fs.rename` 会静默覆盖）；名字没变当成功。目录改名时 `session_files` 里**它底下每一行**都跟着改（前缀替换） |
| `POST /api/files/move` | 移动（可多选） | ⚠️ **源和目标各查一次白名单**（只查一头都能穿）；`paths` 是数组 → handlerScoped。⚠️ **`fs.rename` 会静默覆盖同名文件**，所以同名一律拒；跨设备 EXDEV 回退成 `cp` 成功后再 `rm`。`session_files` 里的路径跟着改（`relocateSessionFiles`，**不按 sessionId 过滤**——磁盘上只有一个文件） |
| `GET /api/office/config?path=` | 下发 EditorConfig | cookie 鉴权，JWT 签名 |
| `GET /api/office/download?ticket=` | **容器**取文件 | 票据鉴权（容器没有 cookie） |
| `POST /api/office/callback?ticket=` | **容器**回调 | 验 JWT，只认 `status=6` |

⚠️ 后两条无 cookie，但容器走 `host.docker.internal:8789`（本机环回），**不经 nginx**
——所以 nginx 那边应当和 `/api/mcp/*` 一样直接 404 掉它们。

## ONLYOFFICE 接线

照律枢 `do_prod` 的三条 URL，只有第一条需要公网：

| 变量 | 方向 | 值 |
|---|---|---|
| `CC_WEBUI_OFFICE_URL` | 浏览器 → 容器 | `https://office.freeaitech.top:8443`（现成） |
| `CC_WEBUI_SELF_INTERNAL_URL` | 容器 → cc-webui（取文件/回调） | `http://host.docker.internal:8789` |
| `CC_WEBUI_OFFICE_JWT_SECRET` | 签名 | **必须与容器 `JWT_SECRET` 一致**，否则容器一律拒签 |

（律枢还有第四条 `LVSHU_OFFICE_INTERNAL_URL`，用于**服务端主动**触发 forcesave。
cc-webui **没有实现那条路**，所以也**没有**这个环境变量——现在的保存全部由用户在编辑器里
点保存触发。别照着律枢把它加进配置文档：有文档有配置零调用方，就是 `FEISHU_USE_WEBHOOK`
那个死 flag 的长相。）

**`CC_WEBUI_OFFICE_URL` 留空 = Office 在线编辑整体关闭，前端回落只读预览。** 这是有意的降级
路径，不是故障——容器是律枢那个栈的（固定 compose 项目名 `lvshu-office`，`./lvshu.sh stop`
会把它停掉），它不在时必须还能用。

保存流程：容器 `status=6` 回调 → 验 JWT → 比对 `mtime`：
- 未变 → 落盘
- 已被 agent 改过 → **不覆盖**，把容器给的新版本写成 `<原名>.我的修改-<时间戳>.<ext>`，回复用户

## 前端

```
src/components/RightDock.tsx          App 层唯一一份，Splitter + 内部 tab 栏
src/components/FileExplorer.tsx       右侧格「项目」标签：目录树 + 操作（多选删除、上传到当前
                                      文件夹、刷新、@插入、下载、单击在右侧打开、⌘+单击浮窗速览）
                                      （原 files/FilesPanel.tsx 已删——决策 4 撤下）
src/components/files/TextEditor.tsx   CodeMirror 6（动态 import）
src/components/files/OfficeEditor.tsx ONLYOFFICE iframe
src/lib/dock-bridge.ts                模块级通道，不逐层传回调（照律枢 dockBridge）
src/lib/files.ts                      API 客户端
```

⚠️ **`RightDock` 必须挂在 `App` 层，且切换视图/会话时不卸载。** 律枢的注释写着为什么：
各处各渲染一份的话，切走就卸载，**销毁 OnlyOffice iframe 累积三次再也打不开**。藏 ≠ 卸载。

窄屏（`useIsNarrow`）：右侧格改成全屏覆盖，复用现有抽屉那套。

`源码 / 渲染` 开关与今天做的预览合流：**渲染 = `Markdown.tsx`，源码 = CodeMirror（可编辑）**，
一个开关两种形态，不做两套 UI。

## 已实施（2026-08-26）

阶段 1-5 全部落地，`npm test` 20/20、typecheck 干净、build 通过。**尚未在真浏览器里
端到端验过**（生产实例当时没重启）。

### 一处必须记下的更正：审计

设计阶段我说「审计设施你已经有了」——**那是错的**。`docs/user-permissions.md` 的
「明确不做的」里写着「不做审计日志（决策 11 明确选了静默）」，这个仓库里没有任何审计
设施。用户当时是基于那个错误前提同意「删除进审计流」的。

实际做法：**只为删除建一张 `file_deletions` 表**（迁移 4），不是通用审计日志——
那条决策不动。理由是删除这件事的组合特别危险：真删 + 批量 + 无回收站 + 多用户 +
这块地既没 git 也没快照。表里冗余存一份 username，因为账号可以被删掉，而这条记录的
全部意义就是**事后**回答「是谁」。`listDeletions()` 是给以后的管理页面留的读口
（现在无调用方，但没有读口的留痕等于没有留痕）。

### 实现时才发现的几件事

- **`valueFrom` 只认字符串**：中间件读 body 用 `c.req.json()` 且要求
  `typeof v === "string"`。于是两处不能照抄「paths 声明」——批量删除的 `paths` 是
  **数组**（声明了会静默取不到值 → 400，标 optional 更糟：等于完全不检查），
  上传是 **multipart**（JSON 解析不出来）。前者改成在处理器里逐个 `assertCanOpen`
  并在 policy 表里写明原因，后者把目标目录挪到 **query**。
- **删除必须清 registry 的两种路径形式**：unlink 用的是 `assertCanOpen` 返回的规范化
  路径（macOS 上 `/var/…` → `/private/var/…`），而 registry 里那行是按会话 cwd 的写法
  存的。只清一种，另一种会一直留在列表里直到下一个 turn 的 prune。**这是测试抓出来的
  真 bug，不是断言写错。**
- **office 的乐观锁基准放在签名票据里**（`m` = 编辑会话开始时的 mtime）。最初写成
  「最近 5 秒内被别人改过」的时间启发式，那种规则怎么调都是错的。另外要记住自己写过
  什么，否则同一次编辑会话里的第二次 forcesave 会被自己判成冲突，从此每次保存都生成
  一个新的旁存文件。
- **公开面被 `policy.test.ts` 钉住**：加那两条 office 路由时它先红了一次，必须显式改
  「the public surface must stay exactly this」那条断言。这是设计意图。
- **刻意没有引入 server→容器 那条 URL**（服务端主动触发 forcesave 用的）：现在没有
  调用方，而这个仓库已经有一个 `FEISHU_USE_WEBHOOK` 那样的死 flag（有文档、有配置、
  零调用方），不再造第二个。

## 实施顺序（每阶段可独立验收）

1. **registry**：建表 + turn 收尾扫描 + relabel + `GET /api/files` + 「文件」标签（只列）。
   验收：让 agent 用 bash 写一个文件，turn 结束后它出现在列表里。
2. **RightDock + 文本编辑**：Splitter、tab 栏、CodeMirror 懒加载、乐观锁保存（409 提示重新打开）。
3. **删除与上传**：批量选择、确认弹窗、审计写入、「上传到本文件夹」。
4. **Office**：`/api/office/*` 三条 + JWT + forcesave + 冲突旁存；浏览器原生预览与降级实测
   （拿 Edge 打开一份 docx，掉成下载就补 `soffice→PDF` + 按 `路径+mtime` 缓存）。
5. **清理**：移除预览窗的「@ 插入」。

## 雷区清单

- **不要上递归 `fs.watch`**：launchd 起的进程读 `~/Documents` 会被 macOS TCC 永久挂住，
  `server/fs.ts` 的 `readdirOrGiveUp`（800ms 超时 + 进程级黑名单）就是为此存在的。
- **不要把 `RightDock` 渲染多份**（见上）。
- **不要让扫描无上界**：`~/tmp` 那种 12 万文件的目录会让每个 turn 多花 3 秒。
- **不要依赖律枢的容器还活着**：降级路径必须先于编辑功能可用。
- **不要把 `/api/office/{download,callback}` 暴露到 nginx**：它们只被本机容器调用。
