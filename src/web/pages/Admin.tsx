import { useState } from 'react';
import type { ManagedUser, UpdateUserInput } from '../../shared/auth';
import { api, post } from '../lib/api';
import { useAction, useResource } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { ErrorNotice, Loading, Modal, PageHeader } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserCard } from '../components/UserCard';
import { CreateUserForm, ResetPasswordForm } from '../components/UserForms';

export function Admin({ currentUserId }: { currentUserId: string }) {
  const { t } = useI18n();
  const [revision, setRevision] = useState(0);
  const { data, error } = useResource<ManagedUser[]>(
    '/api/admin/users',
    revision,
  );
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [passwordFor, setPasswordFor] = useState<ManagedUser>();
  const refresh = () => setRevision((value) => value + 1);
  const update = (user: ManagedUser, change: UpdateUserInput) =>
    action.run(async () => {
      await api(`/api/admin/users/${user.id}`, { method: 'PUT', body: change });
      refresh();
    });
  return (
    <>
      <PageHeader title={t('Verwaltung', 'Administration')}>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          {t('Benutzer anlegen', 'Create user')}
        </button>
      </PageHeader>
      <p className="muted admin-intro">
        {t(
          'Jeder Benutzer hat eigene WebUntis-Konten und Feeds. Administratoren verwalten Zugänge, sehen aber keine Daten anderer Benutzer.',
          'Every user has their own WebUntis accounts and feeds. Administrators manage access but cannot see other users’ data.',
        )}
      </p>
      <ErrorNotice error={error || action.error} />
      {!data ? (
        <Loading />
      ) : (
        <section className="accounts-section">
          <header className="accounts-heading">
            <h2>
              {t('Benutzer', 'Users')}
              <span>{data.length}</span>
            </h2>
          </header>
          <div className="accounts-grid">
            {data.map((user) => (
              <UserCard
                key={user.id}
                user={user}
                isSelf={user.id === currentUserId}
                busy={action.busy}
                onRole={(role) => void update(user, { role })}
                onDisabled={(disabled) => void update(user, { disabled })}
                onResetPassword={() => setPasswordFor(user)}
                onResetTwoFactor={async () => {
                  await post(`/api/admin/users/${user.id}/two-factor/reset`);
                  refresh();
                }}
                onDelete={async () => {
                  await api(`/api/admin/users/${user.id}`, {
                    method: 'DELETE',
                  });
                  refresh();
                }}
              />
            ))}
          </div>
        </section>
      )}
      {creating && (
        <Modal
          title={t('Benutzer anlegen', 'Create user')}
          onClose={() => setCreating(false)}
        >
          <CreateUserForm
            onSaved={() => {
              setCreating(false);
              refresh();
            }}
          />
        </Modal>
      )}
      {passwordFor && (
        <Modal
          title={t('Passwort setzen', 'Set password')}
          onClose={() => setPasswordFor(undefined)}
        >
          <ResetPasswordForm
            user={passwordFor}
            onSaved={() => {
              setPasswordFor(undefined);
              refresh();
            }}
          />
        </Modal>
      )}
    </>
  );
}
