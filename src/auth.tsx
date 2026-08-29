import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import type { CurrentUser } from "./api";
import { isDesktop } from "./printer";

type AuthState =
  | { kind: "loading" }
  | { kind: "browser" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; user: CurrentUser };

type AuthContextValue = {
  state: AuthState;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Applies a just-changed password to the in-memory session without a re-login. */
  clearMustChangePassword: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    if (!isDesktop()) {
      setState({ kind: "browser" });
      return;
    }
    let cancelled = false;
    api
      .currentUser()
      .then((u) => !cancelled && setState(u ? { kind: "signedIn", user: u } : { kind: "signedOut" }))
      .catch(() => !cancelled && setState({ kind: "signedOut" }));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const user = await api.login(username, password);
    setState({ kind: "signedIn", user });
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setState({ kind: "signedOut" });
  }, []);

  const clearMustChangePassword = useCallback(() => {
    setState((s) => (s.kind === "signedIn" ? { kind: "signedIn", user: { ...s.user, must_change_password: false } } : s));
  }, []);

  return (
    <AuthContext.Provider value={{ state, login, logout, clearMustChangePassword }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** In browser dev mode there is no backend session, so every page is reachable. */
export function useCurrentUser(): CurrentUser | null {
  const { state } = useAuth();
  if (state.kind === "signedIn") return state.user;
  if (state.kind === "browser") return { id: 0, username: "dev", display_name: "Dev", role: "admin", must_change_password: false };
  return null;
}
