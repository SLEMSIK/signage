import WebSocket from 'ws';
import type { ServerToPlayer } from '@signage/shared';
import type { TestApp } from './app.js';

/** Тестовый плеер: копит входящие сообщения и умеет ждать нужное. */
export class FakePlayer {
  ws: WebSocket;
  messages: ServerToPlayer[] = [];
  private waiters: { type: string; resolve: (m: ServerToPlayer) => void }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerToPlayer;
      const idx = this.waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(msg);
      else this.messages.push(msg);
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  next<T extends ServerToPlayer['type']>(type: T, timeoutMs = 3000): Promise<Extract<ServerToPlayer, { type: T }>> {
    const idx = this.messages.findIndex((m) => m.type === type);
    if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0] as Extract<ServerToPlayer, { type: T }>);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as Extract<ServerToPlayer, { type: T }>);
        },
      });
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}


/** Поднимает сервер на случайном порту и регистрирует экран. */
export async function listenAndPair(t: TestApp, admin: string, name = 'Экран'): Promise<{ base: string; player: FakePlayer; screenId: number; token: string }> {
  if (!t.app.server.listening) await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address();
  const base = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const player = new FakePlayer(`${base}/ws/player`);
  await player.opened();
  player.send({ type: 'hello' });
  const { code } = await player.next('pairing');
  const res = await t.app.inject({ method: 'POST', url: '/api/admin/screens', payload: { code, name }, headers: { cookie: admin } });
  if (res.statusCode !== 200) throw new Error(res.body);
  const paired = await player.next('paired');
  await player.next('state');
  return { base, player, screenId: paired.screenId, token: paired.token };
}
