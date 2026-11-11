import { useState } from 'react';
import { post } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { ErrorNotice, Field } from './ui';
import { SettingsSection } from './SettingsSection';
export function SecuritySettings({
  enabled,
  reload,
}: {
  enabled: boolean;
  reload: () => void;
}) {
  const { t } = useI18n();
  const action = useAction();
  const [qr, setQr] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [message, setMessage] = useState('');
  const passwordChange = (form: HTMLFormElement) =>
    action.run(async () => {
      const data = new FormData(form);
      await post('/api/auth/change-password', {
        currentPassword: data.get('current'),
        newPassword: data.get('next'),
        revokeOtherSessions: true,
      });
      form.reset();
      setMessage(t('Passwort geändert.', 'Password changed.'));
    });
  const toggle = (form: HTMLFormElement) =>
    action.run(async () => {
      const password = new FormData(form).get('password');
      if (enabled) {
        await post('/api/auth/two-factor/disable', { password });
        setQr('');
        setCodes(undefined);
        reload();
      } else {
        const result = await post<{ totpURI: string; backupCodes: string[] }>(
          '/api/auth/two-factor/enable',
          { password },
        );
        const QRCode = await import('qrcode');
        setQr(
          await QRCode.toDataURL(result.totpURI, { width: 220, margin: 2 }),
        );
        setCodes(result.backupCodes);
      }
      form.reset();
    });
  return (
    <>
      <ErrorNotice error={action.error} />
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <SettingsSection
        title={t('Passwort ändern', 'Change password')}
        icon="lock"
        description={t(
          'Andere Sitzungen werden nach der Änderung abgemeldet.',
          'Other sessions are signed out after the change.',
        )}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void passwordChange(event.currentTarget);
          }}
        >
          <div className="form-grid">
            <Field label={t('Aktuelles Passwort', 'Current password')}>
              <input
                type="password"
                name="current"
                required
                autoComplete="current-password"
              />
            </Field>
            <Field
              label={t('Neues Passwort', 'New password')}
              hint={t('Mindestens 12 Zeichen.', 'At least 12 characters.')}
            >
              <input
                type="password"
                name="next"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <button className="button" disabled={action.busy}>
            {t('Passwort ändern', 'Change password')}
          </button>
        </form>
      </SettingsSection>
      <SettingsSection
        title={t('Zwei-Faktor-Authentifizierung', 'Two-factor authentication')}
        icon="shield"
        status={
          <span className={'badge ' + (!enabled ? 'neutral' : '')}>
            {enabled
              ? t('Aktiv', 'Enabled')
              : t('Nicht aktiviert', 'Not enabled')}
          </span>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void toggle(event.currentTarget);
          }}
        >
          <Field
            label={t(
              'Mit deinem Passwort bestätigen',
              'Confirm with your password',
            )}
          >
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </Field>
          <div className="actions">
            <button className="button" disabled={action.busy}>
              {enabled
                ? t('2FA deaktivieren', 'Disable 2FA')
                : t('2FA einrichten', 'Set up 2FA')}
            </button>
            {enabled && (
              <button
                type="button"
                className="button quiet"
                disabled={action.busy}
                onClick={(event) => {
                  const form = event.currentTarget.form!;
                  if (!form.reportValidity()) return;
                  const password = new FormData(form).get('password');
                  void action.run(async () => {
                    const result = await post<{ backupCodes: string[] }>(
                      '/api/auth/two-factor/generate-backup-codes',
                      { password },
                    );
                    setCodes(result.backupCodes);
                    form.reset();
                  });
                }}
              >
                {t('Neue Wiederherstellungscodes', 'New recovery codes')}
              </button>
            )}
          </div>
        </form>
        {qr && !enabled && (
          <section className="enrollment">
            <p>
              {t(
                'Scanne diesen QR-Code mit deiner Authenticator-App und bestätige den ersten Code.',
                'Scan this QR code with your authenticator app and confirm the first code.',
              )}
            </p>
            <img
              src={qr}
              width={220}
              height={220}
              alt={t('QR-Code zur 2FA-Einrichtung', 'QR code for 2FA setup')}
            />
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const code = new FormData(event.currentTarget).get('code');
                void action.run(async () => {
                  await post('/api/auth/two-factor/verify-totp', { code });
                  setQr('');
                  reload();
                });
              }}
            >
              <Field label={t('Authenticator-Code', 'Authenticator code')}>
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                />
              </Field>
              <button className="button primary" disabled={action.busy}>
                {t('2FA bestätigen', 'Confirm 2FA')}
              </button>
            </form>
          </section>
        )}
        {codes && (
          <section className="recovery-codes">
            <h3>{t('Wiederherstellungscodes', 'Recovery codes')}</h3>
            <p>
              {t(
                'Bewahre diese Codes sicher auf. Jeder Code kann genau einmal verwendet werden. Neue Codes ersetzen die bisherigen.',
                'Store these codes securely. Each code can be used once. New codes replace previous codes.',
              )}
            </p>
            <div>
              {codes.map((code) => (
                <code key={code}>{code}</code>
              ))}
            </div>
            <button className="button" onClick={() => setCodes(undefined)}>
              {t('Sicher gespeichert', 'Stored securely')}
            </button>
          </section>
        )}
      </SettingsSection>
    </>
  );
}
