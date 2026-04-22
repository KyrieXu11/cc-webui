import { useEffect, useState } from "react";
import { subscribeTasksList, type TaskListResponse } from "../lib/tasks";

interface Props {
  sessionId: string | null;
  onOpen: () => void;
  /** Trigger a refresh when this counter changes (e.g., after modal closes). */
  refreshKey?: number;
}

export default function TasksButton({ sessionId, onOpen, refreshKey }: Props) {
  const [data, setData] = useState<TaskListResponse>({
    tasks: [],
    running: 0,
    total: 0,
  });

  useEffect(() => {
    return subscribeTasksList(sessionId, setData);
  }, [refreshKey, sessionId]);

  const { running, total } = data;
  const label =
    total === 0
      ? "no background tasks"
      : running > 0
        ? `${running} running · ${total} total`
        : `${total} finished`;

  return (
    <button
      onClick={onOpen}
      className={[
        "group flex items-center gap-2 px-2.5 h-6 rounded",
        "font-mono text-[11px] tracking-tight",
        "border border-fg/10 bg-canvas/40 hover:border-fg/25 hover:bg-raised",
        "text-subtle hover:text-fg transition-colors",
      ].join(" ")}
      title="打开后台任务面板"
    >
      <span
        className={[
          "w-1.5 h-1.5 rounded-full",
          running > 0 ? "bg-amber pulse-dot" : "bg-fg/20",
        ].join(" ")}
      />
      <span>{label}</span>
      <span className="text-fg/30 group-hover:text-fg/60">↗</span>
    </button>
  );
}
