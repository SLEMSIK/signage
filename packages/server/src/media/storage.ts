import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

const MARKER = '.signage-storage';
const CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: нет ответа ${ms / 1000} с`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Медиа-хранилище (сетевой диск SMB). Если оно недоступно, сервер продолжает
 * работать: загрузка блокируется, плееры играют из своего кэша.
 *
 * Чтобы отличить «SMB не смонтирован, видим пустую локальную папку» от
 * «новое пустое хранилище», в корне лежит файл-маркер.
 */
export class MediaStorage {
  available = false;
  error: string | null = 'Проверка ещё не выполнялась';
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(available: boolean) => void>();

  constructor(
    readonly root: string,
    private readonly log: FastifyBaseLogger,
    /** Есть ли в БД медиафайлы — если есть, а маркера нет, хранилище считаем чужим/несмонтированным. */
    private readonly hasMediaRecords: () => boolean,
  ) {}

  abs(rel: string): string {
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('Путь вне хранилища');
    return full;
  }

  onChange(fn: (available: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async check(): Promise<boolean> {
    let ok = false;
    let error: string | null = null;
    try {
      await withTimeout(this.probe(), CHECK_TIMEOUT_MS, 'Хранилище');
      ok = true;
    } catch (err) {
      error = (err as Error).message;
    }
    const changed = ok !== this.available || error !== this.error;
    this.available = ok;
    this.error = error;
    if (changed) {
      if (ok) this.log.info({ root: this.root }, 'media storage available');
      else this.log.warn({ root: this.root, error }, 'media storage unavailable');
      for (const fn of this.listeners) fn(ok);
    }
    return ok;
  }

  private async probe(): Promise<void> {
    await fs.access(this.root, fsc.R_OK | fsc.W_OK).catch(() => {
      throw new Error(`Каталог ${this.root} недоступен для записи`);
    });
    const marker = path.join(this.root, MARKER);
    try {
      await fs.access(marker, fsc.R_OK);
    } catch {
      if (this.hasMediaRecords()) {
        throw new Error('В хранилище нет файла-маркера, а в базе есть медиа. Сетевой диск не смонтирован?');
      }
      await fs.writeFile(marker, `signage storage, created ${new Date().toISOString()}\n`);
    }
    // Проверка записи: SMB может отдавать stat из кэша, а писать уже не давать.
    const probe = path.join(this.root, '.probe');
    await fs.writeFile(probe, String(Date.now()));
    await fs.rm(probe, { force: true });
  }

  start(intervalMs = 30_000): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
