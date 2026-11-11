import type { Account, Capability, CapabilityStatus } from '../../shared/types';
import {
  isCapabilityFailure,
  isOptionalExamUnavailable,
  visibleSyncIssues,
} from '../../shared/capabilities';
import { dateLabel, useI18n } from '../lib/i18n';
import { Icon, type IconName } from './Icon';
import { ErrorNotice, Modal } from './ui';
import { SyncNotices } from './SyncNotices';
import { syncMessage } from '../lib/sync-messages';

export function ConnectionTest({
  account,
  results,
  busy,
  error,
  onRetry,
  onEdit,
  onClose,
}: {
  account: Pick<Account, 'name' | 'school'> &
    Partial<Pick<Account, 'error' | 'lastAttempt' | 'lastSuccess'>>;
  results?: Capability[];
  busy: boolean;
  error: unknown;
  onRetry: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const labels: Record<CapabilityStatus, string> = {
    success: t('Erfolgreich', 'Successful'),
    empty: t('Keine Daten', 'No data'),
    limited: t('Mit Hinweisen', 'With notes'),
    forbidden: t('Berechtigung fehlt', 'Permission denied'),
    unavailable: t('Nicht verfügbar', 'Unavailable'),
    authentication: t('Anmeldung abgelehnt', 'Sign-in rejected'),
    server: t('Server nicht erreichbar', 'Server unavailable'),
    invalid: t('Unerwartete Antwort', 'Unexpected response'),
  };
  const checks: Record<string, { name: string; icon: IconName }> = {
    server: { name: t('Webserver', 'Web server'), icon: 'system' },
    login: { name: t('Anmeldung', 'Sign-in'), icon: 'lock' },
    timetable: { name: t('Stundenplan', 'Timetable'), icon: 'calendar' },
    exams: {
      name: t('Prüfungen (separater Abruf)', 'Exams (separate endpoint)'),
      icon: 'calendar',
    },
    holidays: { name: t('Ferien', 'Holidays'), icon: 'calendar' },
    schoolyears: { name: t('Schuljahre', 'School years'), icon: 'school' },
  };
  const descriptions: Record<CapabilityStatus, string> = {
    success: '',
    limited: '',
    empty: t(
      'Abruf erfolgreich, aktuell keine Einträge.',
      'Request successful; no entries available.',
    ),
    forbidden: t(
      'WebUntis erlaubt diesem Konto den Zugriff nicht.',
      'WebUntis does not allow access for this account.',
    ),
    unavailable: t(
      'Diese Schnittstelle ist bei deiner Schule nicht verfügbar.',
      'This endpoint is unavailable at your school.',
    ),
    authentication: t(
      'Bitte prüfe deine Zugangsdaten und melde dich direkt bei WebUntis an.',
      'Check your credentials and try signing in directly to WebUntis.',
    ),
    server: t('Bitte versuche es später erneut.', 'Please try again later.'),
    invalid: t(
      'Die WebUntis-Antwort konnte nicht gelesen werden.',
      'The WebUntis response could not be read.',
    ),
  };
  const reasonMessages: Record<NonNullable<Capability['reason']>, string> = {
    invalid_credentials: t(
      'Benutzername oder Passwort falsch.',
      'Incorrect username or password.',
    ),
    invalid_school: t(
      'Schule nicht gefunden. Bitte prüfe Schule und Server.',
      'School not found. Check the school and server.',
    ),
    unsupported_account: t(
      'Bitte verwende ein Schülerkonto.',
      'Please use a student account.',
    ),
  };
  const failure = results?.find(isCapabilityFailure);
  const visibleResults = results?.filter((result) => result.name in checks);
  const loginFailure = results?.find(
    (result) => result.name === 'login' && result.status !== 'success',
  );
  const loginFailed = !!loginFailure;
  const missingChecks = results
    ? Object.keys(checks).filter(
        (name) => !results.some((result) => result.name === name),
      )
    : [];
  const syncCodes = visibleSyncIssues(account.error);
  const hasNotes =
    syncCodes.length > 0 ||
    results?.some((result) => result.status === 'limited');
  const range = results?.find((result) => result.name === 'timetable')?.range;
  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString(language, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  let tone = hasNotes ? 'notes' : 'passed';
  if (failure || error) tone = 'failed';
  let statusIcon: IconName = 'check';
  if (busy) statusIcon = 'clock';
  else if (failure || error) statusIcon = 'alert';
  else if (hasNotes) statusIcon = 'info';
  let title = t('Verbindung erfolgreich', 'Connection successful');
  if (hasNotes)
    title = t('Verbindung steht · mit Hinweisen', 'Connected · with notes');
  if (busy) title = t('Verbindung wird geprüft …', 'Testing connection …');
  else if (error)
    title = t('Test nicht abgeschlossen', 'Test could not be completed');
  else if (failure?.name === 'server')
    title = t('Webserver nicht erreichbar', 'Web server unreachable');
  else if (loginFailed) title = t('Anmeldung fehlgeschlagen', 'Sign-in failed');
  else if (failure)
    title = t('Verbindung eingeschränkt', 'Connection partially available');

  return (
    <Modal
      title={t('Verbindungstest', 'Connection test')}
      className="connection-dialog"
      onClose={onClose}
    >
      <div className="connection-account">
        <span className="school-option-icon">
          <Icon name="school" />
        </span>
        <div>
          <strong>{account.name}</strong>
          <span>{account.school}</span>
        </div>
      </div>
      <div
        className={`connection-summary ${busy ? 'pending' : tone}`}
        role="status"
        aria-live="polite"
      >
        <span className="connection-status-icon">
          <Icon name={statusIcon} />
        </span>
        <div>
          <h3>{title}</h3>
          {loginFailure && (
            <p>
              {loginFailure.reason
                ? reasonMessages[loginFailure.reason]
                : descriptions[loginFailure.status]}
            </p>
          )}
        </div>
      </div>
      <p className="connection-scope">
        <strong>
          {t(
            'Stundenplan & Prüfungen: aktuelle Woche',
            'Timetable & exams: current week',
          )}
        </strong>
        {range && (
          <span>
            {formatDate(range.start)} – {formatDate(range.end)}
          </span>
        )}
        <span>
          {t(
            'Stichprobe ohne Synchronisierung. Der letzte Sync-Status bleibt bestehen.',
            'Sample check without synchronization. The last sync status is unchanged.',
          )}
        </span>
      </p>
      <ErrorNotice error={error} />
      {!busy && results && (
        <ul className="connection-checks">
          {visibleResults?.map((result) => {
            const check = checks[result.name];
            const passed = ['success', 'empty'].includes(result.status);
            const optional = isOptionalExamUnavailable(result);
            const limited = result.status === 'limited';
            let resultTone = passed ? 'passed' : 'failed';
            let resultIcon: IconName = passed ? 'check' : 'alert';
            if (optional || limited) {
              resultTone = '';
              resultIcon = 'info';
            }
            let description = result.reason
              ? reasonMessages[result.reason]
              : descriptions[result.status];
            if (result.code && !result.reason)
              description = syncMessage(result.code, t);
            if (result.name === 'login' && loginFailed) description = '';
            if (optional)
              description =
                labels[result.status] +
                '. ' +
                t(
                  'Der separate Prüfungsabruf ist optional. Prüfungen im Stundenplan werden weiterhin übernommen.',
                  'Separate exam access is optional. Exams in the timetable are still imported.',
                );
            let label = labels[result.status];
            if (optional) label = t('Optional · in Ordnung', 'Optional · okay');
            else if (result.name === 'server' && passed)
              label = t('Erreichbar', 'Reachable');
            return (
              <li key={result.name}>
                <Icon name={check?.icon ?? 'system'} />
                <div className="connection-check-detail">
                  <strong>{check?.name ?? result.name}</strong>
                  {description && <p>{description}</p>}
                  {result.warnings?.map((code) => (
                    <p key={code}>{syncMessage(code, t)}</p>
                  ))}
                </div>
                <span className={`connection-result ${resultTone}`}>
                  <Icon name={resultIcon} />
                  {label}
                </span>
              </li>
            );
          })}
          {missingChecks.map((name) => (
            <li key={name} className="connection-skipped">
              <Icon name={checks[name].icon} />
              <div className="connection-check-detail">
                <strong>{checks[name].name}</strong>
              </div>
              <span className="connection-result">
                <Icon name="minus" />
                {t('Nicht geprüft', 'Not checked')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {account.lastAttempt && (
        <section className="connection-sync-history">
          <h3>{t('Letzte Synchronisierung', 'Last synchronization')}</h3>
          <p className="muted small">
            {dateLabel(account.lastAttempt, language)}
          </p>
          {syncCodes.length ? (
            <SyncNotices codes={syncCodes} />
          ) : (
            <p className="muted small">
              {t('Keine gespeicherten Hinweise.', 'No stored notes.')}
            </p>
          )}
        </section>
      )}
      <div className="actions end">
        <button className="button" disabled={busy} onClick={onRetry}>
          <Icon name="sync" />
          {t('Erneut testen', 'Test again')}
        </button>
        {loginFailed && (
          <button className="button primary" onClick={onEdit}>
            {t('Zugangsdaten bearbeiten', 'Edit credentials')}
          </button>
        )}
      </div>
    </Modal>
  );
}
