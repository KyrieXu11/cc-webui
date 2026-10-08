import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summaryJsonlLines, skipCodexSummaryLine } from "./summary-jsonl.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cc-summary-jsonl-"));
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-08T00:00:00Z", type, payload });
try {
  const file = path.join(tmp, "rows.jsonl");
  const metadata = row("session_meta", { cwd: "/完整/路径" });
  const huge = row("response_item", { type: "reasoning", raw_content: "秘密".repeat(1_000_000) });
  const reordered = JSON.stringify({ payload: { cwd: "/reordered" }, type: "turn_context", timestamp: "2026-10-08T00:00:00Z" });
  const title = row("event_msg", { type: "thread_name_updated", thread_name: "中间的标题" });
  await fs.writeFile(file, [metadata, huge, title, reordered, "malformed", ""].join("\r\n") + row("turn_context", { cwd: "/last" }));
  const got = [];
  for await (const line of summaryJsonlLines(file, h => skipCodexSummaryLine(h, true, false))) got.push(line);
  assert.equal(got.length, 6, "CRLF and unterminated final records are retained");
  assert.equal(JSON.parse(got[0].line!).payload.cwd, "/完整/路径");
  assert.equal(got[1].line, undefined, "ignored huge payload is never decoded/joined into a full string");
  assert.ok(Buffer.byteLength(got[1].head) < 1030, "ignored header remains bounded including partial UTF-8");
  assert.match(got[2].line!, /中间的标题/);
  assert.equal(got[3].line, reordered + "\r", "unfamiliar field order falls back, no middle metadata is lost");
  assert.equal(got[4].line, "malformed\r");
  assert.equal(JSON.parse(got[5].line!).payload.cwd, "/last");
  assert.equal(skipCodexSummaryLine(row("event_msg", { type: "user_message", message: "first" }), false, false), false);
  assert.equal(skipCodexSummaryLine(row("event_msg", { type: "item_completed", item: { type: "UserMessage" } }), false, false), false);
  assert.equal(skipCodexSummaryLine(row("response_item", { role: "user", content: "fallback" }), false, false), false);
  assert.equal(skipCodexSummaryLine(row("event_msg", { type: "thread_name_updated", thread_name: "title" }), true, true), false);
  assert.equal(skipCodexSummaryLine('{"timestamp":"invalid","type":"event_msg","payload":{"type":"x"}}', true, true), false);
  // If a relevant UTF-8 record straddles several chunks, preserve every byte.
  const long = row("turn_context", { cwd: "路径".repeat(40_000) });
  await fs.writeFile(file, long);
  for await (const line of summaryJsonlLines(file, h => skipCodexSummaryLine(h, true, true))) assert.equal(line.line, long);
  // Cancellation closes the stream (early iterator return is a normal caller path).
  for await (const _ of summaryJsonlLines(file, () => false)) break;
} finally { await fs.rm(tmp, { recursive: true, force: true }); }
console.log("summary-jsonl: bounded ignored payloads, full relevant lines and field-order fallback verified");
