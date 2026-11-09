import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router-dom';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Fit, MediaDto, PlaylistDto, SystemStatus, Transition } from '@signage/shared';
import { api } from '../api';
import { useLive } from '../live';
import { formatDuration } from '../format';
import { Empty, ErrorText, MediaThumb, Modal, StagePreview, TYPE_LABEL } from '../components/ui';

interface EditItem {
  key: string;
  mediaId: number;
  media: MediaDto | null;
  durationSec: number | null;
  fit: Fit | null;
  transition: Transition;
}

let keySeq = 0;
const newKey = () => `k${++keySeq}`;

function effectiveDuration(i: EditItem, status: SystemStatus | null): number {
  if (i.durationSec !== null) return i.durationSec;
  if (i.media?.type === 'video') return i.media.durationSec ?? 30;
  if (i.media?.type === 'image') return status?.defaultImageDurationSec ?? 10;
  return status?.defaultHtmlDurationSec ?? 30;
}

export function PlaylistEditorPage() {
  const { id } = useParams();
  const { status } = useLive();
  const [name, setName] = useState('');
  const [items, setItems] = useState<EditItem[]>([]);
  const [saved, setSaved] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const snapshot = useMemo(
    () => JSON.stringify({ name, items: items.map(({ mediaId, durationSec, fit, transition }) => ({ mediaId, durationSec, fit, transition })) }),
    [name, items],
  );
  const dirty = loaded && snapshot !== saved;

  const load = useCallback(() => {
    api<PlaylistDto>(`/playlists/${id}`)
      .then((p) => {
        setName(p.name);
        const its = p.items.map((i) => ({ key: newKey(), mediaId: i.mediaId, media: i.media, durationSec: i.durationSec, fit: i.fit, transition: i.transition }));
        setItems(its);
        setSaved(JSON.stringify({ name: p.name, items: its.map(({ mediaId, durationSec, fit, transition }) => ({ mediaId, durationSec, fit, transition })) }));
        setLoaded(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm('Есть несохранённые изменения. Уйти без сохранения?')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/playlists/${id}`, 'PUT', JSON.parse(snapshot));
      setSaved(snapshot);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    setItems((its) => arrayMove(its, its.findIndex((i) => i.key === e.active.id), its.findIndex((i) => i.key === e.over!.id)));
  };

  const update = (key: string, patch: Partial<EditItem>) => setItems((its) => its.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const total = items.reduce((s, i) => s + effectiveDuration(i, status), 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ flex: 1, minWidth: 300 }}>
          <Link to="/playlists" className="btn btn-ghost btn-sm">
            ← Плейлисты
          </Link>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ fontSize: 18, fontWeight: 600, flex: 1, maxWidth: 480 }} />
        </div>
        <div className="toolbar">
          <span className="muted">
            {items.length} эл. · цикл {formatDuration(total)}
          </span>
          <button className="btn" onClick={() => setPicker(true)}>
            + Добавить из медиатеки
          </button>
          <button className="btn btn-primary" disabled={!dirty || busy || !name.trim()} onClick={() => void save()}>
            {busy ? 'Сохранение…' : dirty ? 'Сохранить' : 'Сохранено'}
          </button>
        </div>
      </div>
      <ErrorText error={error} />

      <div className="editor">
        <div>
          {items.length === 0 ? (
            <Empty>Плейлист пуст. Нажмите «Добавить из медиатеки».</Empty>
          ) : (
            <>
              <div className="item-row" style={{ background: 'transparent', border: 'none', padding: '0 8px', fontSize: 12, color: 'var(--muted)' }}>
                <span />
                <span />
                <span>Файл</span>
                <span>Длительность, с</span>
                <span>Вписывание</span>
                <span>Переход</span>
                <span />
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
                  <div className="items">
                    {items.map((i) => (
                      <Row
                        key={i.key}
                        item={i}
                        status={status}
                        onChange={(p) => update(i.key, p)}
                        onRemove={() => setItems((its) => its.filter((x) => x.key !== i.key))}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </>
          )}
        </div>
        <div className="preview-box card">
          <h3>Предпросмотр</h3>
          <PlaylistPreview items={items} status={status} />
          <p className="small muted" style={{ marginBottom: 0 }}>
            Сцена 1920×1080. Длительности как на экране; без звука.
          </p>
        </div>
      </div>

      {picker && (
        <MediaPicker
          onClose={() => setPicker(false)}
          onPick={(ms) => {
            setItems((its) => [
              ...its,
              ...ms.map((m) => ({ key: newKey(), mediaId: m.id, media: m, durationSec: null, fit: null, transition: 'fade' as const })),
            ]);
            setPicker(false);
          }}
        />
      )}
    </div>
  );
}

function Row({ item, status, onChange, onRemove }: { item: EditItem; status: SystemStatus | null; onChange: (p: Partial<EditItem>) => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key });
  const auto = effectiveDuration({ ...item, durationSec: null }, status);
  return (
    <div
      ref={setNodeRef}
      className="item-row"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1, zIndex: isDragging ? 5 : undefined, position: 'relative' }}
    >
      <span className="drag-handle" {...attributes} {...listeners} title="Перетащите, чтобы изменить порядок">
        ⠿
      </span>
      <MediaThumb media={item.media} showType={false} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.media?.title ?? 'файл удалён'}</div>
        <div className="small muted">{item.media ? TYPE_LABEL[item.media.type] : ''}</div>
      </div>
      <input
        type="number"
        min={1}
        step={1}
        placeholder={item.media?.type === 'video' ? `${Math.round(auto)} (ролик)` : `${auto} (авто)`}
        value={item.durationSec ?? ''}
        onChange={(e) => onChange({ durationSec: e.target.value === '' ? null : Math.max(1, Number(e.target.value)) })}
        title="Пусто — по умолчанию: длина ролика для видео, настройка сервера для картинок и HTML"
      />
      <select value={item.fit ?? ''} onChange={(e) => onChange({ fit: (e.target.value || null) as Fit | null })} disabled={item.media?.type === 'html' || item.media?.type === 'html_zip'}>
        <option value="">как у экрана</option>
        <option value="contain">вписать</option>
        <option value="cover">заполнить</option>
        <option value="stretch">растянуть</option>
      </select>
      <select value={item.transition} onChange={(e) => onChange({ transition: e.target.value as Transition })}>
        <option value="fade">плавно</option>
        <option value="none">сразу</option>
      </select>
      <button className="btn btn-ghost btn-icon" onClick={onRemove} title="Убрать из плейлиста">
        ✕
      </button>
    </div>
  );
}

/** Прокрутка элементов по кругу с их длительностями (упрощённо, без двойного буфера). */
function PlaylistPreview({ items, status }: { items: EditItem[]; status: SystemStatus | null }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const current = items.length ? items[idx % items.length]! : null;

  useEffect(() => {
    if (!playing || !current || items.length < 2) return;
    const t = window.setTimeout(() => setIdx((i) => (i + 1) % items.length), effectiveDuration(current, status) * 1000);
    return () => window.clearTimeout(t);
  }, [idx, playing, current, items.length, status]);

  return (
    <div>
      <StagePreview key={current?.key} media={current?.media ?? null} fit={current?.fit ?? 'contain'} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-sm" disabled={!items.length} onClick={() => setIdx((i) => (i - 1 + items.length) % Math.max(1, items.length))}>
          ◀
        </button>
        <button className="btn btn-sm" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Пауза' : 'Играть'}
        </button>
        <button className="btn btn-sm" disabled={!items.length} onClick={() => setIdx((i) => (i + 1) % Math.max(1, items.length))}>
          ▶
        </button>
        <span className="small muted">{items.length ? `${(idx % items.length) + 1} / ${items.length}` : '—'}</span>
      </div>
    </div>
  );
}

function MediaPicker({ onClose, onPick }: { onClose: () => void; onPick: (m: MediaDto[]) => void }) {
  const [all, setAll] = useState<MediaDto[]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    void api<MediaDto[]>('/media').then(setAll);
  }, []);
  const shown = all.filter((m) => !q || m.title.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <Modal
      title="Добавить из медиатеки"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            Выбрано: {sel.length} (в порядке выбора)
          </span>
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!sel.length} onClick={() => onPick(sel.map((id) => all.find((m) => m.id === id)!))}>
            Добавить
          </button>
        </>
      }
    >
      <input placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 12 }} autoFocus />
      {shown.length === 0 ? (
        <Empty>Нет файлов. Загрузите их в разделе «Медиатека».</Empty>
      ) : (
        <div className="picker-grid">
          {shown.map((m) => (
            <div key={m.id} className={`media-tile${sel.includes(m.id) ? ' selected' : ''}`} style={{ cursor: 'pointer' }} onClick={() => toggle(m.id)}>
              <MediaThumb media={m} />
              <div className="info">
                <div className="title">
                  {sel.includes(m.id) && <span className="badge badge-blue">{sel.indexOf(m.id) + 1}</span>} {m.title}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
