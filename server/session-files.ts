// 「本对话文件」registry —— 某条会话的 turn 亲手创建或改动过的、位于该会话 cwd
// 之下的文件。设计与全部决策见 docs/file-manager.md，术语见 CONTEXT.md。
//
// 为什么不是「扫 transcript 里的 Write/Edit」：cc-webui 的 agent 主要用
// mcp__bash__run 写盘（内置 Bash 被 disallowedTools 禁掉、换成 bash MCP），
// 重定向、cp、脚本批量生成的文件一个都不在工具参数里。只认工具参数会出现
// 「agent 明明生成了 3 份计划，文件栏只有 1 份」——最伤信任的那种错。
//
// 所以判定放在文件系统一侧：turn 开始时记 turnStartMs，收尾扫一遍 cwd，
// mtime >= turnStartMs 即算这个 turn 碰过。一次扫描，不需要开头再扫一次做
// 内存快照。
//
// ⚠️ 刻意不上递归 fs.watch：launchd 起的进程读 ~/Documents 会被 macOS TCC
// 永久挂住（server/fs.ts 的 readdirOrGiveUp 就是为此写的 800ms 兜底），
// 递归 watcher 在同一片雷区里。

import { promises as fsp } from "node:fs";
import path from "node:path";
import { getDb, transact } from "./db.ts";

export type SessionFile = {
  path: string;
  firstSeenMs: number;
  lastTouchedMs: number;
  size: number;
  mtimeMs: number;
};

// ─── 扫描护栏 ────────────────────────────────────────────────────────────────
//
// 缺任何一个，拿代码仓库当 cwd 时每个 turn 都要多花几百毫秒到几秒。
// 实测（本机全量 walk+stat）：workspaces 6 文件 0.2ms · cc-webui 14225 文件
// 307ms · ~/tmp 122442 文件 3.05s。

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "target", ".gradle", ".idea", ".cache", "coverage", ".turbo",
]);

const MAX_DEPTH = 8;
// 超过这个数就放弃整棵树的扫描：与其让每个 turn 多花几秒，不如明确降级并说清楚。
const MAX_FILES = 20_000;

export type ScanOutcome =
  | { kind: "scanned"; touched: SessionFile[]; seen: number }
  | { kind: "too-big"; seen: number };

// 扫 cwd，返回 mtime >= sinceMs 的文件。深度/数量超限即整体放弃（"too-big"），
// 调用方据此降级到只认工具参数报告过的路径。
export async function scanTouched(
  cwd: string,
  sinceMs: number
): Promise<ScanOutcome> {
  const touched: SessionFile[] = [];
  let seen = 0;
  const now = Date.now();

  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > MAX_DEPTH) return true;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // 权限不足 / 刚被删掉 / TCC 挡住 —— 跳过这一支，不是致命错误。
      return true;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (!(await walk(full, depth + 1))) return false;
        continue;
      }
      if (!ent.isFile()) continue; // symlink / socket / fifo 都不算产出
      if (++seen > MAX_FILES) return false;
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (st.mtimeMs >= sinceMs) {
        touched.push({
          path: full,
          firstSeenMs: now,
          lastTouchedMs: st.mtimeMs,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
    return true;
  };

  const ok = await walk(cwd, 0);
  return ok ? { kind: "scanned", touched, seen } : { kind: "too-big", seen };
}

// ─── 存储 ────────────────────────────────────────────────────────────────────

// first_seen_ms 只在插入时写：一个文件被反复改动，"第一次出现"不应该跟着动。
export function recordSessionFiles(
  sessionId: string,
  files: readonly SessionFile[]
): void {
  if (!sessionId || files.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO session_files
      (session_id, path, first_seen_ms, last_touched_ms, size, mtime_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, path) DO UPDATE SET
      last_touched_ms = excluded.last_touched_ms,
      size            = excluded.size,
      mtime_ms        = excluded.mtime_ms
  `);
  transact(() => {
    for (const f of files) {
      stmt.run(
        sessionId,
        f.path,
        f.firstSeenMs,
        f.lastTouchedMs,
        f.size,
        f.mtimeMs
      );
    }
  });
}

export function listSessionFiles(sessionId: string): SessionFile[] {
  if (!sessionId) return [];
  const rows = getDb()
    .prepare(
      `SELECT path, first_seen_ms, last_touched_ms, size, mtime_ms
         FROM session_files
        WHERE session_id = ?
        ORDER BY last_touched_ms DESC`
    )
    .all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => ({
    path: String(r.path),
    firstSeenMs: Number(r.first_seen_ms),
    lastTouchedMs: Number(r.last_touched_ms),
    size: Number(r.size),
    mtimeMs: Number(r.mtime_ms),
  }));
}

export function forgetSessionFiles(
  sessionId: string,
  paths: readonly string[]
): void {
  if (!sessionId || paths.length === 0) return;
  const stmt = getDb().prepare(
    "DELETE FROM session_files WHERE session_id = ? AND path = ?"
  );
  transact(() => {
    for (const p of paths) stmt.run(sessionId, p);
  });
}

// 扫描时顺手把已经不在磁盘上的行删掉——取件台列一个不存在的文件毫无意义。
// 只在真的扫过（不是 too-big）时调用，否则会把没扫到的目录里的文件全清掉。
export async function pruneMissing(sessionId: string): Promise<number> {
  const rows = listSessionFiles(sessionId);
  const gone: string[] = [];
  for (const r of rows) {
    try {
      const st = await fsp.stat(r.path);
      if (!st.isFile()) gone.push(r.path);
    } catch {
      gone.push(r.path);
    }
  }
  forgetSessionFiles(sessionId, gone);
  return gone.length;
}

// ⚠️ 必须和 relabelScope / relabelTasksSessionId / relabelOwner 在同一处调用。
// 首个 turn 的 session id 是 CLI 自己发的，chat.ts 会把之前那个临时 id 全线改名；
// 这张表不跟着改，第一个 turn 的文件就永远挂在一个死 id 下面，谁都查不出来。
//
// INSERT OR REPLACE 而不是 UPDATE：新旧 id 下可能都已经有同一个路径的行
// （极少见，但主键冲突会让整个 relabel 抛出去，那比丢一行贵得多）。
export function relabelSessionFiles(oldId: string, newId: string): void {
  if (!oldId || !newId || oldId === newId) return;
  const db = getDb();
  transact(() => {
    db.prepare(
      `INSERT OR REPLACE INTO session_files
         (session_id, path, first_seen_ms, last_touched_ms, size, mtime_ms)
       SELECT ?, path, first_seen_ms, last_touched_ms, size, mtime_ms
         FROM session_files WHERE session_id = ?`
    ).run(newId, oldId);
    db.prepare("DELETE FROM session_files WHERE session_id = ?").run(oldId);
  });
}
