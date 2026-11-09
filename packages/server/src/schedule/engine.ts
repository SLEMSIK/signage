/**
 * Движок расписания — чистые функции без доступа к БД и часам.
 *
 * Порядок приоритета:
 *   1. активный override на экран;
 *   2. активный override на группу экрана;
 *   3. расписание экрана (больший priority, затем позже начавшееся вхождение, затем больший id);
 *   4. расписание группы (те же правила);
 *   5. иначе null — чёрный экран.
 *
 * Семантика интервала: days — дни, в которые интервал НАЧИНАЕТСЯ.
 * start < end — обычный интервал в пределах дня [start, end).
 * start > end — переход через полночь: с start дня d до end дня d+1.
 * start == end — круглые сутки, начиная со start.
 */
import type { ResolveSource } from '@signage/shared';
import { parseHm, zonedParts, zonedToInstant } from './time.js';

export interface ScheduleRule {
  id: number;
  targetType: 'screen' | 'group';
  targetId: number;
  playlistId: number | null;
  days: number;
  startTime: string;
  endTime: string;
  priority: number;
  enabled: boolean;
}

export interface OverrideRule {
  id: number;
  targetType: 'screen' | 'group';
  targetId: number;
  playlistId: number | null;
  /** epoch ms или null — до отмены. */
  until: number | null;
  createdAt: number;
}

export interface ScreenRef {
  id: number;
  groupId: number | null;
}

export interface ResolveData {
  schedules: readonly ScheduleRule[];
  overrides: readonly OverrideRule[];
}

export interface ResolveResult {
  playlistId: number | null;
  source: ResolveSource;
  /** id правила (override или schedule), которое дало результат. */
  ruleId: number | null;
  /** Момент начала текущего назначения — эпоха для синхронного показа. */
  since: number | null;
  /** Ближайший момент, когда результат изменится; null — сам по себе не изменится. */
  validUntil: number | null;
}

export interface Occurrence {
  rule: ScheduleRule;
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;
/** Сколько дней вперёд смотреть. Неделя + запас: дальше всё повторяется. */
const HORIZON_DAYS = 9;

/** Вхождения правила, начинающиеся в локальные дни от (день now − 2) до (день now + HORIZON_DAYS). */
export function occurrences(rule: ScheduleRule, now: number, tz: string): Occurrence[] {
  const today = zonedParts(now, tz);
  const s = parseHm(rule.startTime);
  const e = parseHm(rule.endTime);
  const out: Occurrence[] = [];
  for (let k = -2; k <= HORIZON_DAYS; k++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + k));
    const weekday = (d.getUTCDay() + 6) % 7;
    if ((rule.days & (1 << weekday)) === 0) continue;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const start = zonedToInstant(y, m, day, s, tz);
    const end = e > s ? zonedToInstant(y, m, day, e, tz) : zonedToInstant(y, m, day + 1, e, tz);
    if (end > start) out.push({ rule, start, end });
  }
  return out;
}

function activeOverride(overrides: readonly OverrideRule[], type: 'screen' | 'group', id: number, t: number): OverrideRule | null {
  let best: OverrideRule | null = null;
  for (const o of overrides) {
    if (o.targetType !== type || o.targetId !== id) continue;
    if (o.createdAt > t) continue;
    if (o.until !== null && o.until <= t) continue;
    if (!best || o.createdAt > best.createdAt || (o.createdAt === best.createdAt && o.id > best.id)) best = o;
  }
  return best;
}

function bestOccurrence(occ: readonly Occurrence[], t: number): Occurrence | null {
  let best: Occurrence | null = null;
  for (const o of occ) {
    if (o.start > t || o.end <= t) continue;
    if (
      !best ||
      o.rule.priority > best.rule.priority ||
      (o.rule.priority === best.rule.priority &&
        (o.start > best.start || (o.start === best.start && o.rule.id > best.rule.id)))
    ) {
      best = o;
    }
  }
  return best;
}

type Snapshot = Omit<ResolveResult, 'validUntil'>;

