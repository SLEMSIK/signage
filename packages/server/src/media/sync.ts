import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../app.js';
import { media, type MediaRow } from '../db/schema.js';
import type { MediaLocation } from './storage.js';

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Все файлы каталога рекурсивно (относительные пути) с размерами. */
async function listTree(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.set(path.relative(dir, full), (await fs.stat(full)).size);
    }
  };
  await walk(dir);
  return out;
}

export interface MirrorStatus {
  enabled: boolean;
  /** Сколько файлов SMB имеют копию на диске VM. */
  mirrored: number;
  /** Сколько всего файлов лежит на SMB. */
  total: number;
  /** Почему зеркало неполное (например, нет места). */
  problem: string | null;
}

/**
 * Синхронизация двух мест хранения медиа: SMB (primary) и диска VM (local).
 *
 * 1. Перенос: файлы, загруженные на диск VM при недоступном SMB, копируются на SMB.
 *    Локальная копия остаётся зеркалом (если localMirror включён) или удаляется.
 * 2. Зеркало: для файлов на SMB делается копия на диске VM, чтобы при недоступном
 *    SMB сервер мог отдавать их плеерам и админке.
 *
 * Относительный путь одинаков в обоих местах, поэтому URL медиа не меняются.
 * Копирование: во временный путь → проверка (sha256 или состав пакета) → rename.
 * Сбой оставляет всё как было; следующая попытка — при следующей проверке SMB.
 */
export class MediaSync {
  private current: Promise<number> | null = null;
  private rerun = false;
  private problem: string | null = null;

  constructor(private readonly ctx: AppContext) {}

  private get mirrorEnabled(): boolean {
    return this.ctx.config.storage.localMirror && this.ctx.storage.localRoot !== null;
  }

  /** Сколько файлов лежит только на диске VM и ждёт переноса на SMB. */
  pendingCount(): number {
    return this.ctx.db.orm.select({ n: sql<number>`count(*)` }).from(media).where(eq(media.location, 'local')).get()?.n ?? 0;
  }

  mirrorStatus(): MirrorStatus {
    const row = this.ctx.db.orm
      .select({ total: sql<number>`count(*)`, mirrored: sql<number>`coalesce(sum(${media.mirrored}), 0)` })
      .from(media)
      .where(eq(media.location, 'primary'))
      .get();
    return { enabled: this.mirrorEnabled, mirrored: row?.mirrored ?? 0, total: row?.total ?? 0, problem: this.mirrorEnabled ? this.problem : null };
  }

