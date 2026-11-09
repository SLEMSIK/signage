import { describe, expect, it } from 'vitest';
import { nextScheduleChange, resolve, type OverrideRule, type ScheduleRule } from './engine.js';
import { zonedParts, zonedToInstant } from './time.js';

const TZ = 'Europe/Moscow';
// 2026-11-09 — понедельник. Москва — UTC+3 без перехода на летнее время.
const msk = (d: number, h: number, mi = 0) => Date.UTC(2026, 10, d, h - 3, mi);

const MON = 1;
const TUE = 2;
const SUN = 64;
const ALL = 127;
const WEEKDAYS = 31;

let nextId = 1;
function rule(p: Partial<ScheduleRule> & Pick<ScheduleRule, 'startTime' | 'endTime'>): ScheduleRule {
  return {
    id: nextId++,
    targetType: 'screen',
    targetId: 1,
    playlistId: 100,
    days: ALL,
    priority: 0,
    enabled: true,
    ...p,
  };
}
function override(p: Partial<OverrideRule> & Pick<OverrideRule, 'createdAt'>): OverrideRule {
  return { id: nextId++, targetType: 'screen', targetId: 1, playlistId: 500, until: null, ...p };
}

const screen = { id: 1, groupId: 10 };

describe('time helpers', () => {
  it('converts zoned wall time to instant and back', () => {
    const t = zonedToInstant(2026, 11, 9, 9 * 60 + 30, TZ);
    expect(t).toBe(msk(9, 9, 30));
    const p = zonedParts(t, TZ);
    expect(p).toMatchObject({ year: 2026, month: 11, day: 9, hour: 9, minute: 30, weekday: 0 });
  });

  it('ignores the process timezone', () => {
    // 23:30 UTC в воскресенье — это уже понедельник 02:30 в Москве.
    const p = zonedParts(Date.UTC(2026, 10, 8, 23, 30), TZ);
    expect(p.weekday).toBe(0);
    expect(p.hour).toBe(2);
  });
});

describe('resolve: базовые случаи', () => {
  it('nothing scheduled → black screen forever', () => {
    const r = resolve(screen, msk(9, 12), { schedules: [], overrides: [] }, TZ);
    expect(r).toEqual({ playlistId: null, source: 'none', ruleId: null, since: null, validUntil: null });
  });

  it('inside a simple interval', () => {
    const s = rule({ startTime: '09:00', endTime: '18:00', days: WEEKDAYS });
    const r = resolve(screen, msk(9, 12), { schedules: [s], overrides: [] }, TZ);
    expect(r.playlistId).toBe(100);
    expect(r.source).toBe('schedule-screen');
    expect(r.since).toBe(msk(9, 9));
    expect(r.validUntil).toBe(msk(9, 18));
  });

  it('end is exclusive, start inclusive', () => {
    const s = rule({ startTime: '09:00', endTime: '18:00' });
    expect(resolve(screen, msk(9, 18), { schedules: [s], overrides: [] }, TZ).playlistId).toBeNull();
    expect(resolve(screen, msk(9, 9), { schedules: [s], overrides: [] }, TZ).playlistId).toBe(100);
  });

  it('before interval: black until it starts', () => {
    const s = rule({ startTime: '09:00', endTime: '18:00' });
    const r = resolve(screen, msk(9, 7), { schedules: [s], overrides: [] }, TZ);
    expect(r.playlistId).toBeNull();
    expect(r.validUntil).toBe(msk(9, 9));
  });

  it('disabled rules are ignored', () => {
    const s = rule({ startTime: '09:00', endTime: '18:00', enabled: false });
    expect(resolve(screen, msk(9, 12), { schedules: [s], overrides: [] }, TZ).playlistId).toBeNull();
  });

  it('start == end means a full day', () => {
    const s = rule({ startTime: '00:00', endTime: '00:00', days: MON });
    const r = resolve(screen, msk(9, 23, 59), { schedules: [s], overrides: [] }, TZ);
    expect(r.playlistId).toBe(100);
    expect(r.validUntil).toBe(msk(10, 0));
  });
});

