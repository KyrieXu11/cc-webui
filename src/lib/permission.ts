import type { PermissionDecision } from "./types";

export async function sendPermission(
  id: string,
  behavior: PermissionDecision,
  message?: string,
  // AskUserQuestion 专用：以「问题原文」为 key 的答案，服务端会并进 updatedInput。
  answers?: Record<string, string>
): Promise<void> {
  const res = await fetch(`/api/permission/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ behavior, message, answers }),
  });
  if (!res.ok) throw new Error(`permission resolve failed: ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error("permission request is no longer pending");
}
