import type { PlayerPlaylist, StateMsg } from '@signage/shared';
import './styles.css';
import { MediaCache } from './cache';
import { Engine } from './engine';
import { Connection } from './net';
import { KEYS, store } from './store';
import { fitStage, Overlays } from './ui';

const startedAt = Date.now();
const stage = document.getElementById('stage')!;
fitStage(stage);

const overlays = new Overlays(stage);
const cache = new MediaCache();
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const conn = new Connection(`${proto}://${location.host}/ws/player`);

let state: StateMsg | null = null;
let previousPlaylist: PlayerPlaylist | null = null;
let heartbeatTimer: number | undefined;
let reloadPending = false;
/** Ошибки, накопленные без связи — отправим при подключении. */
const errorQueue: { message: string; mediaId?: number }[] = [];

function reportError(message: string, mediaId?: number): void {
  console.warn('[signage]', message);
  if (conn.connected) conn.send({ type: 'error', message, mediaId });
  else if (errorQueue.length < 20) errorQueue.push({ message, mediaId });
}

const engine = new Engine(stage, {
  error: reportError,
  serverNow: () => conn.serverNow(),
  onItem: () => sendHeartbeat(),
  onBoundary: () => {
    if (!reloadPending) return false;
    location.reload();
    return true;
  },
});

function applyState(s: StateMsg): void {
  if (state && state.playlist && state.playlist.id !== s.playlist?.id) previousPlaylist = state.playlist;
  state = s;
  store.set(KEYS.lastState, JSON.stringify(s));
  cache.sync(s.playlist, previousPlaylist);
  engine.play({ playlist: s.playlist, syncEpoch: s.syncEpoch, version: s.version });
  restartHeartbeat(s.heartbeatSec);
}

function sendHeartbeat(): void {
  if (!conn.connected) return;
  conn.send({
    type: 'heartbeat',
    currentItemId: engine.currentItemId,
    playlistId: engine.playlistId,
    cacheStatus: cache.status(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    uptime: Math.round((Date.now() - startedAt) / 1000),
    version: engine.version ?? undefined,
  });
}

function restartHeartbeat(sec: number): void {
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(sendHeartbeat, sec * 1000);
}

conn.onStatus = (online) => {
  overlays.setOnline(online);
  if (online) {
    while (errorQueue.length) {
      const e = errorQueue.shift()!;
      conn.send({ type: 'error', ...e });
    }
  }
};

conn.onMessage = (msg) => {
  switch (msg.type) {
    case 'pairing':
      // Токена нет или он больше недействителен (экран удалён в админке).
      store.remove(KEYS.token);
      store.remove(KEYS.lastState);
      state = null;
      engine.stop();
      overlays.showPairing(msg.code);
      break;
    case 'paired':
      store.set(KEYS.token, msg.token);
      overlays.hidePairing();
      break;
    case 'state':
      overlays.hidePairing();
      applyState(msg);
      sendHeartbeat();
      break;
    case 'reload':
      location.reload();
      break;
    case 'identify':
      overlays.showIdentify(msg.name);
      break;
    case 'ping':
      break;
  }
};

/** Тихая перезагрузка раз в сутки около 04:00 (по часовому поясу сервера) — от утечек памяти. */
function checkDailyReload(): void {
  if (reloadPending || Date.now() - startedAt < 3600_000) return;
  const tz = state?.timezone ?? 'Europe/Moscow';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  if (Number(get('hour')) !== 4 || store.get(KEYS.lastReloadDay) === day) return;
  store.set(KEYS.lastReloadDay, day);
  reloadPending = true;
  // Чёрный экран или один элемент — границ не будет, перезагружаемся сразу.
  if (!state?.playlist || state.playlist.items.length <= 1) location.reload();
}
window.setInterval(checkDailyReload, 30_000);

async function boot(): Promise<void> {
  // Холодный старт без сервера: играем последний известный state.
  if (store.get(KEYS.token)) {
    const raw = store.get(KEYS.lastState);
    if (raw) {
      try {
        const last = JSON.parse(raw) as StateMsg;
        state = last;
        engine.play({ playlist: last.playlist, syncEpoch: last.syncEpoch, version: last.version });
      } catch {
        store.remove(KEYS.lastState);
      }
    }
  }
  conn.start();
  await cache.init();
  if (state) cache.sync(state.playlist, previousPlaylist);
}

void boot();
