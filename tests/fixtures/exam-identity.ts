import { randomUUID } from 'node:crypto';
import type { CalendarEvent, Snapshot } from '../../src/shared/events.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { migrateApplication } from '../../src/server/schema.js';
import {
  normalizeExams,
  normalizeTimetable,
} from '../../src/server/webuntis/normalize.js';
import { reconcileExams } from '../../src/server/webuntis/exams.js';
import { context } from './events.js';
import { examTimetableFixture } from './timetable-exams.js';
import type { Exam } from '../../src/server/webuntis/schemas.js';

export function identityDatabase(filename = ':memory:') {
  const db = openDatabase(filename);
  migrateApplication(db);
  return db;
}
export function identityAccount(db: Db) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO webuntis_accounts (id,name,school,server,username,password,timezone) VALUES (?,?,?,?,?,?,?)',
  ).run(
    id,
    'Fixture',
    'fixture',
    'https://fixture.webuntis.com',
    'student',
    'encrypted',
    context.timezone,
  );
  return id;
}
export function separateExam(overrides: Partial<Exam> = {}) {
  return normalizeExams(
    [
      {
        id: 0,
        name: 'Algebra test',
        subject: 'Math',
        examType: 'Written',
        examDate: 20261020,
        startTime: 800,
        endTime: 930,
        ...overrides,
      },
    ],
    context,
  )[0];
}
export function timetableExam() {
  return normalizeTimetable(examTimetableFixture(), context)[0];
}
export function examSnapshots(
  exams: CalendarEvent[],
  options: {
    lessons?: CalendarEvent[];
    schoolYearId?: string;
    start?: string;
    end?: string;
  } = {},
): Snapshot[] {
  const range = {
    start: options.start ?? '2026-10-01',
    end: options.end ?? '2026-11-30',
  };
  const reconciled = reconcileExams(
    options.lessons ?? [],
    exams,
    options.schoolYearId ?? '2026',
  );
  const snapshots: Snapshot[] = [
    {
      ...range,
      category: 'exam',
      events: reconciled.exams.filter((event) => event.sourceId !== 'exam:0'),
      examCandidates: reconciled.identityCandidates,
      confirmedEmptyDates: [],
    },
  ];
  if (options.lessons)
    snapshots.unshift({
      ...range,
      category: 'lesson',
      events: reconciled.timetable,
      confirmedEmptyDates: [],
    });
  return snapshots;
}
