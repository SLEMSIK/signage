import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, idParam, notFound, parse } from '../util/http.js';
import { injectSignage, SIGNAGE_SCRIPT } from './html.js';
import type { MediaLocation } from './storage.js';

const SCRIPT_VERSION = createHash('sha256').update(SIGNAGE_SCRIPT).digest('hex').slice(0, 8);

/**
 * Раздача медиа плеерам и админке. Доступ — из разрешённых сетей
 * (фильтр в authPlugin): img/video/iframe не умеют слать заголовки авторизации,
 * а контент и так показывается публично на экранах.
 */
export async function mediaServeRoutes(app: FastifyInstance): Promise<void> {
  const { storage } = app.ctx;

  const notModified = (req: FastifyRequest, reply: FastifyReply, etag: string): boolean => {
    reply.header('ETag', etag);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}`)) {
      reply.code(304).send();
      return true;
    }
    return false;
  };

  const requireStorage = (location: MediaLocation) => {
    if (!storage.canRead(location)) throw new HttpError(503, 'Хранилище недоступно');
  };

  const sendOpts = { etag: false, lastModified: false, cacheControl: false } as const;

  app.get('/media/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { v } = parse(z.object({ v: z.string().optional() }), req.query);
    const row = app.ctx.media.get(id);
    if (row.type === 'html' || row.type === 'html_zip') return reply.redirect(`/content/${id}/index.html`);
    requireStorage(row.location);
    const versioned = v !== undefined && v === row.sha256.slice(0, 8);
    reply.header('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (notModified(req, reply, `"${row.sha256}"`)) return reply;
    return reply.sendFile(row.relPath, storage.rootOf(row.location), sendOpts);
  });

  app.get('/thumbs/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const row = app.ctx.media.get(id);
    if (!row.thumbPath) throw notFound('Нет превью');
    requireStorage(row.location);
    reply.header('Cache-Control', 'public, max-age=86400');
    if (notModified(req, reply, `"t-${row.sha256}"`)) return reply;
    return reply.sendFile(row.thumbPath, storage.rootOf(row.location), sendOpts);
  });

  // HTML и HTML-пакеты. В каждую HTML-страницу добавляется window.signage.
  app.get('/content/:id/*', async (req, reply) => {
    const params = req.params as { id: string; '*': string };
    const { id } = parse(idParam, { id: params.id });
    const row = app.ctx.media.get(id);
    if (row.type !== 'html' && row.type !== 'html_zip') throw notFound();
    requireStorage(row.location);
    const root = storage.rootOf(row.location);

    let rel = decodeURIComponent(params['*'] || 'index.html');
    if (rel.endsWith('/')) rel += 'index.html';
    let fileRel: string;
    if (row.type === 'html') {
      if (rel !== 'index.html') throw notFound();
      fileRel = row.relPath;
    } else {
      const base = storage.absIn(row.location, row.relPath);
      const target = path.resolve(base, rel);
      if (!target.startsWith(base + path.sep)) throw notFound();
      fileRel = path.relative(root, target);
    }

    // Содержимое media id никогда не меняется — ETag от sha256 пакета + путь.
    const isHtml = /\.html?$/i.test(fileRel);
    const etag = `"${row.sha256.slice(0, 16)}-${createHash('sha1').update(rel).digest('hex').slice(0, 8)}${isHtml ? `-${SCRIPT_VERSION}` : ''}"`;
    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (notModified(req, reply, etag)) return reply;

    if (isHtml) {
      let html: string;
      try {
        html = await fs.readFile(storage.absIn(row.location, fileRel), 'utf8');
      } catch {
        throw notFound();
      }
      return reply.type('text/html; charset=utf-8').send(injectSignage(html));
    }
    return reply.sendFile(fileRel, root, sendOpts);
  });

  app.get('/content/:id', async (req, reply) => reply.redirect(`/content/${(req.params as { id: string }).id}/index.html`));
}
