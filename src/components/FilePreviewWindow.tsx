import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import ImageView from "./ImageView";
import { HTML_SANDBOX, isHtmlFile, renderedHtmlUrl } from "../lib/filepreview";

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
  kind: "text" | "image" | "pdf";
  content: string;
  imageUrl: string | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

const MIN_WIDTH = 420;
const MIN_HEIGHT = 260;

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

function basename(p: string): string {
  return p.split("/").pop() ?? "";
}

function isMarkdownPath(p: string): boolean {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

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
}: Props) {
  const initialRef = useRef(getInitial());
  const [position, setPosition] = useState<Position>(initialRef.current.position);
  const [size, setSize] = useState<Size>(initialRef.current.size);
  // Markdown / HTML 默认渲染视图；源码视图保留行号，用来核对原文。
  const isMarkdown = kind === "text" && isMarkdownPath(relPath);
  // html 的渲染档是一个沙箱 iframe（和 DockFileView 同一套 —— 不做两套 UI），
  // 拉的是 /api/fs/raw?render=1，所以要 absPath；attach 上来的图片那条路
  // absPath 是空串，但它 kind 不是 text，走不到这儿。
  const isHtml = kind === "text" && !!absPath && isHtmlFile(basename(relPath));
  const renderable = isMarkdown || isHtml;
  const [rendered, setRendered] = useState(true);
  const [copied, setCopied] = useState(false);

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

  // 换文件时回到默认视图，并清掉上一次的「已复制」反馈。
  useEffect(() => {
    setRendered(true);
    setCopied(false);
  }, [absPath]);

  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // 非 https / 无剪贴板权限时的兜底：临时 textarea + execCommand。
      const ta = document.createElement("textarea");
      ta.value = content;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [content]);

  const lines = kind === "text" ? content.split("\n") : [];
  const lineCount = lines.length;
  const lineNumWidth = String(lineCount).length;

  return (
    <div
      className="fixed z-40 soft-dialog flex flex-col overflow-hidden"
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
            : kind === "pdf"
              ? "PDF"
              : truncated
              ? `${lineCount}行 · 截断`
              : `${lineCount}行`}
        </span>
        {renderable && (
          <button
            data-no-drag
            onClick={() => setRendered((v) => !v)}
            className="shrink-0 font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
            title={rendered ? "看源码" : "看渲染结果"}
          >
            {rendered ? "源码" : "渲染"}
          </button>
        )}
        {kind === "text" && !loading && !error && (
          <button
            data-no-drag
            onClick={copyAll}
            className={`shrink-0 font-mono text-[11px] border rounded px-2 py-0.5 transition-colors ${
              copied
                ? "text-green border-green/50"
                : "text-muted hover:text-fg border-line hover:border-fg/30"
            }`}
            title={truncated ? "复制已加载的内容（文件被截断）" : "复制全文"}
          >
            {copied ? "已复制" : "复制"}
          </button>
        )}
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

      {/* 图片、PDF、渲染中的 html 都自己管滚动/缩放（ImageView 用 transform，另外
          两个在 iframe 里由浏览器管），外层再套一层 overflow-auto 会变成两条滚动条
          互相打架。 */}
      <div
        className={`flex-1 min-h-0 bg-surface ${
          kind === "text" && !(isHtml && rendered)
            ? "overflow-auto"
            : "overflow-hidden"
        }`}
      >
        {loading ? (
          <div className="px-4 py-6 text-[12px] text-subtle font-mono">
            加载中…
          </div>
        ) : error ? (
          <div className="px-4 py-6 text-[12px] text-red font-mono whitespace-pre-wrap">
            {error}
          </div>
        ) : kind === "image" && imageUrl ? (
          <ImageView url={imageUrl} alt={relPath} />
        ) : kind === "pdf" && imageUrl ? (
          /* 浏览器自带的 PDF viewer：翻页/搜索/缩放/打印全都有。
             ⚠️ 用 <iframe> 而不是 <object>/<embed>：后两者在 PDF 加载失败时是
             一片空白（连 fallback 内容都不一定渲染），而 iframe 会把服务端那句
             JSON 报错显示出来——文件超过 RAW_MAX_BYTES 时用户至少看得见原因。 */
          <iframe
            src={imageUrl}
            title={relPath}
            className="w-full h-full border-0 bg-canvas"
          />
        ) : isHtml && rendered ? (
          /* 沙箱档位见 lib/filepreview.ts 的 HTML_SANDBOX：**allow-scripts 和
             allow-same-origin 一起给等于没有沙箱** —— 拿到同源身份的脚本能把父
             文档上这个 iframe 的 sandbox 属性抹掉再重载，自己把自己放出来。
             这里的内容是 agent 写的文件，放出来就等于本站的同源 XSS。 */
          <iframe
            src={renderedHtmlUrl(absPath)}
            title={relPath}
            sandbox={HTML_SANDBOX}
            className="w-full h-full border-0 bg-white"
          />
        ) : isMarkdown && rendered ? (
          <div className="px-4 py-3 text-[14px] leading-[1.75] text-fg md-body">
            {truncated && (
              <div className="pb-2 text-[11px] text-subtle italic font-mono">
                仅显示前 256KB 内容
              </div>
            )}
            <Markdown text={content} />
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
          className="text-subtle"
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
