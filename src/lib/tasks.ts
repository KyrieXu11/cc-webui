export type TaskStatus = "running" | "completed" | "killed" | "failed";

export interface TaskSummary {
  id: string;
  command: string;
  cwd: string | null;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  status: TaskStatus;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  endReason: string | null;
}

export interface TaskOutput extends TaskSummary {
  stdout: string;
  stderr: string;
}

export interface TaskListResponse {
  tasks: TaskSummary[];
  running: number;
  total: number;
}

export type TaskScope =
  | { sessionId: string }
  | { sessionPrefix: string };

function scopeQS(scope: TaskScope): URLSearchParams {
  if ("sessionPrefix" in scope) {
    return new URLSearchParams({ sessionPrefix: scope.sessionPrefix });
  }
  return new URLSearchParams({ sessionId: scope.sessionId });
}

export async function listTasks(
  sessionId: string | null
): Promise<TaskListResponse> {
  if (!sessionId) return { tasks: [], running: 0, total: 0 };
  const qs = new URLSearchParams({ sessionId });
  const res = await fetch(`/api/bash/tasks?${qs}`);
  if (!res.ok) throw new Error(`listTasks failed: ${res.status}`);
  return res.json();
}

export async function listTasksScoped(
  scope: TaskScope
): Promise<TaskListResponse> {
  const res = await fetch(`/api/bash/tasks?${scopeQS(scope)}`);
  if (!res.ok) throw new Error(`listTasksScoped failed: ${res.status}`);
  return res.json();
}

export async function getTaskOutput(id: string): Promise<TaskOutput> {
  const res = await fetch(`/api/bash/tasks/${encodeURIComponent(id)}/output`);
  if (!res.ok) throw new Error(`getTaskOutput failed: ${res.status}`);
  return res.json();
}

export async function detachForeground(
  fgId: string
): Promise<{ ok: boolean; bashTaskId?: string; reason?: string }> {
  const res = await fetch(
    `/api/bash/tasks/foreground/${encodeURIComponent(fgId)}/detach`,
    { method: "POST" }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`detachForeground failed: ${res.status}`);
  }
  return res.json().catch(() => ({ ok: false }));
}

export async function killTask(
  id: string
): Promise<{ ok: boolean; reason?: string; status: TaskStatus }> {
  const res = await fetch(`/api/bash/tasks/${encodeURIComponent(id)}/kill`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`killTask failed: ${res.status}`);
  return res.json();
}

// Subscribe to list-level updates over SSE. Fires on task added, status
// changed, or kill. Returns an unsubscribe function.
export function subscribeTasksList(
  sessionId: string | null,
  onSnapshot: (data: TaskListResponse) => void,
  onError?: (err: Event) => void
): () => void {
  if (!sessionId) {
    onSnapshot({ tasks: [], running: 0, total: 0 });
    return () => {};
  }
  const qs = new URLSearchParams({ sessionId });
  const es = new EventSource(`/api/bash/tasks/stream?${qs}`);
  es.addEventListener("snapshot", (e) => {
    try {
      onSnapshot(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore malformed frame */
    }
  });
  if (onError) es.addEventListener("error", onError);
  return () => es.close();
}

// Scoped variant that supports either single sessionId or a prefix
// (used by group chats: prefix `${gid}:` aggregates all agents).
export function subscribeTasksListScoped(
  scope: TaskScope,
  onSnapshot: (data: TaskListResponse) => void,
  onError?: (err: Event) => void
): () => void {
  const es = new EventSource(`/api/bash/tasks/stream?${scopeQS(scope)}`);
  es.addEventListener("snapshot", (e) => {
    try {
      onSnapshot(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore malformed frame */
    }
  });
  if (onError) es.addEventListener("error", onError);
  return () => es.close();
}

export type TaskStreamEvent =
  | { type: "init"; payload: TaskOutput }
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | {
      type: "status";
      status: TaskStatus;
      exitCode: number | null;
      endReason: string | null;
      finishedAt: number | null;
      truncated: boolean;
    }
  | { type: "done" };

export function subscribeTaskStream(
  id: string,
  onEvent: (ev: TaskStreamEvent) => void,
  onError?: (err: Event) => void
): () => void {
  const es = new EventSource(
    `/api/bash/tasks/${encodeURIComponent(id)}/stream`
  );
  const parse = <T = unknown>(e: Event): T | null => {
    try {
      return JSON.parse((e as MessageEvent).data) as T;
    } catch {
      return null;
    }
  };
  es.addEventListener("init", (e) => {
    const payload = parse<TaskOutput>(e);
    if (payload) onEvent({ type: "init", payload });
  });
  es.addEventListener("stdout", (e) => {
    const d = parse<{ chunk: string }>(e);
    if (d) onEvent({ type: "stdout", chunk: d.chunk });
  });
  es.addEventListener("stderr", (e) => {
    const d = parse<{ chunk: string }>(e);
    if (d) onEvent({ type: "stderr", chunk: d.chunk });
  });
  es.addEventListener("status", (e) => {
    const d = parse<{
      status: TaskStatus;
      exitCode: number | null;
      endReason: string | null;
      finishedAt: number | null;
      truncated: boolean;
    }>(e);
    if (d) onEvent({ type: "status", ...d });
  });
  es.addEventListener("done", () => {
    onEvent({ type: "done" });
    es.close();
  });
  if (onError) es.addEventListener("error", onError);
  return () => es.close();
}
