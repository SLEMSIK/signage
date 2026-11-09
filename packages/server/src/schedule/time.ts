/**
 * Работа с «настенным» временем в заданном часовом поясе без внешних библиотек.
 * Используем Intl, поэтому таймзона контейнера ни на что не влияет.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 — понедельник … 6 — воскресенье. */
  weekday: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function zonedParts(instant: number, tz: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of dtf(tz).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  const year = out.year!;
  const month = out.month!;
  const day = out.day!;
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return { year, month, day, hour: out.hour! % 24, minute: out.minute!, second: out.second!, weekday };
}

/** Смещение пояса относительно UTC в момент instant, мс. */
function offsetAt(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Момент (epoch ms), соответствующий локальному времени year-month-day hh:mm в поясе tz.
 * day может выходить за пределы месяца — Date.UTC сам нормализует.
 * Для «несуществующего» времени (переход на летнее) возвращает ближайший валидный момент.
 */
export function zonedToInstant(year: number, month: number, day: number, minutes: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  const off1 = offsetAt(guess, tz);
  let t = guess - off1;
  const off2 = offsetAt(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

/** "HH:MM" → минуты от полуночи. */
export function parseHm(hm: string): number {
  const [h, m] = hm.split(':');
  return Number(h) * 60 + Number(m);
}
