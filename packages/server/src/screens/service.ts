import { and, asc, eq, sql } from 'drizzle-orm';
import type { GroupDto, ScreenDto } from '@signage/shared';
import type { AppContext } from '../app.js';
import { groups, overrides, schedules, screens } from '../db/schema.js';
import { hashToken, newToken } from '../realtime/playerHub.js';
import { badRequest, conflict, notFound } from '../util/http.js';

export interface ScreenPatch {
  name?: string;
  groupId?: number | null;
  fitDefault?: 'contain' | 'cover';
}

export class ScreensService {
  constructor(private readonly ctx: AppContext) {}

  private get orm() {
    return this.ctx.db.orm;
  }

  list(): ScreenDto[] {
    const rows = this.orm
      .select({ s: screens, g: groups })
      .from(screens)
      .leftJoin(groups, eq(groups.id, screens.groupId))
      .orderBy(asc(screens.name), asc(screens.id))
      .all();
    return rows.map(({ s, g }) => ({
      id: s.id,
      name: s.name,
      groupId: s.groupId,
      groupName: g?.name ?? null,
      fitDefault: s.fitDefault,
      syncMode: g?.syncPlayback ?? false,
      createdAt: s.createdAt,
      runtime: this.ctx.hub.getRuntime(s.id),
      resolved: this.ctx.playback.getResolved(s.id),
    }));
  }

  get(id: number) {
    const row = this.orm.select().from(screens).where(eq(screens.id, id)).get();
    if (!row) throw notFound('Экран не найден');
    return row;
  }

  private checkGroup(groupId: number | null | undefined): void {
    if (groupId === null || groupId === undefined) return;
    if (!this.orm.select().from(groups).where(eq(groups.id, groupId)).get()) throw badRequest('Группа не найдена');
  }

  /** Регистрация экрана по коду, показанному на плеере. */
  pair(input: { code: string; name: string; groupId: number | null; fitDefault: 'contain' | 'cover' }, user: string): ScreenDto {
    if (!this.ctx.hub.hasPendingCode(input.code)) {
      throw notFound('Код не найден. Проверьте цифры на экране — код меняется при перезапуске плеера.');
    }
    this.checkGroup(input.groupId);
    const token = newToken();
    const row = this.orm
      .insert(screens)
      .values({ name: input.name, groupId: input.groupId, fitDefault: input.fitDefault, tokenHash: hashToken(token), createdAt: Date.now() })
      .returning()
      .get();
    if (!this.ctx.hub.pair(input.code, row, token)) {
      // Плеер отключился между проверкой и регистрацией.
      this.orm.delete(screens).where(eq(screens.id, row.id)).run();
      throw conflict('Плеер отключился. Обновите страницу плеера и попробуйте снова.');
    }
    this.ctx.audit.write(user, 'pair', 'screen', row.id, { name: row.name, groupId: row.groupId });
    this.ctx.events.changed('screens');
    return this.list().find((s) => s.id === row.id)!;
  }

  update(id: number, patch: ScreenPatch, user: string): void {
    const before = this.get(id);
    this.checkGroup(patch.groupId);
    this.orm.update(screens).set(patch).where(eq(screens.id, id)).run();
    this.ctx.audit.write(user, 'update', 'screen', id, { before: { name: before.name, groupId: before.groupId, fitDefault: before.fitDefault }, after: patch });
    this.ctx.events.changed('screens');
  }

  remove(id: number, user: string): void {
    const row = this.get(id);
    this.ctx.db.raw.transaction(() => {
      this.orm.delete(schedules).where(and(eq(schedules.targetType, 'screen'), eq(schedules.targetId, id))).run();
      this.orm.delete(overrides).where(and(eq(overrides.targetType, 'screen'), eq(overrides.targetId, id))).run();
      this.orm.delete(screens).where(eq(screens.id, id)).run();
    })();
    this.ctx.hub.unpair(id);
    this.ctx.audit.write(user, 'delete', 'screen', id, { name: row.name });
    this.ctx.events.changed('screens');
    this.ctx.events.changed('schedules');
  }

  // ---- группы ----

  listGroups(): GroupDto[] {
    const counts = new Map(
      this.orm
        .select({ groupId: screens.groupId, n: sql<number>`count(*)` })
        .from(screens)
        .groupBy(screens.groupId)
        .all()
        .map((r) => [r.groupId, r.n]),
    );
    return this.orm
      .select()
      .from(groups)
      .orderBy(asc(groups.name))
      .all()
      .map((g) => ({ id: g.id, name: g.name, syncPlayback: g.syncPlayback, screenCount: counts.get(g.id) ?? 0 }));
  }

  createGroup(input: { name: string; syncPlayback: boolean }, user: string): GroupDto {
    const row = this.orm.insert(groups).values({ ...input, createdAt: Date.now() }).returning().get();
    this.ctx.audit.write(user, 'create', 'group', row.id, input);
    this.ctx.events.changed('groups');
    return { id: row.id, name: row.name, syncPlayback: row.syncPlayback, screenCount: 0 };
  }

  updateGroup(id: number, patch: { name?: string; syncPlayback?: boolean }, user: string): void {
    if (!this.orm.select().from(groups).where(eq(groups.id, id)).get()) throw notFound('Группа не найдена');
    this.orm.update(groups).set(patch).where(eq(groups.id, id)).run();
    this.ctx.audit.write(user, 'update', 'group', id, patch);
    this.ctx.events.changed('groups');
    this.ctx.events.changed('screens');
  }

  removeGroup(id: number, user: string): void {
    const g = this.orm.select().from(groups).where(eq(groups.id, id)).get();
    if (!g) throw notFound('Группа не найдена');
    this.ctx.db.raw.transaction(() => {
      this.orm.delete(schedules).where(and(eq(schedules.targetType, 'group'), eq(schedules.targetId, id))).run();
      this.orm.delete(overrides).where(and(eq(overrides.targetType, 'group'), eq(overrides.targetId, id))).run();
      // screens.group_id → NULL по внешнему ключу.
      this.orm.delete(groups).where(eq(groups.id, id)).run();
    })();
    this.ctx.audit.write(user, 'delete', 'group', id, { name: g.name });
    this.ctx.events.changed('groups');
    this.ctx.events.changed('screens');
    this.ctx.events.changed('schedules');
  }
}