  /**
   * Запускает перенос и зеркалирование. Если проход уже идёт — ставит повтор
   * в очередь и возвращает тот же промис (он завершится после повтора).
   * Результат — сколько файлов перенесено с диска VM на SMB.
   */
  run(): Promise<number> {
    const { storage } = this.ctx;
    if (!storage.available || !storage.localRoot) return Promise.resolve(0);
    if (this.current) {
      this.rerun = true;
      return this.current;
    }
    this.current = this.loop().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async loop(): Promise<number> {
    const { storage } = this.ctx;
    let moved = 0;
    let mirrored = 0;
    do {
      this.rerun = false;
      moved += await this.moveLocalToPrimary();
      mirrored += await this.mirrorPrimaryToLocal();
    } while (this.rerun && storage.available);
    if (moved > 0) this.ctx.audit.write('system', 'move_to_primary', 'media', null, { count: moved });
    if (moved > 0 || mirrored > 0) {
      this.ctx.events.changed('media');
      this.ctx.events.emit('status');
    }
    return moved;
  }

  // ---------------------------------------------------------------------------

  private async moveLocalToPrimary(): Promise<number> {
    const rows = this.ctx.db.orm.select().from(media).where(eq(media.location, 'local')).all();
    if (rows.length === 0) return 0;
    this.ctx.log.info({ count: rows.length }, 'moving locally stored media to primary storage');
    let moved = 0;
    for (const row of rows) {
      if (!this.ctx.storage.available) break;
      try {
        await this.copyVerified(row, 'local', 'primary');
        const keep = this.mirrorEnabled;
        // Запись могли удалить, пока шло копирование, — тогда убираем копию.
        const res = this.ctx.db.orm
          .update(media)
          .set({ location: 'primary', mirrored: keep })
          .where(and(eq(media.id, row.id), eq(media.location, 'local')))
          .run();
        if (res.changes === 0) {
          await this.removeCopy(row, 'primary');
          continue;
        }
        if (!keep) await this.removeCopy(row, 'local');
        moved++;
        this.ctx.log.info({ mediaId: row.id, title: row.title }, 'media moved to primary storage');
      } catch (err) {
        this.ctx.log.warn({ err, mediaId: row.id }, 'failed to move media to primary storage, will retry');
      }
    }
    return moved;
  }

  private async mirrorPrimaryToLocal(): Promise<number> {
    const orm = this.ctx.db.orm;
    if (!this.mirrorEnabled) {
      // Зеркало выключили — освобождаем место на диске VM.
      for (const row of orm.select().from(media).where(and(eq(media.location, 'primary'), eq(media.mirrored, true))).all()) {
        await this.removeCopy(row, 'local');
        orm.update(media).set({ mirrored: false }).where(eq(media.id, row.id)).run();
      }
      return 0;
    }
    const rows = orm.select().from(media).where(and(eq(media.location, 'primary'), eq(media.mirrored, false))).all();
    this.problem = null;
    let done = 0;
    const minFree = this.ctx.config.storage.localMinFreeMb * 1024 * 1024;
    for (const row of rows) {
      if (!this.ctx.storage.available) break;
      const free = await this.ctx.storage.localFreeBytes();
      if (free === null || free - row.size < minFree) {
        this.problem = 'Не хватает места на диске сервера для копии медиатеки — часть файлов без SMB будет недоступна';
        this.ctx.log.warn({ free, need: row.size }, 'local mirror stopped: not enough disk space');
        break;
      }
      try {
        await this.copyVerified(row, 'primary', 'local');
        const res = orm
          .update(media)
          .set({ mirrored: true })
          .where(and(eq(media.id, row.id), eq(media.location, 'primary')))
          .run();
        if (res.changes === 0) await this.removeCopy(row, 'local');
        else done++;
      } catch (err) {
        this.ctx.log.warn({ err, mediaId: row.id }, 'failed to mirror media to local disk, will retry');
      }
    }
    if (done > 0) this.ctx.log.info({ count: done }, 'media mirrored to local disk');
    return done;
  }

  /** Копирует файл (или каталог пакета) и превью из одного места в другое с проверкой. */
  private async copyVerified(row: MediaRow, from: MediaLocation, to: MediaLocation): Promise<void> {
    const { storage } = this.ctx;
    const src = storage.absIn(from, row.relPath);
    const dst = storage.absIn(to, row.relPath);
    const tmp = `${dst}.copying-${process.pid}`;
    const stat = await fs.stat(src);

    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dst), { recursive: true });
    try {
      if (stat.isDirectory()) {
        await fs.cp(src, tmp, { recursive: true, errorOnExist: false, force: true });
        const [a, b] = await Promise.all([listTree(src), listTree(tmp)]);
        const same = a.size === b.size && [...a].every(([f, size]) => b.get(f) === size);
        if (!same) throw new Error('Копия пакета не совпадает с оригиналом');
      } else {
        await fs.copyFile(src, tmp);
        if ((await sha256File(tmp)) !== row.sha256) throw new Error('Контрольная сумма копии не совпадает');
      }
      // Если по этому пути уже что-то лежит (прерванная попытка) — заменяем.
      await fs.rm(dst, { recursive: true, force: true });
      await fs.rename(tmp, dst);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    if (row.thumbPath) {
      const tDst = storage.absIn(to, row.thumbPath);
      await fs.mkdir(path.dirname(tDst), { recursive: true });
      await fs.copyFile(storage.absIn(from, row.thumbPath), tDst).catch(() => undefined);
    }
  }

  private async removeCopy(row: MediaRow, where: MediaLocation): Promise<void> {
    const { storage } = this.ctx;
    await fs.rm(storage.absIn(where, row.relPath), { recursive: true, force: true }).catch(() => undefined);
    if (row.thumbPath) await fs.rm(storage.absIn(where, row.thumbPath), { force: true }).catch(() => undefined);
  }
}
