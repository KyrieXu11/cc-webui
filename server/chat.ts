import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { awaitPermission } from "./permission.ts";
import { currentUser, isAdmin } from "./auth/middleware.ts";
import { visibilityFor } from "./auth/scope.ts";
import { recordOwner, relabelOwner } from "./auth/ownership.ts";
import { relabelTasksSessionId } from "./bash-mcp.ts";
// ⚠️ 只剩 relabel：**每个 turn 收尾扫一遍 cwd 的那次登记已经撤掉**（2026-08-27）。
// 「本对话文件」列表从 UI 上撤了（用户：「我要的只是项目文件」），而那次扫描是按目录
// 规模计费的（实测 0.2ms / 307ms / 3.05s），没有消费者就是纯开销。
// relabel 留着：CLI 会在首个 turn 换掉 session id，registry 里已有的历史行还得跟着走，
// 不然它们会变成查不出来的孤儿。表和 GET /api/files 都还在，只是不再有写入方。
import { relabelSessionFiles } from "./session-files.ts";
import { claudeExecutor } from "./executors/claude-executor.ts";
import type { ExecResult } from "./executors/types.ts";
import { getMcpRouteUrl, localMcpRouteUrl } from "./codex-mcp-config.ts";
import { availableServers } from "./devices/registry.ts";
import {
  CLI_MCP_TOOL_TIMEOUT_MS,
  LOCAL_PREFIX,
  localToolServerPrefix,
} from "./devices/protocol.ts";
import {
  registerMcpSessionContext,
  unregisterMcpSessionContext,
  updateMcpSession,
} from "./mcp-context.ts";
import {
  createWakeupSlot,
  type WakeupRequest,
  type WakeupSlot,
} from "./wakeup.ts";
import {
  getOrCreateAllowance,
  getOrCreateInputAllowance,
  permissionInputKey,
  relabelScope,
  sessionPermissionSuggestions,
} from "./shared/permission-flow.ts";

const MCP_BASH_RUN = "mcp__bash__run";
const MCP_BASH_OUTPUT = "mcp__bash__output";
const MCP_BASH_KILL = "mcp__bash__kill";
const MCP_BASH_LIST = "mcp__bash__list";
const MCP_SCHEDULE_WAKEUP = "mcp__schedule__wakeup";
const MCP_SCHEDULE_CANCEL_WAKEUP = "mcp__schedule__cancel_wakeup";
const SYSTEM_PROMPT_APPEND =
  "SHELL TOOLS: The built-in Bash/BashOutput/KillBash tools are DISABLED. " +
  `Use ${MCP_BASH_RUN} (same schema: command, timeout, description, plus run_in_background). ` +
  `For background tasks, list with ${MCP_BASH_LIST}, poll with ${MCP_BASH_OUTPUT} (bash_id), and terminate with ${MCP_BASH_KILL} (bash_id). ` +
  "Do not try to invoke the built-in Bash — it will be rejected.\n" +
  "WAKEUP / SELF-RESUMING: The built-in ScheduleWakeup tool is NOT available in this runtime. " +
  `Use ${MCP_SCHEDULE_WAKEUP} (delaySeconds 60..3600, prompt, optional reason) before ending your turn ` +
  "if you want the conversation to auto-resume — typically after starting a long-running " +
  `${MCP_BASH_RUN} (run_in_background=true) task. The injected prompt must be self-contained ` +
  `(no human in the loop). Cancel with ${MCP_SCHEDULE_CANCEL_WAKEUP} if you change your mind.`;

/**
 * 本机工具那一段系统提示（docs/desktop-client.md 决策 9）。
 *
 * ⚠️ **模型必须知道自己有没有这只手。** 工具集在 CLI spawn 的那一刻就冻结了
 * （--mcp-config 是启动参数），设备中途上线也要等下个 turn。如果不说，模型对
 * 「用户的电脑」这件事只能靠猜：有设备时它不知道可以用，没设备时它会去编一个
 * 不存在的工具名然后失败。
 *
 * ⚠️ 两只手的边界要说死。默认的 Read/Edit/Glob/Grep/mcp__bash__run **全都在
 * 服务器上**，`mcp__local-*` 才在用户自己的电脑上，两边是**不同的文件系统**。
 * 不点破的话，模型会把本地浏览器下载的文件路径直接喂给服务端的 Read。
 */
function localToolsPrompt(servers: string[]): string {
  if (servers.length === 0) {
    return (
      "\nUSER'S OWN COMPUTER: not reachable this turn — no desktop client is connected " +
      "(or the user paused local tools from the tray). Every tool you have runs on the " +
      "SERVER, not on the user's machine. If the task genuinely requires their computer " +
      "(a browser session they are logged into, a file only on their disk), say so instead " +
      "of pretending; a client that connects later only takes effect on the NEXT turn."
    );
  }
  const names = servers.map((s) => `mcp__${LOCAL_PREFIX}${s}__*`).join(", ");
  return (
    "\nUSER'S OWN COMPUTER: you have a second set of hands. " +
    `The tools named ${names} execute on the USER'S OWN MACHINE via their desktop client; ` +
    "every other tool — Read/Write/Edit/Glob/Grep and mcp__bash__run — executes on the " +
    "SERVER. These are TWO DIFFERENT FILESYSTEMS: a path you see on one does not exist on " +
    "the other, so never hand a local path to a server tool or vice versa. To move a file " +
    "between them, use the transfer tools rather than copying content by hand. " +
    "Anything needing the user's own browser session, their installed apps, or their local " +
    "files must go through the local tools."
  );
}


