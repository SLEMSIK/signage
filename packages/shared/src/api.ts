import { z } from 'zod';
import type { mediaTypeSchema} from './protocol.js';
import { fitSchema, transitionSchema } from './protocol.js';

/** Типы, которыми обмениваются сервер и админка. */

export const roleSchema = z.enum(['admin', 'operator']);
export type Role = z.infer<typeof roleSchema>;

export interface Me {
  login: string;
  role: Role;
}

export const targetTypeSchema = z.enum(['screen', 'group']);
export type TargetType = z.infer<typeof targetTypeSchema>;

export type ResolveSource = 'override-screen' | 'override-group' | 'schedule-screen' | 'schedule-group' | 'none';

export interface MediaDto {
  id: number;
  type: z.infer<typeof mediaTypeSchema>;
  title: string;
  size: number;
  sha256: string;
  durationSec: number | null;
  url: string;
  thumbUrl: string | null;
  warnings: string[];
  createdAt: number;
  createdBy: string;
}

export interface GroupDto {
  id: number;
  name: string;
  syncPlayback: boolean;
  screenCount: number;
}

export interface ScreenRuntime {
  online: boolean;
  lastSeenAt: number | null;
  currentItemId: number | null;
  playingPlaylistId: number | null;
  viewport: { w: number; h: number } | null;
  uptime: number | null;
  cacheStatus: { sw: boolean; cached: number; total: number } | null;
  ip: string | null;
  lastError: string | null;
}

export interface ScreenResolved {
  playlistId: number | null;
  playlistName: string | null;
  source: ResolveSource;
  validUntil: number | null;
  since: number | null;
  overrideId: number | null;
}

export interface ScreenDto {
  id: number;
  name: string;
  groupId: number | null;
  groupName: string | null;
  fitDefault: 'contain' | 'cover';
  syncMode: boolean;
  createdAt: number;
  runtime: ScreenRuntime;
  resolved: ScreenResolved;
}

export interface PlaylistItemDto {
  id: number;
  mediaId: number;
  position: number;
  durationSec: number | null;
  fit: z.infer<typeof fitSchema> | null;
  transition: z.infer<typeof transitionSchema>;
  media: MediaDto | null;
}

export interface PlaylistSummaryDto {
  id: number;
  name: string;
  itemCount: number;
  totalDurationSec: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistDto extends PlaylistSummaryDto {
  items: PlaylistItemDto[];
}

export const playlistItemInput = z.object({
  mediaId: z.number().int().positive(),
  durationSec: z.number().positive().max(86400).nullable(),
  /** null — как у экрана по умолчанию. */
  fit: fitSchema.nullable(),
  transition: transitionSchema,
});
export const playlistInput = z.object({
  name: z.string().trim().min(1).max(200),
  items: z.array(playlistItemInput).max(1000),
});
export type PlaylistInput = z.infer<typeof playlistInput>;

export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате HH:MM');

export const scheduleInput = z.object({
  targetType: targetTypeSchema,
  targetId: z.number().int().positive(),
  playlistId: z.number().int().positive().nullable(),
  /** Битовая маска: бит 0 — понедельник … бит 6 — воскресенье. */
  days: z.number().int().min(1).max(127),
  startTime: timeSchema,
  endTime: timeSchema,
  priority: z.number().int().min(-1000).max(1000),
  enabled: z.boolean(),
});
export type ScheduleInput = z.infer<typeof scheduleInput>;

export interface ScheduleDto extends ScheduleInput {
  id: number;
  playlistName: string | null;
}

export const overrideInput = z.object({
  targets: z.array(z.object({ type: targetTypeSchema, id: z.number().int().positive() })).min(1),
  playlistId: z.number().int().positive().nullable(),
  /** next — до следующей смены по расписанию, hours — на N часов, forever — до отмены. */
  mode: z.enum(['next', 'hours', 'forever']),
  hours: z.number().positive().max(24 * 365).optional(),
});
export type OverrideInput = z.infer<typeof overrideInput>;

export interface OverrideDto {
  id: number;
  targetType: TargetType;
  targetId: number;
  targetName: string;
  playlistId: number | null;
  playlistName: string | null;
  until: number | null;
  createdBy: string;
  createdAt: number;
}

export interface AuditDto {
  id: number;
  user: string;
  action: string;
  entity: string;
  entityId: string | null;
  payload: unknown;
  at: number;
}

export interface SystemStatus {
  version: string;
  storageAvailable: boolean;
  storageError: string | null;
  serverTime: number;
  timezone: string;
  ffmpeg: boolean;
  maxUploadMb: number;
}

export interface BackupDto {
  name: string;
  size: number;
  createdAt: number;
}

/** Сообщения, которые сервер шлёт админке по /api/admin/ws. */
export type AdminEvent =
  | { type: 'screens'; screens: ScreenDto[] }
  | { type: 'pending'; codes: number }
  | { type: 'status'; status: SystemStatus }
  | { type: 'changed'; entity: 'media' | 'playlists' | 'schedules' | 'overrides' | 'groups' | 'screens' };
