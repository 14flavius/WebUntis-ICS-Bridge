import { useEffect, useRef, useState } from 'react';
import type { FeedInput } from '../../shared/feeds';
import {
  defaultTemplates,
  feedInput,
  PREVIEW_EVENTS_PER_KIND,
} from '../../shared/feeds';
import {
  eventKinds,
  variables,
  nameFields,
  nameVariants,
  type NameField,
  type EventKind,
} from '../../shared/events';
import { templateError } from '../../shared/templates';
import { kindLabel, useI18n } from '../lib/i18n';
import { api } from '../lib/api';
import { eventDateLabel } from '../lib/event-dates';
import { ErrorNotice, Field } from './ui';
interface Preview {
  sourceId: string;
  accountId: string;
  kind: EventKind;
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  description: string;
  location: string;
}
export function TemplateEditor({
  feed,
  onChange,
}: {
  feed: FeedInput;
  onChange: (feed: FeedInput) => void;
}) {
  const { t, language } = useI18n();
  const [kind, setKind] = useState<EventKind>('lesson');
  const [field, setField] = useState<'title' | 'description' | 'location'>(
    'title',
  );
  const [preview, setPreview] = useState<Preview[]>();
  const [error, setError] = useState<unknown>();
  const [variableGroup, setVariableGroup] = useState<NameField | 'other'>(
    'subject',
  );
  const refs = useRef<
    Partial<Record<typeof field, HTMLTextAreaElement | null>>
  >({});
  const serialized = JSON.stringify({
    ...feed,
    // Renaming the calendar cannot change any event's rendered fields.
    name: 'Preview',
  });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const input = feedInput.safeParse(JSON.parse(serialized) as unknown);
      if (!input.success) {
        setPreview([]);
        setError(undefined);
        return;
      }
      api<Preview[]>('/api/preview', {
        method: 'POST',
        body: input.data,
        signal: controller.signal,
      })
        .then((data) => {
          setPreview(data);
          setError(undefined);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [serialized]);
  const update = (key: typeof field, value: string) =>
    onChange({
      ...feed,
      templates: {
        ...feed.templates,
        [kind]: { ...feed.templates[kind], [key]: value },
      },
    });
  const insert = (variable: string) => {
    const input = refs.current[field];
    const value = feed.templates[kind][field];
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const token = '{{' + variable + '}}';
    update(field, value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const fields = {
    title: t('Titel', 'Title'),
    description: t('Notizen', 'Notes'),
    location: t('Standort', 'Location'),
  };
  const fieldHints = {
    title: t(
      '{{subjectShort | teacherShort}} verbindet vorhandene Angaben mit ·. [[({{classShort}})]] ergänzt die Klasse in Klammern.',
      '{{subjectShort | teacherShort}} joins available names with ·. [[({{classShort}})]] adds the class in parentheses.',
    ),
    description: undefined,
    location: t(
      'Erscheint als Standort im Kalender. Freier Text und Variablen sind möglich, z. B. Raum {{roomShort}} · Hauptgebäude.',
      'Appears as the calendar location. Combine text and variables, e.g. Room {{roomShort}} · Main building.',
    ),
  };
  const groupLabels = {
    subject: t('Fach', 'Subject'),
    teacher: t('Lehrkraft', 'Teacher'),
    class: t('Klasse', 'Class'),
    room: t('Raum', 'Room'),
    originalTeacher: t('Ursprüngliche Lehrkraft', 'Original teacher'),
    substituteTeacher: t('Vertretungslehrkraft', 'Substitute teacher'),
    other: t('Weitere Angaben', 'Other details'),
  };
  const shownVariables =
    variableGroup === 'other'
      ? variables.filter(
          (variable) =>
            !nameFields.some(
              (name) =>
                variable === name ||
                nameVariants.some(
                  (variant) => variable === `${name}${variant}`,
                ),
            ),
        )
      : [
          variableGroup,
          ...nameVariants.map((variant) => `${variableGroup}${variant}`),
        ];
  const shown = preview
    ?.filter((event) => event.kind === kind)
    .slice(0, PREVIEW_EVENTS_PER_KIND);
  return (
    <section className="template-editor">
      <div className="card-header">
        <div>
          <h3>{t('Termindarstellung', 'Event appearance')}</h3>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onChange({ ...feed, templates: defaultTemplates(feed.language) })
          }
        >
          {t('Standardvorlagen einsetzen', 'Restore defaults')}
        </button>
      </div>
      <div
        className="tabs"
        role="tablist"
        aria-label={t('Termintyp', 'Event type')}
      >
        {eventKinds.map((type) => (
          <button
            type="button"
            key={type}
            role="tab"
            aria-selected={type === kind}
            className={type === kind ? 'selected' : ''}
            onClick={() => setKind(type)}
          >
            {kindLabel(type, language)}
          </button>
        ))}
      </div>
      {(Object.keys(fields) as (keyof typeof fields)[]).map((key) => (
        <Field
          key={key}
          label={fields[key]}
          hint={templateError(feed.templates[kind][key]) ?? fieldHints[key]}
        >
          <textarea
            ref={(node) => {
              refs.current[key] = node;
            }}
            value={feed.templates[kind][key]}
            onFocus={() => setField(key)}
            onChange={(event) => update(key, event.target.value)}
            rows={key === 'description' ? 3 : 1}
            maxLength={key === 'description' ? 10000 : 2000}
            aria-invalid={!!templateError(feed.templates[kind][key])}
          />
        </Field>
      ))}
      <Field label={t('Variablengruppe', 'Variable group')}>
        <select
          value={variableGroup}
          onChange={(event) =>
            setVariableGroup(event.target.value as NameField | 'other')
          }
        >
          {Object.entries(groupLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted small">
        {t('Einfügen in:', 'Insert into:')} {fields[field]}
      </p>
      <div className="variables">
        {shownVariables.map((variable) => (
          <button type="button" key={variable} onClick={() => insert(variable)}>
            {'{{' + variable + '}}'}
          </button>
        ))}
      </div>
      <p className="muted small">
        {t(
          'Short = Kurzname, Long = Langname, Display = WebUntis-Anzeige. Fehlt eine Variante, wird eine verfügbare Bezeichnung verwendet.',
          'Short = short name, Long = long name, Display = WebUntis display name. Missing variants use an available name.',
        )}
      </p>
      <p className="muted small">
        {t(
          'Optionale Blöcke wie [[Info: {{info}}]] werden ausgeblendet, wenn ein Wert fehlt.',
          'Optional blocks such as [[Info: {{info}}]] disappear when a value is missing.',
        )}
      </p>
      <section className="preview">
        <h3>{t('Vorschau', 'Preview')}</h3>
        <ErrorNotice error={error} />
        {!shown?.length ? (
          <p className="muted">
            {t(
              'Keine passenden Termine. Konto zuerst synchronisieren.',
              'No matching events. Sync an account first.',
            )}
          </p>
        ) : (
          shown.map((event) => (
            <article key={event.accountId + event.sourceId}>
              <div className="preview-date">
                {eventDateLabel(event, language)}
              </div>
              <div>
                <strong>{event.title}</strong>
                <p className="muted small">
                  {event.allDay
                    ? t('Ganztägig', 'All day')
                    : new Date(event.start).toLocaleTimeString(language, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                </p>
                {event.location && (
                  <p className="muted small">
                    {fields.location}: {event.location}
                  </p>
                )}
                <p className="preserve-lines small">{event.description}</p>
              </div>
            </article>
          ))
        )}
      </section>
    </section>
  );
}
