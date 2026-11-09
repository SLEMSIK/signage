import { constants as fsc } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

const MARKER = '.signage-storage';
/**
 * Метка «шара не смонтирована»: лежит в пустом каталоге точки монтирования на хосте.
 * Когда SMB смонтирован, она скрыта под ним; если видна — мы смотрим на диск VM.
 */
export const NOT_MOUNTED = '.NOT-MOUNTED';
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

/** Где лежит файл: основное хранилище (SMB) или резервный каталог на диске VM. */
export type MediaLocation = 'primary' | 'local';

function safeJoin(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Путь вне хранилища');
  return full;
}

/**
 * Медиа-хранилище (сетевой диск SMB). Если оно недоступно, сервер продолжает
 * работать: новые файлы сохраняются в резервный каталог на диске VM
 * (если он задан) и переносятся на SMB, когда тот снова доступен.
 * Плееры всё это время играют из своего кэша.
 *
 * Чтобы отличить «SMB не смонтирован, видим пустую локальную папку» от
 * «новое пустое хранилище», в корне лежит файл-маркер.
 */
export class MediaStorage {
  available = false;
  error: string | null = 'Проверка ещё не выполнялась';
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(available: boolean) => void>();
  private checkListeners = new Set<(available: boolean) => void>();

  constructor(
    readonly root: string,
    private readonly log: FastifyBaseLogger,
    /** Есть ли в БД медиафайлы на SMB — если есть, а маркера нет, хранилище считаем несмонтированным. */
    private readonly hasMediaRecords: () => boolean,
    /** Резервный каталог на диске VM; null — резерв выключен. */
    readonly localRoot: string | null = null,
    /** Минимум свободного места на диске VM, чтобы принимать туда загрузки. */
    private readonly localMinFreeBytes = 2 * 1024 ** 3,
  ) {}

  abs(rel: string): string {
    return safeJoin(this.root, rel);
  }

  rootOf(location: MediaLocation): string {
    if (location === 'primary') return this.root;
    if (!this.localRoot) throw new Error('Резервное хранилище не настроено');
    return this.localRoot;
  }

  absIn(location: MediaLocation, rel: string): string {
    return safeJoin(this.rootOf(location), rel);
  }

  /** Можно ли сейчас читать файлы из этого места. */
  canRead(location: MediaLocation): boolean {
    return location === 'primary' ? this.available : this.localRoot !== null;
  }

  /**
   * Откуда отдавать файл: SMB в приоритете; если он недоступен — копия на диске VM
   * (файл загружен туда или есть в зеркале). null — сейчас файл недоступен.
   */
  readLocation(row: { location: MediaLocation; mirrored: boolean }): MediaLocation | null {
    if (row.location === 'local') return this.localRoot ? 'local' : null;
    if (this.available) return 'primary';
    if (row.mirrored && this.localRoot) return 'local';
    return null;
  }

  /** Свободное место на диске VM (байт) или null, если резерв выключен/недоступен. */
  async localFreeBytes(): Promise<number | null> {
    if (!this.localRoot) return null;
    try {
      await fs.mkdir(this.localRoot, { recursive: true });
      const st = await fs.statfs(this.localRoot);
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  }

  /**
   * Куда сохранять новую загрузку: SMB, если он доступен, иначе диск VM.
   * Бросает ошибку с понятным текстом, если сохранить некуда.
   */
  async uploadTarget(): Promise<MediaLocation> {
    if (this.available) return 'primary';
    if (!this.localRoot) throw new Error('Хранилище недоступно — загрузка временно невозможна');
    const free = await this.localFreeBytes();
    if (free === null) throw new Error('Хранилище недоступно, резервный каталог на сервере тоже недоступен');
    if (free < this.localMinFreeBytes) {
      throw new Error(`Хранилище недоступно, а на диске сервера осталось меньше ${Math.round(this.localMinFreeBytes / 1024 ** 2)} МБ`);
    }
    return 'local';
  }

  /** Вызывается после каждой проверки (а не только при смене статуса) — для фонового переноса. */
  onCheck(fn: (available: boolean) => void): () => void {
    this.checkListeners.add(fn);
    return () => this.checkListeners.delete(fn);
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
    for (const fn of this.checkListeners) fn(ok);
    return ok;
  }

  private async probe(): Promise<void> {
    // Сначала метка: пустой каталог точки монтирования принадлежит root и не доступен
    // для записи — сообщение «не смонтирован» точнее, чем «нет прав».
    const notMounted = await fs.access(path.join(this.root, NOT_MOUNTED)).then(
      () => true,
      () => false,
    );
    if (notMounted) throw new Error('Сетевой диск не смонтирован (видна метка .NOT-MOUNTED точки монтирования)');
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
