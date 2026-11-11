import { z } from 'zod';
import type { StoredEvent } from '../shared/events.js';
import type { Db } from './db.js';
import { storedEvents } from './events.js';
import { applyExamSources } from './exam-feeds.js';
import { entrySchema } from './webuntis/schemas.js';
import { teachingKind } from './webuntis/normalize.js';

const enrichedSource = z.object({ timetable: entrySchema });

function teachingEvent(event: StoredEvent): StoredEvent {
  const source: unknown = JSON.parse(event.source);
  const entry =
    enrichedSource.safeParse(source).data?.timetable ??
    entrySchema.safeParse(source).data;
  const kind = teachingKind(
    entry?.status ?? 'REGULAR',
    event.values.originalTeacher,
  );
  return {
    ...event,
    kind,
    values: {
      ...event.values,
      examName: '',
      examType: '',
      examText: '',
      substituteTeacher: kind === 'substitution' ? event.values.teacher : '',
    },
  };
}

/** A timetable exam is both teaching and an assessment. Keep the timetable
 * identity for teaching even when exam visibility/source changes. Publish the
 * selected assessment independently, without inventing teaching for tab-only
 * exams or changing stored source data and synchronization identities. */
export function calendarEvents(db: Db): StoredEvent[] {
  const events = storedEvents(db);
  const selected = applyExamSources(db, events).map((event) => {
    if (event.category !== 'lesson' || event.kind !== 'exam') return event;
    const sourceId = `timetable-exam:${event.sourceId}`;
    return { ...event, sourceId, sourceIds: [sourceId] };
  });
  selected.push(
    ...events
      .filter((event) => event.category === 'lesson' && event.kind === 'exam')
      .map(teachingEvent),
  );
  return selected.sort(
    (left, right) =>
      left.accountId.localeCompare(right.accountId) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}
