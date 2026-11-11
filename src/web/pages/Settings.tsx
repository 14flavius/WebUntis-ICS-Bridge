import { useState } from 'react';
import type { Language } from '../../shared/types';
import { api } from '../lib/api';
import { useAction, useResource } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { ErrorNotice, Field, Loading, PageHeader } from '../components/ui';
import { SecuritySettings } from '../components/SecuritySettings';
import { SettingsSection } from '../components/SettingsSection';
import { Icon } from '../components/Icon';
interface SettingsData {
  intervalMinutes: number;
  version: string;
  node: string;
  database: string;
}
export function Settings({
  revision,
  reload,
  twoFactorEnabled,
  isAdmin,
}: {
  revision: number;
  reload: () => void;
  twoFactorEnabled: boolean;
  isAdmin: boolean;
}) {
  const { data, error } = useResource<SettingsData>('/api/settings', revision);
  const { t, language, setLanguage } = useI18n();
  const action = useAction();
  const [saved, setSaved] = useState(false);
  const save = (form: HTMLFormElement) =>
    action.run(async () => {
      const values = new FormData(form);
      // The interval is shared by all users; the language is a personal
      // preference stored in this browser.
      if (isAdmin)
        await api('/api/settings', {
          method: 'PUT',
          body: { intervalMinutes: Number(values.get('interval')) },
        });
      setLanguage(values.get('language') as Language);
      setSaved(true);
      reload();
    });
  return (
    <>
      <PageHeader title={t('Einstellungen', 'Settings')} />
      <ErrorNotice error={error || action.error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="settings-layout">
          <SettingsSection title={t('Allgemein', 'General')} icon="settings">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(event.currentTarget);
              }}
            >
              <div className="form-grid">
                {isAdmin && (
                  <Field
                    label={t(
                      'Synchronisierungsintervall (Minuten)',
                      'Sync interval (minutes)',
                    )}
                    hint={t(
                      'Gilt zentral für alle Benutzer und Konten. Mindestens 5 Minuten.',
                      'Applies centrally to all users and accounts. At least 5 minutes.',
                    )}
                  >
                    <input
                      key={data.intervalMinutes}
                      name="interval"
                      type="number"
                      min={5}
                      max={1440}
                      defaultValue={data.intervalMinutes}
                      required
                    />
                  </Field>
                )}
                <Field label={t('Sprache', 'Language')}>
                  <select
                    key={language}
                    name="language"
                    defaultValue={language}
                  >
                    <option value="de">Deutsch</option>
                    <option value="en">English</option>
                  </select>
                </Field>
              </div>
              <button className="button primary" disabled={action.busy}>
                {t('Speichern', 'Save')}
              </button>
              {saved && (
                <span role="status" className="saved">
                  {t('Gespeichert ✓', 'Saved ✓')}
                </span>
              )}
            </form>
          </SettingsSection>
          <SecuritySettings enabled={twoFactorEnabled} reload={reload} />
          <section className="settings-system">
            <h2>
              <Icon name="system" />
              {t('Systeminformationen', 'System information')}
            </h2>
            <dl className="system-info">
              <div>
                <dt>WebUntis ICS Bridge</dt>
                <dd>{data.version}</dd>
              </div>
              <div>
                <dt>Node.js</dt>
                <dd>{data.node}</dd>
              </div>
              <div>
                <dt>{t('Datenbank', 'Database')}</dt>
                <dd>{data.database}</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </>
  );
}
