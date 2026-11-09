import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { PlaylistDto, PlaylistInput, PlaylistSummaryDto } from '@signage/shared';
import type { AppContext } from '../app.js';
import { media, overrides, playlistItems, playlists, schedules } from '../db/schema.js';
import { toMediaDto } from '../media/service.js';
import { badRequest, conflict, notFound } from '../util/http.js';

export class PlaylistsService {
  constructor(private readonly ctx: AppContext) {}

  private get orm() {
    return this.ctx.db.orm;
  }

  /** Длительность элемента так же, как её посчитает плеер. */
  private itemDuration(durationSec: number | null, m: { type: string; durationSec: number | null }): number {
    if (durationSec !== null) return durationSec;
    const { player } = this.ctx.config;
    if (m.type === 'video') return m.durationSec ?? 30;
    return m.type === 'image' ? player.defaultImageDurationSec : player.defaultHtmlDurationSec;
  }

  list(): PlaylistSummaryDto[] {
    const rows = this.orm.select().from(playlists).orderBy(asc(playlists.name)).all();
    const items = this.orm
      .select({ playlistId: playlistItems.playlistId, durationSec: playlistItems.durationSec, type: media.type, mediaDuration: media.durationSec })
      .from(playlistItems)
      .innerJoin(media, eq(media.id, playlistItems.mediaId))
      .all();
    const agg = new Map<number, { n: number; total: number }>();
    for (const i of items) {
      const a = agg.get(i.playlistId) ?? { n: 0, total: 0 };
      a.n++;
      a.total += this.itemDuration(i.durationSec, { type: i.type, durationSec: i.mediaDuration });
      agg.set(i.playlistId, a);
    }
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      itemCount: agg.get(p.id)?.n ?? 0,
      totalDurationSec: Math.round((agg.get(p.id)?.total ?? 0) * 10) / 10,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  get(id: number): PlaylistDto {
    const p = this.orm.select().from(playlists).where(eq(playlists.id, id)).get();
    if (!p) throw notFound('Плейлист не найден');
    const rows = this.orm
      .select({ item: playlistItems, media })
      .from(playlistItems)
      .innerJoin(media, eq(media.id, playlistItems.mediaId))
      .where(eq(playlistItems.playlistId, id))
      .orderBy(asc(playlistItems.position), asc(playlistItems.id))
      .all();
    const total = rows.reduce((s, r) => s + this.itemDuration(r.item.durationSec, r.media), 0);
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      itemCount: rows.length,
      totalDurationSec: Math.round(total * 10) / 10,
      items: rows.map(({ item, media: m }) => ({
        id: item.id,
        mediaId: item.mediaId,
        position: item.position,
        durationSec: item.durationSec,
        fit: item.fit,
        transition: item.transition,
        media: toMediaDto(m),
      })),
    };
  }

  private checkMedia(input: PlaylistInput): void {
    const ids = [...new Set(input.items.map((i) => i.mediaId))];
    if (ids.length === 0) return;
    const found = new Set(this.orm.select({ id: media.id }).from(media).where(inArray(media.id, ids)).all().map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw badRequest(`Медиафайлы не найдены: ${missing.join(', ')}`);
  }

  private writeItems(playlistId: number, input: PlaylistInput): void {
    this.orm.delete(playlistItems).where(eq(playlistItems.playlistId, playlistId)).run();
    if (input.items.length === 0) return;
    this.orm
      .insert(playlistItems)
      .values(
        input.items.map((i, position) => ({
          playlistId,
          mediaId: i.mediaId,
          position,
          durationSec: i.durationSec,
          fit: i.fit,
          transition: i.transition,
        })),
      )
      .run();
  }

  create(input: PlaylistInput, user: string): PlaylistDto {
    this.checkMedia(input);
    const id = this.ctx.db.raw.transaction(() => {
      const now = Date.now();
      const row = this.orm.insert(playlists).values({ name: input.name, createdAt: now, updatedAt: now }).returning().get();
      this.writeItems(row.id, input);
      return row.id;
    })();
    this.ctx.audit.write(user, 'create', 'playlist', id, { name: input.name, items: input.items.length });
    this.ctx.events.changed('playlists');
    return this.get(id);
  }

  update(id: number, input: PlaylistInput, user: string): PlaylistDto {
    const before = this.get(id);
    this.checkMedia(input);
    this.ctx.db.raw.transaction(() => {
      this.orm.update(playlists).set({ name: input.name, updatedAt: Date.now() }).where(eq(playlists.id, id)).run();
      this.writeItems(id, input);
    })();
    this.ctx.audit.write(user, 'update', 'playlist', id, {
      name: input.name,
      renamedFrom: before.name !== input.name ? before.name : undefined,
      items: input.items.length,
    });
    this.ctx.events.changed('playlists');
    return this.get(id);
  }

  duplicate(id: number, user: string): PlaylistDto {
    const src = this.get(id);
    return this.create(
      {
        name: `${src.name} (копия)`,
        items: src.items.map((i) => ({ mediaId: i.mediaId, durationSec: i.durationSec, fit: i.fit, transition: i.transition })),
      },
      user,
    );
  }

  /** Где используется плейлист: число правил расписания и активных переключений. */
  usage(id: number): { schedules: number; overrides: number } {
    const n = (t: typeof schedules | typeof overrides) =>
      this.orm.select({ n: sql<number>`count(*)` }).from(t).where(eq(t.playlistId, id)).get()?.n ?? 0;
    return { schedules: n(schedules), overrides: n(overrides) };
  }

  remove(id: number, force: boolean, user: string): void {
    const p = this.get(id);
    const used = this.usage(id);
    if ((used.schedules > 0 || used.overrides > 0) && !force) {
      throw conflict('Плейлист используется в расписании или ручных переключениях', used);
    }
    // Расписания и переключения удаляются каскадно (ON DELETE CASCADE).
    this.orm.delete(playlists).where(eq(playlists.id, id)).run();
    this.ctx.audit.write(user, 'delete', 'playlist', id, { name: p.name, ...used });
    this.ctx.events.changed('playlists');
    if (used.schedules) this.ctx.events.changed('schedules');
    if (used.overrides) this.ctx.events.changed('overrides');
  }
}
