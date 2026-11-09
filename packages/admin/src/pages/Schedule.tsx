import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GroupDto, OverrideDto, PlaylistSummaryDto, ScheduleDto, ScheduleInput } from '@signage/shared';
import { api } from '../api';
import { useLive, useOnChanged } from '../live';
import { formatWhen } from '../format';
import { Empty, ErrorText, Modal } from '../components/ui';

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const HOUR_H = 28;
const SNAP = 15;
const PALETTE = ['#1f6feb', '#8250df', '#1a7f37', '#bf3989', '#d4a72c', '#0e8a8a', '#cf222e', '#6e7781', '#fb8500', '#3a86ff'];

const colorFor = (playlistId: number | null) => (playlistId === null ? '#111' : PALETTE[playlistId % PALETTE.length]!);
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

interface Segment {
  rule: ScheduleDto;
  day: number;
  start: number;
  end: number;
  inherited: boolean;
  lane: number;
  lanes: number;
}

/** Раскладывает правила по дням (с переходом через полночь) и по дорожкам при пересечениях. */
function layout(rules: ScheduleDto[], inherited: boolean): Omit<Segment, 'lane' | 'lanes'>[] {
  const out: Omit<Segment, 'lane' | 'lanes'>[] = [];
  for (const rule of rules) {
    const s = toMin(rule.startTime);
    const e = toMin(rule.endTime);
    for (let d = 0; d < 7; d++) {
      if (!(rule.days & (1 << d))) continue;
      if (s < e) out.push({ rule, day: d, start: s, end: e, inherited });
      else {
        out.push({ rule, day: d, start: s, end: 1440, inherited });
        if (e > 0) out.push({ rule, day: (d + 1) % 7, start: 0, end: e, inherited });
      }
    }
  }
  return out;
}

