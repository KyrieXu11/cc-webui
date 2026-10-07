import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { listTree, type TreeEntry } from "../lib/fs";
import {
  createFolder,
  deleteFiles,
  downloadFiles,
  moveFiles,
  renameEntry as renameEntryApi,
  uploadToDir,
} from "../lib/files";
import { openInDock } from "../lib/dock-bridge";
import {
  hasDraggedFiles,
  readDraggedFiles,
  writeDraggedFiles,
  type DraggedFile,
} from "../lib/file-drag";

// 项目文件面板：目录树 + 对这些文件的操作（打开/编辑、重命名、多选下载/删除、
// 上传、新建文件夹、拖拽移动）。
//
// 「把路径插进对话框」以前是每行一颗 @ 按钮 + 多选里的「@ N」，**已经删掉**：
// 直接把文件拖到对话框里就是同一件事，而且不用先想起来有这颗按钮。
//
// **这是唯一的文件面板。**（2026-08-27 二次返工：先把「本对话文件」列表塞进左侧栏——
// 按钮在右上角、开出来的东西在左边；挪到右侧格后又变成「项目 / 本对话」两个都叫文件的
// 标签。用户原话是「我要的只是项目文件，然后要有对项目文件做操作的这些模块」，所以操作
// 直接挂在树上，不再按会话分出第二个列表。`docs/file-manager.md` 决策 2/4 已改。）
//
// 操作与树的关系：
//   · 点文件名   → 在右侧格里打开（文本进编辑器、md 可渲染、Office 走 ONLYOFFICE）
//   · 右键文件 / 文件夹 → 进多选模式（勾选框这时才出现，并顺手选中这一行；再右键别的行继续加选）
//                  文件夹只能**删空的**（服务端 rmdir，不递归；非空的原样留下并说明原因），
//                  不能下载（选中里有文件夹时「下载」直接灰掉）
//                  → 批量删除（**真删、无回收站**，所以确认弹窗逐个列出文件名——批量
//                  删除最容易出的事故是多选里混进了一个你没看见的）
//                  → 下载（选一个就是那个文件本身，选多个由服务端打成一个 zip；
//                  **不是**连着触发 N 次下载，理由见 lib/files.ts 的 downloadFiles）
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
  /** ⌘/Ctrl+单击的速览（浮窗），不占右侧格的标签。 */
  onPreviewFile: (absPath: string, relPath: string) => void;
  /** 当前会话 id —— 只用于删除留痕（file_deletions），没有也能删。 */
  sessionId?: string | null;
  /** 内嵌在右侧格里时用：不自带宽度/左边框，由那一格给。 */
  embedded?: boolean;
  /**
   * 右端留出 52px 给窗口右上角那颗浮动的「文件面板」开关。
   * 只有当这一栏就是右侧格最上面那条（＝没有文档打开、树占满整格）时才需要。
   */
  reserveRight?: boolean;
}

// 多选里的一项。`dir` 决定它能做什么：删 = 只删空的（服务端 rmdir），
// 下载 = 不行（/download 只收文件），拖 = 可以（/move 本来就收文件夹）。
type Picked = { name: string; dir: boolean };

type Ctx = {
  selecting: boolean;
  picked: Map<string, Picked>;
  toggle: (path: string, name: string, dir?: boolean) => void;
  /** 右键：进多选模式并顺手选中这一行。 */
  beginSelect: (path: string, name: string, dir?: boolean) => void;
  preview: (abs: string) => void;
  uploadDir: string;
  setUploadDir: (d: string) => void;
  /** 开始拖：拖的是「这一行」还是「整批选中的」由这里决定。 */
  startDrag: (e: React.DragEvent, path: string, name: string) => void;
  /** 放进某个文件夹＝移动到那儿。 */
  dropInto: (dir: string, files: DraggedFile[]) => void;
  /** 让树的根落点熄灯。⚠️ 见 DirRow 的 onDragOver：光靠 dragleave 灭不掉。 */
  setRootOver: (v: boolean) => void;
  /** 原地改名。返回错误文案，null＝成功（行自己负责关掉输入框）。 */
  renameEntry: (path: string, name: string) => Promise<string | null>;
};

