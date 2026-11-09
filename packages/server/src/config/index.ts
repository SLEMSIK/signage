import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseCidr } from '../auth/network.js';

const bcryptHash = z.string().regex(/^\$2[aby]\$\d{2}\$.{53}$/, 'passwordHash должен быть bcrypt-хэшем (npm run hash-password)');

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Неизвестный часовой пояс');

export const configSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(8080),
    host: z.string().default('0.0.0.0'),
    publicUrl: z.url(),
    timezone: timezone.default('Europe/Moscow'),
    sessionSecret: z.string().min(16, 'sessionSecret — минимум 16 символов'),
    sessionTtlHours: z.number().positive().default(12),
    allowedNetworks: z
      .array(z.string().refine((c) => parseCidr(c) !== null, 'Неверная подсеть CIDR'))
      .default(['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12']),
    /** Включить, если перед сервером стоит reverse proxy (берём IP из X-Forwarded-For). */
    trustProxy: z.boolean().default(false),
  }),
  users: z
    .array(
      z.object({
        login: z.string().min(1),
        role: z.enum(['admin', 'operator']),
        passwordHash: bcryptHash,
      }),
    )
    .min(1)
    .refine((u) => new Set(u.map((x) => x.login)).size === u.length, 'Логины пользователей должны быть уникальны'),
  storage: z.object({
    mediaPath: z.string().default('/data/smb/share'),
    dbPath: z.string().default('/data/db/signage.sqlite'),
    backupPath: z.string().default('/data/smb/share/_backup'),
    /**
     * Резервный каталог на диске VM: сюда сохраняются загрузки, пока SMB недоступен,
     * потом файлы автоматически переносятся на SMB. null — резерв выключен.
     */
    localFallbackPath: z.string().nullable().default('/data/local-media'),
    /** Не принимать загрузки на диск VM, если свободного места меньше. */
    localMinFreeMb: z.number().nonnegative().default(2048),
    /**
     * Держать на диске VM копию всей медиатеки (в localFallbackPath) и отдавать её,
     * пока SMB недоступен. Без зеркала при недоступном SMB отдаются только файлы,
     * загруженные в это время.
     */
    localMirror: z.boolean().default(true),
    maxUploadMb: z.number().positive().default(500),
    /** Лимит размера zip после распаковки. */
    maxUnzippedMb: z.number().positive().default(1000),
    backupKeep: z.number().int().positive().default(14),
    /** Время ежедневного бэкапа в server.timezone. */
    backupTime: z.string().regex(/^\d{2}:\d{2}$/).default('03:30'),
  }),
  proxy: z
    .object({
      allowlist: z.array(z.string().min(1)).default([]),
      cacheTtlSec: z.number().int().nonnegative().default(300),
      timeoutSec: z.number().positive().default(10),
      maxResponseKb: z.number().positive().default(2048),
    })
    .default({ allowlist: [], cacheTtlSec: 300, timeoutSec: 10, maxResponseKb: 2048 }),
  player: z
    .object({
      heartbeatSec: z.number().positive().default(15),
      offlineAfterSec: z.number().positive().default(45),
      defaultImageDurationSec: z.number().positive().default(10),
      defaultHtmlDurationSec: z.number().positive().default(30),
    })
    .default({ heartbeatSec: 15, offlineAfterSec: 45, defaultImageDurationSec: 10, defaultHtmlDurationSec: 30 }),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

/** Читает и валидирует config.yaml. Относительные пути считаются от каталога файла конфига. */
export function loadConfig(filePath: string): Config {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Не удалось прочитать конфиг ${filePath}: ${(err as Error).message}`);
  }
  return parseConfig(raw, path.dirname(path.resolve(filePath)));
}

export function parseConfig(yamlText: string, baseDir: string): Config {
  const data: unknown = parseYaml(yamlText);
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Ошибка в конфиге:\n${lines.join('\n')}`);
  }
  const cfg = result.data;
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));
  cfg.storage.mediaPath = abs(cfg.storage.mediaPath);
  cfg.storage.dbPath = abs(cfg.storage.dbPath);
  cfg.storage.backupPath = abs(cfg.storage.backupPath);
  if (cfg.storage.localFallbackPath) cfg.storage.localFallbackPath = abs(cfg.storage.localFallbackPath);
  else cfg.storage.localFallbackPath = null;
  cfg.server.publicUrl = cfg.server.publicUrl.replace(/\/+$/, '');
  cfg.proxy.allowlist = cfg.proxy.allowlist.map((d) => d.toLowerCase());
  return cfg;
}