function withLanes(segs: Omit<Segment, 'lane' | 'lanes'>[]): Segment[] {
  const result: Segment[] = [];
  for (let d = 0; d < 7; d++) {
    const day = segs.filter((s) => s.day === d).sort((a, b) => a.start - b.start || Number(a.inherited) - Number(b.inherited));
    const laneEnds: number[] = [];
    const placed = day.map((s) => {
      let lane = laneEnds.findIndex((end) => end <= s.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = s.end;
      return { ...s, lane, lanes: 1 };
    });
    // Ширина: число дорожек среди пересекающихся сегментов.
    for (const p of placed) {
      p.lanes = Math.max(1, ...placed.filter((q) => q.start < p.end && p.start < q.end).map((q) => q.lane + 1));
    }
    result.push(...placed);
  }
  return result;
}

type Target = { type: 'screen' | 'group'; id: number };
type Form = ScheduleInput & { id?: number };

export function SchedulePage() {
  const { screens, status } = useLive();
  const [params, setParams] = useSearchParams();
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummaryDto[]>([]);
  const [data, setData] = useState<{ own: ScheduleDto[]; inherited: ScheduleDto[]; groupId: number | null } | null>(null);
  const [overridesList, setOverrides] = useState<OverrideDto[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const target: Target | null = useMemo(() => {
    const t = params.get('t');
    const m = t && /^(screen|group)-(\d+)$/.exec(t);
    return m ? { type: m[1] as Target['type'], id: Number(m[2]) } : null;
  }, [params]);

  useEffect(() => {
    void api<GroupDto[]>('/groups').then(setGroups);
    void api<PlaylistSummaryDto[]>('/playlists').then(setPlaylists);
  }, []);

  // По умолчанию — первая группа или первый экран.
  useEffect(() => {
    if (target) return;
    if (groups.length) setParams({ t: `group-${groups[0]!.id}` }, { replace: true });
    else if (screens?.length) setParams({ t: `screen-${screens[0]!.id}` }, { replace: true });
  }, [target, groups, screens, setParams]);

  const load = useCallback(() => {
    if (!target) return;
    api<{ own: ScheduleDto[]; inherited: ScheduleDto[]; groupId: number | null }>(`/schedules?targetType=${target.type}&targetId=${target.id}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
    api<OverrideDto[]>('/overrides')
      .then(setOverrides)
      .catch(() => undefined);
  }, [target]);
  useEffect(load, [load]);
  useOnChanged('schedules', load);
  useOnChanged('overrides', load);
  useOnChanged('playlists', () => {
    void api<PlaylistSummaryDto[]>('/playlists').then(setPlaylists);
    load();
  });

  const segments = useMemo(() => (data ? withLanes([...layout(data.inherited, true), ...layout(data.own, false)]) : []), [data]);
  const activeOverride = overridesList.find((o) => target && o.targetType === target.type && o.targetId === target.id);
  const groupName = data?.groupId ? groups.find((g) => g.id === data.groupId)?.name : null;

  const openNew = (day: number, start: number, end: number) => {
    if (!target) return;
    setFormError(null);
    setForm({
      targetType: target.type,
      targetId: target.id,
      playlistId: playlists[0]?.id ?? null,
      days: 1 << day,
      startTime: toHm(start),
      endTime: toHm(end % 1440),
      priority: 0,
      enabled: true,
    });
  };

  const save = async () => {
    if (!form) return;
    const { id, ...body } = form;
    setFormError(null);
    try {
      if (id) await api(`/schedules/${id}`, 'PUT', body);
      else await api('/schedules', 'POST', body);
      setForm(null);
      load();
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!form?.id || !window.confirm('Удалить это правило расписания?')) return;
    try {
      await api(`/schedules/${form.id}`, 'DELETE');
      setForm(null);
      load();
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  const usedPlaylists = [...new Map([...(data?.own ?? []), ...(data?.inherited ?? [])].map((r) => [r.playlistId, r.playlistName ?? 'Чёрный экран'])).entries()];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Расписание</h1>
        <div className="toolbar">
          <select value={target ? `${target.type}-${target.id}` : ''} onChange={(e) => setParams({ t: e.target.value })}>
            {groups.length > 0 && (
              <optgroup label="Группы">
                {groups.map((g) => (
                  <option key={g.id} value={`group-${g.id}`}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
            {screens && screens.length > 0 && (
              <optgroup label="Экраны">
                {screens.map((s) => (
                  <option key={s.id} value={`screen-${s.id}`}>
                    {s.name}
                    {s.groupName ? ` (${s.groupName})` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn btn-primary" disabled={!target} onClick={() => openNew(0, 9 * 60, 18 * 60)}>
            Добавить правило
          </button>
        </div>
      </div>
      <ErrorText error={error} />

      {!target ? (
        <Empty>Сначала зарегистрируйте экран или создайте группу.</Empty>
      ) : (
        <>
          {activeOverride && (
            <div className="alert alert-warning">
              Сейчас действует ручное переключение: {activeOverride.playlistName ?? 'чёрный экран'}
              {activeOverride.until ? ` до ${formatWhen(activeOverride.until)}` : ' до отмены'} ({activeOverride.createdBy}). Расписание ниже
              применится после его окончания.
            </div>
          )}
          <p className="muted small" style={{ marginTop: 0 }}>
            Выделите мышью интервал в нужном дне, чтобы создать правило. Вне правил экран показывает чёрный экран. Часовой пояс:{' '}
            {status?.timezone}.
            {target.type === 'screen' && groupName && ' Заштрихованы правила группы «' + groupName + '» — правила экрана важнее их.'}
          </p>
          <div className="legend">
            {usedPlaylists.map(([id, name]) => (
              <span key={String(id)}>
                <i className="swatch" style={{ background: colorFor(id) }} /> {name}
              </span>
            ))}
          </div>
          <WeekGrid
            segments={segments}
            timezone={status?.timezone}
            onSelect={openNew}
            onOpen={(rule) => {
              setFormError(null);
              setForm({ ...rule });
            }}
          />
        </>
      )}

      {form && (
        <Modal
          title={form.id ? 'Правило расписания' : 'Новое правило'}
          onClose={() => setForm(null)}
          footer={
            <>
              {form.id && (
                <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => void remove()}>
                  Удалить
                </button>
              )}
              <button className="btn" onClick={() => setForm(null)}>
                Отмена
              </button>
              <button className="btn btn-primary" disabled={form.days === 0} onClick={() => void save()}>
                Сохранить
              </button>
            </>
          }
        >
          <label className="field">
            <span>Что показывать</span>
            <select value={form.playlistId ?? ''} onChange={(e) => setForm({ ...form, playlistId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">■ Чёрный экран</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Дни недели (в которые интервал начинается)</span>
            <div className="days-picker">
              {DAYS.map((d, i) => (
                <button key={d} type="button" className={`btn btn-sm${form.days & (1 << i) ? ' on' : ''}`} onClick={() => setForm({ ...form, days: form.days ^ (1 << i) })}>
                  {d}
                </button>
              ))}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm({ ...form, days: 31 })}>
                будни
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setForm({ ...form, days: 127 })}>
                все
              </button>
            </div>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              <span>Начало</span>
              <input type="time" step={300} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Конец</span>
              <input type="time" step={300} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            </label>
            <label className="field" style={{ width: 110 }}>
              <span>Приоритет</span>
              <input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
            </label>
          </div>
          <p className="small muted" style={{ marginTop: -4 }}>
            {toMin(form.endTime) < toMin(form.startTime) && 'Интервал переходит через полночь и заканчивается на следующий день. '}
            {form.startTime === form.endTime && 'Начало равно концу — круглые сутки. '}
            При пересечении правил побеждает больший приоритет, при равном — начавшееся позже.
          </p>
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Правило включено
          </label>
          <ErrorText error={formError} />
        </Modal>
      )}
    </div>
  );
}

function nowInTz(tz: string | undefined): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return { day: wd, minute: h * 60 + m };
}

function WeekGrid({
  segments,
  timezone,
  onSelect,
  onOpen,
}: {
  segments: Segment[];
  timezone: string | undefined;
  onSelect: (day: number, start: number, end: number) => void;
  onOpen: (rule: ScheduleDto) => void;
}) {
  const [sel, setSel] = useState<{ day: number; a: number; b: number } | null>(null);
  const dragging = useRef(false);
  const [now, setNow] = useState(() => nowInTz(timezone));
  useEffect(() => {
    setNow(nowInTz(timezone));
    const t = window.setInterval(() => setNow(nowInTz(timezone)), 60_000);
    return () => window.clearInterval(t);
  }, [timezone]);

  const minuteAt = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const m = ((e.clientY - r.top) / (HOUR_H * 24)) * 1440;
    return Math.max(0, Math.min(1440, Math.round(m / SNAP) * SNAP));
  };

  return (
    <div className="week" style={{ ['--hour-h' as string]: `${HOUR_H}px` }}>
      <div className="week-head" />
      {DAYS.map((d, i) => (
        <div key={d} className="week-head" style={{ color: i === now.day ? 'var(--primary)' : undefined }}>
          {d}
        </div>
      ))}
      <div className="week-hours">
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h}>{h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</div>
        ))}
      </div>
      {DAYS.map((_, day) => (
        <div
          key={day}
          className={`week-day${day === now.day ? ' today' : ''}`}
          style={{ height: HOUR_H * 24 }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('.block')) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            dragging.current = true;
            const m = minuteAt(e);
            setSel({ day, a: m, b: m });
          }}
          onPointerMove={(e) => {
            if (dragging.current && sel?.day === day) setSel({ ...sel, b: minuteAt(e) });
          }}
          onPointerUp={() => {
            if (!dragging.current || !sel) return;
            dragging.current = false;
            const start = Math.min(sel.a, sel.b);
            let end = Math.max(sel.a, sel.b);
            if (end - start < SNAP) end = Math.min(1440, start + 60); // клик — час
            setSel(null);
            onSelect(day, start, end);
          }}
        >
          {segments
            .filter((s) => s.day === day)
            .map((s, i) => (
              <div
                key={`${s.rule.id}-${i}-${s.inherited}`}
                className={`block${s.inherited ? ' inherited' : ''}${s.rule.enabled ? '' : ' disabled'}${s.rule.playlistId === null ? ' black' : ''}`}
                style={{
                  top: (s.start / 60) * HOUR_H,
                  height: Math.max(12, ((s.end - s.start) / 60) * HOUR_H - 1),
                  background: colorFor(s.rule.playlistId),
                  left: `calc(${(s.lane / s.lanes) * 100}% + 2px)`,
                  width: `calc(${100 / s.lanes}% - 4px)`,
                  right: 'auto',
                }}
                title={`${s.rule.playlistName ?? 'Чёрный экран'} · ${s.rule.startTime}–${s.rule.endTime} · приоритет ${s.rule.priority}${s.inherited ? ' · правило группы' : ''}${s.rule.enabled ? '' : ' · выключено'}`}
                onClick={() => !s.inherited && onOpen(s.rule)}
              >
                <strong>{s.rule.playlistName ?? '■ Чёрный'}</strong>
                <div>
                  {s.rule.startTime}–{s.rule.endTime}
                  {s.rule.priority ? ` · p${s.rule.priority}` : ''}
                </div>
              </div>
            ))}
          {sel?.day === day && (
            <div className="block selecting" style={{ top: (Math.min(sel.a, sel.b) / 60) * HOUR_H, height: (Math.abs(sel.b - sel.a) / 60) * HOUR_H }}>
              {toHm(Math.min(sel.a, sel.b))}–{toHm(Math.max(sel.a, sel.b))}
            </div>
          )}
          {day === now.day && <div className="now-line" style={{ top: (now.minute / 60) * HOUR_H }} />}
        </div>
      ))}
    </div>
  );
}
