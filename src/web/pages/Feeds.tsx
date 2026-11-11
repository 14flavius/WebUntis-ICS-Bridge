import { useState } from 'react';
import type { Feed } from '../../shared/feeds';
import type { Account } from '../../shared/types';
import { api, post } from '../lib/api';
import { useAction, useResource } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import {
  ConfirmButton,
  ErrorNotice,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import { FeedForm } from '../components/FeedForm';
import { Icon } from '../components/Icon';
export function Feeds({
  revision,
  reload,
  onOpenAccounts,
}: {
  revision: number;
  reload: () => void;
  onOpenAccounts: () => void;
}) {
  const feeds = useResource<Feed[]>('/api/feeds', revision);
  const accounts = useResource<Account[]>('/api/accounts', revision);
  const { t } = useI18n();
  const action = useAction();
  const [editing, setEditing] = useState<Feed | 'new'>();
  const [copied, setCopied] = useState('');
  return (
    <>
      <PageHeader title={t('Kalenderfeeds', 'Calendar feeds')}>
        {!!feeds.data?.length && (
          <button
            className="button primary"
            disabled={!accounts.data?.length}
            onClick={() => setEditing('new')}
          >
            <Icon name="plus" /> {t('Feed erstellen', 'Create feed')}
          </button>
        )}
      </PageHeader>
      <ErrorNotice error={feeds.error || accounts.error || action.error} />
      {(!feeds.data || !accounts.data) && <Loading />}
      {feeds.data && accounts.data && !feeds.data.length && (
        <section className="card feeds-empty">
          <div className="feeds-empty-art" aria-hidden="true">
            <span className="feeds-empty-calendar">
              <Icon name="calendar" />
            </span>
            <span className="feeds-empty-link">
              <Icon name="feeds" />
            </span>
          </div>
          <h2>{t('Dein erster Kalenderfeed', 'Your first calendar feed')}</h2>
          <p>
            {accounts.data.length
              ? t(
                  'Wähle Konten und Inhalte für deinen Kalender.',
                  'Choose accounts and content for your calendar.',
                )
              : t(
                  'Verbinde zuerst ein WebUntis-Konto in der Übersicht.',
                  'Connect a WebUntis account in Overview first.',
                )}
          </p>
          {accounts.data.length ? (
            <button
              className="button primary"
              onClick={() => setEditing('new')}
            >
              <Icon name="plus" />
              {t('Feed erstellen', 'Create feed')}
            </button>
          ) : (
            <button className="button primary" onClick={onOpenAccounts}>
              <Icon name="accounts" />
              {t('Zur Übersicht', 'Go to overview')}
            </button>
          )}
        </section>
      )}
      {feeds.data && accounts.data && feeds.data.length > 0 && (
        <div className="feed-grid">
          {feeds.data.map((feed) => (
            <article className="card feed-card" key={feed.id}>
              <div className="card-header">
                <div className="feed-heading">
                  <span className="feed-icon">
                    <Icon name="calendar" />
                  </span>
                  <h2>{feed.name}</h2>
                </div>
                <span className={'badge ' + (!feed.enabled ? 'neutral' : '')}>
                  {feed.enabled
                    ? t('Aktiv', 'Active')
                    : t('Deaktiviert', 'Disabled')}
                </span>
              </div>
              <div className="feed-range">
                <Icon name="clock" />
                <span>
                  {feed.pastDays} {t('Tage zurück', 'days back')}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {feed.futureDays} {t('Tage voraus', 'days ahead')}
                </span>
              </div>
              <div className="source-tags">
                {feed.sources.map((source) => (
                  <span key={source.accountId}>
                    {accounts.data?.find(
                      (account) => account.id === source.accountId,
                    )?.name ?? t('Entferntes Konto', 'Removed account')}
                  </span>
                ))}
              </div>
              <div className="actions">
                <button
                  className="button primary"
                  disabled={!feed.enabled}
                  onClick={() =>
                    void action.run(async () => {
                      await navigator.clipboard.writeText(
                        `${location.origin}/feed/${feed.token}.ics`,
                      );
                      setCopied(feed.id);
                    })
                  }
                >
                  {copied === feed.id
                    ? t('Link kopiert ✓', 'Link copied ✓')
                    : t('ICS-Link kopieren', 'Copy ICS link')}
                </button>
                <button className="button" onClick={() => setEditing(feed)}>
                  {t('Bearbeiten & Vorschau', 'Edit & preview')}
                </button>
              </div>
              <div className="feed-footer actions">
                <button
                  className="text-button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await post(`/api/feeds/${feed.id}/duplicate`);
                      reload();
                    })
                  }
                >
                  {t('Duplizieren', 'Duplicate')}
                </button>
                <button
                  className="text-button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api(`/api/feeds/${feed.id}`, {
                        method: 'PUT',
                        body: { ...feed, enabled: !feed.enabled },
                      });
                      reload();
                    })
                  }
                >
                  {feed.enabled
                    ? t('Deaktivieren', 'Disable')
                    : t('Aktivieren', 'Enable')}
                </button>
                <ConfirmButton
                  question={t(
                    'Den bisherigen Link ungültig machen? Aktualisiere danach alle Kalenderabonnements.',
                    'Invalidate the current link? Update all calendar subscriptions afterwards.',
                  )}
                  action={async () => {
                    await post(`/api/feeds/${feed.id}/rotate`);
                    setCopied('');
                    reload();
                  }}
                >
                  {t('Link erneuern', 'Rotate link')}
                </ConfirmButton>
                <ConfirmButton
                  question={t(
                    'Diesen Feed dauerhaft entfernen?',
                    'Permanently remove this feed?',
                  )}
                  action={async () => {
                    await api(`/api/feeds/${feed.id}`, { method: 'DELETE' });
                    reload();
                  }}
                >
                  {t('Löschen', 'Delete')}
                </ConfirmButton>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && accounts.data && (
        <Modal
          title={
            editing === 'new'
              ? t('Feed erstellen', 'Create feed')
              : t('Feed bearbeiten', 'Edit feed')
          }
          onClose={() => setEditing(undefined)}
        >
          <FeedForm
            existing={editing === 'new' ? undefined : editing}
            accounts={accounts.data}
            onSaved={() => {
              setEditing(undefined);
              reload();
            }}
          />
        </Modal>
      )}
      {!!feeds.data?.length && (
        <p className="fine-print feed-privacy">
          <Icon name="lock" />
          {t(
            'Wer den ICS-Link kennt, kann den Kalender lesen.',
            'Anyone with the ICS link can read this calendar.',
          )}
        </p>
      )}
    </>
  );
}
