export const eventKinds = [
  'lesson',
  'cancelled',
  'substitution',
  'exam',
  'holiday',
] as const;
export type EventKind = (typeof eventKinds)[number];
export const nameFields = [
  'subject',
  'teacher',
  'class',
  'room',
  'originalTeacher',
  'substituteTeacher',
] as const;
export const nameVariants = ['Short', 'Long', 'Display'] as const;
export type NameField = (typeof nameFields)[number];
export type NameVariant = (typeof nameVariants)[number];
export const variables = [
  ...nameFields.flatMap((field) =>
    nameVariants.map((variant) => `${field}${variant}` as const),
  ),
  'subject',
  'teacher',
  'room',
  'class',
  'info',
  'status',
  'substituteTeacher',
  'originalTeacher',
  'examType',
  'examName',
  'examText',
  'holidayName',
  'account',
  'date',
  'start',
  'end',
] as const;
export type Variable = (typeof variables)[number];
export type EventValues = Record<Variable, string>;
export interface CalendarEvent {
  sourceId: string;
  sourceIds?: string[];
  kind: EventKind;
  // Coverage follows the source endpoint; timetable exams remain in lesson coverage.
  category: 'lesson' | 'exam' | 'holiday';
  date: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  values: EventValues;
  source: string;
}
export interface StoredEvent extends CalendarEvent {
  accountId: string;
  revision: number;
  createdAt: string;
  modifiedAt: string;
}
export interface ExamCandidate {
  event: CalendarEvent;
  schoolYearId: string;
  // Verified timetable period IDs, never the placeholder exam:0.
  targetIds?: string[];
  blocked?: boolean;
}
export interface Snapshot {
  category: CalendarEvent['category'];
  start: string;
  end: string;
  events: CalendarEvent[];
  // Only server-confirmed NO_DATA dates can delete an entirely empty day.
  confirmedEmptyDates: string[];
  // Observed-only sources may update events but cannot establish their absence.
  deletionCoverage?: boolean;
  // Separate-exam observations receive persistent aliases inside the commit.
  examCandidates?: ExamCandidate[];
  // Independent source publication keeps each view's identities across switches.
  examFeed?: {
    source: 'exams' | 'timetable';
    schoolYearId: string;
    dates: string[];
    events: CalendarEvent[];
  };
}
