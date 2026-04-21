import type { ChatEvent } from "./types";
import type { SessionMessage } from "./sessions";

type OnSession = (id: string) => void;

export function applySDKMessage(
  events: ChatEvent[],
  msg: any,
  onSession: OnSession
): ChatEvent[] {
  if (!msg || typeof msg !== "object") return events;

  if (msg.type === "system" && msg.subtype === "init") {
    if (msg.session_id) onSession(msg.session_id);
    return events;
  }

  if (msg.type === "stream_event" && msg.event) {
    const ev = msg.event;

    if (ev.type === "content_block_start") {
      const block = ev.content_block;
      if (block?.type === "text") {
        return [
          ...events,
          {
            id: `a-${msg.uuid}-${ev.index}`,
            type: "assistant",
            text: "",
          },
        ];
      }
      if (block?.type === "tool_use") {
        return [
          ...events,
          {
            id: `s-${block.id}`,
            type: "step",
            tool: block.name,
            arg: summarize(block.name, block.input),
            status: "pending",
            input: block.input,
          },
        ];
      }
    }

    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const last = events[events.length - 1];
      if (last?.type === "assistant") {
        return [
          ...events.slice(0, -1),
          { ...last, text: last.text + ev.delta.text },
        ];
      }
    }
    return events;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    let result = events;
    for (const block of msg.message.content) {
      if (block.type === "tool_use") {
        const idx = result.findIndex((e) => e.id === `s-${block.id}`);
        if (idx >= 0) {
          const existing = result[idx];
          if (existing.type === "step") {
            const updated: ChatEvent = {
              ...existing,
              arg: summarize(block.name, block.input) ?? existing.arg,
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

export function sessionMessagesToEvents(msgs: SessionMessage[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const m of msgs) {
    if (m.type === "user") {
      const msg = m.message as any;
      const c = msg?.content;
      if (typeof c === "string" && c.trim()) {
        events.push({ id: `u-${m.uuid}`, type: "user", text: c });
      } else if (Array.isArray(c)) {
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
              id: `u-${m.uuid}-${events.length}`,
              type: "user",
              text: b.text,
            });
          }
        }
      }
    } else if (m.type === "assistant") {
      const msg = m.message as any;
      const content = msg?.content;
      if (Array.isArray(content)) {
        content.forEach((b, i) => {
          if (b?.type === "text" && b.text) {
            events.push({
              id: `a-${m.uuid}-${i}`,
              type: "assistant",
              text: b.text,
            });
          } else if (b?.type === "tool_use") {
            events.push({
              id: `s-${b.id}`,
              type: "step",
              tool: b.name,
              arg: summarize(b.name, b.input),
              status: "ok",
              input: b.input,
            });
          }
        });
      }
    }
  }
  return events;
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
      return truncate(input.command, 96);
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
