import { useCallback, useEffect, useState } from 'react';
import type { BackupDto } from '@signage/shared';
import { api } from '../api';
import { useLive } from '../live';
import { formatBytes, formatDateTime } from '../format';
import { Empty, ErrorText, Modal } from '../components/ui';

export function SettingsPage() {
  const { status } = useLive();
  const [backups, setBackups] = useState<BackupDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<BackupDto | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    api<BackupDto[]>('/backups')
      .then(setBackups)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await api<BackupDto>('/backups', 'POST');
      setFlash(`Бэкап создан: ${b.name}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!restoring) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/backups/${encodeURIComponent(restoring.name)}/restore`, 'POST');
      setRestoring(null);
      setFlash(`База восстановлена из ${restoring.name}. Перед восстановлением сделана страховочная копия.`);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Настройки</h1>
      <ErrorText error={error} />
      {flash && <div className="alert alert-info">{flash}</div>}

      <div className="grid-2">
        <div className="card">
          <h2>Хранилище</h2>
          {status && (
            <dl className="kv" style={{ gridTemplateColumns: '170px 1fr' }}>
              <dt>Сетевой диск (SMB)</dt>
              <dd>
                {status.storageAvailable ? <span className="badge badge-on">доступен</span> : <span className="badge badge-off">недоступен</span>}
                {status.storageError && <div className="small muted">{status.storageError}</div>}
              </dd>
              <dt>Путь в контейнере</dt>
              <dd className="small">{status.mediaPath}</dd>
              <dt>Резерв на диске VM</dt>
              <dd>
                {status.localFallbackPath ? (
                  <>
                    <span className="small">{status.localFallbackPath}</span>
                    {status.localFreeMb !== null && <div className="small muted">свободно {formatBytes(status.localFreeMb * 1024 * 1024)}</div>}
                  </>
                ) : (
                  <span className="muted">выключен</span>
                )}
              </dd>
              <dt>Ждут переноса на SMB</dt>
              <dd>{status.localPending}</dd>
              <dt>Загрузка сейчас</dt>
              <dd>
                {status.uploadTarget === 'primary' && 'на сетевой диск'}
                {status.uploadTarget === 'local' && <span style={{ color: 'var(--warning)' }}>на диск сервера</span>}
                {status.uploadTarget === null && <span style={{ color: 'var(--danger)' }}>невозможна: {status.uploadBlockedReason}</span>}
              </dd>
            </dl>
          )}
        </div>

        <div className="card">
          <h2>Система</h2>
          {status && (
            <dl className="kv" style={{ gridTemplateColumns: '170px 1fr' }}>
              <dt>Версия</dt>
              <dd>{status.version}</dd>
              <dt>Часовой пояс</dt>
              <dd>{status.timezone}</dd>
              <dt>Время сервера</dt>
              <dd>{formatDateTime(status.serverTime)}</dd>
              <dt>ffmpeg</dt>
              <dd>{status.ffmpeg ? 'установлен' : <span style={{ color: 'var(--warning)' }}>нет — без превью и длительности видео</span>}</dd>
              <dt>Лимит загрузки</dt>
              <dd>{status.maxUploadMb} МБ</dd>
              <dt>Длительность</dt>
              <dd>
                картинка {status.defaultImageDurationSec} с, HTML {status.defaultHtmlDurationSec} с
              </dd>
            </dl>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>
            Пользователи, сети и прокси настраиваются в <code>config/config.yaml</code> на сервере.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="page-head" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Бэкапы базы данных</h2>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            Сделать бэкап сейчас
          </button>
        </div>
        {status && (
          <p className="small muted">
            Автоматически при запуске сервера и ежедневно в {status.backupTime} ({status.timezone}). Хранятся последние {status.backupKeep} копий в{' '}
            <code>{status.backupPath}</code>. Пока сетевой диск недоступен, копии пишутся на диск сервера и переносятся позже. Медиафайлы в бэкап
            не входят: они лежат на сетевом диске.
          </p>
        )}
        {!backups ? (
          <div className="muted">Загрузка…</div>
        ) : backups.length === 0 ? (
          <Empty>Бэкапов пока нет</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Файл</th>
                  <th>Создан</th>
                  <th>Размер</th>
                  <th>Где</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={`${b.location}-${b.name}`}>
                    <td className="pre">{b.name}</td>
                    <td>{formatDateTime(b.createdAt)}</td>
                    <td>{formatBytes(b.size)}</td>
                    <td>{b.location === 'primary' ? 'сетевой диск' : <span style={{ color: 'var(--warning)' }}>диск сервера</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <a className="btn btn-sm" href={`/api/admin/backups/${encodeURIComponent(b.name)}/download`}>
                          Скачать
                        </a>
                        <button className="btn btn-sm btn-danger" onClick={() => setRestoring(b)}>
                          Восстановить
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {restoring && (
        <Modal
          title="Восстановить базу?"
          onClose={() => setRestoring(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRestoring(null)}>
                Отмена
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => void restore()}>
                {busy ? 'Восстановление…' : 'Восстановить'}
              </button>
            </>
          }
        >
          <p>
            Текущая база будет заменена копией <strong>{restoring.name}</strong> от {formatDateTime(restoring.createdAt)}. Все изменения после этого
            момента (плейлисты, расписание, экраны, журнал) пропадут.
          </p>
          <p className="small muted">Перед заменой автоматически сохраняется страховочная копия текущей базы. Экраны получат новое состояние сразу.</p>
        </Modal>
      )}
    </div>
  );
}
