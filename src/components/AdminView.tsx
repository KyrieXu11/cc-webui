import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../AuthGate";
import {
  claimUnowned,
  createAdminUser,
  deleteAdminUser,
  listAdminUsers,
  listOpenedProjects,
  listSenderMappings,
  patchAdminUser,
  putSenderMapping,
  type AdminUser,
  type OpenedRecord,
  type SenderMapping,
} from "../lib/admin";
import type { Role } from "../lib/auth";
import {
  EFFORT_OPTIONS,
  availableEffortOptions,
  clampEffort,
  modelOptionsForProvider,
  defaultModelForProvider,
  type EffortLevel,
  type AgentProvider,
  PROVIDER_OPTIONS,
} from "../lib/settings";

interface Props {
  onClose: () => void;
}

type Section = "users" | "projects" | "feishu";

const SECTIONS: Array<[Section, string]> = [
  ["users", "用户"],
  ["projects", "打开记录"],
  ["feishu", "飞书成员"],
];

export default function AdminView({ onClose }: Props) {
  const { user: me } = useAuth();
  const [section, setSection] = useState<Section>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [projects, setProjects] = useState<OpenedRecord[]>([]);
  const [senders, setSenders] = useState<SenderMapping[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [u, p, s] = await Promise.all([
        listAdminUsers(),
        listOpenedProjects(),
        listSenderMappings(),
      ]);
      setUsers(u);
      setProjects(p);
      setSenders(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unownedCount = projects.filter((p) => !p.userId).length;

  return (
    <div className="flex flex-col h-full bg-canvas min-w-0">
      <header className="flex items-center gap-4 px-6 h-14 border-b border-line shrink-0">
        <button
          onClick={onClose}
          className="text-[13px] text-muted hover:text-fg transition-colors"
        >
          ← 返回
        </button>
        <h1 className="text-fg text-[14.5px] font-semibold tracking-tight">管理</h1>
        <nav className="soft-segmented flex ml-4" aria-label="管理分类">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              aria-pressed={section === id}
              className={`h-8 px-3 rounded-control text-[12.5px] ${section === id ? "bg-surface text-fg shadow-chip" : "text-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[860px] mx-auto px-6 py-7">
          {error && (
            <div className="mb-5 px-3 py-2 rounded-md bg-red/10 text-[12.5px] text-red">
              {error}
            </div>
          )}

          {section === "users" && (
            <UsersSection users={users} meId={me.id} busy={busy} onRun={run} />
          )}
          {section === "projects" && (
            <ProjectsSection
              records={projects}
              unownedCount={unownedCount}
              busy={busy}
              onRun={run}
            />
          )}
          {section === "feishu" && (
            <FeishuSection
              mappings={senders}
              users={users}
              busy={busy}
              onRun={run}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── users ───────────────────────────────────────────────────────────────────

function UsersSection({
  users,
  meId,
  busy,
  onRun,
}: {
  users: AdminUser[];
  meId: string;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [newName, setNewName] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newRole, setNewRole] = useState<Role>("user");
  const [newWorkspace, setNewWorkspace] = useState(true);
  const adminCount = users.filter((u) => u.role === "admin").length;

  return (
    <>
      <SectionHead
        title="用户"
        hint="可用 AI 是服务端限制；默认 AI / 模型 / effort 不是锁定值。Codex CLI 不提供逐工具确认，开放后工具写入会自动执行（普通账号仍不能选 Bypass）。目录白名单决定用户能在哪些文件夹里工作。它是使用便利，不是安全隔离——agent 有 shell，能读写服务进程用户能碰的一切。默认模型 / effort 只是默认值：对方下次打开页面（或切回这个标签页）时会换成你设的，之后自己改的会保留，直到你再保存。"
      />

      <div className="soft-panel overflow-hidden mb-7">
        {users.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            isSelf={u.id === meId}
            isLastAdmin={u.role === "admin" && adminCount === 1}
            busy={busy}
            onRun={onRun}
          />
        ))}
      </div>

      <SectionHead
        title="新建用户"
        hint="普通用户默认会拿到一个属于自己的空工作区，除此之外打不开任何目录。"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Field value={newName} onChange={setNewName} placeholder="用户名" width={150} />
        <Field
          value={newPw}
          onChange={setNewPw}
          placeholder="密码"
          width={150}
          type="password"
        />
        <select
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as Role)}
          className="h-9 px-2 rounded-md bg-surface border border-line-strong text-[13px] text-fg outline-none"
        >
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        {newRole === "user" && (
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted select-none">
            <input
              type="checkbox"
              checked={newWorkspace}
              onChange={(e) => setNewWorkspace(e.target.checked)}
              className="accent-blue"
            />
            建一个工作区
          </label>
        )}
        <Primary
          disabled={busy || !newName.trim() || !newPw}
          onClick={() =>
            onRun(async () => {
              await createAdminUser({
                username: newName.trim(),
                password: newPw,
                role: newRole,
                allowedPaths: [],
                workspace: newWorkspace,
              });
              setNewName("");
              setNewPw("");
              setNewRole("user");
              setNewWorkspace(true);
            })
          }
        >
          创建
        </Primary>
      </div>
    </>
  );
}

function UserRow({
  user,
  isSelf,
  isLastAdmin,
  busy,
  onRun,
}: {
  user: AdminUser;
  isSelf: boolean;
  isLastAdmin: boolean;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
}) {
  const joined = user.allowedPaths.join("\n");
  const [draft, setDraft] = useState(joined);
  const [pw, setPw] = useState("");
  useEffect(() => setDraft(joined), [joined]);

  return (
    <div className="border-b border-line last:border-b-0 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] text-fg font-medium">{user.username}</span>
        {user.role === "admin" && (
          <span className="text-[10px] font-mono uppercase tracking-[0.08em] px-1.5 py-0.5 rounded bg-amber/15 text-amber">
            admin
          </span>
        )}
        {isSelf && <span className="text-[11px] text-subtle">你</span>}
        <span className="text-[11.5px] text-subtle ml-auto">
          {user.ownedResources} 个会话
        </span>
      </div>

      {user.workspace ? (
        <div className="flex items-center gap-2 mt-2.5">
          <span
            title="系统建的工作区。它是白名单里的一条，但由服务端维护，所以不在下面的文本框里。"
            className="font-mono text-[11.5px] px-2 py-1 rounded bg-raised text-subtle border border-line truncate"
          >
            {user.workspace.dir}
          </span>
          <button
            disabled={busy}
            onClick={() =>
              onRun(() => patchAdminUser(user.id, { removeWorkspace: true }))
            }
            className="text-[11.5px] text-subtle hover:text-fg disabled:opacity-40 shrink-0"
          >
            移除工作区
          </button>
        </div>
      ) : (
        user.role === "user" && (
          <div className="mt-2.5">
            <button
              disabled={busy}
              onClick={() =>
                onRun(() => patchAdminUser(user.id, { createWorkspace: true }))
              }
              className="text-[11.5px] text-subtle hover:text-fg disabled:opacity-40"
            >
              + 建一个工作区
            </button>
          </div>
        )
      )}

      <DefaultsRow user={user} busy={busy} onRun={onRun} />

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.max(2, draft.split("\n").length)}
        spellCheck={false}
        placeholder="每行一个目录，如 ~/code/**"
        title={"~/code 含子树 · ~/code/* 只含直接子目录 · ~/code/** 含任意层级但不含自身 · ** 全部"}
        className="w-full mt-2.5 px-2.5 py-2 rounded-md bg-surface border border-line-strong text-[12.5px] font-mono text-fg outline-none focus:border-fg/30 resize-y"
      />

      <div className="flex items-center gap-2 mt-2.5">
        <Primary
          small
          disabled={busy || draft === joined}
          onClick={() =>
            onRun(() =>
              patchAdminUser(user.id, {
                allowedPaths: draft.split("\n").map((l) => l.trim()).filter(Boolean),
              }),
            )
          }
        >
          保存目录
        </Primary>
        <Field
          value={pw}
          onChange={setPw}
          placeholder="新密码"
          width={120}
          type="password"
          small
        />
        <Ghost
          disabled={busy || !pw}
          onClick={() =>
            onRun(async () => {
              await patchAdminUser(user.id, { password: pw });
              setPw("");
            })
          }
        >
          重置
        </Ghost>
        <Ghost
          disabled={busy || isLastAdmin}
          title={isLastAdmin ? "不能降级唯一的管理员" : undefined}
          onClick={() => {
            // Demotion rewrites the whitelist (decision 29). Destructive and
            // one-way — promotion does not restore it — so say so first.
            if (user.role === "admin") {
              const n = user.allowedPaths.length;
              const ok = window.confirm(
                `降级为普通用户会把 ${user.username} 的目录白名单替换成只剩一个工作区。` +
                  (n > 0 ? `现有的 ${n} 条会丢失，` : "") +
                  "升回管理员时不会自动恢复。继续？",
              );
              if (!ok) return;
            }
            void onRun(() =>
              patchAdminUser(user.id, {
                role: user.role === "admin" ? "user" : "admin",
              }),
            );
          }}
        >
          {user.role === "admin" ? "降为普通" : "设为管理员"}
        </Ghost>
        <button
          disabled={busy || isSelf || isLastAdmin}
          title={isSelf ? "不能删除自己" : isLastAdmin ? "不能删除唯一的管理员" : undefined}
          onClick={() => {
            if (
              !confirm(
                `删除 ${user.username}？他的会话不会被删除，但会变成无主，之后只有管理员可见。` +
                  (user.workspace
                    ? `\n工作区 ${user.workspace.dir} 也会保留在磁盘上，要清理请自己删。`
                    : ""),
              )
            ) {
              return;
            }
            void onRun(() => deleteAdminUser(user.id));
          }}
          className="h-8 px-3 ml-auto rounded-md text-[12px] text-red hover:bg-red/10 disabled:opacity-30 transition-colors"
        >
          删除
        </button>
      </div>
    </div>
  );
}

// 可用 provider 是限制；默认 AI / 模型 / effort 每个版本只套用一次。
function DefaultsRow({
  user,
  busy,
  onRun,
}: {
  user: AdminUser;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
}) {
  const savedProviders = user.allowedProviders ?? (user.role === "admin" ? ["claude", "codex"] : ["claude"]);
  const savedProvider = user.defaults?.provider ?? (savedProviders[0] as AgentProvider);
  const [providers, setProviders] = useState<AgentProvider[]>(savedProviders as AgentProvider[]);
  const [provider, setProvider] = useState<AgentProvider>(savedProvider);
  const savedModel = user.defaults?.model ?? "";
  const savedEffort = user.defaults?.effort ?? "";
  const [model, setModel] = useState(savedModel);
  const [effort, setEffort] = useState<string>(savedEffort);
  useEffect(() => {
    setProviders(savedProviders as AgentProvider[]); setProvider(savedProvider);
    setModel(savedModel);
    setEffort(savedEffort);
  }, [savedModel, savedEffort, savedProvider, savedProviders.join(",")]);

  // 没指定模型时对方用什么模型都有可能，所以五档全给；指定了就只给那个模型有的档。
  const efforts = availableEffortOptions(model || defaultModelForProvider(provider));
  const dirty = model !== savedModel || effort !== savedEffort || provider !== savedProvider || providers.join(",") !== savedProviders.join(",");

  const pickModel = (next: string) => {
    setModel(next);
    // 换到没有当前这一档的模型（Sonnet 没有 xHigh）就往下落，和输入框里换模型同一条规则。
    if (next && effort && !availableEffortOptions(next).some((o) => o.id === effort)) {
      setEffort(clampEffort(effort as EffortLevel, next));
    }
  };

  const selectClass =
    "h-8 px-2 rounded-md bg-surface border border-line-strong text-[12.5px] text-fg outline-none";

  return (
    <div className="flex flex-wrap items-center gap-2 mt-2.5">
      <span className="text-[12px] text-muted">可用 AI</span>
      {PROVIDER_OPTIONS.map(p => <label key={p.id} className="flex items-center gap-1 text-[12px] text-muted">
        <input type="checkbox" checked={providers.includes(p.id)} disabled={busy || user.role === "admin"}
          onChange={e => {
            const next = e.target.checked ? [...providers, p.id] : providers.filter(v => v !== p.id);
            if (!next.length) return;
            setProviders(next);
            if (!next.includes(provider)) { setProvider(next[0]); setModel(""); setEffort(""); }
          }} />{p.label}
      </label>)}
      <label className="flex items-center gap-1 text-[12px] text-muted">默认 AI
        <select className={selectClass} value={provider} onChange={e => { setProvider(e.target.value as AgentProvider); setModel(""); setEffort(""); }}>
          {PROVIDER_OPTIONS.filter(p => providers.includes(p.id)).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-muted">
        默认模型
        <select
          value={model}
          onChange={(e) => pickModel(e.target.value)}
          className={selectClass}
        >
          <option value="">不设置</option>
          {modelOptionsForProvider(provider).map((m) => (
            <option key={m.id} value={m.id}>
              {m.pinned || provider === "codex" ? m.label : `${m.label}（跟随最新）`}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-muted">
        默认 effort
        <select
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          className={selectClass}
        >
          <option value="">不设置</option>
          {efforts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <Ghost
        disabled={busy || !dirty}
        onClick={() =>
          onRun(() =>
            patchAdminUser(user.id, {
              allowedProviders: providers,
              defaults: { provider, model: model || null, effort: effort || null },
            }),
          )
        }
      >
        保存 AI 设置
      </Ghost>
    </div>
  );
}

// ─── opened projects ─────────────────────────────────────────────────────────

function ProjectsSection({
  records,
  unownedCount,
  busy,
  onRun,
}: {
  records: OpenedRecord[];
  unownedCount: number;
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
}) {
  return (
    <>
      <SectionHead title="打开记录" hint="每个用户最近打开过的目录。" />

      {unownedCount > 0 && (
        <div className="flex items-center gap-3 mb-4 px-3 py-2.5 rounded-lg bg-surface border border-line">
          <span className="text-[12.5px] text-muted flex-1">
            有 {unownedCount} 条记录早于账号体系，暂无归属。
          </span>
          <Primary
            small
            disabled={busy}
            onClick={() => onRun(async () => void (await claimUnowned()))}
          >
            归到我名下
          </Primary>
        </div>
      )}

      <div className="border border-line rounded-lg overflow-hidden">
        {records.map((r, i) => (
          <div
            key={`${r.userId}:${r.path}:${i}`}
            className="flex items-center gap-3 px-4 py-2 border-b border-line last:border-b-0"
          >
            <span
              className={`text-[12px] w-[100px] shrink-0 truncate ${
                r.userId ? "text-fg" : "text-subtle"
              }`}
            >
              {r.userId ? r.username : "无主"}
            </span>
            <span
              className="text-[12.5px] font-mono text-muted truncate flex-1"
              title={r.path}
            >
              {r.path}
            </span>
            <span className="text-[11px] text-subtle shrink-0">
              {new Date(r.lastUsed).toLocaleDateString()}
            </span>
          </div>
        ))}
        {records.length === 0 && <Empty>还没有记录</Empty>}
      </div>
    </>
  );
}

// ─── feishu senders ──────────────────────────────────────────────────────────

function FeishuSection({
  mappings,
  users,
  busy,
  onRun,
}: {
  mappings: SenderMapping[];
  users: AdminUser[];
  busy: boolean;
  onRun: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [openId, setOpenId] = useState("");
  const [userId, setUserId] = useState("");

  return (
    <>
      <SectionHead
        title="飞书成员"
        hint="把飞书的 open_id 对应到账号。没有映射的人 @ 机器人会被拒绝。"
      />

      <div className="soft-panel overflow-hidden mb-7">
        {mappings.map((m) => (
          <div
            key={m.openId}
            className="flex items-center gap-3 px-4 py-2 border-b border-line last:border-b-0"
          >
            <span
              className="text-[12px] font-mono text-muted truncate flex-1"
              title={m.openId}
            >
              {m.openId}
            </span>
            <span className="text-[12.5px] text-fg w-[100px] truncate">
              {m.username}
            </span>
            <Ghost disabled={busy} onClick={() => onRun(() => putSenderMapping(m.openId, ""))}>
              解除
            </Ghost>
          </div>
        ))}
        {mappings.length === 0 && <Empty>还没有映射，飞书消息目前全部被拒绝</Empty>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Field value={openId} onChange={setOpenId} placeholder="ou_… / oc_…" width={220} mono />
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="h-9 px-2 rounded-md bg-surface border border-line-strong text-[13px] text-fg outline-none"
        >
          <option value="">选择账号…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <Primary
          disabled={busy || !openId.trim() || !userId}
          onClick={() =>
            onRun(async () => {
              await putSenderMapping(openId.trim(), userId);
              setOpenId("");
              setUserId("");
            })
          }
        >
          添加
        </Primary>
      </div>
    </>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-fg text-[13.5px] font-semibold tracking-tight">{title}</h2>
      {hint && (
        <p className="text-[11.5px] leading-relaxed text-subtle mt-1 max-w-[620px]">
          {hint}
        </p>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-4 text-[12.5px] text-subtle">{children}</div>;
}

function Field({
  value,
  onChange,
  placeholder,
  width,
  type,
  small,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number;
  type?: string;
  small?: boolean;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={width ? { width } : undefined}
      className={`soft-input ${small ? "h-8" : "h-9"} px-2.5 ${
        mono ? "font-mono text-[12.5px]" : "text-[13px]"
      }`}
    />
  );
}

function Primary({
  children,
  onClick,
  disabled,
  small,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`soft-primary ${small ? "h-8 px-3 text-[12px]" : "h-9 px-3.5 text-[12.5px]"} disabled:opacity-30`}
    >
      {children}
    </button>
  );
}

function Ghost({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="soft-button h-8 px-3 text-[12px] disabled:opacity-30"
    >
      {children}
    </button>
  );
}
