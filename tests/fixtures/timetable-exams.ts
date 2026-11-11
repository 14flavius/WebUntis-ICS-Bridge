import { timetableSchema } from '../../src/server/webuntis/schemas.js';

// Anonymized structure from the user-supplied format=1 response. No student,
// teacher, school or image identifiers from that response are retained.
export function examTimetableFixture() {
  return timetableSchema.parse({
    format: 1,
    errors: [],
    days: [
      {
        date: '2026-10-20',
        status: 'REGULAR',
        gridEntries: [
          {
            ids: [101, 102],
            type: 'EXAM',
            status: 'REGULAR',
            name: null,
            duration: { start: '2026-10-20T08:00', end: '2026-10-20T09:30' },
            position1: [
              {
                current: {
                  type: 'SUBJECT',
                  shortName: 'Math',
                  longName: 'Mathematics',
                  displayName: 'Math',
                },
                removed: null,
              },
            ],
            position2: [
              { current: { type: 'ROOM', shortName: '101' }, removed: null },
            ],
            position3: null,
            position4: null,
            position5: null,
            position6: null,
            position7: null,
            notesAll: 'Test topics: algebra',
            lessonInfo: 'Written assessment',
            lessonText: '',
            substitutionText: '',
            texts: [
              { type: 'NOTES_FOR_ALL', text: 'Test topics: algebra' },
              { type: 'LESSON_INFO', text: 'Written assessment' },
            ],
          },
        ],
      },
    ],
  });
}
