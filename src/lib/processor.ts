import type { ChatEvent, ImageAttachment } from "./types";
import type { SessionMessage } from "./sessions";

const TOOL_ALIAS: Record<string, string> = {
  "mcp__bash__run": "Bash",
  "mcp__bash__output": "BashOutput",
  "mcp__bash__kill": "KillBash",
};

function normalizeToolName(name: string): string {
  return TOOL_ALIAS[name] ?? name;
}

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

  if (msg.type === "permission_request" && msg.id) {
    return [
      ...events,
      {
        id: `p-${msg.id}`,
        type: "permission",
        permissionId: msg.id,
        tool: msg.tool ?? "unknown",
        input: msg.input ?? {},
      },
    ];
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
        const toolName = normalizeToolName(block.name);
        return [
          ...events,
          {
            id: `s-${block.id}`,
            type: "step",
            tool: toolName,
            arg: summarize(toolName, block.input),
            status: "pending",
            input: block.input,
          },
        ];
      }
      if (block?.type === "thinking") {
        return [
          ...events,
          {
            id: `t-${msg.uuid}-${ev.index}`,
            type: "thinking",
            text: block.thinking ?? "",
          },
        ];
      }
    }

    if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta") {
        const last = events[events.length - 1];
        if (last?.type === "assistant") {
          return [
            ...events.slice(0, -1),
            { ...last, text: last.text + ev.delta.text },
          ];
        }
      }
      if (ev.delta?.type === "thinking_delta") {
        const last = events[events.length - 1];
        if (last?.type === "thinking") {
          return [
            ...events.slice(0, -1),
            { ...last, text: last.text + (ev.delta.thinking ?? "") },
          ];
        }
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

export function sessionMessagesToEvents(msgs: SessionMessage[]): ChatEvent[] {
  const events: ChatEvent[] = [];
  for (const m of msgs) {
    if (m.type === "user") {
      const msg = m.message as any;
      const c = msg?.content;
      if (typeof c === "string" && c.trim()) {
        events.push({ id: `u-${m.uuid}`, type: "user", text: c });
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
              id: `u-${m.uuid}-${events.length}`,
              type: "user",
              text: b.text,
              images: attachIfFirst(),
            });
          }
        }
        if (images.length > 0 && !attachedImages) {
          events.push({
            id: `u-${m.uuid}-img`,
            type: "user",
            text: "",
            images,
          });
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
          } else if (b?.type === "thinking" && b.thinking) {
            events.push({
              id: `t-${m.uuid}-${i}`,
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
      return input.run_in_background
        ? `[bg] ${truncate(input.command, 88) ?? ""}`
        : truncate(input.command, 96);
    case "BashOutput":
    case "KillBash":
      return input.bash_id;
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
