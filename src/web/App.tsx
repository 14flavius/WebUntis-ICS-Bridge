import { useEffect, useState } from 'react';
import type { SessionUser, SetupStatus } from '../shared/auth';
import { api, ApiError, post } from './lib/api';
import { LanguageProvider, useI18n } from './lib/i18n';
import { useAction } from './lib/hooks';
import { ErrorNotice, Loading } from './components/ui';
import { AuthPage } from './pages/AuthPage';
import { Dashboard } from './pages/Dashboard';
import { Feeds } from './pages/Feeds';
import { Settings } from './pages/Settings';
import { Admin } from './pages/Admin';
import { Brand } from './components/Brand';
import { SiteFooter } from './components/SiteFooter';
import { Icon } from './components/Icon';
import { pagePaths, useNavigation, type Page } from './lib/navigation';
function Application() {
  const { t, language, setLanguage } = useI18n();
  const [session, setSession] = useState<SessionUser | null>();
  const [setup, setSetup] = useState<SetupStatus>({
    required: false,
    expired: false,
    remainingSeconds: 0,
  });
  const [revision, setRevision] = useState(0);
  const { page, navigate, follow } = useNavigation();
  const [error, setError] = useState<unknown>();
  const action = useAction();
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const initial = await api<SetupStatus>('/api/setup', {
          signal: controller.signal,
        });
        setSetup(initial);
        if (initial.required) {
          setSession(null);
          return;
        }
        const user = await api<SessionUser>('/api/me', {
          signal: controller.signal,
        });
        setSession(user);
        setError(undefined);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) setSession(null);
        else setError(error);
      }
    }
    void load();
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const titles = {
      dashboard: t('Übersicht', 'Overview'),
      feeds: t('Kalenderfeeds', 'Calendar feeds'),
      settings: t('Einstellungen', 'Settings'),
      admin: t('Verwaltung', 'Administration'),
    };
    const title = page
      ? titles[page]
      : t('Seite nicht gefunden', 'Page not found');
    document.title = session
      ? `${title} · WebUntis ICS Bridge`
      : 'WebUntis ICS Bridge';
  }, [page, language, session, t]);
  if (session === undefined)
    return (
      <main className="boot">
        <h1>WebUntis ICS Bridge</h1>
        {error ? (
          <>
            <ErrorNotice error={error} />
            <button className="button" onClick={reload}>
              {t('Erneut versuchen', 'Try again')}
            </button>
          </>
        ) : (
          <Loading />
        )}
      </main>
    );
  if (!session)
    return (
      <AuthPage
        key={`${setup.required}-${setup.expired}`}
        setup={setup}
        onLogin={reload}
      />
    );
  const isAdmin = session.role === 'admin';
  // The server enforces access; hiding the page only keeps the interface tidy.
  const visiblePage = page === 'admin' && !isAdmin ? null : page;
  const navigation: { id: Page; label: string }[] = [
    { id: 'dashboard', label: t('Übersicht', 'Overview') },
    { id: 'feeds', label: t('Kalenderfeeds', 'Calendar feeds') },
    { id: 'settings', label: t('Einstellungen', 'Settings') },
  ];
  if (isAdmin)
    navigation.push({ id: 'admin', label: t('Verwaltung', 'Administration') });
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {t('Zum Inhalt', 'Skip to content')}
      </a>
      <aside className="sidebar">
        <Brand />
        <nav aria-label={t('Hauptnavigation', 'Main navigation')}>
          {navigation.map((item) => (
            <a
              key={item.id}
              href={pagePaths[item.id]}
              aria-current={visiblePage === item.id ? 'page' : undefined}
              onClick={(event) => follow(event, item.id)}
            >
              <Icon name={item.id} />
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="actions">
            <button
              className="text-button"
              onClick={() => setLanguage(language === 'de' ? 'en' : 'de')}
            >
              {language === 'de' ? 'EN' : 'DE'}
            </button>
            <span className="admin-username">
              <span className="admin-avatar" aria-hidden="true">
                {session.username.slice(0, 1).toUpperCase()}
              </span>
              {session.username}
            </span>
            <button
              className="button quiet"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await post('/api/auth/sign-out');
                  // The next person may not have access to the current page.
                  navigate('dashboard');
                  setSession(null);
                })
              }
            >
              {t('Abmelden', 'Sign out')}
            </button>
          </div>
        </header>
        <main id="main" className="main-content">
          <ErrorNotice error={error || action.error} />
          {visiblePage === null && (
            <section className="card">
              <h1>{t('Seite nicht gefunden', 'Page not found')}</h1>
              <a href="/" onClick={(event) => follow(event, 'dashboard')}>
                {t('Zur Übersicht', 'Back to overview')}
              </a>
            </section>
          )}
          {visiblePage === 'dashboard' && (
            <Dashboard revision={revision} reload={reload} />
          )}
          {visiblePage === 'feeds' && (
            <Feeds
              revision={revision}
              reload={reload}
              onOpenAccounts={() => navigate('dashboard')}
            />
          )}
          {visiblePage === 'settings' && (
            <Settings
              revision={revision}
              reload={reload}
              twoFactorEnabled={session.twoFactorEnabled}
              isAdmin={isAdmin}
            />
          )}
          {visiblePage === 'admin' && <Admin currentUserId={session.id} />}
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
export function App() {
  return (
    <LanguageProvider>
      <Application />
    </LanguageProvider>
  );
}
