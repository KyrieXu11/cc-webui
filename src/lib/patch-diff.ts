export type PatchLine = {
  kind: "context" | "add" | "del" | "hunk" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
};
export type PatchChange = {
  file: string;
  moveTo?: string;
  kind: string;
  added: number;
  removed: number;
  hasDiff: boolean;
  lines: PatchLine[];
};

export function parseUnifiedDiff(diff: string): { lines: PatchLine[]; added: number; removed: number } {
  const lines: PatchLine[] = [];
  const source = diff.replace(/\r\n/g, "\n").split("\n");
  if (source.at(-1) === "") source.pop();
  let oldLine: number | undefined, newLine: number | undefined;
  let added = 0, removed = 0, inHunk = false;
  for (const text of source) {
    if (/^diff --git /.test(text)) {
      inHunk = false; oldLine = undefined; newLine = undefined;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      lines.push({ kind: "hunk", text }); continue;
    }
    if ((!inHunk && /^(?:--- |\+\+\+ )/.test(text)) || /^diff --git |^index |^\\ No newline/.test(text)) {
      lines.push({ kind: "meta", text }); continue;
    }
    if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), newLine }); added++;
      if (newLine !== undefined) newLine++;
    } else if (text.startsWith("-")) {
      lines.push({ kind: "del", text: text.slice(1), oldLine }); removed++;
      if (oldLine !== undefined) oldLine++;
    } else if (text.startsWith(" ")) {
      lines.push({ kind: "context", text: text.slice(1), oldLine, newLine });
      if (oldLine !== undefined) oldLine++;
      if (newLine !== undefined) newLine++;
    } else lines.push({ kind: "meta", text });
  }
  return { lines, added, removed };
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;

// Native/history versions use file/type/unified_diff or path/kind/diff.
// Never read today's file to fabricate what a historical edit looked like.
export function patchChanges(changes: unknown): PatchChange[] {
  if (!Array.isArray(changes)) return [];
  return changes.map(raw => {
    const c = record(raw), k = record(c.kind);
    const kind = string(c.type) ?? string(c.kind) ?? string(k.type) ?? "change";
    const diff = string(c.unified_diff) ?? string(c.diff) ?? string(k.diff);
    const content = string(c.content) ?? string(k.content);
    const create = ["add", "create"].includes(kind);
    const deleted = ["delete", "remove"].includes(kind);
    const effective = diff ?? ((create || deleted) && content !== undefined
      ? content === "" ? "" : content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map(line => `${create ? "+" : "-"}${line}`).join("\n") : undefined);
    const parsed = effective !== undefined ? parseUnifiedDiff(effective) : { lines: [], added: 0, removed: 0 };
    return { file: string(c.file) ?? string(c.path) ?? "（未提供文件路径）",
      moveTo: string(c.move_path) ?? string(k.move_path), kind,
      hasDiff: effective !== undefined, ...parsed };
  });
}
