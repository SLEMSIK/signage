import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, HttpError, idParam, parse } from '../util/http.js';

export async function mediaAdminRoutes(app: FastifyInstance): Promise<void> {
  const svc = () => app.ctx.media;

  app.get('/media', async () => svc().list());

  app.post('/media', async (req) => {
    if (!req.isMultipart()) throw badRequest('Ожидается multipart/form-data');
    const file = await req.file();
    if (!file) throw badRequest('Файл не передан');
    try {
      return await svc().upload({ filename: file.filename, stream: file.file, user: req.user!.login });
    } catch (err) {
      // @fastify/multipart бросает ошибку при превышении fileSize.
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new HttpError(413, `Файл больше ${app.ctx.config.storage.maxUploadMb} МБ`);
      }
      throw err;
    }
  });

  app.get('/media/:id/usage', async (req) => {
    const { id } = parse(idParam, req.params);
    svc().get(id);
    return svc().usage(id);
  });

  app.patch('/media/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ title: z.string().trim().min(1).max(200) }), req.body);
    return svc().rename(id, body.title, req.user!.login);
  });

  app.delete('/media/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { force } = parse(z.object({ force: z.enum(['0', '1']).optional() }), req.query);
    await svc().remove(id, force === '1', req.user!.login);
    return { ok: true };
  });
}
