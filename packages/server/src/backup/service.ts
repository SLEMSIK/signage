import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupDto } from '@signage/shared';
import type { AppContext } from '../app.js';
import { zonedParts } from '../schedule/time.js';
import { badRequest, HttpError, notFound } from '../util/http.js';

const NAME_RE = /^signage-\d{8}-\d{6}(-[a-z-]+)?\.sqlite$/;

export interface BackupFile extends BackupDto {
  location: 'primary' | 'local';
  file: string;
}

/**
 * Бэкапы БД: VACUUM INTO во временный файл на локальном диске → копия в
 * storage.backupPath (SMB). Если SMB недоступен — в резервный каталог на диске
 * VM, откуда бэкапы переносятся на SMB при его появлении. Ротация — backupKeep копий.
 */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private lastDailyDay: string | null = null;
  private running: Promise<BackupFile | null> | null = null;

  constructor(private readonly ctx: AppContext) {}

  private get localDir(): string | null {
    const root = this.ctx.storage.localRoot;
    return root ? path.join(root, '_backup') : null;
  }

  private stamp(now = Date.now()): { name: string; day: string } {
    const p = zonedParts(now, this.ctx.config.server.timezone);
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${p.year}${pad(p.month)}${pad(p.day)}`;
    return { name: `signage-${day}-${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`, day };
  }

  /** Создаёт бэкап. reason попадает в имя файла (например, pre-restore). */
  create(reason?: string): Promise<BackupFile | null> {
    if (this.running) return this.running;
    this.running = this.doCreate(reason).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doCreate(reason?: string): Promise<BackupFile | null> {
    const { storage, config, db, log } = this.ctx;
    let dir: string;
    let location: 'primary' | 'local';
    if (storage.available) {
      dir = config.storage.backupPath;
      location = 'primary';
    } else if (this.localDir) {
      dir = this.localDir;
      location = 'local';
    } else {
      log.warn('backup skipped: storage unavailable and no local fallback');
      return null;
    }
    const { name } = this.stamp();
    const fileName = `${name}${reason ? `-${reason}` : ''}.sqlite`;
    // VACUUM INTO пишем рядом с БД (локальный диск), а на SMB только копируем:
    // SQLite на SMB ненадёжен даже для записи нового файла.
    const tmp = path.join(path.dirname(db.file), `.backup-${process.pid}.sqlite`);
    try {
      db.vacuumInto(tmp);
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, fileName);
      await fs.copyFile(tmp, `${target}.part`);
      await fs.rename(`${target}.part`, target);
      const st = await fs.stat(target);
      log.info({ file: target, size: st.size }, 'database backup created');
      await this.rotate(dir);
      return { name: fileName, size: st.size, createdAt: st.mtimeMs, location, file: target };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  private async rotate(dir: string): Promise<void> {
    const keep = this.ctx.config.storage.backupKeep;
    const files = (await fs.readdir(dir)).filter((f) => NAME_RE.test(f)).sort().reverse();
    for (const f of files.slice(keep)) await fs.rm(path.join(dir, f), { force: true });
  }

  async list(): Promise<BackupFile[]> {
    const out: BackupFile[] = [];
    const scan = async (dir: string | null, location: 'primary' | 'local') => {
      if (!dir) return;
      if (location === 'primary' && !this.ctx.storage.available) return;
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      for (const n of names.filter((f) => NAME_RE.test(f))) {
        const file = path.join(dir, n);
        const st = await fs.stat(file).catch(() => null);
        if (st) out.push({ name: n, size: st.size, createdAt: st.mtimeMs, location, file });
      }
    };
    await scan(this.ctx.config.storage.backupPath, 'primary');
    await scan(this.localDir, 'local');
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }

  async find(name: string): Promise<BackupFile> {
    if (!NAME_RE.test(name)) throw badRequest('Некорректное имя бэкапа');
    const b = (await this.list()).find((x) => x.name === name);
    if (!b) throw notFound('Бэкап не найден');
    return b;
  }

  /** Восстановление: сначала страховочный бэкап текущей БД, потом замена файла. */
  async restore(name: string, user: string): Promise<void> {
    const b = await this.find(name);
    const safety = await this.create('pre-restore');
    try {
      this.ctx.db.restoreFrom(b.file);
    } catch (err) {
      throw new HttpError(400, `Не удалось восстановить: ${(err as Error).message}`);
    }
    this.ctx.audit.write(user, 'restore', 'backup', name, { safetyBackup: safety?.name ?? null });
    this.ctx.log.warn({ name, user }, 'database restored from backup');
    for (const e of ['media', 'playlists', 'schedules', 'overrides', 'groups', 'screens'] as const) this.ctx.events.changed(e);
  }

  /** Перенос бэкапов с диска VM на SMB. */
  async moveLocalToPrimary(): Promise<void> {
    const dir = this.localDir;
    if (!dir || !this.ctx.storage.available) return;
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => NAME_RE.test(f));
    if (names.length === 0) return;
    const target = this.ctx.config.storage.backupPath;
    await fs.mkdir(target, { recursive: true });
    for (const n of names) {
      try {
        await fs.copyFile(path.join(dir, n), path.join(target, `${n}.part`));
        await fs.rename(path.join(target, `${n}.part`), path.join(target, n));
        await fs.rm(path.join(dir, n), { force: true });
      } catch (err) {
        this.ctx.log.warn({ err, name: n }, 'failed to move backup to primary storage');
        return;
      }
    }
    await this.rotate(target);
    this.ctx.log.info({ count: names.length }, 'local backups moved to primary storage');
  }

  /** Бэкап при старте и ежедневно в storage.backupTime (server.timezone). */
  start(): void {
    void this.create('startup').catch((err: unknown) => this.ctx.log.error({ err }, 'startup backup failed'));
    this.ctx.storage.onCheck((ok) => {
      if (ok) void this.moveLocalToPrimary();
    });
    this.timer = setInterval(() => {
      const now = Date.now();
      const p = zonedParts(now, this.ctx.config.server.timezone);
      const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
      const { day } = this.stamp(now);
      if (hm === this.ctx.config.storage.backupTime && this.lastDailyDay !== day) {
        this.lastDailyDay = day;
        void this.create().catch((err: unknown) => this.ctx.log.error({ err }, 'daily backup failed'));
      }
    }, 20_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
