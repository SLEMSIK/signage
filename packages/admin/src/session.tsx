import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Me } from '@signage/shared';
import { api, UNAUTHORIZED_EVENT } from './api';

interface SessionValue {
  me: Me | null;
  loading: boolean;
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
  isAdmin: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (login: string, password: string) => {
    setMe(await api<Me>('/login', 'POST', { login, password }));
  }, []);

  const logout = useCallback(async () => {
    await api('/logout', 'POST').catch(() => undefined);
    setMe(null);
  }, []);

  return (
    <SessionContext.Provider value={{ me, loading, login, logout, isAdmin: me?.role === 'admin' }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}
