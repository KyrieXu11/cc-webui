import { getDb, transact } from "./db.ts";
import type { SessionSummary } from "./session-store.ts";

// Rebuildable index only. Never store actor, mine, shares or an already scoped
// result list. The native file remains canonical, authorization stays outside.
export class SessionSummaryIndex<T extends SessionSummary> {
  private warned = false;
  constructor(private namespace: string, private maxEntries: number, private maxBytes: number) {}

  private attempt<R>(fn: () => R, fallback: R): R {
    try { return fn(); } catch {
      // A broken/full derived index must not make native history unavailable.
      if (!this.warned) {
        this.warned = true;
        console.warn("[cc-webui] native summary index unavailable; using native files");
      }
      return fallback;
    }
  }

  get(file: string, stamp: string): T | null {
    return this.attempt(() => {
      const db = getDb();
      const row = db.prepare("SELECT value FROM native_session_summaries WHERE namespace=? AND file=? AND stamp=? AND bytes<=?")
        .get(this.namespace, file, stamp, this.maxBytes) as { value: string } | undefined;
      if (!row) return null;
      const value = JSON.parse(row.value) as T;
      if (!value || typeof value.sessionId !== "string" || typeof value.summary !== "string" ||
        !["claude", "codex"].includes(value.provider) || !Number.isFinite(value.lastModified)) return null;
      for (const key of ["cwd", "firstPrompt", "customTitle", "filePath"] as const) {
        const field = (value as T & { filePath?: string })[key];
        if (field !== undefined && typeof field !== "string") return null;
      }
      db.prepare("UPDATE native_session_summaries SET touched_at=? WHERE namespace=? AND file=?")
        .run(Date.now(), this.namespace, file);
      return value;
    }, null);
  }

  put(file: string, stamp: string, value: T): void {
    this.attempt(() => {
      // Explicit metadata allowlist: no extra T fields, attachments, events,
      // sharing flags, capabilities or account-dependent results can persist.
      const raw = JSON.stringify({ sessionId: value.sessionId, provider: value.provider,
        summary: value.summary, lastModified: value.lastModified, cwd: value.cwd,
        firstPrompt: value.firstPrompt, customTitle: value.customTitle,
        filePath: (value as T & { filePath?: string }).filePath });
      const bytes = Buffer.byteLength(raw);
      transact(() => {
        const db = getDb();
        // Oversized values must not leave an obsolete row behind.
        db.prepare("DELETE FROM native_session_summaries WHERE namespace=? AND file=?").run(this.namespace, file);
        if (bytes <= this.maxBytes) db.prepare("INSERT INTO native_session_summaries(namespace,file,stamp,value,bytes,touched_at) VALUES(?,?,?,?,?,?)")
          .run(this.namespace, file, stamp, raw, bytes, Date.now());
        const rows = db.prepare("SELECT file,bytes FROM native_session_summaries WHERE namespace=? ORDER BY touched_at DESC,rowid DESC")
          .all(this.namespace) as Array<{ file: string; bytes: number }>;
        let used = 0;
        const remove = db.prepare("DELETE FROM native_session_summaries WHERE namespace=? AND file=?");
        for (const [i, row] of rows.entries()) {
          used += row.bytes;
          if (i >= this.maxEntries || used > this.maxBytes) remove.run(this.namespace, row.file);
        }
      });
    }, undefined);
  }

  prune(files: Set<string>): void {
    this.attempt(() => transact(() => {
      const db = getDb();
      const rows = db.prepare("SELECT file FROM native_session_summaries WHERE namespace=?").all(this.namespace) as Array<{ file: string }>;
      const remove = db.prepare("DELETE FROM native_session_summaries WHERE namespace=? AND file=?");
      for (const { file } of rows) if (!files.has(file)) remove.run(this.namespace, file);
    }), undefined);
  }
}
