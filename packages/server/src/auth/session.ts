import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from '@signage/shared';

/**
 * Сессия админки — подписанная HMAC cookie (без хранения на сервере).
 * Роль при проверке берётся из текущего конфига: если пользователя удалили
 * или сменили ему роль, это применяется сразу.
 */

export const SESSION_COOKIE = 'signage_sid';
/** Cookie ставится только на эти пути: HTML-контент (/content) её не получает. */
export const SESSION_COOKIE_PATHS = ['/api/admin', '/api/proxy'] as const;

interface Payload {
  l: string;
  /** Срок действия, epoch ms. */
  e: number;
  /** Версия пароля: первые символы хэша — смена пароля разлогинивает. */
  p: string;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function createSessionToken(login: string, passwordHash: string, ttlMs: number, secret: string, now = Date.now()): string {
  const payload: Payload = { l: login, e: now + ttlMs, p: passwordHash.slice(-8) };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data, secret)}`;
}

export interface SessionUser {
  login: string;
  role: Role;
}

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  users: readonly { login: string; role: Role; passwordHash: string }[],
  now = Date.now(),
): SessionUser | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(data, secret));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Payload;
  } catch {
    return null;
  }
  if (typeof payload.e !== 'number' || payload.e <= now) return null;
  const user = users.find((u) => u.login === payload.l);
  if (!user || user.passwordHash.slice(-8) !== payload.p) return null;
  return { login: user.login, role: user.role };
}

/**
 * Защита от подбора: после `maxFailures` неудач подряд с одного IP
 * (или для одного логина) — блокировка на `blockMs`.
 */
export class LoginLimiter {
  private failures = new Map<string, { count: number; blockedUntil: number; last: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly blockMs = 5 * 60_000,
  ) {}

  /** Сколько мс ещё действует блокировка (0 — не заблокирован). */
  blockedFor(keys: string[], now = Date.now()): number {
    let max = 0;
    for (const k of keys) {
      const f = this.failures.get(k);
      if (f && f.blockedUntil > now) max = Math.max(max, f.blockedUntil - now);
    }
    return max;
  }

  fail(keys: string[], now = Date.now()): void {
    this.gc(now);
    for (const k of keys) {
      const f = this.failures.get(k) ?? { count: 0, blockedUntil: 0, last: now };
      if (f.blockedUntil && f.blockedUntil <= now) {
        f.count = 0;
        f.blockedUntil = 0;
      }
      f.count++;
      f.last = now;
      if (f.count >= this.maxFailures) f.blockedUntil = now + this.blockMs;
      this.failures.set(k, f);
    }
  }

  success(keys: string[]): void {
    for (const k of keys) this.failures.delete(k);
  }

  private gc(now: number): void {
    if (this.failures.size < 10_000) return;
    for (const [k, f] of this.failures) if (f.blockedUntil < now && now - f.last > this.blockMs) this.failures.delete(k);
  }
}
