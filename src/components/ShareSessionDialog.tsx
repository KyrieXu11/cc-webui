import { useEffect, useMemo, useState } from "react";
import {
  getShares,
  listUserDirectory,
  setShares as setSharesApi,
  transferSession,
  type DirectoryUser,
} from "../lib/sessions";
import type { AgentProvider } from "../lib/settings";

interface Props {
  /** 只要一个 id —— owner 是问服务端的，不靠调用方传。顶栏那个入口手里
   *  就只有 sessionId，让它去别处凑一个 SessionSummary 只会两处不一致。 */
  sessionId: string;
  provider: AgentProvider;
  /** 给人看的标题，纯装饰。 */
  label?: string;
  onClose: () => void;
  /** 名单或归属真的变了才调；调用方据此刷新列表。 */
  onChanged: () => void;
}

export default function ShareSessionDialog({
  sessionId,
  provider,
  label,
  onClose,
  onChanged,
}: Props) {
  const [roster, setRoster] = useState<DirectoryUser[]>([]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [owner, setOwner] = useState<{ id: string; username: string } | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // 转交是不可撤销的（转出去之后普通用户就看不到了），所以要点两下：
  // 第一下选人，第二下确认。
  const [transferTo, setTransferTo] = useState("");
  const [confirmingTransfer, setConfirmingTransfer] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listUserDirectory(), getShares(sessionId)])
      .then(([users, state]) => {
        if (cancelled) return;
        setRoster(users);
        setAllowed(state.allowed);
        setOwner(state.owner);
        setPicked(new Set(state.shares.map((s) => s.userId)));
      })
      .catch(() => !cancelled && setError("读取共享名单失败"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 收件人里不出现 owner 自己：给 owner 发一条共享是死数据，显示出来还像是
  // "可以把 owner 踢出他自己的会话"。
  const candidates = useMemo(
    () => roster.filter((u) => u.id !== owner?.id),
    [roster, owner],
  );

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await setSharesApi(sessionId, [...picked], provider);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const doTransfer = async () => {
    setSaving(true);
    setError("");
    try {
      await transferSession(sessionId, transferTo, provider);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirmingTransfer(false);
    } finally {
      setSaving(false);
    }
  };

  const transferTarget = roster.find((u) => u.id === transferTo);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/55 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] bg-surface border border-line-strong rounded-xl overflow-hidden shadow-[0_28px_80px_-20px_rgba(0,0,0,0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-line gap-3">
          <div className="min-w-0">
            <h3 className="text-fg text-[15px] font-semibold tracking-tight">共享会话</h3>
            <div className="text-[12px] text-subtle truncate mt-0.5">
              {label || sessionId.slice(0, 8)}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-subtle hover:text-fg p-1 rounded transition-colors shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {!loading && !allowed ? (
          <div className="p-5 text-[12.5px] text-muted leading-relaxed">
            只有<strong className="text-fg">管理员</strong>能管理共享名单。
            <div className="text-[11.5px] text-subtle mt-2">
              共享给你的会话你照样能读、能接着聊——只是删不掉，也不能再转手给别人。
            </div>
          </div>
        ) : (
        <div className="p-5 space-y-5 max-h-[64vh] overflow-y-auto">
          <section>
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-subtle mb-2.5">
              共享给
            </div>
            {loading ? (
              <div className="text-[12.5px] text-subtle py-2">加载中…</div>
            ) : candidates.length === 0 ? (
              <div className="text-[12.5px] text-subtle py-2">
                除了你之外还没有别的账号。
              </div>
            ) : (
              <div className="space-y-1">
                {candidates.map((u) => (
                  <label
                    key={u.id}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-fg/[0.03] cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(u.id)}
                      onChange={() => toggle(u.id)}
                      className="accent-blue"
                    />
                    <span className="text-[13px] text-fg">{u.username}</span>
                    {u.role === "admin" && (
                      <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-subtle border border-line-strong rounded px-1 py-px">
                        admin
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11.5px] text-subtle leading-relaxed mt-3">
              被共享的人能读全部历史，也能在这个会话里接着聊；
              <span className="text-muted">不能删除，也不能再共享给别人。</span>
              他们发的每个 turn 仍然按他们自己的账号算权限——目录白名单、权限卡、
              bash 护栏都不变。
            </p>
          </section>

          <section className="border-t border-line pt-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-subtle mb-2.5">
              转交归属
            </div>
            <div className="flex items-center gap-2">
              <select
                value={transferTo}
                onChange={(e) => {
                  setTransferTo(e.target.value);
                  setConfirmingTransfer(false);
                }}
                className="flex-1 bg-raised border border-line-strong rounded-md px-2.5 py-1.5 text-[12.5px] text-fg focus:outline-none focus:border-fg/30 transition-colors"
              >
                <option value="">选择新的归属人…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
                  </option>
                ))}
              </select>
              <button
                disabled={!transferTo || saving}
                onClick={() =>
                  confirmingTransfer ? void doTransfer() : setConfirmingTransfer(true)
                }
                className={`h-[30px] px-3 rounded-md text-[12.5px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  confirmingTransfer
                    ? "border-amber/60 text-amber hover:bg-amber/10"
                    : "border-line-strong text-muted hover:text-fg hover:border-fg/25"
                }`}
              >
                {confirmingTransfer ? "确认转交" : "转交"}
              </button>
            </div>
            {confirmingTransfer && transferTarget && (
              <p className="text-[11.5px] text-amber leading-relaxed mt-2">
                转交后这条会话归 <strong>{transferTarget.username}</strong> 所有——
                他能读、能续、能删。你作为管理员照样看得到（决策 11）。
              </p>
            )}
          </section>

          {error && <div className="text-[12px] text-red">{error}</div>}
        </div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line bg-raised/40">
          <button
            onClick={onClose}
            className="h-8 px-3.5 rounded-md text-[12.5px] text-muted hover:text-fg transition-colors"
          >
            {allowed ? "取消" : "关闭"}
          </button>
          {allowed && (
            <button
              onClick={() => void save()}
              disabled={loading || saving}
              className="h-8 px-4 rounded-md text-[12.5px] bg-fg text-canvas font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "saving…" : "保存"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
