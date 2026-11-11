import type { Account } from '../../shared/types';
import { isSyncNotice, visibleSyncIssues } from '../../shared/capabilities';
import { SyncNotices } from './SyncNotices';
import { dateLabel, useI18n } from '../lib/i18n';
import { ConfirmButton } from './ui';
import { Icon } from './Icon';

export function AccountCard({
  account,
  syncing,
  busy,
  onEdit,
  onTest,
  onRemove,
}: {
  account: Account;
  syncing: boolean;
  busy: boolean;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  let status = t('Gespeichert', 'Saved');
  let tone = 'neutral';
  const codes = visibleSyncIssues(account.error);
  const hasFailure = codes.some((code) => !isSyncNotice(code));
  if (syncing) status = t('Synchronisiert …', 'Syncing …');
  else if (hasFailure) {
    status = t('Sync fehlgeschlagen', 'Sync failed');
    tone = 'warning';
  } else if (codes.length) {
    status = account.lastSuccess
      ? t('Synchronisiert · mit Hinweisen', 'Synced · with notes')
      : t('Mit Hinweisen', 'With notes');
  } else if (account.lastSuccess) {
    status = t('Synchronisiert', 'Synced');
    tone = '';
  }
  return (
    <article className="card account-card">
      <header className="account-card-header">
        <span className="account-avatar" aria-hidden="true">
          {account.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="account-card-name">
          <h3>{account.name}</h3>
          <span>{account.username}</span>
        </div>
        <span className={`badge ${tone}`}>{status}</span>
      </header>
      <div className="account-details">
        <p>
          <Icon name="calendar" />
          <span>
            {t('Prüfungen: ', 'Exams: ')}
            {account.examSource === 'timetable'
              ? t('Stundenplan', 'Timetable')
              : t(
                  'Prüfungs-Tab, sonst Stundenplan',
                  'Exams tab, otherwise timetable',
                )}
          </span>
        </p>
        <p>
          <Icon name="school" />
          <span>{account.school}</span>
        </p>
        <p>
          <Icon name="clock" />
          <span>
            {t('Letzter Sync: ', 'Last sync: ')}
            {dateLabel(account.lastSuccess, language)}
          </span>
        </p>
      </div>
      <SyncNotices codes={codes} compact />
      <div className="account-card-actions">
        <div className="actions">
          <button className="button" onClick={onEdit}>
            {t('Bearbeiten', 'Edit')}
          </button>
          <button
            className="button"
            disabled={busy || syncing}
            onClick={onTest}
          >
            {t('Verbindung testen', 'Test connection')}
          </button>
        </div>
        <div className="account-card-footer actions">
          <ConfirmButton
            title={t('Konto entfernen', 'Remove account')}
            disabled={syncing}
            question={t(
              `„${account.name}“ und die gespeicherten Termine entfernen? Das Konto wird auch aus deinen Feeds entfernt.`,
              `Remove “${account.name}” and its stored events? The account will also be removed from your feeds.`,
            )}
            action={onRemove}
          >
            {t('Entfernen', 'Remove')}
          </ConfirmButton>
        </div>
      </div>
    </article>
  );
}
