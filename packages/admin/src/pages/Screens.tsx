import { useCallback, useEffect, useState } from 'react';
import type { GroupDto } from '@signage/shared';
import { api } from '../api';
import { useLive, useOnChanged } from '../live';
import { useSession } from '../session';
import { ago } from '../format';
import { Empty, ErrorText, Modal } from '../components/ui';

type ScreenForm = { id?: number; code: string; name: string; groupId: number | null; fitDefault: 'contain' | 'cover' };
type GroupForm = { id?: number; name: string; syncPlayback: boolean };

export function ScreensPage() {
  const { screens, pendingCodes, refreshScreens } = useLive();
  const { isAdmin } = useSession();
  const [groups, setGroups] = useState<GroupDto[]>([]);
  const [screenForm, setScreenForm] = useState<ScreenForm | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => Promise<void> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const loadGroups = useCallback(() => {
    api<GroupDto[]>('/groups')
      .then(setGroups)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(loadGroups, [loadGroups]);
  useOnChanged('groups', loadGroups);
  useOnChanged('screens', loadGroups);

  const run = async (fn: () => Promise<unknown>, onDone?: () => void) => {
    setFormError(null);
    try {
      await fn();
      onDone?.();
      refreshScreens();
      loadGroups();
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  const saveScreen = () => {
    if (!screenForm) return;
    const { id, code, ...rest } = screenForm;
    void run(() => (id ? api(`/screens/${id}`, 'PATCH', rest) : api('/screens', 'POST', { code: code.replace(/\D/g, ''), ...rest })), () => setScreenForm(null));
  };

  const saveGroup = () => {
    if (!groupForm) return;
    const { id, ...rest } = groupForm;
    void run(() => (id ? api(`/groups/${id}`, 'PATCH', rest) : api('/groups', 'POST', rest)), () => setGroupForm(null));
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Экраны и группы</h1>
        {isAdmin && (
          <div className="toolbar">
            <button className="btn" onClick={() => setGroupForm({ name: '', syncPlayback: false })}>
              Новая группа
            </button>
            <button className="btn btn-primary" onClick={() => setScreenForm({ code: '', name: '', groupId: null, fitDefault: 'contain' })}>
              Добавить экран
            </button>
          </div>
        )}
      </div>

      <ErrorText error={error} />
      {isAdmin && pendingCodes > 0 && (
        <div className="alert alert-info">
          Ожидают регистрации: {pendingCodes}. Нажмите «Добавить экран» и введите код, показанный на экране.
        </div>
      )}

      <h2>Экраны</h2>
      {!screens ? (
        <div className="muted">Загрузка…</div>
      ) : screens.length === 0 ? (
        <Empty>
          Экранов пока нет. Откройте на плеере адрес <code>{location.origin}/player/</code> — появится 6-значный код.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Экран</th>
                <th>Статус</th>
                <th>Группа</th>
                <th>Вписывание</th>
                <th>Плеер</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {screens.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                  </td>
                  <td>
                    {s.runtime.online ? <span className="badge badge-on">в сети</span> : <span className="badge badge-off">не в сети</span>}
                    {!s.runtime.online && <div className="small muted">был {ago(s.runtime.lastSeenAt)}</div>}
                  </td>
                  <td>
                    {s.groupName ?? <span className="muted">—</span>}
                    {s.syncMode && <span className="badge badge-blue" style={{ marginLeft: 6 }}>синхрон</span>}
                  </td>
                  <td>{s.fitDefault === 'cover' ? 'заполнить' : 'вписать'}</td>
                  <td className="small muted">
                    {s.runtime.ip ?? '—'}
                    {s.runtime.viewport && ` · ${s.runtime.viewport.w}×${s.runtime.viewport.h}`}
                    {s.runtime.cacheStatus && ` · кэш ${s.runtime.cacheStatus.sw ? `${s.runtime.cacheStatus.cached}/${s.runtime.cacheStatus.total}` : 'выкл'}`}
                    {s.runtime.lastError && (
                      <div style={{ color: 'var(--danger)' }} title={s.runtime.lastError}>
                        ошибка: {s.runtime.lastError.slice(25, 90)}
                      </div>
                    )}
                  </td>
                  {isAdmin && (
                    <td style={{ textAlign: 'right' }}>
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-sm" onClick={() => setScreenForm({ id: s.id, code: '', name: s.name, groupId: s.groupId, fitDefault: s.fitDefault })}>
                          Изменить
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() =>
                            setConfirm({
                              title: 'Удалить экран?',
                              text: `«${s.name}» будет удалён вместе с его расписанием. Плеер снова покажет код регистрации.`,
                              action: () => api(`/screens/${s.id}`, 'DELETE').then(() => undefined),
                            })
                          }
                        >
                          Удалить
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 28 }}>Группы</h2>
      {groups.length === 0 ? (
        <Empty>Групп нет. Группа позволяет назначать один плейлист и расписание сразу нескольким экранам.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Группа</th>
                <th>Экранов</th>
                <th>Синхронный показ</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{g.name}</strong>
                  </td>
                  <td>{g.screenCount}</td>
                  <td>{g.syncPlayback ? <span className="badge badge-blue">включён</span> : <span className="muted">нет</span>}</td>
                  {isAdmin && (
                    <td style={{ textAlign: 'right' }}>
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-sm" onClick={() => setGroupForm({ id: g.id, name: g.name, syncPlayback: g.syncPlayback })}>
                          Изменить
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() =>
                            setConfirm({
                              title: 'Удалить группу?',
                              text: `Группа «${g.name}» и её расписание будут удалены. Экраны останутся без группы.`,
                              action: () => api(`/groups/${g.id}`, 'DELETE').then(() => undefined),
                            })
                          }
                        >
                          Удалить
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {screenForm && (
        <Modal
          title={screenForm.id ? 'Экран' : 'Добавить экран'}
          onClose={() => {
            setScreenForm(null);
            setFormError(null);
          }}
          footer={
            <>
              <button className="btn" onClick={() => setScreenForm(null)}>
                Отмена
              </button>
              <button
                className="btn btn-primary"
                disabled={!screenForm.name.trim() || (!screenForm.id && screenForm.code.replace(/\D/g, '').length !== 6)}
                onClick={saveScreen}
              >
                {screenForm.id ? 'Сохранить' : 'Зарегистрировать'}
              </button>
            </>
          }
        >
          {!screenForm.id && (
            <label className="field">
              <span>Код с экрана</span>
              <input
                className="code-input"
                autoFocus
                inputMode="numeric"
                maxLength={7}
                placeholder="000000"
                value={screenForm.code}
                onChange={(e) => setScreenForm({ ...screenForm, code: e.target.value.replace(/[^\d ]/g, '') })}
              />
            </label>
          )}
          <label className="field">
            <span>Название</span>
            <input
              autoFocus={!!screenForm.id}
              placeholder="Например: Холл, левый ТВ"
              value={screenForm.name}
              onChange={(e) => setScreenForm({ ...screenForm, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Группа</span>
            <select
              value={screenForm.groupId ?? ''}
              onChange={(e) => setScreenForm({ ...screenForm, groupId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Без группы</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Вписывание контента по умолчанию</span>
            <select value={screenForm.fitDefault} onChange={(e) => setScreenForm({ ...screenForm, fitDefault: e.target.value as 'contain' | 'cover' })}>
              <option value="contain">Вписать целиком (поля по краям)</option>
              <option value="cover">Заполнить экран (обрезать края)</option>
            </select>
          </label>
          <ErrorText error={formError} />
        </Modal>
      )}

      {groupForm && (
        <Modal
          title={groupForm.id ? 'Группа' : 'Новая группа'}
          onClose={() => {
            setGroupForm(null);
            setFormError(null);
          }}
          footer={
            <>
              <button className="btn" onClick={() => setGroupForm(null)}>
                Отмена
              </button>
              <button className="btn btn-primary" disabled={!groupForm.name.trim()} onClick={saveGroup}>
                Сохранить
              </button>
            </>
          }
        >
          <label className="field">
            <span>Название</span>
            <input autoFocus value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={groupForm.syncPlayback} onChange={(e) => setGroupForm({ ...groupForm, syncPlayback: e.target.checked })} />
            Синхронный показ — экраны группы показывают один и тот же слайд одновременно
          </label>
          <ErrorText error={formError} />
        </Modal>
      )}

      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                Отмена
              </button>
              <button className="btn btn-danger" onClick={() => void run(confirm.action, () => setConfirm(null))}>
                Удалить
              </button>
            </>
          }
        >
          <p>{confirm.text}</p>
          <ErrorText error={formError} />
        </Modal>
      )}
    </div>
  );
}
