import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { desc, eq, inArray } from 'drizzle-orm';
import sharp, { type Sharp } from 'sharp';
import type { MediaDto, MediaType } from '@signage/shared';
import type { AppContext } from '../app.js';
import { media, playlistItems, playlists, type MediaRow } from '../db/schema.js';
import { badRequest, conflict, HttpError, notFound } from '../util/http.js';
import { extractFrame, ffmpegAvailable, probeVideo } from './ffmpeg.js';
import { externalRefWarnings } from './html.js';
import { extractZip, ZipError } from './zip.js';
import type { MediaLocation } from './storage.js';

const EXT_TYPES: Record<string, MediaType> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  html: 'html',
  htm: 'html',
  zip: 'html_zip',
};

export const ACCEPTED_EXTENSIONS = Object.keys(EXT_TYPES);

const THUMB_W = 480;
const THUMB_H = 270;

export function mediaUrl(row: Pick<MediaRow, 'id' | 'type' | 'sha256'>): string {
  const v = row.sha256.slice(0, 8);
  return row.type === 'html' || row.type === 'html_zip' ? `/content/${row.id}/index.html?v=${v}` : `/media/${row.id}?v=${v}`;
}

export function toMediaDto(row: MediaRow): MediaDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    size: row.size,
    sha256: row.sha256,
    durationSec: row.durationSec,
    url: mediaUrl(row),
    location: row.location,
    thumbUrl: row.thumbPath ? `/thumbs/${row.id}?v=${row.sha256.slice(0, 8)}` : null,
    warnings: row.warnings,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/** Считает sha256 и размер на лету. */
class Hasher extends Transform {
  readonly hash = createHash('sha256');
  size = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err: Error | null, data?: Buffer) => void): void {
    this.hash.update(chunk);
    this.size += chunk.length;
    cb(null, chunk);
  }
}

export interface UploadInput {
  filename: string;
  stream: Readable & { truncated?: boolean };
  user: string;
}

export class MediaService {
  constructor(private readonly ctx: AppContext) {}

  private get orm() {
    return this.ctx.db.orm;
  }

  list(): MediaDto[] {
    return this.orm.select().from(media).orderBy(desc(media.createdAt), desc(media.id)).all().map(toMediaDto);
  }

  get(id: number): MediaRow {
    const row = this.orm.select().from(media).where(eq(media.id, id)).get();
    if (!row) throw notFound('Медиафайл не найден');
    return row;
  }

