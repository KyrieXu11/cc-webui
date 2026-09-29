import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import ProjectSidebar from "./components/ProjectSidebar";
import EmptyProjectSidebar from "./components/EmptyProjectSidebar";
import RightDock from "./components/RightDock";
import FilePreviewWindow from "./components/FilePreviewWindow";
import Header from "./components/Header";
import Composer from "./components/Composer";
import MessageList from "./components/MessageList";
import HomeView from "./components/HomeView";
import OpenProjectDialog from "./components/OpenProjectDialog";
import SkillsPicker from "./components/SkillsPicker";
import HelpModal from "./components/HelpModal";
import AdminView from "./components/AdminView";
import TasksButton from "./components/TasksButton";
import TasksModal from "./components/TasksModal";
import GroupChatView from "./components/group/GroupChatView";
import GroupConfigDialog from "./components/group/GroupConfigDialog";
import GroupSidebar from "./components/group/GroupSidebar";
import type { ChatEvent, PermissionDecision } from "./lib/types";
import {
  streamChat,
  connectAttach,
  cancelChat,
  steerChat,
  getInflightSessions,
  type ImageAttachment,
} from "./lib/api";
import { detachForeground } from "./lib/tasks";
import { applySDKMessage, sessionMessagesToEvents } from "./lib/processor";
import {
  loadSettings,
  saveSettings,
  systemTheme,
  defaultModelForProvider,
  modelOptionsForProvider,
  clampEffort,
  legalModeFor,
  type AgentProvider,
  type PermissionMode,
  type Settings,
  type Theme,
} from "./lib/settings";
import {
  applyUserDefaults,
  hasPendingDefaults,
  loadAppliedMarks,
  saveAppliedMarks,
} from "./lib/user-defaults";
import { addRecent, getHome, readFile } from "./lib/fs";
import MemoryDialog from "./components/MemoryDialog";
import { isImageFile, isPdfFile, isTextFile, rawFileUrl } from "./lib/filepreview";
import { getSessionMessages, type SessionSummary } from "./lib/sessions";
import { sendPermission } from "./lib/permission";
import { useAuth } from "./AuthGate";
import { useIsNarrow } from "./lib/useIsNarrow";

const INITIAL_VISIBLE = 200;
const LOAD_MORE_STEP = 200;
const ACTIVE_TURN_KEY = "cc-webui:activeTurn";
const INFLIGHT_ATTACH_POLL_MS = 3000;

/** 排队的一条消息。`images` 跟着走，不然排队发出去的那条会把图丢了。 */
type QueuedMessage = {
  id: string;
  text: string;
  images?: ImageAttachment[];
  /** 见 Composer 里同名字段：`stopped` 冻整队，`failed` 只标这一条。 */
  paused?: "stopped" | "failed";
  note?: string;
};

type ActiveTurn = {
  clientTurnId: string;
  agentProvider: AgentProvider;
  cwd: string;
  sessionId: string | null;
  prompt: string;
  startedAt: number;
};

