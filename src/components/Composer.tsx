import { useEffect, useMemo, useRef, useState } from "react";
import ModelSelector from "./ModelSelector";
import ModeSelector from "./ModeSelector";
import EffortSelector from "./EffortSelector";
import SlashCommandMenu from "./SlashCommandMenu";
import { hasDraggedFiles, readDraggedFiles } from "../lib/file-drag";
import { useIsNarrow } from "../lib/useIsNarrow";
import type { AgentProvider, EffortLevel, PermissionMode } from "../lib/settings";
import { uploadFiles, formatSize, type UploadedFile } from "../lib/upload";

type ImagePart = { name?: string; mediaType: string; data: string };

/** 排在当前这轮后面、还没发出去的消息（只要展示用的那几个字段）。 */
export type QueuedMessage = {
  id: string;
  text: string;
  /**
   * 两种暂停，**别合并**——处置完全不同（照律枢，它也是分开的两个）：
   *   `stopped` 用户按了停止 ⇒ **整个队列**冻住，顶上出横幅 +「继续」；
   *   `failed`  这一条没发出去 ⇒ **只有它**变黄、按钮改「重试」，其余照常走。
   */
  paused?: "stopped" | "failed";
  /** 一句就地说明（如「这一轮刚结束，会按顺序发出」）。不是错误。 */
  note?: string;
};

interface Props {
  /**
   * 交出一条消息。**busy 的时候也照样调用**——「现在发还是排队」由 App 决定，
   * 不在这里判：附件/图片拼装的逻辑只有这一份，分叉会让排队那条路少拼一半。
   */
  onSend?: (text: string, images?: ImagePart[]) => void;
  /** 从文件树里拖进来的文件：把相对路径插进输入框（不是上传）。 */
  onInsertFile?: (absPath: string, relPath: string) => void;
  onCancel?: () => void;
  /** 当前这个会话正在跑。**不再等于「不能输入」**，只等于「发出去的会先排队」。 */
  disabled?: boolean;
  /** 已排队的消息，按先后顺序。 */
  queued?: QueuedMessage[];
  onUnqueue?: (id: string) => void;
  /** 那条上的「发送」：在跑就插进这一轮，没在跑就是普通发送。 */
  onSendQueued?: (id: string) => void;
  /** 横幅上的「继续」：解冻被停止冻住的整个队列。 */
  onResumeQueue?: () => void;
  /**
   * 这一刻能不能插话。busy 且 provider=claude 才为真 —— Codex 那侧
   * `codex exec` 的 stdin 不是控制协议，插不进去，那就**如实收起按钮**，
   * 而不是给一颗点了没反应的。
   */
  canSteer?: boolean;
  provider: AgentProvider;
  model: string;
  onModelChange: (v: string) => void;
  mode: PermissionMode;
  onModeChange: (v: PermissionMode) => void;
  effort: EffortLevel;
  onEffortChange: (v: EffortLevel) => void;
  value: string;
  onChange: (v: string) => void;
  slashCommands?: string[];
  onPickSlash?: (cmd: string) => void;
  rightSlot?: React.ReactNode;
}

