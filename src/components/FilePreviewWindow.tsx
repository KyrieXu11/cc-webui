import { useCallback, useEffect, useRef, useState } from "react";

interface Position {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface Props {
  relPath: string;
  absPath: string;
  kind: "text" | "image";
  content: string;
  imageUrl: string | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onInsert: () => void;
}

const MIN_WIDTH = 420;
const MIN_HEIGHT = 260;

function getInitial(): { position: Position; size: Size } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(720, Math.max(MIN_WIDTH, vw - 320));
  const height = Math.min(Math.round(vh * 0.6), vh - 80);
  const x = Math.max(40, Math.round((vw - width) / 2) - 80);
  const y = Math.max(40, Math.round((vh - height) / 2) - 30);
  return { position: { x, y }, size: { width, height } };
}

export default function FilePreviewWindow({
  relPath,
  absPath,
  kind,
  content,
  imageUrl,
  truncated,
  loading,
  error,
  onClose,
  onInsert,
}: Props) {
  const initialRef = useRef(getInitial());
  const [position, setPosition] = useState<Position>(initialRef.current.position);
  const [size, setSize] = useState<Size>(initialRef.current.size);

  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const clampPosition = useCallback((p: Position, s: Size): Position => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(0, Math.min(p.x, vw - Math.min(s.width, vw) ));
    const y = Math.max(0, Math.min(p.y, vh - 40));
    return { x, y };
  }, []);

  const onTitleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    dragRef.current = {
      offsetX: e.clientX - position.x,
      offsetY: e.clientY - position.y,
    };
    e.preventDefault();
  };

  const onResizeMouseDown = (e: React.MouseEvent) => {
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: size.width,
      startH: size.height,
    };
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const next = {
          x: e.clientX - dragRef.current.offsetX,
          y: e.clientY - dragRef.current.offsetY,
        };
        setPosition(clampPosition(next, size));
        return;
      }
      if (resizeRef.current) {
        const r = resizeRef.current;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = Math.max(
          MIN_WIDTH,
          Math.min(r.startW + (e.clientX - r.startX), vw - position.x - 8)
        );
        const height = Math.max(
          MIN_HEIGHT,
          Math.min(r.startH + (e.clientY - r.startY), vh - position.y - 8)
        );
        setSize({ width, height });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clampPosition, position.x, position.y, size]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = kind === "text" ? content.split("\n") : [];
  const lineCount = lines.length;
  const lineNumWidth = String(lineCount).length;

  return (
    <div
      className="fixed z-40 bg-canvas border border-line rounded-lg shadow-2xl flex flex-col overflow-hidden"
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
      }}
    >
      <div
        onMouseDown={onTitleMouseDown}
        className="flex items-center gap-2 px-3 py-2 border-b border-line bg-fg/[0.02] cursor-move select-none"
      >
        <FileIcon />
        <span
          className="font-mono text-[12px] text-muted truncate flex-1"
          title={absPath}
        >
          {relPath}
        </span>
        <span className="font-mono text-[10.5px] text-subtle tabular-nums shrink-0">
          {kind === "image"
            ? "图片"
            : truncated
              ? `${lineCount}行 · 截断`
              : `${lineCount}行`}
        </span>
        <button
          data-no-drag
          onClick={onInsert}
          className="shrink-0 font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
          title="插入到对话"
        >
          @ 插入
        </button>
        <button
          data-no-drag
          onClick={onClose}
          className="shrink-0 text-subtle hover:text-fg transition-colors px-1"
          title="关闭 (Esc)"
          aria-label="关闭"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="flex-1 overflow-auto bg-canvas">
        {loading ? (
          <div className="px-4 py-6 text-[12px] text-subtle font-mono">
            加载中…
          </div>
        ) : error ? (
          <div className="px-4 py-6 text-[12px] text-red font-mono whitespace-pre-wrap">
            {error}
          </div>
        ) : kind === "image" && imageUrl ? (
          <div className="flex items-center justify-center min-h-full p-4 bg-[repeating-conic-gradient(rgba(127,127,127,0.08)_0%_25%,transparent_0%_50%)_50%_/_16px_16px]">
            <img
              src={imageUrl}
              alt={relPath}
              className="max-w-full max-h-full object-contain"
              style={{ imageRendering: "auto" }}
            />
          </div>
        ) : (
          <div className="font-mono text-[12.5px] leading-[1.55] text-fg py-2">
            {truncated && (
              <div className="px-3 pb-2 text-[11px] text-subtle italic">
                仅显示前 256KB 内容
              </div>
            )}
            {lines.map((line, i) => (
              <div key={i} className="flex items-start">
                <span
                  className="pl-3 pr-3 text-right text-subtle select-none shrink-0 tabular-nums"
                  style={{ width: `${lineNumWidth + 2}ch` }}
                >
                  {i + 1}
                </span>
                <span className="whitespace-pre pr-4 flex-1">
                  {line || " "}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        onMouseDown={onResizeMouseDown}
        className="absolute right-0 bottom-0 w-4 h-4 cursor-se-resize"
        title="拖拽调整大小"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          className="text-subtle/70"
        >
          <path
            d="M12 5L5 12 M12 9L9 12"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}

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

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path
      d="M3 3L11 11M11 3L3 11"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);
