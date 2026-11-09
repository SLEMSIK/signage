import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { overrideInput, scheduleInput, targetTypeSchema, type OverrideDto, type ScheduleDto, type ScheduleInput } from '@signage/shared';
import type { AppContext } from '../app.js';
import { groups, overrides, playlists, schedules, screens } from '../db/schema.js';
import { badRequest, idParam, notFound, parse } from '../util/http.js';
import { nextScheduleChange } from './engine.js';

function targetName(ctx: AppContext, type: 'screen' | 'group', id: number): string | null {
  const t = type === 'screen' ? screens : groups;
  return ctx.db.orm.select({ name: t.name }).from(t).where(eq(t.id, id)).get()?.name ?? null;
}

function checkRefs(ctx: AppContext, input: Pick<ScheduleInput, 'targetType' | 'targetId' | 'playlistId'>): void {
  if (targetName(ctx, input.targetType, input.targetId) === null) {
    throw badRequest(input.targetType === 'screen' ? 'Экран не найден' : 'Группа не найдена');
  }
  if (input.playlistId !== null && !ctx.db.orm.select().from(playlists).where(eq(playlists.id, input.playlistId)).get()) {
    throw badRequest('Плейлист не найден');
  }
}

function scheduleDtos(ctx: AppContext, type: 'screen' | 'group', id: number): ScheduleDto[] {
  return ctx.db.orm
    .select({ s: schedules, playlistName: playlists.name })
    .from(schedules)
    .leftJoin(playlists, eq(playlists.id, schedules.playlistId))
    .where(and(eq(schedules.targetType, type), eq(schedules.targetId, id)))
    .all()
    .map(({ s, playlistName }) => ({
      id: s.id,
      targetType: s.targetType,
      targetId: s.targetId,
      playlistId: s.playlistId,
      playlistName,
      days: s.days,
      startTime: s.startTime,
      endTime: s.endTime,
      priority: s.priority,
      enabled: s.enabled,
    }));
}

export function listOverrides(ctx: AppContext): OverrideDto[] {
  const now = Date.now();
  return ctx.db.orm
    .select({ o: overrides, playlistName: playlists.name })
    .from(overrides)
    .leftJoin(playlists, eq(playlists.id, overrides.playlistId))
    .orderBy(desc(overrides.createdAt))
    .all()
    .filter(({ o }) => o.until === null || o.until > now)
    .map(({ o, playlistName }) => ({
      id: o.id,
      targetType: o.targetType,
      targetId: o.targetId,
      targetName: targetName(ctx, o.targetType, o.targetId) ?? '—',
      playlistId: o.playlistId,
      playlistName,
      until: o.until,
      createdBy: o.createdBy,
      createdAt: o.createdAt,
    }));
}

export async function scheduleAdminRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  // ---- расписание ----

  /** Правила цели; для экрана — ещё и унаследованные от группы. */
  app.get('/schedules', async (req) => {
    const q = parse(z.object({ targetType: targetTypeSchema, targetId: z.coerce.number().int().positive() }), req.query);
    if (targetName(ctx, q.targetType, q.targetId) === null) throw notFound('Цель не найдена');
    const own = scheduleDtos(ctx, q.targetType, q.targetId);
    let inherited: ScheduleDto[] = [];
    let groupId: number | null = null;
    if (q.targetType === 'screen') {
      groupId = ctx.db.orm.select({ g: screens.groupId }).from(screens).where(eq(screens.id, q.targetId)).get()?.g ?? null;
      if (groupId !== null) inherited = scheduleDtos(ctx, 'group', groupId);
    }
    return { own, inherited, groupId };
  });

  app.post('/schedules', async (req) => {
    const body = parse(scheduleInput, req.body);
    checkRefs(ctx, body);
    const row = ctx.db.orm.insert(schedules).values({ ...body, createdAt: Date.now() }).returning().get();
    ctx.audit.write(req.user!.login, 'create', 'schedule', row.id, body);
    ctx.events.changed('schedules');
    return { id: row.id };
  });

  app.put('/schedules/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(scheduleInput, req.body);
    const before = ctx.db.orm.select().from(schedules).where(eq(schedules.id, id)).get();
    if (!before) throw notFound('Правило не найдено');
    checkRefs(ctx, body);
    ctx.db.orm.update(schedules).set(body).where(eq(schedules.id, id)).run();
    ctx.audit.write(req.user!.login, 'update', 'schedule', id, { before, after: body });
    ctx.events.changed('schedules');
    return { ok: true };
  });

  app.delete('/schedules/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const before = ctx.db.orm.select().from(schedules).where(eq(schedules.id, id)).get();
    if (!before) throw notFound('Правило не найдено');
    ctx.db.orm.delete(schedules).where(eq(schedules.id, id)).run();
    ctx.audit.write(req.user!.login, 'delete', 'schedule', id, before);
    ctx.events.changed('schedules');
    return { ok: true };
  });

  // ---- ручные переключения ----

  app.get('/overrides', async () => listOverrides(ctx));

  app.post('/overrides', async (req) => {
    const body = parse(overrideInput, req.body);
    if (body.mode === 'hours' && !body.hours) throw badRequest('Укажите количество часов');
    if (body.playlistId !== null && !ctx.db.orm.select().from(playlists).where(eq(playlists.id, body.playlistId)).get()) {
      throw badRequest('Плейлист не найден');
    }
    const now = Date.now();
    const allScreens = ctx.db.orm.select({ id: screens.id, groupId: screens.groupId }).from(screens).all();
    const allSchedules = ctx.db.orm.select().from(schedules).all();
    const created: { id: number; until: number | null }[] = [];

    ctx.db.raw.transaction(() => {
      for (const t of body.targets) {
        if (targetName(ctx, t.type, t.id) === null) throw badRequest(t.type === 'screen' ? 'Экран не найден' : 'Группа не найдена');
        let until: number | null = null;
        if (body.mode === 'hours') until = now + Math.round(body.hours! * 3600_000);
        // «До следующей смены»: если расписания нет вовсе — действует до отмены.
        else if (body.mode === 'next') until = nextScheduleChange(t, allScreens, allSchedules, now, ctx.config.server.timezone);
        // Новое переключение заменяет предыдущее для той же цели.
        ctx.db.orm.delete(overrides).where(and(eq(overrides.targetType, t.type), eq(overrides.targetId, t.id))).run();
        const row = ctx.db.orm
          .insert(overrides)
          .values({ targetType: t.type, targetId: t.id, playlistId: body.playlistId, until, createdBy: req.user!.login, createdAt: now })
          .returning()
          .get();
        created.push({ id: row.id, until });
      }
    })();

    ctx.audit.write(req.user!.login, body.playlistId === null ? 'black_screen' : 'switch', 'override', created.map((c) => c.id).join(','), {
      targets: body.targets.map((t) => ({ ...t, name: targetName(ctx, t.type, t.id) })),
      playlistId: body.playlistId,
      mode: body.mode,
      hours: body.hours,
      until: created.map((c) => c.until),
    });
    ctx.events.changed('overrides');
    return { created };
  });

  app.delete('/overrides/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const row = ctx.db.orm.select().from(overrides).where(eq(overrides.id, id)).get();
    if (!row) throw notFound('Переключение уже закончилось');
    ctx.db.orm.delete(overrides).where(eq(overrides.id, id)).run();
    ctx.audit.write(req.user!.login, 'restore_schedule', 'override', id, { targetType: row.targetType, targetId: row.targetId, name: targetName(ctx, row.targetType, row.targetId) });
    ctx.events.changed('overrides');
    return { ok: true };
  });
}
