import type { Timetable } from '../../src/server/webuntis/schemas.js';
import { normalizeTimetable } from '../../src/server/webuntis/normalize.js';
export const timetableFixture: Timetable = {
  days: [
    {
      date: '2026-10-20',
      status: 'REGULAR',
      gridEntries: [
        {
          ids: [101],
          status: 'REGULAR',
          duration: {
            start: '2026-10-20T08:00:00',
            end: '2026-10-20T08:45:00',
          },
          position1: [{ current: { type: 'SUBJECT', shortName: 'Math' } }],
          position2: [{ current: { type: 'TEACHER', shortName: 'Teacher A' } }],
          position3: [{ current: { type: 'ROOM', shortName: '101' } }],
          lessonInfo: 'Bring calculator',
        },
      ],
    },
  ],
};
export const context = { name: 'Student A', timezone: 'Europe/Berlin' };
export const lessonFixture = () =>
  normalizeTimetable(timetableFixture, context)[0];
