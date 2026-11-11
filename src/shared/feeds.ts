import { z } from 'zod';
import { templateError } from './templates.js';
import { eventKinds } from './events.js';
import { languageSchema, type Language } from './types.js';

const templateText = (max: number) =>
  z
    .string()
    .max(max)
    .superRefine((value, context) => {
      const error = templateError(value);
      if (error) context.addIssue({ code: 'custom', message: error });
    });
const templateSchema = z.object({
  title: templateText(2000),
  description: templateText(10000),
  location: templateText(2000),
});
const templatesSchema = z.record(z.enum(eventKinds), templateSchema);
type Templates = z.infer<typeof templatesSchema>;
export const PREVIEW_EVENTS_PER_KIND = 4;
export const feedInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    pastDays: z.number().int().min(0).max(365).default(14),
    futureDays: z.number().int().min(1).max(365).default(90),
    language: languageSchema.default('en'),
    cancellation: z.enum(['mark', 'omit', 'cancel']).default('mark'),
    sources: z
      .array(
        z.object({
          accountId: z.uuid(),
          kinds: z.array(z.enum(eventKinds)).min(1),
        }),
      )
      .max(100),
    templates: templatesSchema,
  })
  .refine((feed) => !feed.enabled || feed.sources.length > 0, {
    message: 'An active feed needs at least one account',
  })
  .refine(
    (feed) =>
      new Set(feed.sources.map((source) => source.accountId)).size ===
      feed.sources.length,
    { message: 'Each account can appear only once' },
  );
export type FeedInput = z.infer<typeof feedInput>;
export interface Feed extends FeedInput {
  id: string;
  token: string;
  modifiedAt: string;
}
export function defaultTemplates(language: Language): Templates {
  const labels =
    language === 'de'
      ? {
          subject: 'Fach',
          teacher: 'Lehrkraft',
          class: 'Klasse',
          original: 'Ursprüngliche Lehrkraft',
          exam: 'Prüfungsart',
          location: 'Standort',
          note: 'Notiz',
        }
      : {
          subject: 'Subject',
          teacher: 'Teacher',
          class: 'Class',
          original: 'Original teacher',
          exam: 'Exam type',
          location: 'Location',
          note: 'Note',
        };
  const details = `[[${labels.subject}: {{subjectLong}}\n]][[${labels.teacher}: {{teacherDisplay}}\n]][[${labels.class}: {{classShort}}\n]]`;
  const locationNote = `[[${labels.location}: {{roomShort}}]]`;
  const infoNote = `[[${labels.note}: {{info}}\n]]`;
  const lesson = {
    title: '{{subjectShort | teacherShort}} [[({{classShort}})]]',
    description: details + infoNote + locationNote,
    location: '{{roomShort}}',
  };
  return {
    lesson,
    cancelled: {
      ...lesson,
      title: '{{status | subjectShort | teacherShort}} [[({{classShort}})]]',
    },
    substitution: {
      ...lesson,
      title:
        '{{status | subjectShort | substituteTeacherShort}} [[({{classShort}})]]',
      description:
        details +
        `[[${labels.original}: {{originalTeacherDisplay}}\n]]` +
        infoNote +
        locationNote,
    },
    exam: {
      title: '{{examName | subjectShort | teacherShort}} [[({{classShort}})]]',
      description:
        details +
        `[[${labels.exam}: {{examType}}\n]][[${labels.note}: {{examText}}\n]]` +
        locationNote,
      location: '{{roomShort}}',
    },
    holiday: {
      title: '{{holidayName}}',
      description: language === 'de' ? 'Unterrichtsfrei' : 'No lessons',
      location: '',
    },
  };
}
