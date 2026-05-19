import type { ChatEvent, ImageAttachment, StepStatus } from "./types";
import type { CodexSessionTurn, SessionHistoryItem, SessionMessage } from "./sessions";

const TOOL_ALIAS: Record<string, string> = {
  "mcp__bash__run": "Bash",
  "mcp__bash__output": "BashOutput",
  "mcp__bash__kill": "KillBash",
  "mcp__bash__list": "BashList",
  "bash.run": "Bash",
  "bash.output": "BashOutput",
  "bash.kill": "KillBash",
  "bash.list": "BashList",
};

function normalizeToolName(name: string): string {
  return TOOL_ALIAS[name] ?? name;
}

type OnSession = (id: string) => void;

function streamBlockId(prefix: "a" | "t", msg: any, index: number): string {
  const base =
    msg.stream_message_id ??
    msg.event?.message?.id ??
    msg.message?.id ??
    msg.uuid ??
    "unknown";
  return `${prefix}-${base}-${index}`;
}

function findLastEventIndex(
  events: ChatEvent[],
  type: ChatEvent["type"]
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return i;
  }
  return -1;
}

function findCompatibleTextEventIndex(
  events: ChatEvent[],
  type: "assistant" | "thinking",
  text: string
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== type) continue;
    if (!ev.text || text.startsWith(ev.text) || ev.text.startsWith(text)) {
      return i;
    }
  }
  return -1;
}

