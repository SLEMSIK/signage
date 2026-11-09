import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../app.js';
import { media, type MediaRow } from '../db/schema.js';

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

/**
 * Перенос файлов, сохранённых на диск VM во время недоступности SMB, обратно
 * на сетевой диск. Путь относительно корня хранилища не меняется, поэтому URL
 * медиа остаются прежними и кэш плееров не сбрасывается.
 *
 * Порядок: копия во временный путь на SMB → проверка → атомарный rename →
 * смена location в БД → удаление локальной копии. Сбой на любом шаге оставляет
 * файл на диске VM, следующая попытка — при следующей проверке хранилища.
 */
export class MediaSync {
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  pendingCount(): number {
    return (
      this.ctx.db.orm
        .select({ n: sql<number>`count(*)` })
        .from(media)
        .where(eq(media.location, 'local'))
        .get()?.n ?? 0
    );
  }

  /** Запускает перенос, если SMB доступен и есть что переносить. Повторный вызов во время работы игнорируется. */
  async run(): Promise<number> {
    const { storage } = this.ctx;
    if (this.running || !storage.available || !storage.localRoot) return 0;
    const rows = this.ctx.db.orm.select().from(media).where(eq(media.location, 'local')).all();
    if (rows.length === 0) return 0;
    this.running = true;
    let moved = 0;
    try {
      this.ctx.log.info({ count: rows.length }, 'moving locally stored media to primary storage');
      for (const row of rows) {
        if (!storage.available) break;
        try {
          await this.moveOne(row);
          moved++;
        } catch (err) {
          this.ctx.log.warn({ err, mediaId: row.id }, 'failed to move media to primary storage, will retry');
        }
      }
    } finally {
      this.running = false;
    }
    if (moved > 0) {
      this.ctx.audit.write('system', 'move_to_primary', 'media', null, { count: moved });
      this.ctx.events.changed('media');
      this.ctx.events.emit('status');
    }
    return moved;
  }

  private async moveOne(row: MediaRow): Promise<void> {
    const { storage } = this.ctx;
    const src = storage.absIn('local', row.relPath);
    const dst = storage.absIn('primary', row.relPath);
    const tmp = `${dst}.moving-${process.pid}`;
    const stat = await fs.stat(src);

    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dst), { recursive: true });
    if (stat.isDirectory()) {
      await fs.cp(src, tmp, { recursive: true, errorOnExist: false, force: true });
      const [a, b] = await Promise.all([listTree(src), listTree(tmp)]);
      const same = a.size === b.size && [...a].every(([f, size]) => b.get(f) === size);
      if (!same) throw new Error('Копия пакета на сетевом диске не совпадает с оригиналом');
    } else {
      await fs.copyFile(src, tmp);
      if ((await sha256File(tmp)) !== row.sha256) throw new Error('Контрольная сумма копии не совпадает');
    }
    // Если на SMB уже лежит что-то по этому пути (прерванный перенос) — заменяем.
    await fs.rm(dst, { recursive: true, force: true });
    await fs.rename(tmp, dst);

    if (row.thumbPath) {
      const tSrc = storage.absIn('local', row.thumbPath);
      const tDst = storage.absIn('primary', row.thumbPath);
      await fs.mkdir(path.dirname(tDst), { recursive: true });
      await fs.copyFile(tSrc, tDst).catch(() => undefined);
    }

    // Запись могли удалить, пока шло копирование, — тогда убираем копию.
    const updated = this.ctx.db.orm
      .update(media)
      .set({ location: 'primary' })
      .where(and(eq(media.id, row.id), eq(media.location, 'local')))
      .run();
    if (updated.changes === 0) {
      await fs.rm(dst, { recursive: true, force: true });
      return;
    }
    await fs.rm(src, { recursive: true, force: true });
    if (row.thumbPath) await fs.rm(storage.absIn('local', row.thumbPath), { force: true }).catch(() => undefined);
    this.ctx.log.info({ mediaId: row.id, title: row.title }, 'media moved to primary storage');
  }
}
