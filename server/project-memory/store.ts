import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb, transact, dbPath } from "../db.ts";
import { normalizePath } from "../auth/paths.ts";
import { digest, MemoryError, validateMemoryScope, type MemoryScope } from "./scope.ts";
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
export type MemoryEntry = {
  id: string;
  name: string;
  description: string;
  type: MemoryType;
  revision: number;
  provider: string;
  sessionId: string;
  updatedAt: number;
};
type Row = MemoryEntry & {
  file: string;
  hash: string;
  bodyOffset: number;
};
export type SaveMemory = {
  operation_id: string;
  id?: string;
  expected_revision?: number;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
};
export type DeleteMemory = {
  operation_id: string;
  id: string;
  expected_revision: number;
};
type Result = {
  id: string;
  revision: number;
  scope_revision: number;
  deleted?: boolean;
  cleanup_pending?: boolean;
  replayed?: boolean;
};
// 包含生成的 frontmatter；32 KiB 容纳迁移中的已有长记忆，不截断正文。
export const MAX_MEMORY_BYTES = 32 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ROOT_MARKER = ".cc-webui-project-memory";
const SELECT = `SELECT id,name,description,type,revision,provider,session_id AS sessionId,
  updated_at AS updatedAt,file,hash,body_offset AS bodyOffset FROM project_memories`;