describe('resolve: дни недели и полночь', () => {
  it('respects days mask', () => {
    const s = rule({ startTime: '09:00', endTime: '18:00', days: TUE });
    const mon = resolve(screen, msk(9, 12), { schedules: [s], overrides: [] }, TZ);
    expect(mon.playlistId).toBeNull();
    expect(mon.validUntil).toBe(msk(10, 9));
    expect(resolve(screen, msk(10, 12), { schedules: [s], overrides: [] }, TZ).playlistId).toBe(100);
  });

  it('crossing midnight 22:00–02:00 belongs to the start day', () => {
    const s = rule({ startTime: '22:00', endTime: '02:00', days: MON });
    const data = { schedules: [s], overrides: [] };
    expect(resolve(screen, msk(9, 21, 59), data, TZ).playlistId).toBeNull();
    const late = resolve(screen, msk(9, 23), data, TZ);
    expect(late.playlistId).toBe(100);
    expect(late.validUntil).toBe(msk(10, 2));
    // Вторник 01:00 — всё ещё понедельничный интервал.
    const tue = resolve(screen, msk(10, 1), data, TZ);
    expect(tue.playlistId).toBe(100);
    expect(tue.since).toBe(msk(9, 22));
    // Вторник 22:30 — во вторник интервал не начинается.
    expect(resolve(screen, msk(10, 22, 30), data, TZ).playlistId).toBeNull();
  });

  it('Sunday night interval continues into Monday (week wrap)', () => {
    const s = rule({ startTime: '23:00', endTime: '01:00', days: SUN });
    // Понедельник 9 ноября, 00:30 — продолжение воскресенья 8 ноября.
    const r = resolve(screen, msk(9, 0, 30), { schedules: [s], overrides: [] }, TZ);
    expect(r.playlistId).toBe(100);
    expect(r.since).toBe(msk(8, 23));
    expect(r.validUntil).toBe(msk(9, 1));
  });

  it('next change can be several days ahead', () => {
    const s = rule({ startTime: '10:00', endTime: '11:00', days: SUN });
    const r = resolve(screen, msk(9, 12), { schedules: [s], overrides: [] }, TZ);
    expect(r.validUntil).toBe(msk(15, 10));
  });

  it('back-to-back intervals with the same playlist still restart at the boundary', () => {
    const a = rule({ startTime: '08:00', endTime: '12:00' });
    const b = rule({ startTime: '12:00', endTime: '16:00' });
    const r = resolve(screen, msk(9, 10), { schedules: [a, b], overrides: [] }, TZ);
    expect(r.validUntil).toBe(msk(9, 12));
    const r2 = resolve(screen, msk(9, 12), { schedules: [a, b], overrides: [] }, TZ);
    expect(r2.ruleId).toBe(b.id);
  });
});

