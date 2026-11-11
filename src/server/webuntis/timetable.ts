import { DateTime } from 'luxon';
import { AppError } from '../errors.js';
import { isoDate, normalizeTimetable } from './normalize.js';
import { timetableHolidays } from './holidays.js';
import type { Timetable } from './schemas.js';

/** Shared by sync and connection checks: a readable HTTP response is not
 * necessarily complete or usable calendar data. */
export function inspectTimetable(
  data: Timetable,
  context: { name: string; timezone: string },
  range: { start: string; end: string },
) {
  const warnings: string[] = [];
  const excludedDates = new Set<string>();
  const dates = new Set(data.days.map((day) => isoDate(day.date)));
  if (dates.size !== data.days.length)
    throw new AppError('WEBUNTIS_INCOMPLETE_WINDOW', 502);
  for (const day of data.days) {
    const date = isoDate(day.date);
    if (date < range.start || date > range.end)
      throw new AppError('WEBUNTIS_OUTSIDE_WINDOW', 502);
    if (['NOT_ALLOWED_FOR_RESOURCE', 'NOT_ALLOWED'].includes(day.status))
      excludedDates.add(date);
  }
  if (excludedDates.size) warnings.push('TIMETABLE_RANGE_RESTRICTED');
  let cursor = DateTime.fromISO(range.start);
  while (cursor.toISODate()! <= range.end) {
    const date = cursor.toISODate()!;
    if (!dates.has(date)) {
      excludedDates.add(date);
      if (!warnings.includes('TIMETABLE_DAYS_MISSING'))
        warnings.push('TIMETABLE_DAYS_MISSING');
    }
    cursor = cursor.plus({ days: 1 });
  }
  const events = normalizeTimetable(
    { days: data.days.filter((day) => !excludedDates.has(isoDate(day.date))) },
    context,
  );
  const background = timetableHolidays(data);
  if (background.incomplete) warnings.push('HOLIDAYS_INCOMPLETE_RANGE');
  return {
    events,
    excludedDates,
    warnings,
    holidays: background.holidays,
    confirmedEmptyDates: data.days
      .filter((day) => day.status === 'NO_DATA' && day.gridEntries.length === 0)
      .map((day) => isoDate(day.date)),
  };
}
