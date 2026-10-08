import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessageList from "../src/components/MessageList.tsx";
import CodexActivityRow from "../src/components/CodexActivityRow.tsx";
import TurnStatus from "../src/components/TurnStatus.tsx";
import { THINKING_WORDS } from "../src/lib/thinking-words.ts";
import type { ChatEvent } from "../src/lib/types.ts";

const assertDynamicWord = (html: string) => {
  const text = html.match(/<span class="font-mono text-orange">([^<]+)<\/span>/)?.[1];
  assert(text && THINKING_WORDS.some(word => text === `${word}…`), "Codex visible activity is only the rotating word and ellipsis");
};

const clock = Date.now;
const now = clock();
Date.now = () => now;
try {
  const startedAt = now - 311000;
  const render = (events: ChatEvent[], isRunning = true, start: number | undefined = startedAt) =>
    renderToStaticMarkup(createElement(MessageList, {
      events, expandedSteps: new Set<string>(), onToggleStep: () => {},
      onAnswerPermission: () => {}, provider: "codex", isRunning,
      turnStartedAt: start, effort: "xhigh",
    }));
  const user: ChatEvent = { id: "u", type: "user", text: "test" };
  const tool: ChatEvent = { id: "t", type: "step", tool: "Bash", status: "pending" };
  const thought: ChatEvent = { id: "r", type: "thinking", text: "", status: "pending" };
  for (const [phase, events] of [
    ["unknown", [user]],
    ["tool", [user, tool]],
    ["reasoning", [user, thought]],
    ["answer", [user, { id: "a", type: "assistant", text: "working" }]],
  ] as const) {
    const html = render([...events]);
    assert.equal((html.match(/本轮总耗时 5m11s/g) ?? []).length, 1, `${phase}: independent total timer survives every phase`);
    assert.match(html, /含工具与等待/);
    assert.match(html, /推理档位：xhigh/);
    assert.doesNotMatch(html, /处理中 · |思考中 · /, "no visible phase prefix in Codex");
    if (phase === "unknown") {
      assertDynamicWord(html);
      assert.match(html, /aria-label="Codex 处理中"/);
    }
    if (phase === "reasoning") {
      assertDynamicWord(html);
      assert.match(html, /aria-label="Codex 思考中"/);
      assert.doesNotMatch(html, /aria-label="Codex 处理中"/);
    }
    if (phase === "tool") assert.doesNotMatch(html, /aria-label="Codex (处理中|思考中)"/);
  }

  const processingRow = renderToStaticMarkup(createElement(CodexActivityRow, { effort: "xhigh" }));
  assertDynamicWord(processingRow);
  assert.match(processingRow, /aria-label="Codex 处理中"/);
  assert.doesNotMatch(processingRow, /处理中 · |思考中 · /);
  assert.match(processingRow, /sparkle-spin/, "preserve the requested animation");
  assert.doesNotMatch(processingRow, /本轮总耗时|xhigh|\d+[sm]/, "no duration or configured effort beside the pseudo-thinking verb");

  const stat = renderToStaticMarkup(createElement(TurnStatus, { startedAt, effort: "xhigh" }));
  assert.doesNotMatch(stat, /text-orange|sparkle-spin|truncate/, "neutral statistic with visible, wrapping explanation");
  assert.equal(renderToStaticMarkup(createElement(TurnStatus, {})), "", "missing start time is not fabricated");
  assert.doesNotMatch(render([user], false), /本轮总耗时|aria-label="Codex 处理中"/, "end/cancel stops live statistics");
  const withoutStart = renderToStaticMarkup(createElement(MessageList, {
    events: [user], expandedSteps: new Set<string>(), onToggleStep: () => {},
    onAnswerPermission: () => {}, provider: "codex", isRunning: true,
  }));
  assertDynamicWord(withoutStart);
  assert.match(withoutStart, /aria-label="Codex 处理中"/);
  assert.doesNotMatch(withoutStart, /本轮总耗时/, "group/attach without start metadata keeps liveness, not a made-up clock");

  const claude = renderToStaticMarkup(createElement(MessageList, {
    events: [user, { id: "c", type: "thinking", text: "", tokens: 2400 }],
    expandedSteps: new Set<string>(), onToggleStep: () => {}, onAnswerPermission: () => {},
    provider: "claude", isRunning: true, turnStartedAt: startedAt, effort: "max",
  }));
  assert.match(claude, /↓ 2\.4k tokens/, "Claude retains its native token-based thinking row");
  assert.doesNotMatch(claude, /本轮总耗时|含工具与等待|aria-label="Codex (处理中|思考中)"|推理档位：/, "Codex product changes never enter Claude's presentation");
} finally {
  Date.now = clock;
}
console.log("Codex phase feedback and whole-turn elapsed statistics remain visibly separate");
