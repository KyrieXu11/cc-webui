import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
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

type AuthValue = {
  user: AuthUser;
  allowedPaths: string[];
  isAdmin: boolean;
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

  const signOut = useCallback(() => {
    void postLogout().then(() => setMe({ user: null }));
  }, []);

  if (me === "loading") {
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
        isAdmin: me.user.role === "admin",
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
