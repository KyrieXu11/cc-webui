import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";
import Highlighted from "./Highlighted";
import LiquidSelection from "./LiquidSelection";
import {
  MEMORY_LINK_PREFIX,
  getProjectMemory,
  filterMemories,
  memorySearchSnippet,
  mergeMemoryPage,
  linkifyMemoryRefs,
  orderMemories,
  parseMemoryIndex,
  type ProjectMemory,
} from "../lib/memory";

// 唯一日常入口：项目内共用记忆，访问由当前账号的目录白名单决定。

interface Props {
  cwd: string;
  onClose: () => void;
}

const INDEX = "__index__";

// frontmatter 里 metadata.type 的四种（和 CLI 写记忆时的分类一致）。
const TYPE_LABEL: Record<string, string> = {
  user: "关于用户",
  feedback: "做事方式",
  project: "项目情况",
  reference: "参考资料",
};

function formatModified(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MemoryDialog({ cwd, onClose }: Props) {
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState("");
  const [data, setData] = useState<ProjectMemory | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(INDEX);
  const [query, setQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const pageLoading = useRef(false);
  const navigationRail = useRef<HTMLDivElement>(null);

  const requestVersion = useRef(0);
  useEffect(() => { setSelected(INDEX); setQuery(""); }, [cwd]);
  useEffect(() => {
    const version = ++requestVersion.current;
    let alive = true;
    setData(null); setErr(null); setNotice(""); setLoadingMore(false); pageLoading.current = false;
    getProjectMemory(cwd)
      .then((d) => { if (alive && version === requestVersion.current) { setData(d); setSelected(prev => prev === INDEX || d.memories.some(m => m.file === prev) ? prev : INDEX); } })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      requestVersion.current++;
    };
  }, [cwd, refresh]);

  useEffect(() => {
    const reload = () => setRefresh(n => n + 1);
    window.addEventListener("cc-webui:memory-updated", reload);
    return () => window.removeEventListener("cc-webui:memory-updated", reload);
  }, []);

  const loadMore = async () => {
    if (!data || data.nextCursor == null || pageLoading.current) return;
    const version = requestVersion.current;
    const cursor = data.nextCursor;
    pageLoading.current = true;
    setLoadingMore(true);
    try {
      const next = await getProjectMemory(cwd, cursor);
      if (version !== requestVersion.current) return;
      setData(prev => prev?.nextCursor === cursor ? mergeMemoryPage(prev, next) : prev);
    } catch (e) {
      if (version === requestVersion.current) setNotice((e as Error).message);
    } finally {
      if (version === requestVersion.current) { pageLoading.current = false; setLoadingMore(false); }
    }
  };

  const searching = !!query.trim();
  // Search the entire project, not just the first 100 entries. Fetch remaining
  // read-only pages only while searching, with one request at a time. A failure
  // stops the loop until the user retries; stale project/refresh responses lose.
  useEffect(() => {
    if (searching && data?.nextCursor != null && !loadingMore && !notice) void loadMore();
  }, [searching, data?.nextCursor, loadingMore, notice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        if (query) { setQuery(""); setSelected(INDEX); e.preventDefault(); }
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  const list = useMemo(
    () => (data ? orderMemories(parseMemoryIndex(data.index ?? ""), data.memories) : []),
    [data],
  );
  const current = list.find((x) => x.memory.file === selected) ?? null;
  const visibleList = useMemo(() => filterMemories(list, query), [list, query]);
  const firstOrphan = visibleList.findIndex((x) => !x.indexed);
  const empty = data !== null && !data.index && list.length === 0;

  // 正文里的 [[其它记忆]]、索引里的 [标题](文件.md) 都是站内跳转，不是新标签页。
  // Markdown 给所有链接都加了 target=_blank，所以在**捕获阶段**接住点击。
  const onContentClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    let hit: (typeof list)[number] | undefined;
    if (href.startsWith(MEMORY_LINK_PREFIX)) {
      const name = decodeURIComponent(href.slice(MEMORY_LINK_PREFIX.length));
      hit = list.find((x) => x.memory.name === name || x.memory.file === `${name}.md`);
    } else if (href && !href.includes("/") && href.endsWith(".md")) {
      hit = list.find((x) => x.memory.file === href);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (hit) { setSelected(hit.memory.file); setQuery(""); }
  };

  return (
    <div
      className="memory-dialog-scrim fixed inset-0 z-[100] flex items-start justify-center pt-[8vh] p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="项目记忆"
        onClick={(e) => e.stopPropagation()}
        className="memory-dialog w-full max-w-[980px] h-[80vh] flex flex-col soft-dialog overflow-hidden"
      >
        <header className="memory-titlebar flex items-center gap-2.5 shrink-0">
          <h2 className="text-fg text-[14px] font-semibold tracking-tight">项目记忆</h2>
          <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-raised text-subtle border border-line">
            只读
          </span>
          {data && list.length > 0 && (
            <span className="text-[11.5px] text-subtle">共 {data.total ?? list.length} 条</span>
          )}
          <span
            className="font-mono text-[11px] text-subtle truncate min-w-0 flex-1"
            title={data?.dir ?? cwd}
          >
            {cwd}
          </span>
          <button
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
            className="memory-close shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="memory-toolbar flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">项目内共用 · Claude / Codex</span>
          {data && <span className="text-[11px] text-subtle">{data.enabled ? "已启用" : "运行时未启用"}</span>}
          <div className="memory-search soft-input flex items-center gap-2 px-3 h-9 min-w-0 flex-[1_1_260px] md:max-w-[360px] md:ml-auto">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0 text-muted"><circle cx="7" cy="7" r="4.5" stroke="currentColor" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeLinecap="round" /></svg>
            <input aria-label="搜索项目记忆" placeholder="搜索名称、描述和正文…" value={query} maxLength={200}
              onChange={e => { setQuery(e.target.value); setSelected(INDEX); }}
              onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing && searching && visibleList[0]) setSelected(visibleList[0].memory.file); }}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-muted" />
            {query && <button aria-label="清空记忆搜索" title="清空（Esc）" onClick={() => { setQuery(""); setSelected(INDEX); }} className="shrink-0 w-7 h-7 rounded-full text-muted hover:bg-fg/5">×</button>}
          </div>
          {searching && data && <span role="status" className="text-[11px] text-muted">{visibleList.length} 条匹配{data.nextCursor != null ? notice ? " · 未完成" : " · 检索中…" : ""}</span>}
          {data?.nextCursor != null && !searching && <button disabled={loadingMore} onClick={() => void loadMore()} className="text-[12px] text-blue disabled:text-muted">{loadingMore ? "加载中…" : "加载更多"}</button>}
        </div>
        {notice && <div className="px-4 py-2 text-[12px] text-muted border-b border-line">{notice} <button className="text-blue ml-2" onClick={() => { setNotice(""); if (!searching) void loadMore(); }}>重试加载</button></div>}
        {err ? (
          <div className="p-5 text-[12.5px] text-red">{err}</div>
        ) : !data ? (
          <div className="p-5 text-[12.5px] text-subtle">加载中…</div>
        ) : empty ? (
          <div className="p-6 text-[13px] text-muted leading-relaxed">
            这个项目还没有记忆。
            <div className="text-[12px] text-subtle mt-1.5">
              在对话中让 AI 记住长期偏好或背景；Claude 和 Codex 都会使用这份项目记忆。
            </div>
          </div>
        ) : (
          <div className="memory-layout flex flex-col md:flex-row flex-1 min-h-0">
            <nav className="memory-navigation md:w-[280px] max-md:max-h-[38%] shrink-0 overflow-x-hidden overflow-y-auto p-1">
              <div ref={navigationRail} className="memory-navigation-rail">
              <LiquidSelection container={navigationRail} activeKey={selected} layoutKey={`${query}:${visibleList.length}`} />
              <ListButton active={selected === INDEX} liquidKey={INDEX} onClick={() => setSelected(INDEX)}>
                <div className="text-[12.5px] text-fg font-medium">{searching ? "搜索结果" : "索引"}</div>
                <div className="font-mono text-[10.5px] text-subtle mt-0.5">{searching ? "名称 · 描述 · 正文" : "服务端生成索引"}</div>
              </ListButton>
              {visibleList.map((x, i) => (
                <div key={x.memory.file}>
                  {i === firstOrphan && (
                    <div
                      className="mx-2 mt-2 mb-1 pt-2 border-t border-line text-[10.5px] text-subtle"
                      title="有记忆文件，但索引里没有它这一行"
                    >
                      不在索引里
                    </div>
                  )}
                  <ListButton
                    active={selected === x.memory.file}
                    liquidKey={x.memory.file}
                    onClick={() => setSelected(x.memory.file)}
                  >
                    <div className="text-[12.5px] text-fg leading-snug"><Highlighted text={x.title} query={query} /></div>
                    {memorySearchSnippet(x, query) && (
                      <div className="text-[11px] text-subtle mt-0.5 leading-snug line-clamp-2">
                        <Highlighted text={memorySearchSnippet(x, query)} query={query} />
                      </div>
                    )}
                  </ListButton>
                </div>
              ))}
              </div>
            </nav>

            <article
              className="memory-reading-surface flex-1 min-w-0 overflow-y-auto px-6 py-5 rounded-panel"
              onClickCapture={onContentClick}
            >
              {current ? (
                <>
                  <h3 className="text-fg text-[15px] font-semibold leading-snug">{current.title}</h3>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] text-subtle">
                    {current.memory.type && (
                      <span className="px-1.5 py-0.5 rounded bg-raised border border-line">
                        {TYPE_LABEL[current.memory.type] ?? current.memory.type}
                      </span>
                    )}
                    {formatModified(current.memory.modified) && (
                      <span>更新于 {formatModified(current.memory.modified)}</span>
                    )}
                    <span className="font-mono">{current.memory.file}</span>
                  </div>
                  {current.memory.description && (
                    <p className="text-[12.5px] text-muted mt-3 leading-relaxed">
                      {current.memory.description}
                    </p>
                  )}
                  <div className="mt-4 text-[13.5px]">
                    <Markdown text={linkifyMemoryRefs(current.memory.body)} memoryCompat />
                  </div>
                  {current.memory.truncated && (
                    <div className="mt-3 text-[11.5px] text-orange">这条太长，只显示了前 256 KB。</div>
                  )}
                </>
              ) : searching ? (
                <div>
                  <h3 className="text-[15px] font-semibold text-fg">搜索结果</h3>
                  <p className="mt-2 text-[12px] text-muted">{visibleList.length ? `找到 ${visibleList.length} 条相关记忆，点击左侧条目查看。` : notice ? "搜索尚未完成，请重试加载。" : data.nextCursor != null ? "正在检索其余记忆…" : "未找到相关记忆，试试其他关键词。"}</p>
                  {visibleList.map(x => <button key={x.memory.file} onClick={() => setSelected(x.memory.file)} className="block w-full text-left py-3 border-b border-line hover:bg-raised rounded-control px-3 mt-2">
                    <div className="text-[13px] font-medium text-fg"><Highlighted text={x.title} query={query} /></div>
                    <div className="mt-1 text-[12px] text-muted line-clamp-3"><Highlighted text={memorySearchSnippet(x, query)} query={query} /></div>
                  </button>)}
                </div>
              ) : data.index ? (
                <div className="text-[13.5px]">
                  <Markdown text={data.index} memoryCompat />
                </div>
              ) : (
                <div className="text-[12.5px] text-subtle">
                  暂时没有可显示的记忆索引。
                </div>
              )}
            </article>
          </div>
        )}
      </div>
    </div>
  );
}

function ListButton({
  active,
  onClick,
  liquidKey,
  children,
}: {
  active: boolean;
  onClick: () => void;
  liquidKey: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      data-liquid-key={liquidKey}
      className="memory-item w-full text-left px-3 py-2.5 transition-colors"
    >
      {children}
    </button>
  );
}