function createClientTurnId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadActiveTurn(): ActiveTurn | null {
  try {
    const raw = localStorage.getItem(ACTIVE_TURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveTurn;
    if (!parsed?.clientTurnId || !parsed.cwd) return null;
    parsed.agentProvider = parsed.agentProvider ?? "claude";
    if (Date.now() - (parsed.startedAt || 0) > 60 * 60 * 1000) {
      localStorage.removeItem(ACTIVE_TURN_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveActiveTurn(turn: ActiveTurn): void {
  try {
    localStorage.setItem(ACTIVE_TURN_KEY, JSON.stringify(turn));
  } catch {
    /* ignore */
  }
}

function clearSavedActiveTurn(): void {
  try {
    localStorage.removeItem(ACTIVE_TURN_KEY);
  } catch {
    /* ignore */
  }
}

function activeTurnUserEvent(turn: ActiveTurn): ChatEvent {
  return {
    id: `u-${turn.clientTurnId}`,
    type: "user",
    text: turn.prompt,
  };
}

function findActiveProgressStart(events: ChatEvent[]): number {
  let lastUserIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const start = lastUserIndex + 1;
  const suffix = events.slice(start);
  const hasWaitingProgress = suffix.some(
    (e) =>
      (e.type === "permission" && e.resolved === undefined && !e.stale) ||
      (e.type === "step" && e.status === "pending")
  );
  return hasWaitingProgress ? start : events.length;
}

// ⚠️⚠️ **activeTurn 是全局一条**（localStorage 里就一个 key），记的是「这个浏览器
// 最近起的那个 turn」，**不是**「当前这个会话的 turn」。任何拿它去渲染、attach、
// cancel 的地方都必须先过这一关。
//
// 不过这一关的后果（用户 2026-09-10 报的）：在会话 A 发消息、趁它还在跑切到 B ——
// · attach 会拿着 A 的 sessionId 去连，把 A 的事件流灌进 B 的界面，而 attach 一上来
//   就重放整个 buffer，所以来回切几次就是又重复又错位；
// · B 的历史会被 `beforeMs: A.startedAt` 截断（historyEventsForActiveTurn）；
// · A 的那句提问会被插进 B 的消息列表（ensureActiveTurnUserEvent）；
// · 在 B 按停止会把 A 掐掉（服务端 cancel 优先按 clientTurnId 查）。
//
// cwd 相同是常态（同一个项目下好几个会话），所以**光比 cwd 挡不住**，必须比 id。
function turnForSession(
  turn: ActiveTurn | null,
  sessionId: string | null,
  cwd: string
): ActiveTurn | null {
  if (!turn || turn.cwd !== cwd) return null;
  if (turn.sessionId) return turn.sessionId === sessionId ? turn : null;
  // 还没拿到 session id（全新会话的头几秒，clientTurnId 是唯一把手）：
  // 只有界面也停在新会话上，才算是它的。
  return sessionId ? null : turn;
}

function ensureActiveTurnUserEvent(
  events: ChatEvent[],
  turn: ActiveTurn | null,
  cwd: string,
  provider?: AgentProvider
): ChatEvent[] {
  if (!turn || turn.cwd !== cwd || !turn.prompt.trim()) return events;
  if (provider && turn.agentProvider !== provider) return events;
  const hasPrompt = events.some(
    (e) => e.type === "user" && e.text.trim() === turn.prompt.trim()
  );
  if (hasPrompt) return events;
  const idx = findActiveProgressStart(events);
  const userEvent = activeTurnUserEvent(turn);
  return [...events.slice(0, idx), userEvent, ...events.slice(idx)];
}

function historyEventsForActiveTurn(
  msgs: Parameters<typeof sessionMessagesToEvents>[0],
  turn: ActiveTurn | null,
  cwd: string,
  provider: AgentProvider
): ChatEvent[] {
  return sessionMessagesToEvents(
    msgs,
    turn && turn.cwd === cwd && turn.agentProvider === provider
      ? { beforeMs: turn.startedAt }
      : undefined
  );
}

function isVisibleProgress(ev: ChatEvent): boolean {
  // Encrypted thinking has no text, only a token counter — but it DOES render
  // (as a timeline status row), so it counts as progress and must suppress the
  // "nothing happened yet" spinner.
  if (ev.type === "thinking") {
    return ev.text.trim().length > 0 || (ev.tokens ?? 0) > 0;
  }
  if (ev.type === "assistant") {
    return ev.text.trim().length > 0;
  }
  return (
    ev.type === "step" || ev.type === "permission" || ev.type === "summary"
  );
}

function shouldShowPending(events: ChatEvent[], busy: boolean): boolean {
  if (!busy) return false;
  let lastUserIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return false;
  return !events.slice(lastUserIndex + 1).some(isVisibleProgress);
}

export default function App() {
  const [allEvents, setAllEvents] = useState<ChatEvent[]>([]);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachedStreaming, setAttachedStreaming] = useState(false);
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  // 界面上正在流的那一轮**实际**用的 effort（服务端 turn_meta 帧），给思考状态行用。
  // ⚠️ 不能拿 settings.effort 顶：看别人的轮次时那是看的人自己的设置（她 xhigh、
  // 你这边显示 max）。只有正在往界面写的那条流能设它，每条流开始时先清掉。
  const [turnEffort, setTurnEffort] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [systemPref, setSystemPref] = useState<Theme>(systemTheme);
  // 窄屏：两个侧栏从常驻列变成抽屉（方案 B）。
  const narrow = useIsNarrow();
  const [navOpen, setNavOpen] = useState(false);
  const activeTheme: Theme = settings.theme ?? systemPref;
  const [projectCwd, setProjectCwd] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  // 项目记忆（只读）弹窗。按钮只在项目里出现，弹窗也只在项目里渲染。
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 服务端配了 ONLYOFFICE 才给 Office 编辑器，否则降级成浏览器打开/下载。
  const [officeFeature, setOfficeFeature] = useState(false);
  const [home, setHome] = useState("");
  const [loadingSession, setLoadingSession] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  // 右侧格总开关（项目树 / 取件台 / 打开的文档都在那一格里）。
  const [dockOpen, setDockOpen] = useState(false);
  const openDock = useCallback(() => setDockOpen(true), []);
  const [composerValue, setComposerValue] = useState("");
  // 排队：上一轮还在跑时按下的消息，等它结束后**逐条**自动发出去。
  //
  // ⚠️ **只属于当前这个对话，切走就清掉**（openProject / openSession / goHome /
  //    openGroup / handleNewChat 各清一次）。别改成「跟着会话存起来」——这一格里
  //    同一个 cwd 下好几个会话是常态，一条排队消息落错会话就是 2026-09-10 那个
  //    串台 bug 的翻版，而这次是**主动**往别人的会话里发东西。
  // ⚠️ 不落 localStorage：刷新即清，和输入框里的草稿同级（决策 15 一个道理）。
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // 排空那一下发生在 effect 里，读 state 会读到上一帧的；和 viewRef 同一个套路。
  const queuedRef = useRef<QueuedMessage[]>([]);
  queuedRef.current = queued;
  const [retryInfo, setRetryInfo] = useState<{
    attempt: number;
    maxRetries: number;
    retryDelayMs: number;
    errorStatus: number | null;
  } | null>(null);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillsPickerOpen, setSkillsPickerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);
  const [activeForegrounds, setActiveForegrounds] = useState<
    Array<{ fgId: string; command: string }>
  >([]);
  const [attachRetryNonce, setAttachRetryNonce] = useState(0);
  const [currentGroupIdRaw, setCurrentGroupId] = useState<string | null>(null);
  // Group chat is an opt-in server feature (CC_WEBUI_GROUPS_ENABLED). Starts
  // false so nothing group-shaped renders before /api/meta answers.
  const [groupsServerFeature, setGroupsServerFeature] = useState(false);
  // Group chat remains admin-only even when a member is granted Codex access.
  const { isAdmin, user, defaults, allowedProviders } = useAuth();
  const groupsFeature = groupsServerFeature && isAdmin;
  // Every read of the current group goes through the flag, so a stale stored
  // group id can never surface a hidden feature.
  const currentGroupId = groupsFeature ? currentGroupIdRaw : null;
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [groupsRefreshKey, setGroupsRefreshKey] = useState(0);

  const LOCAL_COMMANDS = ["skills", "help", "clear", "exit"];
  const mergedSlashCommands = [
    ...LOCAL_COMMANDS,
    ...slashCommands.filter((c) => !LOCAL_COMMANDS.includes(c)),
  ];
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef<number | null>(null);
  const forceScrollBottom = useRef(false);
  const didRestore = useRef(false);

  const setActiveTurnState = (turn: ActiveTurn) => {
    saveActiveTurn(turn);
    setActiveTurn(turn);
  };

  const updateActiveTurnSession = (id: string) => {
    setActiveTurn((cur) => {
      if (!cur || cur.sessionId === id) return cur;
      const next = { ...cur, sessionId: id };
      saveActiveTurn(next);
      return next;
    });
  };

  const clearActiveTurnState = (clientTurnId?: string) => {
    setActiveTurn((cur) => {
      if (clientTurnId && cur?.clientTurnId !== clientTurnId) return cur;
      clearSavedActiveTurn();
      return null;
    });
  };

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // 管理员给这个账号设的默认模型 / effort：每一版在这台浏览器上只套用一次，
  // 之后用户自己改的会保留，直到管理员再保存（见 lib/user-defaults.ts）。
  useEffect(() => {
    const marks = loadAppliedMarks();
    if (!hasPendingDefaults(defaults, user.id, marks)) return;
    if (defaults.provider && defaults.provider !== settings.agentProvider) {
      clearActiveTurnState(); setSessionId(null); setAllEvents([]);
    }
    setSettings((s) => applyUserDefaults(s, defaults));
    saveAppliedMarks({ ...marks, [user.id]: defaults.updatedAt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id, defaults?.updatedAt]);

  // No stored choice → follow the OS, and keep following it while it changes.
  useEffect(() => {
    if (settings.theme) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setSystemPref(mq.matches ? "light" : "dark");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
  }, [activeTheme]);

  // 抽屉盖着整块内容，选完一个会话/项目/群还留在原地会让人以为没点中。
  useEffect(() => {
    setNavOpen(false);
  }, [projectCwd, sessionId, currentGroupId]);

  // 转成桌面宽度后抽屉不该还“开着”——它此时是常驻列，开关没有意义。
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);

  // 抽屉盖住整屏，Esc 是除了点遮罩之外的第二条退路。
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  useEffect(() => {
    getHome().then(setHome).catch(() => {});
  }, []);

  // Restore last-open project (+ session) on reload.
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    try {
      const active = loadActiveTurn();
      if (active) setActiveTurn(active);
      const raw = localStorage.getItem("cc-webui:lastProject");
      const saved = raw
        ? (JSON.parse(raw) as {
            cwd?: string;
            sessionId?: string | null;
            agentProvider?: AgentProvider;
          })
        : null;
      const cwd = saved?.cwd || active?.cwd;
      if (!cwd) return;
      const restoreProvider = saved?.agentProvider || active?.agentProvider || "claude";
      setSettings((cur) =>
        cur.agentProvider === restoreProvider
          ? cur
          : {
              ...cur,
              agentProvider: restoreProvider,
              model: defaultModelForProvider(restoreProvider),
            }
      );
      setProjectCwd(cwd);
      setSidebarOpen(true);
      const restoreSessionId = saved?.sessionId || active?.sessionId || null;
      // ⚠️ 恢复的会话未必就是 activeTurn 那一个（上次关页面前刚切过会话）。
      // 不比一下的话，B 的历史会被 `beforeMs: A.startedAt` 截掉一段，
      // 而且 A 的提问会被插进 B 的列表里。
      const mine = turnForSession(active, restoreSessionId, cwd);
      if (restoreSessionId) {
        setSessionId(restoreSessionId);
        setLoadingSession(true);
        getSessionMessages(restoreSessionId, cwd, 5000, restoreProvider)
          .then((msgs) => {
            forceScrollBottom.current = true;
            setAllEvents(
              ensureActiveTurnUserEvent(
                historyEventsForActiveTurn(msgs, mine, cwd, restoreProvider),
                mine,
                cwd,
                restoreProvider
              )
            );
          })
          .catch(() =>
            setAllEvents(
              ensureActiveTurnUserEvent([], mine, cwd, restoreProvider)
            )
          )
          .finally(() => setLoadingSession(false));
      } else if (active?.prompt && active.cwd === cwd) {
        setAllEvents([activeTurnUserEvent(active)]);
      }
    } catch {
      /* ignore corrupt saved state */
    }
  }, []);

  // Persist current project + session so refresh lands back in place.
  useEffect(() => {
    if (!didRestore.current) return;
    try {
      if (!projectCwd) {
        localStorage.removeItem("cc-webui:lastProject");
      } else {
        localStorage.setItem(
          "cc-webui:lastProject",
          JSON.stringify({
            cwd: projectCwd,
            sessionId,
            agentProvider: settings.agentProvider,
          })
        );
      }
    } catch {
      /* ignore */
    }
  }, [projectCwd, sessionId, settings.agentProvider]);

  // Server feature flags. Separate from the cwd-scoped meta fetch below
  // because the home view has no project yet and still needs the flag.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/meta")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setGroupsServerFeature(data.features?.groups === true);
        setOfficeFeature(data.features?.office === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectCwd) return;
    let cancelled = false;
    const qs = new URLSearchParams();
    qs.set("cwd", projectCwd);
    fetch(`/api/meta?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (Array.isArray(data.slashCommands) && data.slashCommands.length > 0) {
          setSlashCommands(data.slashCommands);
        }
        if (Array.isArray(data.skills) && data.skills.length > 0) {
          setSkills(data.skills);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectCwd]);

  const toggleStep = (id: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const answerPermission = async (
    permissionId: string,
    decision: PermissionDecision,
    message?: string,
    answers?: Record<string, string>
  ) => {
    try {
      await sendPermission(permissionId, decision, message, answers);
      setAllEvents((prev) =>
        prev.map((e) =>
          e.type === "permission" && e.permissionId === permissionId
            ? { ...e, resolved: decision }
            : e
        )
      );
    } catch (err) {
      console.error("permission resolve failed:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes("no longer pending")) {
        setAllEvents((prev) =>
          prev.map((e) =>
            e.type === "permission" && e.permissionId === permissionId
              ? { ...e, stale: true }
              : e
          )
        );
      }
    }
  };

  // 只有属于当前这个会话的 turn 才能拿来 attach / 渲染 / cancel（见 turnForSession）。
  const liveTurn = turnForSession(activeTurn, sessionId, projectCwd);

  // 发出去之后那个 for-await 会跑很久，闭包里的 sessionId / projectCwd 停在
  // 「发送那一刻」。要判断「用户是不是已经切走了」只能读 ref。
  const viewRef = useRef({ sessionId, cwd: projectCwd });
  viewRef.current = { sessionId, cwd: projectCwd };

  // isStreaming 是全局一个 flag，但它描述的是**某一个会话**在跑。切到别的会话之后
  // 不该让那边的输入框也变灰、也不该挡住那边自己的 attach。
  const streamingHere = isStreaming && !!liveTurn;

  const attachKey = liveTurn?.clientTurnId
    ? `${liveTurn.agentProvider}:turn:${liveTurn.clientTurnId}`
    : sessionId
      ? `${settings.agentProvider}:session:${sessionId}`
      : "";

  // Wakeup-triggered turns start on the server without an initiating browser
  // request, so no EventSource exists yet. Poll the lightweight in-flight
  // registry and nudge the normal attach effect when the currently-open
  // session becomes active.
  useEffect(() => {
    if (!sessionId || !projectCwd) return;
    let alive = true;
    const tick = () => {
      if (streamingHere || attachedStreaming || loadingSession) return;
      getInflightSessions(settings.agentProvider)
        .then((set) => {
          if (!alive) return;
          if (set.has(sessionId)) {
            setAttachRetryNonce((n) => n + 1);
          }
        })
        .catch(() => {});
    };
    const timer = setInterval(tick, INFLIGHT_ATTACH_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [
    sessionId,
    projectCwd,
    settings.agentProvider,
    isStreaming,
    attachedStreaming,
    loadingSession,
  ]);

  // Auto-attach to any in-flight SDK turn. The clientTurnId path covers a
  // refresh during the first seconds of a brand-new chat, before the SDK has
  // emitted its real session_id.
  useEffect(() => {
    if (!attachKey) return;
    // 只有「这个会话自己正在流」才跳过 attach。别的会话在跑不该挡住这边。
    if (streamingHere) return;
    if (loadingSession) return;
    const clientTurnId = liveTurn?.clientTurnId ?? null;
    const attachSessionId = liveTurn?.sessionId ?? sessionId;
    const attachProvider = liveTurn?.agentProvider ?? settings.agentProvider;
    let closed = false;
    // 重放会先送来这一轮的 turn_meta；在那之前别留着上一轮的。
    setTurnEffort(undefined);
    setAttachedStreaming(true);
    const finishAttach = (reason: "done" | "error" | "no-inflight") => {
      if (closed) return;
      setAttachedStreaming(false);
      setRetryInfo(null);
      if (clientTurnId) clearActiveTurnState(clientTurnId);
      if (reason === "done") {
        // Same reason as in handleSend: the turn we were attached to just
        // ended; refresh the sidebar so the new session shows up.
        setSessionsRefreshKey((n) => n + 1);
      }
      if (reason === "error") {
        setAllEvents((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            type: "assistant",
            text: "[错误] 流式连接中断，请重新打开会话确认历史消息。",
          },
        ]);
      }
    };
    const unsub = connectAttach(
      { sessionId: attachSessionId, clientTurnId, agentProvider: attachProvider },
      (msg) => {
        if (msg?.type === "turn_meta") {
          setTurnEffort(typeof msg.effort === "string" ? msg.effort : undefined);
          return;
        }
        if (msg?.type === "foreground_started" && msg.fgId) {
          setActiveForegrounds((prev) =>
            prev.some((f) => f.fgId === msg.fgId)
              ? prev
              : [...prev, { fgId: msg.fgId, command: msg.command ?? "" }]
          );
          return;
        }
        if (msg?.type === "foreground_ended" && msg.fgId) {
          setActiveForegrounds((prev) =>
            prev.filter((f) => f.fgId !== msg.fgId)
          );
          return;
        }
        if (msg?.type === "system" && msg.subtype === "api_retry") {
          // Same retry banner as the initiating-stream path in handleSend —
          // a refresh mid-retry should keep showing the countdown.
          setRetryInfo({
            attempt: msg.attempt ?? 0,
            maxRetries: msg.max_retries ?? 0,
            retryDelayMs: msg.retry_delay_ms ?? 0,
            errorStatus: msg.error_status ?? null,
          });
          return;
        }
        if (msg?.type === "system" && msg.subtype === "init") {
          if (Array.isArray(msg.slash_commands)) {
            setSlashCommands(msg.slash_commands);
          }
          if (Array.isArray(msg.skills)) {
            setSkills(msg.skills);
          }
        }
        setRetryInfo((cur) => (cur ? null : cur));
        setAllEvents((prev) =>
          applySDKMessage(
            ensureActiveTurnUserEvent(prev, liveTurn, projectCwd, attachProvider),
            msg,
            (id) => {
              setSessionId(id);
              updateActiveTurnSession(id);
            }
          )
        );
      },
      finishAttach
    );
    return () => {
      closed = true;
      setAttachedStreaming(false);
      setActiveForegrounds([]);
      unsub();
    };
  }, [
    attachKey,
    attachRetryNonce,
    streamingHere,
    loadingSession,
    projectCwd,
    settings.agentProvider,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "o") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        const stepIds = allEvents.filter((x) => x.type === "step").map((x) => x.id);
        setExpandedSteps((prev) =>
          prev.size > 0 ? new Set() : new Set(stepIds)
        );
      }
      // Ctrl+B: detach the most recent running foreground bash to a background
      // task. Silent no-op when no foreground is active so the key never
      // accidentally disrupts typing.
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "b") {
        if (activeForegrounds.length === 0) return;
        e.preventDefault();
        const latest = activeForegrounds[activeForegrounds.length - 1];
        detachForeground(latest.fgId).catch((err) =>
          console.error("detachForeground failed:", err)
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allEvents, activeForegrounds]);

  const events = useMemo(
    () =>
      allEvents.length <= visibleCount
        ? allEvents
        : allEvents.slice(-visibleCount),
    [allEvents, visibleCount]
  );

  const canLoadMore = visibleCount < allEvents.length;

  useEffect(() => {
    if (!canLoadMore) return;
    const loader = loadMoreRef.current;
    const scroller = scrollRef.current;
    if (!loader || !scroller) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          prevScrollHeight.current = scroller.scrollHeight;
          setVisibleCount((c) => Math.min(c + LOAD_MORE_STEP, allEvents.length));
        }
      },
      { root: scroller, threshold: 0.1 }
    );
    io.observe(loader);
    return () => io.disconnect();
  }, [canLoadMore, allEvents.length]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (forceScrollBottom.current) {
      el.scrollTop = el.scrollHeight;
      forceScrollBottom.current = false;
      return;
    }

    if (prevScrollHeight.current !== null) {
      const delta = el.scrollHeight - prevScrollHeight.current;
      el.scrollTop += delta;
      prevScrollHeight.current = null;
      return;
    }

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [events, loadingSession]);

  const openProject = (cwd: string) => {
    clearActiveTurnState();
    // 排队只属于刚才那个对话，别带到下一个去。
    setQueued([]);
    setProjectCwd(cwd);
    setSidebarOpen(true);
    setDialogOpen(false);
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
    addRecent(cwd).catch(() => {});
  };

  const openSession = async (s: SessionSummary) => {
    if (!s.cwd) {
      console.warn("session has no cwd, cannot resume");
      return;
    }
    clearActiveTurnState();
    // 排队只属于刚才那个对话，别带到下一个去。
    setQueued([]);
    setProjectCwd(s.cwd);
    setSessionId(s.sessionId);
    setSettings((cur) => {
      const modelOptions = modelOptionsForProvider(s.provider);
      const model = modelOptions.some((m) => m.id === cur.model)
        ? cur.model
        : defaultModelForProvider(s.provider);
      return { ...cur, agentProvider: s.provider, model };
    });
    setSidebarOpen(true);
    setDialogOpen(false);
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setLoadingSession(true);
    addRecent(s.cwd).catch(() => {});
    try {
      const msgs = await getSessionMessages(s.sessionId, s.cwd, 5000, s.provider);
      forceScrollBottom.current = true;
      setAllEvents(sessionMessagesToEvents(msgs));
    } catch (err) {
      console.error("load session messages failed:", err);
      setAllEvents([]);
    } finally {
      setLoadingSession(false);
    }
  };

  const goHome = () => {
    clearActiveTurnState();
    // 排队只属于刚才那个对话，别带到下一个去。
    setQueued([]);
    setProjectCwd("");
    setSidebarOpen(false);
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
    setCurrentGroupId(null);
  };

  const openGroup = (gid: string) => {
    clearActiveTurnState();
    // 排队只属于刚才那个对话，别带到下一个去。
    setQueued([]);
    setProjectCwd("");
    setSidebarOpen(true);
    setAllEvents([]);
    setSessionId(null);
    setCurrentGroupId(gid);
  };

  const closeGroup = () => {
    setCurrentGroupId(null);
    setGroupsRefreshKey((k) => k + 1);
  };

  // Persist currentGroupId across refresh
  useEffect(() => {
    if (!didRestore.current) return;
    // With groups disabled currentGroupId is forced to null, so persisting
    // here would delete a perfectly good stored id. Leave it untouched.
    if (!groupsFeature) return;
    try {
      if (currentGroupId) {
        localStorage.setItem("cc-webui:lastGroup", currentGroupId);
      } else {
        localStorage.removeItem("cc-webui:lastGroup");
      }
    } catch {
      /* ignore */
    }
  }, [currentGroupId, groupsFeature]);

  // Restore last open group on first load (skipped if a project is restoring)
  useEffect(() => {
    if (!didRestore.current) return;
    try {
      const last = localStorage.getItem("cc-webui:lastGroup");
      if (last && !projectCwd && !currentGroupId) {
        setCurrentGroupId(last);
      }
    } catch {
      /* ignore */
    }
    // run once after restore phase settles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateModel = (model: string) =>
    setSettings((s) => ({ ...s, model, effort: clampEffort(s.effort, model) }));

  const updateProvider = (agentProvider: AgentProvider) => {
    clearActiveTurnState();
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
    setSettings((s) => {
      const modelOptions = modelOptionsForProvider(agentProvider);
      const model = modelOptions.some((m) => m.id === s.model)
        ? s.model
        : defaultModelForProvider(agentProvider);
      return { ...s, agentProvider, model, effort: clampEffort(s.effort, model) };
    });
  };

  // Revoked providers may still be read as history, but not used for a new turn.
  useEffect(() => {
    if (!sessionId && !allowedProviders.includes(settings.agentProvider)) {
      updateProvider(allowedProviders[0] ?? "claude");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedProviders.join(","), settings.agentProvider, sessionId]);

  // 同样的道理，bypass 也是管理员专属（决策 12）。
  useEffect(() => {
    const legal = legalModeFor(settings.permissionMode, isAdmin);
    if (legal !== settings.permissionMode) updateMode(legal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, settings.permissionMode]);

  const updateMode = (permissionMode: PermissionMode) =>
    setSettings((s) => ({ ...s, permissionMode }));

  const updateEffort = (effort: Settings["effort"]) =>
    setSettings((s) => ({ ...s, effort }));

  const handleSend = async (text: string, images?: ImageAttachment[]) => {
    if (!allowedProviders.includes(settings.agentProvider)) return;
    const clientTurnId = createClientTurnId();
    setActiveTurnState({
      clientTurnId,
      agentProvider: settings.agentProvider,
      cwd: projectCwd,
      sessionId,
      prompt: text,
      startedAt: Date.now(),
    });
    const userEvt: ChatEvent = {
      id: `u-${clientTurnId}`,
      type: "user",
      text,
      images: images && images.length > 0 ? images : undefined,
    };
    setAllEvents((prev) => [...prev, userEvt]);
    setVisibleCount((c) => Math.max(c, INITIAL_VISIBLE));
    setIsStreaming(true);
    setTurnEffort(undefined);

    // 这个 turn 归属的会话。新会话时先是 null，等 CLI 吐出 session_id 再落定。
    const turnCwd = projectCwd;
    let turnSession = sessionId;
    // 界面是不是还停在这个 turn 上。
    const stillViewing = () =>
      viewRef.current.cwd === turnCwd && viewRef.current.sessionId === turnSession;
    // 一旦用户切走过一次，这个流就**永久交棒给 attach**，不再往界面写。
    // 不这么做的话，切回来时中间那段（切走期间的事件）会缺一块——而 attach
    // 一上来就重放整个 buffer，交给它才是一条不少的那条路。
    let handedOff = false;

    try {
      for await (const msg of streamChat({
        prompt: text,
        sessionId,
        clientTurnId,
        cwd: projectCwd,
        agentProvider: settings.agentProvider,
        model: settings.model,
        permissionMode: settings.permissionMode,
        effort: settings.effort,
        images,
      })) {
        // session_id 是这个 turn 的**身份**，用户还在不在看都要认领：
        // activeTurn 靠它，之后的 attach 也靠它找回这条 turn。
        if (
          msg?.type === "system" &&
          msg.subtype === "init" &&
          typeof msg.session_id === "string"
        ) {
          const wasViewing = stillViewing();
          turnSession = msg.session_id;
          updateActiveTurnSession(msg.session_id);
          if (wasViewing && !handedOff) setSessionId(msg.session_id);
        }
        // ⚠️⚠️ **用户可能在 turn 还没跑完时就切到别的会话去了**（服务端本来就是
        // 脱钩的，turn 会继续跑）。它的事件绝不能再往**当前显示的那个会话**的
        // 消息列表里写 —— 那就是「打开的是 B，界面上流的是 A 的内容」，来回切
        // 还会因为 attach 重放 buffer 而重复、错位（用户 2026-09-10 报的）。
        if (!stillViewing() || handedOff) {
          if (!handedOff) {
            handedOff = true;
            // 交棒：让 attach 效应能接管（它以 streamingHere 为门槛）。
            setIsStreaming(false);
          }
          continue;
        }
        if (msg?.type === "turn_meta") {
          setTurnEffort(typeof msg.effort === "string" ? msg.effort : undefined);
          continue;
        }
        if (msg?.type === "system" && msg.subtype === "api_retry") {
          setRetryInfo({
            attempt: msg.attempt ?? 0,
            maxRetries: msg.max_retries ?? 0,
            retryDelayMs: msg.retry_delay_ms ?? 0,
            errorStatus: msg.error_status ?? null,
          });
          continue;
        }
        if (msg?.type === "foreground_started" && msg.fgId) {
          setActiveForegrounds((prev) =>
            prev.some((f) => f.fgId === msg.fgId)
              ? prev
              : [...prev, { fgId: msg.fgId, command: msg.command ?? "" }]
          );
          continue;
        }
        if (msg?.type === "foreground_ended" && msg.fgId) {
          setActiveForegrounds((prev) => prev.filter((f) => f.fgId !== msg.fgId));
          continue;
        }
        if (msg?.type === "system" && msg.subtype === "init") {
          if (Array.isArray(msg.slash_commands)) {
            setSlashCommands(msg.slash_commands);
          }
          if (Array.isArray(msg.skills)) {
            setSkills(msg.skills);
          }
        }
        setRetryInfo((cur) => (cur ? null : cur));
        setAllEvents((prev) =>
          applySDKMessage(prev, msg, (id) => {
            setSessionId(id);
            updateActiveTurnSession(id);
          })
        );
      }
    } catch (err) {
      console.error("stream error:", err);
      const message = err instanceof Error ? err.message : String(err);
      const isBusy =
        message.startsWith("session_busy:") ||
        message.startsWith("turn_busy:");
      // 已经切走了就别把报错塞进**别人**的会话里（同上）。这条 turn 的错误会在
      // 用户切回来 attach 时由服务端那边的 error 事件补上。
      if (!stillViewing() || handedOff) return;
      setAllEvents((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          type: "assistant",
          text: isBusy
            ? `[上一轮还在生成] ${message.slice("session_busy:".length).trim()}`
            : `[错误] ${message}`,
        },
      ]);
    } finally {
      setIsStreaming(false);
      setRetryInfo(null);
      clearActiveTurnState(clientTurnId);
      // A turn just finished — sidebar may be stale (the just-created session
      // wasn't on disk yet when ProjectSidebar fetched on session-id flip).
      setSessionsRefreshKey((n) => n + 1);
    }
  };

  const handleNewChat = () => {
    if (!allowedProviders.includes(settings.agentProvider)) updateProvider(allowedProviders[0] ?? "claude");
    clearActiveTurnState();
    // 排队只属于刚才那个对话，别带到下一个去。
    setQueued([]);
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
  };

  // 删掉的正好是界面上开着的那一条 → 切到新对话。不这么做的话 sessionId 还指着一个
  // 已经不存在的会话（lastProject 里存的也是它，刷新之后又回到这儿），下一条消息会拿它
  // 去 --resume，CLI 回「No conversation found」（用户 2026-09-23 截图）。
  // 服务端另有一道兜底（chat.ts：续聊目标的文件没了就当新对话），这里是让界面别停在死会话上。
  const handleSessionDeleted = (s: SessionSummary) => {
    if (s.sessionId === sessionId && s.provider === settings.agentProvider) {
      handleNewChat();
    }
  };

  const inProject = !!projectCwd;
  const busy = streamingHere || attachedStreaming;

  // Composer 永远调这个。**「现在发还是排队」只在这一处判**，Composer 那边不分叉。
  const submitOrQueue = (text: string, images?: ImageAttachment[]) => {
    if (!busy) {
      // 直接发下一条 ＝ 他已经不想暂停了，顺手解冻（照律枢）。
      resumeQueue();
      void handleSend(text, images);
      return;
    }
    const item: QueuedMessage = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      images,
    };
    setQueued((q) => [...q, item]);
    // ⚠️ **排队之后立刻试着塞进正在跑的这一轮**，不是干等它结束。这是 Claude Code
    //    自己的行为，不是我们发明的：它的会话 jsonl 里有一路 `queue-operation` 记录，
    //    本机 786 个会话里 `remove` 的原因分布是
    //      absorbed_mid_turn 576 · delivered_to_agent 6 · 无原因 255
    //    —— `absorbed_mid_turn`（被当前这一轮吸收）才是主路径。用户 2026-09-20 的
    //    原话「排队没有立刻发出吗？」问的就是这件事。
    //    插不进去（Codex / 带图 / 这轮刚结束）时它原样留在队列里，等排空逻辑按顺序发。
    if (canSteerNow(item)) void absorb(item, false);
  };

  const patchQueued = (id: string, patch: Partial<QueuedMessage>) =>
    setQueued((q) => q.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  // 这一刻能不能把话塞进正在跑的那一轮。
  // Codex 没有这条路（`codex exec` 的 stdin 不是控制协议），带图的也没有（那条路只收文本）。
  const canSteerNow = (item: QueuedMessage) =>
    busy &&
    settings.agentProvider === "claude" &&
    !!liveTurn &&
    !item.images?.length;

  /**
   * 把一条排队消息**塞进正在跑的这一轮**（不等它结束）。
   *
   * ⚠️ 带 clientTurnId 是**乐观锁**：用户是冲着他看见的那一轮发的，等请求到服务端时
   *    那轮可能已经结束、下一轮已开跑 —— 插进另一轮就是答非所问。对不上号回 409。
   * ⚠️ **409 不是故障**：那条原样留在队列里，这一轮结束后由排空逻辑按顺序发出。
   *    所以这里既不弹错、也不标 failed，只在**用户手点**的时候留一句说明。
   */
  const absorb = async (item: QueuedMessage, manual: boolean) => {
    try {
      const r = await steerChat({
        sessionId,
        clientTurnId: liveTurn?.clientTurnId,
        text: item.text,
      });
      if (!r.ok) {
        if (manual) patchQueued(item.id, { note: "这一轮刚结束，会按顺序发出" });
        return;
      }
      // 送到了才进对话流 ——「进对话的时刻 ＝ 真正送出去的时刻」。CLI 会把这条写进它
      // 自己的 jsonl，所以刷新之后由历史回放接管；这里补的只是本轮界面上那只气泡。
      setAllEvents((prev) => [
        ...prev,
        { id: `u-steer-${item.id}`, type: "user", text: item.text },
      ]);
      setQueued((q) => q.filter((m) => m.id !== item.id));
    } catch (err) {
      console.error("steer failed:", err);
      patchQueued(item.id, { paused: "failed", note: undefined });
    }
  };

  // 那条上的「发送」：在跑就插进这一轮，没在跑就是普通发送。
  const sendQueued = (id: string) => {
    const item = queuedRef.current.find((m) => m.id === id);
    if (!item) return;
    if (!busy) {
      setQueued((q) => q.filter((m) => m.id !== id));
      void handleSend(item.text, item.images);
      return;
    }
    if (!canSteerNow(item)) {
      patchQueued(id, {
        note: item.images?.length ? "带图的要等这轮结束" : "这一轮结束后发出",
      });
      return;
    }
    void absorb(item, true);
  };

  // 解冻整队（横幅那颗「继续」，以及用户在空闲时直接发下一条）。
  // 只清 `stopped`：`failed` 是那一条自己的事，得他点「重试」。
  const resumeQueue = () =>
    setQueued((q) =>
      q.some((m) => m.paused === "stopped")
        ? q.map((m) =>
            m.paused === "stopped" ? { ...m, paused: undefined, note: undefined } : m
          )
        : q
    );

  // 这一轮结束 ⇒ 放出队首那条。
  //
  // ⚠️ **挂在 busy 的 true→false 沿上，而不是 handleSend 的 finally 里**：turn 结束
  //    有两条路（自己发起的那条流跑完 / attach 那条收到 done），finally 只覆盖前一条，
  //    刷新后接着看的那种就永远排不出去。
  // ⚠️ **手动「停止」之后照样发。** 停止停的是模型这一轮的活，排队那条是用户自己写下
  //    的话；而且现场十有八九就是「看它跑歪了 → 先打断 → 换个说法」，那条正是要发的。
  // ⚠️ 不要把发送写进 setQueued 的 updater 里：那是纯函数，StrictMode 下会跑两遍，
  //    等于同一条消息发两次。
  const wasBusy = useRef(false);
  useEffect(() => {
    const prev = wasBusy.current;
    wasBusy.current = busy;
    if (!prev || busy) return;
    if (!inProject || currentGroupId || loadingSession) return;
    const q = queuedRef.current;
    // 冻着就整队不动，等用户发话（横幅那颗「继续」，或者他直接发下一条）。
    // 判据是「有没有任何一条被暂停」而不是只看队首：`failed` 那条留在原地等重试，
    // 越过它去发后面的，用户看到的就是自己说的话被调了顺序。
    if (q.length === 0 || q.some((m) => m.paused)) return;
    const next = q[0];
    setQueued((cur) => cur.slice(1));
    void handleSend(next.text, next.images);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, inProject, currentGroupId, loadingSession]);

  // 「停止」。**待发送不清空、只冻住**（照律枢）：按停止多半是嫌它跑太久或方向不对，
  // 那几句话本身还是要说的，程序不该替用户扔掉；但也不能当没看见他按了停止，紧接着
  // 就自动把下一条发出去。解冻靠横幅上那颗「继续」，或者他直接发下一条。
  const handleCancel = async () => {
    setQueued((q) =>
      q.length === 0
        ? q
        : q.map((m) => (m.paused ? m : { ...m, paused: "stopped" as const }))
    );
    // 同一个理由（见 liveTurn 那段注释）：不能用全局的 activeTurn。服务端的
    // cancel **优先按 clientTurnId 查**，所以在 B 会话按停止会去把 A 的 turn
    // 掐掉——而界面上 A 那边什么都不会说。
    const turnId = liveTurn?.clientTurnId ?? null;
    if (!sessionId && !turnId) return;
    try {
      await cancelChat({
        sessionId,
        clientTurnId: turnId,
        agentProvider: liveTurn?.agentProvider ?? settings.agentProvider,
      });
    } catch (err) {
      console.error("cancel failed:", err);
    }
  };

  const handlePickSlash = (cmd: string) => {
    if (cmd === "skills") {
      setSkillsPickerOpen(true);
      setComposerValue("");
      return;
    }
    if (cmd === "help") {
      setHelpOpen(true);
      setComposerValue("");
      return;
    }
    if (cmd === "clear") {
      handleNewChat();
      setComposerValue("");
      return;
    }
    if (cmd === "exit") {
      goHome();
      setComposerValue("");
      return;
    }
    setComposerValue(`/${cmd} `);
  };

  const insertFile = (_abs: string, rel: string) => {
    const token = `@${rel}`;
    setComposerValue((v) => {
      const trimmed = v.trimEnd();
      if (!trimmed) return token + " ";
      if (trimmed.endsWith(token)) return v;
      return `${trimmed} ${token} `;
    });
  };

  const [preview, setPreview] = useState<{
    absPath: string;
    relPath: string;
    kind: "text" | "image" | "pdf";
    content: string;
    imageUrl: string | null;
    truncated: boolean;
    loading: boolean;
    error: string | null;
  } | null>(null);

  const previewAttachedImage = (img: ImageAttachment, label: string) => {
    setPreview({
      absPath: "",
      relPath: label,
      kind: "image",
      content: "",
      imageUrl: `data:${img.mediaType};base64,${img.data}`,
      truncated: false,
      loading: false,
      error: null,
    });
  };

  const previewFile = async (abs: string, rel: string) => {
    const name = abs.slice(abs.lastIndexOf("/") + 1);

    if (isImageFile(name) || isPdfFile(name)) {
      setPreview({
        absPath: abs,
        relPath: rel,
        kind: isPdfFile(name) ? "pdf" : "image",
        content: "",
        // 两者都只要一个 URL：图片给 <img>，PDF 给浏览器自带 viewer 的 <iframe>。
        imageUrl: rawFileUrl(abs),
        truncated: false,
        loading: false,
        error: null,
      });
      return;
    }

    if (!isTextFile(name)) {
      setPreview({
        absPath: abs,
        relPath: rel,
        kind: "text",
        content: "",
        imageUrl: null,
        truncated: false,
        loading: false,
        error: `不支持预览：${name} 不是已知的文本 / 图片 / PDF 文件类型`,
      });
      return;
    }
    setPreview({
      absPath: abs,
      relPath: rel,
      kind: "text",
      content: "",
      imageUrl: null,
      truncated: false,
      loading: true,
      error: null,
    });
    try {
      const result = await readFile(abs);
      if (!result) {
        setPreview((cur) =>
          cur && cur.absPath === abs
            ? { ...cur, loading: false, error: "读取失败" }
            : cur
        );
        return;
      }
      setPreview((cur) =>
        cur && cur.absPath === abs
          ? {
              ...cur,
              content: result.content,
              truncated: result.truncated,
              loading: false,
              error: null,
            }
          : cur
      );
    } catch (err) {
      setPreview((cur) =>
        cur && cur.absPath === abs
          ? {
              ...cur,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : cur
      );
    }
  };

  return (
    // ⚠️ relative：右上角那颗「文件面板」开关是绝对定位的（照律枢
    // `.paneltgl.docktoggle{position:absolute;top:11px;right:12px}`）——它必须
    // **位置不动、图标不变**，不能一会儿长在顶栏里、一会儿变成右侧格里的 ✗。
    <div className="relative flex h-full bg-canvas overflow-hidden">
      {/* 桌面：rail(56) + 会话栏(260) 两根常驻列。
          窄屏：同样两个组件原封不动，只是整体变成一个 316px 的左抽屉滑出来
          —— 这是选方案 B 的理由，侧栏组件本身一行都不用改。 */}
      <div
        // ⚠️ 这个属性是右侧格那条分隔条的**量尺**：它按实测宽度给主栏留活路
        //    （rail 56 / 展开会话列表 316），别删，也别挪到内层去。见 lib/pane-width.ts。
        data-railcol
        className={`flex shrink-0 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[316px] max-md:bg-canvas max-md:transition-transform max-md:duration-200 ${
          narrow && !navOpen
            ? "max-md:-translate-x-full"
            : "max-md:shadow-[0_0_60px_rgba(0,0,0,0.55)]"
        }`}
      >
      {/* ⚠️ **窄屏下这颗按钮是「关抽屉」，不是「切会话栏」。** 窄屏时会话栏的渲染条件
          是 `(sidebarOpen || narrow)` —— `narrow` 已经把它顶成 true，所以在手机上切
          `sidebarOpen` 一点效果都没有：用户点抽屉左上角这颗最显眼的按钮，什么都不发生
          （真机反馈「左边的侧边栏不能关闭」）。而此时顶栏那个汉堡**被抽屉盖住点不到**
          （实测 is_visible=true 但 click 超时），于是唯一的退路只剩右边那条 74px 的
          遮罩 —— 等于没有关闭按钮。桌面那边的偏好不动，narrow 分支只管抽屉。 */}
      <Sidebar
        onToggleSidebar={() =>
          narrow ? setNavOpen(false) : setSidebarOpen((o) => !o)
        }
        narrow={narrow}
        onOpenProject={() => setDialogOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenAdmin={() => setAdminOpen(true)}
        onOpenMemory={inProject ? () => setMemoryOpen(true) : undefined}
        theme={activeTheme}
        onToggleTheme={() =>
          setSettings((s) => ({
            ...s,
            theme: (s.theme ?? systemPref) === "dark" ? "light" : "dark",
            themeChosen: true,
          }))
        }
      />
      {(sidebarOpen || narrow) &&
        (currentGroupId ? (
          <GroupSidebar
            home={home}
            currentGroupId={currentGroupId}
            refreshKey={groupsRefreshKey}
            onOpenGroup={openGroup}
            onCreateGroup={() => setNewGroupOpen(true)}
          />
        ) : inProject ? (
          <ProjectSidebar
            cwd={projectCwd}
            home={home}
            currentProvider={settings.agentProvider}
            currentSessionId={sessionId}
            refreshKey={sessionsRefreshKey}
            onNewChat={handleNewChat}
            onOpenSession={openSession}
            onDeleted={handleSessionDeleted}
          />
        ) : (
          <EmptyProjectSidebar
            onOpenProject={() => setDialogOpen(true)}
          />
        ))}
      </div>

      {/* 遮罩：抽屉开着时点空白处关掉。只在窄屏存在。 */}
      {narrow && (navOpen || (inProject && dockOpen)) && (
        <div
          data-drawer-scrim
          className="fixed inset-0 z-30 bg-black/55 md:hidden"
          onClick={() => {
            setNavOpen(false);
            setDockOpen(false);
          }}
        />
      )}

      <div className="flex flex-col flex-1 min-w-0">
        {adminOpen && isAdmin ? (
          <AdminView onClose={() => setAdminOpen(false)} />
        ) : currentGroupId ? (
          <GroupChatView gid={currentGroupId} home={home} onBack={closeGroup} />
        ) : inProject ? (
          <>
            <Header
              onOpenNav={() => setNavOpen((o) => !o)}
              sessionId={sessionId}
              projectPath={projectCwd}
              home={home}
              provider={settings.agentProvider}
              onHome={goHome}
              onNewChat={handleNewChat}
              onPickProject={openProject}
              onPickSession={openSession}
              onSharesChanged={() => setSessionsRefreshKey((n) => n + 1)}
              reserveRight={!dockOpen}
            />
            <main className="flex-1 relative overflow-hidden">
              <div ref={scrollRef} className="h-full overflow-y-auto">
                <div className="max-w-[820px] mx-auto px-6 max-md:px-3.5 pb-4">
                  {loadingSession ? (
                    <div className="flex items-center gap-2 text-subtle text-[12.5px] py-10 font-mono">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue pulse-dot" />
                      加载会话中…
                    </div>
                  ) : (
                    <>
                      {canLoadMore && (
                        <div
                          ref={loadMoreRef}
                          className="flex items-center justify-center py-3 text-subtle text-[11px] font-mono gap-1.5"
                        >
                          <span className="w-1 h-1 rounded-full bg-subtle animate-pulse" />
                          加载更早消息… ({allEvents.length - visibleCount})
                        </div>
                      )}
                      <MessageList
                        events={events}
                        expandedSteps={expandedSteps}
                        onToggleStep={toggleStep}
                        onAnswerPermission={answerPermission}
                        isPending={shouldShowPending(allEvents, busy)}
                        retryInfo={retryInfo}
                        onPreviewImage={previewAttachedImage}
                        effort={turnEffort}
                      />
                    </>
                  )}
                </div>
              </div>
              <div
                aria-hidden
                className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-canvas to-transparent"
              />
            </main>
            <div className="shrink-0">
              <div className="max-w-[820px] mx-auto w-full">
                {!allowedProviders.includes(settings.agentProvider) && <div className="mb-2 text-[12px] text-muted flex items-center gap-2">
                  此 AI 已停用，当前对话仅供查看。
                  <button className="text-blue" onClick={handleNewChat}>新建可用 AI 对话</button>
                </div>}
                <Composer
                  onSend={submitOrQueue}
                  onCancel={handleCancel}
                  disabled={busy || !allowedProviders.includes(settings.agentProvider)}
                  queued={queued}
                  onUnqueue={(id) =>
                    setQueued((q) => q.filter((m) => m.id !== id))
                  }
                  onSendQueued={(id) => void sendQueued(id)}
                  onResumeQueue={resumeQueue}
                  canSteer={
                    busy && settings.agentProvider === "claude" && !!liveTurn
                  }
                  provider={settings.agentProvider}
                  model={settings.model}
                  onModelChange={updateModel}
                  mode={settings.permissionMode}
                  onModeChange={updateMode}
                  effort={settings.effort}
                  onEffortChange={updateEffort}
                  value={composerValue}
                  onChange={setComposerValue}
                  onInsertFile={insertFile}
                  slashCommands={mergedSlashCommands}
                  onPickSlash={handlePickSlash}
                  rightSlot={
                    <TasksButton
                      sessionId={sessionId}
                      onOpen={() => setTasksOpen(true)}
                      refreshKey={tasksRefreshKey}
                    />
                  }
                />
              </div>
            </div>
          </>
        ) : (
          <>
          {/* 首页没有 Header，窄屏下得给一个够得着抽屉的入口 ——
              rail 里装着「打开项目 / 管理 / 帮助 / 主题 / 退出」。 */}
          <div className="md:hidden flex items-center h-12 px-1 border-b border-line shrink-0">
            <button
              aria-label="打开侧栏"
              onClick={() => setNavOpen((o) => !o)}
              className="w-11 h-11 flex items-center justify-center text-muted"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <HomeView
            provider={settings.agentProvider}
            onProviderChange={updateProvider}
            onOpenSession={openSession}
            onOpenProject={openProject}
            onClickOpen={() => setDialogOpen(true)}
            onOpenGroup={openGroup}
            onCreateGroup={() => setNewGroupOpen(true)}
            groupsRefreshKey={groupsRefreshKey}
            groupsEnabled={groupsFeature}
          />
          </>
        )}
      </div>
      {/* 右侧格：App 层唯一一份。⚠️ 不要下沉到某个视图里去渲染——切走就卸载，
          而卸载会销毁编辑器（以后是 OnlyOffice iframe，律枢在那儿栽过）。 */}
      {/* 「文件面板」开关。**绝对定位在窗口右上角、图标永不变**，照律枢
          `.paneltgl.docktoggle{position:absolute;top:11px;right:12px}`。
          ⚠️ 别再把它挪进顶栏、也别在右侧格里另开一个 ✗：那样它会随主栏宽度飘、
          还变成两种不同的东西（用户 2026-08-27：「一下是个侧边栏按钮一下是一个 ❌，
          而且每次还对不齐」）。开关状态只用背景色表示。 */}
      {inProject && (
        <button
          aria-label="切换文件面板"
          title="文件面板（项目文件）"
          onClick={() => setDockOpen((o) => !o)}
          className={`absolute top-[11px] right-3 z-50 p-2 rounded-md border transition-colors ${
            dockOpen
              ? "text-fg bg-fg/[0.06] border-line-strong"
              : "text-muted hover:text-fg border-transparent hover:bg-fg/5"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect
              x="2"
              y="3"
              width="12"
              height="10"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <line
              x1="10"
              y1="3"
              x2="10"
              y2="13"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        </button>
      )}
      {/* ⚠️ `open` 必须和上面那颗开关**同一个条件**（inProject）。开关只在项目里才有，
          而 dockOpen 回到首页并不会复位：只写 `open={dockOpen}` 的话，在项目里开着
          面板回首页，面板就留在首页上显示「还没有打开项目」，却再也没有东西能关它
          （用户 2026-09-23 报的）。这里不复位 dockOpen 而是不显示：回到项目时面板和
          开着的文件原样还在（收起时本来就不卸载）。 */}
      <RightDock
        open={inProject && dockOpen}
        onRequestOpen={openDock}
        narrow={narrow}
        officeEnabled={officeFeature}
        cwd={inProject ? projectCwd : ""}
        sessionId={sessionId}
        onPreviewFile={previewFile}
      />
      {memoryOpen && inProject && (
        <MemoryDialog cwd={projectCwd} onClose={() => setMemoryOpen(false)} />
      )}
      {preview && (
        <FilePreviewWindow
          absPath={preview.absPath}
          relPath={preview.relPath}
          kind={preview.kind}
          content={preview.content}
          imageUrl={preview.imageUrl}
          truncated={preview.truncated}
          loading={preview.loading}
          error={preview.error}
          onClose={() => setPreview(null)}
        />
      )}
      {dialogOpen && (
        <OpenProjectDialog
          onClose={() => setDialogOpen(false)}
          onOpen={openProject}
        />
      )}
      {skillsPickerOpen && (
        <SkillsPicker
          skills={skills}
          onClose={() => setSkillsPickerOpen(false)}
          onPick={(s) => {
            setSkillsPickerOpen(false);
            setComposerValue(`/${s} `);
          }}
        />
      )}
      {groupsFeature && newGroupOpen && (
        <GroupConfigDialog
          mode={{
            kind: "create",
            cwd: projectCwd || home || process.env.HOME || "/tmp",
            onCreated: (gid) => {
              setNewGroupOpen(false);
              setGroupsRefreshKey((k) => k + 1);
              openGroup(gid);
            },
          }}
          onClose={() => setNewGroupOpen(false)}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {tasksOpen && (
        <TasksModal
          sessionId={sessionId}
          onClose={() => {
            setTasksOpen(false);
            setTasksRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
