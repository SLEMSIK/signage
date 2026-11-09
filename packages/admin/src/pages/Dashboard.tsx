import { useState } from 'react';
import type { ResolveSource, ScreenDto } from '@signage/shared';
import { api } from '../api';
import { useLive } from '../live';
import { ago, formatWhen } from '../format';
import { Empty, ErrorText } from '../components/ui';
import { SwitchDialog, type SwitchTarget } from '../components/SwitchDialog';

export const SOURCE_LABEL: Record<ResolveSource, string> = {
  'override-screen': 'ручное переключение',
  'override-group': 'ручное переключение группы',
  'schedule-screen': 'расписание экрана',
  'schedule-group': 'расписание группы',
  none: 'по умолчанию (вне расписания)',
};

export function DashboardPage() {
  const { screens, refreshScreens } = useLive();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<{ targets: SwitchTarget[]; black: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, okText?: string) => {
    setError(null);
    try {
      await fn();
      if (okText) {
        setFlash(okText);
        window.setTimeout(() => setFlash(null), 3000);
      }
      refreshScreens();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!screens) return <div className="page muted">Загрузка…</div>;

  const online = screens.filter((s) => s.runtime.online).length;
  const groups = [...new Map(screens.filter((s) => s.groupId !== null).map((s) => [s.groupId!, s.groupName!])).entries()];
  const selectedTargets: SwitchTarget[] = screens.filter((s) => selected.has(s.id)).map((s) => ({ type: 'screen', id: s.id, name: s.name }));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Дашборд</h1>
        <div className="toolbar">
          <span className="muted">
            В сети {online} из {screens.length}
          </span>
          {groups.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const g = groups.find(([id]) => id === Number(e.target.value));
                if (g) setDialog({ targets: [{ type: 'group', id: g[0], name: g[1] }], black: false });
              }}
            >
              <option value="">Переключить группу…</option>
              {groups.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-primary" disabled={selected.size === 0} onClick={() => setDialog({ targets: selectedTargets, black: false })}>
            Переключить выбранные{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>

      <ErrorText error={error} />
      {flash && <div className="alert alert-info">{flash}</div>}

      {screens.length === 0 ? (
        <Empty>Экранов пока нет — зарегистрируйте первый в разделе «Экраны и группы».</Empty>
      ) : (
        <div className="screen-grid">
          {screens.map((s) => (
            <ScreenCard
              key={s.id}
              s={s}
              selected={selected.has(s.id)}
              onToggle={() => toggle(s.id)}
              onSwitch={(black) => setDialog({ targets: [{ type: 'screen', id: s.id, name: s.name }], black })}
              onRestore={() => void act(() => api(`/overrides/${s.resolved.overrideId}`, 'DELETE'), `«${s.name}»: возвращено расписание`)}
              onIdentify={() => void act(() => api(`/screens/${s.id}/identify`, 'POST'), `Имя показано на экране «${s.name}»`)}
              onReload={() => void act(() => api(`/screens/${s.id}/reload`, 'POST'), `«${s.name}» перезагружается`)}
            />
          ))}
        </div>
      )}

      {dialog && (
        <SwitchDialog
          targets={dialog.targets}
          initialBlack={dialog.black}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setSelected(new Set());
            refreshScreens();
          }}
        />
      )}
    </div>
  );
}

function ScreenCard({
  s,
  selected,
  onToggle,
  onSwitch,
  onRestore,
  onIdentify,
  onReload,
}: {
  s: ScreenDto;
  selected: boolean;
  onToggle: () => void;
  onSwitch: (black: boolean) => void;
  onRestore: () => void;
  onIdentify: () => void;
  onReload: () => void;
}) {
  const r = s.resolved;
  const isOverride = r.source === 'override-screen' || r.source === 'override-group';
  const playingMismatch = s.runtime.online && s.runtime.playingPlaylistId !== null && s.runtime.playingPlaylistId !== r.playlistId;
  return (
    <div className={`card screen-card select-card${selected ? ' selected' : ''}`}>
      <div className="head">
        <label className="check" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={selected} onChange={onToggle} />
          <div>
            <div className="name">{s.name}</div>
            <div className="small muted">
              {s.groupName ? `группа «${s.groupName}»` : 'без группы'}
              {s.syncMode && ' · синхрон'}
            </div>
          </div>
        </label>
        {s.runtime.online ? <span className="badge badge-on">в сети</span> : <span className="badge badge-off">не в сети</span>}
      </div>
      <dl className="kv">
        <dt>Сейчас</dt>
        <dd>{r.playlistId === null ? <strong>■ чёрный экран</strong> : <strong>{r.playlistName}</strong>}</dd>
        <dt>Источник</dt>
        <dd>{isOverride ? <span className="badge badge-warn">{SOURCE_LABEL[r.source]}</span> : SOURCE_LABEL[r.source]}</dd>
        <dt>Смена</dt>
        <dd>{r.validUntil ? formatWhen(r.validUntil) : isOverride ? 'до отмены' : '—'}</dd>
        {!s.runtime.online && (
          <>
            <dt>Был в сети</dt>
            <dd>{ago(s.runtime.lastSeenAt)}</dd>
          </>
        )}
        {playingMismatch && (
          <>
            <dt>Плеер</dt>
            <dd className="small" style={{ color: 'var(--warning)' }}>
              ещё играет прежний плейлист
            </dd>
          </>
        )}
      </dl>
      <div className="actions">
        <button className="btn btn-sm btn-primary" onClick={() => onSwitch(false)}>
          Переключить
        </button>
        <button className="btn btn-sm btn-dark" onClick={() => onSwitch(true)}>
          Чёрный экран
        </button>
        {isOverride && (
          <button className="btn btn-sm" onClick={onRestore} title={r.source === 'override-group' ? 'Отменит переключение для всей группы' : undefined}>
            Вернуть расписание{r.source === 'override-group' ? ' (группа)' : ''}
          </button>
        )}
        <button className="btn btn-sm btn-ghost" disabled={!s.runtime.online} onClick={onIdentify}>
          Идентифицировать
        </button>
        <button className="btn btn-sm btn-ghost" disabled={!s.runtime.online} onClick={onReload}>
          Перезагрузить
        </button>
      </div>
    </div>
  );
}
