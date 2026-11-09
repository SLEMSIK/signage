import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Me, Role } from '@signage/shared';
import { forbidden, HttpError, parse } from '../util/http.js';
import { createNetworkFilter } from './network.js';
import {
  createSessionToken,
  LoginLimiter,
  SESSION_COOKIE,
  SESSION_COOKIE_PATHS,
  verifySessionToken,
  type SessionUser,
} from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

/** Хэш-заглушка, чтобы время ответа не выдавало существование логина. */
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

const loginBody = z.object({ login: z.string().min(1).max(100), password: z.string().min(1).max(200) });

export function getSessionUser(app: FastifyInstance, req: FastifyRequest): SessionUser | null {
  const { config } = app.ctx;
  return verifySessionToken(req.cookies[SESSION_COOKIE], config.server.sessionSecret, config.users);
}

export function requireRole(role: Role) {
  return async (req: FastifyRequest) => {
    if (!req.user) throw new HttpError(401, 'Требуется вход');
    if (role === 'admin' && req.user.role !== 'admin') throw forbidden();
  };
}

/** Фильтр сетей + разбор сессии + маршруты логина. */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  const { config } = app.ctx;
  const allowed = createNetworkFilter(config.server.allowedNetworks);
  const limiter = new LoginLimiter();
  const ttlMs = config.server.sessionTtlHours * 3600_000;

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!allowed(req.ip)) {
      req.log.warn({ ip: req.ip, url: req.url }, 'request from disallowed network');
      return reply.code(403).send({ error: 'Доступ только из локальной сети' });
    }
    if (req.url.startsWith('/api/')) req.user = getSessionUser(app, req);
  });

  const setCookie = (reply: FastifyReply, value: string, maxAgeSec: number) => {
    for (const p of SESSION_COOKIE_PATHS) {
      reply.setCookie(SESSION_COOKIE, value, { path: p, httpOnly: true, sameSite: 'strict', secure: false, maxAge: maxAgeSec });
    }
  };

  app.post('/api/admin/login', async (req, reply) => {
    const body = parse(loginBody, req.body);
    const keys = [`ip:${req.ip}`, `login:${body.login.toLowerCase()}`];
    const blocked = limiter.blockedFor(keys);
    if (blocked > 0) {
      const min = Math.ceil(blocked / 60_000);
      return reply.code(429).send({ error: `Слишком много попыток. Попробуйте через ${min} мин.` });
    }
    const user = config.users.find((u) => u.login === body.login);
    const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      limiter.fail(keys);
      app.ctx.audit.write(body.login, 'login_failed', 'auth', null, { ip: req.ip });
      return reply.code(401).send({ error: 'Неверный логин или пароль' });
    }
    limiter.success(keys);
    setCookie(reply, createSessionToken(user.login, user.passwordHash, ttlMs, config.server.sessionSecret), ttlMs / 1000);
    app.ctx.audit.write(user.login, 'login', 'auth', null, { ip: req.ip });
    const me: Me = { login: user.login, role: user.role };
    return me;
  });

  app.post('/api/admin/logout', async (req, reply) => {
    setCookie(reply, '', 0);
    if (req.user) app.ctx.audit.write(req.user.login, 'logout', 'auth', null);
    return { ok: true };
  });

  app.get('/api/admin/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Требуется вход' });
    const me: Me = req.user;
    return me;
  });
}
