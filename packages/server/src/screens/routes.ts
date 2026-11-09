import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/index.js';
import { idParam, notFound, parse } from '../util/http.js';

const name = z.string().trim().min(1).max(100);
const fitDefault = z.enum(['contain', 'cover']);

export async function screensAdminRoutes(app: FastifyInstance): Promise<void> {
  const svc = () => app.ctx.screens;
  const admin = { preHandler: requireRole('admin') };

  app.get('/screens', async () => svc().list());

  app.post('/screens', admin, async (req) => {
    const body = parse(
      z.object({
        code: z.string().trim().regex(/^\d{6}$/, 'Код — 6 цифр'),
        name,
        groupId: z.number().int().positive().nullable().default(null),
        fitDefault: fitDefault.default('contain'),
      }),
      req.body,
    );
    return svc().pair(body, req.user!.login);
  });

  app.patch('/screens/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ name: name.optional(), groupId: z.number().int().positive().nullable().optional(), fitDefault: fitDefault.optional() }), req.body);
    svc().update(id, body, req.user!.login);
    return { ok: true };
  });

  app.delete('/screens/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    svc().remove(id, req.user!.login);
    return { ok: true };
  });

  // Быстрые действия доступны и оператору.
  app.post('/screens/:id/reload', async (req) => {
    const { id } = parse(idParam, req.params);
    const s = svc().get(id);
    if (!app.ctx.hub.reload(id)) throw notFound('Экран не в сети');
    app.ctx.audit.write(req.user!.login, 'reload', 'screen', id, { name: s.name });
    return { ok: true };
  });

  app.post('/screens/:id/identify', async (req) => {
    const { id } = parse(idParam, req.params);
    const s = svc().get(id);
    if (!app.ctx.hub.identify(id, s.name)) throw notFound('Экран не в сети');
    return { ok: true };
  });

  app.get('/screens/:id/state', async (req) => {
    const { id } = parse(idParam, req.params);
    svc().get(id);
    return app.ctx.playback.stateFor(id);
  });

  // ---- группы ----
  app.get('/groups', async () => svc().listGroups());

  app.post('/groups', admin, async (req) => {
    const body = parse(z.object({ name, syncPlayback: z.boolean().default(false) }), req.body);
    return svc().createGroup(body, req.user!.login);
  });

  app.patch('/groups/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ name: name.optional(), syncPlayback: z.boolean().optional() }), req.body);
    svc().updateGroup(id, body, req.user!.login);
    return { ok: true };
  });

  app.delete('/groups/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    svc().removeGroup(id, req.user!.login);
    return { ok: true };
  });
}
