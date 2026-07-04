import type * as lark from "@larksuiteoapi/node-sdk";
import type {
  GroupSubscriber,
  InFlightGroupTurn,
} from "../groups/orchestrator.ts";
import type { AgentId } from "../groups/store.ts";
import {
  permissionRequestCard,
  permissionResolvedCard,
  type PermissionRequestPayload,
  type PermissionResolvedPayload,
} from "./cards.ts";
import type { BotConfig } from "./config.ts";
import { rememberFeishuMessage } from "./quote.ts";

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
  // tool_use blocks stream their input as input_json_delta chunks after
  // content_block_start. We buffer the partial JSON keyed by block index
  // and emit the formatted tool line only on content_block_stop, when the
  // input is complete.
  pendingTools: Map<number, { name: string; inputJson: string }>;
  // Codex item.updated events carry the full current text for an item, not
  // token deltas. Track the last rendered text per item so Feishu streaming
  // only appends the newly-added suffix.
  codexTextByItem: Map<string, string>;
  // Tool-like Codex items are upserts in the SDK stream. Feishu markdown is
  // append-oriented, so render each tool item once when it first appears.
  codexToolItems: Set<string>;
  renderedText: string;
};

export async function bridgeTurn(args: BridgeArgs): Promise<void> {
  const { channel, chatId, parentMessageId, turn } = args;

  const states = new Map<AgentId, AgentState>();
  // Permission cards live alongside the markdown stream. The map stores the
  // *Promise* for each card's send so that a permission_resolved arriving
  // before send completes still awaits the same handle.
  type PermissionCardEntry = {
    messageId: string;
    request: PermissionRequestPayload;
  };
  const permissionCards = new Map<string, Promise<PermissionCardEntry | null>>();

  function sendPermissionCard(payload: PermissionRequestPayload): void {
    console.log(
      `[feishu bridge] send permission card id=${payload.id} tool=${payload.tool}`,
    );
    const promise: Promise<PermissionCardEntry | null> = channel
      .send(
        chatId,
        { card: permissionRequestCard(payload) },
        { replyTo: parentMessageId },
      )
      .then((res) => {
        console.log(
          `[feishu bridge] permission card sent id=${payload.id} msg=${res.messageId}`,
        );
        void rememberFeishuMessage(res.messageId, {
          text: permissionRequestQuoteText(payload),
          agent: args.bot.agentId,
        });
        return { messageId: res.messageId, request: payload };
      })
      .catch((err) => {
        console.error(`[feishu bridge] send permission card failed:`, err);
        return null;
      });
    permissionCards.set(payload.id, promise);
  }

  async function updatePermissionCard(
    payload: PermissionResolvedPayload,
  ): Promise<void> {
    console.log(
      `[feishu bridge] update permission card id=${payload.id} behavior=${payload.behavior} stale=${payload.stale} mapHas=${permissionCards.has(payload.id)}`,
    );
    const handle = permissionCards.get(payload.id);
    if (!handle) return;
    const entry = await handle;
    if (!entry) {
      console.warn(
        `[feishu bridge] permission card promise resolved to null id=${payload.id}`,
      );
      return;
    }
    try {
      await channel.updateCard(
        entry.messageId,
        permissionResolvedCard(entry.request, payload),
      );
      void rememberFeishuMessage(entry.messageId, {
        text: permissionResolvedQuoteText(entry.request, payload),
        agent: args.bot.agentId,
      });
      console.log(
        `[feishu bridge] permission card updated id=${payload.id} msg=${entry.messageId}`,
      );
    } catch (err) {
      console.error(`[feishu bridge] update permission card failed:`, err);
    }
  }

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
      pendingTools: new Map(),
      codexTextByItem: new Map(),
      codexToolItems: new Set(),
      renderedText: "",
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
      .then((res) => {
        void rememberFeishuMessage(res.messageId, {
          text: state.renderedText,
          agent,
        });
        return res;
      })
      .catch(async (err) => {
        console.error(`[feishu bridge ${agent}] stream failed:`, err);
        state.fallback = true;
        const buffered = state.pending.join("");
        state.pending.length = 0;
        if (buffered) {
          try {
            const res = await channel.send(
              chatId,
              { text: buffered },
              { replyTo: parentMessageId },
            );
            void rememberFeishuMessage(res.messageId, {
              text: state.renderedText || buffered,
              agent,
            });
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
    s.renderedText += text;
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
    s.renderedText = text;
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
      s.renderedText += tail;
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
        .then((res) =>
          rememberFeishuMessage(res.messageId, {
            text: s.renderedText || text,
            agent,
          }),
        )
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
        const p = data.payload;
        // Permission lifecycle bypasses the markdown stream — it gets its
        // own interactive card instead.
        if (p?.type === "permission_request") {
          void sendPermissionCard(p as PermissionRequestPayload);
          return;
        }
        if (p?.type === "permission_resolved") {
          void updatePermissionCard(p as PermissionResolvedPayload);
          return;
        }
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

function permissionRequestQuoteText(payload: PermissionRequestPayload): string {
  const summary = summarizeToolInput(payload.input);
  return [
    `🔒 工具权限请求: ${payload.tool}`,
    payload.description || payload.displayName || "",
    summary ? `参数: ${summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function permissionResolvedQuoteText(
  request: PermissionRequestPayload,
  resolved: PermissionResolvedPayload,
): string {
  const status = resolved.stale
    ? "已过期 / 中止"
    : resolved.behavior === "deny"
      ? "已拒绝"
      : resolved.behavior === "allow_session"
        ? "本轮都允许"
        : resolved.behavior === "allow_tool_session"
          ? "该工具本轮都允许"
          : "已允许";
  const summary = summarizeToolInput(request.input);
  return [
    `${status}: ${request.tool}`,
    request.description || request.displayName || "",
    summary ? `参数: ${summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
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
      // Don't emit anything yet — params come as `input_json_delta` chunks
      // after block_start. Buffer name + index, render on block_stop.
      const index = typeof evt.index === "number" ? evt.index : -1;
      state.pendingTools.set(index, {
        name: block.name ?? "Tool",
        inputJson: "",
      });
      return null;
    }
  }

  if (evt?.type === "content_block_delta") {
    const d = evt.delta;
    if (d?.type === "text_delta" && typeof d.text === "string") {
      return { kind: "append", text: d.text };
    }
    if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
      const idx = typeof evt.index === "number" ? evt.index : -1;
      const pending = state.pendingTools.get(idx);
      if (pending) pending.inputJson += d.partial_json;
      return null;
    }
    // thinking_delta intentionally dropped — placeholder is the only signal.
  }

  if (evt?.type === "content_block_stop") {
    const idx = typeof evt.index === "number" ? evt.index : -1;
    const pending = state.pendingTools.get(idx);
    if (!pending) return null;
    state.pendingTools.delete(idx);
    let input: unknown = {};
    try {
      input = JSON.parse(pending.inputJson || "{}");
    } catch {
      /* keep empty input */
    }
    const display = prettifyToolName(pending.name);
    const summary = summarizeToolInput(input);
    // Function-call style: `bash(cmd)` / `lark.send_file(/path/x)`.
    // Inline code can't contain literal backticks — strip them to keep
    // markdown rendering intact.
    const safeSummary = summary.replace(/`/g, "'");
    const line = safeSummary
      ? `🔧 \`${display}(${safeSummary})\``
      : `🔧 \`${display}()\``;
    if (state.thinkingPlaceholderActive) {
      state.thinkingPlaceholderActive = false;
      state.realContentStarted = true;
      return { kind: "replace", text: line };
    }
    state.realContentStarted = true;
    return { kind: "append", text: `\n${line}` };
  }
  return deriveCodexStreamAction(payload, state);
}

function deriveCodexStreamAction(
  payload: any,
  state: AgentState,
): StreamAction | null {
  if (
    payload?.type !== "item.started" &&
    payload?.type !== "item.updated" &&
    payload?.type !== "item.completed"
  ) {
    return null;
  }
  const item = payload.item;
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? `${item.type}-${payload.type}`);

  if (item.type === "reasoning") {
    if (!state.realContentStarted && !state.thinkingPlaceholderActive) {
      state.thinkingPlaceholderActive = true;
      return { kind: "replace", text: "🤔 思考中…" };
    }
    return null;
  }

  if (item.type === "agent_message") {
    const text = typeof item.text === "string" ? item.text : "";
    if (!text) return null;
    const prev = state.codexTextByItem.get(id) ?? "";
    state.codexTextByItem.set(id, text);
    if (prev === text) return null;

    if (state.thinkingPlaceholderActive && !state.realContentStarted) {
      state.thinkingPlaceholderActive = false;
      state.realContentStarted = true;
      return { kind: "replace", text };
    }

    const hadRealContent = state.realContentStarted;
    state.realContentStarted = true;
    if (!prev) {
      return {
        kind: "append",
        text: hadRealContent ? `\n\n${text}` : text,
      };
    }
    if (text.startsWith(prev)) {
      return { kind: "append", text: text.slice(prev.length) };
    }
    return { kind: "append", text: `\n\n${text}` };
  }

  const line = codexToolLine(item);
  if (!line) return null;
  if (state.codexToolItems.has(id)) return null;
  state.codexToolItems.add(id);

  if (state.thinkingPlaceholderActive) {
    state.thinkingPlaceholderActive = false;
    state.realContentStarted = true;
    return { kind: "replace", text: line };
  }
  state.realContentStarted = true;
  return { kind: "append", text: `\n${line}` };
}

function codexToolLine(item: any): string | null {
  let display = "";
  let summary = "";

  switch (item.type) {
    case "command_execution":
      display = "CodexShell";
      summary = typeof item.command === "string" ? item.command : "";
      break;
    case "mcp_tool_call":
      display = prettifyToolName(
        `${item.server ?? "mcp"}.${item.tool ?? "tool"}`,
      );
      summary = summarizeAnyToolInput(item.arguments);
      break;
    case "file_change":
      display = "ApplyPatch";
      summary = summarizeFileChange(item.changes);
      break;
    case "web_search":
      display = "WebSearch";
      summary = typeof item.query === "string" ? item.query : "";
      break;
    case "todo_list":
      display = "TodoWrite";
      summary = `${Array.isArray(item.items) ? item.items.length : 0} items`;
      break;
    case "error":
      return `❌ ${truncateOneLine(item.message ?? "Codex error", 120)}`;
    default:
      return null;
  }

  const safeSummary = truncateOneLine(summary, 80).replace(/`/g, "'");
  return safeSummary
    ? `🔧 \`${display}(${safeSummary})\``
    : `🔧 \`${display}()\``;
}

// `mcp__bash__run` → `bash` (drop the canonical `.run` suffix);
// `mcp__bash__output` → `bash.output`;
// `mcp__lark__send_file` → `lark.send_file`;
// built-in tool names (Bash / Read / ToolSearch) stay as-is.
function prettifyToolName(name: string): string {
  if (name === "bash.run") return "bash";
  if (name === "bash.output") return "bash.output";
  if (name === "bash.kill") return "bash.kill";
  if (name === "bash.list") return "bash.list";
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__");
    if (parts.length === 2 && parts[1] === "run") return parts[0];
    return parts.join(".");
  }
  return name;
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
    (typeof o.text === "string" && o.text) ||
    (typeof o.chat_id === "string" && o.chat_id) ||
    "";
  if (!candidate) return "";
  const oneLine = candidate.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
}

function summarizeAnyToolInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "object") {
    const summary = summarizeToolInput(input);
    if (summary) return summary;
    try {
      return JSON.stringify(input);
    } catch {
      return "";
    }
  }
  return String(input);
}

function summarizeFileChange(changes: unknown): string {
  if (!Array.isArray(changes)) return "";
  if (changes.length === 0) return "0 files";
  const paths = changes
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const o = c as Record<string, unknown>;
      return (
        (typeof o.path === "string" && o.path) ||
        (typeof o.file_path === "string" && o.file_path) ||
        ""
      );
    })
    .filter(Boolean);
  if (paths.length > 0) return paths.join(", ");
  return `${changes.length} files`;
}

function truncateOneLine(input: unknown, max: number): string {
  const oneLine = String(input ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}
