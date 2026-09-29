import type { AgentProvider } from "./settings";
import type { UserDefaults } from "./user-defaults";

export type Role = "admin" | "user";

export type AuthUser = {
  id: string;
  username: string;
  role: Role;
  createdAt: number;
};

export type Me = {
  user: AuthUser | null;
  allowedPaths?: string[];
  allowedProviders?: AgentProvider[];
  // 管理员给这个账号设的默认模型 / effort；没设是 null（见 user-defaults.ts）。
  defaults?: UserDefaults | null;
};

export async function getMe(): Promise<Me> {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return { user: null };
    return (await res.json()) as Me;
  } catch {
    return { user: null };
  }
}

export async function login(
  username: string,
  password: string,
): Promise<{ ok: true; me: Me } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return { ok: false, error: "无法连接服务" };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: (data as { error?: string }).error ?? "登录失败" };
  }
  return { ok: true, me: data as Me };
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
}

// ─── session expiry, handled in one place ───────────────────────────────────
//
// There are ~29 fetch call sites across src/lib and the components, with no
// shared wrapper. Rather than teach each of them about 401, wrap window.fetch
// once: any /api/* response of 401 means the cookie is gone or expired, and the
// gate should fall back to the login screen. This also covers call sites added
// later, which a per-caller change would not.

export const UNAUTHORIZED_EVENT = "cc-webui:unauthorized";

let installed = false;

export function installUnauthorizedInterceptor(): void {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    if (res.status === 401) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      // /api/auth/me answers 200 with {user:null} when anonymous, so a 401 here
      // is always a real expiry rather than the normal signed-out state.
      if (url.includes("/api/")) {
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      }
    }
    return res;
  };
}
