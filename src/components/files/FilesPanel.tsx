import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteFiles,
  humanSize,
  humanTime,
  listConversationFiles,
  uploadToDir,
  type ConversationFile,
} from "../../lib/files";
import { openInDock } from "../../lib/dock-bridge";

// 取件台的列表：本对话文件（这条会话的 turn 亲手创建或改动过的文件）。
//
// 刷新时机是 turn 结束（父级 refreshKey 在 App 的 setSessionsRefreshKey 处一起
// 前进）+ 手动按钮。**刻意没有轮询、没有 watcher**：registry 是在 turn 收尾写的，
// turn 跑一半时文件还在变，列出来只会闪；watcher 那条路在 launchd + macOS TCC
// 的雷区里（docs/file-manager.md）。
//
// 删除是**真删、无回收站**（决策 4），所以确认弹窗是唯一的闸门：它列出每一个将被
// 删掉的文件名，而不是只说「确定删除 3 个文件吗」——批量删除最容易出的事故是
// 多选里混进了一个你没看见的。

interface Props {
  sessionId: string | null;
  /** 会话 cwd —— 上传落在这里。 */
  cwd: string;
  /** 变化即重新拉取（turn 结束时前进）。 */
  refreshKey?: number;
}

export default function FilesPanel({
  sessionId,
  cwd,
  refreshKey,
}: Props) {
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const next = await listConversationFiles(sessionId);
      setFiles(next);
      // 选中集跟着收敛：文件可能已经被 agent 或别人删掉了。
      setPicked((cur) => {
        const alive = new Set(next.map((f) => f.path));
        return new Set([...cur].filter((p) => alive.has(p)));
      });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "列出文件失败");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const toggle = (p: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const doDelete = async () => {
    setBusy("删除中…");
    try {
      const r = await deleteFiles([...picked], sessionId);
      if (r.failed.length > 0) {
        setErr(
          `${r.failed.length} 个没删掉：` +
            r.failed.map((f) => `${f.path}（${f.error}）`).join("；")
        );
      } else {
        setErr(null);
      }
      setPicked(new Set());
      setConfirming(false);
      await load();
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
      await uploadToDir(cwd, list);
      setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const pickedFiles = files.filter((f) => picked.has(f.path));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line">
        <span className="font-mono text-[11px] text-subtle flex-1 truncate">
          {busy ?? (loading ? "查找中…" : `${files.length} 个文件`)}
        </span>
        {picked.size > 0 ? (
          <button
            onClick={() => setConfirming(true)}
            className="font-mono text-[11px] text-red hover:text-red border border-red/40 hover:border-red/70 rounded px-2 py-0.5 transition-colors"
          >
            删除 {picked.size}
          </button>
        ) : (
          <>
            <button
              onClick={() => fileInput.current?.click()}
              className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
              title={`上传到 ${cwd}`}
            >
              上传
            </button>
            <button
              onClick={() => void load()}
              className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
              title="重新读取（turn 结束时会自动刷新）"
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

      {err && (
        <div className="px-3 py-2 text-[11.5px] text-red border-b border-line break-words">
          {err}
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {!err && !loading && files.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-subtle leading-relaxed">
            {sessionId
              ? "这条对话还没产出文件。让 agent 写点东西，turn 结束后会出现在这里。"
              : "先发一条消息开始对话，产出的文件会出现在这里。"}
          </div>
        )}
        {files.map((f) => (
          <div
            key={f.path}
            className="flex items-start gap-2 px-3 py-[7px] hover:bg-fg/[0.03] transition-colors"
          >
            <input
              type="checkbox"
              checked={picked.has(f.path)}
              onChange={() => toggle(f.path)}
              className="mt-[3px] shrink-0 accent-blue"
              aria-label={`选择 ${f.name}`}
            />
            <button
              onClick={() => openInDock({ path: f.path, name: f.name })}
              className="flex-1 min-w-0 text-left"
              title={f.path}
            >
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[13px] text-fg truncate flex-1">
                  {f.name}
                </span>
                <span className="font-mono text-[10.5px] text-subtle tabular-nums shrink-0">
                  {humanSize(f.size)}
                </span>
              </div>
              <div className="font-mono text-[10.5px] text-subtle tabular-nums mt-0.5">
                {humanTime(f.mtimeMs)}
              </div>
            </button>
          </div>
        ))}
      </div>

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
              {pickedFiles.map((f) => (
                <div
                  key={f.path}
                  className="font-mono text-[11.5px] text-muted truncate"
                  title={f.path}
                >
                  {f.name}
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
    </div>
  );
}
