// ONLYOFFICE 那半边。三条是花钱买来的教训，必须钉住：
//   ① 回调无论识别与否都返回 {"error":0} —— 返回别的，容器会反复重试并最终扣留
//      文件，用户的修改就悬空了（律枢在生产上踩过）
//   ② 只认 status=6（forcesave），status=2 刻意不落盘
//   ③ 冲突时不覆盖原路径，人的版本旁存（决策 11：原路径永远是 agent 那份）
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cc-webui-office-"));
process.env.CC_WEBUI_DB = path.join(tmp, "test.db");
process.env.CC_WEBUI_OFFICE_JWT_SECRET = "test-secret";
process.env.CC_WEBUI_OFFICE_URL = "https://office.example/";

const {
  officeRoute,
  signJwt,
  verifyJwt,
  isOfficeFile,
  officeConfigured,
  writeOrSideline,
  sidelinePath,
} = await import("./office.ts");

const app = new Hono();
app.route("/api/office", officeRoute);

// ── JWT ─────────────────────────────────────────────────────────────────────

const tok = signJwt({ a: 1 });
assert.deepEqual(verifyJwt(tok), { a: 1 });
assert.equal(verifyJwt(tok, "wrong-key"), null, "换密钥必须验不过");
assert.equal(verifyJwt("not.a.jwt"), null);
assert.equal(verifyJwt(tok.slice(0, -2) + "xx"), null, "改签名必须验不过");
// 篡改载荷（保留原签名）也必须失败 —— 否则票面里的路径可以被改写。
const [h, , sig] = tok.split(".");
const forgedBody = Buffer.from(JSON.stringify({ a: 2 }))
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
assert.equal(verifyJwt(`${h}.${forgedBody}.${sig}`), null, "改载荷必须验不过");

assert.equal(officeConfigured(), true);
assert.equal(isOfficeFile("a.docx"), true);
assert.equal(isOfficeFile("a.md"), false, "md 走文本编辑器，不进 office");

// ── 回调：票据 / 签名 / status 三道门，且**永远返回 error:0** ────────────────

const target = path.join(tmp, "计划.docx");
await fsp.writeFile(target, "agent 写的原件");

const post = async (query: string, body: unknown) => {
  const res = await app.request(`/api/office/callback${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { error?: number } };
};

const badTicket = await post("?ticket=garbage", { status: 6 });
assert.equal(badTicket.status, 200);
assert.deepEqual(badTicket.body, { error: 0 }, "票据无效也要回 error:0");

const ticket = encodeURIComponent(
  signJwt({
    p: target,
    mode: "callback",
    exp: Date.now() + 60_000,
    m: (await fsp.stat(target)).mtimeMs,
  })
);

// 没有请求体 JWT → 拒绝落盘，但仍然 error:0。
const noJwt = await post(`?ticket=${ticket}`, { status: 6, url: "http://x/" });
assert.deepEqual(noJwt.body, { error: 0 });
assert.equal(
  await fsp.readFile(target, "utf8"),
  "agent 写的原件",
  "验签失败绝不许落盘"
);

// status=2（关闭后自动保存）→ 刻意不落盘。
const auto = await post(`?ticket=${ticket}`, {
  status: 2,
  url: "http://x/",
  token: signJwt({ any: 1 }),
});
assert.deepEqual(auto.body, { error: 0 });
assert.equal(await fsp.readFile(target, "utf8"), "agent 写的原件");

// ── 落盘与旁存 ──────────────────────────────────────────────────────────────

const base = await fsp.stat(target);

// 基准对得上 → 覆盖原路径。
const w1 = await writeOrSideline(target, Buffer.from("人改过的"), base.mtimeMs);
assert.equal(w1.sidelined, false);
assert.equal(w1.path, target);
assert.equal(await fsp.readFile(target, "utf8"), "人改过的");

// 同一次编辑会话里第二次 forcesave：现在磁盘上的 mtime 是**我们自己**刚写的，
// 不该被判成冲突（否则每次保存都生成一个新的旁存文件）。
const w2 = await writeOrSideline(target, Buffer.from("人又改了"), base.mtimeMs);
assert.equal(w2.sidelined, false, "自己上一次的写入不算冲突");
assert.equal(w2.path, target);

// agent 在编辑期间改了原件 → 旁存，**原路径保持 agent 那份**。
await new Promise((r) => setTimeout(r, 10));
await fsp.writeFile(target, "agent 后来又改了");
const w3 = await writeOrSideline(target, Buffer.from("人的版本"), base.mtimeMs);
assert.equal(w3.sidelined, true);
assert.notEqual(w3.path, target);
assert.equal(
  await fsp.readFile(target, "utf8"),
  "agent 后来又改了",
  "原路径永远是 agent 那份（决策 11）"
);
assert.equal(await fsp.readFile(w3.path, "utf8"), "人的版本", "人的那份没丢");
assert.match(path.basename(w3.path), /我的修改-\d{8}-\d{4}\.docx$/);

// 旁存名保留扩展名（否则 Word 打不开）。
assert.ok(sidelinePath("/a/b/计划.docx").endsWith(".docx"));
assert.ok(sidelinePath("/a/b/无扩展名").includes("我的修改-"));

// 临时文件不许残留。
assert.deepEqual(
  (await fsp.readdir(tmp)).filter((n) => n.includes("cc-webui-tmp")),
  []
);

// ── 关掉配置 = 整体降级，而不是报错 ─────────────────────────────────────────

delete process.env.CC_WEBUI_OFFICE_URL;
assert.equal(officeConfigured(), false, "缺 URL 即视为在线编辑关闭");
const off = await app.request("/api/office/config?path=/x/a.docx");
assert.equal(off.status, 503, "关闭时明确回 503，前端据此降级");

await fsp.rm(tmp, { recursive: true, force: true });
console.log("office.test.ts: all assertions passed");
