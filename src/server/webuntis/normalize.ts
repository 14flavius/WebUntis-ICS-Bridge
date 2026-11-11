import { DateTime } from 'luxon';
import {
  variables,
  type CalendarEvent,
  type EventKind,
  type EventValues,
} from '../../shared/events.js';
import type { Exam, Holiday, RpcLesson, Timetable } from './schemas.js';
import { entryPositions } from './resources.js';
import { AppError } from '../errors.js';

export function isoDate(value: string | number): string {
  const text = String(value);
  const date = /^\d{8}$/.test(text)
    ? DateTime.fromFormat(text, 'yyyyMMdd')
    : DateTime.fromISO(text);
  if (!date.isValid) throw new AppError('WEBUNTIS_INVALID_DATE', 502);
  return date.toISODate()!;
}
function time(value: string | number): string {
  const text = String(value);
  if (text.includes(':')) return text;
  const padded = text.padStart(4, '0');
  return `${padded.slice(0, 2)}:${padded.slice(2)}`;
}
function instant(value: string, timezone: string): string {
  const date = DateTime.fromISO(value, { zone: timezone, setZone: true });
  const explicitOffset = /([zZ]|[+-][0-9]{2}:?[0-9]{2})$/.test(value);
  if (
    !date.isValid ||
    (date.toFormat("yyyy-MM-dd'T'HH:mm") !== value.slice(0, 16) &&
      !explicitOffset) ||
    (!explicitOffset && date.getPossibleOffsets().length !== 1)
  )
    throw new AppError('WEBUNTIS_INVALID_TIME', 502);
  return date.toUTC().toISO()!;
}
export function valuesFor(account: string): EventValues {
  const values = Object.fromEntries(
    variables.map((variable) => [variable, '']),
  ) as EventValues;
  values.account = account;
  return values;
}
interface Context {
  name: string;
  timezone: string;
}
export function uniqueText(values: (string | null | undefined)[]): string {
  const texts = values.map((value) => value?.trim() ?? '').filter(Boolean);
  return [...new Set(texts)].join('\n');
}
export function positionLabel(value: {
  type: string;
  shortName?: string;
  displayName?: string;
  longName?: string;
}): string {
  // Schools may use room/class descriptions for staff names. Their short
  // names identify the actual room or class shown in the timetable.
  if (value.type === 'ROOM' || value.type === 'CLASS')
    return value.shortName || value.displayName || value.longName || '';
  return value.longName || value.shortName || value.displayName || '';
}
export function teachingKind(
  status: string,
  originalTeacher: string,
): 'lesson' | 'cancelled' | 'substitution' {
  if (['CANCELLED', 'CANCELED'].includes(status)) return 'cancelled';
  if (
    ['SUBSTITUTION', 'CHANGED', 'ADDITIONAL', 'IRREGULAR'].includes(status) ||
    originalTeacher
  )
    return 'substitution';
  if (status !== 'REGULAR') throw new AppError('WEBUNTIS_UNKNOWN_STATUS', 502);
  return 'lesson';
}
function makeEvent(
  context: Context,
  event: Omit<CalendarEvent, 'timezone' | 'values'>,
  values: Partial<EventValues>,
): CalendarEvent {
  if (event.end <= event.start)
    throw new AppError('WEBUNTIS_INVALID_DURATION', 502);
  return {
    ...event,
    timezone: context.timezone,
    values: {
      ...valuesFor(context.name),
      ...values,
      date: event.date,
      start: event.allDay
        ? ''
        : DateTime.fromISO(event.start)
            .setZone(context.timezone)
            .toFormat('HH:mm'),
      end: event.allDay
        ? ''
        : DateTime.fromISO(event.end)
            .setZone(context.timezone)
            .toFormat('HH:mm'),
    },
  };
}
export function normalizeTimetable(
  data: Timetable,
  context: Context,
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const day of data.days) {
    if (!['REGULAR', 'NO_DATA'].includes(day.status))
      throw new AppError('WEBUNTIS_INCOMPLETE_DAY', 502);
    for (const entry of day.gridEntries) {
      const ids =
        entry.ids?.map(String).sort() ??
        (entry.id !== undefined ? [String(entry.id)] : []);
      if (!ids.length) throw new AppError('WEBUNTIS_MISSING_EVENT_ID', 502);
      const current = new Map<string, string[]>();
      const removed = new Map<string, string[]>();
      for (const position of entryPositions(entry)) {
        for (const [value, target] of [
          [position.current, current],
          [position.removed, removed],
        ] as const) {
          if (!value) continue;
          const names = target.get(value.type) ?? [];
          names.push(positionLabel(value));
          target.set(value.type, names);
        }
      }
      const field = (type: string) =>
        [...new Set(current.get(type) ?? [])].filter(Boolean).join(', ');
      const originalTeacher = (removed.get('TEACHER') ?? []).join(', ');
      let kind: EventKind = teachingKind(entry.status, originalTeacher);
      const isExam = entry.type === 'EXAM';
      if (isExam && kind !== 'cancelled') kind = 'exam';
      const info = uniqueText([
        entry.notesAll,
        entry.lessonInfo,
        entry.lessonText,
        entry.substitutionText,
        field('INFO'),
        ...(entry.texts ?? [])
          .filter((text) =>
            [
              'NOTES_FOR_ALL',
              'LESSON_INFO',
              'LESSON_TEXT',
              'SUBSTITUTION_TEXT',
            ].includes(text.type),
          )
          .map((text) => text.text),
      ]);
      events.push(
        makeEvent(
          context,
          {
            sourceId: `lesson:${ids[0]}`,
            sourceIds: ids.map((id) => `lesson:${id}`),
            category: 'lesson',
            kind,
            date: isoDate(day.date),
            start: instant(entry.duration.start, context.timezone),
            end: instant(entry.duration.end, context.timezone),
            allDay: false,
            source: JSON.stringify(entry),
          },
          {
            subject: field('SUBJECT'),
            teacher: field('TEACHER'),
            room: field('ROOM'),
            class: field('CLASS'),
            originalTeacher,
            substituteTeacher: kind === 'substitution' ? field('TEACHER') : '',
            info,
            examName: isExam ? entry.examDetails?.name || entry.name || '' : '',
            examType: isExam ? (entry.examDetails?.typeLongName ?? '') : '',
            examText: isExam
              ? uniqueText([info, entry.examDetails?.description])
              : '',
          },
        ),
      );
    }
  }
  return events;
}
export function normalizeRpc(
  data: RpcLesson[],
  context: Context,
): CalendarEvent[] {
  return data.map((lesson) => {
    const date = isoDate(lesson.date);
    let kind: EventKind = 'lesson';
    if (lesson.code === 'cancelled') kind = 'cancelled';
    else if (
      lesson.code === 'irregular' ||
      lesson.te.some((teacher) => teacher.orgid !== undefined)
    )
      kind = 'substitution';
    else if (lesson.code) throw new AppError('WEBUNTIS_UNKNOWN_STATUS', 502);
    const names = (elements: RpcLesson['su']) =>
      elements
        .map((element) => element.longname || element.name || '')
        .filter(Boolean)
        .join(', ');
    return makeEvent(
      context,
      {
        sourceId: `lesson:${lesson.id}`,
        kind,
        category: 'lesson',
        date,
        start: instant(`${date}T${time(lesson.startTime)}`, context.timezone),
        end: instant(`${date}T${time(lesson.endTime)}`, context.timezone),
        allDay: false,
        source: JSON.stringify(lesson),
      },
      {
        subject: names(lesson.su),
        teacher: names(lesson.te),
        room: lesson.ro
          .map((room) => room.name || room.longname || '')
          .filter(Boolean)
          .join(', '),
        class: (lesson.kl ?? [])
          .map((group) => group.name || group.longname || '')
          .filter(Boolean)
          .join(', '),
        originalTeacher: lesson.te
          .map((teacher) => teacher.orgname ?? '')
          .filter(Boolean)
          .join(', '),
        substituteTeacher: kind === 'substitution' ? names(lesson.te) : '',
        info: uniqueText([lesson.info, lesson.lstext, lesson.substText]),
      },
    );
  });
}
function named(value: string | { name?: string; longName?: string }): string {
  return typeof value === 'string' ? value : value.longName || value.name || '';
}
export function normalizeExams(
  data: Exam[],
  context: Context,
): CalendarEvent[] {
  return data.map((exam) => {
    const date = isoDate(exam.examDate);
    const allDay = exam.startTime === undefined && exam.endTime === undefined;
    if (!allDay && (exam.startTime === undefined || exam.endTime === undefined))
      throw new AppError('WEBUNTIS_INCOMPLETE_EXAM', 502);
    return makeEvent(
      context,
      {
        sourceId: `exam:${exam.id}`,
        kind: 'exam',
        category: 'exam',
        date,
        allDay,
        start: allDay
          ? date
          : instant(`${date}T${time(exam.startTime!)}`, context.timezone),
        end: allDay
          ? DateTime.fromISO(date).plus({ days: 1 }).toISODate()!
          : instant(`${date}T${time(exam.endTime!)}`, context.timezone),
        source: JSON.stringify(exam),
      },
      {
        subject: exam.subject ?? '',
        examName: exam.name,
        examType: exam.examType ? named(exam.examType) : '',
        examText: exam.text ?? exam.description ?? '',
        room: (exam.rooms ?? [])
          .map((room) =>
            typeof room === 'string' ? room : room.name || room.longName || '',
          )
          .filter(Boolean)
          .join(', '),
        teacher: (exam.teachers ?? []).map(named).join(', '),
        class: [...new Set(exam.studentClass ?? [])].filter(Boolean).join(', '),
      },
    );
  });
}
export function normalizeHolidays(
  data: Holiday[],
  context: Context,
): CalendarEvent[] {
  const events = new Map<string, CalendarEvent>();
  for (const holiday of data) {
    const start = isoDate(holiday.startDate);
    const end = DateTime.fromISO(isoDate(holiday.endDate))
      .plus({ days: 1 })
      .toISODate()!;
    const name = holiday.longName || holiday.longname || holiday.name || '';
    const key = `${start}:${end}:${name}`;
    const existing = events.get(key);
    if (existing) {
      existing.sourceIds = [
        ...new Set([
          ...(existing.sourceIds ?? [existing.sourceId]),
          `holiday:${holiday.id}`,
        ]),
      ].sort();
    } else {
      events.set(
        key,
        makeEvent(
          context,
          {
            sourceId: `holiday:${holiday.id}`,
            sourceIds: [`holiday:${holiday.id}`],
            category: 'holiday',
            kind: 'holiday',
            date: start,
            start,
            end,
            allDay: true,
            source: JSON.stringify(holiday),
          },
          { holidayName: name },
        ),
      );
    }
  }
  return [...events.values()];
}
