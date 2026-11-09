import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { MediaDto } from '@signage/shared';
import { api, ApiError, upload } from '../api';
import { useLive, useOnChanged } from '../live';
import { formatBytes, formatDateTime, formatDuration } from '../format';
import { Empty, ErrorText, MediaThumb, Modal, StagePreview, TYPE_LABEL } from '../components/ui';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.m4v,.webm,.html,.htm,.zip';
const PARALLEL = 2;

interface UploadJob {
  id: number;
  file: File;
  loaded: number;
  state: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
  warnings?: string[];
}

let jobSeq = 0;

export function MediaPage() {
  const { status } = useLive();
  const [items, setItems] = useState<MediaDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | MediaDto['type']>('all');
  const [query, setQuery] = useState('');
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<MediaDto | null>(null);
  const [deleting, setDeleting] = useState<{ media: MediaDto; playlists: { id: number; name: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Загружать можно, если есть куда: на сетевой диск или, при его недоступности, на диск сервера.
  const storageOk = status ? status.uploadTarget !== null : true;

  const load = useCallback(() => {
    api<MediaDto[]>('/media')
      .then(setItems)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useOnChanged('media', load);

  // Очередь загрузки: не больше PARALLEL одновременно.
  useEffect(() => {
    const active = jobs.filter((j) => j.state === 'uploading').length;
    const next = jobs.filter((j) => j.state === 'queued').slice(0, Math.max(0, PARALLEL - active));
    for (const job of next) {
      setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, state: 'uploading' } : j)));
      const { promise } = upload<MediaDto>('/media', job.file, (p) =>
        setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, loaded: p.loaded } : j))),
      );
      promise
        .then((dto) => {
          setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, state: 'done', loaded: job.file.size, warnings: dto.warnings } : j)));
          load();
        })
        .catch((e: Error) => setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, state: 'error', error: e.message } : j))));
    }
  }, [jobs, load]);

  const addFiles = (files: FileList | File[]) => {
    if (!storageOk) return;
    const list = Array.from(files);
    const tooBig = status ? list.filter((f) => f.size > status.maxUploadMb * 1024 * 1024) : [];
    setJobs((js) => [
      ...js.filter((j) => j.state !== 'done' || (j.warnings?.length ?? 0) > 0),
      ...list.map((file) => ({
        id: ++jobSeq,
        file,
        loaded: 0,
        state: tooBig.includes(file) ? ('error' as const) : ('queued' as const),
        error: tooBig.includes(file) ? `Больше ${status?.maxUploadMb} МБ` : undefined,
      })),
    ]);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((m) => (filter === 'all' || m.type === filter) && (!q || m.title.toLowerCase().includes(q)));
  }, [items, filter, query]);

  const askDelete = async (m: MediaDto) => {
    try {
      const playlists = await api<{ id: number; name: string }[]>(`/media/${m.id}/usage`);
      setDeleting({ media: m, playlists });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await api(`/media/${deleting.media.id}?force=${deleting.playlists.length ? 1 : 0}`, 'DELETE');
      setDeleting(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const rename = async (m: MediaDto) => {
    const title = window.prompt('Название', m.title);
    if (!title || title === m.title) return;
    try {
      await api(`/media/${m.id}`, 'PATCH', { title });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Медиатека</h1>
        <div className="toolbar">
          <input placeholder="Поиск по названию" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">Все типы</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ErrorText error={error} />

      <div
        className={`dropzone${over ? ' over' : ''}${storageOk ? '' : ' disabled'}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => storageOk && input.current?.click()}
      >
        {storageOk ? (
          <>
            <strong>Перетащите файлы сюда</strong> или нажмите, чтобы выбрать
            {status?.uploadTarget === 'local' && (
              <div className="small" style={{ color: 'var(--warning)' }}>
                Сетевой диск недоступен — файлы будут сохранены на диск сервера
                {status.localFreeMb !== null ? ` (свободно ${formatBytes(status.localFreeMb * 1024 * 1024)})` : ''}
              </div>
            )}
            <div className="small">
              Изображения (jpg, png, webp, gif), видео (mp4 H.264, webm), HTML-файл или zip-пакет с index.html. До {status?.maxUploadMb ?? '…'} МБ.
            </div>
          </>
        ) : (
          <>
            <strong>Загрузка недоступна</strong>
            <div className="small">{status?.uploadBlockedReason ?? 'Хранилище не подключено'}</div>
          </>
        )}
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {jobs.length > 0 && (
        <div className="uploads">
          {jobs.map((j) => (
            <div key={j.id}>
              <div className="upload-row">
                <span title={j.file.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.file.name} <span className="muted small">{formatBytes(j.file.size)}</span>
                </span>
                <div className="progress">
                  <div style={{ width: `${j.state === 'done' ? 100 : Math.round((j.loaded / Math.max(1, j.file.size)) * 100)}%` }} />
                </div>
                <span className={j.state === 'error' ? 'small' : 'small muted'} style={j.state === 'error' ? { color: 'var(--danger)' } : {}}>
                  {j.state === 'queued' && 'в очереди'}
                  {j.state === 'uploading' && (j.loaded >= j.file.size ? 'обработка…' : 'загрузка')}
                  {j.state === 'done' && 'готово'}
                  {j.state === 'error' && 'ошибка'}
                </span>
              </div>
              {j.error && <div className="alert alert-error small" style={{ marginTop: 4 }}>{j.error}</div>}
              {j.warnings && j.warnings.length > 0 && (
                <div className="alert alert-warning small" style={{ marginTop: 4 }}>
                  {j.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {jobs.every((j) => j.state === 'done' || j.state === 'error') && (
            <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-end' }} onClick={() => setJobs([])}>
              Скрыть список загрузок
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="muted">Загрузка…</div>
      ) : shown.length === 0 ? (
        <Empty>{items.length === 0 ? 'Медиатека пуста — загрузите первый файл' : 'Ничего не найдено'}</Empty>
      ) : (
        <div className="media-grid">
          {shown.map((m) => (
            <div key={m.id} className="media-tile">
              <div onClick={() => setPreview(m)} style={{ cursor: 'pointer' }}>
                <MediaThumb media={m} />
              </div>
              <div className="info">
                <div className="title" title={m.title}>
                  {m.title}
                </div>
                <div className="muted">
                  {formatBytes(m.size)}
                  {m.durationSec ? ` · ${formatDuration(m.durationSec)}` : ''}
                </div>
                {status && !status.storageAvailable && m.location === 'primary' && !m.mirrored && (
                  <div className="small" style={{ color: 'var(--danger)' }} title="Файл есть только на сетевом диске, копии на диске сервера нет">
                    недоступен без SMB
                  </div>
                )}
                {m.location === 'local' && (
                  <div className="small" style={{ color: 'var(--warning)' }} title="Сетевой диск был недоступен. Файл будет перенесён автоматически.">
                    ⏳ на диске сервера, ждёт переноса
                  </div>
                )}
                {m.warnings.filter((w) => !w.startsWith('Сетевой диск был недоступен')).length > 0 && (
                  <div className="small" style={{ color: 'var(--warning)' }} title={m.warnings.join('\n')}>
                    ⚠ есть предупреждения
                  </div>
                )}
              </div>
              <div className="tile-actions">
                <button className="btn btn-sm" onClick={() => void rename(m)}>
                  Переименовать
                </button>
                <span className="spacer" />
                <button className="btn btn-sm btn-danger" onClick={() => void askDelete(m)}>
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} wide>
          <StagePreview media={preview} />
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Тип</dt>
            <dd>{TYPE_LABEL[preview.type]}</dd>
            <dt>Размер</dt>
            <dd>{formatBytes(preview.size)}</dd>
            {preview.durationSec && (
              <>
                <dt>Длительность</dt>
                <dd>{formatDuration(preview.durationSec)}</dd>
              </>
            )}
            <dt>Загружен</dt>
            <dd>
              {formatDateTime(preview.createdAt)}, {preview.createdBy}
            </dd>
          </dl>
          {preview.warnings.length > 0 && (
            <div className="alert alert-warning small" style={{ marginTop: 12 }}>
              {preview.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {deleting && (
        <Modal
          title="Удалить файл?"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)}>
                Отмена
              </button>
              <button className="btn btn-danger" onClick={() => void confirmDelete()}>
                Удалить
              </button>
            </>
          }
        >
          <p>
            «{deleting.media.title}» будет удалён без возможности восстановления.
          </p>
          {deleting.playlists.length > 0 && (
            <div className="alert alert-warning">
              Файл используется в плейлистах — он будет из них убран:
              <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                {deleting.playlists.map((p) => (
                  <li key={p.id}>{p.name}</li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
