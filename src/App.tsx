import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import ProjectSidebar from "./components/ProjectSidebar";
import EmptyProjectSidebar from "./components/EmptyProjectSidebar";
import FileExplorer from "./components/FileExplorer";
import FilePreviewWindow from "./components/FilePreviewWindow";
import Header from "./components/Header";
import Composer from "./components/Composer";
import MessageList from "./components/MessageList";
import HomeView from "./components/HomeView";
import OpenProjectDialog from "./components/OpenProjectDialog";
import SkillsPicker from "./components/SkillsPicker";
import HelpModal from "./components/HelpModal";
import TasksButton from "./components/TasksButton";
import TasksModal from "./components/TasksModal";
import type { ChatEvent, PermissionDecision } from "./lib/types";
import {
  streamChat,
  connectAttach,
  cancelChat,
  getInflightSessions,
  type ImageAttachment,
} from "./lib/api";
import { detachForeground } from "./lib/tasks";
import { applySDKMessage, sessionMessagesToEvents } from "./lib/processor";
import {
  loadSettings,
  saveSettings,
  type PermissionMode,
  type Settings,
} from "./lib/settings";
import { addRecent, getHome, readFile } from "./lib/fs";
import { isImageFile, isTextFile, rawFileUrl } from "./lib/filepreview";
import { getSessionMessages, type SessionSummary } from "./lib/sessions";
import { sendPermission } from "./lib/permission";

const INITIAL_VISIBLE = 200;
const LOAD_MORE_STEP = 200;
const ACTIVE_TURN_KEY = "cc-webui:activeTurn";
const INFLIGHT_ATTACH_POLL_MS = 3000;

