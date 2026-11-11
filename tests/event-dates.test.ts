import { expect, test } from 'vitest';
import { eventDateLabel } from '../src/web/lib/event-dates.js';

const label = (start: string, end: string, language: 'en' | 'de' = 'en') =>
  eventDateLabel({ start, end, allDay: true }, language).replace(/\s+/g, ' ');

test('holiday preview shows inclusive multi-day ranges and single-day holidays without an extra day', () => {
  expect(label('2026-11-02', '2026-11-09')).toBe('Nov 2 – 8, 2026');
  expect(label('2026-11-18', '2026-11-19')).toBe('Nov 18, 2026');
  expect(label('2026-11-02', '2026-11-09', 'de')).toBe('2.–8. Nov. 2026');
  expect(label('2026-11-18', '2026-11-19', 'de')).toBe('18. Nov. 2026');
});

test('holiday display retains month/year boundaries and daylight-saving dates', () => {
  expect(label('2026-12-24', '2027-01-07')).toBe('Dec 24, 2026 – Jan 6, 2027');
  expect(label('2026-10-24', '2026-10-27')).toBe('Oct 24 – 26, 2026');
  expect(label('2026-03-29', '2026-03-30')).toBe('Mar 29, 2026');
});
