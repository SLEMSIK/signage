import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../test-utils/app.js';
import { createNetworkFilter, parseCidr } from './network.js';
import { createSessionToken, LoginLimiter, verifySessionToken } from './session.js';

describe('network filter', () => {
  const allowed = createNetworkFilter(['10.0.0.0/8', '192.168.0.0/16', 'fd00::/8']);
  it('allows configured networks and loopback', () => {
    expect(allowed('10.33.44.20')).toBe(true);
    expect(allowed('192.168.1.5')).toBe(true);
    expect(allowed('127.0.0.1')).toBe(true);
    expect(allowed('::1')).toBe(true);
    expect(allowed('::ffff:10.1.2.3')).toBe(true);
    expect(allowed('fd12::1')).toBe(true);
  });
  it('rejects others', () => {
    expect(allowed('8.8.8.8')).toBe(false);
    expect(allowed('11.0.0.1')).toBe(false);
    expect(allowed('::ffff:8.8.8.8')).toBe(false);
    expect(allowed('2001:db8::1')).toBe(false);
    expect(allowed('garbage')).toBe(false);
  });
  it('parses cidr', () => {
    expect(parseCidr('10.0.0.0/8')).not.toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('nope/8')).toBeNull();
  });
});

describe('session token', () => {
  const users = [{ login: 'a', role: 'admin' as const, passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ' }];
  it('roundtrips and expires', () => {
    const t = createSessionToken('a', users[0]!.passwordHash, 1000, 'secret-secret-secret', 0);
    expect(verifySessionToken(t, 'secret-secret-secret', users, 500)).toEqual({ login: 'a', role: 'admin' });
    expect(verifySessionToken(t, 'secret-secret-secret', users, 1500)).toBeNull();
    expect(verifySessionToken(t, 'other-secret-secret', users, 500)).toBeNull();
    expect(verifySessionToken(t + 'x', 'secret-secret-secret', users, 500)).toBeNull();
  });
  it('is invalidated when the password changes', () => {
    const t = createSessionToken('a', users[0]!.passwordHash, 1000, 'secret-secret-secret', 0);
    const changed = [{ ...users[0]!, passwordHash: users[0]!.passwordHash.replace(/Q$/, 'R') }];
    expect(verifySessionToken(t, 'secret-secret-secret', changed, 10)).toBeNull();
  });
});

describe('LoginLimiter', () => {
  it('blocks after 10 failures for 5 minutes', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 9; i++) l.fail(['ip'], 0);
    expect(l.blockedFor(['ip'], 0)).toBe(0);
    l.fail(['ip'], 0);
    expect(l.blockedFor(['ip'], 1000)).toBe(5 * 60_000 - 1000);
    expect(l.blockedFor(['ip'], 5 * 60_000)).toBe(0);
  });
});

describe('auth API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('rejects requests from outside allowed networks', async () => {
    const res = await t.app.inject({ url: '/health', remoteAddress: '8.8.8.8' });
    expect(res.statusCode).toBe(403);
  });

  it('health is ok', async () => {
    const res = await t.app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ db: true, storage: true });
  });

  it('admin API requires a session', async () => {
    expect((await t.app.inject({ url: '/api/admin/status' })).statusCode).toBe(401);
  });

  it('logs in and sets path-scoped httpOnly cookies', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: TEST_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.filter((c) => c.name === 'signage_sid');
    expect(cookies.map((c) => c.path).sort()).toEqual(['/api/admin', '/api/proxy']);
    expect(cookies.every((c) => c.httpOnly && c.sameSite === 'Strict')).toBe(true);
    const cookie = `signage_sid=${cookies[0]!.value}`;
    const me = await t.app.inject({ url: '/api/admin/me', headers: { cookie } });
    expect(me.json()).toEqual({ login: 'admin', role: 'admin' });
    expect((await t.app.inject({ url: '/api/admin/status', headers: { cookie } })).statusCode).toBe(200);
  });

  it('rejects wrong password and locks out after 10 attempts', async () => {
    const attempt = () =>
      t.app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'operator', password: 'wrong' }, remoteAddress: '10.9.9.9' });
    for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
    const good = await t.app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { login: 'operator', password: TEST_PASSWORD },
      remoteAddress: '10.9.9.9',
    });
    expect(good.statusCode).toBe(429);
  });
});
