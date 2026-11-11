import type { CalendarEvent, ExamCandidate } from '../../shared/events.js';
import { AppError } from '../errors.js';

export interface ExamIdentity extends ExamCandidate {
  id: string;
}

const EXAM_MOVE_LIMIT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function text(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
function sameSubject(a: ExamCandidate, b: ExamCandidate): boolean {
  const subject = text(a.event.values.subject);
  return !!subject && subject === text(b.event.values.subject);
}
function sameName(a: ExamCandidate, b: ExamCandidate): boolean {
  const name = text(a.event.values.examName);
  return !!name && name === text(b.event.values.examName);
}
function sameType(a: ExamCandidate, b: ExamCandidate): boolean {
  return text(a.event.values.examType) === text(b.event.values.examType);
}
function sameTime(a: ExamCandidate, b: ExamCandidate): boolean {
  return (
    a.event.start === b.event.start &&
    a.event.end === b.event.end &&
    a.event.allDay === b.event.allDay
  );
}
function nearby(a: ExamCandidate, b: ExamCandidate): boolean {
  const days =
    Math.abs(Date.parse(a.event.date) - Date.parse(b.event.date)) / DAY_MS;
  return (
    a.schoolYearId === b.schoolYearId &&
    compatibleSource(a, b) &&
    days <= EXAM_MOVE_LIMIT_DAYS
  );
}
function nativeId(candidate: ExamCandidate): string | undefined {
  if (candidate.event.sourceId !== 'exam:0') return candidate.event.sourceId;
}
function compatibleSource(a: ExamCandidate, b: ExamCandidate): boolean {
  return !nativeId(a) || !nativeId(b) || nativeId(a) === nativeId(b);
}
function sameSource(a: ExamCandidate, b: ExamCandidate): boolean {
  return (
    a.schoolYearId === b.schoolYearId &&
    !!nativeId(a) &&
    nativeId(a) === nativeId(b)
  );
}
function samePeriod(a: ExamCandidate, b: ExamCandidate): boolean {
  return (
    a.schoolYearId === b.schoolYearId &&
    compatibleSource(a, b) &&
    !!a.targetIds?.some((id) => b.targetIds?.includes(id))
  );
}
function exact(a: ExamCandidate, b: ExamCandidate): boolean {
  return (
    nearby(a, b) &&
    sameTime(a, b) &&
    sameSubject(a, b) &&
    sameName(a, b) &&
    sameType(a, b)
  );
}
function changed(a: ExamCandidate, b: ExamCandidate): boolean {
  if (!nearby(a, b) || !sameSubject(a, b) || !sameType(a, b)) return false;
  // A rename needs a stable timed slot. Moving needs an unchanged name and
  // category. Changing both name and date has no sufficiently strong anchor.
  const renamed = !a.event.allDay && sameTime(a, b);
  const moved = sameName(a, b) && a.event.allDay === b.event.allDay;
  return renamed || moved;
}
function plausible(a: ExamCandidate, b: ExamCandidate): boolean {
  return nearby(a, b) && (sameSubject(a, b) || sameName(a, b));
}
function duplicateSlot(a: ExamCandidate, b: ExamCandidate): boolean {
  if (nativeId(a) && nativeId(b)) return nativeId(a) === nativeId(b);
  if (samePeriod(a, b)) return true;
  return (
    a.schoolYearId === b.schoolYearId &&
    sameTime(a, b) &&
    (sameSubject(a, b) || sameName(a, b))
  );
}

/** Build a deterministic, one-to-one plan without allocating IDs or writing.
 * Exact anchors are assigned before bounded changes. No scores, edit-distance
 * guesses, array-order tie breaks or matches across accounts/school years. */
export function matchExams(
  incoming: ExamCandidate[],
  previous: ExamIdentity[],
  timetable: CalendarEvent[] = [],
) {
  const matches = new Map<ExamCandidate, ExamIdentity>();
  const ambiguous = new Set<ExamCandidate>();
  const used = new Set<string>();
  const sourceIds = new Set<string>();
  for (const candidate of incoming) {
    const sourceId = nativeId(candidate);
    if (sourceId && sourceIds.has(sourceId))
      throw new AppError('WEBUNTIS_CONFLICTING_ID', 502);
    if (sourceId) sourceIds.add(sourceId);
    if (
      candidate.blocked ||
      incoming.some(
        (other) => other !== candidate && duplicateSlot(candidate, other),
      )
    )
      ambiguous.add(candidate);
  }
  const protectedIds = new Set<string>();
  for (const candidate of ambiguous) {
    for (const record of previous) {
      if (
        sameSource(candidate, record) ||
        samePeriod(candidate, record) ||
        plausible(candidate, record)
      )
        protectedIds.add(record.id);
    }
  }
  for (const rule of [sameSource, samePeriod, exact, changed]) {
    const candidates = incoming.filter(
      (candidate) => !matches.has(candidate) && !ambiguous.has(candidate),
    );
    const available = previous.filter(
      (record) => !used.has(record.id) && !protectedIds.has(record.id),
    );
    const possible = new Map(
      candidates.map((candidate) => [
        candidate,
        available.filter((record) => rule(candidate, record)),
      ]),
    );
    for (const candidate of candidates) {
      const records = possible.get(candidate)!;
      const sharedAnchor = records.some((record) =>
        candidates.some(
          (other) =>
            other !== candidate && possible.get(other)!.includes(record),
        ),
      );
      if (
        (rule === sameSource || rule === samePeriod) &&
        (records.length > 1 || sharedAnchor)
      ) {
        ambiguous.add(candidate);
        for (const record of records) protectedIds.add(record.id);
        continue;
      }
      if (records.length !== 1) continue;
      const record = records[0];
      const claimants = candidates.filter((other) =>
        rule === changed
          ? plausible(other, record)
          : possible.get(other)!.includes(record),
      );
      if (claimants.length !== 1) continue;
      matches.set(candidate, record);
      used.add(record.id);
    }
  }
  for (const [candidate, old] of matches) {
    const linkedLessonChanged =
      !candidate.targetIds?.length &&
      timetable.some((event) =>
        (event.sourceIds ?? [event.sourceId]).some((id) =>
          old.targetIds?.includes(id),
        ),
      );
    if (linkedLessonChanged) {
      matches.delete(candidate);
      ambiguous.add(candidate);
    }
  }
  const created: ExamCandidate[] = [];
  for (const candidate of incoming) {
    if (matches.has(candidate) || ambiguous.has(candidate)) continue;
    const potential = previous.some(
      (record) => !used.has(record.id) && plausible(candidate, record),
    );
    const identifiable =
      !!nativeId(candidate) ||
      !!candidate.targetIds?.length ||
      (!!text(candidate.event.values.subject) &&
        !!text(candidate.event.values.examName));
    if (potential || !identifiable) ambiguous.add(candidate);
    else created.push(candidate);
  }
  // All possible histories stay protected when an observation is unresolved.
  for (const candidate of ambiguous) {
    for (const record of previous) {
      if (
        sameSource(candidate, record) ||
        samePeriod(candidate, record) ||
        plausible(candidate, record)
      )
        protectedIds.add(record.id);
    }
  }
  return { matches, created, ambiguous, protectedIds };
}
