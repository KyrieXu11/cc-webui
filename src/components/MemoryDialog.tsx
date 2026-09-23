import { useEffect, useMemo, useState } from "react";
import Markdown from "./Markdown";
import {
  MEMORY_LINK_PREFIX,
  getProjectMemory,
  linkifyMemoryRefs,
  orderMemories,
  parseMemoryIndex,
  type ProjectMemory,
} from "../lib/memory";

// 项目记忆（只读）：Claude 在这个项目的对话里记下的东西 —— 左边是索引
// （MEMORY.md 的顺序，不在索引里的补在最后），右边是选中那条的正文。
//
// ⚠️ **只读**（用户 2026-09-23：「注意，不可编辑，只读」）：这里没有任何编辑 / 删除
// 入口，服务端那条路由也只有 GET。别在这里加「顺手改一下」的按钮 —— 这份记忆是
// CLI 自己的存储，改坏了影响的是之后每一轮对话。

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
  const [data, setData] = useState<ProjectMemory | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(INDEX);

  useEffect(() => {
    let alive = true;
    getProjectMemory(cwd)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [cwd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const list = useMemo(
    () => (data ? orderMemories(parseMemoryIndex(data.index ?? ""), data.memories) : []),
    [data],
  );
  const current = list.find((x) => x.memory.file === selected) ?? null;
  const firstOrphan = list.findIndex((x) => !x.indexed);
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
    if (hit) setSelected(hit.memory.file);
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[8vh] p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="项目记忆"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[980px] h-[80vh] flex flex-col bg-surface border border-line-strong rounded-xl overflow-hidden shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85)]"
      >
        <header className="flex items-center gap-2.5 px-5 h-12 border-b border-line shrink-0">
          <h2 className="text-fg text-[14px] font-semibold tracking-tight">项目记忆</h2>
          <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-raised text-subtle border border-line">
            只读
          </span>
          {data && list.length > 0 && (
            <span className="text-[11.5px] text-subtle">共 {list.length} 条</span>
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
            className="shrink-0 p-1.5 rounded-md text-muted hover:text-fg hover:bg-fg/5 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {err ? (
          <div className="p-5 text-[12.5px] text-red">{err}</div>
        ) : !data ? (
          <div className="p-5 text-[12.5px] text-subtle">加载中…</div>
        ) : empty ? (
          <div className="p-6 text-[13px] text-muted leading-relaxed">
            这个项目还没有记忆。
            <div className="text-[12px] text-subtle mt-1.5">
              Claude 在这个项目的对话里记下的偏好、做事方式、背景信息会出现在这里。
            </div>
          </div>
        ) : (
          <div className="flex flex-col md:flex-row flex-1 min-h-0">
            <nav className="md:w-[300px] max-md:max-h-[38%] shrink-0 overflow-y-auto border-b md:border-b-0 md:border-r border-line p-1.5">
              <ListButton active={selected === INDEX} onClick={() => setSelected(INDEX)}>
                <div className="text-[12.5px] text-fg font-medium">索引</div>
                <div className="font-mono text-[10.5px] text-subtle mt-0.5">MEMORY.md</div>
              </ListButton>
              {list.map((x, i) => (
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
                    onClick={() => setSelected(x.memory.file)}
                  >
                    <div className="text-[12.5px] text-fg leading-snug">{x.title}</div>
                    {x.hook && (
                      <div className="text-[11px] text-subtle mt-0.5 leading-snug line-clamp-2">
                        {x.hook}
                      </div>
                    )}
                  </ListButton>
                </div>
              ))}
            </nav>

            <article
              className="flex-1 min-w-0 overflow-y-auto px-6 py-5"
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
                    <Markdown text={linkifyMemoryRefs(current.memory.body)} />
                  </div>
                  {current.memory.truncated && (
                    <div className="mt-3 text-[11.5px] text-orange">这条太长，只显示了前 256 KB。</div>
                  )}
                </>
              ) : data.index ? (
                <div className="text-[13.5px]">
                  <Markdown text={data.index} />
                </div>
              ) : (
                <div className="text-[12.5px] text-subtle">
                  这个项目没有 MEMORY.md 索引，左边列的是目录里全部的记忆文件。
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
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2.5 py-2 rounded-md transition-colors ${
        active ? "bg-fg/[0.07]" : "hover:bg-fg/[0.04]"
      }`}
    >
      {children}
    </button>
  );
}
