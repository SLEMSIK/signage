import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Config } from './config/index.js';
import { Database } from './db/index.js';
import { media } from './db/schema.js';
import { MediaStorage } from './media/storage.js';
import { AuditService } from './audit/index.js';
import { HttpError } from './util/http.js';

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export interface AppContext {
  config: Config;
  db: Database;
  storage: MediaStorage;
  audit: AuditService;
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
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: config.server.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  const db = new Database(config.storage.dbPath);
  const storage = new MediaStorage(config.storage.mediaPath, app.log, () => {
    const row = db.orm.select({ n: sql<number>`count(*)` }).from(media).get();
    return (row?.n ?? 0) > 0;
  });
  const audit = new AuditService(db);
  const ctx: AppContext = { config, db, storage, audit, version: VERSION };
  app.decorate('ctx', ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Внутренняя ошибка сервера' : (err as Error).message });
  });

  app.get('/health', async (_req, reply) => {
    const dbOk = db.isHealthy();
    const storageOk = await storage.check();
    const body = { status: dbOk && storageOk ? 'ok' : 'degraded', db: dbOk, storage: storageOk, storageError: storage.error, version: VERSION };
    return reply.code(dbOk && storageOk ? 200 : 503).send(body);
  });

  app.get('/', async (_req, reply) => reply.redirect('/admin/'));

  if (background) storage.start();
  else await storage.check();

  app.addHook('onClose', async () => {
    storage.stop();
    db.close();
  });

  return app;
}
