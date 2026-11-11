import { timetableSchema } from '../../src/server/webuntis/schemas.js';

// Structural fixture from the supplied response, with synthetic identifiers.
export function holidayTimetableFixture() {
  return timetableSchema.parse({
    format: 11,
    errors: [],
    days: [2, 3, 4, 5, 6].map((day) => ({
      date: `2026-11-0${day}`,
      status: 'REGULAR',
      gridEntries: [],
      backEntries: [
        {
          id: 901,
          type: 'HOLIDAY',
          status: 'REGULAR',
          statusDetail: 'NOT_BOOKABLE',
          isFullDay: true,
          duration: {
            start: `2026-11-0${day}T00:00`,
            end: `2026-11-0${day}T23:59:59`,
          },
          durationTotal: {
            start: '2026-11-02T00:00',
            end: '2026-11-08T23:59:59',
          },
          shortName: 'AB',
          longName: 'Autumn break',
        },
      ],
    })),
  });
}
export const rpcHolidayFixture = {
  id: 901,
  name: 'AB',
  longName: 'Autumn break',
  startDate: 20261102,
  endDate: 20261108,
};
