type Translate = (de: string, en: string) => string;

export function syncMessage(code: string, t: Translate): string {
  const messages: Record<string, string> = {
    WEBUNTIS_INVALID_CREDENTIALS: t(
      'Benutzername oder Passwort falsch.',
      'Incorrect username or password.',
    ),
    WEBUNTIS_INVALID_SCHOOL: t(
      'Schule oder Server prüfen.',
      'Check the school or server.',
    ),
    WEBUNTIS_UNSUPPORTED_ACCOUNT: t(
      'Ein Schülerkonto wird benötigt.',
      'A student account is required.',
    ),
    WEBUNTIS_AUTHENTICATION: t(
      'Anmeldung fehlgeschlagen. Zugangsdaten prüfen.',
      'Sign-in failed. Check your credentials.',
    ),
    WEBUNTIS_SERVER: t(
      'WebUntis ist momentan nicht erreichbar.',
      'WebUntis is currently unreachable.',
    ),
    WEBUNTIS_FORBIDDEN: t(
      'Für diesen Abruf fehlt die Berechtigung.',
      'Permission is missing for this request.',
    ),
    WEBUNTIS_UNAVAILABLE: t(
      'Eine WebUntis-Schnittstelle ist nicht verfügbar.',
      'A WebUntis endpoint is unavailable.',
    ),
    TIMETABLE_RANGE_RESTRICTED: t(
      'Die Schule gibt nur einen Teil des Zeitraums frei. Nur freigegebene Tage können synchronisiert werden.',
      'The school allows access to only part of this date range. Only available days can be synced.',
    ),
    TIMETABLE_DAYS_MISSING: t(
      'WebUntis hat einige Tage nicht zurückgegeben. Vorhandene Termine dieser Tage bleiben erhalten.',
      'WebUntis omitted some dates. Existing events on those dates are preserved.',
    ),
    EXAMS_AMBIGUOUS: t(
      'Einige Prüfungen lassen sich nicht eindeutig zuordnen. Bisherige Termine bleiben erhalten; unklare neue Einträge werden vorerst nicht übernommen.',
      'Some exams cannot be identified unambiguously. Existing events are preserved; uncertain new entries are withheld for now.',
    ),
    EXAMS_MISSING_IDS: t(
      'WebUntis liefert für einige Prüfungen keine eindeutige Kennung. Diese werden nur übernommen, wenn sie im Stundenplan zugeordnet werden können. Zusätzliche Einträge können fehlen.',
      'WebUntis provides no unique identifier for some exams. These are imported only when they can be matched to the timetable. Additional entries may be missing.',
    ),
    HOLIDAYS_INCOMPLETE_RANGE: t(
      'Für einige Ferien fehlt der vollständige Zeitraum. Gespeicherte Ferien bleiben erhalten.',
      'Some holidays have no complete date range. Stored holidays are preserved.',
    ),
    WEBUNTIS_CONFLICTING_HOLIDAY: t(
      'WebUntis liefert widersprüchliche Ferienzeiträume. Gespeicherte Termine bleiben erhalten.',
      'WebUntis returned conflicting holiday ranges. Stored events are preserved.',
    ),
    WEBUNTIS_INVALID_HOLIDAY_RANGE: t(
      'Ein Ferienzeitraum von WebUntis ist ungültig. Gespeicherte Termine bleiben erhalten.',
      'A WebUntis holiday date range is invalid. Stored events are preserved.',
    ),
    WEBUNTIS_UNKNOWN_HOLIDAY_STATUS: t(
      'Ein Ferienstatus von WebUntis konnte nicht verarbeitet werden. Gespeicherte Termine bleiben erhalten.',
      'A WebUntis holiday status could not be processed. Stored events are preserved.',
    ),
    WEBUNTIS_INCOMPLETE_DAY: t(
      'Ein Tagesstatus von WebUntis konnte nicht verarbeitet werden. Gespeicherte Termine bleiben erhalten.',
      'A WebUntis day status could not be processed. Stored events are preserved.',
    ),
    WEBUNTIS_INCOMPLETE_WINDOW: t(
      'In der WebUntis-Antwort fehlen angefragte Tage. Gespeicherte Termine bleiben erhalten.',
      'The WebUntis response is missing requested days. Stored events are preserved.',
    ),
    EXAMS_FORBIDDEN: t(
      'Separater Prüfungsabruf nicht freigegeben.',
      'Separate exam access is not permitted.',
    ),
    EXAMS_UNAVAILABLE: t(
      'Separater Prüfungsabruf nicht verfügbar.',
      'Separate exam endpoint unavailable.',
    ),
    EXAMS_TIMETABLE_FALLBACK: t(
      'Der Prüfungs-Tab konnte nicht gelesen werden. Für zugängliche Tage werden automatisch Prüfungen aus dem Stundenplan verwendet.',
      'The Exams tab could not be read. Exams from the timetable are used automatically for accessible dates.',
    ),
    HOLIDAYS_FORBIDDEN: t(
      'Der separate Ferienabruf ist nicht freigegeben. Ferien aus dem Stundenplan bleiben verfügbar.',
      'Separate holiday access is not permitted. Timetable holidays remain available.',
    ),
    HOLIDAYS_UNAVAILABLE: t(
      'Der separate Ferienabruf ist nicht verfügbar. Ferien aus dem Stundenplan bleiben verfügbar.',
      'The separate holiday endpoint is unavailable. Timetable holidays remain available.',
    ),
    SCHOOLYEAR_RANGE_LIMITED: t(
      'WebUntis ordnet nicht alle angefragten Tage einem verfügbaren Schuljahr zu, etwa in den Sommerferien. Die verfügbaren Zeiträume werden synchronisiert.',
      'WebUntis does not assign every requested date to an available school year, for example during summer holidays. Available date ranges are synced.',
    ),
    RPC_FALLBACK: t(
      'Der Stundenplan wird über den alternativen WebUntis-Abruf gelesen. Details können fehlen.',
      'The timetable uses the alternative WebUntis endpoint. Some details may be missing.',
    ),
    RETAINED_UNCONFIRMED_EVENTS: t(
      'Nicht bestätigte Löschungen wurden zurückgehalten. Bisherige Termine bleiben erhalten.',
      'Unconfirmed deletions were withheld. Previous events are preserved.',
    ),
    WEBUNTIS_SCHOOLYEAR_MISSING: t(
      'WebUntis liefert kein passendes Schuljahr für den angefragten Zeitraum.',
      'WebUntis returned no matching school year for the requested dates.',
    ),
  };
  return (
    messages[code] ??
    t(
      'Die Synchronisierung wurde nicht abgeschlossen. Gespeicherte Termine bleiben erhalten.',
      'Synchronization did not complete. Stored events are preserved.',
    )
  );
}

