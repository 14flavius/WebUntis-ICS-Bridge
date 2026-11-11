import { z } from 'zod';
import type { CalendarEvent } from '../../shared/events.js';
import { entrySchema, rpcTimetableSchema } from './schemas.js';
import { entryPositions } from './resources.js';
import { positionLabel } from './normalize.js';

const enrichedSource = z.object({ timetable: entrySchema });

/** Reapply label rules to an existing source, including dates now inaccessible
 * upstream. Never infer new schedule data, change identity or grant coverage. */
export function refreshStoredLabels(event: CalendarEvent): CalendarEvent {
  if (event.category !== 'lesson') return event;
  const source: unknown = JSON.parse(event.source);
  const enriched = enrichedSource.safeParse(source);
  const parsed = entrySchema.safeParse(source);
  const entry = enriched.success ? enriched.data.timetable : parsed.data;
  const values = { ...event.values };
  if (entry) {
    for (const [type, field] of [
      ['ROOM', 'room'],
      ['CLASS', 'class'],
    ] as const) {
      const labels: string[] = [];
      for (const { current } of entryPositions(entry)) {
        if (current?.type === type) labels.push(positionLabel(current));
      }
      // Missing positions may have been enriched from the separate exam API.
      if (labels.length)
        values[field] = [...new Set(labels)].filter(Boolean).join(', ');
    }
    if (event.kind === 'exam' && entry.examDetails?.typeLongName)
      values.examType = entry.examDetails.typeLongName;
  } else {
    const rpc = rpcTimetableSchema.element.safeParse(source);
    if (!rpc.success) return event;
    if (rpc.data.ro.length)
      values.room = rpc.data.ro
        .map((room) => room.name || room.longname || '')
        .filter(Boolean)
        .join(', ');
    if (rpc.data.kl?.length)
      values.class = rpc.data.kl
        .map((group) => group.name || group.longname || '')
        .filter(Boolean)
        .join(', ');
  }
  if (
    values.room === event.values.room &&
    values.class === event.values.class &&
    values.examType === event.values.examType
  )
    return event;
  return { ...event, values };
}
