import { and, desc, eq, gte, like, lte, sql, type SQL } from 'drizzle-orm';
import type { AuditDto } from '@signage/shared';
import type { Database } from '../db/index.js';
import { auditLog } from '../db/schema.js';

export class AuditService {
  constructor(private readonly db: Database) {}

  write(user: string, action: string, entity: string, entityId: string | number | null, payload?: unknown): void {
    this.db.orm
      .insert(auditLog)
      .values({
        user,
        action,
        entity,
        entityId: entityId === null ? null : String(entityId),
        payload: payload === undefined ? null : payload,
        at: Date.now(),
      })
      .run();
  }

  list(filter: {
    user?: string;
    entity?: string;
    action?: string;
    from?: number;
    to?: number;
    q?: string;
    limit: number;
    offset: number;
  }): { items: AuditDto[]; total: number } {
    const conds: SQL[] = [];
    if (filter.user) conds.push(eq(auditLog.user, filter.user));
    if (filter.entity) conds.push(eq(auditLog.entity, filter.entity));
    if (filter.action) conds.push(eq(auditLog.action, filter.action));
    if (filter.from !== undefined) conds.push(gte(auditLog.at, filter.from));
    if (filter.to !== undefined) conds.push(lte(auditLog.at, filter.to));
    if (filter.q) conds.push(like(sql`CAST(${auditLog.payload} AS TEXT)`, `%${filter.q}%`));
    const where = conds.length ? and(...conds) : undefined;
    const rows = this.db.orm
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(filter.limit)
      .offset(filter.offset)
      .all();
    const total = this.db.orm.select({ n: sql<number>`count(*)` }).from(auditLog).where(where).get()?.n ?? 0;
    return {
      items: rows.map((r) => ({ ...r, payload: r.payload ?? null })),
      total,
    };
  }

  distinct(): { users: string[]; entities: string[]; actions: string[] } {
    const col = (name: 'user' | 'entity' | 'action') =>
      (this.db.raw.prepare(`SELECT DISTINCT "${name}" AS v FROM audit_log ORDER BY v`).all() as { v: string }[]).map(
        (r) => r.v,
      );
    return { users: col('user'), entities: col('entity'), actions: col('action') };
  }
}
