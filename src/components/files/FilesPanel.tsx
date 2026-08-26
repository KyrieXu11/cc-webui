import { useCallback, useEffect, useState } from "react";
import {
  humanSize,
  humanTime,
  listConversationFiles,
  type ConversationFile,
} from "../../lib/files";

// 取件台的列表：本对话文件（这条会话的 turn 亲手创建或改动过的文件）。
//
// 刷新时机是 turn 结束（父级 refreshKey 在 App 的 setSessionsRefreshKey 处一起
// 前进）+ 手动按钮。**刻意没有轮询、没有 watcher**：registry 是在 turn 收尾写的，
// turn 跑一半时文件还在变，列出来只会闪；watcher 那条路在 launchd + macOS TCC
// 的雷区里（docs/file-manager.md）。

interface Props {
  sessionId: string | null;
  /** 变化即重新拉取（turn 结束时前进）。 */
  refreshKey?: number;
  onPreviewFile?: (absPath: string, relPath: string) => void;
}

export default function FilesPanel({
  sessionId,
  refreshKey,
  onPreviewFile,
}: Props) {
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      setFiles(await listConversationFiles(sessionId));
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-line">
        <span className="font-mono text-[11px] text-subtle flex-1">
          {loading ? "查找中…" : `${files.length} 个文件`}
        </span>
        <button
          onClick={() => void load()}
          className="font-mono text-[11px] text-muted hover:text-fg border border-line hover:border-fg/30 rounded px-2 py-0.5 transition-colors"
          title="重新读取（turn 结束时会自动刷新）"
        >
          刷新
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {err && (
          <div className="px-4 py-3 text-[12px] text-red font-mono">{err}</div>
        )}
        {!err && !loading && files.length === 0 && (
          <div className="px-4 py-3 text-[12px] text-subtle leading-relaxed">
            {sessionId
              ? "这条对话还没产出文件。让 agent 写点东西，turn 结束后会出现在这里。"
              : "先发一条消息开始对话，产出的文件会出现在这里。"}
          </div>
        )}
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => onPreviewFile?.(f.path, f.name)}
            className="w-full text-left px-4 py-[7px] hover:bg-fg/[0.03] transition-colors group"
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
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="font-mono text-[10.5px] text-subtle tabular-nums shrink-0">
                {humanTime(f.mtimeMs)}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
