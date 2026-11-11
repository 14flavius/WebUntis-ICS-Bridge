import { useEffect, useState } from 'react';
import type { SetupStatus } from '../../shared/auth';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../shared/auth';
import { useI18n } from '../lib/i18n';
import { useAction } from '../lib/hooks';
import { ApiError, post } from '../lib/api';
import { ErrorNotice, Field } from '../components/ui';
import { SiteFooter } from '../components/SiteFooter';
import { Brand } from '../components/Brand';
export function AuthPage({
  setup,
  onLogin,
}: {
  setup: SetupStatus;
  onLogin: () => void;
}) {
  const { t, language, setLanguage } = useI18n();
  const action = useAction();
  const [step, setStep] = useState<'setup' | 'login' | 'totp'>(
    setup.required ? 'setup' : 'login',
  );
  const [recovery, setRecovery] = useState(false);
  const [expired, setExpired] = useState(setup.expired);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const validLength =
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH;
  const passwordsMatch = password === confirmation;
  const confirmationMismatch = confirmation.length > 0 && !passwordsMatch;
  useEffect(() => {
    if (step !== 'setup' || expired) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      setup.remainingSeconds * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [step, expired, setup.remainingSeconds]);
  const submit = (form: HTMLFormElement) =>
    action.run(async () => {
      const data = new FormData(form);
      if (step === 'totp') {
        await post(
          '/api/auth/two-factor/' +
            (recovery ? 'verify-backup-code' : 'verify-totp'),
          { code: data.get('code') },
        );
        onLogin();
        return;
      }
      const credentials = {
        username: data.get('username'),
        password: data.get('password'),
      };
      if (step === 'setup') {
        if (data.get('password') !== data.get('confirm'))
          throw new Error('PASSWORD_MISMATCH');
        try {
          await post('/api/setup', credentials);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'SETUP_EXPIRED')
            setExpired(true);
          throw error;
        }
        setStep('login');
        setPassword('');
        setConfirmation('');
        form.reset();
        return;
      }
      const result = await post<{ twoFactorRedirect?: boolean }>(
        '/api/auth/sign-in/username',
        credentials,
      );
      if (result.twoFactorRedirect) setStep('totp');
      else onLogin();
    });
  let title = t('Willkommen zurück', 'Welcome back');
  let subtitle = t('Melde dich an.', 'Sign in to your account.');
  if (step === 'setup') {
    title = t('Willkommen', 'Welcome');
    subtitle = t(
      'Richte deinen Administrator ein.',
      'Create your administrator account.',
    );
  }
  if (step === 'setup' && expired)
    title = t('Einrichtung gesperrt.', 'Setup is locked.');
  if (step === 'totp') title = t('Bestätigungscode', 'Verification code');
  let submitLabel = t('Anmelden', 'Sign in');
  if (step === 'setup')
    submitLabel = t('Administrator erstellen', 'Create administrator');
  if (step === 'totp') submitLabel = t('Bestätigen', 'Verify');
  return (
    <main className="auth-layout">
      <header className="auth-header">
        <Brand />
        <button
          className="button quiet"
          onClick={() => setLanguage(language === 'de' ? 'en' : 'de')}
        >
          {language === 'de' ? 'English' : 'Deutsch'}
        </button>
      </header>
      <section className="auth-panel">
        <div className="auth-form">
          <div className="auth-form-header">
            <h1>{title}</h1>
            {step !== 'totp' && !expired && <p>{subtitle}</p>}
          </div>
          {step === 'setup' && expired ? (
            <section className="notice warning" role="alert">
              <p>
                {t(
                  'Die zwei Stunden sind abgelaufen. Container oder Anwendung neu starten, um die Einrichtung freizugeben.',
                  'The two-hour window has expired. Restart the container or application to enable setup.',
                )}
              </p>
              <button className="button" onClick={onLogin}>
                {t('Status erneut prüfen', 'Check status again')}
              </button>
            </section>
          ) : (
            <>
              <ErrorNotice error={action.error} />
              {/* Keyed by step: without it React reuses the username
                  input's DOM node for the code field, so the typed username
                  stays in it and password managers keep treating it as the
                  username field they already classified. */}
              <form
                key={step}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(event.currentTarget);
                }}
              >
                {step === 'totp' ? (
                  <>
                    <Field
                      key={recovery ? 'recovery' : 'authenticator'}
                      label={
                        recovery
                          ? t('Wiederherstellungscode', 'Recovery code')
                          : t('Authenticator-Code', 'Authenticator code')
                      }
                    >
                      {/* Password managers otherwise treat a single text
                          field as a username input; the vendor flags opt the
                          one-time-code field out of their credential
                          autofill. */}
                      <input
                        type="text"
                        name="code"
                        required
                        autoComplete="one-time-code"
                        inputMode={recovery ? 'text' : 'numeric'}
                        autoFocus
                        data-1p-ignore
                        data-bwignore
                        data-lpignore="true"
                        data-form-type="other"
                      />
                    </Field>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setRecovery(!recovery)}
                    >
                      {recovery
                        ? t('Authenticator verwenden', 'Use authenticator')
                        : t(
                            'Wiederherstellungscode verwenden',
                            'Use recovery code',
                          )}
                    </button>
                  </>
                ) : (
                  <>
                    <Field
                      label={t('Benutzername', 'Username')}
                      hint={
                        step === 'setup'
                          ? t(
                              '3–30 Zeichen: a–z, 0–9, . _ -',
                              '3–30 characters: a–z, 0–9, . _ -',
                            )
                          : undefined
                      }
                    >
                      <input
                        type="text"
                        name="username"
                        required
                        minLength={3}
                        maxLength={30}
                        pattern="[a-zA-Z0-9_.\-]+"
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        placeholder="admin"
                      />
                    </Field>
                    <Field
                      label={t('Passwort', 'Password')}
                      hint={
                        step === 'setup' && (
                          <span
                            className={
                              validLength ? 'validation-success' : undefined
                            }
                          >
                            {PASSWORD_MIN_LENGTH}–{PASSWORD_MAX_LENGTH}{' '}
                            {t('Zeichen', 'characters')}
                            {' · '}
                            {password.length}/{PASSWORD_MAX_LENGTH}
                          </span>
                        )
                      }
                    >
                      <input
                        type="password"
                        name="password"
                        required
                        minLength={step === 'setup' ? PASSWORD_MIN_LENGTH : 1}
                        maxLength={PASSWORD_MAX_LENGTH}
                        value={password}
                        onChange={(event) =>
                          setPassword(event.currentTarget.value)
                        }
                        aria-invalid={
                          step === 'setup' &&
                          password.length > 0 &&
                          !validLength
                        }
                        autoComplete={
                          step === 'setup' ? 'new-password' : 'current-password'
                        }
                      />
                    </Field>
                    {step === 'setup' && (
                      <Field
                        label={t('Passwort bestätigen', 'Confirm password')}
                        hint={
                          <span
                            role="status"
                            className={
                              confirmationMismatch
                                ? 'validation-error'
                                : 'validation-success'
                            }
                          >
                            {confirmation.length > 0 &&
                              (passwordsMatch
                                ? t(
                                    'Passwörter stimmen überein.',
                                    'Passwords match.',
                                  )
                                : t(
                                    'Passwörter stimmen nicht überein.',
                                    'Passwords do not match.',
                                  ))}
                          </span>
                        }
                      >
                        <input
                          type="password"
                          name="confirm"
                          required
                          minLength={PASSWORD_MIN_LENGTH}
                          maxLength={PASSWORD_MAX_LENGTH}
                          value={confirmation}
                          onChange={(event) =>
                            setConfirmation(event.currentTarget.value)
                          }
                          aria-invalid={confirmationMismatch}
                          autoComplete="new-password"
                        />
                      </Field>
                    )}
                  </>
                )}
                <button
                  className="button primary full"
                  disabled={
                    action.busy ||
                    (step === 'setup' && (!validLength || !passwordsMatch))
                  }
                >
                  {action.busy
                    ? t('Bitte warten …', 'Please wait …')
                    : submitLabel}
                </button>
              </form>
            </>
          )}
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
