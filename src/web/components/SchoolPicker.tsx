import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { School } from '../../shared/types';
import { api } from '../lib/api';
import { nonCredentialAutofill } from '../lib/autofill';
import { useI18n } from '../lib/i18n';
import { ErrorNotice } from './ui';
import { Icon } from './Icon';

const SEARCH_DELAY_MS = 350;
const MIN_QUERY_LENGTH = 3;

export function SchoolPicker({
  initialSchool,
  onChange,
}: {
  initialSchool: string;
  onChange: (school: string, server: string, displayName?: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const listId = `${id}-results`;
  const [query, setQuery] = useState(initialSchool);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<School[]>([]);
  const [selected, setSelected] = useState<School>();
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<unknown>();
  const showResults =
    open && editing && query.trim().length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!editing || query.trim().length < MIN_QUERY_LENGTH) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const schools = await api<School[]>(
          `/api/schools?q=${encodeURIComponent(query.trim())}`,
          {
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        setResults(schools);
        setStatus('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error);
        setStatus('error');
      }
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, editing]);

  useEffect(() => {
    if (showResults && activeIndex >= 0)
      document
        .getElementById(`${listId}-${activeIndex}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listId, showResults]);

  const select = (school: School) => {
    setSelected(school);
    setQuery(school.displayName);
    setEditing(false);
    setOpen(false);
    setActiveIndex(-1);
    setError(undefined);
    onChange(school.loginName, school.server, school.displayName);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' && editing) {
      event.preventDefault();
      if (showResults && activeIndex >= 0 && results[activeIndex])
        select(results[activeIndex]);
      return;
    }
    if (
      !['ArrowDown', 'ArrowUp'].includes(event.key) ||
      !results.length ||
      !editing
    )
      return;
    event.preventDefault();
    setOpen(true);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    setActiveIndex((index) => {
      if (index < 0) return direction === 1 ? 0 : results.length - 1;
      return (index + direction + results.length) % results.length;
    });
  };

  return (
    <div className="school-picker">
      <label className="field" htmlFor={id}>
        <span>{t('Schule', 'School')}</span>
        <div className="school-input">
          <Icon name="calendar" />
          <input
            {...nonCredentialAutofill}
            id={id}
            name="school-search"
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showResults}
            aria-controls={showResults ? listId : undefined}
            aria-activedescendant={
              showResults && activeIndex >= 0
                ? `${listId}-${activeIndex}`
                : undefined
            }
            aria-describedby={`${id}-hint`}
            value={query}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setQuery(value);
              setEditing(true);
              setSelected(undefined);
              setOpen(true);
              setResults([]);
              setActiveIndex(-1);
              setError(undefined);
              setStatus(
                value.trim().length >= MIN_QUERY_LENGTH ? 'loading' : 'idle',
              );
              // An edited search must never retain a previously selected server.
              onChange(value, '');
            }}
            required
            maxLength={150}
            placeholder={t('Schulname oder Ort', 'School name or town')}
          />
        </div>
      </label>
      <div id={`${id}-hint`} className="school-hint" role="status">
        {selected ? (
          <div className="school-selection">
            <span className="school-option-icon">
              <Icon name="school" />
            </span>
            <div>
              <strong>{selected.displayName}</strong>
              <span>{selected.address || selected.loginName}</span>
            </div>
            <span
              className="selection-check"
              aria-label={t('Ausgewählt', 'Selected')}
            >
              <Icon name="check" />
            </span>
          </div>
        ) : (
          t('Vorschläge ab 3 Zeichen', 'Suggestions from 3 characters')
        )}
      </div>
      {showResults && (
        <div className="school-suggestions">
          {status === 'ready' && results.length > 0 && (
            <p className="school-results-label">
              {t('Schule auswählen', 'Select a school')}
              <span>{results.length}</span>
            </p>
          )}
          {status === 'loading' && (
            <p className="school-search-status" role="status">
              {t('Schulen werden gesucht …', 'Searching schools …')}
            </p>
          )}
          {status === 'error' && <ErrorNotice error={error} />}
          {status === 'ready' && !results.length && (
            <p className="school-search-status" role="status">
              {t(
                'Keine Schule gefunden. Versuche einen anderen Namen oder Ort.',
                'No school found. Try another name or town.',
              )}
            </p>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label={t('Schulvorschläge', 'School suggestions')}
          >
            {results.map((school, index) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${index}`}
                key={`${school.server}/${school.loginName}`}
                aria-selected={activeIndex === index}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(school)}
              >
                <span className="school-option-icon">
                  <Icon name="school" />
                </span>
                <span>
                  <strong>{school.displayName}</strong>
                  <small>{school.address || school.loginName}</small>
                </span>
                <span className="school-option-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
