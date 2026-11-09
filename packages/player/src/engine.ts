import type { PlayerItem, PlayerPlaylist } from '@signage/shared';
// Напрямую из модуля, а не из индекса: индекс тянет zod (~90 КБ), плееру он не нужен.
import { syncPosition } from '../../shared/src/sync';

const LOAD_TIMEOUT_MS = 15_000;
const VIDEO_START_TIMEOUT_MS = 5_000;
const FADE_MS = 800;
/** Если до конца элемента в синхронном режиме меньше — не показываем его, ждём следующий. */
const SYNC_MIN_REMAINING_MS = 400;

interface Slot {
  el: HTMLDivElement;
  item: PlayerItem | null;
  media: HTMLImageElement | HTMLVideoElement | HTMLIFrameElement | null;
}

export interface EngineHooks {
  error(message: string, mediaId?: number): void;
  serverNow(): number;
  /** Сменился показываемый элемент (null — чёрный экран). */
  onItem(item: PlayerItem | null, playlistId: number | null): void;
  /** Граница между элементами. Вернуть true, чтобы остановить показ (например, перед перезагрузкой). */
  onBoundary(): boolean;
}

export interface PlayRequest {
  playlist: PlayerPlaylist | null;
  syncEpoch?: number;
  version: string;
}

/**
 * Движок показа: два слоя (двойная буферизация). Следующий элемент
 * загружается в скрытый слой заранее, переход — мгновенный или fade.
 * Пока следующий не готов, текущий остаётся на экране — чёрных пауз нет.
 */
export class Engine {
  private slots: [Slot, Slot];
  private front = 0;
  private gen = 0;
  private wakers = new Set<() => void>();
  version: string | null = null;
  playlistId: number | null = null;
  currentItemId: number | null = null;

  constructor(
    stage: HTMLElement,
    private readonly hooks: EngineHooks,
  ) {
    const mk = (): Slot => {
      const el = document.createElement('div');
      el.className = 'slot';
      stage.appendChild(el);
      return { el, item: null, media: null };
    };
    this.slots = [mk(), mk()];
  }

  /** Новый state. Одинаковая версия — ничего не делаем. */
  play(req: PlayRequest): void {
    if (req.version === this.version) return;
    this.version = req.version;
    const gen = ++this.gen;
    this.wakeAll();
    if (!req.playlist || req.playlist.items.length === 0) {
      this.black();
      return;
    }
    this.playlistId = req.playlist.id;
    const run = req.syncEpoch !== undefined ? this.runSync(gen, req.playlist, req.syncEpoch) : this.runLoop(gen, req.playlist);
    run.catch((err: unknown) => this.hooks.error(`engine: ${(err as Error).message}`));
  }

  stop(): void {
    this.gen++;
    this.version = null;
    this.wakeAll();
    this.black();
  }

  private black(): void {
    for (const s of this.slots) this.clear(s);
    this.playlistId = null;
    this.currentItemId = null;
    this.hooks.onItem(null, null);
  }

  // ---------------------------------------------------------------------------
  // Ожидания, которые прерываются сменой state
  // ---------------------------------------------------------------------------

  private wakeAll(): void {
    for (const w of this.wakers) w();
    this.wakers.clear();
  }

  /** Ждёт ms или смены поколения (нового state). */
  private wait(gen: number, ms: number, extra?: (done: () => void) => () => void): Promise<void> {
    return new Promise((resolve) => {
      if (gen !== this.gen) return resolve();
      const cleanup: { fn?: () => void } = {};
      const done = () => {
        window.clearTimeout(t);
        this.wakers.delete(done);
        cleanup.fn?.();
        resolve();
      };
      const t = window.setTimeout(done, Math.max(0, ms));
      this.wakers.add(done);
      cleanup.fn = extra?.(done);
    });
  }

  private untilChanged(gen: number): Promise<void> {
    return this.wait(gen, 2 ** 31 - 1);
  }

  // ---------------------------------------------------------------------------
  // Слои
  // ---------------------------------------------------------------------------

  private get back(): Slot {
    return this.slots[1 - this.front]!;
  }

