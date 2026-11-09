import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  syncPlayback: integer('sync_playback', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().default(now),
});

export const screens = sqliteTable(
  'screens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    groupId: integer('group_id').references(() => groups.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash').notNull().unique(),
    status: text('status', { enum: ['online', 'offline'] }).notNull().default('offline'),
    lastSeenAt: integer('last_seen_at'),
    currentItem: text('current_item', { mode: 'json' }).$type<{ itemId: number | null; playlistId: number | null } | null>(),
    fitDefault: text('fit_default', { enum: ['contain', 'cover'] }).notNull().default('contain'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('screens_group_idx').on(t.groupId)],
);

export const media = sqliteTable('media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['image', 'video', 'html', 'html_zip'] }).notNull(),
  title: text('title').notNull(),
  /** Путь относительно storage.mediaPath. Для html_zip — каталог пакета. */
  relPath: text('rel_path').notNull(),
  /** Для html_zip — путь к index.html внутри каталога пакета. */
  entry: text('entry'),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  durationSec: real('duration_sec'),
  thumbPath: text('thumb_path'),
  /** Для html_zip — список файлов пакета (для предзагрузки в плеере). */
  files: text('files', { mode: 'json' }).$type<string[] | null>(),
  warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: integer('created_at').notNull().default(now),
  createdBy: text('created_by').notNull(),
});

export const playlists = sqliteTable('playlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const playlistItems = sqliteTable(
  'playlist_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    durationSec: real('duration_sec'),
    fit: text('fit', { enum: ['contain', 'cover', 'stretch'] }).notNull().default('contain'),
    transition: text('transition', { enum: ['none', 'fade'] }).notNull().default('none'),
  },
  (t) => [index('playlist_items_playlist_idx').on(t.playlistId, t.position), index('playlist_items_media_idx').on(t.mediaId)],
);

export const schedules = sqliteTable(
  'schedules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    targetType: text('target_type', { enum: ['screen', 'group'] }).notNull(),
    targetId: integer('target_id').notNull(),
    /** null — чёрный экран. */
    playlistId: integer('playlist_id').references(() => playlists.id, { onDelete: 'cascade' }),
    /** Битовая маска: бит 0 — Пн … бит 6 — Вс. */
    days: integer('days').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    priority: integer('priority').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('schedules_target_idx').on(t.targetType, t.targetId)],
);

export const overrides = sqliteTable(
  'overrides',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    targetType: text('target_type', { enum: ['screen', 'group'] }).notNull(),
    targetId: integer('target_id').notNull(),
    playlistId: integer('playlist_id').references(() => playlists.id, { onDelete: 'cascade' }),
    /** epoch ms; null — до отмены. */
    until: integer('until'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('overrides_target_idx').on(t.targetType, t.targetId)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    user: text('user').notNull(),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    payload: text('payload', { mode: 'json' }),
    at: integer('at').notNull().default(now),
  },
  (t) => [index('audit_at_idx').on(t.at)],
);

export type GroupRow = typeof groups.$inferSelect;
export type ScreenRow = typeof screens.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type PlaylistRow = typeof playlists.$inferSelect;
export type PlaylistItemRow = typeof playlistItems.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type OverrideRow = typeof overrides.$inferSelect;
