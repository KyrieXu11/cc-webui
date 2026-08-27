import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { listTree, type TreeEntry } from "../lib/fs";
import { deleteFiles, uploadToDir } from "../lib/files";
import { openInDock } from "../lib/dock-bridge";

// 项目文件面板：目录树 + 对这些文件的操作（打开/编辑、多选删除、上传、@插入）。
//
// **这是唯一的文件面板。**（2026-08-27 二次返工：先把「本对话文件」列表塞进左侧栏——
// 按钮在右上角、开出来的东西在左边；挪到右侧格后又变成「项目 / 本对话」两个都叫文件的
// 标签。用户原话是「我要的只是项目文件，然后要有对项目文件做操作的这些模块」，所以操作
// 直接挂在树上，不再按会话分出第二个列表。`docs/file-manager.md` 决策 2/4 已改。）
//
// 操作与树的关系：
//   · 点文件名   → 在右侧格里打开（文本进编辑器、md 可渲染、Office 走 ONLYOFFICE）
//   · 右键文件   → 进多选模式（勾选框这时才出现，并顺手选中这一行；再右键别的行继续加选）
//                  → 批量删除（**真删、无回收站**，所以确认弹窗逐个列出文件名——批量
//                  删除最容易出的事故是多选里混进了一个你没看见的）
//                  ⚠️ 勾选框**平时不画**：常驻的话一棵目录树看着像一排表单（用户原话
//                  「多选框应该去掉，应该做一个右键点击多选之后，才出现动态加载多选框」）。
//                  退出：取消按钮 / Esc / 取消到一个不剩时自动退出。
//   · 悬停的 @   → 把相对路径插进对话框（原来的「单击插入」，给 agent 指路用）
//   · 点文件夹   → 除了展开/收起，还把它设成**上传落点**（标题栏那颗「上传」的目标）
//
// 刷新是整棵树重挂（`key={seq}`）：每个 DirRow 各自懒加载 children，逐个 refetch 既要
// 跨组件通信又容易漏掉没展开的那些，重挂一次干净，而这棵树本来就是懒的。

interface Props {
  cwd: string;
  onInsertFile: (absPath: string, relPath: string) => void;
  /** ⌘/Ctrl+单击的速览（浮窗），不占右侧格的标签。 */
  onPreviewFile: (absPath: string, relPath: string) => void;
  /** 当前会话 id —— 只用于删除留痕（file_deletions），没有也能删。 */
  sessionId?: string | null;
  /** 内嵌在右侧格里时用：不自带宽度/左边框，由那一格给。 */
  embedded?: boolean;
  /** 有值就在标题栏右端画一颗「收起面板」——内嵌时它是这一格唯一常驻的表头。 */
  onClose?: () => void;
}

type Ctx = {
  selecting: boolean;
  picked: Map<string, string>;
  toggle: (path: string, name: string) => void;
  /** 右键：进多选模式并顺手选中这一行。 */
  beginSelect: (path: string, name: string) => void;
  insert: (abs: string) => void;
  preview: (abs: string) => void;
  uploadDir: string;
  setUploadDir: (d: string) => void;
};

const TreeCtx = createContext<Ctx | null>(null);
const useTree = () => {
  const c = useContext(TreeCtx);
  if (!c) throw new Error("TreeCtx missing");
  return c;
};

