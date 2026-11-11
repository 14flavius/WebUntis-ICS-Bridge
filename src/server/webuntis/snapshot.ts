import { DateTime } from 'luxon';
import { ZodError } from 'zod';
import type { Snapshot } from '../../shared/events.js';
import type { ExamSource } from '../../shared/types.js';
import type { WebUntisClient } from './client.js';
import { WebUntisError } from './client.js';
import {
  isoDate,
  normalizeRpc,
  normalizeExams,
  normalizeHolidays,
} from './normalize.js';
import { AppError } from '../errors.js';
import { reconcileExams } from './exams.js';
import { matchExams } from './exam-matching.js';
import { mergeHolidays } from './holidays.js';
import { inspectTimetable } from './timetable.js';
import type { Holiday } from './schemas.js';

function readableTimetableSnapshots(
  snapshot: Snapshot,
  excludedDates: Set<string>,
): Snapshot[] {
  if (!excludedDates.size) return [snapshot];
  const snapshots: Snapshot[] = [];
  let cursor = DateTime.fromISO(snapshot.start);
  while (cursor.toISODate()! <= snapshot.end) {
    const date = cursor.toISODate()!;
    // A denied or omitted date is not empty: omit its coverage so old
    // events cannot be marked missing or deleted by a later synchronization.
    if (!excludedDates.has(date)) {
      snapshots.push({
        category: 'lesson',
        start: date,
        end: date,
        events: snapshot.events.filter((event) => event.date === date),
        confirmedEmptyDates: snapshot.confirmedEmptyDates.filter(
          (day) => day === date,
        ),
      });
    }
    cursor = cursor.plus({ days: 1 });
  }
  return snapshots;
}

