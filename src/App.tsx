import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import ProjectSidebar from "./components/ProjectSidebar";
import EmptyProjectSidebar from "./components/EmptyProjectSidebar";
import FileExplorer from "./components/FileExplorer";
import Header from "./components/Header";
import Composer from "./components/Composer";
import MessageList from "./components/MessageList";
import HomeView from "./components/HomeView";
import OpenProjectDialog from "./components/OpenProjectDialog";
import type { ChatEvent } from "./lib/types";
import { streamChat, type ImageAttachment } from "./lib/api";
import { applySDKMessage, sessionMessagesToEvents } from "./lib/processor";
import {
  loadSettings,
  saveSettings,
  type PermissionMode,
  type Settings,
} from "./lib/settings";
import { addRecent, getHome } from "./lib/fs";
import { getSessionMessages, type SessionSummary } from "./lib/sessions";
import { sendPermission } from "./lib/permission";

const INITIAL_VISIBLE = 200;
const LOAD_MORE_STEP = 200;

export default function App() {
  const [allEvents, setAllEvents] = useState<ChatEvent[]>([]);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [projectCwd, setProjectCwd] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [home, setHome] = useState("");
  const [loadingSession, setLoadingSession] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [filesOpen, setFilesOpen] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const prevScrollHeight = useRef<number | null>(null);
  const forceScrollBottom = useRef(false);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    getHome().then(setHome).catch(() => {});
  }, []);

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
    decision: "allow" | "deny",
    message?: string
  ) => {
    setAllEvents((prev) =>
      prev.map((e) =>
        e.type === "permission" && e.permissionId === permissionId
          ? { ...e, resolved: decision }
          : e
      )
    );
    try {
      await sendPermission(permissionId, decision, message);
    } catch (err) {
      console.error("permission resolve failed:", err);
    }
  };

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allEvents]);

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
    const userEvt: ChatEvent = {
      id: `u-${Date.now()}`,
      type: "user",
      text:
        text ||
        (images && images.length > 0
          ? `[${images.length} 张图片]`
          : ""),
    };
    setAllEvents((prev) => [...prev, userEvt]);
    setVisibleCount((c) => Math.max(c, INITIAL_VISIBLE));
    setIsStreaming(true);

    try {
      for await (const msg of streamChat({
        prompt: text,
        sessionId,
        cwd: projectCwd,
        model: settings.model,
        permissionMode: settings.permissionMode,
        effort: settings.effort,
        images,
      })) {
        setAllEvents((prev) =>
          applySDKMessage(prev, msg, (id) => setSessionId(id))
        );
      }
    } catch (err) {
      console.error("stream error:", err);
      const message = err instanceof Error ? err.message : String(err);
      setAllEvents((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          type: "assistant",
          text: `[错误] ${message}`,
        },
      ]);
    } finally {
      setIsStreaming(false);
    }
  };

  const handleNewChat = () => {
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
  };

  const inProject = !!projectCwd;

  const pickFile = (_abs: string, rel: string) => {
    const token = `@${rel}`;
    setComposerValue((v) => {
      const trimmed = v.trimEnd();
      if (!trimmed) return token + " ";
      if (trimmed.endsWith(token)) return v;
      return `${trimmed} ${token} `;
    });
  };

  return (
    <div className="flex h-full bg-canvas">
      <Sidebar
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onOpenProject={() => setDialogOpen(true)}
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
                        isPending={
                          isStreaming &&
                          allEvents[allEvents.length - 1]?.type === "user"
                        }
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
                  disabled={isStreaming}
                  model={settings.model}
                  onModelChange={updateModel}
                  mode={settings.permissionMode}
                  onModeChange={updateMode}
                  effort={settings.effort}
                  onEffortChange={updateEffort}
                  value={composerValue}
                  onChange={setComposerValue}
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
        <FileExplorer cwd={projectCwd} onPickFile={pickFile} />
      )}
      {dialogOpen && (
        <OpenProjectDialog
          onClose={() => setDialogOpen(false)}
          onOpen={openProject}
        />
      )}
    </div>
  );
}
