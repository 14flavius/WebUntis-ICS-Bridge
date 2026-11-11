import { randomUUID } from 'node:crypto';
import type { CalendarEvent } from '../shared/events.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

export function originalIds(event: CalendarEvent): string[] {
  return event.sourceIds ?? [event.sourceId];
}

/** Preserve the representative when WebUntis changes a block's ID order or
 * removes its former first period. Explicit splits get distinct representatives;
 * explicit merges retire redundant representatives in the same transaction.
 */
export function resolveIdentities(
  db: Db,
  accountId: string,
  incoming: CalendarEvent[],
) {
  const rows = db
    .prepare(
      'SELECT originalId, sourceId FROM event_aliases WHERE accountId = ?',
    )
    .all(accountId) as { originalId: string; sourceId: string }[];
  const aliases = new Map(rows.map((row) => [row.originalId, row.sourceId]));
  const published = new Map<string, CalendarEvent>();
  const assignments = new Map<string, string>();
  for (const event of incoming.sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  )) {
    const ids = originalIds(event);
    if (ids.some((id) => assignments.has(id)))
      throw new AppError('WEBUNTIS_OVERLAPPING_IDS', 502);
    const candidates = ids
      .map((id) => aliases.get(id))
      .filter((id): id is string => !!id);
    let representative =
      candidates.find((id) => !published.has(id)) ?? event.sourceId;
    if (published.has(representative))
      representative = `${event.category}:${randomUUID()}`;
    published.set(representative, { ...event, sourceId: representative });
    for (const id of ids) {
      assignments.set(id, representative);
      db.prepare(
        `INSERT INTO event_aliases (accountId, originalId, sourceId) VALUES (?, ?, ?)
        ON CONFLICT(accountId, originalId) DO UPDATE SET sourceId=excluded.sourceId`,
      ).run(accountId, id, representative);
    }
  }
  return { published, assignments };
}
