import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@shared/types";
import { authApi, type GuestCheckoutResult } from "@/api/endpoints";
import { guestSession } from "@/lib/guestSession";
import { ApiRequestError, tokenStore } from "@/api/http";
import { authEvents } from "@/lib/authEvents";
import { queryKeys } from "@/api/queryKeys";
import { useQueryClient } from "@tanstack/react-query";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  /**
   * Guest session (ТЗ §5): the buyer has a scoped token instead of a password.
   * `isGuest` drives the "save your tickets" prompt on the checkout page.
   */
  isGuest: boolean;
  login: (input: { email: string; password: string }) => Promise<User>;
  register: (input: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    referralCode?: string;
  }) => Promise<User>;
  /** Starts a guest session from the checkout response. */
  startGuestSession: (result: GuestCheckoutResult) => void;
  /** Sets a password on the guest account (keeps the tickets). */
  claimGuest: (password: string) => Promise<User>;
  /** Passwordless sign-in: exchanges a magic-link token for a session. */
  magicLink: (token: string) => Promise<User>;
  /** Re-reads the profile (phone verification, loyalty, plan changes). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Refresh this many ms before the access token actually expires. */
const REFRESH_LEAD_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [isGuest, setIsGuest] = useState<boolean>(() => Boolean(guestSession.get()));
  const refreshTimer = useRef<number | null>(null);
  const queryClient = useQueryClient();

  const scheduleRefresh = useCallback((expiresAt: number | undefined) => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    if (!expiresAt) return;
    const delay = Math.max(30_000, expiresAt - Date.now() - REFRESH_LEAD_MS);
    refreshTimer.current = window.setTimeout(() => {
      void authApi
        .me()
        .then(({ user: fresh }) => setUser(fresh))
        .catch(() => {
          tokenStore.clear();
          setUser(null);
          setStatus("anonymous");
        });
    }, delay);
  }, []);

  const bootstrap = useCallback(async () => {
    if (!tokenStore.getRefresh()) {
      setStatus("anonymous");
      return;
    }
    try {
      const { user: current } = await authApi.me();
      setUser(current);
      setStatus("authenticated");
    } catch (error) {
      // Only a 401 means the session is truly dead. Network/server errors
      // must NOT wipe the tokens — otherwise going offline once logs the
      // user out forever.
      if (error instanceof ApiRequestError && error.status === 401) {
        tokenStore.clear();
      }
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void bootstrap();
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [bootstrap]);

  // Any request that dies with a 401 flips the UI back to "signed out", so
  // ProtectedRoute can bounce the user to /login and straight back after.
  useEffect(
    () =>
      authEvents.onUnauthorized(() => {
        if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
        setUser(null);
        setStatus("anonymous");
        queryClient.removeQueries({ queryKey: ["bookings"] });
        queryClient.removeQueries({ queryKey: queryKeys.me() });
      }),
    [queryClient],
  );

  const login = useCallback<AuthContextValue["login"]>(
    async (input) => {
      const session = await authApi.login(input);
      setUser(session.user);
      setStatus("authenticated");
      scheduleRefresh(session.expiresAt);
      // A fresh session may own bookings the previous one could not read.
      await queryClient.invalidateQueries({ queryKey: ["bookings"] });
      return session.user;
    },
    [queryClient, scheduleRefresh],
  );

  const register = useCallback<AuthContextValue["register"]>(
    async (input) => {
      const session = await authApi.register(input);
      // A real account supersedes any guest session started earlier.
      guestSession.clear();
      setIsGuest(false);
      setUser(session.user);
      setStatus("authenticated");
      scheduleRefresh(session.expiresAt);
      return session.user;
    },
    [scheduleRefresh],
  );

  const startGuestSession = useCallback<AuthContextValue["startGuestSession"]>((result) => {
    guestSession.set(result.guest.token, result.booking.id);
    setIsGuest(true);
    setUser(result.user);
    setStatus("authenticated");
  }, []);

  const claimGuest = useCallback<AuthContextValue["claimGuest"]>(
    async (password) => {
      const guest = guestSession.get();
      if (!guest) throw new Error("No guest session to claim");
      const session = await authApi.claimGuest({ guestToken: guest.token, password });
      guestSession.clear();
      setIsGuest(false);
      setUser(session.user);
      setStatus("authenticated");
      scheduleRefresh(session.expiresAt);
      return session.user;
    },
    [scheduleRefresh],
  );

  const magicLink = useCallback<AuthContextValue["magicLink"]>(
    async (token) => {
      const session = await authApi.magicLinkVerify(token);
      guestSession.clear();
      setIsGuest(false);
      setUser(session.user);
      setStatus("authenticated");
      scheduleRefresh(session.expiresAt);
      return session.user;
    },
    [scheduleRefresh],
  );

  const refresh = useCallback(async () => {
    try {
      const { user: fresh } = await authApi.me();
      setUser(fresh);
      setStatus("authenticated");
    } catch {
      /* keep the current state — the caller decides how to react */
    }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    guestSession.clear();
    setIsGuest(false);
    setUser(null);
    setStatus("anonymous");
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    // Never leak one user's tickets to the next one.
    queryClient.removeQueries({ queryKey: ["bookings"] });
    queryClient.removeQueries({ queryKey: queryKeys.me() });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isGuest,
      login,
      register,
      startGuestSession,
      claimGuest,
      magicLink,
      refresh,
      logout,
    }),
    [user, status, isGuest, login, register, startGuestSession, claimGuest, magicLink, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
