import type { PermissionDecision } from "./types";

export async function sendPermission(
  id: string,
  behavior: PermissionDecision,
  message?: string
): Promise<void> {
  const res = await fetch(`/api/permission/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ behavior, message }),
  });
  if (!res.ok) throw new Error(`permission resolve failed: ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error("permission request is no longer pending");
}
