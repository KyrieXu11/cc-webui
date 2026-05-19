import type * as lark from "@larksuiteoapi/node-sdk";
import type {
  GroupSubscriber,
  InFlightGroupTurn,
} from "../groups/orchestrator.ts";
import type { AgentId } from "../groups/store.ts";
import type { BotConfig } from "./config.ts";

export type BridgeArgs = {
  bot: BotConfig;
  channel: lark.LarkChannel;
  chatId: string;
  parentMessageId: string;
  gid: string;
  turn: InFlightGroupTurn;
};

type AgentState = {
  controller: lark.MarkdownStreamController | null;
  // Plain text buffer for fallback path (when stream API rejected).
  pending: string[];
  // Initial card content cached until controller is ready, then handed off
  // via setContent / append. After hand-off we drive the controller directly.
  initialContent: string;
  ended: boolean;
  resolveProducer: (() => void) | null;
  streamPromise: Promise<unknown> | null;
  fallback: boolean;
  // Placeholder state machine: keep a "💭 思考中…" placeholder visible while
  // a thinking block is in flight; the first non-thinking content (text or
  // tool_use) replaces it. thinking_delta content itself is never shown.
  thinkingPlaceholderActive: boolean;
  realContentStarted: boolean;
};

export async function bridgeTurn(args: BridgeArgs): Promise<void> {
  const { channel, chatId, parentMessageId, turn } = args;

  const states = new Map<AgentId, AgentState>();

  function startStream(agent: AgentId): AgentState {
    const cached = states.get(agent);
    if (cached) return cached;
    const state: AgentState = {
      controller: null,
      pending: [],
      initialContent: "",
      ended: false,
      resolveProducer: null,
      streamPromise: null,
      fallback: false,
      thinkingPlaceholderActive: false,
      realContentStarted: false,
    };
    const done = new Promise<void>((resolve) => {
      state.resolveProducer = resolve;
    });
    state.streamPromise = channel
      .stream(
        chatId,
        {
          markdown: async (controller) => {
            state.controller = controller;
            // Replay anything accumulated before controller arrived.
            if (state.initialContent) {
              try {
                await controller.setContent(state.initialContent);
              } catch (err) {
                console.error(
                  `[feishu bridge ${agent}] initial flush:`,
                  err,
                );
              }
            }
            await done;
          },
        },
        { replyTo: parentMessageId },
      )
      .catch(async (err) => {
        console.error(`[feishu bridge ${agent}] stream failed:`, err);
        state.fallback = true;
        const buffered = state.pending.join("");
        state.pending.length = 0;
        if (buffered) {
          try {
            await channel.send(
              chatId,
              { text: buffered },
              { replyTo: parentMessageId },
            );
          } catch (e) {
            console.error(`[feishu bridge ${agent}] fallback send:`, e);
          }
        }
      });
    states.set(agent, state);
    return state;
  }

  function appendTo(agent: AgentId, text: string): void {
    if (!text) return;
    const s = startStream(agent);
    if (s.fallback) {
      s.pending.push(text);
      return;
    }
    if (s.controller) {
      s.controller.append(text).catch((err) => {
        console.error(`[feishu bridge ${agent}] append:`, err);
      });
    } else {
      s.initialContent += text;
    }
  }

  function replaceContent(agent: AgentId, text: string): void {
    const s = startStream(agent);
    if (s.fallback) {
      // For fallback (plain text) just reset what we'll send at the end.
      s.pending = text ? [text] : [];
      return;
    }
    if (s.controller) {
      s.controller.setContent(text).catch((err) => {
        console.error(`[feishu bridge ${agent}] setContent:`, err);
      });
    } else {
      s.initialContent = text;
    }
  }

  function endAgent(agent: AgentId, errorMsg?: string): void {
    const s = states.get(agent);
    if (!s || s.ended) return;
    s.ended = true;
    if (errorMsg) {
      const tail = `\n\n❌ ${errorMsg}`;
      if (s.controller) {
        s.controller.append(tail).catch(() => {});
      } else {
        s.pending.push(tail);
      }
    }
    // Fallback mode: stream API failed entirely; flush whatever we buffered
    // as a plain-text reply so the user still gets the answer.
    if (s.fallback && s.pending.length > 0) {
      const text = s.pending.join("");
      s.pending.length = 0;
      channel
        .send(chatId, { text }, { replyTo: parentMessageId })
        .catch((err) =>
          console.error(`[feishu bridge ${agent}] fallback final:`, err),
        );
    }
    s.resolveProducer?.();
  }

  const sub: GroupSubscriber = {
    write(event, dataStr) {
      let data: any;
      try {
        data = JSON.parse(dataStr);
      } catch {
        return;
      }
      if (event === "agent_event") {
        const agent = data.agent as AgentId;
        const s = startStream(agent);
        const action = deriveStreamAction(data.payload, s);
        if (!action) return;
        if (action.kind === "replace") replaceContent(agent, action.text);
        else appendTo(agent, action.text);
      } else if (event === "agent_end") {
        const agent = data.agent as AgentId;
        endAgent(
          agent,
          data.ok === false
            ? typeof data.error === "string"
              ? data.error
              : "unknown"
            : undefined,
        );
      } else if (event === "turn_end") {
        for (const a of states.keys()) endAgent(a);
      }
    },
    close() {
      for (const a of states.keys()) endAgent(a);
    },
  };

  for (const m of turn.buffered) sub.write(m.event, m.data);
  turn.subscribers.add(sub);

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (turn.status !== "running") resolve();
      else setTimeout(tick, 200);
    };
    tick();
  });
  turn.subscribers.delete(sub);
  for (const a of states.keys()) endAgent(a);

  await Promise.allSettled(
    Array.from(states.values()).map((s) => s.streamPromise),
  );
}

