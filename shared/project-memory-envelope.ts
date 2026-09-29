export type MemorySnapshot = {
  source: "cc-webui-project-memory-v1";
  scope: string;
  revision: number;
  total: number;
  entries: Array<{
    id: string;
    name: string;
    description: string;
    type: string;
    revision: number;
  }>;
  truncated: boolean;
};
const HEADER = "<!-- cc-webui-project-memory:v1 -->\n<project-memory-snapshot>\n";
const END = "\n<!-- cc-webui-user-request -->\n";
export function encodeMemorySnapshot(snapshot: MemorySnapshot): string {
  return JSON.stringify(snapshot).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function wrapMemoryPrompt(snapshot: MemorySnapshot, prompt: string, guidance = ""): string {
  return `${HEADER}${encodeMemorySnapshot(snapshot)}\n</project-memory-snapshot>\n${guidance}${END}${prompt}`;
}
export function unwrapMemoryPrompt(text: string): string {
  if (!text.startsWith(HEADER)) return text;
  const close = text.indexOf("\n</project-memory-snapshot>", HEADER.length);
  const end = text.indexOf(END, close);
  if (close < 0 || end < close) return text;
  try {
    const data = JSON.parse(text.slice(HEADER.length, close));
    if (data.source !== "cc-webui-project-memory-v1" || typeof data.scope !== "string" || !Number.isSafeInteger(data.revision) || !Array.isArray(data.entries)) return text;
    return text.slice(end + END.length);
  } catch {
    return text;
  }
}
export function stripMemoryMessage<T>(message: T): T {
  if (!message || typeof message !== "object") return message;
  const m = message as Record<string, unknown>;
  if (m.role !== "user") return message;
  if (typeof m.content === "string") return {
    ...m,
    content: unwrapMemoryPrompt(m.content)
  } as T;
  if (!Array.isArray(m.content)) return message;
  return {
    ...m,
    content: m.content.map(p => p && p.type === "text" && typeof p.text === "string" ? {
      ...p,
      text: unwrapMemoryPrompt(p.text)
    } : p)
  } as T;
}
