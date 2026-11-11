import type { Language } from '../../shared/types';

export function eventDateLabel(
  event: { start: string; end: string; allDay: boolean },
  language: Language,
): string {
  const start = new Date(event.start);
  const end = new Date(event.end);
  const formatter = new Intl.DateTimeFormat(language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: event.allDay ? 'UTC' : undefined,
  });
  if (!event.allDay) return formatter.format(start);
  // All-day DTEND is exclusive. Calendar-day arithmetic in UTC keeps this
  // display independent of the viewer's timezone and daylight-saving changes.
  end.setUTCDate(end.getUTCDate() - 1);
  if (start.getTime() === end.getTime()) return formatter.format(start);
  return formatter.formatRange(start, end);
}
