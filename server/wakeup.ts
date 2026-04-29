import { randomUUID } from "node:crypto";

// Range mirrors Claude Code's ScheduleWakeup tool: too-short delays churn the
// prompt cache for nothing, too-long delays should be a cron job instead.
export const MIN_DELAY_S = 60;
export const MAX_DELAY_S = 3600;

export interface WakeupRequest {
  id: string;
  delaySeconds: number;
  prompt: string;
  reason: string | null;
  scheduledAt: number;
}

export function clampDelay(s: number): number {
  if (!Number.isFinite(s)) return MIN_DELAY_S;
  if (s < MIN_DELAY_S) return MIN_DELAY_S;
  if (s > MAX_DELAY_S) return MAX_DELAY_S;
  return Math.round(s);
}

// Per-turn slot. The schedule MCP tool writes into it; chat.ts reads it after
// the SDK iterator finishes to decide whether to schedule a follow-up turn.
// One pending request per turn — re-calling overwrites; cancel clears.
export interface WakeupSlot {
  set(req: {
    delaySeconds: number;
    prompt: string;
    reason?: string | null;
  }): WakeupRequest;
  clear(): WakeupRequest | null;
  get(): WakeupRequest | null;
}

export function createWakeupSlot(): WakeupSlot {
  let current: WakeupRequest | null = null;
  return {
    set(req) {
      const w: WakeupRequest = {
        id: "wk-" + randomUUID().slice(0, 8),
        delaySeconds: clampDelay(req.delaySeconds),
        prompt: req.prompt,
        reason: req.reason ?? null,
        scheduledAt: Date.now(),
      };
      current = w;
      return w;
    },
    clear() {
      const w = current;
      current = null;
      return w;
    },
    get() {
      return current;
    },
  };
}
