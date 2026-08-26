// ONLYOFFICE 在线编辑。设计与三条 URL 见 docs/file-manager.md。
//
// 三条链路，只有第一条需要公网（照律枢 do_prod 的拆法）：
//   浏览器 → 容器        CC_WEBUI_OFFICE_URL        公网（office.freeaitech.top:8443，现成）
//   容器   → cc-webui    CC_WEBUI_SELF_INTERNAL_URL host.docker.internal:8789，不走公网
//   签名                 CC_WEBUI_OFFICE_JWT_SECRET **必须与容器 JWT_SECRET 一致**
//
// ⚠️ CC_WEBUI_OFFICE_URL 或密钥留空 = 在线编辑整体关闭，前端回落只读/下载。
// 这是**有意的降级路径**而不是故障：那个容器是律枢那个栈的（固定 compose 项目名
// lvshu-office，`./lvshu.sh stop` 会把它停掉），它不在时取件台必须还能用。
//
// ⚠️ 这里刻意**不**引入「服务端主动触发 forcesave」需要的那条 server→容器 URL：
// 现在没有调用方。这个仓库已经有一个 FEISHU_USE_WEBHOOK 那样的死 flag（有文档、
// 有配置、零调用方），不再造第二个。

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { currentUser } from "./auth/middleware.ts";
import { getAllowedPaths } from "./auth/users.ts";
import { assertCanOpen } from "./auth/paths.ts";

const officeRoute = new Hono();

const EDITABLE = new Set([
  "docx", "doc", "odt", "rtf", "txt",
  "xlsx", "xls", "ods", "csv",
  "pptx", "ppt", "odp",
]);

const DOC_TYPE: Record<string, string> = {
  docx: "word", doc: "word", odt: "word", rtf: "word", txt: "word",
  xlsx: "cell", xls: "cell", ods: "cell", csv: "cell",
  pptx: "slide", ppt: "slide", odp: "slide",
};

function ext(p: string): string {
  return path.extname(p).slice(1).toLowerCase();
}

export function isOfficeFile(p: string): boolean {
  return EDITABLE.has(ext(p));
}

export function officeConfigured(): boolean {
  return (
    !!process.env.CC_WEBUI_OFFICE_URL?.trim() &&
    !!process.env.CC_WEBUI_OFFICE_JWT_SECRET?.trim()
  );
}

function secret(): string {
  return process.env.CC_WEBUI_OFFICE_JWT_SECRET?.trim() ?? "";
}

function selfUrl(): string {
  return (
    process.env.CC_WEBUI_SELF_INTERNAL_URL?.trim() ||
    "http://host.docker.internal:8789"
  );
}

// ─── JWT（HS256）────────────────────────────────────────────────────────────
//
// 自己写而不是加依赖：需要的只有 HS256 签 + 验，两个都是十行。容器要求 EditorConfig
// 带签名，回调体也带签名（**验回调体的签名是唯一能阻止伪造回调的门** —— 票据只证明
// 「这个请求指向这个文件」，而带票的 callbackUrl 是随配置下发到浏览器的，开发者工具
// 里就能看到）。

