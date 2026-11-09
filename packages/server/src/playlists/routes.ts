import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { playlistInput } from '@signage/shared';
import { idParam, parse } from '../util/http.js';

export async function playlistsAdminRoutes(app: FastifyInstance): Promise<void> {
  const svc = () => app.ctx.playlists;

  app.get('/playlists', async () => svc().list());

  app.get('/playlists/:id', async (req) => svc().get(parse(idParam, req.params).id));

  app.get('/playlists/:id/usage', async (req) => {
    const { id } = parse(idParam, req.params);
    svc().get(id);
    return svc().usage(id);
  });

  app.post('/playlists', async (req) => svc().create(parse(playlistInput, req.body), req.user!.login));

  app.put('/playlists/:id', async (req) => svc().update(parse(idParam, req.params).id, parse(playlistInput, req.body), req.user!.login));

  app.post('/playlists/:id/duplicate', async (req) => svc().duplicate(parse(idParam, req.params).id, req.user!.login));

  app.delete('/playlists/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { force } = parse(z.object({ force: z.enum(['0', '1']).optional() }), req.query);
    svc().remove(id, force === '1', req.user!.login);
    return { ok: true };
  });
}
