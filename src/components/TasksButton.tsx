import { useEffect, useState } from "react";
import {
  subscribeTasksList,
  subscribeTasksListScoped,
  type TaskListResponse,
  type TaskScope,
} from "../lib/tasks";

interface Props {
  sessionId?: string | null;
  // Either sessionId (legacy single-chat) OR scope (group: { sessionPrefix }).
  scope?: TaskScope;
  onOpen: () => void;
  /** Trigger a refresh when this counter changes (e.g., after modal closes). */
  refreshKey?: number;
}

export default function TasksButton({
  sessionId,
  scope,
  onOpen,
  refreshKey,
}: Props) {
  const [data, setData] = useState<TaskListResponse>({
    tasks: [],
    running: 0,
    total: 0,
  });

  useEffect(() => {
    if (scope) return subscribeTasksListScoped(scope, setData);
    return subscribeTasksList(sessionId ?? null, setData);
  }, [refreshKey, sessionId, JSON.stringify(scope)]);

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