export function applySDKMessage(
  events: ChatEvent[],
  msg: any,
  onSession: OnSession
): ChatEvent[] {
  if (!msg || typeof msg !== "object") return events;

  if (msg.type === "thread.started" && msg.thread_id) {
    onSession(msg.thread_id);
    return events;
  }

  if (msg.type === "turn.failed" && msg.error?.message) {
    return [
      ...events,
      {
        id: `e-codex-${Date.now()}`,
        type: "assistant",
        text: `[错误] ${msg.error.message}`,
      },
    ];
  }

  if (
    (msg.type === "item.started" ||
      msg.type === "item.updated" ||
      msg.type === "item.completed") &&
    msg.item
  ) {
    return applyCodexItem(events, msg.item);
  }

  if (msg.type === "system" && msg.subtype === "init") {
    if (msg.session_id) onSession(msg.session_id);
    return events;
  }

  if (msg.type === "wakeup_turn_started" && typeof msg.prompt === "string") {
    const id = `u-wakeup-${msg.reqId ?? msg.sessionId ?? msg.prompt}`;
    if (events.some((e) => e.id === id)) return events;
    return [
      ...events,
      {
        id,
        type: "user",
        text: msg.prompt,
      },
    ];
  }

  if (msg.type === "permission_request" && msg.id) {
    const id = `p-${msg.id}`;
    if (events.some((e) => e.id === id)) return events;
    return [
      ...events,
      {
        id,
        type: "permission",
        permissionId: msg.id,
        tool: msg.tool ?? "unknown",
        input: msg.input ?? {},
        toolUseId: typeof msg.toolUseId === "string" ? msg.toolUseId : undefined,
        title: typeof msg.title === "string" ? msg.title : undefined,
        displayName:
          typeof msg.displayName === "string" ? msg.displayName : undefined,
        description:
          typeof msg.description === "string" ? msg.description : undefined,
        hasSessionPermissionSuggestions:
          msg.hasSessionPermissionSuggestions === true,
      },
    ];
  }

  if (msg.type === "permission_resolved" && msg.id) {
    const behavior =
      msg.behavior === "allow" ||
      msg.behavior === "allow_session" ||
      msg.behavior === "allow_tool_session" ||
      msg.behavior === "deny"
        ? msg.behavior
        : undefined;
    return events.map((e) =>
      e.type === "permission" && e.permissionId === msg.id
        ? { ...e, resolved: behavior ?? e.resolved, stale: !behavior || e.stale }
        : e
    );
  }

  if (msg.type === "stream_event" && msg.event) {
    const ev = msg.event;

    if (ev.type === "content_block_start") {
      const block = ev.content_block;
      // Idempotent: on re-delivery (attach replay after initial disconnect),
      // reset the existing event at this id back to empty so subsequent
      // deltas re-fill it. Without this we'd accumulate duplicates.
      if (block?.type === "text") {
        const id = streamBlockId("a", msg, ev.index);
        const idx = events.findIndex((e) => e.id === id);
        if (idx >= 0) {
          return [
            ...events.slice(0, idx),
            { ...events[idx], text: "" } as ChatEvent,
            ...events.slice(idx + 1),
          ];
        }
        return [
          ...events,
          { id, type: "assistant", text: "" },
        ];
      }
      if (block?.type === "tool_use") {
        const id = `s-${block.id}`;
        const idx = events.findIndex((e) => e.id === id);
        const toolName = normalizeToolName(block.name);
        if (idx >= 0) {
          const existing = events[idx];
          if (existing.type === "step") {
            return [
              ...events.slice(0, idx),
              {
                ...existing,
                tool: toolName,
                arg: summarize(toolName, block.input) ?? existing.arg,
                status: "pending",
                input: block.input,
                output: undefined,
              },
              ...events.slice(idx + 1),
            ];
          }
        }
        return [
          ...events,
          {
            id,
            type: "step",
            tool: toolName,
            arg: summarize(toolName, block.input),
            status: "pending",
            input: block.input,
          },
        ];
      }
      if (block?.type === "thinking") {
        const id = streamBlockId("t", msg, ev.index);
        const idx = events.findIndex((e) => e.id === id);
        if (idx >= 0) {
          return [
            ...events.slice(0, idx),
            { ...events[idx], text: block.thinking ?? "" } as ChatEvent,
            ...events.slice(idx + 1),
          ];
        }
        return [
          ...events,
          { id, type: "thinking", text: block.thinking ?? "" },
        ];
      }
    }

    if (ev.type === "content_block_delta") {
      // Target the specific block event by id, not "last" — after an attach
      // replay the last event may not be the one we intend to append to.
      if (ev.delta?.type === "text_delta") {
        const id = streamBlockId("a", msg, ev.index);
        let idx = events.findIndex((e) => e.id === id);
        if (idx < 0 && !msg.stream_message_id) {
          idx = findLastEventIndex(events, "assistant");
        }
        if (idx >= 0) {
          const target = events[idx];
          if (target.type === "assistant") {
            return [
              ...events.slice(0, idx),
              { ...target, text: target.text + ev.delta.text },
              ...events.slice(idx + 1),
            ];
          }
        }
      }
      if (ev.delta?.type === "thinking_delta") {
        const id = streamBlockId("t", msg, ev.index);
        let idx = events.findIndex((e) => e.id === id);
        if (idx < 0 && !msg.stream_message_id) {
          idx = findLastEventIndex(events, "thinking");
        }
        if (idx >= 0) {
          const target = events[idx];
          if (target.type === "thinking") {
            return [
              ...events.slice(0, idx),
              { ...target, text: target.text + (ev.delta.thinking ?? "") },
              ...events.slice(idx + 1),
            ];
          }
        }
      }
    }
    return events;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    let result = events;
    const messageId = msg.message.id ?? msg.uuid;
    for (let i = 0; i < msg.message.content.length; i++) {
      const block = msg.message.content[i];
      if (block.type === "text") {
        const id = `a-${messageId}-${i}`;
        const text = block.text ?? "";
        let idx = result.findIndex((e) => e.id === id);
        if (idx < 0 && text) {
          idx = findCompatibleTextEventIndex(result, "assistant", text);
        }
        if (idx >= 0) {
          const existing = result[idx];
          if (existing.type === "assistant") {
            result = [
              ...result.slice(0, idx),
              { ...existing, text },
              ...result.slice(idx + 1),
            ];
          }
        } else if (text) {
          result = [...result, { id, type: "assistant", text }];
        }
        continue;
      }
      if (block.type === "thinking") {
        const id = `t-${messageId}-${i}`;
        const text = block.thinking ?? "";
        let idx = result.findIndex((e) => e.id === id);
        if (idx < 0 && text) {
          idx = findCompatibleTextEventIndex(result, "thinking", text);
        }
        if (idx >= 0) {
          const existing = result[idx];
          if (existing.type === "thinking") {
            result = [
              ...result.slice(0, idx),
              { ...existing, text },
              ...result.slice(idx + 1),
            ];
          }
        } else if (text) {
          result = [...result, { id, type: "thinking", text }];
        }
        continue;
      }
      if (block.type === "tool_use") {
        const idx = result.findIndex((e) => e.id === `s-${block.id}`);
        if (idx >= 0) {
          const existing = result[idx];
          if (existing.type === "step") {
            const toolName = normalizeToolName(block.name);
            const updated: ChatEvent = {
              ...existing,
              arg: summarize(toolName, block.input) ?? existing.arg,
              input: block.input ?? existing.input,
            };
            result = [...result.slice(0, idx), updated, ...result.slice(idx + 1)];
          }
        }
      }
    }
    return result;
  }

  if (msg.type === "user" && msg.message?.content) {
    let result = events;
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result") {
          const idx = result.findIndex((e) => e.id === `s-${block.tool_use_id}`);
          if (idx >= 0) {
            const existing = result[idx];
            if (existing.type === "step") {
              const updated: ChatEvent = {
                ...existing,
                status: block.is_error ? "error" : "ok",
                output: stringifyToolResult(block.content),
              };
              result = [
                ...result.slice(0, idx),
                updated,
                ...result.slice(idx + 1),
              ];
            }
          }
        }
      }
    }
    return result;
  }

  return events;
}

