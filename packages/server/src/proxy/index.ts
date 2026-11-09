import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSessionUser } from '../auth/index.js';
import { screens } from '../db/schema.js';
import { hashToken } from '../realtime/playerHub.js';
import { badRequest, forbidden, HttpError, parse } from '../util/http.js';

export const PLAYER_COOKIE = 'signage_player';
const MAX_REDIRECTS = 3;
const MAX_ENTRIES = 500;

interface CacheEntry {
  status: number;
  contentType: string;
  body: Buffer;
  fetchedAt: number;
}

/** Домен разрешён, если совпадает с записью allowlist или является поддоменом записи вида «*.example.com». */
export function isAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      return h === base || h.endsWith(`.${base}`);
    }
    return h === entry;
  });
}

function playerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.cookies[PLAYER_COOKIE] ?? null;
}

/**
 * Прокси внешних данных для HTML-контента: экраны не имеют интернета.
 * Только GET, только домены из proxy.allowlist, кэш на cacheTtlSec; если источник
 * недоступен — отдаётся последний успешный ответ.
 */
export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app.ctx;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<CacheEntry>>();

  const screenByToken = (token: string | null) =>
    token ? app.ctx.db.orm.select({ id: screens.id }).from(screens).where(eq(screens.tokenHash, hashToken(token))).get() : undefined;

  // Плеер обменивает токен на httpOnly cookie, чтобы iframe с HTML-контентом
  // мог ходить в прокси, не видя самого токена.
  app.post('/api/player/session', async (req, reply) => {
    const token = playerToken(req);
    if (!screenByToken(token)) return reply.code(401).send({ error: 'Неверный токен экрана' });
    reply.setCookie(PLAYER_COOKIE, token!, { path: '/api/proxy', httpOnly: true, sameSite: 'strict', secure: false, maxAge: 365 * 86400 });
    return { ok: true };
  });

  const fetchUpstream = async (url: URL): Promise<CacheEntry> => {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(config.proxy.timeoutSec * 1000),
        headers: { 'User-Agent': 'signage-proxy/1.0', Accept: '*/*' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location')!, current);
        if (!/^https?:$/.test(next.protocol) || !isAllowed(next.hostname, config.proxy.allowlist)) {
          throw new HttpError(403, `Перенаправление на неразрешённый адрес: ${next.hostname}`);
        }
        current = next;
        continue;
      }
      const max = config.proxy.maxResponseKb * 1024;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > max) throw new HttpError(502, 'Ответ источника слишком большой');
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > max) throw new HttpError(502, 'Ответ источника слишком большой');
      return { status: res.status, contentType: res.headers.get('content-type') ?? 'application/octet-stream', body, fetchedAt: Date.now() };
    }
    throw new HttpError(502, 'Слишком много перенаправлений');
  };

  app.get('/api/proxy', async (req, reply) => {
    // Доступ: сессия админки (предпросмотр) или токен экрана.
    if (!getSessionUser(app, req) && !screenByToken(playerToken(req))) {
      return reply.code(401).send({ error: 'Требуется токен экрана или вход в админку' });
    }
    const { url: raw } = parse(z.object({ url: z.string().min(1).max(4000) }), req.query);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw badRequest('Некорректный URL');
    }
    if (!/^https?:$/.test(url.protocol)) throw badRequest('Разрешены только http и https');
    if (url.username || url.password) throw badRequest('Учётные данные в URL запрещены');
    if (!isAllowed(url.hostname, config.proxy.allowlist)) throw forbidden(`Домен ${url.hostname} не входит в proxy.allowlist`);

    const key = url.href;
    const cached = cache.get(key);
    const ttl = config.proxy.cacheTtlSec * 1000;
    let entry: CacheEntry | undefined = cached && Date.now() - cached.fetchedAt < ttl ? cached : undefined;
    let stale = false;

    if (!entry) {
      let p = inflight.get(key);
      if (!p) {
        p = fetchUpstream(url).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      try {
        const fresh = await p;
        if (fresh.status >= 200 && fresh.status < 300) {
          cache.delete(key);
          cache.set(key, fresh);
          if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
          entry = fresh;
        } else if (cached) {
          entry = cached;
          stale = true;
        } else {
          entry = fresh; // ошибку источника отдаём как есть
        }
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 403) throw err;
        if (!cached) {
          req.log.warn({ url: key, err: (err as Error).message }, 'proxy upstream failed');
          throw new HttpError(502, `Источник недоступен: ${url.hostname}`);
        }
        entry = cached;
        stale = true;
      }
    }

    reply.header('Content-Type', entry.contentType);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Signage-Fetched-At', new Date(entry.fetchedAt).toISOString());
    if (stale) reply.header('X-Signage-Stale', '1');
    return reply.code(entry.status).send(entry.body);
  });
}
