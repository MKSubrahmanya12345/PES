'use client';

/**
 * Client session provider — /api/auth/me on mount, shared across the app.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface ClientUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  plan: string;
  orgId: string | null;
  usage?: {
    projectsThisMonth: number;
    llmCallsThisMonth: number;
    simSessionsToday: number;
    monthKey: string;
    dayKey: string;
  };
}

export interface ClientPlan {
  id: string;
  name: string;
  priceMonthlyUsd: number | null;
  features: string[];
  projectsPerMonth: number;
}

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  user: ClientUser | null;
  plan: ClientPlan | null;
  usage: {
    projectsThisMonth: number;
    llmCallsThisMonth: number;
    simSessionsToday: number;
    storedProjects: number;
    concurrentRuns: number;
  } | null;
  plans: ClientPlan[];
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<ClientUser | null>(null);
  const [plan, setPlan] = useState<ClientPlan | null>(null);
  const [usage, setUsage] = useState<AuthState['usage']>(null);
  const [plans, setPlans] = useState<ClientPlan[]>([]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' });
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: {
          authenticated?: boolean;
          user?: ClientUser | null;
          plan?: ClientPlan;
          usage?: AuthState['usage'];
          plans?: ClientPlan[];
        };
      };
      if (!response.ok || !payload.ok || !payload.data) {
        setAuthenticated(false);
        setUser(null);
        setPlan(null);
        setUsage(null);
        return;
      }
      setAuthenticated(Boolean(payload.data.authenticated));
      setUser(payload.data.user ?? null);
      setPlan(payload.data.plan ?? null);
      setUsage(payload.data.usage ?? null);
      setPlans(payload.data.plans ?? []);
    } catch {
      setAuthenticated(false);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthenticated(false);
    setUser(null);
    setPlan(null);
    setUsage(null);
    await refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ loading, authenticated, user, plan, usage, plans, refresh, signOut }),
    [loading, authenticated, user, plan, usage, plans, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      loading: false,
      authenticated: false,
      user: null,
      plan: null,
      usage: null,
      plans: [],
      refresh: async () => undefined,
      signOut: async () => undefined,
    };
  }
  return ctx;
}