function applyCodexItem(events: ChatEvent[], item: any): ChatEvent[] {
  switch (item.type) {
    case "agent_message":
      return upsertTextEvent(events, {
        id: `a-codex-${item.id}`,
        type: "assistant",
        text: item.text ?? "",
      });
    case "reasoning":
      return upsertTextEvent(events, {
        id: `t-codex-${item.id}`,
        type: "thinking",
        text: item.text ?? "",
      });
    case "command_execution":
      return upsertStepEvent(events, {
        id: `s-codex-${item.id}`,
        type: "step",
        tool: "CodexShell",
        arg: truncate(item.command, 96),
        status: codexStatus(item.status),
        input: { command: item.command },
        output: item.aggregated_output ?? "",
      });
    case "file_change":
      return upsertStepEvent(events, {
        id: `s-codex-${item.id}`,
        type: "step",
        tool: "ApplyPatch",
        arg: `${(item.changes ?? []).length} files`,
        status: item.status === "failed" ? "error" : "ok",
        input: { changes: item.changes ?? [] },
        output: stringifyToolResult(item.changes ?? []),
      });
    case "mcp_tool_call": {
      const rawTool = `${item.server ?? "mcp"}.${item.tool ?? "tool"}`;
      const toolName = normalizeToolName(rawTool);
      return upsertStepEvent(events, {
        id: `s-codex-${item.id}`,
        type: "step",
        tool: toolName,
        arg: summarize(toolName, item.arguments),
        status: codexStatus(item.status),
        input:
          item.arguments && typeof item.arguments === "object"
            ? item.arguments
            : { arguments: item.arguments },
        output: item.error?.message ?? stringifyToolResult(item.result),
      });
    }
    case "web_search":
      return upsertStepEvent(events, {
        id: `s-codex-${item.id}`,
        type: "step",
        tool: "WebSearch",
        arg: item.query,
        status: "ok",
        input: { query: item.query },
      });
    case "todo_list":
      return upsertStepEvent(events, {
        id: `s-codex-${item.id}`,
        type: "step",
        tool: "TodoWrite",
        arg: `${(item.items ?? []).length} items`,
        status: "ok",
        input: { todos: item.items ?? [] },
      });
    case "error":
      return [
        ...events,
        {
          id: `e-codex-${item.id ?? Date.now()}`,
          type: "assistant",
          text: `[错误] ${item.message ?? "Codex error"}`,
        },
      ];
    default:
      return events;
  }
}

function codexStatus(status: string | undefined): StepStatus {
  if (status === "failed") return "error";
  if (status === "completed") return "ok";
  return "pending";
}

function upsertTextEvent(
  events: ChatEvent[],
  next: Extract<ChatEvent, { type: "assistant" | "thinking" }>
): ChatEvent[] {
  const idx = events.findIndex((e) => e.id === next.id);
  if (idx < 0) return next.text ? [...events, next] : events;
  return [...events.slice(0, idx), next, ...events.slice(idx + 1)];
}

function upsertStepEvent(
  events: ChatEvent[],
  next: Extract<ChatEvent, { type: "step" }>
): ChatEvent[] {
  const idx = events.findIndex((e) => e.id === next.id);
  if (idx < 0) return [...events, next];
  const existing = events[idx];
  if (existing.type !== "step") return events;
  return [
    ...events.slice(0, idx),
    { ...existing, ...next },
    ...events.slice(idx + 1),
  ];
}

