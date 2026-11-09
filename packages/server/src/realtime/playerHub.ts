import { createHash, randomBytes, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import { playerToServerSchema, type ScreenRuntime, type ServerToPlayer } from '@signage/shared';
import type { AppContext } from '../app.js';
import { screens, type ScreenRow } from '../db/schema.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

interface Conn {
  socket: WebSocket;
  ip: string;
  screenId: number | null;
  pairingCode: string | null;
  lastSeen: number;
  connectedAt: number;
  rtt: number | null;
  pingSentAt: number | null;
  /** Версия последнего отправленного state — чтобы не слать одно и то же. */
  sentVersion: string | null;
}

const PING_EVERY_MS = 10_000;

function emptyRuntime(): ScreenRuntime {
  return {
    online: false,
    lastSeenAt: null,
    currentItemId: null,
    playingPlaylistId: null,
    viewport: null,
    uptime: null,
    cacheStatus: null,
    ip: null,
    lastError: null,
  };
}

/**
 * WebSocket-хаб плееров (/ws/player): регистрация по коду, токены,
 * heartbeat, ping/pong для синхронизации часов, доставка state.
 */
export class PlayerHub {
  private conns = new Set<Conn>();
  private byScreen = new Map<number, Conn>();
  private pending = new Map<string, Conn>();
  private runtime = new Map<number, ScreenRuntime>();
  private timer: NodeJS.Timeout | null = null;
  private lastDbWrite = new Map<number, number>();
  /** Вызывается при изменении онлайн-статуса или runtime-информации экрана. */
  onScreensChanged: () => void = () => undefined;
  onPendingChanged: () => void = () => undefined;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), PING_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.conns) c.socket.close(1001, 'server shutdown');
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  getRuntime(screenId: number): ScreenRuntime {
    return this.runtime.get(screenId) ?? { ...emptyRuntime(), ...this.dbRuntime(screenId) };
  }

  private dbRuntime(screenId: number): Partial<ScreenRuntime> {
    const row = this.ctx.db.orm.select().from(screens).where(eq(screens.id, screenId)).get();
    return row ? { lastSeenAt: row.lastSeenAt, currentItemId: row.currentItem?.itemId ?? null } : {};
  }

  isOnline(screenId: number): boolean {
    return this.byScreen.has(screenId);
  }

  handle(socket: WebSocket, ip: string): void {
    const now = Date.now();
    const conn: Conn = { socket, ip, screenId: null, pairingCode: null, lastSeen: now, connectedAt: now, rtt: null, pingSentAt: null, sentVersion: null };
    this.conns.add(conn);

    socket.on('message', (raw) => {
      conn.lastSeen = Date.now();
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = playerToServerSchema.safeParse(data);
      if (!parsed.success) {
        this.ctx.log.debug({ ip, issues: parsed.error.issues }, 'bad player message');
        return;
      }
      const msg = parsed.data;
      switch (msg.type) {
        case 'hello':
          this.onHello(conn, msg.token);
          break;
        case 'heartbeat': {
          if (conn.screenId === null) return;
          const rt = this.ensureRuntime(conn.screenId);
          rt.lastSeenAt = conn.lastSeen;
          rt.currentItemId = msg.currentItemId;
          rt.playingPlaylistId = msg.playlistId;
          rt.viewport = msg.viewport;
          rt.uptime = msg.uptime;
          rt.cacheStatus = msg.cacheStatus;
          this.persist(conn.screenId, false);
          this.onScreensChanged();
          break;
        }
        case 'pong':
          if (conn.pingSentAt !== null && msg.t === conn.pingSentAt) conn.rtt = Date.now() - msg.t;
          break;
        case 'error':
          if (conn.screenId !== null) {
            this.ensureRuntime(conn.screenId).lastError = `${new Date().toISOString()} ${msg.message}`;
            this.onScreensChanged();
          }
          this.ctx.log.warn({ screenId: conn.screenId, mediaId: msg.mediaId, message: msg.message }, 'player error');
          break;
      }
    });

    socket.on('close', () => this.onClose(conn));
    socket.on('error', (err) => this.ctx.log.debug({ err, ip }, 'player socket error'));
  }

  private send(conn: Conn, msg: ServerToPlayer): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(msg));
  }

  private onHello(conn: Conn, token: string | undefined): void {
    if (conn.screenId !== null) return;
    if (token) {
      const row = this.ctx.db.orm.select().from(screens).where(eq(screens.tokenHash, hashToken(token))).get();
      if (row) {
        this.attach(conn, row);
        return;
      }
    }
    this.startPairing(conn);
  }

  private startPairing(conn: Conn): void {
    if (conn.pairingCode) this.pending.delete(conn.pairingCode);
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while (this.pending.has(code));
    conn.pairingCode = code;
    this.pending.set(code, conn);
    this.send(conn, { type: 'pairing', code });
    this.onPendingChanged();
  }

  private attach(conn: Conn, row: ScreenRow): void {
    if (conn.pairingCode) {
      this.pending.delete(conn.pairingCode);
      conn.pairingCode = null;
      this.onPendingChanged();
    }
    const old = this.byScreen.get(row.id);
    if (old && old !== conn) {
      old.screenId = null;
      old.socket.close(4000, 'replaced by a new connection');
    }
    conn.screenId = row.id;
    this.byScreen.set(row.id, conn);
    const rt = this.ensureRuntime(row.id);
    rt.online = true;
    rt.ip = conn.ip;
    rt.lastSeenAt = Date.now();
    this.persist(row.id, true);
    this.ctx.log.info({ screenId: row.id, name: row.name, ip: conn.ip }, 'player connected');
    this.pushState(row.id, true);
    this.ping(conn);
    this.onScreensChanged();
  }

  private onClose(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.pairingCode) {
      this.pending.delete(conn.pairingCode);
      this.onPendingChanged();
    }
    if (conn.screenId !== null && this.byScreen.get(conn.screenId) === conn) {
      this.byScreen.delete(conn.screenId);
      const rt = this.ensureRuntime(conn.screenId);
      rt.online = false;
      this.persist(conn.screenId, true);
      this.ctx.log.info({ screenId: conn.screenId }, 'player disconnected');
      this.onScreensChanged();
    }
  }

  private ensureRuntime(screenId: number): ScreenRuntime {
    let rt = this.runtime.get(screenId);
    if (!rt) {
      rt = { ...emptyRuntime(), ...this.dbRuntime(screenId) };
      this.runtime.set(screenId, rt);
    }
    return rt;
  }

  /** Пишем статус в БД: сразу при смене онлайн/офлайн, иначе не чаще раза в минуту. */
  private persist(screenId: number, force: boolean): void {
    const now = Date.now();
    if (!force && now - (this.lastDbWrite.get(screenId) ?? 0) < 60_000) return;
    this.lastDbWrite.set(screenId, now);
    const rt = this.runtime.get(screenId);
    this.ctx.db.orm
      .update(screens)
      .set({
        status: this.byScreen.has(screenId) ? 'online' : 'offline',
        lastSeenAt: rt?.lastSeenAt ?? now,
        currentItem: rt ? { itemId: rt.currentItemId, playlistId: rt.playingPlaylistId } : null,
      })
      .where(eq(screens.id, screenId))
      .run();
  }

  private ping(conn: Conn): void {
    conn.pingSentAt = Date.now();
    this.send(conn, { type: 'ping', t: conn.pingSentAt, rtt: conn.rtt ?? undefined });
  }

  private tick(): void {
    const now = Date.now();
    const offlineMs = this.ctx.config.player.offlineAfterSec * 1000;
    for (const c of this.conns) {
      if (now - c.lastSeen > offlineMs) {
        this.ctx.log.info({ screenId: c.screenId, ip: c.ip }, 'player timed out');
        c.socket.terminate();
        continue;
      }
      if (c.screenId !== null) this.ping(c);
    }
  }

  // ---- действия из админки ----

  /** Регистрирует экран по коду: возвращает false, если такого кода нет. */
  pair(code: string, row: ScreenRow, token: string): boolean {
    const conn = this.pending.get(code);
    if (!conn) return false;
    this.send(conn, { type: 'paired', token, screenId: row.id, name: row.name });
    this.attach(conn, row);
    return true;
  }

  hasPendingCode(code: string): boolean {
    return this.pending.has(code);
  }

  /** Экран удалён: токен больше не действует, плеер снова показывает код. */
  unpair(screenId: number): void {
    const conn = this.byScreen.get(screenId);
    this.runtime.delete(screenId);
    this.lastDbWrite.delete(screenId);
    if (!conn) return;
    this.byScreen.delete(screenId);
    conn.screenId = null;
    conn.sentVersion = null;
    this.startPairing(conn);
    this.onScreensChanged();
  }

  reload(screenId: number): boolean {
    const conn = this.byScreen.get(screenId);
    if (!conn) return false;
    this.send(conn, { type: 'reload' });
    return true;
  }

  identify(screenId: number, name: string): boolean {
    const conn = this.byScreen.get(screenId);
    if (!conn) return false;
    this.send(conn, { type: 'identify', name });
    return true;
  }

  /** Отправляет экрану актуальный state, если он изменился (или force). */
  pushState(screenId: number, force = false): void {
    const conn = this.byScreen.get(screenId);
    if (!conn) return;
    const state = this.ctx.playback.stateFor(screenId);
    if (!state) return;
    if (!force && conn.sentVersion === state.version) return;
    conn.sentVersion = state.version;
    this.send(conn, state);
  }

  pushAll(): void {
    for (const id of this.byScreen.keys()) this.pushState(id);
  }
}
