import { useRef, useState } from 'react';
import type { Account, Capability } from '../../shared/types';
import { api } from '../lib/api';
import { nonCredentialAutofill } from '../lib/autofill';
import { useAction } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { ErrorNotice, Field } from './ui';
import { SchoolPicker } from './SchoolPicker';
import { ConnectionTest } from './ConnectionTest';
import { Icon } from './Icon';
export function AccountForm({
  account,
  onSaved,
}: {
  account?: Account;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const action = useAction();
  const testAction = useAction();
  const formRef = useRef<HTMLFormElement>(null);
  const [connection, setConnection] = useState<{
    name: string;
    school: string;
    results?: Capability[];
  }>();
  const [school, setSchool] = useState(account?.school ?? '');
  const [server, setServer] = useState(account?.server ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [nameEdited, setNameEdited] = useState(!!account);
  const formValues = (form: HTMLFormElement) => {
    const data = new FormData(form);
    return {
      name,
      school,
      server,
      username: data.get('username'),
      password: data.get('password') || undefined,
      timezone: data.get('timezone'),
      examSource: data.get('examSource'),
    };
  };
  const testDraft = () => {
    const form = formRef.current;
    if (!form || !form.reportValidity()) return;
    setConnection({ name, school });
    void testAction.run(async () => {
      const results = await api<Capability[]>('/api/accounts/test', {
        method: 'POST',
        body: formValues(form),
      });
      setConnection((current) => (current ? { ...current, results } : current));
    });
  };
  const submit = (form: HTMLFormElement) =>
    action.run(async () => {
      await api('/api/accounts' + (account ? '/' + account.id : ''), {
        method: account ? 'PUT' : 'POST',
        body: formValues(form),
      });
      onSaved();
    });
  return (
    <>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
      >
        <ErrorNotice error={action.error} />
        <SchoolPicker
          initialSchool={account?.school ?? ''}
          onChange={(school, server, displayName) => {
            setSchool(school);
            setServer(server);
            if (displayName && !nameEdited) setName(displayName.slice(0, 100));
          }}
        />
        <Field label={t('Kontoname', 'Account name')}>
          <input
            {...nonCredentialAutofill}
            name="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(!!event.target.value);
            }}
            required
            maxLength={100}
            placeholder={t('z. B. Mein Stundenplan', 'e.g. My timetable')}
          />
        </Field>
        <Field
          label={t('WebUntis-Server (optional)', 'WebUntis server (optional)')}
          hint={t(
            'Wird durch die Schulsuche ausgefüllt. Nur HTTPS-WebUntis-Server.',
            'Filled by school search. HTTPS WebUntis servers only.',
          )}
        >
          <input
            {...nonCredentialAutofill}
            name="school-server"
            value={server}
            onChange={(event) => setServer(event.target.value)}
            placeholder="https://school.webuntis.com"
            maxLength={300}
          />
        </Field>
        <div className="form-grid">
          <Field label={t('Benutzername', 'Username')}>
            <input
              name="username"
              defaultValue={account?.username}
              required
              maxLength={200}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field
            label={
              account
                ? t('Neues Passwort (optional)', 'New password (optional)')
                : t('WebUntis-Passwort', 'WebUntis password')
            }
            hint={
              account
                ? t(
                    'Leer lassen, um es beizubehalten.',
                    'Leave blank to keep the current password.',
                  )
                : undefined
            }
          >
            <input
              type="password"
              name="password"
              required={!account}
              maxLength={512}
              autoComplete="current-password"
            />
          </Field>
        </div>
        <Field
          label={t('Prüfungsquelle', 'Exam source')}
          hint={t(
            'Ist der Prüfungs-Tab nicht verfügbar, wird automatisch der Stundenplan verwendet. Änderungen starten eine Synchronisierung.',
            'If the Exams tab is unavailable, the timetable is used automatically. Changes start a synchronization.',
          )}
        >
          <select
            name="examSource"
            defaultValue={account?.examSource ?? 'exams'}
          >
            <option value="exams">
              {t('Prüfungs-Tab bevorzugen', 'Prefer Exams tab')}
            </option>
            <option value="timetable">{t('Stundenplan', 'Timetable')}</option>
          </select>
        </Field>
        <Field label={t('Zeitzone der Schule', 'School timezone')}>
          <input
            {...nonCredentialAutofill}
            name="timezone"
            defaultValue={account?.timezone ?? 'Europe/Berlin'}
            required
          />
        </Field>
        <div className="notice">
          {t(
            'Dein Passwort wird verschlüsselt gespeichert und ausschließlich an den ausgewählten WebUntis-Server gesendet.',
            'Your password is stored encrypted and sent only to the selected WebUntis server.',
          )}
        </div>
        <div className="actions end">
          {!account && (
            <button
              type="button"
              className="button"
              disabled={action.busy || testAction.busy}
              onClick={testDraft}
            >
              <Icon name="shield" />
              {t('Verbindung testen', 'Test connection')}
            </button>
          )}
          <button
            className="button primary"
            disabled={action.busy || testAction.busy}
          >
            {t('Konto speichern', 'Save account')}
          </button>
        </div>
      </form>
      {connection && (
        <ConnectionTest
          account={connection}
          results={connection.results}
          busy={testAction.busy}
          error={testAction.error}
          onRetry={testDraft}
          onClose={() => setConnection(undefined)}
          onEdit={() => {
            setConnection(undefined);
            formRef.current
              ?.querySelector<HTMLInputElement>('input[name="password"]')
              ?.focus();
          }}
        />
      )}
    </>
  );
}
