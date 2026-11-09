import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

export const ADMIN_DIST = fileURLToPath(new URL('../../admin/dist', import.meta.url));
export const PLAYER_DIST = fileURLToPath(new URL('../../player/dist', import.meta.url));

/**
 * Раздача собранных админки (/admin) и плеера (/player) с SPA-fallback.
 * reply.sendFile декорирует регистрация @fastify/static в app.ts.
 */
export async function webPlugin(app: FastifyInstance): Promise<void> {
  const spa = async (prefix: string, root: string, extraHeaders?: (path: string) => Record<string, string>) => {
    if (!existsSync(root)) {
      app.get(`${prefix}*`, async (_req, reply) =>
        reply.code(503).type('text/plain; charset=utf-8').send(`Сборка не найдена: ${root}. Выполните npm run build.`),
      );
      return;
    }
    await app.register(fastifyStatic, {
      root,
      prefix,
      decorateReply: false,
      wildcard: false,
      index: ['index.html'],
      // В @fastify/static v10 первым аргументом приходит reply.
      setHeaders(reply: FastifyReply, filePath: string) {
        // Хэшированные ассеты Vite — навсегда; index.html и sw.js — всегда перепроверять.
        if (filePath.includes('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else reply.header('Cache-Control', 'no-cache');
        for (const [k, v] of Object.entries(extraHeaders?.(filePath) ?? {})) reply.header(k, v);
      },
    });
    // Всё, что не файл, — index.html (клиентский роутинг).
    app.get(`${prefix}*`, async (_req, reply) => {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html', root);
    });
  };

  await spa('/admin/', ADMIN_DIST);
  await spa('/player/', PLAYER_DIST, (p): Record<string, string> =>
    // SW лежит в /player/, но должен перехватывать /media и /content.
    p.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {},
  );
  app.get('/admin', async (_req, reply) => reply.redirect('/admin/'));
  app.get('/player', async (_req, reply) => reply.redirect('/player/'));
}
