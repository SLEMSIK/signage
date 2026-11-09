import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { LiveProvider, useLive } from './live';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ScreensPage } from './pages/Screens';
import { MediaPage } from './pages/Media';
import { PlaylistsPage } from './pages/Playlists';
import { PlaylistEditorPage } from './pages/PlaylistEditor';
import { SchedulePage } from './pages/Schedule';
import { AuditPage } from './pages/Audit';
import { SettingsPage } from './pages/Settings';

const NAV = [
  { to: '/', label: 'Дашборд', end: true },
  { to: '/screens', label: 'Экраны и группы' },
  { to: '/media', label: 'Медиатека' },
  { to: '/playlists', label: 'Плейлисты' },
  { to: '/schedule', label: 'Расписание' },
  { to: '/audit', label: 'Журнал' },
  { to: '/settings', label: 'Настройки', adminOnly: true },
];

function Shell() {
  const { me, logout, isAdmin } = useSession();
  const { status, connected } = useLive();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/admin/favicon.svg" alt="" width={26} height={26} />
          <span>Signage</span>
        </div>
        <nav>
          {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user">
            <div>{me?.login}</div>
            <div className="muted small">{me?.role === 'admin' ? 'администратор' : 'оператор'}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            Выйти
          </button>
          <div className="muted small" title={connected ? 'Связь с сервером в реальном времени' : 'Переподключение…'}>
            <span className={connected ? 'dot dot-on' : 'dot dot-off'} /> {connected ? 'онлайн' : 'нет связи'} · v{status?.version ?? '…'}
          </div>
        </div>
      </aside>
      <main className="main">
        {status && !status.storageAvailable && (
          <div className="banner banner-error">
            <strong>Хранилище недоступно.</strong> Загрузка медиа заблокирована, экраны продолжают играть из своего кэша.
            {status.storageError && <div className="small">{status.storageError}</div>}
          </div>
        )}
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/screens" element={<ScreensPage />} />
          <Route path="/media" element={<MediaPage />} />
          <Route path="/playlists" element={<PlaylistsPage />} />
          <Route path="/playlists/:id" element={<PlaylistEditorPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={isAdmin ? <SettingsPage /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Gate() {
  const { me, loading } = useSession();
  if (loading) return <div className="center muted">Загрузка…</div>;
  if (!me) return <LoginPage />;
  return (
    <LiveProvider>
      <Shell />
    </LiveProvider>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
