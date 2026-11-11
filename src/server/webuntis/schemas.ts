import { z } from 'zod';

const sourceId = z.union([z.string().min(1), z.number().int()]);
const dateValue = z.union([z.string(), z.number().int()]);
export const rpcEnvelope = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export const loginSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .regex(/^[\w.-]+$/),
  personId: z.number().int().positive(),
  personType: z.number().int(),
});
export const holidaySchema = z.object({
  id: sourceId,
  name: z.string().optional(),
  longName: z.string().optional(),
  longname: z.string().optional(),
  startDate: dateValue,
  endDate: dateValue,
});
export const schoolYearsSchema = z.array(
  z.object({
    id: sourceId,
    name: z.string(),
    dateRange: z.object({ start: z.string(), end: z.string() }),
  }),
);
export const rpcYearsSchema = z.array(
  z.object({
    id: sourceId,
    name: z.string(),
    startDate: dateValue,
    endDate: dateValue,
  }),
);
const positionItem = z.object({
  type: z.string(),
  shortName: z.string().optional(),
  longName: z.string().optional(),
  displayName: z.string().optional(),
});
export const positionKeys = [
  'position1',
  'position2',
  'position3',
  'position4',
  'position5',
  'position6',
  'position7',
] as const;
const position = z.array(
  z.object({
    current: positionItem.nullish(),
    removed: positionItem.nullish(),
  }),
);
const timetableExamDetails = z.object({
  name: z.string(),
  description: z.string().nullish(),
  typeLongName: z.string().nullish(),
});
export const calendarEntryDetailsSchema = z.object({
  calendarEntries: z.array(
    z.object({
      id: sourceId,
      type: z.string(),
      startDateTime: z.string(),
      endDateTime: z.string(),
      exam: timetableExamDetails.nullish(),
    }),
  ),
});
export const entrySchema = z.object({
  id: sourceId.optional(),
  ids: z.array(sourceId).optional(),
  lessonId: sourceId.optional(),
  duration: z.object({ start: z.string(), end: z.string() }),
  status: z.string(),
  type: z.string().optional(),
  position1: position.nullish(),
  position2: position.nullish(),
  position3: position.nullish(),
  position4: position.nullish(),
  position5: position.nullish(),
  position6: position.nullish(),
  position7: position.nullish(),
  substitutionText: z.string().nullish(),
  lessonInfo: z.string().nullish(),
  lessonText: z.string().nullish(),
  notesAll: z.string().nullish(),
  name: z.string().nullish(),
  examDetails: timetableExamDetails.optional(),
  classDetails: z
    .array(positionItem.extend({ type: z.literal('CLASS') }))
    .optional(),
  texts: z.array(z.object({ type: z.string(), text: z.string() })).nullish(),
});
export const timetableHolidaySchema = z.object({
  id: sourceId,
  type: z.literal('HOLIDAY'),
  status: z.string(),
  isFullDay: z.boolean(),
  duration: z.object({ start: z.string(), end: z.string() }),
  durationTotal: z.object({ start: z.string(), end: z.string() }).nullish(),
  shortName: z.string().nullish(),
  longName: z.string().nullish(),
});
export const timetableSchema = z.object({
  errors: z.array(z.unknown()).max(0).optional(),
  days: z.array(
    z.object({
      date: z.string(),
      status: z.string(),
      gridEntries: z.array(entrySchema),
      // Other background types are not calendar holidays. Validate HOLIDAY
      // fields separately before normalization, without guessing other types.
      backEntries: z
        .array(z.object({ type: z.string() }).passthrough())
        .optional(),
    }),
  ),
});
const named = z.union([
  z.string(),
  z.object({ name: z.string().optional(), longName: z.string().optional() }),
]);
export const examsSchema = z.object({
  data: z.object({
    exams: z.array(
      z.object({
        id: sourceId,
        examDate: dateValue,
        startTime: dateValue.optional(),
        endTime: dateValue.optional(),
        name: z.string(),
        subject: z.string().optional(),
        examType: named.optional(),
        text: z.string().optional(),
        description: z.string().optional(),
        teachers: z.array(named).optional(),
        rooms: z.array(named).optional(),
        studentClass: z.array(z.string()).optional(),
        assignedStudents: z.array(z.object({ id: sourceId })).optional(),
      }),
    ),
  }),
});
const rpcElement = z.object({
  id: sourceId,
  name: z.string().optional(),
  longname: z.string().optional(),
  orgid: sourceId.optional(),
  orgname: z.string().optional(),
});
export const rpcTimetableSchema = z.array(
  z.object({
    id: sourceId,
    date: dateValue,
    startTime: z.number(),
    endTime: z.number(),
    code: z.string().optional(),
    // WebUntis omits hidden resources instead of returning empty arrays.
    // Invalid values remain errors; only an absent field defaults to empty.
    su: z.array(rpcElement).default([]),
    te: z.array(rpcElement).default([]),
    ro: z.array(rpcElement).default([]),
    kl: z.array(rpcElement).optional(),
    substText: z.string().optional(),
    lstext: z.string().optional(),
    info: z.string().optional(),
  }),
);
export type Timetable = z.infer<typeof timetableSchema>;
export type Exam = z.infer<typeof examsSchema>['data']['exams'][number];
export type Holiday = z.infer<typeof holidaySchema>;
export type RpcLesson = z.infer<typeof rpcTimetableSchema>[number];
