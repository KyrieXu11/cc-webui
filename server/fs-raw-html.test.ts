// /api/fs/raw 的 HTML 渲染档。走**真实的** app.request()，因为这条路由上真正在
// 干活的是响应头，而响应头只有从中间件那头整条走下来才是真的。
//
// 钉死的是**安全**那一半，不是「能不能看见页面」：
//   ① 缺省（不带 render=1）绝不能回 text/html —— 回了就是同源 XSS，agent 有 shell，
//      往白名单里落一个 .html 再骗人在新标签页点开，脚本就站在本站源上了；
//   ② 带 render=1 时**必须**带 `Content-Security-Policy: sandbox`，因为这个参数
//      谁都能自己拼，前端 iframe 上那个 sandbox 属性对「直接导航打开」是不存在的；
//   ③ CSP 里的 sandbox 档位必须和前端 HTML_SANDBOX 一字不差 —— 两者同时生效时
//      浏览器取**交集**，这边少一档，iframe 里就莫名其妙少一档能力；
//   ④ **绝不能出现 allow-same-origin**。它和 allow-scripts 一起给等于没有沙箱：
//      拿到同源身份的脚本可以把父文档上这个 iframe 的 sandbox 属性抹掉再重载。
//      这条是整个功能的地基，所以断言直接查这个子串。
// 另外 ⑤ render=1 只认 .html/.htm：别的扩展名拼上它也不能变成 HTML 文档。

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = path.join(os.tmpdir(), `cc-webui-raw-html-test-${Date.now()}`);
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_COOKIE_SECRET_FILE = path.join(tmp, "cookie-secret");
process.env.CC_WEBUI_GROUPS_DIR = path.join(tmp, "groups");
process.env.CC_WEBUI_SESSION_INDEX = path.join(tmp, "sessions.json");
process.env.CODEX_SESSIONS_DIR = path.join(tmp, "codex-empty");
process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
process.env.CC_WEBUI_WORKSPACES_DIR = path.join(tmp, "workspaces");
process.env.CC_WEBUI_DOTENV = path.join(tmp, "empty.env");

const mine = path.join(tmp, "mine");
const theirs = path.join(tmp, "theirs");
await fs.mkdir(mine, { recursive: true });
await fs.mkdir(theirs, { recursive: true });
await fs.writeFile(path.join(tmp, "empty.env"), "");

const { closeDb } = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { createUser } = await import("./auth/users.ts");
const { issueSession, SESSION_COOKIE } = await import("./auth/session.ts");

// 前端那份档位。测试直接 import 它，这样两边写岔了就是红的，而不是等到
// alert() 在某个人的页面里静默失效。
const { HTML_SANDBOX } = await import("../src/lib/filepreview.ts");

try {
  const app = createApp();
  const alice = createUser({
    username: "alice",
    password: "x",
    role: "user",
    allowedPaths: [`${mine}/**`],
  });
  const cookie = `${SESSION_COOKIE}=${issueSession(alice.id)}`;
  const raw = (p: string, qs = "") =>
    app.request(`/api/fs/raw?path=${encodeURIComponent(p)}${qs}`, {
      headers: { cookie },
    });

  const page = path.join(mine, "report.html");
  await fs.writeFile(page, "<!doctype html><title>hi</title><p>你好");

  // ── ① 缺省不回 text/html ────────────────────────────────────────────────
  {
    const r = await raw(page);
    assert.equal(r.status, 200);
    const ct = r.headers.get("content-type") ?? "";
    assert.ok(
      !ct.includes("text/html"),
      `不带 render=1 时绝不能回 text/html，实际是 ${ct}`,
    );
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }

  // ── ②③④ render=1：text/html + CSP sandbox，且没有 allow-same-origin ─────
  {
    const r = await raw(page, "&render=1");
    assert.equal(r.status, 200);
    assert.ok((r.headers.get("content-type") ?? "").startsWith("text/html"));
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");

    const csp = r.headers.get("content-security-policy") ?? "";
    assert.equal(
      csp,
      `sandbox ${HTML_SANDBOX}`,
      "CSP 的 sandbox 档位必须和前端 HTML_SANDBOX 一字不差（浏览器取交集）",
    );
    assert.ok(
      !csp.includes("allow-same-origin"),
      "allow-same-origin + allow-scripts = 没有沙箱，页面能把自己放出来",
    );
    assert.ok(!HTML_SANDBOX.includes("allow-same-origin"));
    assert.equal(await r.text(), "<!doctype html><title>hi</title><p>你好");
  }

  // ── ⑤ render=1 只认 .html/.htm ─────────────────────────────────────────
  {
    const txt = path.join(mine, "notes.txt");
    await fs.writeFile(txt, "<script>alert(1)</script>");
    const r = await raw(txt, "&render=1");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.equal(r.headers.get("content-security-policy"), null);
  }

  // ── svg 也在沙箱里：它是能带 <script> 的文档格式，一直回 image/svg+xml，
  //    直接导航打开就在本站源上执行。<img> 那条路读不到 CSP，所以不受影响。
  {
    const svg = path.join(mine, "chart.svg");
    await fs.writeFile(svg, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const r = await raw(svg);
    assert.equal(r.headers.get("content-type"), "image/svg+xml");
    assert.equal(r.headers.get("content-security-policy"), "sandbox");
  }

  // ── 白名单照旧管着 render=1：它是个渲染开关，不是绕过目录校验的后门 ────
  {
    const outside = path.join(theirs, "evil.html");
    await fs.writeFile(outside, "<script>fetch('/api/auth/me')</script>");
    const r = await raw(outside, "&render=1");
    assert.equal(r.status, 403);
  }

  console.log("fs-raw-html.test.ts ✓");
} finally {
  closeDb();
  await fs.rm(tmp, { recursive: true, force: true });
}
