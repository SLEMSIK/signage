import type { WebSocket } from 'ws';
import type { AdminEvent } from '@signage/shared';
import type { AppContext } from '../app.js';
import { systemStatus } from '../system/routes.js';

/** WebSocket для админок: статусы экранов и уведомления об изменениях в реальном времени. */
export class AdminHub {
  private sockets = new Set<WebSocket>();
  private screensTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {
    ctx.events.on('changed', (entity) => {
      this.broadcast({ type: 'changed', entity });
      if (entity === 'screens' || entity === 'groups' || entity === 'schedules' || entity === 'overrides' || entity === 'playlists') {
        this.screensChanged();
      }
    });
    ctx.events.on('status', () => void this.sendStatus());
    ctx.events.on('changed', (entity) => {
      if (entity === 'media') void this.sendStatus();
    });
  }

  handle(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
    this.send(socket, { type: 'screens', screens: this.ctx.screens.list() });
    this.send(socket, { type: 'pending', codes: this.ctx.hub.pendingCount });
    void systemStatus(this.ctx)
      .then((status) => this.send(socket, { type: 'status', status }))
      .catch(() => undefined);
  }

  private send(socket: WebSocket, ev: AdminEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(ev));
  }

  broadcast(ev: AdminEvent): void {
    if (this.sockets.size === 0) return;
    const data = JSON.stringify(ev);
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.send(data);
  }

  /** Список экранов отправляем не чаще раза в 500 мс — heartbeat'ов может быть много. */
  screensChanged(): void {
    if (this.screensTimer || this.sockets.size === 0) return;
    this.screensTimer = setTimeout(() => {
      this.screensTimer = null;
      this.broadcast({ type: 'screens', screens: this.ctx.screens.list() });
    }, 500);
  }

  pendingChanged(): void {
    this.broadcast({ type: 'pending', codes: this.ctx.hub.pendingCount });
  }

  async sendStatus(): Promise<void> {
    if (this.sockets.size === 0 || this.stopped) return;
    try {
      this.broadcast({ type: 'status', status: await systemStatus(this.ctx) });
    } catch (err) {
      this.ctx.log.debug({ err }, 'status broadcast failed');
    }
  }

  private stopped = false;

  stop(): void {
    this.stopped = true;
    if (this.screensTimer) clearTimeout(this.screensTimer);
    for (const s of this.sockets) s.close(1001);
  }
}
