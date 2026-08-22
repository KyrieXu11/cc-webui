import { useState } from "react";
import { login, type Me } from "../lib/auth";

interface Props {
  onSignedIn: (me: Me) => void;
}

export default function LoginView({ onSignedIn }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    const result = await login(username.trim(), password);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setPassword("");
      return;
    }
    onSignedIn(result.me);
  };

  return (
    <div className="flex h-full items-center justify-center bg-canvas px-6">
      <form onSubmit={submit} className="w-full max-w-[340px]">
        <div className="mb-8">
          <h1 className="text-fg text-[19px] font-semibold tracking-tight">
            cc-webui
          </h1>
          <p className="text-muted text-[13px] mt-1.5">登录以继续</p>
        </div>

        <label className="block mb-3">
          <span className="block text-[11.5px] font-mono uppercase tracking-[0.08em] text-subtle mb-1.5">
            用户名
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            className="w-full h-10 px-3 rounded-lg bg-surface border border-line-strong text-[13.5px] text-fg outline-none focus:border-fg/30 transition-colors"
          />
        </label>

        <label className="block mb-5">
          <span className="block text-[11.5px] font-mono uppercase tracking-[0.08em] text-subtle mb-1.5">
            密码
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full h-10 px-3 rounded-lg bg-surface border border-line-strong text-[13.5px] text-fg outline-none focus:border-fg/30 transition-colors"
          />
        </label>

        {error && (
          <div className="mb-4 text-[12.5px] text-amber" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="w-full h-10 rounded-lg bg-fg text-canvas text-[13.5px] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
