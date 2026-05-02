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
    // Skip non-conversational rows: thinking is private, tool plumbing
    // breaks tool_use_id pairing if replayed, permission/summary/error
    // are bookkeeping.
    if (
      e.type === "thinking" ||
      e.type === "tool_call" ||
      e.type === "tool_result" ||
      e.type === "permission" ||
      e.type === "summary" ||
      e.type === "error"
    ) {
      continue;
    }

    if (e.type === "user" && e.agent === "user" && e.text) {
      lines.push(`USER: ${e.text}`);
      hasHistory = true;
      continue;
    }

    if (e.type === "assistant" && e.agent === target && e.text) {
      lines.push(`你的上一条回复: ${e.text}`);
      hasHistory = true;
      continue;
    }

    if (
      e.type === "assistant" &&
      e.agent !== "user" &&
      e.agent !== target &&
      e.text
    ) {
      lines.push(`[来自 ${peerLabel(e.agent)} 的回复]\n${e.text}`);
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