const chat = new Hono();
const KEEPALIVE_MS = 15_000;

function streamSSEUnbuffered(
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>
): Response {
  const res = streamSSE(c, cb);
  res.headers.set("Cache-Control", "no-cache, no-transform");
  res.headers.set("X-Accel-Buffering", "no");
  return res;
}

function expandHome(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

type PermissionMode =
  | "default"
  | "auto"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

const ALLOWED_MODES: PermissionMode[] = [
  "default",
  "auto",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
const ALLOWED_EFFORTS: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];


// ============================================================
// In-flight chat registry
// ============================================================
//
// Each active SDK turn is represented by an InFlightChat. The turn runs as a
// detached async task — independent of the HTTP request that started it — so
// that a browser refresh / tab close / session switch doesn't cancel the
// generation. All SDK-produced messages are buffered in `messages` and fanned
// out to every Subscriber. A late-joining client (via GET /chat/attach)
// replays the buffer and then follows live until the turn ends.

type BufferedMsg = { event: string; data: string };

interface Subscriber {
  write: (event: string, data: string) => void;
  close: () => void;
}

interface InFlightChat {
  reqId: string;
  clientTurnId: string | undefined;
  messages: BufferedMsg[];
  subscribers: Set<Subscriber>;
  status: "running" | "done" | "error";
  errorMsg?: string;
  sessionId: string | undefined;
  cancelRequested: boolean;
  source: "user" | "wakeup";
  // Calls response.return() on the SDK iterator to force the for-await in
  // the detached task to exit early. Set after `query()` returns.
  cancelIterator?: () => Promise<void>;
  // 中途插话的句柄：executor 在 CLI 起来、stdin 可写之后塞进来，这一轮不再接受
  // 输入时置回 null（见 ExecOptions.onSteer）。POST /chat/steer 是唯一的消费者。
  steer?: ((text: string) => boolean) | null;
}

function permissionBehavior(
  decision: Awaited<ReturnType<typeof awaitPermission>>
): string {
  return decision.behavior;
}

const activeChats = new Map<string, InFlightChat>();
const activeChatsByClientTurn = new Map<string, InFlightChat>();

// 从 (sessionId, clientTurnId) 找那条在途 turn。attach 和 cancel 共用。
//
// ⚠️⚠️ **这两个 key 完全可能指向不同的 turn**：clientTurnId 存在浏览器的
// localStorage 里，而那儿**全局只有一条**，很容易是别的会话留下的。写成
// `bySession(a) ?? byTurn(b)` 或者反过来，在两者不一致时就会静默串台——
// 「A 的 turn id + B 的会话 id」接出来是 A 的流（attach）或者掐掉 A（cancel）。
// 所以：调用方给了 sessionId 就必须对得上，对不上宁可当没找到。
//
// 没给 sessionId 是合法的，那正是全新会话头几秒的形状（CLI 还没吐 session_id，
// clientTurnId 是唯一的把手）——clientTurnId 这条路径就是为它存在的。
export function pickInFlight<T extends { sessionId: string | undefined }>(
  args: { sessionId?: string; clientTurnId?: string },
  bySession: (k: string) => T | undefined,
  byTurn: (k: string) => T | undefined
): T | undefined {
  const { sessionId, clientTurnId } = args;
  if (sessionId) {
    const direct = bySession(sessionId);
    if (direct) return direct;
  }
  if (!clientTurnId) return undefined;
  const entry = byTurn(clientTurnId);
  if (!entry) return undefined;
  if (!sessionId) return entry;
  return entry.sessionId === sessionId ? entry : undefined;
}

function removeEntryIfSelf(entry: InFlightChat): void {
  if (entry.sessionId && activeChats.get(entry.sessionId) === entry) {
    activeChats.delete(entry.sessionId);
  }
  if (
    entry.clientTurnId &&
    activeChatsByClientTurn.get(entry.clientTurnId) === entry
  ) {
    activeChatsByClientTurn.delete(entry.clientTurnId);
  }
}

// ============================================================
// Wakeup scheduling (Claude-Code-ScheduleWakeup-style auto-resume)
// ============================================================
//
// When the model calls `mcp__schedule__wakeup` mid-turn, the schedule MCP
// stashes the request into the current turn's WakeupSlot. After the SDK
// iterator finishes (entry.status === "done"), we read the slot and arm a
// setTimeout that, when it fires, kicks off a fresh turn via runChatTurn()
// using `resume: sessionId` and the model-supplied prompt. UI / pulse
// handling falls out automatically because the new entry registers itself
// in activeChats just like any user-driven turn.

interface PendingWakeup {
  sessionId: string;
  request: WakeupRequest;
  timeout: NodeJS.Timeout;
  // Inherited from the parent turn so the wakeup-driven turn runs against
  // the same cwd / model / permissionMode / effort.
  parentOpts: TurnOptions;
}

const wakeupTimers = new Map<string, PendingWakeup>();

function cancelPendingWakeup(sid: string | undefined): WakeupRequest | null {
  if (!sid) return null;
  const t = wakeupTimers.get(sid);
  if (!t) return null;
  clearTimeout(t.timeout);
  wakeupTimers.delete(sid);
  console.log(
    `[wakeup ${t.request.id}] cancelled for session ${sid} (${t.request.delaySeconds}s pending)`
  );
  return t.request;
}

function scheduleWakeup(
  sid: string,
  request: WakeupRequest,
  parentOpts: TurnOptions
): void {
  cancelPendingWakeup(sid);
  const timeout = setTimeout(() => {
    wakeupTimers.delete(sid);
    if (activeChats.has(sid)) {
      console.log(
        `[wakeup ${request.id}] session ${sid} already busy, skipping`
      );
      return;
    }
    console.log(
      `[wakeup ${request.id}] firing for session ${sid} after ${request.delaySeconds}s`
    );
    try {
      runChatTurn({
        ...parentOpts,
        sessionId: sid,
        clientTurnId: undefined,
        prompt: request.prompt,
        images: [],
        source: "wakeup",
        wakeupReason: request.reason,
      });
    } catch (err) {
      console.error(`[wakeup ${request.id}] failed to start turn:`, err);
    }
  }, request.delaySeconds * 1000);
  wakeupTimers.set(sid, { sessionId: sid, request, timeout, parentOpts });
  console.log(
    `[wakeup ${request.id}] scheduled for session ${sid} in ${request.delaySeconds}s`
  );
}

// Attach a stream to an entry as a subscriber. Replays the current buffer
// snapshot, then drains live messages until the entry terminates or the
// stream disconnects. Returns a promise that resolves when the subscriber
// has fully drained.
async function attachStreamToEntry(
  stream: SSEStreamingApi,
  entry: InFlightChat
): Promise<void> {
  const subId = Math.random().toString(36).slice(2, 7);
  const tag = `[sub ${entry.reqId}/${subId}]`;
  let writeCount = 0;
  const queue: BufferedMsg[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const doWake = () => {
    if (wake) {
      const r = wake;
      wake = null;
      r();
    }
  };

  // Take a snapshot of already-buffered messages for replay. Subscriber is
  // registered in the same synchronous block — since JS can't interleave, no
  // fanout can happen between the two, so no dedup / skip logic is needed:
  // every message is either in `snapshot` (replayed) or arrives via
  // sub.write afterwards (queued). Never both, never lost.
  const snapshot = entry.messages.slice();

  const sub: Subscriber = {
    write: (event, data) => {
      if (closed) return;
      queue.push({ event, data });
      doWake();
    },
    close: () => {
      closed = true;
      doWake();
    },
  };
  entry.subscribers.add(sub);
  const keepAlive = setInterval(() => {
    sub.write("ping", "");
  }, KEEPALIVE_MS);
  console.log(
    `${tag} attached, snapshot=${snapshot.length}, status=${entry.status}`
  );
  stream.onAbort(() => {
    closed = true;
    doWake();
    console.log(`${tag} onAbort, wrote=${writeCount}`);
  });

  try {
    try {
      await stream.writeSSE({ event: "ping", data: "" });
      writeCount++;
    } catch (e) {
      console.log(`${tag} initial ping threw:`, (e as any)?.message);
      closed = true;
    }
    // Replay existing buffer (includes done/error if entry has terminated).
    for (const m of snapshot) {
      if (closed) break;
      try {
        await stream.writeSSE(m);
        writeCount++;
      } catch (e) {
        console.log(`${tag} replay write threw after ${writeCount}:`, (e as any)?.message);
        closed = true;
        break;
      }
    }
    // Drain live queue until closed. Keep draining even after close as long
    // as there are queued items (done/error usually arrives right before
    // close and we want the client to see it).
    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        if (closed) break;
        await new Promise<void>((r) => {
          wake = r;
        });
        continue;
      }
      const item = queue.shift()!;
      try {
        await stream.writeSSE(item);
        writeCount++;
      } catch (e) {
        console.log(`${tag} live write threw after ${writeCount}:`, (e as any)?.message);
        closed = true;
        break;
      }
    }
  } finally {
    clearInterval(keepAlive);
    entry.subscribers.delete(sub);
    console.log(`${tag} detached, total wrote=${writeCount}`);
  }
}

