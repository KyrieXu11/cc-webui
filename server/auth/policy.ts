// Declarative authorization, one entry per registered route.
//
// Why a table instead of a check inside each handler: the failure mode of
// per-handler checks is "someone adds a route and forgets", and in this codebase
// forgetting means EXPOSURE — the underlying stores are shared and unscoped, so
// the default is open, not closed (see docs/user-permissions.md).
//
// So: the middleware refuses any route with no entry here (fail-closed), and
// server/auth/policy.test.ts enumerates Hono's own route list and asserts every
// one is covered. A new route is therefore broken until it is classified, which
// is the opposite of silently public.

import type { AccessLevel, ResourceKind } from "./ownership.ts";

// Where to read a value out of the request.
export type ValueSource = "param" | "query" | "body";

export type OwnsSpec = {
  from: ValueSource;
  key: string;
  kind?: ResourceKind; // omitted = any kind
  // Absent value means "not addressing a specific resource" (e.g. cancel with
  // no session id yet) rather than a violation.
  optional?: boolean;
  // Every resource id in this app is a UUID (Claude session, Codex thread,
  // gid). Enforced BEFORE the admin bypass, because an admin bypassing the
  // ownership check must not also bypass the format check — that is what let
  // `DELETE /api/groups/%2e%2e%2f%2e%2e` reach fs.rm(recursive) on $HOME.
  // Set false only for an id that genuinely is not a UUID.
  uuid?: false;
  // "owner" (default) — only the owner may pass.
  // "reader"          — the owner, OR someone the owner shared it with
  //                     (server/auth/sharing.ts).
  //
  // ⚠️ Read-shaped routes only. A share is permission to READ and to keep the
  // conversation going; it is NOT ownership, so DELETE and the config-mutating
  // routes must stay on the default. Leaving `access` off is always the safe
  // choice, which is why the default is the strict one.
  access?: AccessLevel;
};

export type PathSpec = {
  from: ValueSource;
  key: string;
  optional?: boolean;
  // What the HANDLER will use when the caller omits this value. Without it,
  // `optional: true` means "no cwd in the body → no check at all", while the
  // handler quietly falls back to CC_WEBUI_CWD or the server's own directory —
  // so an account with an empty whitelist could still start a turn, inside the
  // cc-webui checkout. The check has to see the effective value, not the
  // literal one.
  fallback?: "serverCwd";
};

export type RoutePolicy = {
  // public   — reachable with no cc-webui identity at all
  // user     — any authenticated account
  // admin    — role === "admin"
  auth: "public" | "user" | "admin";
  // Resource must be owned by the caller (admins bypass — decision 11).
  owns?: OwnsSpec;
  // Filesystem paths in the request must fall inside the caller's whitelist.
  paths?: PathSpec[];
  // The handler narrows its own result set by owner. Declared so the coverage
  // test can tell "deliberately handler-scoped" from "nobody thought about it".
  handlerScoped?: true;
  // Why a route carries no resource check at all.
  note?: string;
};

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

// The MCP routes authenticate with their own per-turn bearer token
// (server/mcp-context.ts); they are not user-facing and carry no cookie.
const MCP_NOTE = "per-turn bearer token, not a user session";

