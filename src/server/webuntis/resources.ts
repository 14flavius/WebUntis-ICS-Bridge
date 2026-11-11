import { positionKeys, type Timetable } from './schemas.js';

export type TimetableEntry = Timetable['days'][number]['gridEntries'][number];

export function entryPositions(entry: TimetableEntry) {
  const positions = positionKeys.flatMap((key) => entry[key] ?? []);
  if (!positions.some(({ current }) => current?.type === 'CLASS'))
    positions.push(
      ...(entry.classDetails ?? []).map((current) => ({ current })),
    );
  return positions;
}
