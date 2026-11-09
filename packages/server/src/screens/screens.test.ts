import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ScreenDto, ServerToPlayer } from '@signage/shared';
import { createTestApp, type TestApp } from '../test-utils/app.js';

/** Тестовый плеер: копит входящие сообщения и умеет ждать нужное. */
class FakePlayer {
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

describe('screens & pairing', () => {
  let t: TestApp;
  let admin: string;
  let operator: string;
  let base: string;

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = t.app.server.address();
    base = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    admin = await t.login('admin');
    operator = await t.login('operator');
  });
  afterAll(async () => t.close());

  let token = '';
  let screenId = 0;

  it('unregistered player gets a 6-digit pairing code', async () => {
    const p = new FakePlayer(`${base}/ws/player`);
    await p.opened();
    p.send({ type: 'hello' });
    const { code } = await p.next('pairing');
    expect(code).toMatch(/^\d{6}$/);

    // Оператор регистрировать не может.
    const denied = await t.app.inject({ method: 'POST', url: '/api/admin/screens', payload: { code, name: 'Холл 1' }, headers: { cookie: operator } });
    expect(denied.statusCode).toBe(403);

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/admin/screens',
      payload: { code: code === '000000' ? '111111' : '000000', name: 'Холл 1' },
      headers: { cookie: admin },
    });
    expect(wrong.statusCode).toBe(404);

    const res = await t.app.inject({ method: 'POST', url: '/api/admin/screens', payload: { code, name: 'Холл 1' }, headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const dto = res.json<ScreenDto>();
    expect(dto).toMatchObject({ name: 'Холл 1', groupId: null });
    expect(dto.runtime.online).toBe(true);

    const paired = await p.next('paired');
    expect(paired.screenId).toBe(dto.id);
    token = paired.token;
    screenId = dto.id;
    const state = await p.next('state');
    expect(state).toMatchObject({ screenId: dto.id, playlist: null, timezone: 'Europe/Moscow' });
    await p.next('ping');
    p.close();
  });

  it('player reconnects with its token and gets state', async () => {
    const p = new FakePlayer(`${base}/ws/player`);
    await p.opened();
    p.send({ type: 'hello', token });
    const state = await p.next('state');
    expect(state.screenId).toBe(screenId);

    p.send({
      type: 'heartbeat',
      currentItemId: null,
      playlistId: null,
      cacheStatus: { sw: false, cached: 0, total: 0 },
      viewport: { w: 1920, h: 1080 },
      uptime: 5,
    });
    await new Promise((r) => setTimeout(r, 50));
    const list = (await t.app.inject({ url: '/api/admin/screens', headers: { cookie: operator } })).json<ScreenDto[]>();
    expect(list[0]!.runtime).toMatchObject({ online: true, uptime: 5, viewport: { w: 1920, h: 1080 } });

    // Быстрые действия
    expect((await t.app.inject({ method: 'POST', url: `/api/admin/screens/${screenId}/identify`, headers: { cookie: operator } })).statusCode).toBe(200);
    expect((await p.next('identify')).name).toBe('Холл 1');

    // Удаление экрана — токен больше не действует, плеер снова получает код.
    const del = await t.app.inject({ method: 'DELETE', url: `/api/admin/screens/${screenId}`, headers: { cookie: admin } });
    expect(del.statusCode).toBe(200);
    const again = await p.next('pairing');
    expect(again.code).toMatch(/^\d{6}$/);
    p.close();
  });

  it('old token is rejected after deletion', async () => {
    const p = new FakePlayer(`${base}/ws/player`);
    await p.opened();
    p.send({ type: 'hello', token });
    await p.next('pairing');
    p.close();
  });

  it('groups CRUD is admin-only', async () => {
    const denied = await t.app.inject({ method: 'POST', url: '/api/admin/groups', payload: { name: 'Холл' }, headers: { cookie: operator } });
    expect(denied.statusCode).toBe(403);
    const g = await t.app.inject({ method: 'POST', url: '/api/admin/groups', payload: { name: 'Холл', syncPlayback: true }, headers: { cookie: admin } });
    expect(g.json()).toMatchObject({ name: 'Холл', syncPlayback: true, screenCount: 0 });
  });

  it('admin websocket requires a session', async () => {
    const ws = new WebSocket(`${base}/api/admin/ws`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
    const ok = new WebSocket(`${base}/api/admin/ws`, { headers: { cookie: admin } });
    const first = await new Promise<string>((resolve) => ok.once('message', (m) => resolve(String(m))));
    expect(JSON.parse(first).type).toBe('screens');
    ok.close();
  });
});