describe('resolve: пересечения и приоритеты', () => {
  it('higher priority wins', () => {
    const low = rule({ startTime: '08:00', endTime: '20:00', playlistId: 1, priority: 0 });
    const high = rule({ startTime: '12:00', endTime: '13:00', playlistId: 2, priority: 5 });
    const data = { schedules: [low, high], overrides: [] };
    expect(resolve(screen, msk(9, 12, 30), data, TZ).playlistId).toBe(2);
    const before = resolve(screen, msk(9, 11), data, TZ);
    expect(before.playlistId).toBe(1);
    expect(before.validUntil).toBe(msk(9, 12));
    const lunch = resolve(screen, msk(9, 12, 10), data, TZ);
    expect(lunch.validUntil).toBe(msk(9, 13));
  });

  it('lower priority starting later does not interrupt', () => {
    const high = rule({ startTime: '08:00', endTime: '20:00', playlistId: 1, priority: 5 });
    const low = rule({ startTime: '12:00', endTime: '13:00', playlistId: 2, priority: 0 });
    const r = resolve(screen, msk(9, 10), { schedules: [high, low], overrides: [] }, TZ);
    expect(r.playlistId).toBe(1);
    expect(r.validUntil).toBe(msk(9, 20));
  });

  it('equal priority → the later-started occurrence wins', () => {
    const a = rule({ startTime: '08:00', endTime: '20:00', playlistId: 1 });
    const b = rule({ startTime: '12:00', endTime: '14:00', playlistId: 2 });
    expect(resolve(screen, msk(9, 13), { schedules: [a, b], overrides: [] }, TZ).playlistId).toBe(2);
    expect(resolve(screen, msk(9, 15), { schedules: [a, b], overrides: [] }, TZ).playlistId).toBe(1);
  });

  it('explicit black screen schedule (playlistId null) overrides lower priority', () => {
    const day = rule({ startTime: '00:00', endTime: '00:00', playlistId: 1 });
    const black = rule({ startTime: '13:00', endTime: '14:00', playlistId: null, priority: 1 });
    const r = resolve(screen, msk(9, 13, 30), { schedules: [day, black], overrides: [] }, TZ);
    expect(r.playlistId).toBeNull();
    expect(r.source).toBe('schedule-screen');
  });
});

describe('resolve: группа против экрана', () => {
  const groupRule = (p: Partial<ScheduleRule> & Pick<ScheduleRule, 'startTime' | 'endTime'>) =>
    rule({ targetType: 'group', targetId: 10, playlistId: 200, ...p });

  it('group schedule applies when screen has none', () => {
    const g = groupRule({ startTime: '09:00', endTime: '18:00' });
    const r = resolve(screen, msk(9, 12), { schedules: [g], overrides: [] }, TZ);
    expect(r).toMatchObject({ playlistId: 200, source: 'schedule-group' });
  });

  it('screen schedule beats group schedule regardless of priority', () => {
    const g = groupRule({ startTime: '09:00', endTime: '18:00', priority: 100 });
    const s = rule({ startTime: '11:00', endTime: '12:00', priority: 0 });
    const data = { schedules: [g, s], overrides: [] };
    expect(resolve(screen, msk(9, 11, 30), data, TZ)).toMatchObject({ playlistId: 100, source: 'schedule-screen' });
    const after = resolve(screen, msk(9, 12), data, TZ);
    expect(after).toMatchObject({ playlistId: 200, source: 'schedule-group' });
    expect(after.validUntil).toBe(msk(9, 18));
  });

  it('other groups and screens are ignored', () => {
    const g = rule({ targetType: 'group', targetId: 99, startTime: '09:00', endTime: '18:00' });
    const s = rule({ targetType: 'screen', targetId: 2, startTime: '09:00', endTime: '18:00' });
    expect(resolve(screen, msk(9, 12), { schedules: [g, s], overrides: [] }, TZ).playlistId).toBeNull();
  });

  it('screen without group ignores group rules', () => {
    const g = groupRule({ startTime: '09:00', endTime: '18:00' });
    expect(resolve({ id: 1, groupId: null }, msk(9, 12), { schedules: [g], overrides: [] }, TZ).playlistId).toBeNull();
  });
});

