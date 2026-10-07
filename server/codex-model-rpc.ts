// A short-lived metadata-only CLI process. Never starts a thread/turn, exposes
// tools, reads account credentials itself, or opens a public transport.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import { resolveCodexBin } from "./executors/codex-executor.ts";
import { parseCodexModelsCache, type ModelOption } from "../src/lib/settings.ts";

export function readCodexModels(timeoutMs = 8000): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCodexBin(), ["app-server", "--listen", "stdio://"], {
      cwd: os.homedir(), stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false, bytes = 0, requestId = 1, pages = 0;
    const entries: unknown[] = [];
    const cursors = new Set<string>();
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, models?: ModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
      if (error) reject(error); else resolve(models!);
    };
    const send = (value: unknown) => {
      if (!settled && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n");
    };
    const list = (cursor?: string) => send({ id: ++requestId, method: "model/list",
      params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    const timer = setTimeout(() => finish(new Error("Codex model discovery timed out")), timeoutMs);
    child.on("error", () => finish(new Error("Codex model discovery unavailable")));
    child.stdin.on("error", () => finish(new Error("Codex model discovery disconnected")));
    child.on("exit", () => {
      clearTimeout(killTimer);
      if (!settled) finish(new Error("Codex model discovery exited"));
    });
    // Count before readline parses/dispatches the final chunk of a frame.
    child.stdout.prependListener("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) finish(new Error("Codex model response too large"));
    });
    lines.on("line", (line) => {
      if (settled) return;
      let frame: any;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame.id !== requestId) return;
      // Do not expose CLI error bodies or unrelated account notifications.
      if (frame.error || !frame.result) return finish(new Error("Codex model discovery rejected"));
      if (requestId === 1) {
        send({ method: "initialized", params: {} });
        list();
        return;
      }
      if (!Array.isArray(frame.result.data)) return finish(new Error("Invalid Codex model catalog"));
      entries.push(...frame.result.data);
      if (entries.length > 200 || ++pages > 10) return finish(new Error("Codex model catalog limit exceeded"));
      const cursor = frame.result.nextCursor;
      if (typeof cursor === "string" && cursor) {
        if (cursors.has(cursor)) return finish(new Error("Codex model catalog cursor loop"));
        cursors.add(cursor);
        list(cursor);
        return;
      }
      const models = parseCodexModelsCache({ models: entries.map((m: any) => ({
        slug: m?.model ?? m?.id, display_name: m?.displayName, description: m?.description,
        visibility: m?.hidden === true ? "hide" : "list",
        supported_reasoning_levels: Array.isArray(m?.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts.map((e: any) => ({ effort: e?.reasoningEffort })) : [],
        default_reasoning_level: m?.defaultReasoningEffort,
      })) });
      if (!models) return finish(new Error("Empty Codex model catalog"));
      finish(undefined, models);
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "cc-webui", title: "cc-webui", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    } });
  });
}
