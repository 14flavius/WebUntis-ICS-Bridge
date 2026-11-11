import { randomUUID } from 'node:crypto';
import type {
  CalendarEvent,
  ExamCandidate,
  Snapshot,
} from '../shared/events.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { originalIds } from './identities.js';
import { matchExams, type ExamIdentity } from './webuntis/exam-matching.js';
import { includeCachedTimetable } from './webuntis/exam-snapshots.js';
import { refreshStoredLabels } from './webuntis/stored-labels.js';

export function cachedTimetableExams(
  db: Db,
  accountId: string,
): CalendarEvent[] {
  const rows = db
    .prepare(
      "SELECT payload FROM events WHERE accountId=? AND category='lesson' AND deleted=0",
    )
    .all(accountId) as { payload: string }[];
  return rows
    .map((row) => JSON.parse(row.payload) as CalendarEvent)
    .filter((event) => event.kind === 'exam')
    .map(refreshStoredLabels);
}

export function examIdentities(db: Db, accountId: string): ExamIdentity[] {
  const rows = db
    .prepare('SELECT id, payload FROM exam_identities WHERE accountId = ?')
    .all(accountId) as { id: string; payload: string }[];
  return rows.map((row) => ({
    ...(JSON.parse(row.payload) as ExamCandidate),
    id: row.id,
  }));
}
function targetMatches(event: CalendarEvent, ids: string[]) {
  return originalIds(event).some((id) => ids.includes(id));
}
function validateCandidate(candidate: ExamCandidate, snapshot: Snapshot) {
  const { event } = candidate;
  if (
    snapshot.category !== 'exam' ||
    event.category !== 'exam' ||
    !event.sourceId.startsWith('exam:') ||
    !candidate.schoolYearId ||
    event.date < snapshot.start ||
    event.date > snapshot.end
  )
    throw new AppError('WEBUNTIS_INVALID_EXAM_CANDIDATE', 502);
}

/** Runs inside the event transaction: identity allocation and event publication
 * must succeed together. Never use a hash of mutable fields as a calendar UID. */
export function prepareExamIdentities(
  db: Db,
  accountId: string,
  incoming: Snapshot[],
) {
  const snapshots = includeCachedTimetable(
    incoming,
    cachedTimetableExams(db, accountId),
  );
  const owners = new Map<ExamCandidate, Snapshot>();
  for (const snapshot of snapshots) {
    for (const candidate of snapshot.examCandidates ?? []) {
      validateCandidate(candidate, snapshot);
      owners.set(candidate, snapshot);
    }
  }
  const previous = examIdentities(db, accountId);
  const lessons = snapshots
    .filter((snapshot) => snapshot.category === 'lesson')
    .flatMap((snapshot) => snapshot.events);
  const plan = matchExams([...owners.keys()], previous, lessons);
  const protectedIds = plan.protectedIds;
  // Without a source ID, disappearance is not reliable deletion evidence.
  // Retain standalone exams until they age out of the feed's date range.
  for (const record of previous) {
    if (!record.targetIds?.length && record.event.sourceId === 'exam:0')
      protectedIds.add(record.id);
  }
  const ambiguous = new Set(plan.ambiguous);
  const accepted = [...plan.matches.keys(), ...plan.created];
  for (const candidate of accepted) {
    const old = plan.matches.get(candidate);
    const targetIds = candidate.targetIds ?? old?.targetIds ?? [];
    const targetSnapshot = snapshots.find(
      (snapshot) =>
        snapshot.category === 'lesson' &&
        snapshot.events.some((event) => targetMatches(event, targetIds)),
    );
    if (
      (!candidate.targetIds && targetSnapshot) ||
      (candidate.targetIds && !targetSnapshot)
    ) {
      // A formerly linked lesson changed classification or the source changed
      // mid-fetch. Do not publish a second exam beside the current lesson.
      ambiguous.add(candidate);
      if (old) protectedIds.add(old.id);
      continue;
    }
    const id = old?.id ?? `exam-local:${randomUUID()}`;
    const record: ExamCandidate = {
      ...candidate,
      targetIds: targetIds.length ? targetIds : undefined,
    };
    db.prepare(
      `INSERT INTO exam_identities (accountId, id, payload) VALUES (?, ?, ?)
      ON CONFLICT(accountId, id) DO UPDATE SET payload=excluded.payload`,
    ).run(accountId, id, JSON.stringify(record));
    const owner = owners.get(candidate)!;
    owner.events = owner.events.filter(
      (event) => event.sourceId !== candidate.event.sourceId,
    );
    if (targetSnapshot) {
      targetSnapshot.events = targetSnapshot.events.map((event) => {
        if (!targetMatches(event, targetIds)) return event;
        return {
          ...event,
          sourceIds: [...new Set([...originalIds(event), id])],
        };
      });
    } else {
      const sourceIds = [id];
      let sourceId = id;
      if (candidate.event.sourceId !== 'exam:0') {
        sourceId = candidate.event.sourceId;
        sourceIds.unshift(sourceId);
      }
      owner.events.push({ ...candidate.event, sourceId, sourceIds });
    }
  }
  for (const candidate of ambiguous) {
    const owner = owners.get(candidate)!;
    owner.deletionCoverage = false;
    if (candidate.event.sourceId !== 'exam:0') {
      owner.events = owner.events.filter(
        (event) => event.sourceId !== candidate.event.sourceId,
      );
      protectedIds.add(candidate.event.sourceId);
    }
    for (const snapshot of snapshots) {
      if (!candidate.targetIds?.length || snapshot.category !== 'lesson')
        continue;
      const withheld = snapshot.events.filter((event) =>
        targetMatches(event, candidate.targetIds!),
      );
      if (!withheld.length) continue;
      snapshot.events = snapshot.events.filter(
        (event) => !withheld.includes(event),
      );
      snapshot.deletionCoverage = false;
      for (const id of candidate.targetIds) protectedIds.add(id);
    }
  }
  const aliases = db
    .prepare(
      'SELECT originalId, sourceId FROM event_aliases WHERE accountId = ?',
    )
    .all(accountId) as { originalId: string; sourceId: string }[];
  for (const alias of aliases) {
    if (protectedIds.has(alias.originalId)) protectedIds.add(alias.sourceId);
  }
  return {
    snapshots,
    protectedIds,
    warnings: ambiguous.size ? ['EXAMS_AMBIGUOUS'] : [],
  };
}