// ============================================================
// runChatTurn — start a turn, return its InFlightChat entry
// ============================================================
//
// Used by both POST /chat (user-initiated) and the wakeup scheduler
// (auto-resume after a setTimeout fires). The detached SDK loop runs
// independently of any HTTP request.

interface NormalizedImage {
  name?: string;
  mediaType: string;
  data: string;
}

interface TurnOptions {
  sessionId: string | undefined;
  clientTurnId: string | undefined;
  prompt: string;
  images: NormalizedImage[];
  cwd: string | undefined;
  model: string | undefined;
  permissionMode: PermissionMode | undefined;
  effort: EffortLevel | undefined;
  source: "user" | "wakeup";
  wakeupReason?: string | null;
  // Who this turn belongs to. Recorded against whatever session id the CLI
  // hands back, so the caller can find their own conversation afterwards —
  // without it every session is unowned and therefore invisible to its
  // creator (admins would not notice: they bypass the check).
  ownerId?: string;
}

function runChatTurn(opts: TurnOptions): InFlightChat {
  const reqId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  console.log(
    `[chat ${reqId}] start source=${opts.source} resume=${opts.sessionId ?? "-"} cwd=${opts.cwd ?? "-"}` +
      ` model=${opts.model ?? "default"} mode=${opts.permissionMode ?? "default"}` +
      ` images=${opts.images.length} prompt=${JSON.stringify(opts.prompt.slice(0, 80))}`
  );

  const entry: InFlightChat = {
    reqId,
    clientTurnId: opts.clientTurnId,
    messages: [],
    subscribers: new Set(),
    status: "running",
    sessionId: opts.sessionId,
    cancelRequested: false,
    source: opts.source,
  };
  if (opts.sessionId) activeChats.set(opts.sessionId, entry);
  if (opts.clientTurnId) activeChatsByClientTurn.set(opts.clientTurnId, entry);

  let currentSessionId = opts.sessionId;
  const allowance = getOrCreateAllowance(currentSessionId);
  const inputAllowance = getOrCreateInputAllowance(currentSessionId);
  const wakeupSlot: WakeupSlot = createWakeupSlot();

  // Broadcast: append to buffer + push to every subscriber synchronously.
  const fanout = (event: string, data: string) => {
    const item: BufferedMsg = { event, data };
    entry.messages.push(item);
    for (const sub of entry.subscribers) sub.write(event, data);
  };

  // 这一轮**实际**用的 effort，给思考状态行那句「· xhigh effort」用。
  //
  // ⚠️ 前端不能读自己输入框里的设置来显示它：看别人正在跑的一轮时，那是**看的人**
  // 的设置，不是这一轮的（用户 2026-09-23：「她是 xhigh，我显示 max」）。CLI 自己的
  // system/init 帧里只有 model 没有 effort，所以只能由这里补一帧。
  // 放在 buffer 的**第一条**：发起者的 POST 流和之后任何 attach 的重放都先拿到它。
  // null = 请求没带 effort（CLI 用它自己的默认），前端就不显示这一截。
  fanout(
    "turn_meta",
    JSON.stringify({ type: "turn_meta", effort: opts.effort ?? null })
  );

  if (opts.source === "wakeup") {
    fanout(
      "wakeup_turn_started",
      JSON.stringify({
        type: "wakeup_turn_started",
        reqId,
        prompt: opts.prompt,
        reason: opts.wakeupReason ?? null,
        sessionId: opts.sessionId,
      })
    );
  }

  // Detached CLI run — lives past the HTTP request's lifetime.
  let mcpTokenToRelease: string | undefined;
  (async () => {
    try {
      // MCP over HTTP. The SDK's in-process ("sdk") MCP transport goes away
      // with the SDK, so bash + schedule move onto the HTTP routes that Codex
      // and Feishu already use. Those routes run in THIS process, so the only
      // real change is a loopback hop: the bash task registry that
      // /api/bash/tasks streams, and the wakeup slot the timer reads, are still
      // the very same objects. A per-turn bearer token carries this turn's
      // context (cwd, live session id, SSE fanout, wakeup slot).
      const mcpToken = randomUUID();
      mcpTokenToRelease = mcpToken;
      registerMcpSessionContext({
        token: mcpToken,
        sessionId: currentSessionId ?? "",
        ownerId: opts.ownerId,
        cwd: opts.cwd,
        onForegroundEvent: fanout,
        wakeupSlot,
      });

      // 起 turn 前探测这个账号有没有在线设备（docs/desktop-client.md 决策 9）。
      //
      // ⚠️ 探测必须在这里做一次并**定死**：CLI 的工具集在 spawn 时就冻结了
      // （--mcp-config 是启动参数），turn 中途设备上线也不会生效。所以这一行拿到
      // 什么，这个 turn 就是什么 —— 包括要照实告诉模型（见 localToolsPrompt）。
      //
      // ⚠️ ownerId 是 optional（TurnOptions.ownerId?: string）。拿不到账号必须
      // 当成「没有设备」，绝不能当成「任意设备」—— fail-closed 是全仓纪律。
      const localServers = opts.ownerId
        ? availableServers(opts.ownerId)
        : [];
      if (localServers.length > 0) {
        console.log(
          `[chat ${reqId}] local tools: ${localServers.join(", ")} (device online)`,
        );
      }

      // The CLI takes a real AbortSignal, so cancelling is no longer the
      // iterator-.return() workaround the SDK forced.
      const abort = new AbortController();
      entry.cancelIterator = async () => {
        abort.abort();
      };

      const frames = claudeExecutor.exec({
        // 插话句柄。**只存不调**——写进去的那一下由 POST /chat/steer 触发。
        onSteer: (send) => {
          entry.steer = send;
        },
        prompt: opts.prompt,
        images: opts.images,
        cwd: opts.cwd ?? process.cwd(),
        signal: abort.signal,
        model: opts.model,
        effort: opts.effort,
        mode: opts.permissionMode,
        resume: opts.sessionId,
        // ScheduleWakeup: the CLI ships a built-in wakeup tool, but its
        // timers live inside the CLI process and die with the turn. Keep
        // it disabled so the model only uses mcp__schedule__wakeup, whose
        // timers the server owns (survive across turns, cancellable).
        disallowedTools: ["Bash", "BashOutput", "KillBash", "ScheduleWakeup"],
        appendSystemPrompt: SYSTEM_PROMPT_APPEND + localToolsPrompt(localServers),
        // 只在真有本地工具时才抬高超时（见 CLI_MCP_TOOL_TIMEOUT_MS 的注释）。
        // 无条件抬高会让服务端那些本该快速失败的 MCP 调用也拖到 5 分钟。
        extraEnv:
          localServers.length > 0
            ? { MCP_TOOL_TIMEOUT: String(CLI_MCP_TOOL_TIMEOUT_MS) }
            : undefined,
        mcpServers: [
          {
            name: "bash",
            url: getMcpRouteUrl(process.env, "bash"),
            bearerToken: mcpToken,
          },
          {
            name: "schedule",
            url: getMcpRouteUrl(process.env, "schedule"),
            bearerToken: mcpToken,
          },
          // 家人机器上的那几只手（docs/desktop-client.md）。
          //
          // ⚠️⚠️ **决策 19（群聊 / 飞书不得使用本地工具）就是靠「只有这一处装配」
          // 实现的，不能靠检查 ownerId。** 飞书 turn 的 ownerId 会被
          // auth/actor.ts 的 actorForResource 解析成一个**真实存在的管理员账号
          // id**，而那个管理员很可能正好有在线设备 —— 任何「按 ownerId 查设备」
          // 的黑名单都会漏过去，等于飞书群里任何人 @ 一下 bot 就能碰到家人的
          // 电脑（飞书至今没有 sender 白名单，见 AGENTS.md）。
          // 所以 groups/claude-runner.ts、groups/codex-runner.ts、codex-chat.ts
          // 一律**不要**加这一段。要开，先给飞书补 sender 白名单。
          ...localServers.map((name) => ({
            name: `${LOCAL_PREFIX}${name}`,
            url: localMcpRouteUrl(process.env, name),
            bearerToken: mcpToken,
          })),
        ],
        // Same decision logic as the SDK-era canUseTool — only the parameter
        // shape changed, so permission cards behave identically.
        onPermissionAsk: async ({
          toolName,
          input,
          suggestions,
          displayName,
          description,
          title,
          toolUseId,
          signal,
        }) => {
            if (
              toolName === MCP_BASH_OUTPUT ||
              toolName === MCP_BASH_KILL ||
              toolName === MCP_BASH_LIST ||
              toolName === MCP_SCHEDULE_WAKEUP ||
              toolName === MCP_SCHEDULE_CANCEL_WAKEUP
            ) {
              return { behavior: "allow", updatedInput: input };
            }
            // AskUserQuestion 永远不走「已放行」短路：放行它等于替用户回答，
            // 而没有答案的放行只会让 CLI 回 "The user did not answer the
            // questions."——一次误点会把之后所有提问都变成哑火。
            const isAsk = toolName === "AskUserQuestion";
            const localPrefix = localToolServerPrefix(toolName);
            if (
              !isAsk &&
              (allowance.has(toolName) ||
                (localPrefix !== null && allowance.has(localPrefix)))
            ) {
              return { behavior: "allow", updatedInput: input };
            }
            const inputKey = permissionInputKey(toolName, input);
            if (!isAsk && inputAllowance.has(inputKey)) {
              return { behavior: "allow", updatedInput: input };
            }
            const permissionSuggestions = sessionPermissionSuggestions(
              suggestions
            );
            const id = randomUUID();
            const displayTool =
              toolName === MCP_BASH_RUN ? "Bash" : toolName;
            // Fan out the permission prompt so any subscriber (initiator or
            // reconnect attach) can surface the card and answer it.
            fanout(
              "permission_request",
              JSON.stringify({
                type: "permission_request",
                id,
                tool: displayTool,
                input,
                title: title,
                displayName: displayName,
                description: description,
                hasSessionPermissionSuggestions:
                  permissionSuggestions.length > 0,
                // Carry the SDK's toolUseID so the client can match the card
                // to the corresponding step (`s-<toolUseID>`) and know when
                // the step is actually executing vs waiting on approval.
                toolUseId: toolUseId,
              })
            );
            let decision: Awaited<ReturnType<typeof awaitPermission>>;
            try {
              decision = await awaitPermission(id, signal, { ownerId: opts.ownerId });
            } catch (err) {
              fanout(
                "permission_resolved",
                JSON.stringify({
                  type: "permission_resolved",
                  id,
                  stale: true,
                })
              );
              throw err;
            }
            fanout(
              "permission_resolved",
              JSON.stringify({
                type: "permission_resolved",
                id,
                behavior: permissionBehavior(decision),
              })
            );
            if (decision.behavior === "allow") {
              return {
                behavior: "allow",
                updatedInput: decision.answers
                  ? { ...input, answers: decision.answers }
                  : input,
              };
            }
            if (decision.behavior === "allow_session") {
              inputAllowance.add(inputKey);
              if (permissionSuggestions.length === 0) {
                return { behavior: "allow", updatedInput: input };
              }
              return {
                behavior: "allow",
                updatedInput: input,
                updatedPermissions: permissionSuggestions,
              };
            }
            if (decision.behavior === "allow_tool_session") {
              // 本地工具按 server 放行（见 localToolServerPrefix 的注释）；
              // 其余一切照旧按工具名。
              allowance.add(localPrefix ?? toolName);
              return { behavior: "allow", updatedInput: input };
            }
            return decision;
        },
      });

      let ended: ExecResult | null = null;
      let msgCount = 0;
      let currentStreamMessageId: string | undefined;
      for await (const frame of frames) {
        if (frame.kind === "ended") {
          ended = frame.result;
          break;
        }
        if (entry.cancelRequested) break;
        // `payload` is the CLI's own stream-json frame — byte-for-byte what the
        // SDK used to yield, which is why everything below is unchanged.
        const msg = frame.payload;
        msgCount++;
        const tag =
          (msg as any).type +
          ((msg as any).subtype ? `:${(msg as any).subtype}` : "");
        if (msgCount <= 20 || msgCount % 50 === 0) {
          console.log(`[chat ${reqId}] msg #${msgCount} ${tag} @${elapsed()}`);
        }
        // Diagnostic: dump status messages and any tool_use content blocks so
        // we can see why the model isn't actually invoking mcp__bash__run.
        const m = msg as any;
        if (m.type === "system" && m.subtype === "status") {
          console.log(
            `[chat ${reqId}] status payload: ${JSON.stringify(m).slice(0, 500)}`
          );
        }
        if (
          m.type === "stream_event" &&
          m.event?.type === "content_block_start"
        ) {
          const cb = m.event.content_block;
          if (cb?.type === "tool_use") {
            console.log(
              `[chat ${reqId}] tool_use: ${cb.name} input=${JSON.stringify(cb.input ?? {}).slice(0, 200)}`
            );
          }
        }

        let outboundMsg = msg as any;
        if (outboundMsg.type === "stream_event" && outboundMsg.event) {
          const ev = outboundMsg.event;
          if (ev.type === "message_start") {
            currentStreamMessageId =
              ev.message?.id ?? outboundMsg.uuid ?? currentStreamMessageId;
          }
          if (currentStreamMessageId) {
            outboundMsg = {
              ...outboundMsg,
              stream_message_id: currentStreamMessageId,
            };
          }
        }

        // Migrate session identity the moment SDK emits a real session_id.
        // Re-key tool allowances, task sessionIds, and activeChats together.
        const emittedId = m.session_id as string | undefined;
        if (emittedId && emittedId !== currentSessionId) {
          const previousId = currentSessionId;
          relabelScope(previousId, emittedId, allowance, inputAllowance);
          relabelTasksSessionId(previousId, emittedId);
          // 「本对话文件」registry 必须跟着改名，否则首个 turn 的文件永远挂在
          // 这个即将作废的 id 下面（docs/file-manager.md）。
          relabelSessionFiles(previousId ?? "", emittedId);
          if (previousId && activeChats.get(previousId) === entry) {
            activeChats.delete(previousId);
          }
          activeChats.set(emittedId, entry);
          entry.sessionId = emittedId;
          currentSessionId = emittedId;
          if (opts.ownerId) {
            // The CLI issues its own id on the first turn, so ownership is
            // recorded here rather than up front, and the previous id (if any)
            // is carried over.
            recordOwner(emittedId, "claude", opts.ownerId);
            relabelOwner(previousId ?? "", emittedId);
          }
          // The HTTP bash tool reads the session id off the token context, so
          // it has to follow the rename too or background tasks get filed
          // under the old id.
          updateMcpSession(mcpToken, emittedId);
        }

        fanout(outboundMsg.type, JSON.stringify(outboundMsg));
        if (
          outboundMsg.type === "stream_event" &&
          outboundMsg.event?.type === "message_stop"
        ) {
          currentStreamMessageId = undefined;
        }
      }

      console.log(
        `[chat ${reqId}] ${entry.cancelRequested ? "cancelled" : (ended?.status ?? "done")}` +
          ` msgs=${msgCount} in ${elapsed()}` +
          (ended?.error ? ` error=${JSON.stringify(ended.error)}` : "")
      );
      // A user cancel is not an error. `aborted` exists precisely because a
      // killed child also exits non-zero, which an exit code alone cannot tell
      // apart from a genuine failure.
      if (ended && ended.status !== "completed" && ended.status !== "aborted") {
        throw new Error(ended.error ?? `run ${ended.status}`);
      }
      entry.status = "done";

      // Surface pending wakeup BEFORE the terminal `done` event so the UI can
      // pin a countdown badge as soon as the turn ends. We still defer the
      // actual setTimeout-arm until after the entry is cleaned up so that
      // activeChats.has(sid) is a meaningful "is this session still busy"
      // check when the timer fires.
      const pendingWakeup =
        !entry.cancelRequested && entry.sessionId
          ? wakeupSlot.get()
          : null;
      if (pendingWakeup) {
        fanout(
          "wakeup_pending",
          JSON.stringify({
            type: "wakeup_pending",
            id: pendingWakeup.id,
            sessionId: entry.sessionId,
            delaySeconds: pendingWakeup.delaySeconds,
            scheduledAt: pendingWakeup.scheduledAt,
            firesAt: pendingWakeup.scheduledAt + pendingWakeup.delaySeconds * 1000,
            reason: pendingWakeup.reason,
            prompt: pendingWakeup.prompt,
          })
        );
      }

      fanout("done", "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[chat ${reqId}] ERROR at ${elapsed()}:`, err);
      entry.status = "error";
      entry.errorMsg = message;
      fanout("error", JSON.stringify({ message }));
    } finally {
      // Drop the per-turn MCP context: the token stops authenticating, and the
      // HTTP routes' per-request servers have nothing left to resolve.
      if (mcpTokenToRelease) unregisterMcpSessionContext(mcpTokenToRelease);

      // Close subscribers so their drain loops wake up and exit. The terminal
      // event ("done" / "error") has already been fanned out into their
      // queues; the drain loop is keyed off `!closed || queue.length > 0`.
      for (const sub of [...entry.subscribers]) sub.close();
      entry.steer = null;
      removeEntryIfSelf(entry);

      // Arm the wakeup AFTER cleanup so activeChats no longer holds this
      // entry — a "session busy" check inside the timer reflects user-driven
      // turns, not the just-finished one.
      if (entry.status === "done" && !entry.cancelRequested && entry.sessionId) {
        const pending = wakeupSlot.get();
        if (pending) {
          scheduleWakeup(entry.sessionId, pending, opts);
        }
      }
    }
  })().catch((err) =>
    console.error(`[chat ${reqId}] unhandled in detached task:`, err)
  );

  return entry;
}

// ============================================================
// POST /chat — start a new turn
// ============================================================

chat.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const prompt: string = body.prompt ?? "";
  const sessionId: string | undefined = body.sessionId;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" && body.clientTurnId
      ? body.clientTurnId
      : undefined;
  const cwd = expandHome(body.cwd || process.env.CC_WEBUI_CWD);
  const model: string | undefined = body.model;
  const permissionMode: PermissionMode | undefined = ALLOWED_MODES.includes(
    body.permissionMode
  )
    ? body.permissionMode
    : undefined;
  const effort: EffortLevel | undefined = ALLOWED_EFFORTS.includes(body.effort)
    ? body.effort
    : undefined;

  // 决策 12：bypass 只给管理员。
  //
  // 它不是「少弹几张卡」——它是唯一一个让 CLI **根本不调 canUseTool** 的 mode：
  // 权限卡不弹，`auto` 那个安全分类器也不跑（实测：分类器只在需要确认时才回到
  // host，bypass 下这条路整个不存在）。给普通账号开 bypass 等于把这台机器上的
  // shell 直接交出去，而目录白名单挡不住 shell。
  //
  // 必须在服务端挡：ModeSelector 里不显示只是不显示，body 是客户端说了算的。
  if (permissionMode === "bypassPermissions" && !isAdmin(c)) {
    return c.json(
      {
        error: "forbidden",
        detail: "Bypass 模式仅管理员可用，请换一个权限模式再发送。",
      },
      403
    );
  }

  type IncomingImage = { name?: string; mediaType?: string; data?: string };
  const rawImages: IncomingImage[] = Array.isArray(body.images)
    ? body.images
    : [];
  const images: NormalizedImage[] = rawImages
    .filter(
      (img): img is { name?: string; mediaType: string; data: string } =>
        typeof img?.mediaType === "string" &&
        img.mediaType.startsWith("image/") &&
        typeof img.data === "string" &&
        img.data.length > 0
    )
    .map((img) => ({
      name: img.name,
      mediaType: img.mediaType,
      data: img.data,
    }));

  if (!prompt.trim() && images.length === 0) {
    return c.json({ error: "prompt or images required" }, 400);
  }

  // Reject if same session already has an in-flight turn. Caller should wait
  // for the prior turn to finish (or switch to attach endpoint to observe it).
  if (sessionId && activeChats.has(sessionId)) {
    const prior = activeChats.get(sessionId)!;
    return c.json(
      {
        error: "session_busy",
        message: `Session ${sessionId} is still processing prior message (reqId ${prior.reqId})`,
      },
      409
    );
  }
  if (clientTurnId && activeChatsByClientTurn.has(clientTurnId)) {
    const prior = activeChatsByClientTurn.get(clientTurnId)!;
    return c.json(
      {
        error: "turn_busy",
        message: `Turn ${clientTurnId} is still processing (reqId ${prior.reqId})`,
      },
      409
    );
  }

  // User submitted a fresh message — drop any wakeup that was waiting to
  // auto-resume this session, since the human is back in the loop.
  cancelPendingWakeup(sessionId);

  const entry = runChatTurn({
    sessionId,
    clientTurnId,
    prompt,
    images,
    cwd,
    model,
    permissionMode,
    effort,
    source: "user",
    ownerId: currentUser(c)?.id,
  });

  return streamSSEUnbuffered(c, async (stream) => {
    await attachStreamToEntry(stream, entry);
  });
});

