# 取件台（文件管理）— 决策记录与实施计划

> 本文是**设计期文档**。术语看 [CONTEXT.md](../CONTEXT.md)，架构看 [AGENTS.md](../AGENTS.md)。
> 决策来自 2026-08-26 的一轮 grilling，逐条都有理由，改之前先看理由还成不成立。

## 定位

**取件台**，不是文件管理器。agent 已经有完整 shell——「删掉第 3 节」直接说就行。所以这块
界面只该承载**人自己动手比让 agent 动手更快或更可信**的那部分：校对错字、决定要不要发出去。
真实用户是不写代码的老师（`workspaces/rebecca`），不是开发者。

**v1 做**：列本对话文件、预览、文本编辑、Office 编辑、批量删除、上传到本文件夹。
**v1 不做**：重命名、新建文件/文件夹、移动、多选拖拽、目录树导航、群聊会话的文件、回收站。

## 决策表

| # | 决定 | 理由（一句） |
|---|---|---|
| 1 | 定位＝取件台 | 用户是老师不是开发者，IDE 侧栏那套他用不上而你有终端 |
| 2 | 入口＝侧栏「对话 / 文件」tab 切换 | 现有 `FileExplorer` 就在侧栏里，这是升级不是再造一根栏 |
| 3 | 呈现＝右侧格（照律枢 `RightDock`），可拖宽、可折叠 | Office 编辑器是 iframe，需要真画布；同时保住「边看对话边看产出」 |
| 4 | 「本对话文件」＝ turn 收尾快照比对 + SQLite registry | agent 主要用 `mcp__bash__run` 写盘，只认 `Write`/`Edit` 会漏掉主路径 |
| 5 | registry 每路径一行，挂进 sessionId relabel 链 | 首个 turn 的 id 会被 CLI 换掉，不 relabel 就查不出来 |
| 6 | 白名单外的路径直接过滤不显示 | 列一个碰不了的路径只制造困惑；也别把「agent 写到哪儿了」漏给别的账号 |
| 7 | 文本编辑＝CodeMirror 6，**动态 import 懒加载** | 用户要高亮；主 bundle（488KB）不为一个校对场景涨 200KB |
| 8 | Office 编辑＝ONLYOFFICE，复用现成容器 | `office.freeaitech.top:8443` 已公网可达，基建成本≈0 |
| 9 | Office 预览降级＝先只用浏览器原生（Edge） | 用户选择；实测掉成下载再补 `soffice→PDF`（本机已装） |
| 10 | 保存只认 `status=6`（forcesave） | 这块地没 git 没回收站，「看一眼手滑关窗」不该变成静默覆盖 |
| 11 | **原路径永远是 agent 那份**；人的版本冲突时旁存 | 用户定的「以 agent 为主」；旁存保证人白改一小时不凭空消失 |
| 12 | 文本保存＝乐观锁（`ifMatch` mtime+size） | 人写半小时的东西不能被静默覆盖，成本只是多带一个字段 |
| 13 | 删除＝真删、批量、确认弹窗、进审计流 | 不做回收站的前提就是留痕；多用户+批量+真删，「谁删的」必须查得到 |
| 14 | 上传新按钮落会话 cwd；Composer 那条**不动** | Composer 落 `/tmp` 是有意的（不污染项目目录），那是另一笔账 |
| 15 | 打开的 tab ＝内存态，刷新即清 | 取件台是「进去取件、改完出来」，不欠「tab 指向的文件被删了」这类状态债 |
| 16 | 列表刷新＝turn 结束自动刷 + 手动按钮，**不上 watcher** | 递归 watcher 在 launchd + macOS TCC 的雷区里（见 AGENTS.md） |
| 17 | 去掉预览窗的「@ 插入」 | 用户定的 |

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
| `POST /api/files/delete` | 批量删除 | 真删 + 写审计 |
| `POST /api/files/upload` | 上传到会话 cwd | multipart |
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
| `CC_WEBUI_OFFICE_INTERNAL_URL` | cc-webui → 容器（forcesave） | `http://127.0.0.1:8890`，**不走公网** |
| `CC_WEBUI_SELF_INTERNAL_URL` | 容器 → cc-webui（取文件/回调） | `http://host.docker.internal:8789` |
| `CC_WEBUI_OFFICE_JWT_SECRET` | 签名 | **必须与容器 `JWT_SECRET` 一致**，否则容器一律拒签 |

**`CC_WEBUI_OFFICE_URL` 留空 = Office 在线编辑整体关闭，前端回落只读预览。** 这是有意的降级
路径，不是故障——容器是律枢那个栈的（固定 compose 项目名 `lvshu-office`，`./lvshu.sh stop`
会把它停掉），它不在时必须还能用。

保存流程：容器 `status=6` 回调 → 验 JWT → 比对 `mtime`：
- 未变 → 落盘
- 已被 agent 改过 → **不覆盖**，把容器给的新版本写成 `<原名>.我的修改-<时间戳>.<ext>`，回复用户

## 前端

```
src/components/RightDock.tsx          App 层唯一一份，Splitter + 内部 tab 栏
src/components/files/FilesPanel.tsx   侧栏「文件」tab 的列表（多选、删除、上传、刷新）
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

## 实施顺序（每阶段可独立验收）

1. **registry**：建表 + turn 收尾扫描 + relabel + `GET /api/files` + 侧栏「文件」tab（只列）。
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