export default function Composer({
  onSend,
  onInsertFile,
  onCancel,
  disabled,
  queued = [],
  onUnqueue,
  onSendQueued,
  onResumeQueue,
  canSteer,
  provider,
  model,
  onModelChange,
  mode,
  onModeChange,
  effort,
  onEffortChange,
  value,
  onChange,
  slashCommands = [],
  onPickSlash,
  rightSlot,
}: Props) {
  const narrow = useIsNarrow();
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 拖的是本机文件（上传）还是文件树里的文件（插路径）——提示语不一样，
  // 不区分的话「松开上传文件」会对着一个根本不会被上传的东西说。
  const [dragKind, setDragKind] = useState<"upload" | "insert" | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Slash menu is active when the textarea starts with "/" and the first
  // token (the command name) is still being typed (no space yet).
  const slashInfo = useMemo(() => {
    if (!value.startsWith("/")) return null;
    const firstSpace = value.indexOf(" ");
    if (firstSpace >= 0) return null;
    const query = value.slice(1);
    const lower = query.toLowerCase();
    const matches = slashCommands
      .filter((c) =>
        lower === "" ? true : c.toLowerCase().includes(lower)
      )
      .sort((a, b) => {
        const ai = a.toLowerCase().indexOf(lower);
        const bi = b.toLowerCase().indexOf(lower);
        if (ai !== bi) return ai - bi;
        return a.localeCompare(b);
      })
      .slice(0, 40);
    return { query, matches };
  }, [value, slashCommands]);

  const slashOpen = !!slashInfo && slashInfo.matches.length > 0;

  useEffect(() => {
    setSlashIdx(0);
  }, [slashInfo?.query]);

  const pickSlash = (cmd: string) => {
    setSlashIdx(0);
    if (onPickSlash) {
      onPickSlash(cmd);
    } else {
      onChange(`/${cmd} `);
    }
    requestAnimationFrame(() => taRef.current?.focus());
  };

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);

  const doUpload = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    setUploading(true);
    try {
      const saved = await uploadFiles(arr);
      setAttachments((prev) => [...prev, ...saved]);
    } catch (err) {
      console.error(err);
      alert(`上传失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const submit = () => {
    const v = value.trim();
    // ⚠️ 这里**不再看 disabled**：上一轮还在跑时按回车＝排队，不是丢掉。用户 2026-09-20
    //    的原话「不然我还得等前面一个结束之后才能发出去」。真正的分流在 App.submitOrQueue。
    if (uploading) return;
    if (!v && attachments.length === 0) return;

    const imageParts: ImagePart[] = [];
    const fileParts: typeof attachments = [];
    for (const a of attachments) {
      if (a.imageData && a.mime?.startsWith("image/")) {
        imageParts.push({
          name: a.name,
          mediaType: a.mime,
          data: a.imageData,
        });
      } else {
        fileParts.push(a);
      }
    }

    let payload = v;
    if (fileParts.length > 0) {
      const lines = fileParts
        .map((a) => `- ${a.path}  (${a.name})`)
        .join("\n");
      payload = `附件：\n${lines}${v ? `\n\n${v}` : ""}`;
    }
    onSend?.(payload, imageParts.length > 0 ? imageParts : undefined);
    onChange("");
    setAttachments([]);
  };

  const removeAt = (i: number) =>
    setAttachments((xs) => xs.filter((_, idx) => idx !== i));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setDragKind(null);
    // 从自己的文件树里拖过来的：插路径，不上传。这两件事必须分开——
    // 那个文件本来就在服务器上，再上传一份到 /tmp 只会多出一个副本。
    const dragged = readDraggedFiles(e.dataTransfer);
    if (dragged.length > 0) {
      for (const f of dragged) onInsertFile?.(f.path, f.rel);
      return;
    }
    if (e.dataTransfer.files?.length) {
      doUpload(e.dataTransfer.files);
    }
  };

  const canSend = !uploading && (value.trim() || attachments.length > 0);

  const frozen = queued.some((q) => q.paused === "stopped");

  return (
    <div className="px-6 pb-5 pt-2 max-md:px-3 max-md:pb-[calc(env(safe-area-inset-bottom)+10px)]">
      {/* 待发送。**挂在输入框上方，不在框里、更不在对话流里**（照律枢 PendingStack）：
          还没送出去的话不该出现在对话里——上一版把它塞进输入框内部，看着就成了
          「第二个输入框」。「进对话的时刻 ＝ 真正送出去的时刻」是这整件事的主线。
          样式跟着那边的安静度走：无边框、按钮无底、整块唯一的颜色是左边那个琥珀小图标。 */}
      {queued.length > 0 && (
        <div className="mb-2 flex flex-col">
          {frozen && (
            <div className="mb-2 flex items-center gap-2 border-b border-line px-1 pb-2">
              <ClockIcon />
              <span className="min-w-0 flex-1 text-[12px] text-subtle">
                你中断了这一轮，队列已暂停
              </span>
              <button
                onClick={onResumeQueue}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] font-semibold text-green hover:bg-green/10"
              >
                继续
              </button>
            </div>
          )}
          <div className="flex flex-col gap-1.5 max-h-[168px] overflow-y-auto">
            {queued.map((q) => (
              <div
                key={q.id}
                className={`flex items-center gap-2.5 rounded-[10px] py-2 pl-3 pr-1.5 ${
                  q.paused === "failed" ? "bg-amber/10" : "bg-raised"
                }`}
              >
                {q.paused ? <ClockIcon /> : <QueueIcon />}
                <span
                  className="min-w-0 flex-1 truncate text-[12.5px] text-muted"
                  title={q.text}
                >
                  {q.text}
                </span>
                {q.note && (
                  <span className="shrink-0 text-[11px] text-subtle">{q.note}</span>
                )}
                {/* 「发送」＝不等这一轮跑完，现在就塞进正在跑的那一轮（走 claude 命令行
                    自己的排队）。没人在跑时它就是普通发送。Codex 插不进去 ⇒ 收起按钮，
                    而不是给一颗点了没反应的。 */}
                {(!disabled || canSteer) && (
                  <button
                    onClick={() => onSendQueued?.(q.id)}
                    title={
                      disabled ? "不等这一轮跑完，现在就发进去" : "现在发出去"
                    }
                    className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-subtle hover:bg-fg/5 hover:text-fg"
                  >
                    <ArrowUpIcon />
                    {q.paused === "failed" ? "重试" : "发送"}
                  </button>
                )}
                <button
                  onClick={() => onUnqueue?.(q.id)}
                  title="删除这条待发送"
                  aria-label="删除这条待发送"
                  className="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded text-subtle hover:bg-fg/5 hover:text-red"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
          setDragKind(hasDraggedFiles(e.dataTransfer) ? "insert" : "upload");
        }}
        onDragLeave={() => {
          setDragOver(false);
          setDragKind(null);
        }}
        onDrop={onDrop}
        data-drag-over={dragOver}
        className="composer-surface relative"
      >
        {slashOpen && slashInfo && (
          <SlashCommandMenu
            commands={slashInfo.matches}
            activeIdx={slashIdx}
            onPick={pickSlash}
            onHover={setSlashIdx}
            query={slashInfo.query}
          />
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3">
            {attachments.map((a, i) => (
              <div
                key={a.path}
                className="flex items-center gap-2 bg-surface border border-line-strong rounded-md pl-2 pr-1 py-1 text-[12px]"
              >
                <FileIcon />
                <span className="text-fg truncate max-w-[220px]">{a.name}</span>
                <span className="text-subtle font-mono text-[10.5px]">
                  {formatSize(a.size)}
                </span>
                <button
                  onClick={() => removeAt(i)}
                  aria-label="移除"
                  className="text-subtle hover:text-fg p-0.5 rounded"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M3 3L9 9M9 3L3 9"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
            {uploading && (
              <div className="flex items-center gap-1.5 text-[11px] text-subtle font-mono px-2 py-1">
                <span className="w-1 h-1 rounded-full bg-blue animate-pulse" />
                上传中…
              </div>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (slashOpen && slashInfo) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIdx((i) =>
                  Math.min(i + 1, slashInfo.matches.length - 1)
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIdx((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const pick = slashInfo.matches[slashIdx];
                if (pick) pickSlash(pick);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onChange("");
                return;
              }
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.altKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
              return;
            }
            if (
              e.key === "Backspace" &&
              !e.metaKey &&
              !e.altKey &&
              !e.shiftKey
            ) {
              const el = e.currentTarget;
              const start = el.selectionStart ?? 0;
              const end = el.selectionEnd ?? 0;
              if (start !== end || start === 0) return;
              const before = value.slice(0, start);
              const m = before.match(/@[^\s]+(\s?)$/);
              if (!m) return;
              const tokenStart = before.length - m[0].length;
              let deleteFrom = tokenStart;
              if (
                !m[1] &&
                tokenStart > 0 &&
                value[tokenStart - 1] === " "
              ) {
                deleteFrom = tokenStart - 1;
              }
              e.preventDefault();
              const next = value.slice(0, deleteFrom) + value.slice(start);
              onChange(next);
              requestAnimationFrame(() =>
                el.setSelectionRange(deleteFrom, deleteFrom)
              );
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files?.length) {
              e.preventDefault();
              doUpload(e.clipboardData.files);
            }
          }}
          placeholder={
            dragOver
              ? dragKind === "insert"
                ? "松开把路径插进来"
                : "松开上传文件"
              : narrow
                // 手机上既没有 ⇧ 也没有独立的 ↵，这行提示只是占地方。
                ? disabled
                  ? "输入下一条…（会排队）"
                  : "输入追问或补充说明…"
                : disabled
                  ? "输入下一条…    ↵ 排队，这轮结束后自动发出 · ⇧↵ 换行"
                  : "输入追问或补充说明…    ↵ 发送 · ⇧↵ 换行"
          }
          rows={1}
          className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[14.5px] leading-[1.6] text-fg placeholder:text-subtle focus:outline-none"
        />

        <input
          ref={fileRef}
          type="file"
          multiple
          onChange={(e) => {
            if (e.target.files) doUpload(e.target.files);
            e.target.value = "";
          }}
          className="hidden"
        />

        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            aria-label="上传文件"
            title="上传文件（或拖拽 / 粘贴）"
            className="w-8 h-8 rounded-md text-muted hover:text-fg hover:bg-fg/5 disabled:opacity-40 flex items-center justify-center transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 2V12M2 7H12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {/* ⚠️ busy 时两颗**同时**在，而且最右边那颗**永远是发送**：
              手机上没有回车可按，排队就只能靠这颗；而「停止」原来占着最右，
              一 busy 就和发送互换位置，等于让人对着同一个坐标点出两种结果。 */}
          <div className="flex items-center gap-2">
            {disabled && onCancel && (
              <button
                onClick={onCancel}
                aria-label="停止生成"
                title="停止生成"
                className="w-9 h-9 rounded-full bg-red hover:brightness-110 flex items-center justify-center transition-all active:scale-95"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="2" y="2" width="8" height="8" rx="1.5" fill="var(--color-on-status)" />
                </svg>
              </button>
            )}
            <button
              onClick={submit}
              disabled={!canSend}
              aria-label={disabled ? "排队发送" : "发送"}
              title={disabled ? "排队：这一轮结束后自动发出" : undefined}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed ${
                disabled
                  ? "border border-blue/60 text-blue hover:bg-blue/10"
                  : "bg-blue hover:bg-blue-hover"
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 13V3M8 3L3.5 7.5M8 3L12.5 7.5"
                  stroke={disabled ? "currentColor" : "var(--color-on-brand)"}
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <ModelSelector
            value={model}
            provider={provider}
            onChange={onModelChange}
          />
          <span className="text-subtle/50 text-[11px]">·</span>
          <ModeSelector value={mode} provider={provider} onChange={onModeChange} />
          <span className="text-subtle/50 text-[11px]">·</span>
          <EffortSelector
            value={effort}
            onChange={onEffortChange}
            model={model}
          />
        </div>
        <div className="flex items-center gap-2">
          {rightSlot}
          <span className="text-[11px] text-subtle font-mono px-1">
            {disabled ? provider === "codex" ? "processing…" : "thinking…" : uploading ? "uploading…" : "idle"}
          </span>
        </div>
      </div>
    </div>
  );
}

const QueueIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-amber">
    <path d="M1.5 2.5h9M1.5 6h9M1.5 9.5h5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const ClockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-amber">
    <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 3.6V6l1.7 1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ArrowUpIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
    <path d="M6 9.5V2.5M6 2.5L3 5.5M6 2.5L9 5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TrashIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
    <path d="M2.5 3.2h7M4.8 3.2V2.2h2.4v1M3.4 3.2l.4 6.2h4.4l.4-6.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FileIcon = () => (
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="text-muted">
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