export function windows(
  start: string,
  end: string,
  years: { id: string | number; dateRange: { start: string; end: string } }[],
) {
  const result: { start: string; end: string; yearId: string }[] = [];
  const ranges = years.map((year) => ({
    id: String(year.id),
    start: isoDate(year.dateRange.start),
    end: isoDate(year.dateRange.end),
  }));
  let cursor = DateTime.fromISO(start);
  while (cursor.toISODate()! <= end) {
    const date = cursor.toISODate()!;
    const year = ranges.find((year) => date >= year.start && date <= year.end);
    if (!year) {
      // Some schools exclude summer holidays from both adjacent school years.
      // Skip uncovered dates without inventing coverage or discarding other years.
      const next = ranges
        .map((range) => range.start)
        .filter((date) => date > cursor.toISODate()! && date <= end)
        .sort()[0];
      if (!next) break;
      cursor = DateTime.fromISO(next);
      continue;
    }
    const stop = [
      cursor.plus({ days: 6 }).toISODate()!,
      end,
      year.end,
    ].sort()[0];
    result.push({ start: date, end: stop, yearId: String(year.id) });
    cursor = DateTime.fromISO(stop).plus({ days: 1 });
  }
  if (!result.length) throw new AppError('WEBUNTIS_SCHOOLYEAR_MISSING', 502);
  return result;
}
export async function fetchSnapshots(
  client: WebUntisClient,
  context: { name: string; timezone: string; examSource?: ExamSource },
  start: string,
  end: string,
) {
  await client.login();
  const warnings: string[] = [];
  const years = await client.years();
  const requestedWindows = windows(start, end, years);
  const coveredDays = requestedWindows.reduce(
    (total, window) =>
      total +
      DateTime.fromISO(window.end).diff(DateTime.fromISO(window.start), 'days')
        .days +
      1,
    0,
  );
  const requestedDays =
    DateTime.fromISO(end).diff(DateTime.fromISO(start), 'days').days + 1;
  if (coveredDays < requestedDays) warnings.push('SCHOOLYEAR_RANGE_LIMITED');
  const snapshots: Snapshot[] = [];
  const observedHolidays: Holiday[] = [];
  for (const window of requestedWindows) {
    let lessons: Snapshot;
    let excludedDates = new Set<string>();
    let timetableDates: string[];
    try {
      const data = await client.timetable(
        window.start,
        window.end,
        window.yearId,
      );
      const inspected = inspectTimetable(data, context, window);
      excludedDates = inspected.excludedDates;
      timetableDates = data.days
        .filter((day) => !excludedDates.has(day.date))
        .map((day) => day.date);
      lessons = {
        category: 'lesson',
        ...window,
        events: inspected.events,
        confirmedEmptyDates: inspected.confirmedEmptyDates,
      };
      observedHolidays.push(...inspected.holidays);
      warnings.push(...inspected.warnings);
    } catch (error) {
      if (
        !(error instanceof WebUntisError) ||
        !['unavailable', 'forbidden'].includes(error.status)
      )
        throw error;
      lessons = {
        category: 'lesson',
        ...window,
        events: normalizeRpc(
          await client.rpcTimetable(window.start, window.end),
          context,
        ),
        confirmedEmptyDates: [],
      };
      warnings.push('RPC_FALLBACK');
      timetableDates = [...new Set(lessons.events.map((event) => event.date))];
    }
    const exams: Snapshot = {
      category: 'exam',
      ...window,
      events: [],
      confirmedEmptyDates: [],
      deletionCoverage: false,
      examFeed: {
        source: 'timetable',
        schoolYearId: window.yearId,
        dates: timetableDates,
        events: [],
      },
    };
    if (context.examSource !== 'timetable') {
      try {
        const observations = normalizeExams(
          await client.exams(window.start, window.end),
          context,
        );
        if (
          observations.some(
            (event) => event.date < window.start || event.date > window.end,
          )
        )
          throw new AppError('WEBUNTIS_OUTSIDE_WINDOW', 502);
        // Reject conflicting native IDs here, where a failed tab can still
        // fall back to the validated timetable without aborting publication.
        matchExams(
          observations.map((event) => ({ event, schoolYearId: window.yearId })),
          [],
        );
        const reconciled = reconcileExams(
          lessons.events,
          observations,
          window.yearId,
        );
        lessons.events = reconciled.timetable;
        exams.events = reconciled.exams.filter(
          (event) => event.sourceId !== 'exam:0',
        );
        exams.examCandidates = reconciled.identityCandidates;
        exams.deletionCoverage = true;
        const dates: string[] = [];
        for (
          let date = DateTime.fromISO(window.start);
          date.toISODate()! <= window.end;
          date = date.plus({ days: 1 })
        )
          dates.push(date.toISODate()!);
        exams.examFeed = {
          source: 'exams',
          schoolYearId: window.yearId,
          dates,
          events: observations,
        };
      } catch (error) {
        if (
          !(error instanceof WebUntisError) &&
          !(error instanceof ZodError) &&
          !(error instanceof AppError && error.code.startsWith('WEBUNTIS_'))
        )
          throw error;
        if (
          error instanceof WebUntisError &&
          ['forbidden', 'unavailable'].includes(error.status)
        )
          warnings.push(`EXAMS_${error.status.toUpperCase()}`);
        warnings.push('EXAMS_TIMETABLE_FALLBACK');
      }
    }
    snapshots.push(...readableTimetableSnapshots(lessons, excludedDates));
    snapshots.push(exams);
  }
  let rpcHolidays: Holiday[] = [];
  let holidayCoverage = false;
  try {
    rpcHolidays = await client.holidays();
    holidayCoverage = true;
  } catch (error) {
    if (
      !(error instanceof WebUntisError) ||
      !['forbidden', 'unavailable'].includes(error.status)
    )
      throw error;
    warnings.push(`HOLIDAYS_${error.status.toUpperCase()}`);
  }
  if (holidayCoverage || observedHolidays.length) {
    const rpcIds = new Set(rpcHolidays.map((holiday) => String(holiday.id)));
    // A background-only observation must not make an otherwise empty RPC
    // scope look complete enough to delete other holidays on the same date.
    const deletionCoverage =
      holidayCoverage &&
      observedHolidays.every((holiday) => rpcIds.has(String(holiday.id)));
    snapshots.push({
      category: 'holiday',
      start,
      end,
      events: normalizeHolidays(
        mergeHolidays(rpcHolidays, observedHolidays),
        context,
      ),
      confirmedEmptyDates: [],
      deletionCoverage,
    });
  }
  return { snapshots, warnings: [...new Set(warnings)] };
}
