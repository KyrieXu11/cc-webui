import { randomUUID } from "node:crypto";
import { runClaude } from "./claude-runner.ts";
import { runCodex } from "./codex-runner.ts";
import { buildPrompt, buildResumeCatchup } from "./input-builder.ts";
import { readConfig } from "./config.ts";
import {
  getAgentSessionId,
  setAgentSessionId,
} from "./runtime.ts";
import type { ChatEvent } from "../../src/lib/types.ts";
import {
  appendEntry,
  readAll,
  upsertIndexRow,
  newEntryId,
  makeEntry,
  type AgentId,
  type GroupTurnEntry,
  type ImageAttachment,
} from "./store.ts";
import type { RunnerEvent, RunnerCtx } from "./runner-types.ts";

// ============================================================
// Group turn state + in-flight registry
// ============================================================

type BufferedSse = { event: string; data: string };

export type GroupSubscriber = {
  write: (event: string, data: string) => void;
  close: () => void;
};

export type InFlightGroupTurn = {
  gid: string;
  turnId: string;
  startedAt: number;
  status: "running" | "done" | "error";
  errorMsg?: string;
  buffered: BufferedSse[];
  subscribers: Set<GroupSubscriber>;
  abort: AbortController;
};

const activeGroupTurns = new Map<string, InFlightGroupTurn>();

export function getInFlightTurn(gid: string): InFlightGroupTurn | undefined {
  return activeGroupTurns.get(gid);
}

export function listInFlightTurns(): InFlightGroupTurn[] {
  return Array.from(activeGroupTurns.values());
}

function fanout(turn: InFlightGroupTurn, event: string, data: string): void {
  turn.buffered.push({ event, data });
  for (const sub of turn.subscribers) {
    try {
      sub.write(event, data);
    } catch {
      /* keep going for other subs */
    }
  }
}

// ============================================================
// Public entry: start a turn
// ============================================================

export type StartTurnInput = {
  gid: string;
  text: string;
  images?: ImageAttachment[];
  recipients?: ("claude" | "codex" | "all")[];
  quote?: { agent: AgentId; text: string };
  // Adapter-supplied MCP servers (e.g. Feishu adapter injects a `lark`
  // MCP bound to the originating chat). Each agent's runner merges these
  // with its own built-in MCP servers and auto-allows their tools.
  // Values must be SDK-wrapped (createSdkMcpServer), not raw McpServer.
  extraMcpServers?: Record<
    string,
    import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance
  >;
};

export type StartTurnResult = {
  turn: InFlightGroupTurn;
};

export async function startTurn(
  input: StartTurnInput,
): Promise<StartTurnResult> {
  const gid = input.gid;
  if (activeGroupTurns.has(gid)) {
    throw new Error("turn_busy");
  }

  const config = await readConfig(gid);
  const requestedRecipients = input.recipients ?? ["all"];
  const expanded: AgentId[] = requestedRecipients.includes("all")
    ? config.pipeline
    : (requestedRecipients as AgentId[]).filter(
        (r): r is AgentId => r === "claude" || r === "codex",
      );
  if (expanded.length === 0) {
    throw new Error("no recipients");
  }

  const turnId = randomUUID();
  const abort = new AbortController();

  const turn: InFlightGroupTurn = {
    gid,
    turnId,
    startedAt: Date.now(),
    status: "running",
    buffered: [],
    subscribers: new Set(),
    abort,
  };
  activeGroupTurns.set(gid, turn);

  // Persist the user turn first so a refresh during runner setup still
  // shows the user message.
  const userMeta: NonNullable<Parameters<typeof makeEntry>[0]> = {
    agent: "user",
    event: {
      id: newEntryId(),
      type: "user",
      text: input.text,
      images:
        input.images && input.images.length > 0 ? input.images : undefined,
    },
    turnId,
    recipients: expanded,
  };
  const userEntry = makeEntry(userMeta);
  if (input.quote) {
    userEntry.meta = { ...(userEntry.meta ?? {}), quote: input.quote };
  }
  await appendEntry(gid, userEntry);

  fanout(
    turn,
    "turn_begin",
    JSON.stringify({
      type: "turn_begin",
      turnId,
      userText: input.text,
      recipients: expanded,
      quote: input.quote,
    }),
  );

  // Detached pipeline runner — independent of the HTTP request that started
  // the turn so that a refresh / disconnect doesn't cancel generation.
  void runPipeline({
    turn,
    config,
    expanded,
    text: input.text,
    images: input.images ?? [],
    extraMcpServers: input.extraMcpServers,
  })
    .catch((err) => {
      console.error(
        `[group ${gid}] pipeline crash:`,
        err instanceof Error ? err.stack ?? err.message : err,
      );
      turn.status = "error";
      turn.errorMsg = err instanceof Error ? err.message : String(err);
      fanout(
        turn,
        "turn_end",
        JSON.stringify({
          type: "turn_end",
          turnId,
          ok: false,
          error: turn.errorMsg,
        }),
      );
    })
    .finally(() => {
      // Tear down subscribers + remove from registry. Subscribers' close()
      // wakes their drain loops so the HTTP responses end cleanly.
      for (const sub of [...turn.subscribers]) {
        try {
          sub.close();
        } catch {
          /* ignore */
        }
      }
      if (activeGroupTurns.get(gid) === turn) {
        activeGroupTurns.delete(gid);
      }
    });

  return { turn };
}

