import { z } from 'zod';
import {
  nameFields,
  nameVariants,
  variables,
  type CalendarEvent,
  type EventValues,
  type NameField,
  type NameVariant,
} from '../../shared/events.js';
import { entrySchema, examsSchema, rpcTimetableSchema } from './schemas.js';
import { entryPositions } from './resources.js';

interface Names {
  shortName?: string;
  longName?: string;
  displayName?: string;
}
const resourceFields: Record<string, NameField | undefined> = {
  SUBJECT: 'subject',
  TEACHER: 'teacher',
  CLASS: 'class',
  ROOM: 'room',
};
const enrichedSource = z.object({ timetable: entrySchema });
const examSource = examsSchema.shape.data.shape.exams.element;

function sourceNames(event: CalendarEvent): Map<NameField, Names[]> {
  const resources = new Map<NameField, Names[]>();
  const add = (field: NameField, names: Names) => {
    const items = resources.get(field) ?? [];
    items.push(names);
    resources.set(field, items);
  };
  const source: unknown = JSON.parse(event.source);
  const entry =
    enrichedSource.safeParse(source).data?.timetable ??
    entrySchema.safeParse(source).data;
  if (entry && event.category === 'lesson') {
    for (const position of entryPositions(entry)) {
      const current = position.current;
      const field = current && resourceFields[current.type];
      if (current && field) add(field, current);
      if (position.removed?.type === 'TEACHER')
        add('originalTeacher', position.removed);
    }
  } else if (event.category === 'lesson') {
    const rpc = rpcTimetableSchema.element.safeParse(source).data;
    if (rpc) {
      for (const [field, items] of [
        ['subject', rpc.su],
        ['teacher', rpc.te],
        ['class', rpc.kl ?? []],
        ['room', rpc.ro],
      ] as const) {
        for (const item of items)
          add(field, { shortName: item.name, longName: item.longname });
      }
      for (const teacher of rpc.te) {
        if (teacher.orgname)
          add('originalTeacher', { shortName: teacher.orgname });
      }
    }
  } else if (event.category === 'exam') {
    const exam = examSource.safeParse(source).data;
    if (exam) {
      for (const [field, items] of [
        ['teacher', exam.teachers ?? []],
        ['room', exam.rooms ?? []],
      ] as const) {
        for (const item of items)
          add(
            field,
            typeof item === 'string'
              ? { shortName: item }
              : { shortName: item.name, longName: item.longName },
          );
      }
      if (exam.subject) add('subject', { shortName: exam.subject });
      for (const group of exam.studentClass ?? [])
        add('class', { shortName: group });
    }
  }
  if (event.kind === 'substitution' && resources.has('teacher'))
    resources.set('substituteTeacher', resources.get('teacher')!);
  return resources;
}

function variantLabel(
  item: Names,
  field: NameField,
  variant: NameVariant,
): string {
  const short = item.shortName?.trim();
  const long = item.longName?.trim();
  const display = item.displayName?.trim();
  if (variant === 'Short') {
    if (field === 'room' || field === 'class')
      return short || display || long || '';
    return short || long || display || '';
  }
  if (variant === 'Long') return long || short || display || '';
  return display || long || short || '';
}

/** Resolve variants from validated stored sources at render time. Historical
 * snapshots need neither a destructive migration nor another WebUntis request. */
export function eventTemplateValues(event: CalendarEvent): EventValues {
  const values = Object.fromEntries(
    variables.map((key) => [key, event.values[key] ?? '']),
  ) as EventValues;
  const resources = sourceNames(event);
  for (const field of nameFields) {
    const items = resources.get(field);
    for (const variant of nameVariants) {
      const key = `${field}${variant}` as const;
      if (!items?.length) {
        values[key] ||= values[field];
        continue;
      }
      const labels = items
        .map((item) => variantLabel(item, field, variant))
        .filter(Boolean);
      values[key] = [...new Set(labels)].join(', ') || values[field];
    }
  }
  return values;
}
