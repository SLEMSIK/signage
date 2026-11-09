import { createHash } from 'node:crypto';
import { asc, eq, lte } from 'drizzle-orm';
import type { PlayerItem, ScreenResolved, StateMsg } from '@signage/shared';
import type { AppContext } from '../app.js';
import { groups, media, overrides, playlistItems, playlists, schedules, screens, type ScreenRow } from '../db/schema.js';
import { mediaUrl } from '../media/service.js';
import { resolve, type OverrideRule, type ResolveResult, type ScheduleRule } from './engine.js';

/** Максимальная задержка setTimeout, которую стоит ставить (страховка от переполнения). */
const MAX_TIMER_MS = 60 * 60_000;
const SAFETY_RECALC_MS = 60_000;

/**
 * Планировщик: для каждого экрана держит результат resolve(), пересчитывает
 * по таймеру на ближайший validUntil, раз в минуту и при любом изменении
 * данных, и рассылает плеерам изменившиеся state.
 */
export class PlaybackService {
  private resolved = new Map<number, ResolveResult>();
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private recalcQueued = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.recalculate();
    this.interval = setInterval(() => this.recalculate(), SAFETY_RECALC_MS);
    this.interval.unref();
    this.ctx.events.on('changed', (entity) => {
      if (entity !== 'media' || this.resolved.size > 0) this.queueRecalc();
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Склеивает несколько изменений подряд в один пересчёт. */
  queueRecalc(): void {
    if (this.recalcQueued) return;
    this.recalcQueued = true;
    setImmediate(() => {
      this.recalcQueued = false;
      this.recalculate();
    });
  }

  private loadRules(): { schedules: ScheduleRule[]; overrides: OverrideRule[] } {
    const orm = this.ctx.db.orm;
    return {
      schedules: orm.select().from(schedules).all(),
      overrides: orm.select().from(overrides).all(),
    };
  }

  recalculate(now = Date.now()): void {
    const orm = this.ctx.db.orm;
    // Истёкшие override больше не нужны.
    orm.delete(overrides).where(lte(overrides.until, now)).run();

    const rules = this.loadRules();
    const tz = this.ctx.config.server.timezone;
    const list = orm.select({ id: screens.id, groupId: screens.groupId }).from(screens).all();
    const next = new Map<number, ResolveResult>();
    let earliest: number | null = null;
    for (const s of list) {
      const r = resolve(s, now, rules, tz);
      next.set(s.id, r);
      if (r.validUntil !== null && (earliest === null || r.validUntil < earliest)) earliest = r.validUntil;
    }
    const changed = [...next].some(([id, r]) => {
      const prev = this.resolved.get(id);
      return !prev || prev.playlistId !== r.playlistId || prev.since !== r.since || prev.source !== r.source || prev.validUntil !== r.validUntil;
    }) || next.size !== this.resolved.size;
    this.resolved = next;

    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (earliest !== null) {
      const delay = Math.min(Math.max(earliest - Date.now(), 0) + 50, MAX_TIMER_MS);
      this.timer = setTimeout(() => this.recalculate(), delay);
      this.timer.unref();
    }

    // Содержимое плейлистов могло поменяться — хаб сам сравнит версии.
    this.ctx.hub.pushAll();
    if (changed) this.ctx.hub.onScreensChanged();
  }

  getResolved(screenId: number): ScreenResolved {
    const r = this.resolved.get(screenId);
    if (!r) return { playlistId: null, playlistName: null, source: 'none', validUntil: null, since: null, overrideId: null };
    const name =
      r.playlistId === null
        ? null
        : (this.ctx.db.orm.select({ name: playlists.name }).from(playlists).where(eq(playlists.id, r.playlistId)).get()?.name ?? null);
    return {
      playlistId: r.playlistId,
      playlistName: name,
      source: r.source,
      validUntil: r.validUntil,
      since: r.since,
      overrideId: r.source === 'override-screen' || r.source === 'override-group' ? r.ruleId : null,
    };
  }

  /** Элементы плейлиста в формате плеера. */
  playerItems(playlistId: number, fitDefault: 'contain' | 'cover'): PlayerItem[] {
    const orm = this.ctx.db.orm;
    const { player } = this.ctx.config;
    const rows = orm
      .select({ item: playlistItems, media })
      .from(playlistItems)
      .innerJoin(media, eq(media.id, playlistItems.mediaId))
      .where(eq(playlistItems.playlistId, playlistId))
      .orderBy(asc(playlistItems.position), asc(playlistItems.id))
      .all();
    return rows.map(({ item, media: m }) => {
      let durationSec = item.durationSec;
      let untilEnd = false;
      if (durationSec === null) {
        if (m.type === 'video') {
          durationSec = m.durationSec ?? 30;
          untilEnd = true;
        } else if (m.type === 'image') durationSec = player.defaultImageDurationSec;
        else durationSec = player.defaultHtmlDurationSec;
      }
      const out: PlayerItem = {
        itemId: item.id,
        mediaId: m.id,
        url: mediaUrl(m),
        type: m.type,
        durationSec,
        fit: item.fit ?? fitDefault,
        transition: item.transition,
      };
      if (untilEnd) out.untilEnd = true;
      if (m.type === 'html_zip' && m.files) out.assets = m.files.map((f) => `/content/${m.id}/${f.split('/').map(encodeURIComponent).join('/')}`);
      return out;
    });
  }

  stateFor(screenId: number): StateMsg | null {
    const orm = this.ctx.db.orm;
    const screen: ScreenRow | undefined = orm.select().from(screens).where(eq(screens.id, screenId)).get();
    if (!screen) return null;
    let r = this.resolved.get(screenId);
    if (!r) {
      // Новый экран — пересчитываем сразу, не дожидаясь общего цикла.
      r = resolve(screen, Date.now(), this.loadRules(), this.ctx.config.server.timezone);
      this.resolved.set(screenId, r);
    }
    const group = screen.groupId === null ? undefined : orm.select().from(groups).where(eq(groups.id, screen.groupId)).get();
    const items = r.playlistId === null ? [] : this.playerItems(r.playlistId, screen.fitDefault);
    const playlist = r.playlistId === null || items.length === 0 ? null : { id: r.playlistId, items };
    const body: Omit<StateMsg, 'version'> = {
      type: 'state',
      screenId: screen.id,
      name: screen.name,
      playlist,
      timezone: this.ctx.config.server.timezone,
      heartbeatSec: this.ctx.config.player.heartbeatSec,
    };
    if (playlist && group?.syncPlayback && r.since !== null) body.syncEpoch = r.since;
    const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    return { ...body, version };
  }

  /** Экраны, которые сейчас (по расписанию/override) играют данные плейлисты. */
  screensUsing(playlistIds: number[]): number[] {
    const set = new Set(playlistIds);
    return [...this.resolved].filter(([, r]) => r.playlistId !== null && set.has(r.playlistId)).map(([id]) => id);
  }
}
