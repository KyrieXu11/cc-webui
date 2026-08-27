import { useCallback, useEffect, useState } from "react";
import Markdown from "../Markdown";
import TextEditor from "./TextEditor";
import OfficeEditor from "./OfficeEditor";
import { isImageFile, isTextFile, rawFileUrl } from "../../lib/filepreview";
import { readFileVersioned, saveFile } from "../../lib/files";

// 右侧格里的一份文件：渲染 / 源码（可编辑）两种形态，一个开关切换。
//
// 和下午做的 FilePreviewWindow 合流的地方：**渲染 = Markdown.tsx，源码 =
// CodeMirror**。不做两套 UI。
//
// 乐观锁的状态就在这里：打开时记下 mtimeMs+size，保存时带回去；409 就把「已被
// agent 改过」摆在最显眼的地方，并且**不清掉用户的编辑**——那是他刚写的东西，
// 唯一能救回它的地方就是这个还没关的编辑器。

type Version = { mtimeMs: number; size: number };

const OFFICE_RE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;

interface Props {
  path: string;
  name: string;
  /** 服务端是否配了 ONLYOFFICE（/api/meta 的 features.office）。 */
  officeEnabled?: boolean;
  /** 由父级传入，用于「重新打开」后重建编辑器（换 key）。 */
  reloadToken: number;
  onReload: () => void;
}

export default function DockFileView({
  path,
  name,
  officeEnabled,
  reloadToken,
  onReload,
}: Props) {
  const isMd = /\.(md|markdown|mdx)$/i.test(name);
  const editable = isTextFile(name);
  const [rendered, setRendered] = useState(isMd);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [version, setVersion] = useState<Version | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!editable) {
      setLoaded(null);
      return;
    }
    readFileVersioned(path)
      .then((d) => {
        if (!alive) return;
        setLoaded(d.content);
        setDraft(d.content);
        setVersion({ mtimeMs: d.mtimeMs, size: d.size });
        setTruncated(d.truncated);
        setErr(null);
        setConflict(null);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : "读取失败");
      });
    return () => {
      alive = false;
    };
  }, [path, editable, reloadToken]);

  const dirty = loaded !== null && draft !== loaded;

  const save = useCallback(async () => {
    if (!version || !dirty || truncated) return;
    setSaving(true);
    const r = await saveFile(path, draft, version);
    setSaving(false);
    if (r.ok) {
      setLoaded(draft);
      setVersion({ mtimeMs: r.mtimeMs, size: r.size });
      setConflict(null);
      setSavedAt(Date.now());
      return;
    }
    // 冲突时刻意不动 draft：用户的编辑只存在于这个编辑器里。
    setConflict(r.message);
  }, [dirty, draft, path, truncated, version]);

  // 图片：直接给 raw。
  if (isImageFile(name)) {
    return (
      <div className="h-full overflow-auto flex items-center justify-center p-4">
        <img
          src={rawFileUrl(path)}
          alt={name}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }

  // Office 文件：容器可用就上 ONLYOFFICE，否则降级成浏览器打开/下载（决策 9）。
  if (OFFICE_RE.test(name)) {
    if (officeEnabled) return <OfficeEditor path={path} name={name} />;
    return (
      <div className="p-4 space-y-3">
        <div className="text-[12.5px] text-muted leading-relaxed">
          服务端没有开启在线编辑（缺 ONLYOFFICE 配置，或那个容器不在跑）。
        </div>
        <div className="text-[12px] text-subtle leading-relaxed">
          Edge 会用它自带的 Office 查看器直接渲染，其它浏览器是下载。也可以直接
          让 agent 改这份文件。
        </div>
        <a
          href={rawFileUrl(path)}
          target="_blank"
          rel="noreferrer"
          className="inline-block font-mono text-[11.5px] text-blue underline underline-offset-2"
        >
          用浏览器打开 / 下载 {name}
        </a>
      </div>
    );
  }

  if (!editable) {
    return (
      <div className="p-4 space-y-3 text-[12.5px] text-muted">
        <div>这个格式没有内置查看器。</div>
        <a
          href={rawFileUrl(path)}
          target="_blank"
          rel="noreferrer"
          className="inline-block font-mono text-[11.5px] text-blue underline underline-offset-2"
        >
          用浏览器打开 / 下载
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line shrink-0">
        {isMd && (
          <button
            onClick={() => setRendered((v) => !v)}
            className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
          >
            {rendered ? "源码" : "渲染"}
          </button>
        )}
        <span className="font-mono text-[10.5px] text-subtle tabular-nums">
          {truncated
            ? "文件过大，只读前 256KB —— 不可保存"
            : dirty
              ? "未保存"
              : savedAt
                ? "已保存"
                : "已同步"}
        </span>
        <div className="flex-1" />
        {loaded !== null && (
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(draft)
                .then(() => setCopied(true))
                .then(() => setTimeout(() => setCopied(false), 1400));
            }}
            className="font-mono text-[11px] rounded px-2 py-0.5 border transition-colors text-muted hover:text-fg border-line hover:border-fg/30"
            title="复制全文"
          >
            {copied ? "已复制" : "复制"}
          </button>
        )}
        {!rendered && !truncated && (
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="font-mono text-[11px] rounded px-2 py-0.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-muted hover:text-fg border-line hover:border-fg/30"
            title="保存（⌘S）"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        )}
      </div>

      {conflict && (
        <div className="shrink-0 px-3 py-2 border-b border-line bg-fg/[0.03] space-y-1.5">
          <div className="text-[12px] text-orange">{conflict}</div>
          <div className="text-[11.5px] text-subtle leading-relaxed">
            你的改动还在下面的编辑器里，没有丢。可以先复制出来，再点「重新打开」
            拿最新版本。
          </div>
          <button
            onClick={onReload}
            className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
          >
            重新打开
          </button>
        </div>
      )}

      {err ? (
        <div className="p-4 text-[12px] text-red font-mono">{err}</div>
      ) : loaded === null ? (
        <div className="p-4 text-[12px] text-subtle">加载中…</div>
      ) : rendered ? (
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 text-[14px] leading-[1.75] text-fg md-body">
          <Markdown text={draft} />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <TextEditor
            key={`${path}:${reloadToken}`}
            initial={loaded}
            filename={name}
            onChange={setDraft}
            onSave={() => void save()}
          />
        </div>
      )}
    </div>
  );
}
