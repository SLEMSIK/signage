import type { CacheStatus, PlayerPlaylist } from '@signage/shared';

/** URL, которые нужны плейлисту (медиа + файлы HTML-пакетов). */
export function playlistUrls(p: PlayerPlaylist | null): string[] {
  if (!p) return [];
  const out = new Set<string>();
  for (const i of p.items) {
    out.add(i.url);
    for (const a of i.assets ?? []) out.add(a);
  }
  return [...out];
}

/**
 * Офлайн-кэш через Service Worker. Работает только в secure context
 * (киоск запускается с --unsafely-treat-insecure-origin-as-secure).
 * Без SW плеер просто грузит всё по сети.
 */
export class MediaCache {
  enabled = false;
  private cached = new Set<string>();
  private want: string[] = [];

  async init(): Promise<void> {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      await navigator.serviceWorker.register('/player/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      this.enabled = true;
      navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { type?: string; urls?: string[] };
        if (d?.type === 'cache-keys' && Array.isArray(d.urls)) this.cached = new Set(d.urls);
      });
      this.post({ type: 'report' });
    } catch (err) {
      console.warn('Service Worker недоступен', err);
    }
  }

  private post(msg: unknown): void {
    const target = navigator.serviceWorker.controller;
    if (target) target.postMessage(msg);
    else void navigator.serviceWorker.ready.then((r) => r.active?.postMessage(msg));
  }

  /** Кэшировать текущий плейлист, держать прошлый, остальное удалить. */
  sync(current: PlayerPlaylist | null, previous: PlayerPlaylist | null): void {
    this.want = playlistUrls(current);
    if (!this.enabled) return;
    this.post({ type: 'sync', want: this.want, keep: playlistUrls(previous) });
  }

  status(): CacheStatus {
    return { sw: this.enabled, cached: this.want.filter((u) => this.cached.has(u)).length, total: this.want.length };
  }
}
