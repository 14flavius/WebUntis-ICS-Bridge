import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { ApiError } from '../lib/api';
import { Icon } from './Icon';

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  let text = t(
    'Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen.',
    'The request failed. Please try again.',
  );
  if (error instanceof Error && error.message === 'PASSWORD_MISMATCH')
    text = t(
      'Die Passwörter stimmen nicht überein.',
      'The passwords do not match.',
    );
  if (error instanceof ApiError) {
    if (error.status === 401)
      text = t(
        'Anmeldung fehlgeschlagen oder Sitzung abgelaufen.',
        'Sign-in failed or your session expired.',
      );
    else if (error.status === 429)
      text = t(
        'Zu viele Versuche. Bitte eine Minute warten.',
        'Too many attempts. Please wait a minute.',
      );
    else if (error.code === 'INVALID_ORIGIN')
      text = t(
        'Diese Adresse ist nicht freigegeben. Öffne die Anwendung über die konfigurierte öffentliche URL.',
        'This address is not allowed. Open the application using its configured public URL.',
      );
    else if (error.code === 'INVALID_INPUT')
      text =
        t('Bitte die Eingaben prüfen.', 'Please check your input.') +
        ' ' +
        error.details;
    else if (error.code === 'SCHOOL_SEARCH_TOO_BROAD')
      text = t(
        'Zu viele Schulen gefunden. Gib den Schulnamen genauer ein.',
        'Too many schools found. Enter a more specific school name.',
      );
    else if (error.code === 'SCHOOL_SEARCH_TIMEOUT')
      text = t(
        'Die Schulsuche dauert zu lange. Bitte erneut versuchen.',
        'School search timed out. Please try again.',
      );
    else if (error.code === 'SCHOOL_SEARCH_UNAVAILABLE')
      text = t(
        'Die WebUntis-Schulsuche ist gerade nicht erreichbar. Bitte erneut versuchen oder Schule und Server manuell eintragen.',
        'WebUntis school search is currently unavailable. Try again or enter the school and server manually.',
      );
    else if (error.code === 'SCHOOL_SEARCH_INVALID')
      text = t(
        'WebUntis hat eine unerwartete Antwort geliefert. Bitte erneut versuchen oder Schule und Server manuell eintragen.',
        'WebUntis returned an unexpected response. Try again or enter the school and server manually.',
      );
    else if (error.code === 'SELECT_SCHOOL')
      text = t(
        'Bitte eine eindeutige Schule aus der Suche auswählen.',
        'Please choose one school from the search results.',
      );
    else if (error.code === 'INVALID_SERVER')
      text = t(
        'Bitte einen HTTPS-Server unter webuntis.com verwenden.',
        'Please use an HTTPS server under webuntis.com.',
      );
    else if (error.code === 'USERNAME_TAKEN')
      text = t(
        'Dieser Benutzername ist bereits vergeben.',
        'This username is already taken.',
      );
    else if (error.code === 'LAST_ADMINISTRATOR')
      text = t(
        'Mindestens ein aktiver Administrator muss bestehen bleiben.',
        'At least one active administrator must remain.',
      );
    else if (error.code === 'CANNOT_MODIFY_SELF')
      text = t(
        'Du kannst dir die Administratorrechte nicht selbst entziehen.',
        'You cannot remove your own administrator access.',
      );
    else if (error.status === 403)
      text = t(
        'Dafür fehlt dir die Berechtigung.',
        'You do not have permission to do this.',
      );
    else if (error.code === 'SETUP_COMPLETE')
      text = t(
        'Einrichtung bereits abgeschlossen. Bitte anmelden.',
        'Setup is complete. Please sign in.',
      );
  }
  return (
    <div role="alert" className="notice error">
      {text}
    </div>
  );
}
export function Loading() {
  const { t } = useI18n();
  return (
    <p className="muted" role="status">
      {t('Wird geladen …', 'Loading …')}
    </p>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const id = useId();
  const labelControls = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (node) => {
      if (
        !isValidElement<{
          children?: ReactNode;
          'aria-labelledby'?: string;
          'aria-describedby'?: string;
        }>(node)
      )
        return node;
      if (
        typeof node.type === 'string' &&
        ['input', 'select', 'textarea'].includes(node.type)
      )
        return cloneElement(node, {
          'aria-labelledby': id,
          'aria-describedby': hint ? id + '-hint' : undefined,
        });
      if (node.type === 'div')
        return cloneElement(node, {}, labelControls(node.props.children));
      return node;
    });
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {labelControls(children)}
      {hint && <small id={id + '-hint'}>{hint}</small>}
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { t } = useI18n();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      className={className}
      ref={ref}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="modal-header">
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label={t('Schließen', 'Close')}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function ConfirmButton({
  children,
  question,
  action,
  disabled = false,
  title,
}: {
  children: ReactNode;
  question: string;
  action: () => Promise<void>;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const { t } = useI18n();
  const confirm = async () => {
    setBusy(true);
    try {
      await action();
      setOpen(false);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="button quiet danger"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open && (
        <Modal
          className="confirmation-dialog"
          title={title ?? t('Bitte bestätigen', 'Please confirm')}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div className="confirmation-content">
            <span className="confirmation-icon">
              <Icon name="alert" />
            </span>
            <p>{question}</p>
          </div>
          <ErrorNotice error={error} />
          <div className="actions end">
            <button
              className="button"
              autoFocus
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t('Abbrechen', 'Cancel')}
            </button>
            <button
              className="button destructive"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {t('Bestätigen', 'Confirm')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}