type ActiveTurn = {
  clientTurnId: string;
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

function ensureActiveTurnUserEvent(
  events: ChatEvent[],
  turn: ActiveTurn | null,
  cwd: string
): ChatEvent[] {
  if (!turn || turn.cwd !== cwd || !turn.prompt.trim()) return events;
  const hasPrompt = events.some(
    (e) => e.type === "user" && e.text.trim() === turn.prompt.trim()
  );
  return hasPrompt ? events : [...events, activeTurnUserEvent(turn)];
}

function isVisibleProgress(ev: ChatEvent): boolean {
  if (ev.type === "assistant" || ev.type === "thinking") {
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
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [projectCwd, setProjectCwd] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [home, setHome] = useState("");
  const [loadingSession, setLoadingSession] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [filesOpen, setFilesOpen] = useState(false);
  const [composerValue, setComposerValue] = useState("");
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
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [activeForegrounds, setActiveForegrounds] = useState<
    Array<{ fgId: string; command: string }>
  >([]);
  const [attachRetryNonce, setAttachRetryNonce] = useState(0);

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

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

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
          })
        : null;
      const cwd = saved?.cwd || active?.cwd;
      if (!cwd) return;
      setProjectCwd(cwd);
      setSidebarOpen(true);
      const restoreSessionId = saved?.sessionId || active?.sessionId || null;
      if (restoreSessionId) {
        setSessionId(restoreSessionId);
        setLoadingSession(true);
        getSessionMessages(restoreSessionId, cwd)
          .then((msgs) => {
            forceScrollBottom.current = true;
            setAllEvents(
              ensureActiveTurnUserEvent(sessionMessagesToEvents(msgs), active, cwd)
            );
          })
          .catch(() =>
            setAllEvents(ensureActiveTurnUserEvent([], active, cwd))
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
          JSON.stringify({ cwd: projectCwd, sessionId })
        );
      }
    } catch {
      /* ignore */
    }
  }, [projectCwd, sessionId]);

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
    message?: string
  ) => {
    try {
      await sendPermission(permissionId, decision, message);
      setAllEvents((prev) =>
        prev.map((e) =>
          e.type === "permission" && e.permissionId === permissionId
            ? { ...e, resolved: decision }
            : e
        )
      );
    } catch (err) {
      console.error("permission resolve failed:", err);
    }
  };

  const attachKey = activeTurn?.clientTurnId
    ? `turn:${activeTurn.clientTurnId}`
    : sessionId
      ? `session:${sessionId}`
      : "";

  // Wakeup-triggered turns start on the server without an initiating browser
  // request, so no EventSource exists yet. Poll the lightweight in-flight
  // registry and nudge the normal attach effect when the currently-open
  // session becomes active.
  useEffect(() => {
    if (!sessionId || !projectCwd) return;
    let alive = true;
    const tick = () => {
      if (isStreaming || attachedStreaming || loadingSession) return;
      getInflightSessions()
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
  }, [sessionId, projectCwd, isStreaming, attachedStreaming, loadingSession]);

  // Auto-attach to any in-flight SDK turn. The clientTurnId path covers a
  // refresh during the first seconds of a brand-new chat, before the SDK has
  // emitted its real session_id.
  useEffect(() => {
    if (!attachKey) return;
    if (isStreaming) return;
    if (loadingSession) return;
    const clientTurnId = activeTurn?.clientTurnId ?? null;
    const attachSessionId = activeTurn?.sessionId ?? sessionId;
    let closed = false;
    setAttachedStreaming(true);
    const finishAttach = (reason: "done" | "error" | "no-inflight") => {
      if (closed) return;
      setAttachedStreaming(false);
      setRetryInfo(null);
      if (clientTurnId) clearActiveTurnState(clientTurnId);
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
      { sessionId: attachSessionId, clientTurnId },
      (msg) => {
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
        if (msg?.type === "system" && msg.subtype === "init") {
          if (Array.isArray(msg.slash_commands)) {
            setSlashCommands(msg.slash_commands);
          }
          if (Array.isArray(msg.skills)) {
            setSkills(msg.skills);
          }
        }
        setAllEvents((prev) =>
          applySDKMessage(
            ensureActiveTurnUserEvent(prev, activeTurn, projectCwd),
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
  }, [attachKey, attachRetryNonce, isStreaming, loadingSession, projectCwd]);

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
    setProjectCwd(s.cwd);
    setSessionId(s.sessionId);
    setSidebarOpen(true);
    setDialogOpen(false);
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setLoadingSession(true);
    addRecent(s.cwd).catch(() => {});
    try {
      const msgs = await getSessionMessages(s.sessionId, s.cwd);
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
    setProjectCwd("");
    setSidebarOpen(false);
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
  };

  const updateModel = (model: string) =>
    setSettings((s) => {
      const next = { ...s, model };
      if (model !== "opus" && s.effort === "xhigh") {
        next.effort = "high";
      }
      return next;
    });

  const updateMode = (permissionMode: PermissionMode) =>
    setSettings((s) => ({ ...s, permissionMode }));

  const updateEffort = (effort: Settings["effort"]) =>
    setSettings((s) => ({ ...s, effort }));

  const handleSend = async (text: string, images?: ImageAttachment[]) => {
    const clientTurnId = createClientTurnId();
    setActiveTurnState({
      clientTurnId,
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

    try {
      for await (const msg of streamChat({
        prompt: text,
        sessionId,
        clientTurnId,
        cwd: projectCwd,
        model: settings.model,
        permissionMode: settings.permissionMode,
        effort: settings.effort,
        images,
      })) {
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
    }
  };

  const handleNewChat = () => {
    clearActiveTurnState();
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
  };

  const inProject = !!projectCwd;
  const busy = isStreaming || attachedStreaming;

  const handleCancel = async () => {
    const turnId = activeTurn?.clientTurnId ?? null;
    if (!sessionId && !turnId) return;
    try {
      await cancelChat({ sessionId, clientTurnId: turnId });
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
    kind: "text" | "image";
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

    if (isImageFile(name)) {
      setPreview({
        absPath: abs,
        relPath: rel,
        kind: "image",
        content: "",
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
        error: `不支持预览：${name} 不是已知的文本或图片文件类型`,
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
    <div className="flex h-full bg-canvas">
      <Sidebar
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onOpenProject={() => setDialogOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        theme={settings.theme}
        onToggleTheme={() =>
          setSettings((s) => ({
            ...s,
            theme: s.theme === "dark" ? "light" : "dark",
          }))
        }
      />
      {sidebarOpen &&
        (inProject ? (
          <ProjectSidebar
            cwd={projectCwd}
            home={home}
            currentSessionId={sessionId}
            onNewChat={handleNewChat}
            onOpenSession={openSession}
          />
        ) : (
          <EmptyProjectSidebar
            onOpenProject={() => setDialogOpen(true)}
          />
        ))}
      <div className="flex flex-col flex-1 min-w-0">
        {inProject ? (
          <>
            <Header
              sessionId={sessionId}
              projectPath={projectCwd}
              home={home}
              onHome={goHome}
              onNewChat={handleNewChat}
              onToggleFiles={() => setFilesOpen((o) => !o)}
              filesOpen={filesOpen}
              onPickProject={openProject}
              onPickSession={openSession}
            />
            <main className="flex-1 relative overflow-hidden">
              <div ref={scrollRef} className="h-full overflow-y-auto">
                <div className="max-w-[820px] mx-auto px-6 pb-4">
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
                <Composer
                  onSend={handleSend}
                  onCancel={handleCancel}
                  disabled={busy}
                  model={settings.model}
                  onModelChange={updateModel}
                  mode={settings.permissionMode}
                  onModeChange={updateMode}
                  effort={settings.effort}
                  onEffortChange={updateEffort}
                  value={composerValue}
                  onChange={setComposerValue}
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
          <HomeView
            onOpenSession={openSession}
            onOpenProject={openProject}
            onClickOpen={() => setDialogOpen(true)}
          />
        )}
      </div>
      {inProject && filesOpen && (
        <FileExplorer
          cwd={projectCwd}
          onInsertFile={insertFile}
          onPreviewFile={previewFile}
        />
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
          onInsert={
            preview.absPath
              ? () => insertFile(preview.absPath, preview.relPath)
              : undefined
          }
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