const TreeCtx = createContext<Ctx | null>(null);
const useTree = () => {
  const c = useContext(TreeCtx);
  if (!c) throw new Error("TreeCtx missing");
  return c;
};

export default function FileExplorer({
  cwd,
  onPreviewFile,
  sessionId,
  embedded,
  reserveRight,
}: Props) {
  const [rootEntries, setRootEntries] = useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [seq, setSeq] = useState(0);
  const [picked, setPicked] = useState<Map<string, Picked>>(() => new Map());
  const [uploadDir, setUploadDir] = useState(cwd);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [selecting, setSelecting] = useState(false);
  // null = 没在新建；"" = 输入框开着但还没敲字。落点就是 uploadDir（点文件夹能换）。
  const [newFolder, setNewFolder] = useState<string | null>(null);
  // 拖到树的空白处＝移回根目录时的高亮。
  const [rootOver, setRootOver] = useState(false);
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

  const preview = (abs: string) => onPreviewFile(abs, toRel(abs));
  const pickedHasDir = [...picked.values()].some((v) => v.dir);

  const toggle = (path: string, name: string, dir = false) =>
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(path)) next.delete(path);
      else next.set(path, { name, dir });
      // 取消到一个不剩就退出多选：留着一排空勾选框没有意义。
      if (next.size === 0) setSelecting(false);
      return next;
    });

  // 拖一行：如果它在当前多选里，就拖整批（文件管理器的通例）；否则只拖它自己。
  const startDrag = (e: React.DragEvent, path: string, name: string) => {
    const batch: DraggedFile[] =
      picked.has(path) && picked.size > 0
        ? [...picked.entries()].map(([p, v]) => ({ path: p, name: v.name, rel: toRel(p) }))
        : [{ path, name, rel: toRel(path) }];
    dragging = batch;
    writeDraggedFiles(e.dataTransfer, batch);
  };

  const dropInto = (dir: string, files: DraggedFile[]) => {
    // 只搬「搬过去有意义」的那些：整批里混进一两个本来就在目标目录的，
    // 不该让整个动作变成一屏红字。
    const paths = files
      .filter(
        (f) =>
          parentOf(f.path) !== dir &&
          dir !== f.path &&
          !dir.startsWith(f.path + "/")
      )
      .map((f) => f.path);
    if (paths.length === 0) return;
    void (async () => {
      setBusy("移动中…");
      const r = await moveFiles(paths, dir);
      setBusy(null);
      setErr(
        r.failed.length
          ? `${r.failed.length} 个没移动：` +
              r.failed
                .map((f) => `${f.path.split("/").pop()}（${f.error}）`)
                .join("；")
          : null
      );
      if (r.moved.length > 0) {
        setPicked(new Map());
        setSelecting(false);
        refresh();
      }
    })();
  };

  const renameEntry = async (target: string, name: string) => {
    setBusy("重命名中…");
    const r = await renameEntryApi(target, name);
    setBusy(null);
    if (!r.ok) {
      setErr(r.message);
      return r.message;
    }
    setErr(null);
    // 选中集合里那一条的路径已经不存在了。留着它，下一次批量删除/下载就会对着
    // 一个不存在的路径报错，而用户完全不知道是哪来的。
    setPicked((cur) => {
      if (!cur.has(target)) return cur;
      const next = new Map(cur);
      next.delete(target);
      if (next.size === 0) setSelecting(false);
      return next;
    });
    refresh();
    return null;
  };

  const ctx: Ctx = {
    selecting,
    picked,
    toggle,
    beginSelect: (path, name, dir) => {
      setSelecting(true);
      toggle(path, name, dir);
    },
    preview,
    uploadDir,
    setUploadDir,
    startDrag,
    dropInto,
    setRootOver,
    renameEntry,
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
      // 和 toggle 里「取消到一个不剩就退出多选」同一条规则：选中的已经清空了，
      // 留着一排空勾选框和「下载 0 / 删除 0」没有意义。
      setSelecting(false);
      setConfirming(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(null);
    }
  };

  const doMkdir = async () => {
    const name = (newFolder ?? "").trim();
    if (!name) return;
    setBusy("新建中…");
    const r = await createFolder(uploadDir, name);
    setBusy(null);
    if (!r.ok) {
      // 名字不合法 / 重名 / 不在白名单里——理由是服务端给的，原样显示。
      // 输入框**不关**：用户要改的就是刚敲的那个名字，关掉等于让他重打一遍。
      setErr(r.message);
      return;
    }
    setErr(null);
    setNewFolder(null);
    refresh();
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

  // 多选时表头左边不显示上传落点：那会儿它没有意义，而 280px（拖窄到 180px）的
  // 表头要放下四颗按钮。
  let headerLabel = "";
  if (busy) headerLabel = busy;
  else if (loading) headerLabel = "读取中…";
  else if (!selecting) headerLabel = uploadDir === cwd ? "根目录" : toRel(uploadDir);

  return (
    <aside
      className={
        embedded
          ? "h-full min-h-0 flex flex-col bg-surface"
          : "w-[280px] shrink-0 border-l border-line flex flex-col bg-surface"
      }
    >
      {/* ⚠️ h-14 是**和主栏顶栏同一个高度**：不等高的话两条下边框错开一截，
          看着就是「对不齐」（用户 2026-08-27 反馈）。 */}
      <div
        className={`flex items-center gap-1.5 h-14 pl-3 border-b border-line shrink-0 ${
          reserveRight ? "pr-[52px]" : "pr-3"
        }`}
      >
        <span
          className="font-mono text-[11px] text-subtle flex-1 truncate"
          title={`上传落点：${uploadDir}`}
        >
          {headerLabel}
        </span>
        {selecting ? (
          <>
            <button
              onClick={() => {
                setSelecting(false);
                setPicked(new Map());
              }}
              className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
              title="退出多选（Esc）"
            >
              取消
            </button>
            <button
              // 文件夹下不了（/download 只收文件，混进一个就整条 400），宁可按钮直接灰掉说清楚。
              disabled={picked.size === 0 || pickedHasDir}
              onClick={() => {
                // 交给浏览器下，这里没有可等的东西；和 @ 一样做完就退出多选。
                downloadFiles([...picked.keys()]);
                setSelecting(false);
                setPicked(new Map());
              }}
              className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors disabled:opacity-40"
              title={
                pickedHasDir
                  ? "选中的里面有文件夹：文件夹不能下载"
                  : picked.size > 1
                    ? `打包成一个 zip 下载（${picked.size} 个文件）`
                    : "下载到本机"
              }
            >
              下载 {picked.size}
            </button>
            <button
              disabled={picked.size === 0}
              onClick={() => setConfirming(true)}
              className="shrink-0 whitespace-nowrap font-mono text-[11px] text-red border border-red/40 hover:border-red/70 rounded px-2 py-0.5 transition-colors disabled:opacity-40"
            >
              删除 {picked.size}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                setErr(null);
                setNewFolder((v) => (v === null ? "" : null));
              }}
              className={`shrink-0 font-mono text-[11px] border rounded px-1.5 py-0.5 transition-colors ${
                newFolder !== null
                  ? "text-fg border-fg/40"
                  : "text-muted hover:text-fg border-line hover:border-fg/30"
              }`}
              title={`在 ${uploadDir} 里新建文件夹（点某个文件夹可换落点）`}
              aria-label="新建文件夹"
            >
              <NewFolderIcon />
            </button>
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
      </div>

      {newFolder !== null && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-line shrink-0">
          <input
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doMkdir();
              if (e.key === "Escape") {
                setNewFolder(null);
                setErr(null);
              }
              // ⚠️ 别让按键冒到外面：这一栏的 Esc 是「退出多选」，
              // 在输入框里按 Esc 应该只是取消这次新建。
              e.stopPropagation();
            }}
            placeholder="文件夹名，回车确定"
            className="flex-1 min-w-0 bg-surface border border-line focus:border-fg/30 rounded px-2 py-1 font-mono text-[11.5px] text-fg placeholder:text-subtle outline-none"
          />
          <button
            onClick={() => void doMkdir()}
            disabled={!newFolder.trim() || busy !== null}
            className="shrink-0 font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors disabled:opacity-40"
          >
            建
          </button>
        </div>
      )}

      {err && (
        <div className="px-3 py-2 text-[11.5px] text-red border-b border-line break-words shrink-0">
          {err}
        </div>
      )}

      <TreeCtx.Provider value={ctx}>
        {/* 空白处也是落点＝移回根目录。没有它的话，从子目录里搬出来这件事
            压根没有手势可做（根目录不是树里的一行）。 */}
        <div
          key={seq}
          onDragOver={(e) => {
            if (!hasDraggedFiles(e.dataTransfer) || !canDropInto(cwd)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setRootOver(true);
          }}
          onDragLeave={(e) => {
            // 拖过子元素时 dragleave 也会打到容器上，会闪。只有真的离开了才灭。
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setRootOver(false);
            }
          }}
          onDrop={(e) => {
            if (!hasDraggedFiles(e.dataTransfer)) return;
            e.preventDefault();
            setRootOver(false);
            dropInto(cwd, readDraggedFiles(e.dataTransfer));
          }}
          className={`flex-1 overflow-y-auto py-1.5 pr-1 transition-colors ${
            rootOver ? "bg-blue/10 ring-1 ring-inset ring-blue/40" : ""
          }`}
        >
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
          <div className="soft-dialog max-w-[440px] w-full p-4 space-y-3">
            <div className="text-[14px] text-fg font-semibold">
              删除 {picked.size} {pickedHasDir ? "项" : "个文件"}？
            </div>
            <div className="text-[12.5px] text-orange leading-relaxed">
              直接删掉，<span className="font-semibold">没有回收站</span>
              ，也没有版本可以回退。
              {pickedHasDir && "文件夹只删空的，不是空的会原样留下。"}
            </div>
            {/* 逐个列出来：批量删除最容易出的事故是多选里混进了没看见的那一个。 */}
            <div className="max-h-[180px] overflow-y-auto bg-surface border border-line rounded p-2 space-y-0.5">
              {[...picked.entries()].map(([path, v]) => (
                <div
                  key={path}
                  className="font-mono text-[11.5px] text-muted truncate"
                  title={path}
                >
                  {v.dir ? `${v.name}/` : v.name}
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

// 当前正在拖的那批。⚠️ 不能只靠 dataTransfer：dragover 阶段浏览器不让读它的内容
// （见 lib/file-drag.ts），而「这个文件夹能不能放」必须在 dragover 就决定——
// 本来就在这个目录里的、以及文件夹拖进它自己，都不该亮成可放。
// 同一个文档里同时只可能有一次拖拽，所以模块级变量就够了。
let dragging: DraggedFile[] = [];

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** 这批东西放进 dir 有意义吗（不是原地、也不是塞进自己肚子里）。 */
export function canDropInto(dir: string): boolean {
  if (dragging.length === 0) return false;
  return dragging.some(
    (f) =>
      parentOf(f.path) !== dir &&
      dir !== f.path &&
      !dir.startsWith(f.path + "/")
  );
}

/* 行内改名。做成输入框而不是又一个弹窗：改名是「就地微调」，
   为它盖一层遮罩会打断上下文（你要参照旁边那几个文件的名字来起名）。
   ⚠️ 默认只选中主干名、不选扩展名——改名十次有九次不动后缀，
   全选中的话第一次敲键盘就把 `.md` 一起吃掉了。 */
function RenameInput({
  initial,
  onDone,
  onCancel,
}: {
  initial: string;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // ⚠️ 一律 stopPropagation：这一栏的 Esc 是「退出多选」，
        // 而 Enter/字母键在树上还有别的意思。
        e.stopPropagation();
        if (e.key === "Enter") onDone(value.trim());
        if (e.key === "Escape") onCancel();
      }}
      // 点别处就当确认（和 Finder 一致）。取消只有 Esc。
      onBlur={() => onDone(value.trim())}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 min-w-0 bg-surface border border-blue/50 rounded px-1 py-0 font-mono text-[12px] text-fg outline-none"
    />
  );
}

const PencilIcon = () => (
  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" className="block">
    <path
      d="M9.6 2.4 11.6 4.4 5 11H3v-2l6.6-6.6Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

function Row({ entry, depth }: { entry: TreeEntry; depth: number }) {
  return entry.type === "dir" ? (
    <DirRow entry={entry} depth={depth} />
  ) : (
    <FileRow entry={entry} depth={depth} />
  );
}

function DirRow({ entry, depth }: { entry: TreeEntry; depth: number }) {
  const {
    uploadDir,
    setUploadDir,
    dropInto,
    setRootOver,
    renameEntry,
    selecting,
    picked,
    toggle: togglePick,
    beginSelect,
  } = useTree();
  const checked = picked.has(entry.path);
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [over, setOver] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const isTarget = uploadDir === entry.path;
  // 悬停展开：拖着东西在一个收起的文件夹上停一会儿就把它打开，
  // 不然「目标在两层深处」这件事就只能先放下、点开、再拖一次。
  const dwell = useRef<number | null>(null);
  const clearDwell = () => {
    if (dwell.current !== null) {
      window.clearTimeout(dwell.current);
      dwell.current = null;
    }
  };
  useEffect(() => clearDwell, []);

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

  const open_ = async () => {
    if (!children) {
      setLoading(true);
      try {
        setChildren(await listTree(entry.path));
      } finally {
        setLoading(false);
      }
    }
    setOpen(true);
  };

  return (
    <>
      {/* 落点和拖拽高亮长在**外层 div** 上，不是那颗展开按钮上：右边还要放一颗
          重命名按钮，而 <button> 里不能再套 <button>。顺带落点也变大了一点。 */}
      <div
        onDragOver={(e) => {
          if (!hasDraggedFiles(e.dataTransfer) || !canDropInto(entry.path)) return;
          // preventDefault 才等于「这里可以放」。不写的话浏览器一律当不可放，
          // 光标是禁止符号，drop 事件也永远不来。
          e.preventDefault();
          // ⚠️ 这两行缺一不可：stopPropagation 挡住外层那个「放到根目录」的落点，
          // 但**它同时也让外层再也收不到 dragover 去自己熄灯**——外层的 dragleave
          // 在指针移进子元素时不算离开，于是两处会同时亮。所以主动叫它灭。
          e.stopPropagation();
          setRootOver(false);
          e.dataTransfer.dropEffect = "move";
          setOver(true);
          if (!open && dwell.current === null) {
            dwell.current = window.setTimeout(() => {
              dwell.current = null;
              void open_();
            }, 600);
          }
        }}
        onDragLeave={() => {
          setOver(false);
          clearDwell();
        }}
        onDrop={(e) => {
          if (!hasDraggedFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation(); // 别再冒到根目录那个落点上，会移动两次
          setOver(false);
          clearDwell();
          dropInto(entry.path, readDraggedFiles(e.dataTransfer));
        }}
        data-active={checked || isTarget}
        data-drop-over={over}
        className={`navigation-row group w-full flex items-center gap-1.5 py-1 pr-1.5 transition-colors ${
          over ? "ring-1 ring-blue/60" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
        // 右键＝进多选并选中这个文件夹，和文件同一个手势。原来这里只吞掉右键，
        // 文件夹于是根本选不中，空文件夹也就删不掉（用户 2026-09-23）。
        // 选中之后能删（只删空的）、能拖，不能下载。
        onContextMenu={(e) => {
          e.preventDefault();
          beginSelect(entry.path, entry.name, true);
        }}
      >
        {selecting && (
          <input
            type="checkbox"
            checked={checked}
            onChange={() => togglePick(entry.path, entry.name, true)}
            aria-label={`选择 ${entry.name}`}
            className="shrink-0 accent-blue"
          />
        )}
        {renaming ? (
          <>
            <Chevron open={open} />
            <FolderIcon />
            <RenameInput
              initial={entry.name}
              onCancel={() => setRenaming(false)}
              onDone={(name) => {
                setRenaming(false);
                if (name && name !== entry.name) void renameEntry(entry.path, name);
              }}
            />
          </>
        ) : (
          <>
            <button
              onClick={toggle}
              className="flex-1 min-w-0 flex items-center gap-1.5 py-0 text-left"
              title={`${entry.path}\n（点一下：展开 / 设为上传落点 · 可以把文件拖进来 · 右键：多选，空文件夹可以删）`}
            >
              <Chevron open={open} />
              <FolderIcon />
              <span className="font-mono text-[12px] truncate">{entry.name}</span>
            </button>
            <button
              onClick={() => setRenaming(true)}
              className="shrink-0 text-subtle hover:text-fg px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
              title="重命名"
              aria-label={`重命名 ${entry.name}`}
            >
              <PencilIcon />
            </button>
          </>
        )}
      </div>
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
  const { selecting, picked, toggle, beginSelect, preview, startDrag, renameEntry } =
    useTree();
  const checked = picked.has(entry.path);
  const [renaming, setRenaming] = useState(false);

  return (
    <div
      // ⚠️ 改名时必须关掉 draggable：draggable 元素里的 input 选不了文字——
      // 按住拖选会被浏览器解释成开始拖拽，光标一动整行就飞起来了。
      draggable={!renaming}
      onDragStart={(e) => startDrag(e, entry.path, entry.name)}
      onDragEnd={() => {
        dragging = [];
      }}
      data-active={checked}
      className="navigation-row group w-full flex items-center gap-1.5 py-1 pr-1.5 transition-colors"
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
      {renaming ? (
        <>
          <FileIcon />
          <RenameInput
            initial={entry.name}
            onCancel={() => setRenaming(false)}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== entry.name) void renameEntry(entry.path, name);
            }}
          />
        </>
      ) : (
        <>
          <button
            onClick={(e) =>
              e.metaKey || e.ctrlKey
                ? preview(entry.path)
                : openInDock({ path: entry.path, name: entry.name })
            }
            className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
            title={`${entry.path}\n（单击：在右侧打开 · ⌘/Ctrl+单击：浮窗速览 · 右键：多选 · 可拖到文件夹或对话框）`}
          >
            <FileIcon />
            <span className="font-mono text-[12px] truncate">{entry.name}</span>
          </button>
          <button
            onClick={() => setRenaming(true)}
            className="shrink-0 text-subtle hover:text-fg px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            title="重命名"
            aria-label={`重命名 ${entry.name}`}
          >
            <PencilIcon />
          </button>
        </>
      )}
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

// 文件夹 + 一个加号。用图标不用文字：这条栏能拖到 180px，表头放不下第三个词。
const NewFolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" className="block">
    <path
      d="M1.5 11V3.5C1.5 3 1.9 2.6 2.4 2.6H5.2L6.4 4H11.6C12.1 4 12.5 4.4 12.5 4.9V7.4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M1.5 11C1.5 11.5 1.9 11.9 2.4 11.9H7.2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <path
      d="M10.6 8.2v4.2M8.5 10.3h4.2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);