export default function FileExplorer({
  cwd,
  onInsertFile,
  onPreviewFile,
  sessionId,
  embedded,
  onClose,
}: Props) {
  const [rootEntries, setRootEntries] = useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [seq, setSeq] = useState(0);
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map());
  const [uploadDir, setUploadDir] = useState(cwd);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Esc 退出多选。绑在 window 上：焦点可能在树里的任何一个按钮上。
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSelecting(false);
      setPicked(new Map());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  useEffect(() => {
    setUploadDir(cwd);
    setPicked(new Map());
    setSelecting(false);
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRootEntries(null);
    listTree(cwd)
      .then((xs) => !cancelled && setRootEntries(xs))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [cwd, seq]);

  const refresh = useCallback(() => setSeq((n) => n + 1), []);

  const toRel = (abs: string) =>
    abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;

  const insert = (abs: string) => onInsertFile(abs, toRel(abs));
  const preview = (abs: string) => onPreviewFile(abs, toRel(abs));

  const toggle = (path: string, name: string) =>
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(path)) next.delete(path);
      else next.set(path, name);
      // 取消到一个不剩就退出多选：留着一排空勾选框没有意义。
      if (next.size === 0) setSelecting(false);
      return next;
    });

  const ctx: Ctx = {
    selecting,
    picked,
    toggle,
    beginSelect: (path, name) => {
      setSelecting(true);
      toggle(path, name);
    },
    insert,
    preview,
    uploadDir,
    setUploadDir,
  };

  const doDelete = async () => {
    setBusy("删除中…");
    try {
      const r = await deleteFiles([...picked.keys()], sessionId ?? null);
      setErr(
        r.failed.length
          ? `${r.failed.length} 个没删掉：` +
              r.failed.map((f) => `${f.path}（${f.error}）`).join("；")
          : null
      );
      setPicked(new Map());
      setConfirming(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(null);
    }
  };

  const doUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy("上传中…");
    try {
      await uploadToDir(uploadDir, list);
      setErr(null);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <aside
      className={
        embedded
          ? "h-full min-h-0 flex flex-col bg-canvas"
          : "w-[280px] shrink-0 border-l border-line flex flex-col bg-canvas"
      }
    >
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line shrink-0">
        <span
          className="font-mono text-[11px] text-subtle flex-1 truncate"
          title={`上传落点：${uploadDir}`}
        >
          {busy ??
            (loading
              ? "读取中…"
              : uploadDir === cwd
                ? "根目录"
                : toRel(uploadDir))}
        </span>
        {selecting ? (
          <>
            <button
              onClick={() => {
                setSelecting(false);
                setPicked(new Map());
              }}
              className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
              title="退出多选（Esc）"
            >
              取消
            </button>
            <button
              disabled={picked.size === 0}
              onClick={() => {
                for (const p of picked.keys()) insert(p);
                setSelecting(false);
                setPicked(new Map());
              }}
              className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
              title="把选中的相对路径插进对话框"
            >
              @ {picked.size}
            </button>
            <button
              disabled={picked.size === 0}
              onClick={() => setConfirming(true)}
              className="font-mono text-[11px] text-red border border-red/40 hover:border-red/70 rounded px-2 py-0.5 transition-colors disabled:opacity-40"
            >
              删除 {picked.size}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => fileInput.current?.click()}
              className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
              title={`上传到 ${uploadDir}（点某个文件夹可换落点）`}
            >
              上传
            </button>
            <button
              onClick={refresh}
              className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
              title="重新读取目录"
            >
              刷新
            </button>
          </>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void doUpload(e.target.files)}
        />
        {onClose && (
          <button
            onClick={onClose}
            className="shrink-0 text-subtle hover:text-fg px-1 py-1 rounded hover:bg-fg/5"
            title="收起面板"
            aria-label="收起面板"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path
                d="M2 2L9 9M9 2L2 9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      {err && (
        <div className="px-3 py-2 text-[11.5px] text-red border-b border-line break-words shrink-0">
          {err}
        </div>
      )}

      <TreeCtx.Provider value={ctx}>
        <div key={seq} className="flex-1 overflow-y-auto py-1.5 pr-1">
          {loading ? (
            <div className="px-4 py-3 text-[12px] text-subtle">加载中…</div>
          ) : !rootEntries || rootEntries.length === 0 ? (
            <div className="px-4 py-3 text-[12px] text-subtle">空目录</div>
          ) : (
            rootEntries.map((e) => <Row key={e.path} entry={e} depth={0} />)
          )}
        </div>
      </TreeCtx.Provider>

      {confirming && (
        <div className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center p-6">
          <div className="bg-canvas border border-line rounded-lg shadow-2xl max-w-[440px] w-full p-4 space-y-3">
            <div className="text-[14px] text-fg font-semibold">
              删除 {picked.size} 个文件？
            </div>
            <div className="text-[12.5px] text-orange leading-relaxed">
              直接删掉，<span className="font-semibold">没有回收站</span>
              ，也没有版本可以回退。
            </div>
            {/* 逐个列出来：批量删除最容易出的事故是多选里混进了没看见的那一个。 */}
            <div className="max-h-[180px] overflow-y-auto bg-surface border border-line rounded p-2 space-y-0.5">
              {[...picked.entries()].map(([path, name]) => (
                <div
                  key={path}
                  className="font-mono text-[11.5px] text-muted truncate"
                  title={path}
                >
                  {name}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setConfirming(false)}
                className="text-[12.5px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-3 py-1 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => void doDelete()}
                disabled={busy !== null}
                className="text-[12.5px] text-red border border-red/50 hover:border-red rounded px-3 py-1 transition-colors disabled:opacity-40"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function Row({ entry, depth }: { entry: TreeEntry; depth: number }) {
  return entry.type === "dir" ? (
    <DirRow entry={entry} depth={depth} />
  ) : (
    <FileRow entry={entry} depth={depth} />
  );
}

function DirRow({ entry, depth }: { entry: TreeEntry; depth: number }) {
  const { uploadDir, setUploadDir } = useTree();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const isTarget = uploadDir === entry.path;

  const toggle = async () => {
    // 点文件夹同时把它设成上传落点：这是「上传到本文件夹」唯一需要的手势。
    setUploadDir(entry.path);
    if (!open && !children) {
      setLoading(true);
      try {
        setChildren(await listTree(entry.path));
      } finally {
        setLoading(false);
      }
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        onClick={toggle}
        className={`w-full flex items-center gap-1.5 py-1 pr-2 text-left transition-colors rounded-sm ${
          isTarget
            ? "text-fg bg-blue/10"
            : "text-muted hover:text-fg hover:bg-fg/[0.025]"
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={`${entry.path}\n（点一下：展开 / 设为上传落点）`}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Chevron open={open} />
        <FolderIcon />
        <span className="font-mono text-[12px] truncate">{entry.name}</span>
      </button>
      {open && loading && (
        <div
          className="text-[11px] text-subtle font-mono py-0.5"
          style={{ paddingLeft: 8 + (depth + 1) * 12 + 20 }}
        >
          …
        </div>
      )}
      {open &&
        children?.map((c) => <Row key={c.path} entry={c} depth={depth + 1} />)}
    </>
  );
}

function FileRow({ entry, depth }: { entry: TreeEntry; depth: number }) {
  const { selecting, picked, toggle, beginSelect, insert, preview } = useTree();
  const checked = picked.has(entry.path);

  return (
    <div
      className={`group w-full flex items-center gap-1.5 py-1 pr-1.5 rounded-sm transition-colors ${
        checked ? "bg-blue/10" : "hover:bg-fg/[0.025]"
      }`}
      style={{ paddingLeft: 8 + depth * 12 }}
      // 右键＝进多选并选中这一行；已在多选态里再右键就是加选/取消。
      onContextMenu={(e) => {
        e.preventDefault();
        beginSelect(entry.path, entry.name);
      }}
    >
      {/* ⚠️ 勾选框只在多选态里存在，平时连位置都不占：常驻的话一棵目录树看着像一排表单。 */}
      {selecting && (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(entry.path, entry.name)}
          aria-label={`选择 ${entry.name}`}
          className="shrink-0 accent-blue"
        />
      )}
      <button
        onClick={(e) =>
          e.metaKey || e.ctrlKey
            ? preview(entry.path)
            : openInDock({ path: entry.path, name: entry.name })
        }
        className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-muted hover:text-fg transition-colors"
        title={`${entry.path}\n（单击：在右侧打开 · ⌘/Ctrl+单击：浮窗速览 · 右键：多选）`}
      >
        <FileIcon />
        <span className="font-mono text-[12px] truncate">{entry.name}</span>
      </button>
      <button
        onClick={() => insert(entry.path)}
        className="shrink-0 font-mono text-[11px] text-subtle hover:text-fg px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
        title="把相对路径插进对话框"
        aria-label={`插入 ${entry.name} 的路径`}
      >
        @
      </button>
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 9 9"
    fill="none"
    className={`shrink-0 text-subtle transition-transform ${
      open ? "rotate-90" : ""
    }`}
  >
    <path
      d="M3 2L6 4.5L3 7"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const FolderIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0 text-subtle"
  >
    <path
      d="M1.5 4V11C1.5 11.55 1.95 12 2.5 12H11.5C12.05 12 12.5 11.55 12.5 11V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 3H2.5C1.95 3 1.5 3.45 1.5 4Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

const FileIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0 text-subtle"
  >
    <path
      d="M8 1.5H3.5C3 1.5 2.5 2 2.5 2.5V11.5C2.5 12 3 12.5 3.5 12.5H10.5C11 12.5 11.5 12 11.5 11.5V5L8 1.5Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path
      d="M8 1.5V5H11.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);
