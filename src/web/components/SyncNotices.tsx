import { isSyncNotice } from '../../shared/capabilities';
import { useI18n } from '../lib/i18n';
import { syncMessage, syncTitle } from '../lib/sync-messages';
import { Icon } from './Icon';

export function SyncNotices({
  codes,
  compact = false,
}: {
  codes: string[];
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (!codes.length) return null;
  const failure = codes.some((code) => !isSyncNotice(code));
  const details = (
    <ul className="sync-notice-list">
      {codes.map((code) => (
        <li key={code}>
          <strong>{syncTitle(code, t)}</strong>
          {syncTitle(code, t) !== syncMessage(code, t) && (
            <p>{syncMessage(code, t)}</p>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div className={`sync-notices ${failure ? 'failure' : ''}`}>
      {compact && !failure ? (
        <details>
          <summary>
            <Icon name={failure ? 'alert' : 'info'} />
            {failure
              ? t('Sync-Details', 'Sync details')
              : t(
                  `${codes.length} ${codes.length === 1 ? 'Hinweis' : 'Hinweise'}`,
                  `${codes.length} ${codes.length === 1 ? 'note' : 'notes'}`,
                )}
          </summary>
          {details}
        </details>
      ) : (
        details
      )}
    </div>
  );
}