// ============================================================
// Pipeline runner
// ============================================================

async function runPipeline(args: {
  turn: InFlightGroupTurn;
  config: Awaited<ReturnType<typeof readConfig>>;
  expanded: AgentId[];
  text: string;
  images: ImageAttachment[];
  extraMcpServers?: Record<
    string,
    import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance
  >;
}): Promise<void> {
  const { turn, config, expanded, text, images, extraMcpServers } = args;
  let pipelineOk = true;

  for (let step = 0; step < expanded.length; step++) {
    if (turn.abort.signal.aborted) {
      pipelineOk = false;
      break;
    }

    const agentId = expanded[step];
    const participant = config.participants.find((p) => p.id === agentId);
    if (!participant) {
      fanout(
        turn,
        "agent_end",
        JSON.stringify({
          type: "agent_end",
          turnId: turn.turnId,
          agent: agentId,
          ok: false,
          error: "participant not configured",
        }),
      );
      pipelineOk = false;
      break;
    }

    fanout(
      turn,
      "agent_begin",
      JSON.stringify({
        type: "agent_begin",
        turnId: turn.turnId,
        agent: agentId,
        step,
        totalSteps: expanded.length,
      }),
    );

    // Re-read transcript so this agent sees the prior step's output.
    const transcript = await readAll(turn.gid);

    // Look up an existing session id for this agent — if present we
    // resume so the SDK keeps prompt cache warm across turns and we
    // only pay for the catchup diff each turn.
    const resumeSessionId = await getAgentSessionId(turn.gid, agentId);

    const ctx: RunnerCtx = {
      gid: turn.gid,
      turnId: turn.turnId,
      agentId,
      signal: turn.abort.signal,
      resumeSessionId,
      extraMcpServers,
      emitPermission: (payload) => {
        // Fan out as agent_event so the client's applySDKMessage folds it
        // into the live ChatEvent[] (same code path as single chat).
        fanout(
          turn,
          "agent_event",
          JSON.stringify({
            type: "agent_event",
            turnId: turn.turnId,
            agent: agentId,
            payload,
          }),
        );
      },
    };

    let claudePrompt: string;
    let codexPrompt: string;
    if (resumeSessionId) {
      // Existing session: send only what the agent hasn't seen yet.
      claudePrompt = buildResumeCatchup({ transcript, target: agentId });
      codexPrompt = claudePrompt;
    } else {
      // First-time invocation: send the full rendered history (which
      // includes the just-appended user message).
      const fullPrompt = buildPrompt({
        transcript,
        target: agentId,
        currentText: text,
        config,
      });
      claudePrompt = fullPrompt;
      codexPrompt = fullPrompt;
    }

    const runner =
      agentId === "claude"
        ? runClaude({
            config,
            participant,
            prompt: claudePrompt,
            images,
            ctx,
          })
        : runCodex({
            config,
            participant,
            prompt: codexPrompt,
            images,
            ctx,
          });

    let stepOk = true;
    let stepError: string | undefined;
    let stepEvents: ChatEvent[] = [];
    let stepSessionId: string | undefined;

    let rawCount = 0;
    for await (const ev of runner) {
      if (ev.kind === "raw") {
        rawCount++;
        // Wrap in agent_event so the client knows which agent it came from.
        fanout(
          turn,
          "agent_event",
          JSON.stringify({
            type: "agent_event",
            turnId: turn.turnId,
            agent: agentId,
            payload: ev.payload,
          }),
        );
      } else if (ev.kind === "ended") {
        stepOk = ev.ok;
        stepError = ev.error;
        stepEvents = ev.events;
        stepSessionId = ev.sessionId;
      }
    }
    console.log(
      `[orch ${turn.gid}] step=${step} agent=${agentId} ok=${stepOk} rawEvents=${rawCount} stepEvents=${stepEvents.length}${stepError ? ` error=${stepError}` : ""}`,
    );

    // Persist the discovered session id so the next turn can resume
    // (keeps Anthropic prompt cache warm across the conversation).
    if (stepSessionId) {
      try {
        await setAgentSessionId(turn.gid, agentId, stepSessionId);
      } catch (err) {
        console.error(
          `[group ${turn.gid}] failed to persist session id for ${agentId}:`,
          err,
        );
      }
    }

    // Persist every ChatEvent the runner produced (assistant, thinking,
    // step, permission, summary) — that's what gives a refresh after
    // turn_end the same view as the live stream, including tool-call
    // timelines and edit diffs.
    for (const chatEvent of stepEvents) {
      // Skip empty assistant/thinking text — applySDKMessage may emit
      // shells before content arrives if the stream was aborted.
      if (
        (chatEvent.type === "assistant" || chatEvent.type === "thinking") &&
        !chatEvent.text?.trim()
      ) {
        continue;
      }
      await appendEntry(
        turn.gid,
        makeEntry({
          agent: agentId,
          event: chatEvent,
          turnId: turn.turnId,
          pipelineStep: step,
        }),
      );
    }
    if (!stepOk) {
      await appendEntry(
        turn.gid,
        makeEntry({
          agent: agentId,
          event: {
            id: newEntryId(),
            type: "assistant",
            text: `[错误] ${stepError ?? "unknown error"}`,
          },
          turnId: turn.turnId,
          pipelineStep: step,
          error: stepError,
        }),
      );
    }

    fanout(
      turn,
      "agent_end",
      JSON.stringify({
        type: "agent_end",
        turnId: turn.turnId,
        agent: agentId,
        ok: stepOk,
        error: stepError,
      }),
    );

    if (!stepOk) {
      pipelineOk = false;
      break; // spec §5: pipeline aborts on first agent failure
    }
  }

  // Update sidebar / search index
  const final = await readAll(turn.gid);
  const last = final[final.length - 1];
  const lastEv: any = last?.event;
  const lastSnippet =
    typeof lastEv?.text === "string" && lastEv.text
      ? lastEv.text.slice(0, 120)
      : "";
  await upsertIndexRow({
    id: config.id,
    title: config.title,
    cwd: config.cwd,
    lastTs: Date.now(),
    participantSummary: config.participants
      .map((p) => (p.id === "claude" ? "Claude" : "Codex"))
      .join(" · "),
    lastSnippet,
    inFlight: false,
  });

  turn.status = pipelineOk ? "done" : "error";
  fanout(
    turn,
    "turn_end",
    JSON.stringify({
      type: "turn_end",
      turnId: turn.turnId,
      ok: pipelineOk,
    }),
  );
}

// ============================================================
// Public: stop in-flight turn
// ============================================================

export function stopTurn(gid: string): boolean {
  const turn = activeGroupTurns.get(gid);
  if (!turn) return false;
  turn.abort.abort();
  return true;
}

// ============================================================
// Public: subscribe to an in-flight turn (replay buffer + follow live)
// ============================================================

export function subscribeInFlight(
  gid: string,
  sub: GroupSubscriber,
): { detach: () => void } | null {
  const turn = activeGroupTurns.get(gid);
  if (!turn) return null;
  // Replay buffered events first so the new subscriber catches up.
  for (const m of turn.buffered) {
    sub.write(m.event, m.data);
  }
  turn.subscribers.add(sub);
  return {
    detach: () => {
      turn.subscribers.delete(sub);
    },
  };
}
