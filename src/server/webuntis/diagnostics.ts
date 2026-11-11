import { DateTime } from 'luxon';
import type { Capability } from '../../shared/types.js';
import type { CalendarEvent, Snapshot } from '../../shared/events.js';
import { AppError } from '../errors.js';
import { type WebUntisClient, WebUntisError } from './client.js';
import { isoDate, normalizeExams, normalizeHolidays } from './normalize.js';
import { inspectTimetable } from './timetable.js';
import { reconcileExams } from './exams.js';
import { mergeHolidays } from './holidays.js';
import type { Holiday } from './schemas.js';
import { matchExams, type ExamIdentity } from './exam-matching.js';
import { includeCachedTimetable } from './exam-snapshots.js';

interface CheckData {
  count: number;
  warnings?: string[];
}

/** Read-only sample of the current school-local week, using sync validators.
 * Historical synchronization results are deliberately outside this operation. */
export async function testConnection(
  client: WebUntisClient,
  timezone: string,
  history: { previousExams?: ExamIdentity[]; timetable?: CalendarEvent[] } = {},
): Promise<Capability[]> {
  const results: Capability[] = [];
  try {
    await client.login();
    results.push({ name: 'server', status: 'success' });
    results.push({ name: 'login', status: 'success' });
  } catch (error) {
    if (!client.serverReached()) return [{ name: 'server', status: 'server' }];
    return [
      { name: 'server', status: 'success' },
      {
        name: 'login',
        status: error instanceof WebUntisError ? error.status : 'invalid',
        reason: error instanceof WebUntisError ? error.reason : undefined,
      },
    ];
  }
  const week = DateTime.now().setZone(timezone).startOf('week');
  const range = {
    start: week.toISODate()!,
    end: week.plus({ days: 6 }).toISODate()!,
  };
  const context = { name: '', timezone };
  let yearId: string | undefined;
  let lessons: CalendarEvent[] = [];
  let timetableSnapshots: Snapshot[] = [];
  let observedHolidays: Holiday[] = [];
  const checks: {
    name: string;
    dated?: boolean;
    run: () => Promise<CheckData>;
  }[] = [
    {
      name: 'schoolyears',
      run: async () => {
        const years = await client.years();
        const year = years.find(
          (year) =>
            range.start >= isoDate(year.dateRange.start) &&
            range.start <= isoDate(year.dateRange.end),
        );
        if (!year) throw new AppError('WEBUNTIS_SCHOOLYEAR_MISSING', 502);
        yearId = String(year.id);
        return { count: years.length };
      },
    },
    {
      name: 'timetable',
      dated: true,
      run: async () => {
        const data = await client.timetable(range.start, range.end, yearId);
        const inspected = inspectTimetable(data, context, range);
        lessons = inspected.events;
        timetableSnapshots = data.days
          .filter((day) => !inspected.excludedDates.has(day.date))
          .map((day) => ({
            category: 'lesson',
            start: day.date,
            end: day.date,
            events: lessons.filter((event) => event.date === day.date),
            confirmedEmptyDates: [],
          }));
        observedHolidays = inspected.holidays;
        return { count: lessons.length, warnings: inspected.warnings };
      },
    },
    {
      name: 'exams',
      dated: true,
      run: async () => {
        const exams = normalizeExams(
          await client.exams(range.start, range.end),
          context,
        );
        const reconciled = reconcileExams(lessons, exams, yearId ?? '');
        const snapshots = includeCachedTimetable(
          [
            ...timetableSnapshots,
            {
              category: 'exam',
              ...range,
              events: [],
              confirmedEmptyDates: [],
              examCandidates: reconciled.identityCandidates,
            },
          ],
          history.timetable ?? [],
        );
        const matching = matchExams(
          snapshots.flatMap((snapshot) => snapshot.examCandidates ?? []),
          history.previousExams ?? [],
          snapshots
            .filter((snapshot) => snapshot.category === 'lesson')
            .flatMap((snapshot) => snapshot.events),
        );
        return {
          count: exams.length,
          warnings: matching.ambiguous.size ? ['EXAMS_AMBIGUOUS'] : [],
        };
      },
    },
    {
      name: 'holidays',
      run: async () => {
        const holidays = mergeHolidays(
          await client.holidays(),
          observedHolidays,
        );
        return { count: normalizeHolidays(holidays, context).length };
      },
    },
  ];
  for (const check of checks) {
    const checkedRange = check.dated ? range : undefined;
    try {
      const data = await check.run();
      let status: Capability['status'] = data.count ? 'success' : 'empty';
      if (data.warnings?.length) status = 'limited';
      results.push({
        name: check.name,
        status,
        range: checkedRange,
        warnings: data.warnings?.length ? data.warnings : undefined,
      });
    } catch (error) {
      results.push({
        name: check.name,
        status: error instanceof WebUntisError ? error.status : 'invalid',
        reason: error instanceof WebUntisError ? error.reason : undefined,
        code: error instanceof AppError ? error.code : undefined,
        range: checkedRange,
      });
    }
  }
  return results;
}
