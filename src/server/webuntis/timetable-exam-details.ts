import { DateTime } from 'luxon';
import type { z } from 'zod';
import type { Timetable, calendarEntryDetailsSchema } from './schemas.js';
import { WebUntisError } from './client.js';
import { AppError } from '../errors.js';

type Details = z.infer<typeof calendarEntryDetailsSchema>;
type DetailLoader = (start: string, end: string) => Promise<Details>;

function timestamp(value: string, timezone: string): number {
  const date = DateTime.fromISO(value, { zone: timezone, setZone: true });
  if (!date.isValid) throw new AppError('WEBUNTIS_INVALID_TIME', 502);
  return date.toMillis();
}

/** Fetch details only for explicit timetable exams. Extra profile, homework,
 * attachment and attendance fields are discarded by the response schema.
 * Never match by subject alone or create a new event from a detail response. */
export async function enrichTimetableExamDetails(
  timetable: Timetable,
  timezone: string,
  load: DetailLoader,
): Promise<Timetable> {
  const result = structuredClone(timetable);
  const cache = new Map<string, Details>();
  for (const day of result.days) {
    if (day.status !== 'REGULAR') continue;
    for (const entry of day.gridEntries) {
      if (
        entry.type !== 'EXAM' ||
        ['CANCELLED', 'CANCELED'].includes(entry.status)
      )
        continue;
      const { start, end } = entry.duration;
      const key = `${start}/${end}`;
      let details = cache.get(key);
      if (!details) {
        try {
          details = await load(start, end);
          cache.set(key, details);
        } catch (error) {
          // Schools can disable this optional view independently of timetables.
          // Stop probing it for this window; retain the timetable's own fields.
          if (
            error instanceof WebUntisError &&
            ['forbidden', 'unavailable'].includes(error.status)
          )
            return result;
          throw error;
        }
      }
      const ids = new Set(
        (entry.ids ?? (entry.id === undefined ? [] : [entry.id])).map(String),
      );
      const matches = details.calendarEntries.filter(
        (detail) =>
          detail.type === 'EXAM' &&
          detail.exam &&
          ids.has(String(detail.id)) &&
          timestamp(detail.startDateTime, timezone) ===
            timestamp(start, timezone) &&
          timestamp(detail.endDateTime, timezone) === timestamp(end, timezone),
      );
      if (matches.length === 1) entry.examDetails = matches[0].exam!;
    }
  }
  return result;
}