// ============================================================
// POST /chat/cancel — stop an in-flight turn
// ============================================================

chat.post("/chat/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" ? body.clientTurnId : undefined;

  // Cancel a pending wakeup even if the session has no active in-flight
  // turn — the user explicitly asked to stop, so don't auto-resume later.
  const cancelledWakeup = cancelPendingWakeup(sessionId);

  const entry = pickInFlight(
    { sessionId, clientTurnId },
    (k) => activeChats.get(k),
    (k) => activeChatsByClientTurn.get(k)
  );
  if (!entry) {
    if (cancelledWakeup) {
      return c.json({ ok: true, cancelledWakeup: cancelledWakeup.id });
    }
    return c.json({ ok: false, reason: "not_found" }, 404);
  }
  if (entry.status !== "running") {
    return c.json({ ok: false, reason: `already_${entry.status}` });
  }

  entry.cancelRequested = true;
  console.log(`[chat ${entry.reqId}] cancel requested`);
  // Fire-and-forget — the iterator's return() unblocks the detached for-await,
  // which then goes through its finally and closes subscribers cleanly.
  entry.cancelIterator?.().catch(() => {});
  return c.json({
    ok: true,
    ...(cancelledWakeup ? { cancelledWakeup: cancelledWakeup.id } : {}),
  });
});

