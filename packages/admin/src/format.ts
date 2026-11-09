const TZ_FMT = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${tz}|${JSON.stringify(opts)}`;
  let f = TZ_FMT.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { ...opts, timeZone: tz });
    TZ_FMT.set(key, f);
  }
  return f;
}

let serverTz: string | undefined;
export function setServerTimezone(tz: string): void {
  serverTz = tz;
}

export function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return fmt(serverTz, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
}

export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return fmt(serverTz, { hour: '2-digit', minute: '2-digit' }).format(ms);
}

/** «сегодня в 18:00», «завтра в 09:00» или полная дата. */
export function formatWhen(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return '—';
  const day = (t: number) => fmt(serverTz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  if (day(ms) === day(now)) return `сегодня в ${formatTime(ms)}`;
  if (day(ms) === day(now + 86_400_000)) return `завтра в ${formatTime(ms)}`;
  return formatDateTime(ms);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'никогда';
  const d = Math.max(0, Math.round((now - ms) / 1000));
  if (d < 60) return `${d} с назад`;
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return formatDateTime(ms);
}
