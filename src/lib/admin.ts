import type { AgentProvider } from "./settings";
import type { Role } from "./auth";
import type { UserDefaults } from "./user-defaults";

export type AdminUser = {
  id: string;
  username: string;
  role: Role;
  createdAt: number;
  // 只含管理员手写的那些；工作区那条是系统管的，单独放在 workspace 里
  // （决策 27），否则文本框会出现「删掉保存又自己回来」的行为。
  allowedPaths: string[];
  workspace: { dir: string; pattern: string } | null;
  ownedResources: number;
  // 管理员给这个账号设的默认模型 / effort，没设是 null。
  defaults: UserDefaults | null;
  allowedProviders: AgentProvider[];
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
  // 默认建一个工作区（服务端对管理员角色忽略这个字段）。
  workspace?: boolean;
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
  patch: {
    role?: Role;
    password?: string;
    allowedPaths?: string[];
    removeWorkspace?: boolean;
    createWorkspace?: boolean;
    // 两项都给 null = 清空。
    defaults?: { provider?: AgentProvider | null; model: string | null; effort: string | null };
    allowedProviders?: AgentProvider[];
  },
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
