import type { Stats } from "node:fs";
import type { SessionSummary } from "./session-store.ts";
import { SessionSummaryIndex } from "./session-summary-index.ts";

// Raw metadata only: visibility/sharing is evaluated on EVERY request.
export class SessionSummaryCache<T extends SessionSummary> {
  private entries = new Map<string, { stamp: string; value: T | null; bytes: number }>();
  private pending = new Map<string, Promise<T | null>>();
  private bytes = 0;
  private index?: SessionSummaryIndex<T>;

  constructor(private maxEntries = 1024, private maxBytes = 32 * 1024 * 1024, namespace?: string) {
    if (namespace) this.index = new SessionSummaryIndex(namespace, maxEntries, maxBytes);
  }

  prune(files: Set<string>): void {
    this.index?.prune(files);
    for (const [key, entry] of this.entries) if (!files.has(key)) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }

  async get(file: string, stat: Stats, read: () => Promise<T | null>): Promise<T | null> {
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const entry = this.entries.get(file);
    if (entry?.stamp === stamp) {
      this.entries.delete(file);
      this.entries.set(file, entry);
      return entry.value;
    }
    const key = `${file}\0${stamp}`;
    const running = this.pending.get(key);
    if (running) return running;
    const task = Promise.resolve().then(async () => {
      const indexed = this.index?.get(file, stamp);
      if (indexed) return indexed;
      const value = await read();
      if (value) this.index?.put(file, stamp, value);
      return value;
    }).then((value) => {
      const bytes = value ? Object.values(value).reduce<number>((sum, v) =>
        sum + (typeof v === "string" ? Buffer.byteLength(v) : 16), 128) : 64;
      const old = this.entries.get(file);
      if (old) { this.bytes -= old.bytes; this.entries.delete(file); }
      // Large pasted prompts must not create an unbounded second transcript
      // store in RAM. Evict least-recently used metadata by count AND bytes.
      // Readers use null for vanished/transiently unreadable files too. Never
      // cache that absence indefinitely when the next stat is unchanged.
      if (value && bytes <= this.maxBytes) {
        this.entries.set(file, { stamp, value, bytes });
        this.bytes += bytes;
      }
      while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
        const first = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(first)!.bytes;
        this.entries.delete(first);
      }
      return value;
    });
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }
}
