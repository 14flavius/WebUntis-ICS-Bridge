import type { CalendarEvent, ExamCandidate } from '../../shared/events.js';
import { z } from 'zod';
import { entrySchema, positionKeys } from './schemas.js';
import { uniqueText } from './normalize.js';

const UNIDENTIFIED_EXAM = 'exam:0';
function subjectNames(event: CalendarEvent): Set<string> {
  const names = new Set([event.values.subject.trim().toLowerCase()]);
  const source: unknown = JSON.parse(event.source);
  const enriched = z.object({ timetable: entrySchema }).safeParse(source);
  const parsed = entrySchema.safeParse(source);
  const entry = enriched.success ? enriched.data.timetable : parsed.data;
  if (!entry) return names;
  for (const key of positionKeys) {
    for (const { current } of entry[key] ?? []) {
      if (current?.type !== 'SUBJECT') continue;
      for (const name of [
        current.shortName,
        current.longName,
        current.displayName,
      ]) {
        if (name?.trim()) names.add(name.trim().toLowerCase());
      }
    }
  }
  return names;
}

/** Only explicit timetable exams qualify. Same-subject all-day observations may
 * enrich a unique exam on that date; timed observations need identical bounds
 * or containment with a shared boundary. Mere overlap is not a match.
 */
export function reconcileExams(
  timetable: CalendarEvent[],
  exams: CalendarEvent[],
  schoolYearId = '',
) {
  const candidates = timetable.filter((event) => event.kind === 'exam');
  const matches = new Map<CalendarEvent, CalendarEvent[]>();
  for (const exam of exams) {
    matches.set(
      exam,
      candidates.filter((candidate) => matchesTimetable(exam, candidate)),
    );
  }
  const replacements = new Map<CalendarEvent, CalendarEvent>();
  const remaining: CalendarEvent[] = [];
  const identityCandidates: ExamCandidate[] = [];
  for (const exam of exams) {
    const matching = matches.get(exam)!;
    const candidate = matching[0];
    const unique =
      matching.length === 1 &&
      [...matches.values()].filter((items) => items.includes(candidate))
        .length === 1;
    if (!unique) {
      const subject = exam.values.subject.trim().toLowerCase();
      const overlapsTimetable = candidates.some(
        (candidate) =>
          candidate.date === exam.date &&
          subjectNames(candidate).has(subject) &&
          (exam.allDay ||
            (candidate.start < exam.end && candidate.end > exam.start)),
      );
      identityCandidates.push({
        event: exam,
        schoolYearId,
        blocked: matching.length > 0 || overlapsTimetable,
      });
      remaining.push(exam);
      continue;
    }
    identityCandidates.push({
      event: exam,
      schoolYearId,
      targetIds: (candidate.sourceIds ?? [candidate.sourceId]).filter((id) =>
        id.startsWith('lesson:'),
      ),
    });
    const source = timetableSource(candidate);
    const detailedType =
      entrySchema.safeParse(source).data?.examDetails?.typeLongName;
    replacements.set(candidate, {
      ...candidate,
      sourceIds: [
        ...new Set([
          ...(candidate.sourceIds ?? [candidate.sourceId]),
          // The placeholder is shared by unrelated exams and is never an alias.
          ...(exam.sourceId === UNIDENTIFIED_EXAM ? [] : [exam.sourceId]),
        ]),
      ],
      values: {
        ...candidate.values,
        examName: exam.values.examName || candidate.values.examName,
        examType:
          detailedType || exam.values.examType || candidate.values.examType,
        examText: uniqueText([candidate.values.examText, exam.values.examText]),
        teacher: candidate.values.teacher || exam.values.teacher,
        room: candidate.values.room || exam.values.room,
      },
      source: JSON.stringify({
        timetable: source,
        exam: JSON.parse(exam.source),
      }),
    });
  }
  return {
    timetable: timetable.map((event) => replacements.get(event) ?? event),
    exams: remaining,
    identityCandidates,
  };
}

function timetableSource(event: CalendarEvent): unknown {
  const source: unknown = JSON.parse(event.source);
  const enriched = z.object({ timetable: entrySchema }).safeParse(source);
  return enriched.success ? enriched.data.timetable : source;
}

function matchesTimetable(exam: CalendarEvent, candidate: CalendarEvent) {
  const subject = exam.values.subject.trim().toLowerCase();
  if (
    !subject ||
    exam.date !== candidate.date ||
    !subjectNames(candidate).has(subject)
  )
    return false;
  if (exam.allDay) return true;
  const sharedBoundary =
    exam.start === candidate.start || exam.end === candidate.end;
  const contained =
    (exam.start >= candidate.start && exam.end <= candidate.end) ||
    (candidate.start >= exam.start && candidate.end <= exam.end);
  return sharedBoundary && contained;
}
