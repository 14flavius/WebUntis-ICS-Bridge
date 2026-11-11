import { DateTime } from 'luxon';
import { AppError } from '../errors.js';
import { isoDate } from './normalize.js';
import {
  timetableHolidaySchema,
  type Holiday,
  type Timetable,
} from './schemas.js';

function holidayRange(duration: { start: string; end: string }) {
  // These are school-local calendar dates. UTC conversion would shift midnight
  // into the previous day; RFC 5545's exclusive end is added by normalizeHolidays.
  const start = DateTime.fromISO(duration.start, { setZone: true });
  const end = DateTime.fromISO(duration.end, { setZone: true });
  if (
    !start.isValid ||
    !end.isValid ||
    end <= start ||
    start.toFormat('HH:mm:ss') !== '00:00:00'
  )
    throw new AppError('WEBUNTIS_INVALID_HOLIDAY_RANGE', 502);
  let lastDay = end;
  if (end.toFormat('HH:mm:ss') === '00:00:00') lastDay = end.minus({ days: 1 });
  else if (end.toFormat('HH:mm:ss') !== '23:59:59')
    throw new AppError('WEBUNTIS_INVALID_HOLIDAY_RANGE', 502);
  return { startDate: start.toISODate()!, endDate: lastDay.toISODate()! };
}

export function timetableHolidays(data: Timetable) {
  const holidays: Holiday[] = [];
  let incomplete = false;
  for (const day of data.days) {
    if (!['REGULAR', 'NO_DATA'].includes(day.status)) continue;
    for (const raw of day.backEntries ?? []) {
      if (raw.type !== 'HOLIDAY') continue;
      const holiday = timetableHolidaySchema.parse(raw);
      if (holiday.status !== 'REGULAR')
        throw new AppError('WEBUNTIS_UNKNOWN_HOLIDAY_STATUS', 502);
      if (!holiday.isFullDay || !holiday.durationTotal) {
        // A daily slice cannot establish the full holiday's start/end. Keep the
        // RPC result or previous stored event rather than shortening its duration.
        incomplete = true;
        continue;
      }
      const range = holidayRange(holiday.durationTotal);
      const date = isoDate(day.date);
      if (date < range.startDate || date > range.endDate)
        throw new AppError('WEBUNTIS_INVALID_HOLIDAY_RANGE', 502);
      holidays.push({
        id: holiday.id,
        name: holiday.shortName ?? undefined,
        longName: holiday.longName ?? undefined,
        ...range,
      });
    }
  }
  return { holidays, incomplete };
}

/** Repeated background slices and RPC records share the same holiday namespace.
 * Keep RPC naming for known IDs; disagreeing full ranges are unsafe to publish.
 * Equal names/ranges under different IDs are consolidated by normalizeHolidays.
 */
export function mergeHolidays(rpc: Holiday[], timetable: Holiday[]): Holiday[] {
  const byId = new Map<string, Holiday>();
  for (const holiday of [...rpc, ...timetable]) {
    const id = String(holiday.id);
    const existing = byId.get(id);
    if (existing) {
      if (
        isoDate(existing.startDate) !== isoDate(holiday.startDate) ||
        isoDate(existing.endDate) !== isoDate(holiday.endDate)
      )
        throw new AppError('WEBUNTIS_CONFLICTING_HOLIDAY', 502);
    } else {
      byId.set(id, holiday);
    }
  }
  return [...byId.values()];
}