export const memoryRoot = () => path.resolve(process.env.CC_WEBUI_PROJECT_MEMORY_DIR || path.join(os.homedir(), ".cc-webui/project-memory"));
const queues = new Map<string, Promise<unknown>>();
const recoveries = new Map<string, Promise<void>>();
function folder(scope: MemoryScope, id?: string): string {
  if (!UUID.test(scope.actorId) || id && !UUID.test(id) || !/^[a-f0-9]{64}$/.test(scope.projectKey)) throw new MemoryError("scope_unavailable", "记忆范围无效");
  return path.join(memoryRoot(), "projects", scope.projectKey, ...(id ? [id] : []));
}
function absolute(file: string): string {
  const root = memoryRoot();
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(root + path.sep)) throw new MemoryError("memory_corrupt", "记忆文件定位无效");
  return resolved;
}
function row(scope: MemoryScope, id: string): Row {
  const r = getDb().prepare(`${SELECT} WHERE scope_id=? AND id=?`).get(scope.id, id) as Row | undefined;
  if (!r) throw new MemoryError("not_found", "此项目没有该记忆");
  return r;
}
function entry(r: Row): MemoryEntry {
  const {
    file: _f,
    hash: _h,
    bodyOffset: _o,
    ...meta
  } = r;
  return meta;
}
export function scopeRevision(scope: MemoryScope): number {
  return Number((getDb().prepare("SELECT revision FROM project_memory_scopes WHERE id=?").get(scope.id) as {
    revision: number;
  } | undefined)?.revision ?? 0);
}
function bump(scope: MemoryScope): number {
  getDb().prepare("UPDATE project_memory_scopes SET revision=revision+1 WHERE id=?").run(scope.id);
  return scopeRevision(scope);
}
async function locked<T>(scope: MemoryScope, fn: () => Promise<T>): Promise<T> {
  const key = memoryRoot() + scope.id;
  const prior = queues.get(key) ?? Promise.resolve();
  const pending = prior.catch(() => {}).then(async () => {
    await validateMemoryScope(scope);
    return fn();
  });
  queues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(key) === pending) queues.delete(key);
  }
}
export async function listMemory(scope: MemoryScope, cursor = 0, limit = 50) {
  return locked(scope, async () => {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MemoryError("invalid_input", "分页参数无效");
    const rows = getDb().prepare(`${SELECT} WHERE scope_id=? ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(scope.id, limit, cursor) as Row[];
    const total = Number((getDb().prepare("SELECT COUNT(*) AS n FROM project_memories WHERE scope_id=?").get(scope.id) as {
      n: number;
    }).n);
    return {
      entries: rows.map(entry),
      total,
      scope_revision: scopeRevision(scope),
      next_cursor: cursor + rows.length < total ? cursor + rows.length : null
    };
  });
}
export async function searchMemory(scope: MemoryScope, query: string, limit = 10) {
  return locked(scope, async () => {
    if (!query.trim() || query.length > 512 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new MemoryError("invalid_input", "搜索参数无效");
    const q = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    const rows = getDb().prepare(`${SELECT} WHERE scope_id=? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') ORDER BY updated_at DESC,id LIMIT ?`).all(scope.id, q, q, limit) as Row[];
    return {
      entries: rows.map(entry),
      scope_revision: scopeRevision(scope)
    };
  });
}
export async function readMemory(scope: MemoryScope, id: string) {
  return locked(scope, async () => {
    const r = row(scope, id);
    try {
      const file = absolute(r.file);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > MAX_MEMORY_BYTES) throw new Error("invalid file");
      const text = await fs.readFile(file, "utf8");
      if (digest(text) !== r.hash) throw new Error("hash mismatch");
      return {
        ...entry(r),
        body: text.slice(r.bodyOffset)
      };
    } catch {
      throw new MemoryError("memory_corrupt", "记忆正文丢失或被外部修改");
    }
  });
}
function checkOperation(id: string): void {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) throw new MemoryError("invalid_input", "operation_id 应为稳定的短标识");
}
function previous(scope: MemoryScope, id: string, hash: string): Result | null {
  const r = getDb().prepare("SELECT request_hash AS hash,result FROM project_memory_operations WHERE scope_id=? AND actor_id=? AND operation_id=?").get(scope.id, scope.actorId, id) as {
    hash: string;
    result: string;
  } | undefined;
  if (!r) return null;
  if (r.hash !== hash) throw new MemoryError("idempotency_conflict", "同一 operation_id 不能用于不同写入");
  return {
    ...(JSON.parse(r.result) as Result),
    replayed: true,
    scope_revision: scopeRevision(scope)
  };
}
function record(scope: MemoryScope, id: string, hash: string, result: Result): void {
  getDb().prepare("INSERT INTO project_memory_operations(scope_id,actor_id,operation_id,request_hash,result) VALUES(?,?,?,?,?)").run(scope.id, scope.actorId, id, hash, JSON.stringify(result));
}
function checkSave(input: SaveMemory): void {
  checkOperation(input.operation_id);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.name) || !input.description.trim() || input.description.length > 240 || /[\r\n]/.test(input.description) || !MEMORY_TYPES.includes(input.type) || !input.body.trim()) {
    throw new MemoryError("invalid_input", "需要稳定的 name、单行 description、有效 type 与正文");
  }
  if (!input.id && input.expected_revision !== undefined) throw new MemoryError("invalid_input", "创建不应带 expected_revision");
  if (input.id && (!UUID.test(input.id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision! < 1)) throw new MemoryError("invalid_input", "更新需要 id 和 expected_revision");
  if (/\bsk-(?:ant-|proj-)?[a-zA-Z0-9_-]{24,}\b/.test(input.body)) throw new MemoryError("invalid_input", "不要保存密钥或凭据");
}
export async function saveMemory(scope: MemoryScope, input: SaveMemory, source: {
  provider: string;
  sessionId: string;
}): Promise<Result> {
  checkSave(input);
  await recoverMemoryFiles();
  return locked(scope, async () => {
    const hash = digest(JSON.stringify(["save", input.id ?? null, input.expected_revision ?? null, input.name, input.description, input.type, input.body]));
    const old = previous(scope, input.operation_id, hash);
    if (old) return old;
    const before = input.id ? row(scope, input.id) : undefined;
    if (before && before.revision !== input.expected_revision) throw new MemoryError("revision_conflict", `当前 revision 为 ${before.revision}，请重新 read`);
    const duplicate = getDb().prepare("SELECT id FROM project_memories WHERE scope_id=? AND name=?").get(scope.id, input.name) as {
      id: string;
    } | undefined;
    if (duplicate && duplicate.id !== before?.id) throw new MemoryError("name_conflict", `已有同名记忆 id=${duplicate.id}，请 read 后更新`);
    const id = before?.id ?? randomUUID();
    const revision = (before?.revision ?? 0) + 1;
    const now = Date.now();
    const header = `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\nmetadata:\n  type: ${input.type}\n  modified: ${new Date(now).toISOString()}\n---\n\n`;
    const text = header + input.body;
    if (Buffer.byteLength(text) > MAX_MEMORY_BYTES) throw new MemoryError("content_too_large", "每条记忆最多 32 KiB，请缩短或拆分主题");
    const dir = folder(scope, id);
    await fs.mkdir(dir, {
      recursive: true,
      mode: 0o700
    });
    const file = path.join(dir, randomUUID() + ".md");
    const temp = file + ".tmp";
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, file);
      await validateMemoryScope(scope);
      return transact(() => {
        const relative = path.relative(memoryRoot(), file);
        if (before) {
          const change = getDb().prepare(`UPDATE project_memories SET name=?,description=?,type=?,revision=?,file=?,hash=?,body_offset=?,provider=?,session_id=?,updated_at=? WHERE scope_id=? AND id=? AND revision=?`).run(input.name, input.description, input.type, revision, relative, digest(text), header.length, source.provider, source.sessionId, now, scope.id, id, before.revision);
          if (!change.changes) throw new MemoryError("revision_conflict", "记忆已改变，请重新 read");
        } else {
          getDb().prepare(`INSERT INTO project_memories(id,scope_id,name,description,type,revision,file,hash,body_offset,provider,session_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope.id, input.name, input.description, input.type, revision, relative, digest(text), header.length, source.provider, source.sessionId, now);
        }
        getDb().prepare("INSERT INTO project_memory_revisions(memory_id,revision,parent_revision,file,hash,body_offset,provider,session_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, revision, revision - 1, relative, digest(text), header.length, source.provider, source.sessionId, now);
        const result = {
          id,
          revision,
          scope_revision: bump(scope)
        };
        record(scope, input.operation_id, hash, result);
        return result;
      });
    } catch (err) {
      await fs.rm(temp, {
        force: true
      }).catch(() => {});
      await fs.rm(file, {
        force: true
      }).catch(() => {});
      if (err instanceof MemoryError) throw err;
      throw new MemoryError("storage_unavailable", "记忆未能保存，请重试同一 operation_id");
    }
  });
}
export async function deleteMemory(scope: MemoryScope, input: DeleteMemory): Promise<Result> {
  checkOperation(input.operation_id);
  if (!UUID.test(input.id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw new MemoryError("invalid_input", "删除需要 id 和 expected_revision");
  return locked(scope, async () => {
    const hash = digest(JSON.stringify(["delete", input.id, input.expected_revision]));
    let result = previous(scope, input.operation_id, hash);
    if (!result) {
      const current = row(scope, input.id);
      if (current.revision !== input.expected_revision) throw new MemoryError("revision_conflict", `当前 revision 为 ${current.revision}，请重新 read`);
      result = transact(() => {
        const deleted = getDb().prepare("DELETE FROM project_memories WHERE scope_id=? AND id=? AND revision=?").run(scope.id, input.id, input.expected_revision);
        if (!deleted.changes) throw new MemoryError("revision_conflict", "记忆已改变，请重新 read");
        const out = {
          id: input.id,
          revision: current.revision + 1,
          scope_revision: bump(scope),
          deleted: true,
          cleanup_pending: true
        };
        record(scope, input.operation_id, hash, out);
        return out;
      });
    }
    if (result.cleanup_pending) {
      try {
        await removeMemoryBodies(scope, input.id);
      } catch {
        throw new MemoryError("delete_cleanup_pending", "已停止召回，但正文清理失败；请重试同一 operation_id");
      }
      result.cleanup_pending = false;
      getDb().prepare("UPDATE project_memory_operations SET result=? WHERE scope_id=? AND actor_id=? AND operation_id=?").run(JSON.stringify(result), scope.id, scope.actorId, input.operation_id);
    }
    return result;
  });
}

// Run once per database/root, before the first write. Never race an in-progress write.
export async function recoverMemoryFiles(): Promise<void> {
  const key = dbPath() + "|" + memoryRoot();
  const previous = recoveries.get(key);
  if (previous) return previous;
  const run = (async () => {
    const root = memoryRoot();
    const canonicalRoot = await normalizePath(root);
    const nativeRoots = [process.env.CC_WEBUI_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude/projects"), path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "memories")];
    for (const native of nativeRoots) {
      const canonicalNative = await normalizePath(native);
      if (canonicalRoot === canonicalNative || canonicalRoot.startsWith(canonicalNative + path.sep)) throw new MemoryError("storage_unavailable", "项目记忆库不能放在 CLI 原生记忆目录中");
    }
    await fs.mkdir(root, {
      recursive: true,
      mode: 0o700
    });
    const marker = path.join(root, ROOT_MARKER);
    try {
      const info = await fs.lstat(marker);
      if (!info.isFile() || (await fs.readFile(marker, "utf8")) !== "cc-webui-project-memory-v1\n") throw new Error("invalid marker");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (await fs.readdir(root)).length !== 0) {
        throw new MemoryError("storage_unavailable", "配置的记忆目录不是 cc-webui 记忆库，不能复用非空目录");
      }
      await fs.writeFile(marker, "cc-webui-project-memory-v1\n", {
        flag: "wx",
        mode: 0o600
      });
    }
    const live = new Set((getDb().prepare("SELECT file FROM project_memory_revisions").all() as {
      file: string;
    }[]).map(r => absolute(r.file)));
    async function walk(dir: string, depth = 0) {
      let entries;
      try {
        entries = await fs.readdir(dir, {
          withFileTypes: true
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const e of entries) {
        const file = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        // Shared projects/hash/memory/version, plus historical actor/hash/... pointers.
        const directory = depth === 0 ? e.name === "projects" || UUID.test(e.name) : depth === 1 ? /^[a-f0-9]{64}$/.test(e.name) : UUID.test(e.name);
        if (e.isDirectory() && depth < 3 && directory) await walk(file, depth + 1);else if (depth === 3 && e.isFile() && UUID.test(e.name.replace(/\.md(?:\.tmp)?$/, "")) && /\.md(?:\.tmp)?$/.test(e.name) && !live.has(file)) await fs.rm(file, {
          force: true
        });
      }
    }
    await walk(memoryRoot());
  })();
  recoveries.set(key, run);
  try {
    await run;
  } catch (err) {
    recoveries.delete(key);
    throw err;
  }
}
async function removeMemoryBodies(scope: MemoryScope, id: string): Promise<void> {
  // Immutable versions created before schema 10 may still live under actor
  // directories. Deleting a shared entry removes BOTH layouts, not just the
  // current writer's folder. Account deletion never calls this function.
  await recoverMemoryFiles();
  await fs.rm(folder(scope, id), { recursive: true, force: true });
  for (const entry of await fs.readdir(memoryRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    await fs.rm(path.join(memoryRoot(), entry.name, scope.projectKey, id), { recursive: true, force: true });
  }
}
