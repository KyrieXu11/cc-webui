import { useEffect, useState } from "react";
import { readFile } from "../lib/fs";

interface Props {
  tool: string;
  input: any;
}

type DiffLine =
  | { kind: "context"; text: string; lineNo: number }
  | { kind: "add"; text: string; lineNo?: number }
  | { kind: "del"; text: string; lineNo?: number }
  | { kind: "gap" };

type Hunk = {
  verb: "Create" | "Update";
  filePath: string;
  added: number;
  removed: number;
  lines: DiffLine[];
};

const CONTEXT_LINES = 3;

function splitLines(s: string | undefined): string[] {
  if (!s) return [];
  const normalized = s.replace(/\r\n/g, "\n");
  const out = normalized.split("\n");
  if (out.length > 0 && out[out.length - 1] === "" && !s.endsWith("\n")) {
    out.pop();
  }
  return out;
}

function buildDiffLines(
  oldText: string,
  newText: string,
  fileContent: string | null
): { lines: DiffLine[]; anchored: boolean } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (!fileContent || !newText) {
    return {
      lines: [
        ...oldLines.map<DiffLine>((text) => ({ kind: "del", text })),
        ...newLines.map<DiffLine>((text) => ({ kind: "add", text })),
      ],
      anchored: false,
    };
  }

  const src = fileContent.replace(/\r\n/g, "\n");
  const pos = src.indexOf(newText);
  if (pos < 0) {
    return {
      lines: [
        ...oldLines.map<DiffLine>((text) => ({ kind: "del", text })),
        ...newLines.map<DiffLine>((text) => ({ kind: "add", text })),
      ],
      anchored: false,
    };
  }

  // Line number where new_string starts (1-indexed).
  const beforeSrc = src.slice(0, pos);
  const startLine = beforeSrc.split("\n").length;

  // Context before: last N fully-preceding lines.
  const beforeLines = beforeSrc.split("\n");
  // The last element is the partial line leading up to `pos` — if pos lands on
  // a line break it's "", otherwise it's a tail that is already part of the
  // "changed region". Drop it.
  beforeLines.pop();
  const ctxBefore = beforeLines.slice(-CONTEXT_LINES);
  const ctxBeforeStart = startLine - ctxBefore.length;

  // Context after.
  const afterSrc = src.slice(pos + newText.length);
  const afterLines = afterSrc.split("\n");
  if (afterLines.length > 0 && afterLines[0] === "") afterLines.shift();
  const ctxAfter = afterLines.slice(0, CONTEXT_LINES);
  const ctxAfterStart = startLine + newLines.length;

  const out: DiffLine[] = [];
  ctxBefore.forEach((text, i) => {
    out.push({ kind: "context", text, lineNo: ctxBeforeStart + i });
  });
  oldLines.forEach((text) => out.push({ kind: "del", text }));
  newLines.forEach((text, i) =>
    out.push({ kind: "add", text, lineNo: startLine + i })
  );
  ctxAfter.forEach((text, i) => {
    out.push({ kind: "context", text, lineNo: ctxAfterStart + i });
  });
  return { lines: out, anchored: true };
}

function buildCreateLines(content: string): DiffLine[] {
  return splitLines(content).map<DiffLine>((text, i) => ({
    kind: "add",
    text,
    lineNo: i + 1,
  }));
}

export default function EditDiff({ tool, input }: Props) {
  const [hunk, setHunk] = useState<Hunk | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function compute() {
      if (tool === "Write") {
        const content = input?.content ?? "";
        const addedLines = splitLines(content);
        if (!cancelled) {
          setHunk({
            verb: "Create",
            filePath: input?.file_path ?? "",
            added: addedLines.length,
            removed: 0,
            lines: buildCreateLines(content),
          });
        }
        return;
      }
      if (tool === "Edit" || tool === "NotebookEdit") {
        const filePath = input?.file_path ?? input?.notebook_path ?? "";
        const oldStr = input?.old_string ?? "";
        const newStr = input?.new_string ?? "";
        const oldCount = splitLines(oldStr).length;
        const newCount = splitLines(newStr).length;
        let fileContent: string | null = null;
        if (filePath) {
          try {
            const got = await readFile(filePath);
            if (got && !got.truncated) fileContent = got.content;
            else if (got) fileContent = got.content;
          } catch {
            /* ignore — fall back to anchorless diff */
          }
        }
        if (cancelled) return;
        const { lines } = buildDiffLines(oldStr, newStr, fileContent);
        setHunk({
          verb: "Update",
          filePath,
          added: newCount,
          removed: oldCount,
          lines,
        });
      }
    }
    compute();
    return () => {
      cancelled = true;
    };
  }, [tool, input]);

  if (!hunk) {
    return (
      <div className="ml-[27px] mt-1.5 mb-2 text-[11.5px] text-subtle font-mono">
        加载 diff…
      </div>
    );
  }

  const maxLineNo = hunk.lines.reduce((m, l) => {
    const n = "lineNo" in l && l.lineNo ? l.lineNo : 0;
    return n > m ? n : m;
  }, 0);
  const gutterWidth = Math.max(2, String(maxLineNo).length);

  return (
    <div className="ml-[27px] mt-1.5 mb-2">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="font-mono text-[12.5px] text-fg font-semibold">
          {hunk.verb}
        </span>
        <span className="font-mono text-[12px] text-muted truncate">
          ({hunk.filePath})
        </span>
        <span className="ml-auto text-[11px] font-mono tabular-nums">
          {hunk.added > 0 && <span className="text-green">+{hunk.added}</span>}
          {hunk.removed > 0 && (
            <span className="text-red ml-1.5">-{hunk.removed}</span>
          )}
        </span>
      </div>
      <div className="bg-surface border border-line rounded-md overflow-x-auto font-mono text-[12px] leading-[1.55]">
        {hunk.lines.length === 0 ? (
          <div className="px-3 py-2 text-subtle">（无变更内容）</div>
        ) : (
          hunk.lines.map((l, i) => {
            if (l.kind === "gap") {
              return (
                <div
                  key={i}
                  className="text-center text-subtle select-none py-0.5 text-[11px]"
                >
                  ⋯
                </div>
              );
            }
            const bg =
              l.kind === "add"
                ? "bg-green/[0.08]"
                : l.kind === "del"
                  ? "bg-red/[0.1]"
                  : "";
            const sigil =
              l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
            const sigilColor =
              l.kind === "add"
                ? "text-green"
                : l.kind === "del"
                  ? "text-red"
                  : "text-subtle/60";
            const textColor =
              l.kind === "add"
                ? "text-fg"
                : l.kind === "del"
                  ? "text-muted"
                  : "text-muted";
            const lineNo = "lineNo" in l && l.lineNo ? l.lineNo : "";
            return (
              <div key={i} className={`flex ${bg}`}>
                <span
                  className="select-none text-subtle/60 text-right pr-2 pl-2 shrink-0 tabular-nums"
                  style={{ minWidth: `${gutterWidth + 2}ch` }}
                >
                  {lineNo}
                </span>
                <span
                  className={`w-5 shrink-0 text-center select-none ${sigilColor}`}
                >
                  {sigil}
                </span>
                <span
                  className={`whitespace-pre break-all pr-3 ${textColor}`}
                >
                  {l.text || " "}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
