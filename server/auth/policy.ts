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

import type { ResourceKind } from "./ownership.ts";

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
  "POST /api/chat": {
    auth: "user",
    paths: [{ from: "body", key: "cwd", optional: true, fallback: "serverCwd" }],
  },
  "POST /api/chat/cancel": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "claude", optional: true },
  },
  "GET /api/chat/inflight": { auth: "user", handlerScoped: true },
  "GET /api/chat/wakeups": { auth: "user", handlerScoped: true },
  "POST /api/chat/wakeups/cancel": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "claude" },
  },
  "GET /api/chat/attach": {
    auth: "user",
    owns: { from: "query", key: "sessionId", kind: "claude", optional: true },
  },

  // ── web single chat (Codex) ───────────────────────────────────────────────
  //
  // admin-only by decision 14: `codex exec` has no --ask-for-approval, so on
  // that side even permissionMode `auto` means unrestricted writes — banning
  // bypassPermissions for ordinary users (decision 12) would be paper-only.
  // Only the route that STARTS a turn is gated; attach/cancel/inflight stay
  // owner-scoped, which already yields nothing for someone who owns no Codex
  // session, and keeps working if this ever loosens.
  "POST /api/codex/chat": {
    auth: "admin",
    paths: [{ from: "body", key: "cwd", optional: true, fallback: "serverCwd" }],
  },
  "POST /api/codex/chat/cancel": {
    auth: "user",
    owns: { from: "body", key: "sessionId", kind: "codex", optional: true },
  },
  "GET /api/codex/chat/inflight": { auth: "user", handlerScoped: true },
  "GET /api/codex/chat/attach": {
    auth: "user",
    owns: { from: "query", key: "sessionId", kind: "codex", optional: true },
  },

  // ── group chat (only mounted when CC_WEBUI_GROUPS_ENABLED) ────────────────
  "GET /api/groups": { auth: "user", handlerScoped: true },
  "POST /api/groups": {
    auth: "user",
    paths: [{ from: "body", key: "cwd", optional: true, fallback: "serverCwd" }],
  },
  "GET /api/groups/inflight/all": { auth: "user", handlerScoped: true },
  "GET /api/groups/:gid": { auth: "user", owns: { from: "param", key: "gid", kind: "group" } },
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
  // 目标目录走 query：multipart body 用 c.req.json() 解析不出来。
  "POST /api/files/upload": { auth: "user", paths: [{ from: "query", key: "dir" }] },

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
  "GET /api/sessions/:id/messages": { auth: "user", owns: { from: "param", key: "id" } },
  "DELETE /api/sessions/:id": { auth: "user", owns: { from: "param", key: "id" } },

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
