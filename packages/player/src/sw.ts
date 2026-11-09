/**
 * Service Worker плеера. Регистрируется из /player/ со scope «/»
 * (сервер отдаёт Service-Worker-Allowed: /), чтобы перехватывать /media и /content.
 *
 * - оболочка плеера: network-first (index) и cache-first (хэшированные ассеты);
 * - медиа: cache-first; что кэшировать и что удалять, говорит страница сообщением `sync`;
 * - Range-запросы видео обслуживаются из кэша (206 Partial Content).
 */

// Минимальные типы SW: в tsconfig подключён только DOM lib.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  data: unknown;
  source: { postMessage(msg: unknown): void } | null;
}
interface SwScope {
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', fn: (e: ExtendableMessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(): Promise<{ postMessage(m: unknown): void }[]> };
  location: Location;
}

const sw = self as unknown as SwScope;
const SHELL = 'signage-shell-v2';
const MEDIA = 'signage-media-v1';

sw.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add('/player/').catch(() => undefined))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('signage-') && k !== SHELL && k !== MEDIA).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

function isMedia(url: URL): boolean {
  return url.pathname.startsWith('/media/') || url.pathname.startsWith('/content/');
}

/** Ответ 206 из полного закэшированного ответа. */
async function rangeResponse(full: Response, range: string): Promise<Response> {
  const blob = await full.blob();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const size = blob.size;
  let start = m?.[1] ? Number(m[1]) : 0;
  let end = m?.[2] ? Number(m[2]) : size - 1;
  if (!m?.[1] && m?.[2]) {
    // bytes=-500 — последние 500 байт
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') ?? 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function fromMediaCache(req: Request): Promise<Response> {
  const cache = await caches.open(MEDIA);
  const range = req.headers.get('range');
  const hit = await cache.match(req.url);
  if (hit) return range ? rangeResponse(hit, range) : hit;
  // Нет в кэше — в сеть. Кэшируем только по команде страницы (sync), чтобы не раздувать кэш.
  return fetch(req);
}

async function shellNetworkFirst(req: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(req, { signal: controller.signal });
    clearTimeout(t);
    if (res.ok) await cache.put('/player/', res.clone());
    return res;
  } catch {
    const hit = await cache.match('/player/');
    if (hit) return hit;
    throw new Error('offline and no cached shell');
  }
}

async function shellCacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // HTML вместо ассета — признак ошибки маршрутизации; такое не кэшируем.
  if (res.ok && !(res.headers.get('Content-Type') ?? '').includes('text/html')) await cache.put(req, res.clone());
  return res;
}

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  if (isMedia(url)) {
    e.respondWith(fromMediaCache(req));
  } else if (url.pathname === '/player/' || url.pathname === '/player' || url.pathname === '/player/index.html') {
    e.respondWith(shellNetworkFirst(req));
  } else if (url.pathname.startsWith('/player/assets/')) {
    e.respondWith(shellCacheFirst(req));
  }
  // остальное (/api, /admin, /ws, /thumbs) — без вмешательства
});

// ---------------------------------------------------------------------------
// Синхронизация кэша по команде страницы
// ---------------------------------------------------------------------------

let syncing: Promise<void> = Promise.resolve();

async function report(): Promise<void> {
  const cache = await caches.open(MEDIA);
  const keys = await cache.keys();
  for (const c of await sw.clients.matchAll()) c.postMessage({ type: 'cache-keys', urls: keys.map((k) => new URL(k.url).pathname + new URL(k.url).search) });
}

async function doSync(want: string[], keep: string[]): Promise<void> {
  const cache = await caches.open(MEDIA);
  const keepSet = new Set([...want, ...keep].map((u) => new URL(u, sw.location.origin).href));
  // Удаляем то, что не нужно ни текущему, ни прошлому плейлисту.
  for (const req of await cache.keys()) if (!keepSet.has(req.url)) await cache.delete(req);
  // Докачиваем недостающее по одному, чтобы не мешать показу.
  for (const u of want) {
    const href = new URL(u, sw.location.origin).href;
    if (await cache.match(href)) continue;
    try {
      const res = await fetch(href, { cache: 'no-store' });
      if (res.ok && res.status === 200) await cache.put(href, res);
    } catch {
      /* сервер недоступен — попробуем при следующем sync */
    }
    await report();
  }
  await report();
}

sw.addEventListener('message', (e) => {
  const data = e.data as { type?: string; want?: string[]; keep?: string[] } | null;
  if (data?.type === 'sync' && Array.isArray(data.want)) {
    const want = data.want;
    const keep = data.keep ?? [];
    syncing = syncing.then(() => doSync(want, keep)).catch(() => undefined);
    e.waitUntil(syncing);
  } else if (data?.type === 'report') {
    e.waitUntil(report());
  }
});
