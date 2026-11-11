import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type ManagedUser,
  type UserRole,
} from '../../shared/auth';
import { post } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { ErrorNotice, Field } from './ui';

function PasswordField({ label }: { label: string }) {
  const { t } = useI18n();
  return (
    <Field
      label={label}
      hint={t(
        `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} Zeichen. Gib es der Person auf sicherem Weg weiter.`,
        `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters. Share it with the person over a safe channel.`,
      )}
    >
      <input
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        required
      />
    </Field>
  );
}

export function CreateUserForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const action = useAction();
  const save = (form: HTMLFormElement) =>
    action.run(async () => {
      const values = new FormData(form);
      await post('/api/admin/users', {
        username: values.get('username'),
        password: values.get('password'),
        role: values.get('role') as UserRole,
      });
      onSaved();
    });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(event.currentTarget);
      }}
    >
      <ErrorNotice error={action.error} />
      <Field
        label={t('Benutzername', 'Username')}
        hint={t(
          '3–30 Zeichen: Buchstaben, Zahlen, Punkt, Unterstrich, Bindestrich.',
          '3–30 characters: letters, numbers, dot, underscore, hyphen.',
        )}
      >
        <input
          name="username"
          autoComplete="off"
          minLength={3}
          maxLength={30}
          pattern="[a-zA-Z0-9_.\-]+"
          required
          autoFocus
        />
      </Field>
      <PasswordField label={t('Startpasswort', 'Initial password')} />
      <Field
        label={t('Rolle', 'Role')}
        hint={t(
          'Administratoren verwalten Benutzer und das Synchronisierungsintervall. Die Daten anderer Benutzer sehen sie nicht.',
          'Administrators manage users and the sync interval. They cannot see other users’ data.',
        )}
      >
        <select name="role" defaultValue="user">
          <option value="user">{t('Benutzer', 'User')}</option>
          <option value="admin">{t('Administrator', 'Administrator')}</option>
        </select>
      </Field>
      <div className="actions end">
        <button className="button primary" disabled={action.busy}>
          {t('Benutzer anlegen', 'Create user')}
        </button>
      </div>
    </form>
  );
}

export function ResetPasswordForm({
  user,
  onSaved,
}: {
  user: ManagedUser;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const action = useAction();
  const save = (form: HTMLFormElement) =>
    action.run(async () => {
      await post(`/api/admin/users/${user.id}/password`, {
        password: new FormData(form).get('password'),
      });
      onSaved();
    });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(event.currentTarget);
      }}
    >
      <ErrorNotice error={action.error} />
      <p className="muted">
        {t(
          `Setzt ein neues Passwort für „${user.username}“ und meldet alle Geräte ab.`,
          `Sets a new password for “${user.username}” and signs out all devices.`,
        )}
      </p>
      <PasswordField label={t('Neues Passwort', 'New password')} />
      <div className="actions end">
        <button className="button primary" disabled={action.busy}>
          {t('Passwort setzen', 'Set password')}
        </button>
      </div>
    </form>
  );
}
