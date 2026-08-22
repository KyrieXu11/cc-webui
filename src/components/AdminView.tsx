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
        <nav className="flex gap-1 ml-4">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`h-8 px-3 rounded-md text-[12.5px] transition-colors ${
                section === id
                  ? "bg-raised text-fg"
                  : "text-muted hover:text-fg hover:bg-fg/5"
              }`}
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
  const adminCount = users.filter((u) => u.role === "admin").length;

  return (
    <>
      <SectionHead
        title="用户"
        hint="目录白名单决定用户能在哪些文件夹里工作。它是使用便利，不是安全隔离——agent 有 shell，能读写服务进程用户能碰的一切。"
      />

      <div className="border border-line rounded-lg overflow-hidden mb-7">
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

      <SectionHead title="新建用户" hint="新用户默认不能打开任何目录。" />
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
        <Primary
          disabled={busy || !newName.trim() || !newPw}
          onClick={() =>
            onRun(async () => {
              await createAdminUser({
                username: newName.trim(),
                password: newPw,
                role: newRole,
                allowedPaths: [],
              });
              setNewName("");
              setNewPw("");
              setNewRole("user");
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
          onClick={() =>
            onRun(() =>
              patchAdminUser(user.id, {
                role: user.role === "admin" ? "user" : "admin",
              }),
            )
          }
        >
          {user.role === "admin" ? "降为普通" : "设为管理员"}
        </Ghost>
        <button
          disabled={busy || isSelf || isLastAdmin}
          title={isSelf ? "不能删除自己" : isLastAdmin ? "不能删除唯一的管理员" : undefined}
          onClick={() => {
            if (
              !confirm(
                `删除 ${user.username}？他的会话不会被删除，但会变成无主，之后只有管理员可见。`,
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

      <div className="border border-line rounded-lg overflow-hidden mb-7">
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
      className={`${small ? "h-8" : "h-9"} px-2.5 rounded-md bg-surface border border-line-strong ${
        mono ? "font-mono text-[12.5px]" : "text-[13px]"
      } text-fg outline-none focus:border-fg/30 transition-colors`}
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
      className={`${small ? "h-8 px-3 text-[12px]" : "h-9 px-3.5 text-[12.5px]"} rounded-md bg-fg text-canvas font-medium disabled:opacity-30 hover:opacity-90 transition-opacity`}
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
      className="h-8 px-3 rounded-md bg-surface border border-line-strong text-[12px] text-fg hover:bg-raised disabled:opacity-30 transition-colors"
    >
      {children}
    </button>
  );
}