export function syncTitle(code: string, t: Translate): string {
  const titles: Record<string, string> = {
    TIMETABLE_RANGE_RESTRICTED: t('Begrenzter Zeitraum', 'Limited date range'),
    TIMETABLE_DAYS_MISSING: t('Einzelne Tage fehlen', 'Some dates omitted'),
    EXAMS_AMBIGUOUS: t(
      'Einige Prüfungen noch unklar',
      'Some exams are still unclear',
    ),
    EXAMS_MISSING_IDS: t(
      'Einige Prüfungen nur über den Stundenplan verfügbar',
      'Some exams available through timetable only',
    ),
    EXAMS_FORBIDDEN: t(
      'Prüfungen nur aus dem Stundenplan',
      'Exams from timetable only',
    ),
    EXAMS_UNAVAILABLE: t(
      'Prüfungen nur aus dem Stundenplan',
      'Exams from timetable only',
    ),
    EXAMS_TIMETABLE_FALLBACK: t(
      'Prüfungen aus dem Stundenplan',
      'Exams from the timetable',
    ),
    HOLIDAYS_FORBIDDEN: t(
      'Ferienabruf eingeschränkt',
      'Limited holiday access',
    ),
    HOLIDAYS_UNAVAILABLE: t(
      'Ferienabruf eingeschränkt',
      'Limited holiday access',
    ),
    HOLIDAYS_INCOMPLETE_RANGE: t(
      'Unvollständiger Ferienzeitraum',
      'Incomplete holiday range',
    ),
    SCHOOLYEAR_RANGE_LIMITED: t(
      'Zeitraum auf Schuljahr begrenzt',
      'Limited to available school years',
    ),
    RPC_FALLBACK: t(
      'Alternativer Stundenplanabruf',
      'Alternative timetable source',
    ),
    RETAINED_UNCONFIRMED_EVENTS: t(
      'Bisherige Termine beibehalten',
      'Previous events retained',
    ),
  };
  return titles[code] ?? syncMessage(code, t);
}
