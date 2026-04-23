import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  killTask,
  subscribeTaskStream,
  subscribeTasksList,
  type TaskOutput,
  type TaskStatus,
  type TaskSummary,
} from "../lib/tasks";

interface Props {
  sessionId: string | null;
  onClose: () => void;
}

// Match server's MAX_OUTPUT_BYTES rolling window so client view stays in sync
// with what `init` seeds: 256K JS chars per stream.
const OUTPUT_WINDOW_CHARS = 256 * 1024;

const STATUS_DOT: Record<TaskStatus, string> = {
  running: "bg-amber pulse-dot",
  completed: "bg-green",
  killed: "bg-fg/30",
  failed: "bg-red",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "running",
  completed: "completed",
  killed: "killed",
  failed: "failed",
};

function fmtElapsed(startedAt: number, finishedAt: number | null): string {
  const end = finishedAt ?? Date.now();
  const s = Math.max(0, (end - startedAt) / 1000);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m ${rem}s`;
}

function truncCmd(cmd: string, max = 56): string {
  const single = cmd.replace(/\s+/g, " ");
  return single.length > max ? single.slice(0, max - 1) + "…" : single;
}

export default function TasksModal({ sessionId, onClose }: Props) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [output, setOutput] = useState<TaskOutput | null>(null);
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const stickBottom = useRef(true);

  // Global: Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Subscribe to task-list updates (SSE). Fires on add/status/kill.
  useEffect(() => {
    return subscribeTasksList(sessionId, (d) => {
      setTasks(d.tasks);
      setLoading(false);
      setSelectedId((cur) => {
        if (cur && d.tasks.some((t) => t.id === cur)) return cur;
        return d.tasks[0]?.id ?? null;
      });
    });
  }, [sessionId]);

  // Subscribe to the selected task's output (SSE). `init` seeds full buffer,
  // `stdout`/`stderr` append chunks, `status` updates lifecycle fields.
  useEffect(() => {
    if (!selectedId) {
      setOutput(null);
      return;
    }
    return subscribeTaskStream(selectedId, (ev) => {
      if (ev.type === "init") {
        setOutput(ev.payload);
        return;
      }
      if (ev.type === "done") return;
      setOutput((cur) => {
        if (!cur) return cur;
        if (ev.type === "stdout") {
          const combined = cur.stdout + ev.chunk;
          const overflow = Math.max(0, combined.length - OUTPUT_WINDOW_CHARS);
          return {
            ...cur,
            stdout: overflow ? combined.slice(overflow) : combined,
            stdoutBytes: cur.stdoutBytes + ev.chunk.length,
          };
        }
        if (ev.type === "stderr") {
          const combined = cur.stderr + ev.chunk;
          const overflow = Math.max(0, combined.length - OUTPUT_WINDOW_CHARS);
          return {
            ...cur,
            stderr: overflow ? combined.slice(overflow) : combined,
            stderrBytes: cur.stderrBytes + ev.chunk.length,
          };
        }
        if (ev.type === "status") {
          return {
            ...cur,
            status: ev.status,
            exitCode: ev.exitCode,
            endReason: ev.endReason,
            finishedAt: ev.finishedAt,
            truncated: ev.truncated,
          };
        }
        return cur;
      });
    });
  }, [selectedId]);

  // Track whether user is scrolled to bottom of output (for sticky auto-scroll)
  const onOutputScroll = () => {
    const el = outputRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickBottom.current = near;
  };

  useLayoutEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    if (stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Reset stick-to-bottom when switching tasks
  useEffect(() => {
    stickBottom.current = true;
  }, [selectedId]);

  const handleKill = async () => {
    if (!selectedId || killing) return;
    setKilling(true);
    try {
      await killTask(selectedId);
      // status + list updates arrive via SSE; nothing else to do.
    } catch (err) {
      console.error("kill failed:", err);
    } finally {
      setKilling(false);
    }
  };

  const selected = output;
  const hasTasks = tasks.length > 0;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={[
          "w-full max-w-[880px] h-[560px]",
          "bg-surface border border-line-strong rounded-xl overflow-hidden",
          "shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85)]",
          "flex flex-col",
        ].join(" ")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-line shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-fg text-[14px] font-semibold tracking-tight">
              后台任务
            </h3>
            <span className="text-[11px] font-mono text-subtle">
              {tasks.length
                ? `${tasks.filter((t) => t.status === "running").length} running · ${tasks.length} total`
                : loading
                  ? "加载中…"
                  : "暂无任务"}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-subtle hover:text-fg p-1 rounded"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M3 3L11 11M11 3L3 11"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Body: split */}
        <div className="flex-1 min-h-0 flex">
          {/* Left: task list */}
          <div className="w-[260px] shrink-0 border-r border-line overflow-y-auto">
            {!hasTasks && !loading && (
              <div className="p-5 text-[12.5px] text-subtle leading-relaxed">
                暂无后台任务
              </div>
            )}
            <ul className="py-1">
              {tasks.map((t) => {
                const active = t.id === selectedId;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => setSelectedId(t.id)}
                      className={[
                        "w-full text-left px-3 py-2.5 border-l-2 transition-colors",
                        active
                          ? "bg-raised border-blue"
                          : "border-transparent hover:bg-canvas/40",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={[
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            STATUS_DOT[t.status],
                          ].join(" ")}
                        />
                        <span className="font-mono text-[11px] text-subtle truncate">
                          {t.id}
                        </span>
                        <span className="ml-auto font-mono text-[10.5px] text-subtle shrink-0">
                          {fmtElapsed(t.startedAt, t.finishedAt)}
                        </span>
                      </div>
                      <div
                        className={[
                          "font-mono text-[11.5px] leading-snug break-words",
                          active ? "text-fg" : "text-muted",
                        ].join(" ")}
                      >
                        {truncCmd(t.command)}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Right: output pane */}
          <div className="flex-1 min-w-0 flex flex-col">
            {!selected ? (
              <div className="flex-1 flex items-center justify-center text-subtle text-[12.5px]">
                {hasTasks ? "选择左侧任务查看输出" : "—"}
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b border-line shrink-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span
                      className={[
                        "w-1.5 h-1.5 rounded-full shrink-0",
                        STATUS_DOT[selected.status],
                      ].join(" ")}
                    />
                    <span className="text-[11px] font-mono text-subtle uppercase tracking-[0.08em]">
                      {STATUS_LABEL[selected.status]}
                    </span>
                    {selected.exitCode != null && (
                      <span className="text-[11px] font-mono text-subtle">
                        · exit {selected.exitCode}
                      </span>
                    )}
                    <span className="text-[11px] font-mono text-subtle">
                      ·{" "}
                      {fmtElapsed(selected.startedAt, selected.finishedAt)}
                    </span>
                    <span className="text-[11px] font-mono text-subtle">
                      · {selected.id}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      {selected.status === "running" && (
                        <button
                          onClick={handleKill}
                          disabled={killing}
                          className={[
                            "px-2.5 h-6 rounded text-[11px] font-mono",
                            "border border-red/40 text-red",
                            "hover:bg-red/10 hover:border-red/60",
                            "disabled:opacity-50 disabled:cursor-wait",
                            "transition-colors",
                          ].join(" ")}
                        >
                          {killing ? "killing…" : "kill"}
                        </button>
                      )}
                    </div>
                  </div>
                  <pre className="font-mono text-[12px] text-fg bg-canvas/40 border border-fg/10 rounded px-2.5 py-1.5 whitespace-pre-wrap break-all max-h-[3.2em] overflow-y-auto">
                    {selected.command}
                  </pre>
                  {selected.cwd && (
                    <div className="mt-1 font-mono text-[10.5px] text-subtle truncate">
                      cwd: {selected.cwd}
                    </div>
                  )}
                  {selected.endReason && (
                    <div className="mt-1 font-mono text-[10.5px] text-subtle">
                      [{selected.endReason}]
                    </div>
                  )}
                </div>

                <pre
                  ref={outputRef}
                  onScroll={onOutputScroll}
                  className="flex-1 min-h-0 overflow-y-auto font-mono text-[12px] leading-[1.55] text-fg px-4 py-3 whitespace-pre-wrap break-words bg-canvas/20"
                >
                  {renderOutput(selected)}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderOutput(o: TaskOutput): string {
  const parts: string[] = [];
  if (o.stdout) {
    parts.push(o.stdout.trimEnd());
  }
  if (o.stderr) {
    if (parts.length) parts.push("");
    parts.push("── stderr ──");
    parts.push(o.stderr.trimEnd());
  }
  if (o.truncated) {
    if (parts.length) parts.push("");
    parts.push("[rolling window: only the last 256K chars are kept per stream]");
  }
  if (!o.stdout && !o.stderr) {
    return o.status === "running" ? "(还没有输出)" : "(无输出)";
  }
  return parts.join("\n");
}
