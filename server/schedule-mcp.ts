import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MAX_DELAY_S, MIN_DELAY_S, type WakeupSlot } from "./wakeup.ts";

interface Options {
  slot: WakeupSlot;
}

// Mirrors Claude Code's ScheduleWakeup: model schedules a future "continue"
// before ending the current turn, so it can come back without a human typing
// "continue" in the UI. Designed for the case where the model started a
// long-running mcp__bash__run (run_in_background=true) task and wants to poll
// on its completion.
export function createScheduleMcpServer(
  opts: Options
): McpSdkServerConfigWithInstance {
  const wakeupTool = tool(
    "wakeup",
    "Schedule the conversation to automatically resume after a delay. " +
      "When the current turn ends, the runtime sleeps for delaySeconds, then injects " +
      "`prompt` as a synthetic user message that resumes this same session — there " +
      "is no human in the loop, so the prompt must be self-contained and actionable. " +
      "Use this when you started a long-running background command via " +
      "mcp__bash__run (run_in_background=true) and want to come back later to check " +
      "on it without the user having to manually type 'continue'. Only one wakeup can " +
      "be pending per turn — calling again overwrites the previous request. Cancel " +
      "with mcp__schedule__cancel_wakeup if no longer needed.",
    {
      delaySeconds: z
        .number()
        .describe(
          `Delay in seconds before resuming. Clamped to [${MIN_DELAY_S}, ${MAX_DELAY_S}]. ` +
            "Pick based on how long the background task realistically takes — do not " +
            "default to short polling loops."
        ),
      prompt: z
        .string()
        .min(1)
        .describe(
          "Self-contained prompt injected as a user message when the wakeup fires. " +
            "Be specific: e.g. 'Poll mcp__bash__output for bash_id=bg-abc12345 and " +
            "report the results, then continue the analysis.'"
        ),
      reason: z
        .string()
        .optional()
        .describe(
          "Short rationale for the scheduling decision (shown in logs/UI). One sentence."
        ),
    },
    async (args) => {
      const w = opts.slot.set({
        delaySeconds: args.delaySeconds,
        prompt: args.prompt,
        reason: args.reason ?? null,
      });
      const fireAt = new Date(w.scheduledAt + w.delaySeconds * 1000);
      const hh = fireAt.getHours().toString().padStart(2, "0");
      const mm = fireAt.getMinutes().toString().padStart(2, "0");
      const ss = fireAt.getSeconds().toString().padStart(2, "0");
      return {
        content: [
          {
            type: "text",
            text: `Next wakeup scheduled for ${hh}:${mm}:${ss} (in ${w.delaySeconds}s, id=${w.id}).`,
          },
        ],
        isError: false,
      };
    }
  );

  const cancelTool = tool(
    "cancel_wakeup",
    "Cancel the wakeup scheduled by mcp__schedule__wakeup in the current turn, if any. " +
      "Has no effect on wakeups already fired.",
    {},
    async () => {
      const w = opts.slot.clear();
      return {
        content: [
          {
            type: "text",
            text: w
              ? `Cancelled pending wakeup (id=${w.id}, was set for ${w.delaySeconds}s).`
              : "No pending wakeup to cancel.",
          },
        ],
        isError: false,
      };
    }
  );

  return createSdkMcpServer({
    name: "schedule",
    version: "0.1.0",
    tools: [wakeupTool, cancelTool],
  });
}
