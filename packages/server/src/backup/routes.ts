import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/index.js';
import { HttpError, parse } from '../util/http.js';

const nameParam = z.object({ name: z.string().min(1).max(200) });

export async function backupAdminRoutes(app: FastifyInstance): Promise<void> {
  const svc = () => app.ctx.backups;
  const admin = { preHandler: requireRole('admin') };

  app.get('/backups', admin, async () => (await svc().list()).map(({ file: _f, ...b }) => b));

  app.post('/backups', admin, async (req) => {
    const b = await svc().create('manual');
    if (!b) throw new HttpError(503, 'Хранилище недоступно — бэкап сделать некуда');
    app.ctx.audit.write(req.user!.login, 'create', 'backup', b.name, { location: b.location });
    const { file: _f, ...dto } = b;
    return dto;
  });

  app.get('/backups/:name/download', admin, async (req, reply) => {
    const { name } = parse(nameParam, req.params);
    const b = await svc().find(name);
    reply.header('Content-Disposition', `attachment; filename="${b.name}"`);
    reply.type('application/vnd.sqlite3');
    return reply.send(createReadStream(b.file));
  });

  app.post('/backups/:name/restore', admin, async (req) => {
    const { name } = parse(nameParam, req.params);
    await svc().restore(name, req.user!.login);
    return { ok: true };
  });
}
