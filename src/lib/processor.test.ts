// 历史（jsonl）和流式（stream_event）必须给同一个 content block **同一个事件 id**。
//
// 对不上的后果不是抽象的：打开一个正在跑的会话时，openSession 先把整段历史灌进去，
// 紧接着 attach 又把服务端 buffer 里**整条 turn** 重放一遍。两套 id 撞不上就各建一个
// 事件 —— 界面上同一句话出现两遍（用户 2026-09-10 报的那张图）。
//
// 真实形状（实测 CLI 2.1.267，`~/.claude/projects/**/*.jsonl`）：一条 API 消息被拆成
// **一行一个 block**，三行共用同一个 `message.id`，每行 `content` 长度都是 1 ——
// 所以行内下标恒为 0，真实下标只在 `apiBlockIndex` 里。

import assert from "node:assert/strict";
import { applySDKMessage, sessionMessagesToEvents } from "./processor.ts";
import type { SessionMessage } from "./sessions.ts";

const MID = "msg_011CeuXAE5QZRgMuHmJsHzTS";
const TEXT = "Now I have the full source (P138-151) plus the official answer key.";
const TOOL_ID = "toolu_01abc";

/** CLI 写下的那三行（thinking / text / tool_use 各一行，content 长度都是 1）。 */
function historyLines(): SessionMessage[] {
  const base = { type: "assistant" as const, session_id: "s1" };
  return [
    {
      ...base,
      uuid: "f0076ad1",
      api_block_index: 0,
      message: {
        id: MID,
        content: [{ type: "thinking", thinking: "" }],
        usage: { output_tokens_details: { thinking_tokens: 12570 } },
      },
    },
    {
      ...base,
      uuid: "08770ba1",
      api_block_index: 1,
      message: { id: MID, content: [{ type: "text", text: TEXT }] },
    },
    {
      ...base,
      uuid: "a802a6a9",
      api_block_index: 2,
      message: {
        id: MID,
        content: [
          { type: "tool_use", id: TOOL_ID, name: "mcp__bash__run", input: { command: "ls" } },
        ],
      },
    },
  ];
}

/** attach 重放 buffer 时前端会收到的那串帧（顺序与服务端 fan-out 一致）。 */
const REPLAY: unknown[] = [
  {
    type: "stream_event",
    stream_message_id: MID,
    event: { type: "message_start", message: { id: MID } },
  },
  {
    type: "stream_event",
    stream_message_id: MID,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
  },
  {
    type: "stream_event",
    stream_message_id: MID,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "", estimated_tokens: 12570 },
    },
  },
  {
    type: "assistant",
    message: { id: MID, content: [{ type: "thinking", thinking: "" }] },
  },
  {
    type: "stream_event",
    stream_message_id: MID,
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
  },
  {
    type: "stream_event",
    stream_message_id: MID,
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: TEXT },
    },
  },
  { type: "assistant", message: { id: MID, content: [{ type: "text", text: TEXT }] } },
  {
    type: "stream_event",
    stream_message_id: MID,
    event: {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: TOOL_ID, name: "mcp__bash__run", input: { command: "ls" } },
    },
  },
];

// 1. 历史事件的 id 用真实下标，不是行内下标。
{
  const events = sessionMessagesToEvents(historyLines());
  const ids = events.map((e) => e.id);
  assert.deepEqual(ids, [`t-${MID}-0`, `a-${MID}-1`, `s-${TOOL_ID}`]);
}

// 2. 回归：历史 + attach 重放同一条 turn，一句话只能出现一次。
{
  let events = sessionMessagesToEvents(historyLines());
  for (const msg of REPLAY) events = applySDKMessage(events, msg, () => {});

  const texts = events.filter((e) => e.type === "assistant" && e.text === TEXT);
  assert.equal(texts.length, 1, `正文被渲染了 ${texts.length} 遍`);
  assert.equal(events.filter((e) => e.type === "thinking").length, 1);
  assert.equal(events.filter((e) => e.type === "step").length, 1);
  // 重放把 token 计数清零后由 delta 重新填满，最终还是同一个数。
  const thinking = events.find((e) => e.type === "thinking");
  assert.equal(thinking?.type === "thinking" ? thinking.tokens : -1, 12570);
}

// 3. 重放两遍也还是一份（attach 断线重连会再来一次整段 buffer）。
{
  let events = sessionMessagesToEvents(historyLines());
  for (const msg of [...REPLAY, ...REPLAY]) {
    events = applySDKMessage(events, msg, () => {});
  }
  assert.equal(events.filter((e) => e.type === "assistant" && e.text === TEXT).length, 1);
  assert.equal(events.length, 3);
}

// 4. 老记录没有 apiBlockIndex（那时候 content 是完整数组），行内下标就是真值。
{
  const legacy: SessionMessage[] = [
    {
      type: "assistant",
      uuid: "old-1",
      session_id: "s1",
      message: {
        id: "msg_old",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hello" },
        ],
      },
    },
  ];
  assert.deepEqual(
    sessionMessagesToEvents(legacy).map((e) => e.id),
    ["t-msg_old-0", "a-msg_old-1"]
  );
}

console.log("processor history/stream id alignment: ok");
