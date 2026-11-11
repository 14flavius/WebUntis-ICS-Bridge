import {
  tzlib_get_ical_block,
  tzlib_get_timezones,
} from 'timezones-ical-library';
import { AppError } from './errors.js';

const supportedTimezones = new Set(tzlib_get_timezones(false));

export function exportTimezone(timezone: string): string {
  if (supportedTimezones.has(timezone)) return timezone;
  const canonical = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
  }).resolvedOptions().timeZone;
  // Intl can recognize newer names before the bundled VTIMEZONE data does.
  // UTC remains unambiguous; never emit a named zone without its definition.
  return supportedTimezones.has(canonical) ? canonical : 'UTC';
}

/** Keep aliases identical in DTSTART and VTIMEZONE; the library may return
 * the canonical zone's identifier for an alias such as Europe/Busingen. */
export function calendarTimezone(timezone: string): string {
  const block = tzlib_get_ical_block(timezone);
  if (!Array.isArray(block) || !block[0])
    throw new AppError('CALENDAR_TIMEZONE_UNSUPPORTED', 500);
  return block[0]
    .replace(/^TZID:.*$/m, `TZID:${timezone}`)
    .replace(/^X-LIC-LOCATION:.*$/m, `X-LIC-LOCATION:${timezone}`);
}
