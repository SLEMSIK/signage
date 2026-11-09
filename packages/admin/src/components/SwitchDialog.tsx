import { useEffect, useState } from 'react';
import type { OverrideInput, PlaylistSummaryDto } from '@signage/shared';
import { api } from '../api';
import { ErrorText, Modal } from './ui';

export interface SwitchTarget {
  type: 'screen' | 'group';
  id: number;
  name: string;
}

/** Ручное переключение: плейлист или чёрный экран на срок. */
export function SwitchDialog({
  targets,
  initialBlack = false,
  onClose,
  onDone,
}: {
  targets: SwitchTarget[];
  initialBlack?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [playlists, setPlaylists] = useState<PlaylistSummaryDto[]>([]);
  const [playlistId, setPlaylistId] = useState<number | 'black' | ''>(initialBlack ? 'black' : '');
  const [mode, setMode] = useState<OverrideInput['mode']>('next');
  const [hours, setHours] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PlaylistSummaryDto[]>('/playlists')
      .then(setPlaylists)
      .catch((e: Error) => setError(e.message));
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: OverrideInput = {
        targets: targets.map((t) => ({ type: t.type, id: t.id })),
        playlistId: playlistId === 'black' ? null : Number(playlistId),
        mode,
        hours: mode === 'hours' ? hours : undefined,
      };
      await api('/overrides', 'POST', body);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Переключить контент"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className={playlistId === 'black' ? 'btn btn-dark' : 'btn btn-primary'} disabled={busy || playlistId === ''} onClick={() => void submit()}>
            {playlistId === 'black' ? 'Включить чёрный экран' : 'Переключить'}
          </button>
        </>
      }
    >
      <div className="field">
        <span>Куда</span>
        <div>{targets.map((t) => (t.type === 'group' ? `группа «${t.name}»` : t.name)).join(', ')}</div>
      </div>
      <label className="field">
        <span>Что показывать</span>
        <select value={playlistId} onChange={(e) => setPlaylistId(e.target.value === 'black' ? 'black' : e.target.value ? Number(e.target.value) : '')}>
          <option value="">— выберите плейлист —</option>
          <option value="black">■ Чёрный экран</option>
          {playlists.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.itemCount} эл.)
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>На какой срок</span>
        <label className="check">
          <input type="radio" checked={mode === 'next'} onChange={() => setMode('next')} /> До следующей смены по расписанию
        </label>
        <label className="check">
          <input type="radio" checked={mode === 'hours'} onChange={() => setMode('hours')} /> На
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={hours}
            style={{ width: 80 }}
            onChange={(e) => setHours(Number(e.target.value))}
            onFocus={() => setMode('hours')}
          />
          ч
        </label>
        <label className="check">
          <input type="radio" checked={mode === 'forever'} onChange={() => setMode('forever')} /> До отмены вручную
        </label>
      </div>
      <ErrorText error={error} />
    </Modal>
  );
}
