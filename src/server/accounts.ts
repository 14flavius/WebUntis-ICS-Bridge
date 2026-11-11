import { randomUUID } from 'node:crypto';
import type { Account, AccountInput } from '../shared/types.js';
import type { Db } from './db.js';
import { encryptPassword, decryptPassword } from './crypto.js';
import { AppError } from './errors.js';
import { WebUntisClient } from './webuntis/client.js';
import { serverOrigin } from './webuntis/http.js';
import { searchSchools } from './webuntis/schools.js';
import { feeds, saveFeed } from './feeds.js';
import { testConnection } from './webuntis/diagnostics.js';
export { testConnection } from './webuntis/diagnostics.js';

/** Unknown and foreign accounts are indistinguishable to the caller. */
export function assertAccountOwner(db: Db, id: string, ownerId: string) {
  const row = db
    .prepare('SELECT id FROM webuntis_accounts WHERE id = ? AND ownerId = ?')
    .get(id, ownerId);
  if (!row) throw new AppError('NOT_FOUND', 404);
}

export function removeAccount(db: Db, id: string, ownerId?: string) {
  db.transaction(() => {
    if (ownerId) assertAccountOwner(db, id, ownerId);
    for (const feed of feeds(db)) {
      const sources = feed.sources.filter((source) => source.accountId !== id);
      if (sources.length !== feed.sources.length)
        saveFeed(
          db,
          { ...feed, sources, enabled: feed.enabled && sources.length > 0 },
          feed.id,
        );
    }
    db.prepare('DELETE FROM webuntis_accounts WHERE id = ?').run(id);
  }).immediate();
}

/** Without an owner this lists every account, which only the scheduler needs. */
export function accounts(db: Db, ownerId?: string): Account[] {
  const columns =
    'id, name, school, server, username, timezone, examSource, lastSuccess, lastAttempt, error';
  if (ownerId === undefined)
    return db
      .prepare(`SELECT ${columns} FROM webuntis_accounts ORDER BY name`)
      .all() as Account[];
  return db
    .prepare(
      `SELECT ${columns} FROM webuntis_accounts WHERE ownerId = ? ORDER BY name`,
    )
    .all(ownerId) as Account[];
}
export function accountCredentials(
  db: Db,
  id: string,
  key: string,
): AccountInput & { password: string } {
  const account = db
    .prepare('SELECT * FROM webuntis_accounts WHERE id = ?')
    .get(id) as (Account & { password: string }) | undefined;
  if (!account) throw new AppError('NOT_FOUND', 404);
  return { ...account, password: decryptPassword(account.password, key) };
}
export async function saveAccount(
  db: Db,
  input: AccountInput,
  key: string,
  id?: string,
  ownerId?: string,
) {
  if (id && ownerId) assertAccountOwner(db, id, ownerId);
  const previous = id ? accountCredentials(db, id, key) : undefined;
  if (!input.password && !previous) throw new AppError('PASSWORD_REQUIRED');
  const { server, school } = await resolveAccountSchool(input);
  const accountId = id ?? randomUUID();
  const password = encryptPassword(input.password ?? previous!.password, key);
  db.prepare(
    `INSERT INTO webuntis_accounts (id, name, school, server, username, password, timezone, examSource, ownerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, school=excluded.school, server=excluded.server, username=excluded.username, password=excluded.password, timezone=excluded.timezone, examSource=excluded.examSource, revision=webuntis_accounts.revision+1`,
  ).run(
    accountId,
    input.name,
    school,
    server,
    input.username,
    password,
    input.timezone,
    input.examSource ?? previous?.examSource ?? 'exams',
    // Only used on creation; an update never changes the owner.
    ownerId ?? null,
  );
  return accountId;
}

async function resolveAccountSchool(
  input: Pick<AccountInput, 'server' | 'school'>,
) {
  let { server, school } = input;
  if (!server) {
    const matches = await searchSchools(school);
    const exact = matches.filter(
      (match) => match.loginName === school || match.displayName === school,
    );
    if (exact.length !== 1) throw new AppError('SELECT_SCHOOL');
    server = exact[0].server;
    school = exact[0].loginName;
  }
  return { school, server: serverOrigin(server) };
}

export async function testAccountDraft(
  input: AccountInput & { password: string },
) {
  const school = await resolveAccountSchool(input);
  const client = new WebUntisClient({ ...input, ...school });
  try {
    return await testConnection(client, input.timezone);
  } finally {
    await client.close();
  }
}