interface Prepared {
  screen: ScreenRef;
  overrides: readonly OverrideRule[];
  screenOcc: Occurrence[];
  groupOcc: Occurrence[];
}

function prepare(screen: ScreenRef, now: number, data: ResolveData, tz: string): Prepared {
  const screenOcc: Occurrence[] = [];
  const groupOcc: Occurrence[] = [];
  for (const r of data.schedules) {
    if (!r.enabled || r.days === 0) continue;
    if (r.targetType === 'screen' && r.targetId === screen.id) screenOcc.push(...occurrences(r, now, tz));
    else if (r.targetType === 'group' && screen.groupId !== null && r.targetId === screen.groupId) {
      groupOcc.push(...occurrences(r, now, tz));
    }
  }
  const overrides = data.overrides.filter(
    (o) =>
      (o.targetType === 'screen' && o.targetId === screen.id) ||
      (o.targetType === 'group' && screen.groupId !== null && o.targetId === screen.groupId),
  );
  return { screen, overrides, screenOcc, groupOcc };
}

function snapshotAt(p: Prepared, t: number): Snapshot {
  const so = activeOverride(p.overrides, 'screen', p.screen.id, t);
  if (so) return { playlistId: so.playlistId, source: 'override-screen', ruleId: so.id, since: so.createdAt };
  if (p.screen.groupId !== null) {
    const go = activeOverride(p.overrides, 'group', p.screen.groupId, t);
    if (go) return { playlistId: go.playlistId, source: 'override-group', ruleId: go.id, since: go.createdAt };
  }
  const ss = bestOccurrence(p.screenOcc, t);
  if (ss) return { playlistId: ss.rule.playlistId, source: 'schedule-screen', ruleId: ss.rule.id, since: ss.start };
  const gs = bestOccurrence(p.groupOcc, t);
  if (gs) return { playlistId: gs.rule.playlistId, source: 'schedule-group', ruleId: gs.rule.id, since: gs.start };
  return { playlistId: null, source: 'none', ruleId: null, since: null };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.playlistId === b.playlistId && a.source === b.source && a.ruleId === b.ruleId && a.since === b.since;
}

/** Решает, что должен показывать экран в момент now. */
export function resolve(screen: ScreenRef, now: number, data: ResolveData, tz: string): ResolveResult {
  const p = prepare(screen, now, data, tz);
  const current = snapshotAt(p, now);

  // Все моменты, в которые результат потенциально может поменяться.
  const bounds = new Set<number>();
  const limit = now + (HORIZON_DAYS - 1) * DAY_MS;
  for (const o of [...p.screenOcc, ...p.groupOcc]) {
    if (o.start > now && o.start <= limit) bounds.add(o.start);
    if (o.end > now && o.end <= limit) bounds.add(o.end);
  }
  for (const o of p.overrides) {
    if (o.until !== null && o.until > now) bounds.add(o.until);
    if (o.createdAt > now) bounds.add(o.createdAt);
  }

  const sorted = [...bounds].sort((a, b) => a - b);
  for (const b of sorted) {
    if (!sameSnapshot(current, snapshotAt(p, b))) return { ...current, validUntil: b };
  }
  return { ...current, validUntil: null };
}

/**
 * Момент следующей смены по расписанию (без учёта override) — для ручного
 * переключения «до следующей смены». Для группы берётся ближайшая смена среди
 * расписания группы и расписаний её экранов.
 */
export function nextScheduleChange(
  target: { type: 'screen' | 'group'; id: number },
  screens: readonly ScreenRef[],
  schedules: readonly ScheduleRule[],
  now: number,
  tz: string,
): number | null {
  const data: ResolveData = { schedules, overrides: [] };
  const refs: ScreenRef[] =
    target.type === 'screen'
      ? screens.filter((s) => s.id === target.id)
      : [{ id: -1, groupId: target.id }, ...screens.filter((s) => s.groupId === target.id)];
  let best: number | null = null;
  for (const ref of refs) {
    const r = resolve(ref, now, data, tz);
    if (r.validUntil !== null && (best === null || r.validUntil < best)) best = r.validUntil;
  }
  return best;
}
