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
  if (total === 0) return null;

  const label =
    running > 0
      ? `${running} shell${running > 1 ? "s" : ""}`
      : `${total} done`;
  const dotClass = running > 0 ? "bg-amber pulse-dot" : "bg-fg/25";

  return (
    <button
      onClick={onOpen}
      className={[
        "flex items-center gap-1.5 px-1.5 h-6 rounded",
        "font-mono text-[11px] tracking-tight",
        "text-subtle hover:text-fg transition-colors",
      ].join(" ")}
      title="打开后台任务面板"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span>{label}</span>
    </button>
  );
}
