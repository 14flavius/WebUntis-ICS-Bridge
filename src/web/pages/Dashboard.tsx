import { useEffect, useState } from 'react';
import type { Account } from '../../shared/types';
import { useResource, useAction } from '../lib/hooks';
import { post } from '../lib/api';
import { dateLabel, useI18n } from '../lib/i18n';
import { ErrorNotice, Loading, PageHeader } from '../components/ui';
import { Icon } from '../components/Icon';
import { AccountManager } from '../components/AccountManager';
interface Status {
  accounts: Account[];
  activeFeeds: number;
  events: number;
  syncing: string[];
}
export function Dashboard({
  revision,
  reload,
}: {
  revision: number;
  reload: () => void;
}) {
  const [pollRevision, setPollRevision] = useState(0);
  const { data, error } = useResource<Status>(
    '/api/status',
    revision + pollRevision,
  );
  const action = useAction();
  const { t, language } = useI18n();
  useEffect(() => {
    if (error || (!data?.syncing.length && !action.busy)) return;
    // Poll only status; a global reload also repeats setup/session requests.
    const timer = window.setTimeout(
      () => setPollRevision((value) => value + 1),
      2000,
    );
    return () => window.clearTimeout(timer);
  }, [data, error, action.busy]);
  const sync = () =>
    action.run(async () => {
      await post('/api/sync');
      reload();
    });
  const last =
    data?.accounts
      .map((account) => account.lastSuccess)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
  return (
    <>
      <PageHeader title={t('Übersicht', 'Overview')}>
        <button
          className="button primary"
          disabled={
            action.busy || !!data?.syncing.length || !data?.accounts.length
          }
          onClick={() => void sync()}
        >
          <Icon name="sync" />
          {action.busy || !!data?.syncing.length
            ? t('Synchronisiert …', 'Syncing …')
            : t('Alle synchronisieren', 'Sync all accounts')}
        </button>
      </PageHeader>
      <ErrorNotice error={error || action.error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="metrics">
            <div className="metric metric-accounts">
              <span className="metric-icon">
                <Icon name="accounts" />
              </span>
              <span>{t('WebUntis-Konten', 'WebUntis accounts')}</span>
              <strong>{data.accounts.length}</strong>
            </div>
            <div className="metric metric-feeds">
              <span className="metric-icon">
                <Icon name="feeds" />
              </span>
              <span>{t('Aktive Feeds', 'Active feeds')}</span>
              <strong>{data.activeFeeds}</strong>
            </div>
            <div className="metric metric-events">
              <span className="metric-icon">
                <Icon name="calendar" />
              </span>
              <span>{t('Gespeicherte Termine', 'Stored events')}</span>
              <strong>{data.events}</strong>
            </div>
          </div>
          <p className="sync-status muted">
            <Icon name="clock" />
            {data.syncing.length
              ? t('Synchronisierung läuft …', 'Syncing …')
              : t('Letzte Synchronisierung: ', 'Last sync: ') +
                dateLabel(last, language)}
          </p>
          <AccountManager
            accounts={data.accounts}
            syncing={data.syncing}
            reload={reload}
          />
        </>
      )}
    </>
  );
}
