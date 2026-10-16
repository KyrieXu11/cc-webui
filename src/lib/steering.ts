// Serialize additions; prevent double clicks and late replies from a previous
// conversation from changing the new conversation's queue.
export class SteerCoordinator {
  private epoch = 0;
  private pending = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  reset(): void { this.epoch++; this.pending.clear(); this.tail = Promise.resolve(); }
  has(id: string): boolean { return this.pending.has(id); }
  submit<T>(id: string, send: () => Promise<T>): Promise<{ stale: boolean; value?: T }> | null {
    if (this.pending.has(id)) return null;
    this.pending.add(id);
    const epoch = this.epoch;
    const task = this.tail.catch(() => {}).then(async () => {
      if (epoch !== this.epoch) return { stale: true };
      try {
        const value = await send();
        return { stale: epoch !== this.epoch, value };
      } catch (error) {
        if (epoch !== this.epoch) return { stale: true };
        throw error;
      }
    }).finally(() => { if (epoch === this.epoch) this.pending.delete(id); });
    this.tail = task;
    return task;
  }
}
