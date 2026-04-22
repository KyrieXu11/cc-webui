interface Props {
  tool: string;
  input: any;
}

function shortPath(p: string | undefined): string {
  if (!p) return "";
  return p;
}

function splitLines(s: string | undefined): string[] {
  if (!s) return [];
  const normalized = s.replace(/\r\n/g, "\n");
  const out = normalized.split("\n");
  // Preserve a final empty segment only if the string itself ended with newline
  if (out.length > 0 && out[out.length - 1] === "" && !s.endsWith("\n")) {
    out.pop();
  }
  return out;
}

type DiffKind = "add" | "del";
type DiffLine = { kind: DiffKind; text: string };

export default function EditDiff({ tool, input }: Props) {
  let verb = "Edit";
  let lines: DiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;

  if (tool === "Write") {
    verb = "Create";
    const src = splitLines(input?.content);
    lines = src.map((text) => ({ kind: "add", text }));
    addedCount = src.length;
  } else if (tool === "Edit" || tool === "NotebookEdit") {
    verb = "Update";
    const oldLines = splitLines(input?.old_string);
    const newLines = splitLines(input?.new_string);
    lines = [
      ...oldLines.map<DiffLine>((text) => ({ kind: "del", text })),
      ...newLines.map<DiffLine>((text) => ({ kind: "add", text })),
    ];
    addedCount = newLines.length;
    removedCount = oldLines.length;
  } else {
    return null;
  }

  const filePath = input?.file_path ?? input?.notebook_path ?? "";

  return (
    <div className="ml-[27px] mt-1.5 mb-2">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="font-mono text-[12.5px] text-fg font-semibold">
          {verb}
        </span>
        <span className="font-mono text-[12px] text-muted truncate">
          ({shortPath(filePath)})
        </span>
        <span className="ml-auto text-[11px] font-mono tabular-nums">
          {addedCount > 0 && (
            <span className="text-green">+{addedCount}</span>
          )}
          {removedCount > 0 && (
            <span className="text-red ml-1.5">-{removedCount}</span>
          )}
        </span>
      </div>
      <div className="bg-surface border border-line rounded-md overflow-x-auto font-mono text-[12px] leading-[1.55]">
        {lines.length === 0 ? (
          <div className="px-3 py-2 text-subtle">（无变更内容）</div>
        ) : (
          lines.map((l, i) => (
            <div
              key={i}
              className={`flex ${
                l.kind === "add"
                  ? "bg-green/[0.08]"
                  : "bg-red/[0.1]"
              }`}
            >
              <span
                className={`w-6 shrink-0 text-center select-none ${
                  l.kind === "add" ? "text-green" : "text-red"
                }`}
              >
                {l.kind === "add" ? "+" : "−"}
              </span>
              <span
                className={`whitespace-pre break-all pr-3 ${
                  l.kind === "add" ? "text-fg" : "text-muted line-through/0"
                }`}
              >
                {l.text || " "}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
