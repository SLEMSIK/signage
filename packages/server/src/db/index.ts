import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Orm = BetterSQLite3Database<typeof schema>;

/** Каталог SQL-миграций (packages/server/drizzle) — одинаково из src и из dist. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Обёртка над соединением SQLite. Сервисы всегда берут `db.orm` в момент
 * вызова, поэтому после восстановления из бэкапа (reopen) всё продолжает работать.
 */
export class Database {
  private sqlite!: BetterSqlite3.Database;
  private _orm!: Orm;

  constructor(readonly file: string) {
    this.open();
  }

  get orm(): Orm {
    return this._orm;
  }

  get raw(): BetterSqlite3.Database {
    return this.sqlite;
  }

  private open(): void {
    if (this.file !== ':memory:') mkdirSync(path.dirname(this.file), { recursive: true });
    this.sqlite = new BetterSqlite3(this.file);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this._orm = drizzle(this.sqlite, { schema });
    migrate(this._orm, { migrationsFolder: MIGRATIONS_DIR });
  }

  isHealthy(): boolean {
    try {
      return this.sqlite.prepare('SELECT 1 AS ok').get() !== undefined;
    } catch {
      return false;
    }
  }

  /** Консистентная копия БД в файл (VACUUM INTO). Файл назначения не должен существовать. */
  vacuumInto(target: string): void {
    if (existsSync(target)) rmSync(target);
    this.sqlite.prepare('VACUUM INTO ?').run(target);
  }

  /** Заменяет файл БД копией из бэкапа и открывает заново. */
  restoreFrom(source: string): void {
    // Проверяем, что это вообще SQLite-база, до того как закрывать текущую.
    const probe = new BetterSqlite3(source, { readonly: true, fileMustExist: true });
    try {
      const res = probe.pragma('integrity_check', { simple: true });
      if (res !== 'ok') throw new Error(`Бэкап повреждён: ${String(res)}`);
    } finally {
      probe.close();
    }
    this.sqlite.close();
    for (const suffix of ['-wal', '-shm']) rmSync(this.file + suffix, { force: true });
    copyFileSync(source, this.file);
    this.open();
  }

  close(): void {
    this.sqlite.close();
  }
}
