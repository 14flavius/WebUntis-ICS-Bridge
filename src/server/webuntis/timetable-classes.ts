import { DateTime } from 'luxon';
import { isoDate, normalizeRpc } from './normalize.js';
import { entryPositions, type TimetableEntry } from './resources.js';
import type { RpcLesson, Timetable } from './schemas.js';

function lacksClass(entry: TimetableEntry): boolean {
  return !entryPositions(entry).some(
    ({ current }) => current?.type === 'CLASS',
  );
}

function classNames(lesson: RpcLesson) {
  return (lesson.kl ?? [])
    .map((item) => ({
      id: String(item.id),
      type: 'CLASS' as const,
      shortName: item.name?.trim() ?? '',
      longName: item.longname?.trim() ?? '',
    }))
    .filter((item) => item.shortName || item.longName)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** REST positions remain authoritative. Missing classes may be filled only
 * when every source period matches by ID/date within the same outer time span,
 * with identical class assignments throughout a grouped lesson. */
export async function enrichTimetableClasses(
  timetable: Timetable,
  timezone: string,
  load: () => Promise<RpcLesson[]>,
): Promise<Timetable> {
  const entries = timetable.days
    .filter((day) => day.status === 'REGULAR')
    .flatMap((day) => day.gridEntries.filter(lacksClass));
  if (!entries.length) return timetable;
  const lessons = await load();
  const normalized = normalizeRpc(lessons, { name: '', timezone });
  const periods = new Map<
    string,
    { lesson: RpcLesson; start: string; end: string }[]
  >();
  lessons.forEach((lesson, index) => {
    const key = `${isoDate(lesson.date)}/${lesson.id}`;
    const matches = periods.get(key) ?? [];
    matches.push({
      lesson,
      start: normalized[index].start,
      end: normalized[index].end,
    });
    periods.set(key, matches);
  });
  const result = structuredClone(timetable);
  for (const day of result.days) {
    if (day.status !== 'REGULAR') continue;
    for (const entry of day.gridEntries) {
      if (!lacksClass(entry)) continue;
      const ids = entry.ids ?? (entry.id === undefined ? [] : [entry.id]);
      if (!ids.length) continue;
      const matches = ids.map((id) =>
        periods.get(`${isoDate(day.date)}/${id}`),
      );
      if (matches.some((items) => items?.length !== 1)) continue;
      const ordered = matches
        .map((items) => items![0])
        .sort((left, right) => left.start.localeCompare(right.start));
      const names = classNames(ordered[0].lesson);
      if (
        !names.length ||
        ordered.some(
          ({ lesson }) =>
            JSON.stringify(classNames(lesson)) !== JSON.stringify(names),
        )
      )
        continue;
      const start = DateTime.fromISO(entry.duration.start, { zone: timezone })
        .toUTC()
        .toISO();
      const end = DateTime.fromISO(entry.duration.end, { zone: timezone })
        .toUTC()
        .toISO();
      if (!start || !end) continue;
      // REST groups may span school breaks. Exact period IDs establish
      // membership; require matching outer bounds, not uninterrupted teaching.
      const matchingBounds =
        ordered[0].start === start &&
        ordered.some((period) => period.end === end);
      const withinBounds = ordered.every(
        (period) => period.start >= start && period.end <= end,
      );
      if (matchingBounds && withinBounds)
        entry.classDetails = names.map(({ type, shortName, longName }) => ({
          type,
          shortName,
          longName,
        }));
    }
  }
  return result;
}
