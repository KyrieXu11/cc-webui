import { useEffect, useState } from "react";
import { listTree, type TreeEntry } from "../lib/fs";

interface Props {
  cwd: string;
  onInsertFile: (absPath: string, relPath: string) => void;
  onPreviewFile: (absPath: string, relPath: string) => void;
}

export default function FileExplorer({
  cwd,
  onInsertFile,
  onPreviewFile,
}: Props) {
  const [rootEntries, setRootEntries] = useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

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
  }, [cwd]);

  const toRel = (abs: string) =>
    abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;

  const insertFile = (abs: string) => onInsertFile(abs, toRel(abs));
  const previewFile = (abs: string) => onPreviewFile(abs, toRel(abs));

  return (
    <aside className="w-[280px] shrink-0 border-l border-line flex flex-col bg-canvas">
      <div className="px-4 py-3 border-b border-line">
        <div className="text-[11px] font-mono text-subtle uppercase tracking-[0.08em]">
          文件
        </div>
        <div className="font-mono text-[11.5px] text-muted truncate mt-0.5">
          {cwd}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1.5 pr-1">
        {loading ? (
          <div className="px-4 py-3 text-[12px] text-subtle">加载中…</div>
        ) : !rootEntries || rootEntries.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-subtle">空目录</div>
        ) : (
          rootEntries.map((e) =>
            e.type === "dir" ? (
              <DirRow
                key={e.path}
                entry={e}
                depth={0}
                onInsertFile={insertFile}
                onPreviewFile={previewFile}
              />
            ) : (
              <FileRow
                key={e.path}
                entry={e}
                depth={0}
                onInsertFile={insertFile}
                onPreviewFile={previewFile}
              />
            )
          )
        )}
      </div>
    </aside>
  );
}

function DirRow({
  entry,
  depth,
  onInsertFile,
  onPreviewFile,
}: {
  entry: TreeEntry;
  depth: number;
  onInsertFile: (abs: string) => void;
  onPreviewFile: (abs: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!open && !children) {
      setLoading(true);
      try {
        const es = await listTree(entry.path);
        setChildren(es);
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
        className="w-full flex items-center gap-1.5 py-1 pr-2 text-left text-muted hover:text-fg hover:bg-fg/[0.025] transition-colors rounded-sm"
        style={{ paddingLeft: 8 + depth * 12 }}
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
      {open && children && (
        <>
          {children.map((c) =>
            c.type === "dir" ? (
              <DirRow
                key={c.path}
                entry={c}
                depth={depth + 1}
                onInsertFile={onInsertFile}
                onPreviewFile={onPreviewFile}
              />
            ) : (
              <FileRow
                key={c.path}
                entry={c}
                depth={depth + 1}
                onInsertFile={onInsertFile}
                onPreviewFile={onPreviewFile}
              />
            )
          )}
        </>
      )}
    </>
  );
}

function FileRow({
  entry,
  depth,
  onInsertFile,
  onPreviewFile,
}: {
  entry: TreeEntry;
  depth: number;
  onInsertFile: (abs: string) => void;
  onPreviewFile: (abs: string) => void;
}) {
  const onClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      onPreviewFile(entry.path);
      return;
    }
    onInsertFile(entry.path);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      onPreviewFile(entry.path);
    }
  };

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="w-full flex items-center gap-1.5 py-1 pr-2 text-left text-muted hover:text-fg hover:bg-fg/[0.025] transition-colors rounded-sm"
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
      title={`${entry.path}\n(单击插入 · Ctrl/⌘+单击预览)`}
    >
      <FileIcon />
      <span className="font-mono text-[12px] truncate">{entry.name}</span>
    </button>
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
