/** localStorage с защитой: в киоске он может быть недоступен или переполнен. */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* нет места — переживём */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const KEYS = {
  token: 'signage.token',
  lastState: 'signage.lastState',
  lastReloadDay: 'signage.lastReloadDay',
} as const;
