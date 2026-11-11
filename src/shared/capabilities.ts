import type { Capability } from './types.js';

export function isOptionalExamUnavailable(result: Capability): boolean {
  return (
    result.name === 'exams' &&
    ['forbidden', 'unavailable'].includes(result.status)
  );
}

export function isCapabilityFailure(result: Capability): boolean {
  return (
    !['success', 'empty', 'limited'].includes(result.status) &&
    !isOptionalExamUnavailable(result)
  );
}

const syncNoticeCodes = new Set([
  'TIMETABLE_RANGE_RESTRICTED',
  'TIMETABLE_DAYS_MISSING',
  'EXAMS_MISSING_IDS',
  'EXAMS_AMBIGUOUS',
  'EXAMS_FORBIDDEN',
  'EXAMS_UNAVAILABLE',
  'EXAMS_TIMETABLE_FALLBACK',
  'HOLIDAYS_FORBIDDEN',
  'HOLIDAYS_UNAVAILABLE',
  'HOLIDAYS_INCOMPLETE_RANGE',
  'SCHOOLYEAR_RANGE_LIMITED',
  'RPC_FALLBACK',
  'RETAINED_UNCONFIRMED_EVENTS',
]);

export function syncIssueCodes(error: string | null | undefined): string[] {
  return [
    ...new Set(
      (error ?? '')
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean),
    ),
  ];
}

export function isSyncNotice(code: string): boolean {
  return syncNoticeCodes.has(code);
}

export function visibleSyncIssues(error: string | null | undefined): string[] {
  return syncIssueCodes(error).filter(
    (code) => !['EXAMS_FORBIDDEN', 'EXAMS_UNAVAILABLE'].includes(code),
  );
}
