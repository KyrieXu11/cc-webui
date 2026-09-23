import { Hono } from "hono";
import { currentUser } from "./auth/middleware.ts";
import { visibilityFor } from "./auth/scope.ts";
import {
  kindOf,
  ownerMap,
  transferOwner,
  type ResourceKind,
} from "./auth/ownership.ts";
import { setShares, shareCounts, sharedByFor, sharesOf } from "./auth/sharing.ts";
import { getUserById, listUsers } from "./auth/users.ts";
import {
  listClaudeSessions,
  getClaudeSessionMessages,
  deleteClaudeSession,
} from "./claude-sessions.ts";
import {
  deleteCodexSession,
  getCodexSessionTurns,
  listCodexSessions,
  type AgentProvider,
  type SessionSummary,
} from "./session-store.ts";

const sessionsRoute = new Hono();

type ProviderFilter = AgentProvider | "all";

function providerFilter(raw: string | undefined): ProviderFilter {
  return raw === "claude" || raw === "codex" || raw === "all" ? raw : "all";
}

async function listClaude(opts: {
  limit: number;
  dir?: string;
}): Promise<SessionSummary[]> {
  const sessions = await listClaudeSessions({
    limit: opts.limit,
    dir: opts.dir,
  });
  return sessions.map((s) => ({ ...s, provider: "claude" as const }));
}

sessionsRoute.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 30);
  const dir = c.req.query("cwd") || undefined;
  const provider = providerFilter(c.req.query("provider"));
  try {
    const groups = await Promise.all([
      provider === "codex" ? [] : listClaude({ limit, dir }),
      provider === "claude" ? [] : listCodexSessions({ limit, cwd: dir }),
    ]);
    // Scoped: sessions live in shared trees (~/.claude/projects is even shared
    // with the user's own terminal), so this filter is the only thing keeping
    // one person's history out of another's list. Unowned sessions are
    // admin-only (decision 10).
    const me = currentUser(c)!;
    const visible = visibilityFor(me);
    // Three lookups for the whole page rather than three per row.
    const owners = ownerMap();
    const sharedBy = sharedByFor(me.id);
    const counts = shareCounts();
    const usernames = new Map(listUsers().map((u) => [u.id, u.username]));
    const sessions = groups
      .flat()
      .filter((s) => visible(s.sessionId))
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit)
      .map((s) => {
        const ownerId = owners.get(s.sessionId) ?? null;
        return {
          ...s,
          // `mine` is strictly "I am the owner" — an admin looking at someone
          // else's session gets false here and combines it with their own role
          // on the client. Conflating the two server-side would make the UI say
          // "your conversation" about every session on the machine.
          mine: !!ownerId && ownerId === me.id,
          ownerName: ownerId ? (usernames.get(ownerId) ?? null) : null,
          // Present only when a share row is what makes this row visible.
          sharedBy: sharedBy.has(s.sessionId)
            ? (usernames.get(sharedBy.get(s.sessionId)!) ?? null)
            : undefined,
          sharedCount: counts.get(s.sessionId) ?? 0,
        };
      });
    return c.json({ sessions });
  } catch (e) {
    return c.json({ sessions: [], error: String(e) });
  }
});

sessionsRoute.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const dir = c.req.query("cwd") || undefined;
  const limit = Number(c.req.query("limit") ?? 5000);
  const provider = providerFilter(c.req.query("provider"));
  try {
    if (provider === "codex") {
      const messages = await getCodexSessionTurns(id);
      return c.json({ provider: "codex", messages });
    }
    const messages = await getClaudeSessionMessages(id, { dir, limit });
    return c.json({ provider: "claude", messages });
  } catch (e) {
    return c.json({ messages: [], error: String(e) });
  }
});

// ⚠️ **删不掉就必须说删不掉。** 两个 deleteXxxSession 都是「没找到 / unlink 失败 →
// 返回 false」，原来这里把返回值丢掉、一律回 `{ok:true}` ⇒ 前端照着把那一行从列表里
// 抹掉，下次刷新它又回来了 —— 用户 2026-09-20 报的就是这个形状（「我早上删除了，
// 但是为什么还在呢？」）。静默成功比报错难查得多：界面上看不出任何异常。
sessionsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const dir = c.req.query("cwd") || undefined;
  const provider = providerFilter(c.req.query("provider"));
  try {
    const gone =
      provider === "codex"
        ? await deleteCodexSession(id)
        : await deleteClaudeSession(id, { dir });
    if (!gone) return c.json({ ok: false, reason: "not_found" }, 404);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

// ── 共享 ─────────────────────────────────────────────────────────────────────
//
// policy 里这三条都是**不带 access 的** owns，也就是只有 owner（和 bypass 的
// 管理员）能走到这里。共享名单是所有权的一部分，不是被共享者能转手的东西。

// shares 行要记 kind。优先用 ownership 里已经记着的那个 —— 前端传来的 provider
// 只是它当前选中的 tab，不必然是这条会话的真实类型。都拿不到时按 claude 记：
// kind 不参与任何鉴权判断（判断只看 resource_id + user_id 在不在），
// 记错的后果止于将来按类型筛选时少一行。
function kindFor(id: string, raw: string | undefined): ResourceKind {
  return kindOf(id) ?? (raw === "codex" ? "codex" : "claude");
}

// 连 owner 一起回：对话框只拿得到一个 sessionId，靠这个才知道收件人列表里该把谁
// 划掉（给 owner 自己发共享是死数据），以及转交确认里该怎么措辞。
sessionsRoute.get("/:id/shares", (c) => {
  const id = c.req.param("id");
  const ownerId = ownerMap().get(id) ?? null;
  const owner = ownerId ? getUserById(ownerId) : null;
  return c.json({
    shares: sharesOf(id),
    owner: owner ? { id: owner.id, username: owner.username } : null,
  });
});

sessionsRoute.put("/:id/shares", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const raw = (body as { userIds?: unknown }).userIds;
  if (!Array.isArray(raw)) {
    return c.json({ error: "userIds must be an array" }, 400);
  }
  const me = currentUser(c)!;
  const shares = setShares({
    resourceId: id,
    kind: kindFor(id, c.req.query("provider")),
    userIds: raw.filter((x): x is string => typeof x === "string"),
    sharedBy: me.id,
    ownerId: ownerMap().get(id) ?? null,
  });
  return c.json({ shares });
});

// 转交归属。和共享是两件事：共享是加一个读者，转交是换 owner —— 转出去之后
// **你自己就只剩管理员 bypass 了**（决策 11），普通用户转完是真的看不到了。
// 前端的二次确认必须把这句说清楚。
sessionsRoute.post("/:id/transfer", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const userId = typeof body.userId === "string" ? body.userId : "";
  const target = userId ? getUserById(userId) : null;
  if (!target) return c.json({ error: "unknown user" }, 400);
  transferOwner(id, kindFor(id, c.req.query("provider")), target.id);
  return c.json({ ok: true, owner: { id: target.id, username: target.username } });
});

export { sessionsRoute };
