import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import LoginView from "./components/LoginView";
import {
  UNAUTHORIZED_EVENT,
  getMe,
  installUnauthorizedInterceptor,
  logout as postLogout,
  type AuthUser,
  type Me,
} from "./lib/auth";
import { configureCodexModels, modelCatalogVersion, subscribeModelCatalog, type AgentProvider } from "./lib/settings";
import type { UserDefaults } from "./lib/user-defaults";

type AuthValue = {
  user: AuthUser;
  allowedPaths: string[];
  allowedProviders: AgentProvider[];
  isAdmin: boolean;
  defaults: UserDefaults | null;
  modelCatalogRevision: number;
  signOut: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    // Only reachable from a component rendered outside the gate, which would be
    // a wiring mistake rather than a state the user can get into.
    throw new Error("useAuth must be used inside AuthGate");
  }
  return value;
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  // "loading" is a distinct state on purpose: rendering the workbench before we
  // know who is looking would flash the whole UI at an anonymous visitor before
  // snapping to the login screen.
  const [me, setMe] = useState<Me | "loading">("loading");
  const revision = useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion);
  const [catalogReadyFor, setCatalogReadyFor] = useState<string | null>(null);
  const accountId = me !== "loading" ? me.user?.id : null;
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch("/api/meta", { signal: AbortSignal.timeout(5000) });
        if (r.ok) { const data = await r.json(); if (!cancelled) configureCodexModels(data.models?.codex?.models, data.models?.codex?.source === "fallback" ? "fallback" : "cli-cache"); }
      } catch { /* retain conservative fallback / last valid catalogue */ }
      finally { if (!cancelled) setCatalogReadyFor(accountId); }
    };
    void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [accountId]);

  useEffect(() => {
    installUnauthorizedInterceptor();
    let cancelled = false;
    getMe().then((result) => {
      if (!cancelled) setMe(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A cookie can expire mid-session. Any /api/* 401 re-checks identity, which
  // drops us back to the login screen instead of leaving a dead UI behind.
  useEffect(() => {
    const onUnauthorized = () => {
      getMe().then(setMe);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // 管理员改了这个账号的默认模型 / effort 之后，开着不动的标签页要能拿到新值
  // （决策 46）——切回这个标签页时重新问一次。
  //
  // 两个「只」：
  // · 只接受带着 user 的结果。getMe() 把网络失败也报成 {user:null}，照单全收的话
  //   笔记本合盖醒来、或者服务正在重启的那几秒，切回标签页就会被踢到登录页。
  //   真过期了下一次 /api 调用会 401，那条路径（上面）会处理。
  // · 只在内容真的变了才 setMe，否则每次切回来整个工作台都要重渲染一遍。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      getMe().then((next) => {
        if (!next.user) return;
        setMe((cur) =>
          cur !== "loading" && JSON.stringify(cur) === JSON.stringify(next)
            ? cur
            : next,
        );
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const signOut = useCallback(() => {
    void postLogout().then(() => setMe({ user: null }));
  }, []);

  if (me === "loading" || (me.user && catalogReadyFor !== me.user.id)) {
    return <div className="h-full bg-canvas" />;
  }

  if (!me.user) {
    return <LoginView onSignedIn={setMe} />;
  }

  return (
    <AuthContext.Provider
      value={{
        user: me.user,
        allowedPaths: me.allowedPaths ?? [],
        allowedProviders: me.allowedProviders ?? (me.user.role === "admin" ? ["claude", "codex"] : ["claude"]),
        isAdmin: me.user.role === "admin",
        defaults: me.defaults ?? null,
        modelCatalogRevision: revision,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
