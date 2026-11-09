import { useCallback, useEffect, useState } from 'react';
import type { AuditDto } from '@signage/shared';
import { api } from '../api';
import { formatDateTime } from '../format';
import { Empty, ErrorText } from '../components/ui';

const PAGE = 50;

const ACTION_LABEL: Record<string, string> = {
  login: 'вход',
  login_failed: 'неудачный вход',
  logout: 'выход',
  upload: 'загрузка',
  create: 'создание',
  update: 'изменение',
  delete: 'удаление',
  rename: 'переименование',
  pair: 'регистрация',
  reload: 'перезагрузка',
  switch: 'переключение',
  black_screen: 'чёрный экран',
  restore_schedule: 'возврат расписания',
  restore: 'восстановление',
  move_to_primary: 'перенос на сетевой диск',
};

const ENTITY_LABEL: Record<string, string> = {
  auth: 'вход',
  media: 'медиа',
  playlist: 'плейлист',
  schedule: 'расписание',
  override: 'переключение',
  screen: 'экран',
  group: 'группа',
  backup: 'бэкап',
};

export function AuditPage() {
  const [filters, setFilters] = useState({ user: '', entity: '', action: '', q: '', from: '', to: '' });
  const [options, setOptions] = useState<{ users: string[]; entities: string[]; actions: string[] }>({ users: [], entities: [], actions: [] });
  const [data, setData] = useState<{ items: AuditDto[]; total: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    void api<typeof options>('/audit/filters').then(setOptions);
  }, []);

  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (filters.user) p.set('user', filters.user);
    if (filters.entity) p.set('entity', filters.entity);
    if (filters.action) p.set('action', filters.action);
    if (filters.q.trim()) p.set('q', filters.q.trim());
    if (filters.from) p.set('from', String(new Date(`${filters.from}T00:00:00`).getTime()));
    if (filters.to) p.set('to', String(new Date(`${filters.to}T23:59:59`).getTime()));
    api<{ items: AuditDto[]; total: number }>(`/audit?${p}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [filters, offset]);
  useEffect(load, [load]);

  const set = (patch: Partial<typeof filters>) => {
    setOffset(0);
    setFilters((f) => ({ ...f, ...patch }));
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Журнал действий</h1>
        <div className="toolbar">
          <select value={filters.user} onChange={(e) => set({ user: e.target.value })}>
            <option value="">Все пользователи</option>
            {options.users.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
          <select value={filters.entity} onChange={(e) => set({ entity: e.target.value })}>
            <option value="">Все объекты</option>
            {options.entities.map((u) => (
              <option key={u} value={u}>
                {ENTITY_LABEL[u] ?? u}
              </option>
            ))}
          </select>
          <select value={filters.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">Все действия</option>
            {options.actions.map((u) => (
              <option key={u} value={u}>
                {ACTION_LABEL[u] ?? u}
              </option>
            ))}
          </select>
          <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} title="С даты" />
          <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} title="По дату" />
          <input placeholder="Поиск в деталях" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        </div>
      </div>
      <ErrorText error={error} />
      {!data ? (
        <div className="muted">Загрузка…</div>
      ) : data.items.length === 0 ? (
        <Empty>Записей нет</Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Объект</th>
                  <th>Детали</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id} onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: 'pointer' }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.at)}</td>
                    <td>{a.user}</td>
                    <td>{ACTION_LABEL[a.action] ?? a.action}</td>
                    <td>
                      {ENTITY_LABEL[a.entity] ?? a.entity}
                      {a.entityId ? ` #${a.entityId}` : ''}
                    </td>
                    <td>
                      {a.payload === null ? (
                        <span className="muted">—</span>
                      ) : open === a.id ? (
                        <pre className="pre">{JSON.stringify(a.payload, null, 2)}</pre>
                      ) : (
                        <span className="small muted pre" style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {JSON.stringify(a.payload)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span className="muted small">
              {offset + 1}–{Math.min(offset + PAGE, data.total)} из {data.total}
            </span>
            <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ← Новее
            </button>
            <button className="btn btn-sm" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
              Старее →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
