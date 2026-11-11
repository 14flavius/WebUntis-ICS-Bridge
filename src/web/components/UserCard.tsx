import type { ManagedUser, UserRole } from '../../shared/auth';
import { useI18n } from '../lib/i18n';
import { ConfirmButton } from './ui';
import { Icon } from './Icon';

export function UserCard({
  user,
  isSelf,
  busy,
  onRole,
  onDisabled,
  onResetPassword,
  onResetTwoFactor,
  onDelete,
}: {
  user: ManagedUser;
  isSelf: boolean;
  busy: boolean;
  onRole: (role: UserRole) => void;
  onDisabled: (disabled: boolean) => void;
  onResetPassword: () => void;
  onResetTwoFactor: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const created = new Date(user.createdAt).toLocaleDateString(language, {
    dateStyle: 'medium',
  });
  return (
    <article className="card account-card user-card">
      <header className="account-card-header">
        <span className="account-avatar" aria-hidden="true">
          {user.username.slice(0, 1).toUpperCase()}
        </span>
        <div className="account-card-name">
          <h3>{user.username}</h3>
          <span>
            {isSelf
              ? t('Das bist du', 'This is you')
              : t(`Seit ${created}`, `Since ${created}`)}
          </span>
        </div>
        <span className={`badge ${user.disabled ? 'warning' : ''}`}>
          {user.disabled ? t('Deaktiviert', 'Disabled') : t('Aktiv', 'Active')}
        </span>
      </header>
      <div className="account-details">
        <p>
          <Icon name="accounts" />
          <span>
            {t(
              `${user.accounts} WebUntis-Konten · ${user.feeds} Feeds`,
              `${user.accounts} WebUntis accounts · ${user.feeds} feeds`,
            )}
          </span>
        </p>
        <p>
          <Icon name="shield" />
          <span>
            {user.twoFactorEnabled
              ? t('Zwei-Faktor aktiv', 'Two-factor enabled')
              : t('Zwei-Faktor nicht aktiv', 'Two-factor not enabled')}
          </span>
        </p>
      </div>
      <label className="field user-role">
        <span>{t('Rolle', 'Role')}</span>
        <select
          value={user.role}
          disabled={busy || isSelf}
          onChange={(event) => onRole(event.target.value as UserRole)}
        >
          <option value="user">{t('Benutzer', 'User')}</option>
          <option value="admin">{t('Administrator', 'Administrator')}</option>
        </select>
      </label>
      {!isSelf && (
        <div className="account-card-actions">
          <div className="actions">
            <button
              className="button"
              disabled={busy}
              onClick={onResetPassword}
            >
              {t('Passwort setzen', 'Set password')}
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => onDisabled(!user.disabled)}
            >
              {user.disabled
                ? t('Aktivieren', 'Enable')
                : t('Deaktivieren', 'Disable')}
            </button>
          </div>
          <div className="account-card-footer actions">
            {user.twoFactorEnabled && (
              <ConfirmButton
                title={t('Zwei-Faktor zurücksetzen', 'Reset two-factor')}
                question={t(
                  `Zwei-Faktor-Anmeldung für „${user.username}“ entfernen? Die Person wird abgemeldet und kann sie danach neu einrichten.`,
                  `Remove two-factor sign-in for “${user.username}”? The person is signed out and can set it up again afterwards.`,
                )}
                action={onResetTwoFactor}
              >
                {t('2FA zurücksetzen', 'Reset 2FA')}
              </ConfirmButton>
            )}
            <ConfirmButton
              title={t('Benutzer löschen', 'Delete user')}
              question={t(
                `„${user.username}“ endgültig löschen? Alle WebUntis-Konten, Termine und Feeds dieser Person werden entfernt und ihre Kalender-Links funktionieren nicht mehr.`,
                `Permanently delete “${user.username}”? All of this person’s WebUntis accounts, events and feeds are removed and their calendar links stop working.`,
              )}
              action={onDelete}
            >
              {t('Löschen', 'Delete')}
            </ConfirmButton>
          </div>
        </div>
      )}
    </article>
  );
}
