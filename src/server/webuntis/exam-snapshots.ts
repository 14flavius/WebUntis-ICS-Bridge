import type { CalendarEvent, Snapshot } from '../../shared/events.js';
import { reconcileExams } from './exams.js';

/** A restricted/omitted timetable date has no fresh coverage. Its last valid
 * exams can still identify observations from the independently readable Exams
 * endpoint. Never resurrect lessons from dates with authoritative fresh data. */
export function includeCachedTimetable(
  snapshots: Snapshot[],
  cached: CalendarEvent[],
) {
  const eligible = cached.filter(
    (event) =>
      event.category === 'lesson' &&
      event.kind === 'exam' &&
      !snapshots.some(
        (snapshot) =>
          snapshot.category === 'lesson' &&
          event.date >= snapshot.start &&
          event.date <= snapshot.end,
      ),
  );
  const candidates = snapshots.flatMap(
    (snapshot) => snapshot.examCandidates ?? [],
  );
  const reconciled = reconcileExams(
    eligible,
    candidates.map((candidate) => candidate.event),
  );
  const byEvent = new Map(
    reconciled.identityCandidates.map((candidate) => [
      candidate.event,
      candidate,
    ]),
  );
  const linkedIds = new Set<string>();
  const result = snapshots.map((snapshot) => ({
    ...snapshot,
    events: [...snapshot.events],
    examCandidates: snapshot.examCandidates?.map((candidate) => {
      if (candidate.targetIds?.length) return candidate;
      const cachedMatch = byEvent.get(candidate.event)!;
      for (const id of cachedMatch.targetIds ?? []) linkedIds.add(id);
      return {
        ...candidate,
        blocked: candidate.blocked || cachedMatch.blocked,
        targetIds: cachedMatch.targetIds,
      };
    }),
  }));
  for (const event of reconciled.timetable) {
    if (!event.sourceIds?.some((id) => linkedIds.has(id))) continue;
    result.push({
      category: 'lesson',
      start: event.date,
      end: event.date,
      events: [event],
      confirmedEmptyDates: [],
      deletionCoverage: false,
      examCandidates: undefined,
    });
  }
  return result;
}
