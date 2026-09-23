import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 中途插话（steer）的端到端：**那一行有没有真的写进 CLI 的 stdin**。
//
// 为什么非要起一个假 CLI：这个功能的全部实现就是「往一根已经开着的管子多写一行」，
// 而现有的 executor 测试全是纯函数（argv 拼装、帧分类），一行都覆盖不到进程那一侧。
// 真 claude 又不能在测试里跑（要登录、要钱、要网）。所以假一个：它把收到的每一行
// stdin 原样回播成一帧，我们就能断言第二行确实到了。
//
// ⚠️ 这里同时钉住**收回句柄**：executor 在关管子时必须 onSteer(null)。不收回的话
//    chat.ts 的 in-flight 表会一直攥着一个指向死进程的函数，用户点「发送」会得到
//    「写成功了」而其实没人收 —— 比直接说「插不进去」糟得多。

const FAKE = `#!/usr/bin/env node
// 假 claude：把每一行 stdin 回播成 assistant 帧；收到第 2 行后收尾。
const { createInterface } = require("node:readline");
let n = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let text = "";
  try {
    const o = JSON.parse(line);
    for (const c of o?.message?.content ?? []) if (c.type === "text") text = c.text;
  } catch {}
  n++;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "echo:" + text }] } }) + "\\n");
  if (n === 2) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s-1" }) + "\\n");
  }
});
`;

const dir = await mkdtemp(path.join(tmpdir(), "cc-steer-"));
const bin = path.join(dir, "fake-claude.cjs");
await writeFile(bin, FAKE);
await chmod(bin, 0o755);

const savedBin = process.env.CC_WEBUI_CLAUDE_BIN;
process.env.CC_WEBUI_CLAUDE_BIN = bin;

try {
  const { claudeExecutor } = await import("./claude-executor.ts");

  let handle: ((t: string) => boolean) | null = null;
  // 经一层函数去读：直接读 `handle` 的话 tsc 按控制流把它收窄成 `null`
  // （赋值发生在它看不进去的回调里），后面 `handle("…")` 就成了 never。
  const steer = () => handle;
  let revoked = false;
  const echoes: string[] = [];

  const frames = claudeExecutor.exec({
    prompt: "第一条",
    cwd: dir,
    signal: new AbortController().signal,
    // 走 stdin 协议的开关之一（另一个是带图）。没有它 executor 会把 prompt 当
    // positional 传、当场关掉 stdin，插话自然就无从谈起。
    onPermissionAsk: async () => ({ behavior: "deny", message: "n/a" }),
    onSteer: (send) => {
      if (send) handle = send;
      else revoked = true;
    },
  });

  for await (const f of frames) {
    if (f.kind !== "raw") continue;
    const p = f.payload as { type?: string; message?: { content?: { text?: string }[] } };
    if (p.type !== "assistant") continue;
    const text = p.message?.content?.[0]?.text ?? "";
    echoes.push(text);
    if (echoes.length === 1) {
      // 这一轮还在跑 —— 这正是插话的窗口。
      const send = steer();
      assert.ok(send, "CLI 起来之后必须交出插话句柄");
      assert.equal(send!("第二条"), true, "管子开着时插话必须写得进去");
    }
  }

  assert.deepEqual(
    echoes,
    ["echo:第一条", "echo:第二条"],
    "插进去的那一行必须原样到达 CLI 的 stdin（而且是在同一轮里）"
  );
  assert.equal(revoked, true, "这一轮结束时必须把句柄收回（onSteer(null)）");
  assert.equal(steer()!("第三条"), false, "管子关了之后再插必须如实返回 false");

  console.log("claude-steer.test.ts: all assertions passed");
} finally {
  if (savedBin === undefined) delete process.env.CC_WEBUI_CLAUDE_BIN;
  else process.env.CC_WEBUI_CLAUDE_BIN = savedBin;
  await rm(dir, { recursive: true, force: true });
}