const b64u = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64u = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function signJwt(payload: unknown, key = secret()): string {
  const head = b64u(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = b64u(
    createHmac("sha256", key).update(`${head}.${body}`).digest()
  );
  return `${head}.${body}.${sig}`;
}

export function verifyJwt<T = unknown>(token: string, key = secret()): T | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !key) return null;
  const want = createHmac("sha256", key)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const got = unb64u(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(unb64u(parts[1]).toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ─── 票据 ───────────────────────────────────────────────────────────────────
//
// 容器没有 cookie，也发不出 Authorization 头，所以取文件与回调这两条路由必须在
// 登录之外，凭证只能是查询串里的票据。票面自带路径与用途，**别的什么都不要相信**。

// m = 编辑会话开始时原文件的 mtime。放在**签名票据**里，回调时直接比对 —— 这就是
// office 那半边的乐观锁，而且它不可伪造。不这么做就只能靠时间启发式猜「这期间有没有
// 人改过」，那种规则怎么调都是错的。
type Ticket = {
  p: string;
  mode: "content" | "callback";
  exp: number;
  m?: number;
};

const TICKET_TTL_MS = 12 * 3600_000; // 一次编辑会话足够长，又不至于永久有效

function issueTicket(abs: string, mode: Ticket["mode"], mtimeMs?: number): string {
  return signJwt({ p: abs, mode, exp: Date.now() + TICKET_TTL_MS, m: mtimeMs });
}

function readTicket(
  raw: string | undefined,
  mode: Ticket["mode"]
): Ticket | null {
  if (!raw) return null;
  const t = verifyJwt<Ticket>(raw);
  if (!t || t.mode !== mode || typeof t.p !== "string") return null;
  if (!t.exp || t.exp < Date.now()) return null;
  return t;
}

// ─── 浏览器侧：下发 EditorConfig ─────────────────────────────────────────────

officeRoute.get("/config", async (c) => {
  if (!officeConfigured()) {
    return c.json({ error: "office editing disabled" }, 503);
  }
  const raw = c.req.query("path");
  if (!raw) return c.json({ error: "path required" }, 400);
  if (!isOfficeFile(raw)) return c.json({ error: "unsupported type" }, 415);

  // 白名单由 policy 表声明（paths: query.path）已经查过；这里再取一次规范化路径，
  // 因为票据里必须放规范化后的那个 —— 容器拿票来取文件时没有别的东西可校验。
  const user = currentUser(c)!;
  let abs: string;
  try {
    abs = await assertCanOpen(raw, getAllowedPaths(user.id));
  } catch {
    return c.json({ error: "path not allowed" }, 403);
  }
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return c.json({ error: "not found" }, 404);
  }

  const e = ext(abs);
  const base = selfUrl();
  const config = {
    document: {
      fileType: e,
      // key 必须随内容变，否则容器会拿它的缓存 —— 同一个 key 改了文件也看不到新内容。
      key: `${b64u(createHmac("sha256", "k").update(abs).digest()).slice(0, 20)}-${Math.round(stat.mtimeMs)}`,
      title: path.basename(abs),
      url: `${base}/api/office/download?ticket=${encodeURIComponent(issueTicket(abs, "content"))}`,
    },
    documentType: DOC_TYPE[e] ?? "word",
    editorConfig: {
      lang: "zh-CN",
      callbackUrl: `${base}/api/office/callback?ticket=${encodeURIComponent(issueTicket(abs, "callback", stat.mtimeMs))}`,
      user: { id: user.id, name: user.username },
      customization: {
        // 只认 forcesave（决策 10）：把「保存」做成显式动作，关窗不落盘。
        forcesave: true,
        autosave: false,
      },
    },
  };
  return c.json({
    officeUrl: process.env.CC_WEBUI_OFFICE_URL!.trim(),
    config: { ...config, token: signJwt(config) },
  });
});

// ─── 容器侧：取原文件 ────────────────────────────────────────────────────────
//
// 免登录，票据自证。⚠️ 新增容器侧端点一律加在这个文件里，并且**只信票面**。

officeRoute.get("/download", async (c) => {
  const t = readTicket(c.req.query("ticket"), "content");
  if (!t) return c.json({ error: "bad ticket" }, 403);
  const abs = t.p;
  try {
    const data = await fsp.readFile(abs);
    return new Response(data, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(data.length),
      },
    });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

// ─── 容器侧：保存回调 ────────────────────────────────────────────────────────
//
// ⚠️ **无论识别与否都必须返回 {"error":0}**（律枢在生产上付过这个学费）：返回别的，
// 容器会反复重试并最终扣留文件，用户的修改就悬空了。真正的失败走日志。
//
// ⚠️ 必须验回调体里的 JWT —— 票据只证明「请求指向这个文件」，而带票的 callbackUrl
// 是随配置下发到浏览器的，开发者工具里就能看到。不验签名，持票者可以伪造任意内容。

const OK = { error: 0 };

officeRoute.post("/callback", async (c) => {
  const ticket = readTicket(c.req.query("ticket"), "callback");
  const abs = ticket?.p;
  const body = (await c.req.json().catch(() => ({}))) as {
    status?: number;
    url?: string;
    token?: string;
  };

  if (!abs) {
    console.warn("[office] 回调票据无效，忽略");
    return c.json(OK);
  }
  if (!body.token || !verifyJwt(body.token)) {
    console.warn(`[office] 回调 JWT 验签失败，拒绝落盘 path=${abs}`);
    return c.json(OK);
  }
  // 只认 status=6（forcesave）。status=2 是「关闭后自动保存」，刻意不落盘：
  // ONLYOFFICE 协议里压根没有「不保存」，只认显式 forcesave，「不保存」才是真的
  // 不保存（决策 10）。
  if (body.status !== 6) {
    console.log(`[office] 忽略 status=${body.status} path=${abs}`);
    return c.json(OK);
  }
  if (!body.url) {
    console.warn(`[office] forcesave 没带 url path=${abs}`);
    return c.json(OK);
  }

  try {
    const res = await fetch(body.url);
    if (!res.ok) throw new Error(`取编辑结果失败 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeOrSideline(abs, buf, ticket?.m ?? 0);
  } catch (err) {
    console.error(`[office] 落盘失败 path=${abs}:`, err);
  }
  return c.json(OK);
});

// 冲突时**不覆盖原路径**，把人这一份旁存（决策 11：原路径永远是 agent 那份）。
//
// 判定就是一次 mtime 比对，基准来自签名票据里的 m（编辑会话开始时的 mtime）：
// 现在的 mtime 比它新 → 这期间有别人（几乎总是 agent）改过 → 旁存。
//
// ⚠️ 一次编辑会话里可以有多次 forcesave，第二次时原文件的 mtime 已经是**我们自己**
// 上一次写下的了。所以要记住自己写过什么，否则第二次保存会被自己判成冲突，从此每次
// 保存都生成一个新的旁存文件。
const lastWrittenByUs = new Map<string, number>();

export async function writeOrSideline(
  abs: string,
  buf: Buffer,
  baselineMtimeMs: number
): Promise<{ path: string; sidelined: boolean }> {
  let conflict = false;
  try {
    const st = await fsp.stat(abs);
    const ours = lastWrittenByUs.get(abs);
    // 1ms 容差：某些文件系统的 mtime 粒度粗。
    const newer = st.mtimeMs > baselineMtimeMs + 1;
    const isOurOwnWrite = ours !== undefined && Math.abs(st.mtimeMs - ours) <= 1;
    conflict = newer && !isOurOwnWrite;
  } catch {
    conflict = false; // 原文件没了：直接写回去
  }

  const target = conflict ? sidelinePath(abs) : abs;
  const tmp = `${target}.cc-webui-tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, target);
  const st = await fsp.stat(target);
  lastWrittenByUs.set(target, st.mtimeMs);
  if (conflict) {
    console.log(`[office] 原文件已被改过，人的版本旁存到 ${target}`);
  }
  return { path: target, sidelined: conflict };
}

export function sidelinePath(abs: string): string {
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const e = dot > 0 ? base.slice(dot) : "";
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}` +
    `${String(d.getDate()).padStart(2, "0")}-` +
    `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return path.join(dir, `${stem}.我的修改-${stamp}${e}`);
}

export { officeRoute };