type StreamAction =
  | { kind: "append"; text: string }
  | { kind: "replace"; text: string };

// Derive a stream action from one SDK payload. Mutates `state` to track the
// "thinking placeholder" flags so we can hide thinking deltas behind a
// single "💭 思考中…" indicator and replace it once real content arrives.
function deriveStreamAction(
  payload: any,
  state: AgentState,
): StreamAction | null {
  if (!payload) return null;
  const evt = payload.event ?? payload;

  if (evt?.type === "content_block_start") {
    const block = evt.content_block;
    if (block?.type === "thinking") {
      // Show placeholder only once per turn.
      if (!state.realContentStarted && !state.thinkingPlaceholderActive) {
        state.thinkingPlaceholderActive = true;
        return { kind: "replace", text: "🤔 思考中…" };
      }
      return null;
    }
    if (block?.type === "text") {
      if (state.thinkingPlaceholderActive) {
        state.thinkingPlaceholderActive = false;
        state.realContentStarted = true;
        return { kind: "replace", text: "" };
      }
      state.realContentStarted = true;
      return { kind: "append", text: "\n\n" };
    }
    if (block?.type === "tool_use") {
      const name = block.name ?? "Tool";
      const summary = summarizeToolInput(block.input);
      const header = summary
        ? `🔧 **${name}** \`${summary}\`\n`
        : `🔧 **${name}**\n`;
      if (state.thinkingPlaceholderActive) {
        state.thinkingPlaceholderActive = false;
        state.realContentStarted = true;
        return { kind: "replace", text: header };
      }
      state.realContentStarted = true;
      return { kind: "append", text: `\n\n${header}` };
    }
  }

  if (evt?.type === "content_block_delta") {
    const d = evt.delta;
    if (d?.type === "text_delta" && typeof d.text === "string") {
      return { kind: "append", text: d.text };
    }
    // thinking_delta intentionally dropped — placeholder is the only signal.
  }
  return null;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const candidate =
    (typeof o.command === "string" && o.command) ||
    (typeof o.file_path === "string" && o.file_path) ||
    (typeof o.path === "string" && o.path) ||
    (typeof o.url === "string" && o.url) ||
    (typeof o.query === "string" && o.query) ||
    (typeof o.pattern === "string" && o.pattern) ||
    "";
  if (!candidate) return "";
  return candidate.length > 60 ? candidate.slice(0, 60) + "…" : candidate;
}