  findMany(ids: number[]): Map<number, MediaRow> {
    if (ids.length === 0) return new Map();
    const rows = this.orm.select().from(media).where(inArray(media.id, ids)).all();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Плейлисты, в которых используется медиафайл. */
  usage(id: number): { id: number; name: string }[] {
    return this.orm
      .selectDistinct({ id: playlists.id, name: playlists.name })
      .from(playlistItems)
      .innerJoin(playlists, eq(playlists.id, playlistItems.playlistId))
      .where(eq(playlistItems.mediaId, id))
      .all();
  }

  rename(id: number, title: string, user: string): MediaDto {
    this.get(id);
    this.orm.update(media).set({ title }).where(eq(media.id, id)).run();
    this.ctx.audit.write(user, 'rename', 'media', id, { title });
    this.ctx.events.changed('media');
    return toMediaDto(this.get(id));
  }

  async remove(id: number, force: boolean, user: string): Promise<void> {
    const row = this.get(id);
    const used = this.usage(id);
    if (used.length > 0 && !force) {
      throw conflict('Файл используется в плейлистах', { playlists: used });
    }
    this.orm.delete(media).where(eq(media.id, id)).run();
    this.ctx.audit.write(user, 'delete', 'media', id, { title: row.title, type: row.type, playlists: used.map((p) => p.name) });
    // Файлы удаляем после БД: даже если SMB сейчас недоступен, запись уже не мешает
    // (на SMB останется «сирота» — это безопаснее, чем висящая запись).
    const storage = this.ctx.storage;
    await fs.rm(storage.absIn(row.location, row.relPath), { recursive: true, force: true }).catch(() => undefined);
    if (row.thumbPath) await fs.rm(storage.absIn(row.location, row.thumbPath), { force: true }).catch(() => undefined);
    this.ctx.events.changed('media');
    if (used.length > 0) this.ctx.events.changed('playlists');
  }

  async upload(input: UploadInput): Promise<MediaDto> {
    const { storage, config } = this.ctx;
    let location: MediaLocation;
    try {
      location = await storage.uploadTarget();
    } catch (err) {
      input.stream.resume();
      throw new HttpError(503, (err as Error).message);
    }
    const at = (rel: string) => storage.absIn(location, rel);

    const ext = path.extname(input.filename).slice(1).toLowerCase();
    const type = EXT_TYPES[ext];
    if (!type) {
      input.stream.resume();
      throw badRequest(`Формат .${ext || '?'} не поддерживается. Допустимо: ${ACCEPTED_EXTENSIONS.join(', ')}`);
    }

    const uuid = randomUUID();
    const tmpDir = at('_tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${uuid}.${ext}`);
    const hasher = new Hasher();
    try {
      await pipeline(input.stream, hasher, createWriteStream(tmpFile));
      if (input.stream.truncated) throw new HttpError(413, `Файл больше ${config.storage.maxUploadMb} МБ`);
      if (hasher.size === 0) throw badRequest('Пустой файл');

      const sha256 = hasher.hash.digest('hex');
      const now = new Date();
      const datedDir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const title = path.basename(input.filename, path.extname(input.filename)).slice(0, 200) || input.filename;

      let relPath: string;
      let size = hasher.size;
      let durationSec: number | null = null;
      let thumbPath: string | null = null;
      let files: string[] | null = null;
      let entry: string | null = null;
      const warnings: string[] = [];

      if (type === 'html_zip') {
        relPath = `html/${uuid}`;
        const dest = at(relPath);
        try {
          const res = await extractZip(tmpFile, dest, {
            maxTotalBytes: config.storage.maxUnzippedMb * 1024 * 1024,
            maxEntries: 20_000,
          });
          files = res.files;
          size = res.totalBytes;
        } catch (err) {
          await fs.rm(dest, { recursive: true, force: true });
          if (err instanceof ZipError) throw badRequest(err.message);
          throw err;
        }
        entry = 'index.html';
        const index = await fs.readFile(path.join(dest, entry), 'utf8');
        warnings.push(...externalRefWarnings(index));
        for (const f of files.filter((x) => x.endsWith('.css')).slice(0, 50)) {
          const css = await fs.readFile(path.join(dest, f), 'utf8').catch(() => '');
          const w = externalRefWarnings(css);
          if (w.length) warnings.push(...w.slice(1).map((x) => `${f}: ${x}`));
        }
        await fs.rm(tmpFile, { force: true });
      } else {
        relPath = `${datedDir}/${uuid}.${ext}`;
        const finalPath = at(relPath);

        if (type === 'image') {
          try {
            const meta = await sharp(tmpFile).metadata();
            if (!meta.width || !meta.height) throw new Error('нет размеров');
          } catch {
            throw badRequest('Файл не похож на изображение или повреждён');
          }
          thumbPath = await this.makeThumb(location, uuid, () => sharp(tmpFile, { animated: false }).rotate());
        } else if (type === 'video') {
          if (await ffmpegAvailable()) {
            try {
              const info = await probeVideo(tmpFile);
              durationSec = info.durationSec;
              if (ext !== 'webm' && info.codec && info.codec !== 'h264') {
                warnings.push(`Кодек видео ${info.codec}: браузер на экране может его не воспроизвести. Рекомендуется H.264.`);
              }
              if (info.width && info.height && info.width * info.height > 1920 * 1080 * 1.1) {
                warnings.push(`Разрешение ${info.width}×${info.height} больше 1920×1080 — лишняя нагрузка на плеер.`);
              }
              const at = durationSec ? Math.min(1, durationSec / 2) : 0;
              const frame = await extractFrame(tmpFile, at);
              thumbPath = await this.makeThumb(location, uuid, () => sharp(frame));
            } catch (err) {
              this.ctx.log.warn({ err }, 'video probe failed');
              warnings.push('Не удалось проанализировать видео (ffprobe). Длительность нужно задать вручную.');
            }
          } else {
            warnings.push('ffmpeg не установлен на сервере: нет превью и автоматической длительности.');
          }
        } else {
          const html = await fs.readFile(tmpFile, 'utf8');
          warnings.push(...externalRefWarnings(html));
        }

        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.rename(tmpFile, finalPath);
      }

      if (location === 'local') {
        warnings.unshift('Сетевой диск был недоступен: файл сохранён на диск сервера и будет перенесён на сетевой диск автоматически.');
      }

      const row = this.orm
        .insert(media)
        .values({
          type,
          location,
          title,
          relPath,
          entry,
          size,
          sha256,
          durationSec,
          thumbPath,
          files,
          warnings,
          createdAt: Date.now(),
          createdBy: input.user,
        })
        .returning()
        .get();
      this.ctx.audit.write(input.user, 'upload', 'media', row.id, { title, type, size, location });
      this.ctx.events.changed('media');
      return toMediaDto(row);
    } finally {
      await fs.rm(tmpFile, { force: true }).catch(() => undefined);
    }
  }

  private async makeThumb(location: MediaLocation, uuid: string, source: () => Sharp): Promise<string | null> {
    const rel = `thumbs/${uuid}.webp`;
    const abs = this.ctx.storage.absIn(location, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    try {
      await source().resize(THUMB_W, THUMB_H, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toFile(abs);
      return rel;
    } catch {
      return null;
    }
  }
}