// ============================================================
// POST /chat/steer — 把一条消息塞进**正在跑的**那一轮
// ============================================================
//
// 存在的理由：一轮几十秒到十几分钟，用户看着它往错方向走却只能干等到结束。
// 底下不是我们自己造的插队机制 —— 跑的就是 claude 命令行、**它自己带排队**，
// 起进程时就带了 `--input-format stream-json`（权限确认那一路早在用），
// 往那根**已经开着**的 stdin 多写一行就行。整条路连同下面这些教训抄自律枢
// `server/internal/service/steer.go`。
//
// ⚠️ **`clientTurnId` 是乐观锁。** 用户是冲着他**看见的那一轮**点的发送，等他点下去
//    时那轮可能已经结束、下一轮已经开跑 —— 插进另一轮就是答非所问。所以 pickInFlight
//    给的那条必须同时对得上 sessionId 和 clientTurnId（它本来就是这个语义）。
// ⚠️ **插不进去不是故障。** 三种情形（这一轮刚结束 / 还没起 CLI / 不走 stdin 协议）
//    合流成同一个 409 `steer_unavailable`，前端对它只说「这一轮刚结束，它会按顺序
//    发出」，那条留在排队里等下一轮。**措辞不许报成错。**
// ⚠️ **不落任何库、不进 transcript。** 消息经 CLI 自己的 stdin 进去，CLI 会把它写进
//    `~/.claude/projects/` 的 jsonl —— 那就是本仓唯一的真相。我们再记一份必然漂。
//    界面上那条气泡由前端本地补（`applySDKMessage` 对 user 帧只认 tool_result）。

