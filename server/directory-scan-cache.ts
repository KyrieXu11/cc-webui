// Cache filesystem discovery, never an account's authorised response. Callers
// must apply the current whitelist after reading these raw candidates.
export class DirectoryScanCache {
  private entries = new Map<string, { dirs: string[]; expiresAt: number }>();
  private pending = new Map<string, Promise<string[]>>();

  constructor(
    private scan: (root: string) => Promise<string[]>,
    private ttlMs = 30_000,
    private maxEntries = 32,
    private now = Date.now,
  ) {}

  async get(root: string, refresh = false): Promise<string[]> {
    // Even forced refreshes join an existing walk: retrying must not multiply
    // blocked macOS TCC syscalls or duplicate an expensive scan.
    const running = this.pending.get(root);
    if (running) return running;
    const cached = this.entries.get(root);
    if (!refresh && cached && cached.expiresAt > this.now()) {
      this.entries.delete(root);
      this.entries.set(root, cached);
      return cached.dirs;
    }
    const task = Promise.resolve().then(() => this.scan(root)).then((dirs) => {
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= this.now()) this.entries.delete(key);
      }
      this.entries.delete(root);
      this.entries.set(root, { dirs, expiresAt: this.now() + this.ttlMs });
      while (this.entries.size > this.maxEntries) {
        this.entries.delete(this.entries.keys().next().value!);
      }
      return dirs;
    });
    this.pending.set(root, task);
    try {
      return await task;
    } finally {
      this.pending.delete(root);
    }
  }
}
