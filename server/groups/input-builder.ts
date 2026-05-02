import type { GroupTurnEntry, AgentId } from "./store.ts";
import type { GroupConfig } from "./config.ts";

export function peerLabel(agent: AgentId): string {
  return agent === "claude" ? "Claude" : "Codex";
}

export type BuildPromptArgs = {
  transcript: GroupTurnEntry[];
  target: AgentId;
  currentText: string;
  config: GroupConfig;
};

export function buildPrompt(args: BuildPromptArgs): string {
  const { transcript, target, currentText } = args;
  const lines: string[] = [];
  let hasHistory = false;

  for (const e of transcript) {
    const ev = e.event;
    if (!ev) continue;

    // Skip non-conversational rows. Tool plumbing must NOT be replayed
    // because Claude SDK strictly validates tool_use_id pairing across
    // a single call and we can't reconstruct that from canonical text.
    if (
      ev.type === "thinking" ||
      ev.type === "step" ||
      ev.type === "permission" ||
      ev.type === "summary"
    ) {
      continue;
    }

    if (ev.type === "user" && e.agent === "user" && ev.text) {
      lines.push(renderUserText(e, ev.text));
      hasHistory = true;
      continue;
    }

    if (ev.type === "assistant" && e.agent === target && ev.text) {
      lines.push(`你的上一条回复: ${ev.text}`);
      hasHistory = true;
      continue;
    }

    if (
      ev.type === "assistant" &&
      e.agent !== "user" &&
      e.agent !== target &&
      ev.text
    ) {
      lines.push(`[来自 ${peerLabel(e.agent)} 的回复]\n${ev.text}`);
      hasHistory = true;
      continue;
    }
  }

  if (!hasHistory) return currentText;

  return [
    "[群聊历史]",
    ...lines,
    "",
    "[当前用户消息]",
    currentText,
  ].join("\n\n");
}

// User messages may carry a `meta.quote` referencing a prior agent reply
// the user is explicitly asking about. Render as a markdown blockquote
// so the agent treats it as quoted context.
function renderUserText(entry: GroupTurnEntry, text: string): string {
  const q = entry.meta?.quote;
  if (q && q.text) {
    const quoted = q.text
      .split("\n")
      .map((l: string) => `> ${l}`)
      .join("\n");
    return `USER:\n[引用 ${peerLabel(q.agent)} 的回复]\n${quoted}\n\n${text}`;
  }
  return `USER: ${text}`;
}

// Build the per-turn prompt string for an agent that's resuming its
// own session. We send only what the agent HASN'T seen yet — the
// catchup since its most recent assistant entry in canonical:
//
//   - user messages from anywhere after the agent's last own reply
//   - peer assistants with the `[来自 X]` cross-injection prefix
//
// We never re-send the agent's own past replies — those already live in
// the resumed session naturally. We never re-send peer thinking / tool
// timelines — those are the peer's private working notes; only the
// peer's final assistant text matters for cross-talk.
//
// First-time invocation (agent has no prior assistant entry) → the
// "catchup" is the entire history, equivalent to the old full-prompt
// behavior. Each subsequent turn shrinks because there's only a small
// diff to send.
export function buildResumeCatchup(args: {
  transcript: GroupTurnEntry[];
  target: AgentId;
}): string {
  const { transcript, target } = args;

  // Walk backwards to find the agent's most recent own assistant
  // entry. Everything strictly after that is "new" to the agent.
  let lastOwnIdx = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (
      e.agent === target &&
      e.event &&
      (e.event.type === "assistant" || e.event.type === "thinking" ||
        e.event.type === "step")
    ) {
      lastOwnIdx = i;
      break;
    }
  }

  const newEntries = transcript.slice(lastOwnIdx + 1);
  const lines: string[] = [];

  for (const e of newEntries) {
    const ev = e.event;
    if (!ev) continue;

    if (ev.type === "user" && e.agent === "user" && ev.text) {
      lines.push(renderUserText(e, ev.text));
      continue;
    }
    if (
      ev.type === "assistant" &&
      e.agent !== "user" &&
      e.agent !== target &&
      ev.text
    ) {
      lines.push(`[来自 ${peerLabel(e.agent)} 的回复]\n${ev.text}`);
      continue;
    }
    // Skip: own assistant/thinking/step (resumed session has them) +
    // peer thinking/step/permission (private to that agent).
  }

  return lines.join("\n\n");
}

export function systemPromptFor(args: {
  config: GroupConfig;
  target: AgentId;
}): string {
  const { config, target } = args;
  const me = config.participants.find((p) => p.id === target);
  const peer = config.participants.find((p) => p.id !== target);

  const peerDesc = peer
    ? `${peerLabel(peer.id)} (${peer.model})${
        peer.systemPrompt?.trim() ? `, 角色: ${peer.systemPrompt.trim()}` : ""
      }`
    : "另一方";

  const own = me?.systemPrompt?.trim() ?? "";

  const groupPreamble = [
    "你正在参与一个多 agent 群聊。",
    `其他参与者：${peerDesc}。`,
    `对方的发言会以"[来自 ${
      peer ? peerLabel(peer.id) : "对方"
    } 的回复]"前缀的 USER 消息形式出现在历史里 —— 那不是真实用户说的，是另一个 agent 说的，你可以认同 / 反驳 / 补充。`,
    '本次群聊的实际用户（人）只通过不带前缀的 "USER:" 出现。',
  ].join("\n");

  return own ? `${own}\n\n---\n${groupPreamble}` : groupPreamble;
}
