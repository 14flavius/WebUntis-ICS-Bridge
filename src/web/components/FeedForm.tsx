import { useState } from 'react';
import type { Account } from '../../shared/types';
import {
  defaultTemplates,
  type Feed,
  type FeedInput,
} from '../../shared/feeds';
import { eventKinds, type EventKind } from '../../shared/events';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { kindLabel, useI18n } from '../lib/i18n';
import { ErrorNotice, Field } from './ui';
import { TemplateEditor } from './TemplateEditor';
export function FeedForm({
  existing,
  accounts,
  onSaved,
}: {
  existing?: Feed;
  accounts: Account[];
  onSaved: () => void;
}) {
  const { t, language } = useI18n();
  const action = useAction();
  const [feed, setFeed] = useState<FeedInput>(
    () =>
      existing ?? {
        name: '',
        enabled: true,
        pastDays: 14,
        futureDays: 90,
        language,
        cancellation: 'mark',
        sources: accounts.map((account) => ({
          accountId: account.id,
          kinds: [...eventKinds],
        })),
        templates: defaultTemplates(language),
      },
  );
  const toggleKind = (
    accountId: string,
    kind: EventKind,
    selected: boolean,
  ) => {
    const source = feed.sources.find(
      (source) => source.accountId === accountId,
    );
    const kinds = new Set(source?.kinds ?? []);
    if (selected) kinds.add(kind);
    else kinds.delete(kind);
    const sources = feed.sources.filter(
      (source) => source.accountId !== accountId,
    );
    if (kinds.size) sources.push({ accountId, kinds: [...kinds] });
    setFeed({ ...feed, sources });
  };
  const submit = () =>
    action.run(async () => {
      await api('/api/feeds' + (existing ? '/' + existing.id : ''), {
        method: existing ? 'PUT' : 'POST',
        body: feed,
      });
      onSaved();
    });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ErrorNotice error={action.error} />
      <Field label={t('Feedname', 'Feed name')}>
        <input
          value={feed.name}
          onChange={(event) => setFeed({ ...feed, name: event.target.value })}
          required
          maxLength={100}
          placeholder={t('Mein Schulkalender', 'My school calendar')}
        />
      </Field>
      <section className="source-selector">
        <h3>{t('Quellen und Inhalte', 'Sources and content')}</h3>
        <p className="muted small">
          {t(
            'Wähle die gewünschten Inhalte für jedes Konto. Prüfungen erscheinen als zusätzliche Termine. Unterricht und Vertretungen bleiben auch bei ausgeblendeten Prüfungen sichtbar.',
            'Choose the content you want for each account. Exams appear as additional events. Lessons and substitutions remain visible when exams are hidden.',
          )}
        </p>
        {accounts.map((account) => (
          <fieldset key={account.id}>
            <legend>{account.name}</legend>
            <div className="checkbox-row">
              {eventKinds.map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={feed.sources.some(
                      (source) =>
                        source.accountId === account.id &&
                        source.kinds.includes(kind),
                    )}
                    onChange={(event) =>
                      toggleKind(account.id, kind, event.target.checked)
                    }
                  />
                  {kindLabel(kind, language)}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </section>
      <div className="form-grid">
        <Field label={t('Tage rückwirkend', 'Days in the past')}>
          <input
            type="number"
            min={0}
            max={365}
            value={feed.pastDays}
            onChange={(event) =>
              setFeed({ ...feed, pastDays: Number(event.target.value) })
            }
            required
          />
        </Field>
        <Field label={t('Tage in der Zukunft', 'Days ahead')}>
          <input
            type="number"
            min={1}
            max={365}
            value={feed.futureDays}
            onChange={(event) =>
              setFeed({ ...feed, futureDays: Number(event.target.value) })
            }
            required
          />
        </Field>
        <Field label={t('Ausfälle', 'Cancelled lessons')}>
          <select
            value={feed.cancellation}
            onChange={(event) =>
              setFeed({
                ...feed,
                cancellation: event.target.value as FeedInput['cancellation'],
              })
            }
          >
            <option value="mark">
              {t(
                'Als Ausfall anzeigen (empfohlen)',
                'Display as cancelled (recommended)',
              )}
            </option>
            <option value="omit">{t('Ausblenden', 'Hide')}</option>
            <option value="cancel">
              {t(
                'Kalenderstatus CANCELLED senden',
                'Send calendar CANCELLED status',
              )}
            </option>
          </select>
        </Field>
        <Field label={t('Sprache im Kalender', 'Calendar language')}>
          <select
            value={feed.language}
            onChange={(event) =>
              setFeed({
                ...feed,
                language: event.target.value as FeedInput['language'],
              })
            }
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </Field>
      </div>
      {feed.cancellation === 'cancel' && (
        <p className="notice warning">
          {t(
            'Kalender-Apps können Termine mit diesem Status vollständig entfernen.',
            'Calendar apps may completely remove events with this status.',
          )}
        </p>
      )}
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={feed.enabled}
          onChange={(event) =>
            setFeed({ ...feed, enabled: event.target.checked })
          }
        />
        {t('Feed aktiv', 'Feed enabled')}
      </label>
      <TemplateEditor feed={feed} onChange={setFeed} />
      <div className="actions end sticky-save">
        <button
          className="button primary"
          disabled={action.busy || (feed.enabled && !feed.sources.length)}
        >
          {t('Feed speichern', 'Save feed')}
        </button>
      </div>
    </form>
  );
}
