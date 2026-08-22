import type { Role } from "./auth";

export type AdminUser = {
  id: string;
  username: string;
  role: Role;
  createdAt: number;
  allowedPaths: string[];
  ownedResources: number;
};

export type OpenedRecord = {
  userId: string;
  username: string;
  path: string;
  lastUsed: number;
};

export type SenderMapping = {
  openId: string;
  userId: string;
  username: string;
};

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  return (await json<{ users: AdminUser[] }>(await fetch("/api/admin/users")))
    .users;
}

export async function createAdminUser(input: {
  username: string;
  password: string;
  role: Role;
  allowedPaths: string[];
}): Promise<void> {
  await json(
    await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function patchAdminUser(
  id: string,
  patch: { role?: Role; password?: string; allowedPaths?: string[] },
): Promise<void> {
  await json(
    await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteAdminUser(id: string): Promise<void> {
  await json(await fetch(`/api/admin/users/${id}`, { method: "DELETE" }));
}

export async function listOpenedProjects(): Promise<OpenedRecord[]> {
  return (
    await json<{ records: OpenedRecord[] }>(
      await fetch("/api/admin/opened-projects"),
    )
  ).records;
}

export async function listSenderMappings(): Promise<SenderMapping[]> {
  return (
    await json<{ mappings: SenderMapping[] }>(
      await fetch("/api/admin/feishu-senders"),
    )
  ).mappings;
}

// An empty userId removes the mapping.
export async function putSenderMapping(
  openId: string,
  userId: string,
): Promise<void> {
  await json(
    await fetch("/api/admin/feishu-senders", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openId, userId }),
    }),
  );
}

export async function claimUnowned(): Promise<void> {
  await json(await fetch("/api/admin/claim-unowned", { method: "POST" }));
}
