import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../util/http.js';

/** Журнал действий: admin и operator — только просмотр. */
export async function auditAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', async (req) => {
    const q = parse(
      z.object({
        user: z.string().max(100).optional(),
        entity: z.string().max(50).optional(),
        action: z.string().max(50).optional(),
        q: z.string().max(200).optional(),
        from: z.coerce.number().int().optional(),
        to: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    return app.ctx.audit.list(q);
  });

  app.get('/audit/filters', async () => app.ctx.audit.distinct());
}
