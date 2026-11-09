import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { PlaylistDto, PlaylistSummaryDto } from '@signage/shared';
import { api, ApiError } from '../api';
import { useOnChanged } from '../live';
import { formatDateTime, formatDuration } from '../format';
import { Empty, ErrorText, Modal } from '../components/ui';

export function PlaylistsPage() {
  const [items, setItems] = useState<PlaylistSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ p: PlaylistSummaryDto; usage: { schedules: number; overrides: number } } | null>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    api<PlaylistSummaryDto[]>('/playlists')
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useOnChanged('playlists', load);
  useOnChanged('media', load);

  const create = async () => {
    const name = window.prompt('Название плейлиста');
    if (!name?.trim()) return;
    try {
      const p = await api<PlaylistDto>('/playlists', 'POST', { name: name.trim(), items: [] });
      navigate(`/playlists/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const duplicate = async (id: number) => {
    try {
      await api(`/playlists/${id}/duplicate`, 'POST');
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const askDelete = async (p: PlaylistSummaryDto) => {
    const usage = await api<{ schedules: number; overrides: number }>(`/playlists/${p.id}/usage`);
    setDeleting({ p, usage });
  };

  const doDelete = async () => {
    if (!deleting) return;
    const used = deleting.usage.schedules + deleting.usage.overrides > 0;
    try {
      await api(`/playlists/${deleting.p.id}?force=${used ? 1 : 0}`, 'DELETE');
      setDeleting(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Плейлисты</h1>
        <button className="btn btn-primary" onClick={() => void create()}>
          Новый плейлист
        </button>
      </div>
      <ErrorText error={error} />
      {!items ? (
        <div className="muted">Загрузка…</div>
      ) : items.length === 0 ? (
        <Empty>Плейлистов пока нет. Создайте первый и добавьте в него файлы из медиатеки.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Элементов</th>
                <th>Длительность цикла</th>
                <th>Изменён</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/playlists/${p.id}`}>
                      <strong>{p.name}</strong>
                    </Link>
                  </td>
                  <td>{p.itemCount}</td>
                  <td>{formatDuration(p.totalDurationSec)}</td>
                  <td className="muted">{formatDateTime(p.updatedAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="actions" style={{ justifyContent: 'flex-end' }}>
                      <Link className="btn btn-sm" to={`/playlists/${p.id}`}>
                        Редактировать
                      </Link>
                      <button className="btn btn-sm" onClick={() => void duplicate(p.id)}>
                        Копия
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => void askDelete(p)}>
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleting && (
        <Modal
          title="Удалить плейлист?"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)}>
                Отмена
              </button>
              <button className="btn btn-danger" onClick={() => void doDelete()}>
                Удалить
              </button>
            </>
          }
        >
          <p>Плейлист «{deleting.p.name}» будет удалён. Медиафайлы останутся в медиатеке.</p>
          {deleting.usage.schedules + deleting.usage.overrides > 0 && (
            <div className="alert alert-warning">
              Плейлист используется: правил расписания — {deleting.usage.schedules}, ручных переключений — {deleting.usage.overrides}. Они
              тоже будут удалены, и затронутые экраны перейдут на другое расписание или чёрный экран.
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
