import { useEffect, useRef, useState } from "react";
import ModelSelector from "./ModelSelector";
import ModeSelector from "./ModeSelector";
import EffortSelector from "./EffortSelector";
import type { EffortLevel, PermissionMode } from "../lib/settings";
import { uploadFiles, formatSize, type UploadedFile } from "../lib/upload";

type ImagePart = { name?: string; mediaType: string; data: string };

interface Props {
  onSend?: (text: string, images?: ImagePart[]) => void;
  disabled?: boolean;
  model: string;
  onModelChange: (v: string) => void;
  mode: PermissionMode;
  onModeChange: (v: PermissionMode) => void;
  effort: EffortLevel;
  onEffortChange: (v: EffortLevel) => void;
  value: string;
  onChange: (v: string) => void;
}

export default function Composer({
  onSend,
  disabled,
  model,
  onModelChange,
  mode,
  onModeChange,
  effort,
  onEffortChange,
  value,
  onChange,
}: Props) {
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    if (disabled || uploading) return;
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
    if (e.dataTransfer.files?.length) {
      doUpload(e.dataTransfer.files);
    }
  };

  const canSend = !disabled && !uploading && (value.trim() || attachments.length > 0);

  return (
    <div className="px-6 pb-5 pt-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`relative bg-raised border rounded-2xl transition-colors ${
          dragOver
            ? "border-blue/70 ring-2 ring-blue/20"
            : "border-line-strong focus-within:border-fg/25"
        }`}
      >
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
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
            dragOver ? "松开上传文件" : "输入追问或补充说明…    ⌘↵ 发送"
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
          <button
            onClick={submit}
            disabled={!canSend}
            aria-label="发送"
            className="w-9 h-9 rounded-full bg-blue hover:bg-blue-hover disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all active:scale-95"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 13V3M8 3L3.5 7.5M8 3L12.5 7.5"
                stroke="white"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <ModelSelector value={model} onChange={onModelChange} />
          <span className="text-subtle/50 text-[11px]">·</span>
          <ModeSelector value={mode} onChange={onModeChange} />
          <span className="text-subtle/50 text-[11px]">·</span>
          <EffortSelector
            value={effort}
            onChange={onEffortChange}
            model={model}
          />
        </div>
        <span className="text-[11px] text-subtle font-mono px-1">
          {disabled ? "thinking…" : uploading ? "uploading…" : "idle"}
        </span>
      </div>
    </div>
  );
}

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