describe('resolve: overrides', () => {
  const s = rule({ startTime: '09:00', endTime: '18:00' });

  it('screen override beats schedule and lasts until expiry', () => {
    const o = override({ createdAt: msk(9, 10), until: msk(9, 11) });
    const data = { schedules: [s], overrides: [o] };
    const r = resolve(screen, msk(9, 10, 30), data, TZ);
    expect(r).toMatchObject({ playlistId: 500, source: 'override-screen', since: msk(9, 10) });
    expect(r.validUntil).toBe(msk(9, 11));
    expect(resolve(screen, msk(9, 11), data, TZ)).toMatchObject({ playlistId: 100, source: 'schedule-screen' });
  });

  it('override to black screen', () => {
    const o = override({ createdAt: msk(9, 10), playlistId: null });
    const r = resolve(screen, msk(9, 12), { schedules: [s], overrides: [o] }, TZ);
    expect(r).toMatchObject({ playlistId: null, source: 'override-screen', validUntil: null });
  });

  it('screen override beats group override', () => {
    const go = override({ targetType: 'group', targetId: 10, playlistId: 600, createdAt: msk(9, 11) });
    const so = override({ createdAt: msk(9, 10), until: msk(9, 13) });
    const data = { schedules: [s], overrides: [go, so] };
    expect(resolve(screen, msk(9, 12), data, TZ)).toMatchObject({ playlistId: 500, source: 'override-screen' });
    const r = resolve(screen, msk(9, 13), data, TZ);
    expect(r).toMatchObject({ playlistId: 600, source: 'override-group' });
  });

  it('group override beats screen schedule', () => {
    const go = override({ targetType: 'group', targetId: 10, playlistId: 600, createdAt: msk(9, 10) });
    expect(resolve(screen, msk(9, 12), { schedules: [s], overrides: [go] }, TZ).playlistId).toBe(600);
  });

  it('newest override for the same target wins', () => {
    const a = override({ createdAt: msk(9, 10), playlistId: 1 });
    const b = override({ createdAt: msk(9, 11), playlistId: 2 });
    expect(resolve(screen, msk(9, 12), { schedules: [], overrides: [a, b] }, TZ).playlistId).toBe(2);
  });

  it('expired override is ignored', () => {
    const o = override({ createdAt: msk(9, 8), until: msk(9, 9) });
    expect(resolve(screen, msk(9, 12), { schedules: [s], overrides: [o] }, TZ).source).toBe('schedule-screen');
  });

  it('schedule boundaries under an active override do not cause recalculation', () => {
    const o = override({ createdAt: msk(9, 8), until: msk(9, 20) });
    expect(resolve(screen, msk(9, 10), { schedules: [s], overrides: [o] }, TZ).validUntil).toBe(msk(9, 20));
  });
});

describe('nextScheduleChange', () => {
  it('screen: next boundary ignoring overrides', () => {
    const s = rule({ startTime: '09:00', endTime: '18:00' });
    expect(nextScheduleChange({ type: 'screen', id: 1 }, [screen], [s], msk(9, 12), TZ)).toBe(msk(9, 18));
  });

  it('group: earliest among group rule and member screens', () => {
    const g = rule({ targetType: 'group', targetId: 10, startTime: '09:00', endTime: '18:00' });
    const s2 = rule({ targetType: 'screen', targetId: 2, startTime: '14:00', endTime: '15:00' });
    const screens = [screen, { id: 2, groupId: 10 }];
    expect(nextScheduleChange({ type: 'group', id: 10 }, screens, [g, s2], msk(9, 12), TZ)).toBe(msk(9, 14));
  });

  it('null when nothing will change', () => {
    expect(nextScheduleChange({ type: 'screen', id: 1 }, [screen], [], msk(9, 12), TZ)).toBeNull();
  });
});

describe('DST-aware timezone', () => {
  it('handles a 23-hour day in Europe/Berlin', () => {
    // 29.03.2026 в Берлине часы переводятся 02:00 → 03:00.
    const s = rule({ startTime: '01:00', endTime: '04:00', days: SUN });
    const tz = 'Europe/Berlin';
    const now = Date.UTC(2026, 2, 29, 0, 30); // 01:30 CET
    const r = resolve(screen, now, { schedules: [s], overrides: [] }, tz);
    expect(r.playlistId).toBe(100);
    // 04:00 CEST = 02:00 UTC
    expect(r.validUntil).toBe(Date.UTC(2026, 2, 29, 2, 0));
  });
});