  private clear(slot: Slot): void {
    const m = slot.media;
    slot.media = null;
    slot.item = null;
    slot.el.style.transition = 'none';
    slot.el.style.opacity = '0';
    if (!m) return;
    if (m instanceof HTMLVideoElement) {
      m.pause();
      m.removeAttribute('src');
      m.load(); // освобождает декодер
    } else if (m instanceof HTMLIFrameElement) {
      m.src = 'about:blank';
    }
    m.remove();
  }

  /** Загружает элемент в слой. true — готов к показу. */
  private prepare(slot: Slot, item: PlayerItem, loop: boolean): Promise<boolean> {
    this.clear(slot);
    slot.item = item;
    const objectFit = item.fit === 'stretch' ? 'fill' : item.fit;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!ok) this.hooks.error(reason ?? 'не удалось загрузить', item.mediaId);
        resolve(ok);
      };
      const timer = window.setTimeout(() => {
        // HTML может грузиться долго (внешние данные) — показываем как есть.
        if (item.type === 'html' || item.type === 'html_zip') finish(true);
        else finish(false, `таймаут загрузки ${item.url}`);
      }, LOAD_TIMEOUT_MS);

      if (item.type === 'image') {
        const img = document.createElement('img');
        img.className = 'media';
        img.style.objectFit = objectFit;
        img.decoding = 'async';
        img.src = item.url;
        slot.media = img;
        slot.el.appendChild(img);
        img
          .decode()
          .then(() => finish(true))
          .catch(() => finish(false, `ошибка изображения ${item.url}`));
      } else if (item.type === 'video') {
        const v = document.createElement('video');
        v.className = 'media';
        v.style.objectFit = objectFit;
        v.muted = true;
        v.defaultMuted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.loop = loop;
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.addEventListener('loadeddata', () => finish(true), { once: true });
        v.addEventListener('error', () => finish(false, `ошибка видео ${item.url}: ${v.error?.message ?? v.error?.code ?? ''}`), { once: true });
        v.src = item.url;
        slot.media = v;
        slot.el.appendChild(v);
      } else {
        const f = document.createElement('iframe');
        f.className = 'media';
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        f.setAttribute('scrolling', 'no');
        f.addEventListener('load', () => finish(true), { once: true });
        f.src = item.url;
        slot.media = f;
        slot.el.appendChild(f);
      }
    });
  }

  /** Делает слой видимым. Для видео — запускает и ждёт фактического старта (до 5 с). */
  private async show(slot: Slot, offsetMs = 0): Promise<boolean> {
    const item = slot.item!;
    const media = slot.media;
    if (media instanceof HTMLVideoElement) {
      if (offsetMs > 0 && Number.isFinite(media.duration) && media.duration > 0) {
        media.currentTime = (offsetMs / 1000) % media.duration;
      }
      const started = await new Promise<boolean>((resolve) => {
        const t = window.setTimeout(() => resolve(false), VIDEO_START_TIMEOUT_MS);
        media.addEventListener(
          'playing',
          () => {
            window.clearTimeout(t);
            resolve(true);
          },
          { once: true },
        );
        media.play().catch(() => {
          window.clearTimeout(t);
          resolve(false);
        });
      });
      if (!started) {
        this.hooks.error(`видео не стартовало за 5 с: ${item.url}`, item.mediaId);
        this.clear(slot);
        return false;
      }
    }

    const old = this.slots[this.front]!;
    const idx = this.slots.indexOf(slot);
    slot.el.style.zIndex = '2';
    old.el.style.zIndex = '1';
    this.front = idx;
    if (item.transition === 'fade' && old.media) {
      slot.el.style.transition = 'none';
      slot.el.style.opacity = '0';
      void slot.el.offsetWidth; // reflow, чтобы transition сработал
      slot.el.style.transition = `opacity ${FADE_MS}ms ease`;
      slot.el.style.opacity = '1';
      this.currentItemId = item.itemId;
      this.hooks.onItem(item, this.playlistId);
      // Старый слой освобождаем только после окончания перехода. Следующий элемент
      // начнёт грузиться в этот слой лишь после возврата из show() — гонки нет.
      await new Promise((r) => window.setTimeout(r, FADE_MS + 50));
    } else {
      slot.el.style.transition = 'none';
      slot.el.style.opacity = '1';
      this.currentItemId = item.itemId;
      this.hooks.onItem(item, this.playlistId);
      // Ждём, пока новый кадр будет отрисован, и только потом убираем старый.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    if (old !== slot && this.slots[this.front] === slot) this.clear(old);
    return true;
  }

  /** Ждёт окончания показа элемента: по таймеру или по ended у видео без явной длительности. */
  private waitItemEnd(gen: number, slot: Slot, elapsedMs = 0): Promise<void> {
    const item = slot.item!;
    const ms = item.durationSec * 1000 - elapsedMs;
    const media = slot.media;
    if (item.untilEnd && media instanceof HTMLVideoElement && !media.loop) {
      // Длительность — длина ролика; ended приходит точнее. Таймер — страховка (+3 с).
      return this.wait(gen, ms + 3000, (done) => {
        media.addEventListener('ended', done, { once: true });
        return () => media.removeEventListener('ended', done);
      });
    }
    return this.wait(gen, ms);
  }

  // ---------------------------------------------------------------------------
  // Независимый показ: плейлист с начала по кругу
  // ---------------------------------------------------------------------------

  private async runLoop(gen: number, playlist: PlayerPlaylist): Promise<void> {
    const items = playlist.items;
    const n = items.length;
    const single = n === 1;
    let idx = 0;
    let failures = 0;
    let prepared = this.prepare(this.back, items[0]!, single || !items[0]!.untilEnd);

    while (gen === this.gen) {
      const ok = await prepared;
      if (gen !== this.gen) return;
      const slot = this.back;
      const shownAt = performance.now();
      const started = ok && (await this.show(slot));
      if (gen !== this.gen) return;

      if (!started) {
        failures++;
        if (failures >= n) {
          // Ничего не загружается: не крутим цикл вхолостую.
          if (!this.slots[this.front]!.media) this.hooks.onItem(null, this.playlistId);
          await this.wait(gen, 10_000);
          failures = 0;
        }
        idx = (idx + 1) % n;
        prepared = this.prepare(this.back, items[idx]!, single || !items[idx]!.untilEnd);
        continue;
      }
      failures = 0;

      if (single) {
        await this.untilChanged(gen);
        return;
      }

      const nextIdx = (idx + 1) % n;
      prepared = this.prepare(this.back, items[nextIdx]!, !items[nextIdx]!.untilEnd);
      await this.waitItemEnd(gen, slot, performance.now() - shownAt);
      if (gen !== this.gen) return;
      if (this.hooks.onBoundary()) return;
      idx = nextIdx;
    }
  }

  // ---------------------------------------------------------------------------
  // Синхронный показ: позиция = (serverNow - epoch) mod total
  // ---------------------------------------------------------------------------

  private async runSync(gen: number, playlist: PlayerPlaylist, epoch: number): Promise<void> {
    const items = playlist.items;
    const durations = items.map((i) => i.durationSec);
    const single = items.length === 1;
    let pending: { idx: number; ready: Promise<boolean> } | null = null;

    while (gen === this.gen) {
      let pos = syncPosition(durations, epoch, this.hooks.serverNow())!;
      if (!single && pos.remainingMs < SYNC_MIN_REMAINING_MS) {
        await this.wait(gen, pos.remainingMs);
        continue;
      }
      const item = items[pos.index]!;
      if (!pending || pending.idx !== pos.index) {
        pending = { idx: pos.index, ready: this.prepare(this.back, item, true) };
      }
      const ok = await pending.ready;
      pending = null;
      if (gen !== this.gen) return;
      // Загрузка заняла время — пересчитываем смещение внутри элемента.
      pos = syncPosition(durations, epoch, this.hooks.serverNow())!;
      if (!single && pos.index !== items.indexOf(item)) continue; // пока грузили, наступил следующий элемент
      const slot = this.back;
      const started = ok && slot.item?.itemId === item.itemId && (await this.show(slot, pos.offsetMs));
      if (gen !== this.gen) return;

      if (single) {
        if (started) await this.untilChanged(gen);
        else await this.wait(gen, 10_000);
        if (!started) continue;
        return;
      }

      // Готовим следующий элемент и ждём границы по часам сервера.
      const now = syncPosition(durations, epoch, this.hooks.serverNow())!;
      const nextIdx = (now.index + 1) % items.length;
      pending = { idx: nextIdx, ready: this.prepare(this.back, items[nextIdx]!, true) };
      await this.wait(gen, now.remainingMs);
      if (gen !== this.gen) return;
      if (this.hooks.onBoundary()) return;
      if (!started) continue;
    }
  }
}