export function sessionMessagesToEvents(
  msgs: SessionHistoryItem[],
  opts?: { beforeMs?: number }
): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const m of msgs) {
    if (opts?.beforeMs !== undefined) {
      const ts = historyTimestampMs(m);
      if (ts !== null && ts >= opts.beforeMs) continue;
    }
    if ((m as CodexSessionTurn).provider === "codex") {
      const turn = m as CodexSessionTurn;
      if (turn.prompt.trim()) {
        events.push({
          id: `u-codex-${turn.startedAt}`,
          type: "user",
          text: turn.prompt,
        });
      }
      for (const ev of turn.events) {
        const next = applySDKMessage(events, ev, () => {});
        events.splice(0, events.length, ...next);
      }
      continue;
    }
    const claudeMsg = m as SessionMessage;
    if (claudeMsg.type === "user") {
      const msg = claudeMsg.message as any;
      const c = msg?.content;
      if (typeof c === "string" && c.trim()) {
        events.push({ id: `u-${claudeMsg.uuid}`, type: "user", text: c });
      } else if (Array.isArray(c)) {
        const images: ImageAttachment[] = [];
        for (const b of c) {
          if (b?.type === "image" && b.source?.type === "base64") {
            images.push({
              mediaType: b.source.media_type ?? "image/png",
              data: b.source.data ?? "",
            });
          }
        }
        let attachedImages = false;
        const attachIfFirst = () => {
          if (images.length === 0 || attachedImages) return undefined;
          attachedImages = true;
          return images;
        };
        for (const b of c) {
          if (b?.type === "tool_result") {
            const idx = events.findIndex(
              (e) => e.type === "step" && e.id === `s-${b.tool_use_id}`
            );
            if (idx >= 0) {
              const existing = events[idx];
              if (existing.type === "step") {
                events[idx] = {
                  ...existing,
                  status: b.is_error ? "error" : "ok",
                  output: stringifyToolResult(b.content),
                };
              }
            }
          } else if (b?.type === "text" && b.text) {
            events.push({
              id: `u-${claudeMsg.uuid}-${events.length}`,
              type: "user",
              text: b.text,
              images: attachIfFirst(),
            });
          }
        }
        if (images.length > 0 && !attachedImages) {
          events.push({
            id: `u-${claudeMsg.uuid}-img`,
            type: "user",
            text: "",
            images,
          });
        }
      }
    } else if (claudeMsg.type === "assistant") {
      const msg = claudeMsg.message as any;
      const content = msg?.content;
      if (Array.isArray(content)) {
        const messageId = msg?.id ?? claudeMsg.uuid;
        content.forEach((b, i) => {
          if (b?.type === "text" && b.text) {
            events.push({
              id: `a-${messageId}-${i}`,
              type: "assistant",
              text: b.text,
            });
          } else if (b?.type === "thinking" && b.thinking) {
            events.push({
              id: `t-${messageId}-${i}`,
              type: "thinking",
              text: b.thinking,
            });
          } else if (b?.type === "tool_use") {
            const toolName = normalizeToolName(b.name);
            events.push({
              id: `s-${b.id}`,
              type: "step",
              tool: toolName,
              arg: summarize(toolName, b.input),
              status: "pending",
              input: b.input,
            });
          }
        });
      }
    }
  }
  return events;
}

function historyTimestampMs(m: SessionHistoryItem): number | null {
  if ((m as CodexSessionTurn).provider === "codex") {
    const ts = (m as CodexSessionTurn).startedAt;
    return Number.isFinite(ts) ? ts : null;
  }
  const raw = (m as SessionMessage).timestamp;
  if (typeof raw !== "string") return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

export function summarize(tool: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return shortPath(input.file_path);
    case "Bash":
      return input.run_in_background
        ? `[bg] ${truncate(input.command, 88) ?? ""}`
        : truncate(input.command, 96);
    case "BashOutput":
    case "KillBash":
      return input.bash_id;
    case "BashList":
      return "background tasks";
    case "Grep":
      return input.pattern ? `/${input.pattern}/` : undefined;
    case "Glob":
      return input.pattern;
    case "WebFetch":
      return input.url;
    case "WebSearch":
      return input.query;
    case "Task":
      return input.description || input.subagent_type;
    case "TodoWrite":
      return `${(input.todos ?? []).length} items`;
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return typeof first === "string" ? truncate(first, 80) : undefined;
    }
  }
}

function shortPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function stringifyToolResult(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "text") return b.text ?? "";
        if (b?.type === "image") return "[image]";
        return JSON.stringify(b);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}
