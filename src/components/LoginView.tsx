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
      <form onSubmit={submit} className="soft-panel w-full max-w-[400px] p-8 max-md:p-6">
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
            className="w-full h-10 px-3 soft-input text-[13.5px]"
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
            className="w-full h-10 px-3 soft-input text-[13.5px]"
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
          className="soft-primary w-full h-10 text-[13.5px] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
