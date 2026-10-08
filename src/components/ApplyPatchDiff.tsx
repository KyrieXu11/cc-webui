import { useMemo, useState } from "react";
import { patchChanges, type PatchChange } from "../lib/patch-diff";

const LABELS: Record<string, string> = { add: "新建", create: "新建", update: "修改", delete: "删除", remove: "删除", change: "变更" };

export function PatchStats({ changes }: { changes: unknown }) {
  const patches = useMemo(() => patchChanges(changes), [changes]);
  const added = patches.reduce((n, p) => n + p.added, 0), removed = patches.reduce((n, p) => n + p.removed, 0);
  if (!added && !removed) return null;
  return <span className="font-mono text-[11.5px] shrink-0 tabular-nums" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
    {!!added && <span className="text-green">+{added}</span>}
    {!!removed && <span className="text-red ml-1.5">−{removed}</span>}
  </span>;
}

function FileDiff({ change }: { change: PatchChange }) {
  const [all, setAll] = useState(false);
  const lines = all ? change.lines : change.lines.slice(0, 600);
  return <details open className="border border-line rounded-control overflow-hidden">
    <summary className="flex items-baseline gap-2 px-3 py-2 cursor-pointer bg-surface-2 font-mono text-[12px]">
      <span className="text-muted shrink-0">{LABELS[change.kind] ?? "变更"}</span>
      <span className="text-fg truncate min-w-0 flex-1" title={change.file}>{change.file}</span>
      {!!change.added && <span className="text-green shrink-0">+{change.added}</span>}
      {!!change.removed && <span className="text-red shrink-0">−{change.removed}</span>}
    </summary>
    {change.moveTo && <div className="px-3 py-1.5 text-[11.5px] font-mono text-muted break-all">移动到：{change.moveTo}</div>}
    {!change.hasDiff ? <div className="px-3 py-3 text-[12px] text-muted">CLI 未提供具体差异，不能从当前文件推断历史修改。</div>
      : !lines.length ? <div className="px-3 py-3 text-[12px] text-muted">未报告文本差异。</div>
      : <div className="overflow-auto max-h-[420px] font-mono text-[11.5px] leading-[1.65]">
        <div className="min-w-max">
          {lines.map((line, i) => line.kind === "hunk" || line.kind === "meta"
            ? <div key={i} className="px-3 py-0.5 bg-fg/[0.03] text-subtle whitespace-pre">{line.text}</div>
            : <div key={i} data-diff-kind={line.kind} className={`flex ${line.kind === "add" ? "bg-green/[0.08]" : line.kind === "del" ? "bg-red/[0.1]" : ""}`}>
              <span className="w-[5ch] shrink-0 px-1 text-right text-subtle tabular-nums select-none" aria-label="旧行号">{line.oldLine ?? ""}</span>
              <span className="w-[5ch] shrink-0 px-1 text-right text-subtle tabular-nums select-none" aria-label="新行号">{line.newLine ?? ""}</span>
              <span className={`w-5 shrink-0 text-center select-none ${line.kind === "add" ? "text-green" : line.kind === "del" ? "text-red" : "text-subtle"}`}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
              <span className="pr-3 whitespace-pre text-fg">{line.text || " "}</span>
            </div>)}
        </div>
      </div>}
    {!all && change.lines.length > 600 && <button onClick={() => setAll(true)} className="px-3 py-2 text-[12px] text-blue">显示全部 {change.lines.length} 行</button>}
  </details>;
}

export default function ApplyPatchDiff({ changes, failed = false }: { changes: unknown; failed?: boolean }) {
  const patches = useMemo(() => patchChanges(changes), [changes]);
  return <div className="ml-[27px] mt-1.5 mb-2 space-y-2" data-patch-diff>
    {failed && <p className="text-[12px] text-red">工具未成功完成；以下为工具报告的差异，不代表全部修改已应用。</p>}
    {patches.map((change, i) => <FileDiff key={`${i}:${change.file}`} change={change} />)}
    <details className="text-[11px] text-subtle font-mono"><summary className="cursor-pointer py-1">原始工具数据</summary><pre className="mt-1 bg-surface-2 rounded-control p-2.5 max-h-[240px] overflow-auto whitespace-pre">{JSON.stringify(changes, null, 2)}</pre></details>
  </div>;
}
