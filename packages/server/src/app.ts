import { readFileSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Config } from './config/index.js';
import { Database } from './db/index.js';
import { media } from './db/schema.js';
import { AppEvents } from './events.js';
import { MediaStorage } from './media/storage.js';
import { MediaService } from './media/service.js';
import { mediaAdminRoutes } from './media/routes.js';
import { mediaServeRoutes } from './media/serve.js';
import { AuditService } from './audit/index.js';
import { HttpError } from './util/http.js';
import { authPlugin, requireRole } from './auth/index.js';
import { systemRoutes } from './system/routes.js';
import { webPlugin } from './web.js';
import { PlayerHub } from './realtime/playerHub.js';
import { AdminHub } from './realtime/adminHub.js';
import { realtimeRoutes } from './realtime/routes.js';
import { PlaybackService } from './schedule/playback.js';
import { ScreensService } from './screens/service.js';
import { screensAdminRoutes } from './screens/routes.js';

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export interface AppContext {
  config: Config;
  log: FastifyBaseLogger;
  db: Database;
  events: AppEvents;
  storage: MediaStorage;
  audit: AuditService;
  media: MediaService;
  screens: ScreensService;
  hub: PlayerHub;
  adminHub: AdminHub;
  playback: PlaybackService;
  version: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildOptions {
  /** Не запускать фоновые таймеры (для тестов). */
  background?: boolean;
  logger?: boolean;
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const background = opts.background ?? true;
  const app = Fastify({
    logger: opts.logger === false && !process.env.TEST_LOG ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: config.server.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  const db = new Database(config.storage.dbPath);
  const storage = new MediaStorage(config.storage.mediaPath, app.log, () => {
    const row = db.orm.select({ n: sql<number>`count(*)` }).from(media).get();
    return (row?.n ?? 0) > 0;
  });
  const ctx = {
    config,
    log: app.log,
    db,
    events: new AppEvents(),
    storage,
    audit: new AuditService(db),
    version: VERSION,
  } as AppContext;
  ctx.media = new MediaService(ctx);
  ctx.screens = new ScreensService(ctx);
  ctx.hub = new PlayerHub(ctx);
  ctx.playback = new PlaybackService(ctx);
  ctx.adminHub = new AdminHub(ctx);
  ctx.hub.onScreensChanged = () => ctx.adminHub.screensChanged();
  ctx.hub.onPendingChanged = () => ctx.adminHub.pendingChanged();
  app.decorate('ctx', ctx);

  storage.onChange(() => ctx.events.emit('status'));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Внутренняя ошибка сервера' : (err as Error).message });
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.storage.maxUploadMb * 1024 * 1024, files: 1, fields: 5 },
  });
  // Декорирует reply.sendFile (используется для медиа и SPA-fallback).
  await app.register(fastifyStatic, { root: config.storage.mediaPath, serve: false });
  await authPlugin(app);

  app.get('/', async (_req, reply) => reply.redirect('/admin/'));

  app.get('/health', async (_req, reply) => {
    const dbOk = db.isHealthy();
    const storageOk = await storage.check();
    const body = { status: dbOk && storageOk ? 'ok' : 'degraded', db: dbOk, storage: storageOk, storageError: storage.error, version: VERSION };
    return reply.code(dbOk && storageOk ? 200 : 503).send(body);
  });

  await app.register(mediaServeRoutes);
  await app.register(realtimeRoutes);

  await app.register(
    async (api) => {
      api.addHook('preHandler', requireRole('operator'));
      await api.register(systemRoutes);
      await api.register(mediaAdminRoutes);
      await api.register(screensAdminRoutes);
    },
    { prefix: '/api/admin' },
  );

  await app.register(webPlugin);

  if (background) {
    storage.start();
    ctx.hub.start();
    ctx.playback.start();
  } else {
    await storage.check();
    ctx.playback.recalculate();
    ctx.events.on('changed', () => ctx.playback.recalculate());
  }

  app.addHook('onClose', async () => {
    ctx.playback.stop();
    ctx.hub.stop();
    ctx.adminHub.stop();
    storage.stop();
    db.close();
  });

  return app;
}