chat.post("/chat/steer", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const clientTurnId: string | undefined =
    typeof body.clientTurnId === "string" ? body.clientTurnId : undefined;
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return c.json({ error: "text required" }, 400);

  const entry = pickInFlight(
    { sessionId, clientTurnId },
    (k) => activeChats.get(k),
    (k) => activeChatsByClientTurn.get(k)
  );
  const unavailable = (why: string) => {
    // 线上只看得到一个 409 的话，永远不知道该往哪边查 —— 码合流、日志分开。
    console.log(
      `[chat] steer 未送达 session=${sessionId ?? "-"} turn=${clientTurnId ?? "-"} 原因=${why}`
    );
    return c.json(
      {
        error: "steer_unavailable",
        message: "这一轮已经结束或不接受追加，稍后会按顺序发出",
      },
      409
    );
  };
  if (!entry) return unavailable("no_entry");
  if (entry.status !== "running") return unavailable(`already_${entry.status}`);
  if (!entry.steer) return unavailable("no_handle");
  if (!entry.steer(text)) return unavailable("pipe_closed");
  console.log(`[chat ${entry.reqId}] steer 已送达（${text.length} 字）`);
  return c.json({ ok: true });
});

// ============================================================
// GET /chat/inflight — list sessions with an active turn
// ============================================================
//
// Used by the sidebar to draw a pulsing dot on sessions that are currently
// generating. Lightweight: clients poll this every few seconds rather than
// subscribing via SSE.

