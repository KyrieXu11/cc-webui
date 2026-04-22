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
import { streamChat, type ImageAttachment } from "./lib/api";
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
      const raw = localStorage.getItem("cc-webui:lastProject");
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        cwd?: string;
        sessionId?: string | null;
      };
      if (!saved?.cwd) return;
      setProjectCwd(saved.cwd);
      setSidebarOpen(true);
      if (saved.sessionId) {
        setSessionId(saved.sessionId);
        setLoadingSession(true);
        getSessionMessages(saved.sessionId, saved.cwd)
          .then((msgs) => {
            forceScrollBottom.current = true;
            setAllEvents(sessionMessagesToEvents(msgs));
          })
          .catch(() => setAllEvents([]))
          .finally(() => setLoadingSession(false));
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
      setRetryInfo(null);
    }
  };

  const handleNewChat = () => {
    setAllEvents([]);
    setVisibleCount(INITIAL_VISIBLE);
    setSessionId(null);
  };

  const inProject = !!projectCwd;

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
                        isPending={
                          isStreaming &&
                          allEvents[allEvents.length - 1]?.type === "user"
                        }
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
                  disabled={isStreaming}
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
