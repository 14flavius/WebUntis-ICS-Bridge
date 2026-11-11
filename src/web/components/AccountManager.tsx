import { useState } from 'react';
import type { Account, Capability } from '../../shared/types';
import { api, post } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { AccountForm } from './AccountForm';
import { AccountCard } from './AccountCard';
import { ConnectionTest } from './ConnectionTest';
import { Modal } from './ui';
import { Icon } from './Icon';

export function AccountManager({
  accounts,
  syncing,
  reload,
}: {
  accounts: Account[];
  syncing: string[];
  reload: () => void;
}) {
  const { t } = useI18n();
  const testAction = useAction();
  const [editing, setEditing] = useState<Account | 'new'>();
  const [connection, setConnection] = useState<{
    account: Account;
    results?: Capability[];
  }>();
  const test = (account: Account) => {
    setConnection({ account });
    void testAction.run(async () => {
      const results = await post<Capability[]>(
        `/api/accounts/${account.id}/test`,
      );
      // Closing the dialog during a request must not reopen it on completion.
      setConnection((current) =>
        current?.account.id === account.id ? { account, results } : current,
      );
      reload();
    });
  };
  return (
    <>
      <section className="accounts-section">
        <header className="accounts-heading">
          <h2>
            {t('Konten', 'Accounts')}
            <span>{accounts.length}</span>
          </h2>
          {accounts.length > 0 && (
            <button
              className="button primary"
              onClick={() => setEditing('new')}
            >
              <Icon name="plus" />
              {t('Konto hinzufügen', 'Add account')}
            </button>
          )}
        </header>
        {!accounts.length ? (
          <div className="card dashboard-empty">
            <span className="empty-account-icon">
              <Icon name="accounts" />
            </span>
            <h3>
              {t('Verbinde dein erstes Konto', 'Connect your first account')}
            </h3>
            <button
              className="button primary"
              onClick={() => setEditing('new')}
            >
              <Icon name="plus" />
              {t('Konto hinzufügen', 'Add account')}
            </button>
          </div>
        ) : (
          <div className="accounts-grid">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                syncing={syncing.includes(account.id)}
                busy={testAction.busy}
                onEdit={() => setEditing(account)}
                onTest={() => test(account)}
                onRemove={async () => {
                  await api(`/api/accounts/${account.id}`, {
                    method: 'DELETE',
                  });
                  reload();
                }}
              />
            ))}
          </div>
        )}
      </section>
      {editing && (
        <Modal
          title={
            editing === 'new'
              ? t('Konto hinzufügen', 'Add account')
              : t('Konto bearbeiten', 'Edit account')
          }
          onClose={() => setEditing(undefined)}
        >
          <AccountForm
            account={editing === 'new' ? undefined : editing}
            onSaved={() => {
              setEditing(undefined);
              reload();
            }}
          />
        </Modal>
      )}
      {connection && (
        <ConnectionTest
          account={
            accounts.find((account) => account.id === connection.account.id) ??
            connection.account
          }
          results={connection.results}
          busy={testAction.busy}
          error={testAction.error}
          onClose={() => setConnection(undefined)}
          onRetry={() => test(connection.account)}
          onEdit={() => {
            setEditing(connection.account);
            setConnection(undefined);
          }}
        />
      )}
    </>
  );
}