export const ROUTE_POLICIES: Record<string, RoutePolicy> = {
  // ── auth ──────────────────────────────────────────────────────────────────
  "POST /api/auth/login": { auth: "public", note: "the way in" },
  "POST /api/auth/logout": { auth: "public", note: "clearing a cookie needs no identity" },
  "GET /api/auth/me": { auth: "public", note: "returns {user:null} when anonymous" },
  // 共享面板的选人列表：只有 id + username + role。
  //
  // 跟着决策 41 一起是 admin —— 只有管理员发起共享，就没有理由让普通用户看到
  // 这台机器上有哪些账号。**故意不复用 `GET /api/admin/users`**：那条回的是
  // 管理页面要的东西（白名单、工作区、资源计数），共享面板不该依赖它的形状，
  // 而且哪天共享放开给普通用户，这里改一个词就够。
  "GET /api/auth/directory": { auth: "admin", note: "id + username roster, no secrets" },

  // ── admin management ──────────────────────────────────────────────────────
  // No owns/paths specs: these routes are ABOUT users and mappings, not about
  // a caller's own resources, and role === "admin" is the whole gate.
  "GET /api/admin/users": { auth: "admin", note: "the admin surface" },
  "POST /api/admin/users": { auth: "admin", note: "the admin surface" },
  "PATCH /api/admin/users/:id": { auth: "admin", note: "the admin surface" },
  "DELETE /api/admin/users/:id": { auth: "admin", note: "the admin surface" },
  "POST /api/admin/claim-unowned": { auth: "admin", note: "the admin surface" },
  "GET /api/admin/opened-projects": { auth: "admin", note: "the admin surface" },
  "GET /api/admin/feishu-senders": { auth: "admin", note: "the admin surface" },
  "PUT /api/admin/feishu-senders": { auth: "admin", note: "the admin surface" },

  // ── web single chat (Claude) ──────────────────────────────────────────────
  // `owns` on the resume id is NOT decoration: body.sessionId goes straight into
  // the CLI's `resume:` (server/chat.ts), so without it any account could carry
  // on someone else's conversation just by knowing its id — the path whitelist
  // is the only thing that ever stood in the way, and it lines up by
  // construction for two accounts pointed at the same folder.
  //
  // `reader`, not `owner`: continuing a shared conversation is the point of
  // sharing it. Safe because every permission decision inside the turn is
  // re-derived from the CALLER, not from the session's owner — the cwd check
  // right below, the permission cards (chat.ts passes `ownerId`), and the bash
  // MCP path guardrail all read the account that sent this request.
  "POST /api/chat": {
    auth: "user",
    owns: {
      from: "body",
      key: "sessionId",
      kind: "claude",
      optional: true,
      access: "reader",
    },
    paths: [{ from: "body", key: "cwd", optional: true, fallback: "serverCwd" }],
  },
  "POST /api/chat/cancel": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "claude", optional: true, access: "reader" },
  },
  // 插话（往正在跑的那一轮里塞一条消息）。和 cancel 同一档：被共享者能续聊，
  // 自然也能插话 —— turn 里每个权限判断本来就是按**调用者**重新推导的。
  "POST /api/chat/steer": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "claude", optional: true, access: "reader" },
  },
  "GET /api/chat/inflight": { auth: "user", handlerScoped: true },
  "GET /api/chat/wakeups": { auth: "user", handlerScoped: true },
  "POST /api/chat/wakeups/cancel": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "claude", access: "reader" },
  },
  "GET /api/chat/attach": {
    auth: "user",
    owns: { from: "query", key: "sessionId", kind: "claude", optional: true, access: "reader" },
  },

  // ── web single chat (Codex) ───────────────────────────────────────────────
  //
  // Ordinary accounts need an explicit administrator grant (user_ai_access).
  // middleware checks it on every start; resume still requires reader access.
  // Codex has no per-tool approval channel; granting it is a deliberate policy
  // choice, not an admin-role promotion. Bypass remains admin-only.
  "POST /api/codex/chat": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "codex", optional: true, access: "reader" },
    paths: [{ from: "body", key: "cwd", optional: true, fallback: "serverCwd" }],
  },
  "POST /api/codex/chat/cancel": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "codex", optional: true, access: "reader" },
  },
  "GET /api/codex/chat/inflight": { auth: "user", handlerScoped: true },
  "GET /api/codex/chat/attach": {
    auth: "user",
    owns: { from: "query", key: "sessionId", kind: "codex", optional: true, access: "reader" },
  },

  // ── group chat (only mounted when CC_WEBUI_GROUPS_ENABLED) ────────────────
  "GET /api/groups": { auth: "user", handlerScoped: true },
  "POST /api/groups": {
    auth: "user",
    paths: [{ from: "body", key: "cwd", optional: true, fallback: "serverCwd" }],
  },
  "GET /api/groups/inflight/all": { auth: "user", handlerScoped: true },
  // Reading a group config accepts a share; every mutating route below stays on
  // the default. There is no UI for sharing a group yet — this is here so the
  // rule is uniform when there is.
  "GET /api/groups/:gid": {
    auth: "user",
    owns: { from: "param", key: "gid", kind: "group", access: "reader" },
  },
  "PATCH /api/groups/:gid/config": {
    auth: "user",
    owns: { from: "param", key: "gid", kind: "group" },
  },
  "DELETE /api/groups/:gid": { auth: "user", owns: { from: "param", key: "gid", kind: "group" } },
  "POST /api/groups/:gid/turn": {
    auth: "user",
    owns: { from: "param", key: "gid", kind: "group" },
  },
  "GET /api/groups/:gid/stream": {
    auth: "user",
    owns: { from: "param", key: "gid", kind: "group" },
  },
  "POST /api/groups/:gid/stop": {
    auth: "user",
    owns: { from: "param", key: "gid", kind: "group" },
  },

  // ── filesystem ────────────────────────────────────────────────────────────
  "GET /api/fs/home": { auth: "user", note: "returns $HOME, no caller-supplied path" },
  "GET /api/fs/read": { auth: "user", paths: [{ from: "query", key: "path" }] },
  "GET /api/fs/raw": { auth: "user", paths: [{ from: "query", key: "path" }] },
  "GET /api/fs/tree": { auth: "user", paths: [{ from: "query", key: "path" }] },
  // 项目记忆（只读）。能看哪个项目的记忆 = 能不能打开这个项目：白名单查的是 cwd，
  // 读哪些文件由服务端 readdir 决定，不收调用方给的文件名（见 memory-routes.ts）。
  "GET /api/project-memory": { auth: "user", paths: [{ from: "query", key: "cwd" }] },
  "POST /api/project-memory/import": { auth: "user", paths: [{ from: "body", key: "cwd" }] },
  "ALL /api/mcp/memory": { auth: "public", note: MCP_NOTE },
  "GET /api/memory": { auth: "user", paths: [{ from: "query", key: "cwd" }] },
  "GET /api/fs/scan": { auth: "user", handlerScoped: true },

  // ── 取件台（本对话文件）─────────────────────────────────────────────────────
  // handlerScoped：处理器自己按会话归属 + 路径白名单双重收窄（files-routes.ts）。
  // 不用 paths 声明——要查的不是请求里的某个路径，而是 registry 里的每一行。
  "GET /api/files": { auth: "user", handlerScoped: true },
  // 写侧按路径查白名单（不是 handlerScoped：要查的就是请求里那个路径）。
  "PUT /api/files/content": { auth: "user", paths: [{ from: "body", key: "path" }] },
  // paths 是**数组**，而 valueFrom 只认字符串字段 —— 声明 paths 会静默取不到值。
  // 所以白名单在处理器里逐个查（files-routes.ts 那段 ⚠️ 写了原因）。
  "POST /api/files/delete": { auth: "user", handlerScoped: true },
  // 同样是 handlerScoped，但成因不同：`path` 是**可重复的 query**，而 valueFrom
  // 只取第一个值 —— 声明 paths 会让第二个之后的路径完全不过检查（files-routes.ts）。
  "GET /api/files/download": { auth: "user", handlerScoped: true },
  // 目标目录走 query：multipart body 用 c.req.json() 解析不出来。
  "POST /api/files/upload": { auth: "user", paths: [{ from: "query", key: "dir" }] },
  // 建文件夹的落点也要过目录白名单——它是「写」，和上传同级。
  "POST /api/files/mkdir": { auth: "user", paths: [{ from: "body", key: "dir" }] },
  // 移动：源是数组（中间件的 valueFrom 只读得到一个字符串），而且**源和目标要各查
  // 一次**——所以整条交给 handler 自己查，和 delete / download 同理。
  "POST /api/files/move": { auth: "user", handlerScoped: true },
  // 改名：源和改完之后的名字**各查一次**（白名单是 glob，同目录换后缀也能越界）。
  // 两次都在 handler 里，所以整条 handlerScoped。
  "POST /api/files/rename": { auth: "user", handlerScoped: true },

  // ── ONLYOFFICE ────────────────────────────────────────────────────────────
  // config 是浏览器要的，走正常登录 + 路径白名单。
  "GET /api/office/config": { auth: "user", paths: [{ from: "query", key: "path" }] },
  // 下面两条**由 DocumentServer 容器调用**：容器没有 cookie，也发不出
  // Authorization 头，放在鉴权里会被 401 挡死。凭证是查询串里的**签名票据**
  // （server/office.ts，票面自带路径与用途，HMAC 用 office JWT 密钥），回调还额外
  // 验请求体里的 JWT。容器走 host.docker.internal 到本机环回，**不经 nginx**
  // —— 所以反代那侧应当和 /api/mcp/* 一样把这两条直接 404 掉。
  "GET /api/office/download": { auth: "public", note: "容器取文件，签名票据自证" },
  "POST /api/office/callback": { auth: "public", note: "容器回调，票据 + 请求体 JWT 双验" },
  "GET /api/fs/recents": { auth: "user", handlerScoped: true },
  "POST /api/fs/recents": { auth: "user", paths: [{ from: "body", key: "path" }] },
  "DELETE /api/fs/recents": { auth: "user", paths: [{ from: "body", key: "path", optional: true }] },

  // ── session history ───────────────────────────────────────────────────────
  "GET /api/sessions": { auth: "user", handlerScoped: true },
  "GET /api/sessions/:id/messages": {
    auth: "user",
    owns: { from: "param", key: "id", access: "reader" },
  },
  // Deliberately NOT `reader`: being shown a conversation is not permission to
  // destroy it, and this delete is a real unlink of the CLI's own jsonl.
  "DELETE /api/sessions/:id": { auth: "user", owns: { from: "param", key: "id" } },
  // 决策 41：**发起共享是管理员动作**。不是"owner 管自己的会话"——
  // 一个普通用户能共享的对象只有管理员（对方本来就全看得见）或另一个普通用户，
  // 后者是在管理员背后重新分配可见性。这台机器上谁能看到什么，由管理员决定。
  //
  // ⚠️ `auth: "admin"` **不能替掉 `owns`**：中间件的 UUID 格式守卫长在 owns 里，
  // 而它是刻意跑在管理员 bypass **之前**的（`DELETE /api/groups/%2e%2e%2f%2e%2e`
  // 摸到 fs.rm(recursive) 那次就是这么来的）。管理员靠 bypass 过归属检查，
  // 但格式检查照样要过。两个都留着。
  "GET /api/sessions/:id/shares": { auth: "admin", owns: { from: "param", key: "id" } },
  "PUT /api/sessions/:id/shares": { auth: "admin", owns: { from: "param", key: "id" } },
  "POST /api/sessions/:id/transfer": { auth: "admin", owns: { from: "param", key: "id" } },

  // ── misc ──────────────────────────────────────────────────────────────────
  "POST /api/upload": { auth: "user", note: "writes only into the upload dir, name sanitised" },
  "GET /api/meta": { auth: "user", note: "leaks which skills/commands are installed" },
  "POST /api/permission/:id": {
    auth: "user",
    // Not declarative: permission ids are not in the ownership table. The
    // pending entry itself records who may answer it, and resolvePermission
    // enforces that — see server/permission.ts.
    handlerScoped: true,
  },

  // ── background bash tasks ─────────────────────────────────────────────────
  "GET /api/bash/tasks": { auth: "user", handlerScoped: true },
  "GET /api/bash/tasks/stream": { auth: "user", handlerScoped: true },
  "GET /api/bash/tasks/foreground": { auth: "user", handlerScoped: true },
  "GET /api/bash/tasks/:id/output": { auth: "user", handlerScoped: true },
  "POST /api/bash/tasks/:id/kill": { auth: "user", handlerScoped: true },
  "GET /api/bash/tasks/:id/stream": { auth: "user", handlerScoped: true },
  "POST /api/bash/tasks/foreground/:fgId/detach": { auth: "user", handlerScoped: true },

  // ── MCP (capability tokens, not user sessions) ────────────────────────────
  "ALL /api/mcp/bash": { auth: "public", note: MCP_NOTE },
  "ALL /api/mcp/schedule": { auth: "public", note: MCP_NOTE },
  "ALL /api/mcp/lark": { auth: "public", note: MCP_NOTE },
  // 桌面客户端的中继（docs/desktop-client.md）。和上面三条完全同性质：凭证是
  // per-turn bearer token，调用方只有本机的 CLI 子进程。token 背后解析不出
  // ownerId 时路由自己 403（fail-closed），见 server/mcp-local-route.ts。
  "ALL /api/mcp/local/:server": { auth: "public", note: MCP_NOTE },

  // ── 桌面客户端安装包 ───────────────────────────────────────────────────────
  // ⚠️ **不是** public。决策 27：客户端主进程带 cookie 自己下载，不走
  // shell.openExternal（家人的默认浏览器多半没登录过）。改成 public 会同时打破
  // 公开面清单和 policy.test.ts 的断言 —— 那正是它存在的意义。
  "GET /api/client/download/:file": {
    auth: "user",
    note: "serves the desktop installer from CC_WEBUI_CLIENT_DIR; the handler pins the name to a basename inside that dir",
  },

  // ── Feishu ────────────────────────────────────────────────────────────────
  "ALL /feishu/:bot/events": {
    auth: "public",
    note: "fixed 404; the real Feishu path is a WebSocket, not HTTP",
  },
};

export function policyFor(method: string, path: string): RoutePolicy | undefined {
  return (
    ROUTE_POLICIES[routeKey(method, path)] ?? ROUTE_POLICIES[routeKey("ALL", path)]
  );
}