chat.get("/chat/inflight", (c) => {
  // Scoped: this used to hand every caller the id of every running session.
  const visible = visibilityFor(currentUser(c)!);
  const sessionIds = Array.from(activeChats.keys()).filter(visible);
  return c.json({ sessionIds });
});

// ============================================================
// GET /chat/wakeups — list sessions with a pending wakeup
// ============================================================
//
// Returns one entry per session that has a wakeup armed. UI can use this to
// show a countdown badge and offer a manual-cancel button.

chat.get("/chat/wakeups", (c) => {
  const visible = visibilityFor(currentUser(c)!);
  const wakeups = Array.from(wakeupTimers.values())
    .filter((w) => visible(w.sessionId))
    .map((w) => ({
    sessionId: w.sessionId,
    id: w.request.id,
    delaySeconds: w.request.delaySeconds,
    scheduledAt: w.request.scheduledAt,
    firesAt: w.request.scheduledAt + w.request.delaySeconds * 1000,
      reason: w.request.reason,
      prompt: w.request.prompt,
    }));
  return c.json({ wakeups });
});

// ============================================================
// POST /chat/wakeups/cancel — cancel a pending wakeup
// ============================================================

chat.post("/chat/wakeups/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sessionId: string | undefined =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  if (!sessionId) {
    return c.json({ ok: false, reason: "sessionId required" }, 400);
  }
  const cancelled = cancelPendingWakeup(sessionId);
  return c.json(
    cancelled
      ? { ok: true, id: cancelled.id }
      : { ok: false, reason: "not_found" }
  );
});

// ============================================================
// GET /chat/attach — reconnect to an in-flight turn
// ============================================================

chat.get("/chat/attach", (c) => {
  const sessionId = c.req.query("sessionId");
  const clientTurnId = c.req.query("clientTurnId");
  return streamSSEUnbuffered(c, async (stream) => {
    if (!sessionId && !clientTurnId) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    const entry = pickInFlight(
      { sessionId, clientTurnId },
      (k) => activeChats.get(k),
      (k) => activeChatsByClientTurn.get(k)
    );
    if (!entry) {
      await stream.writeSSE({ event: "no-inflight", data: "" });
      return;
    }
    await attachStreamToEntry(stream, entry);
  });
});

export { chat };
