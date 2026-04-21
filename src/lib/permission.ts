export async function sendPermission(
  id: string,
  behavior: "allow" | "deny",
  message?: string
): Promise<void> {
  const res = await fetch(`/api/permission/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ behavior, message }),
  });
  if (!res.ok) throw new Error(`permission resolve failed: ${res.status}`);
}
