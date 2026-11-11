import { randomBytes, randomUUID } from 'node:crypto';
import { feedInput, type Feed, type FeedInput } from '../shared/feeds.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

interface FeedRow {
  id: string;
  token: string;
  config: string;
  modifiedAt: string;
}
function deserialize(row: FeedRow): Feed {
  return {
    ...feedInput.parse(JSON.parse(row.config) as unknown),
    id: row.id,
    token: row.token,
    modifiedAt: row.modifiedAt,
  };
}
/** Without an owner this lists every feed, for internal maintenance only. */
export function feeds(db: Db, ownerId?: string): Feed[] {
  const rows =
    ownerId === undefined
      ? db
          .prepare(
            'SELECT id, token, config, modifiedAt FROM feeds ORDER BY name',
          )
          .all()
      : db
          .prepare(
            'SELECT id, token, config, modifiedAt FROM feeds WHERE ownerId = ? ORDER BY name',
          )
          .all(ownerId);
  return (rows as FeedRow[]).map(deserialize);
}
export function getFeed(db: Db, id: string, ownerId?: string): Feed {
  const row = db
    .prepare(
      'SELECT id, token, config, modifiedAt, ownerId FROM feeds WHERE id = ?',
    )
    .get(id) as (FeedRow & { ownerId: string | null }) | undefined;
  // A foreign feed answers exactly like a missing one.
  if (!row || (ownerId !== undefined && row.ownerId !== ownerId))
    throw new AppError('NOT_FOUND', 404);
  return deserialize(row);
}
/** A feed may only read accounts of its own owner. */
export function assertFeedSources(
  db: Db,
  sources: FeedInput['sources'],
  ownerId?: string,
) {
  for (const source of sources) {
    const account = db
      .prepare('SELECT ownerId FROM webuntis_accounts WHERE id = ?')
      .get(source.accountId) as { ownerId: string | null } | undefined;
    if (!account || (ownerId !== undefined && account.ownerId !== ownerId))
      throw new AppError('ACCOUNT_NOT_FOUND');
  }
}
export function saveFeed(
  db: Db,
  input: FeedInput,
  id?: string,
  ownerId?: string,
): Feed {
  input = feedInput.parse(input);
  const previous = id ? getFeed(db, id, ownerId) : undefined;
  assertFeedSources(db, input.sources, ownerId);
  const feedId = id ?? randomUUID();
  const content = JSON.stringify(input);
  const previousContent = previous
    ? JSON.stringify(feedInput.parse(previous))
    : '';
  const modified =
    content === previousContent
      ? previous!.modifiedAt
      : new Date().toISOString();
  db.prepare(
    `INSERT INTO feeds (id, name, token, enabled, pastDays, futureDays, config, modifiedAt, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, pastDays=excluded.pastDays, futureDays=excluded.futureDays, config=excluded.config, modifiedAt=excluded.modifiedAt`,
  ).run(
    feedId,
    input.name,
    randomBytes(32).toString('base64url'),
    Number(input.enabled),
    input.pastDays,
    input.futureDays,
    content,
    modified,
    // Only used on creation; an update never changes the owner.
    ownerId ?? null,
  );
  return getFeed(db, feedId);
}
export function removeFeed(db: Db, id: string, ownerId?: string) {
  getFeed(db, id, ownerId);
  db.prepare('DELETE FROM feeds WHERE id = ?').run(id);
}
export function rotateToken(db: Db, id: string, ownerId?: string) {
  getFeed(db, id, ownerId);
  db.prepare('UPDATE feeds SET token = ? WHERE id = ?').run(
    randomBytes(32).toString('base64url'),
    id,
  );
  return getFeed(db, id);
}
