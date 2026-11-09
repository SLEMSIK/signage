import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test-utils/app.js';
import { listenAndPair, type FakePlayer } from '../test-utils/fakePlayer.js';
import { isAllowed } from './index.js';

describe('isAllowed', () => {
  it('matches exact hosts and wildcard subdomains', () => {
    expect(isAllowed('api.open-meteo.com', ['api.open-meteo.com'])).toBe(true);
    expect(isAllowed('API.Open-Meteo.com.', ['api.open-meteo.com'])).toBe(true);
    expect(isAllowed('evil.com', ['api.open-meteo.com'])).toBe(false);
    expect(isAllowed('api.open-meteo.com.evil.com', ['api.open-meteo.com'])).toBe(false);
    expect(isAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(isAllowed('example.com', ['*.example.com'])).toBe(true);
    expect(isAllowed('badexample.com', ['*.example.com'])).toBe(false);
  });
});

describe('/api/proxy', () => {
  let t: TestApp;
  let upstream: http.Server;
  let base: string;
  let hits = 0;
  let down = false;
  let admin: string;
  let player: FakePlayer;
  let token: string;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      hits++;
      if (down) {
        res.destroy();
        return;
      }
      if (req.url === '/redirect-out') {
        res.writeHead(302, { Location: 'http://evil.example/' }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ n: hits }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    t = await createTestApp((c) => {
      c.proxy.allowlist = ['127.0.0.1'];
      c.proxy.cacheTtlSec = 60;
    });
    admin = await t.login('admin');
    ({ player, token } = await listenAndPair(t, admin));
  });
  afterAll(async () => {
    player.close();
    await t.close();
    upstream.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ url: `/api/proxy?url=${encodeURIComponent(url)}`, headers });

  it('requires a player token or admin session', async () => {
    expect((await get(`${base}/data`)).statusCode).toBe(401);
    expect((await get(`${base}/data`, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
  });

  it('exchanges the player token for a path-scoped cookie', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/player/session', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === 'signage_player')!;
    expect(c).toMatchObject({ path: '/api/proxy', httpOnly: true });
    const viaCookie = await get(`${base}/data`, { cookie: `signage_player=${c.value}` });
    expect(viaCookie.statusCode).toBe(200);
  });

  it('caches responses and serves stale data when the source is down', async () => {
    const before = hits;
    const a = await get(`${base}/cached`, { cookie: admin.replace('signage_sid', 'signage_sid') });
    expect(a.statusCode).toBe(200);
    const b = await get(`${base}/cached`, { authorization: `Bearer ${token}` });
    expect(b.body).toBe(a.body);
    expect(hits - before).toBe(1);

    // Истёк TTL, источник лёг — отдаём последний успешный ответ.
    t.config.proxy.cacheTtlSec = 0;
    down = true;
    const c = await get(`${base}/cached`, { authorization: `Bearer ${token}` });
    expect(c.statusCode).toBe(200);
    expect(c.headers['x-signage-stale']).toBe('1');
    expect(c.body).toBe(a.body);
    const d = await get(`${base}/never-fetched`, { authorization: `Bearer ${token}` });
    expect(d.statusCode).toBe(502);
    down = false;
    t.config.proxy.cacheTtlSec = 60;
  });

  it('rejects non-allowlisted domains, other schemes and redirects out of the allowlist', async () => {
    const auth = { authorization: `Bearer ${token}` };
    expect((await get('http://example.org/', auth)).statusCode).toBe(403);
    expect((await get('file:///etc/passwd', auth)).statusCode).toBe(400);
    expect((await get(`${base}/redirect-out`, auth)).statusCode).toBe(403);
  });
});
