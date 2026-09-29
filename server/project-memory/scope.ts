import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { getAllowedPaths, getUserById } from "../auth/users.ts";
import { assertCanOpen } from "../auth/paths.ts";
import { getDb } from "../db.ts";
export class MemoryError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
export type MemoryScope = {
  id: string;
  actorId: string;
  cwd: string;
  projectKey: string;
};
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function resolveMemoryScope(actorId: string, cwd: string): Promise<MemoryScope> {
  if (!getUserById(actorId)) throw new MemoryError("scope_unavailable", "账号不可用");
  let canonical: string;
  try {
    canonical = await assertCanOpen(cwd, getAllowedPaths(actorId));
    if (!(await stat(canonical)).isDirectory()) throw new Error("not directory");
  } catch {
    throw new MemoryError("scope_unavailable", "当前账号不能访问此项目");
  }
  const projectKey = digest(canonical);
  const scope = {
    id: projectKey,
    actorId,
    cwd: canonical,
    projectKey
  };
  getDb().prepare(`INSERT INTO project_memory_scopes(id,cwd,project_key) VALUES(?,?,?)
    ON CONFLICT(id) DO NOTHING`).run(scope.id, canonical, projectKey);
  return scope;
}
export async function validateMemoryScope(scope: MemoryScope): Promise<void> {
  const current = await resolveMemoryScope(scope.actorId, scope.cwd);
  if (current.id !== scope.id || current.projectKey !== scope.projectKey) {
    throw new MemoryError("scope_unavailable", "项目范围已改变");
  }
}
