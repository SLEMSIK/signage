import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminEvent, ScreenDto, SystemStatus } from '@signage/shared';
import { api } from './api';
import { setServerTimezone } from './format';

type Entity = Extract<AdminEvent, { type: 'changed' }>['entity'];

interface LiveValue {
  status: SystemStatus | null;
  screens: ScreenDto[] | null;
  pendingCodes: number;
  connected: boolean;
  /** Подписка на «данные изменились» — страницы перезагружают свои списки. */
  onChanged(entity: Entity, fn: () => void): () => void;
  refreshScreens(): void;
}

const LiveContext = createContext<LiveValue | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [screens, setScreens] = useState<ScreenDto[] | null>(null);
  const [pendingCodes, setPending] = useState(0);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Map<Entity, Set<() => void>>());

  const refreshScreens = () => {
    api<ScreenDto[]>('/screens')
      .then(setScreens)
      .catch(() => undefined);
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 1000;
    let timer: number | undefined;

    const loadStatus = () =>
      api<SystemStatus>('/status')
        .then((s) => {
          setServerTimezone(s.timezone);
          setStatus(s);
        })
        .catch(() => undefined);

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/admin/ws`);
      ws.onopen = () => {
        retry = 1000;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(String(e.data)) as AdminEvent;
        if (ev.type === 'screens') setScreens(ev.screens);
        else if (ev.type === 'status') {
          setServerTimezone(ev.status.timezone);
          setStatus(ev.status);
        } else if (ev.type === 'pending') setPending(ev.codes);
        else if (ev.type === 'changed') listeners.current.get(ev.entity)?.forEach((fn) => fn());
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };

    void loadStatus();
    refreshScreens();
    connect();
    // Страховка, если WS недоступен.
    const poll = window.setInterval(loadStatus, 60_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(poll);
      ws?.close();
    };
  }, []);

  const onChanged = (entity: Entity, fn: () => void) => {
    const set = listeners.current.get(entity) ?? new Set();
    set.add(fn);
    listeners.current.set(entity, set);
    return () => {
      set.delete(fn);
    };
  };

  return (
    <LiveContext.Provider value={{ status, screens, pendingCodes, connected, onChanged, refreshScreens }}>{children}</LiveContext.Provider>
  );
}

export function useLive(): LiveValue {
  const v = useContext(LiveContext);
  if (!v) throw new Error('LiveProvider missing');
  return v;
}

/** Перезагружает данные при событии `changed` для сущности. */
export function useOnChanged(entity: Entity, fn: () => void): void {
  const { onChanged } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onChanged(entity, () => ref.current()), [entity, onChanged]);
}
