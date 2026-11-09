import { z } from 'zod';

/** Типы медиа, которые умеет показывать плеер. */
export const mediaTypeSchema = z.enum(['image', 'video', 'html', 'html_zip']);
export type MediaType = z.infer<typeof mediaTypeSchema>;

export const fitSchema = z.enum(['contain', 'cover', 'stretch']);
export type Fit = z.infer<typeof fitSchema>;

export const transitionSchema = z.enum(['none', 'fade']);
export type Transition = z.infer<typeof transitionSchema>;

/** Элемент плейлиста в том виде, в котором его получает плеер. */
export const playerItemSchema = z.object({
  /** id элемента плейлиста (уникален в пределах плейлиста). */
  itemId: z.number().int(),
  mediaId: z.number().int(),
  url: z.string(),
  type: mediaTypeSchema,
  /** Итоговая длительность показа в секундах (уже с учётом значений по умолчанию). */
  durationSec: z.number().positive(),
  /** Для видео без явной длительности: переключаться по событию ended. */
  untilEnd: z.boolean().optional(),
  fit: fitSchema,
  transition: transitionSchema,
  /** Для html_zip: все файлы пакета, чтобы Service Worker мог закэшировать их заранее. */
  assets: z.array(z.string()).optional(),
});
export type PlayerItem = z.infer<typeof playerItemSchema>;

export const playerPlaylistSchema = z.object({
  id: z.number().int(),
  items: z.array(playerItemSchema),
});
export type PlayerPlaylist = z.infer<typeof playerPlaylistSchema>;

// ---------------------------------------------------------------------------
// Плеер → сервер
// ---------------------------------------------------------------------------

export const helloMsg = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  /** Версия сборки плеера, для диагностики. */
  build: z.string().optional(),
});

export const cacheStatusSchema = z.object({
  /** Включён ли Service Worker. */
  sw: z.boolean(),
  /** Сколько URL текущего плейлиста лежит в кэше. */
  cached: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type CacheStatus = z.infer<typeof cacheStatusSchema>;

export const heartbeatMsg = z.object({
  type: z.literal('heartbeat'),
  currentItemId: z.number().int().nullable(),
  playlistId: z.number().int().nullable(),
  cacheStatus: cacheStatusSchema,
  viewport: z.object({ w: z.number(), h: z.number() }),
  uptime: z.number().nonnegative(),
  /** Версия state, которую сейчас играет плеер. */
  version: z.string().optional(),
});
export type HeartbeatMsg = z.infer<typeof heartbeatMsg>;

export const pongMsg = z.object({ type: z.literal('pong'), t: z.number() });

export const errorMsg = z.object({
  type: z.literal('error'),
  message: z.string().max(2000),
  mediaId: z.number().int().optional(),
});

export const playerToServerSchema = z.discriminatedUnion('type', [helloMsg, heartbeatMsg, pongMsg, errorMsg]);
export type PlayerToServer = z.infer<typeof playerToServerSchema>;

// ---------------------------------------------------------------------------
// Сервер → плеер
// ---------------------------------------------------------------------------

export const pairingMsg = z.object({ type: z.literal('pairing'), code: z.string().regex(/^\d{6}$/) });

export const pairedMsg = z.object({
  type: z.literal('paired'),
  token: z.string(),
  screenId: z.number().int(),
  name: z.string(),
});

export const stateMsg = z.object({
  type: z.literal('state'),
  screenId: z.number().int(),
  name: z.string(),
  playlist: playerPlaylistSchema.nullable(),
  /**
   * Если задан — синхронный показ: позиция в плейлисте считается от этого
   * момента (epoch ms по часам сервера).
   */
  syncEpoch: z.number().optional(),
  /** Хэш содержимого state. Одинаковая версия — ничего не менять. */
  version: z.string(),
  /** Часовой пояс сервера, нужен для ночной перезагрузки в 04:00. */
  timezone: z.string(),
  heartbeatSec: z.number().positive(),
});
export type StateMsg = z.infer<typeof stateMsg>;

export const pingMsg = z.object({
  type: z.literal('ping'),
  /** Время сервера в момент отправки. */
  t: z.number(),
  /** Последний измеренный RTT в мс — плееру для расчёта смещения часов. */
  rtt: z.number().optional(),
});

export const reloadMsg = z.object({ type: z.literal('reload') });
export const identifyMsg = z.object({ type: z.literal('identify'), name: z.string() });

export const serverToPlayerSchema = z.discriminatedUnion('type', [
  pairingMsg,
  pairedMsg,
  stateMsg,
  pingMsg,
  reloadMsg,
  identifyMsg,
]);
export type ServerToPlayer = z.infer<typeof serverToPlayerSchema>;
