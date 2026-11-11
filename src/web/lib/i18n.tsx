import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Language } from '../../shared/types';
import type { EventKind } from '../../shared/events';
const LanguageContext = createContext<{
  language: Language;
  setLanguage: (value: Language) => void;
}>({ language: 'en', setLanguage: () => {} });
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setValue] = useState<Language>(() => {
    const saved = localStorage.getItem('language');
    if (saved === 'de' || saved === 'en') return saved;
    const browserLanguage =
      navigator.languages?.[0] ?? navigator.language ?? '';
    return /^de(?:-|$)/i.test(browserLanguage) ? 'de' : 'en';
  });
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const setLanguage = (value: Language) => {
    setValue(value);
    localStorage.setItem('language', value);
  };
  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
}
export function useI18n() {
  const context = useContext(LanguageContext);
  return {
    ...context,
    t: (de: string, en: string) => (context.language === 'de' ? de : en),
  };
}
export function kindLabel(kind: EventKind, language: Language) {
  const labels = {
    de: {
      lesson: 'Unterricht',
      cancelled: 'Ausfälle',
      substitution: 'Vertretungen',
      exam: 'Prüfungen',
      holiday: 'Ferien',
    },
    en: {
      lesson: 'Lessons',
      cancelled: 'Cancellations',
      substitution: 'Substitutions',
      exam: 'Exams',
      holiday: 'Holidays',
    },
  };
  return labels[language][kind];
}
export function dateLabel(value: string | null, language: Language) {
  if (!value)
    return language === 'de' ? 'Noch nicht synchronisiert' : 'Not synced yet';
  return new Date(value).toLocaleString(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
