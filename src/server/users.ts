import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type {
  CreateUserInput,
  ManagedUser,
  UpdateUserInput,
  UserRole,
} from '../shared/auth.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

interface UserRow {
  id: string;
  username: string;
  role: string | null;
  disabled: number | null;
  twoFactorEnabled: number | null;
  createdAt: number | string;
  accounts: number;
  feeds: number;
}

export function roleOf(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user';
}

function toManagedUser(row: UserRow): ManagedUser {
  return {
    id: row.id,
    username: row.username,
    role: roleOf(row.role),
    disabled: !!row.disabled,
    twoFactorEnabled: !!row.twoFactorEnabled,
    createdAt: new Date(row.createdAt).toISOString(),
    accounts: row.accounts,
    feeds: row.feeds,
  };
}

const USER_SELECT = `SELECT user.id, user.username, user.role, user.disabled,
  user.twoFactorEnabled, user.createdAt,
  (SELECT count(*) FROM webuntis_accounts WHERE ownerId = user.id) AS accounts,
  (SELECT count(*) FROM feeds WHERE ownerId = user.id) AS feeds
  FROM user`;

export function listUsers(db: Db): ManagedUser[] {
  const rows = db
    .prepare(`${USER_SELECT} ORDER BY user.username`)
    .all() as UserRow[];
  return rows.map(toManagedUser);
}

function getUser(db: Db, id: string): ManagedUser {
  const row = db.prepare(`${USER_SELECT} WHERE user.id = ?`).get(id) as
    UserRow | undefined;
  if (!row) throw new AppError('NOT_FOUND', 404);
  return toManagedUser(row);
}

export function isUserDisabled(db: Db, username: string): boolean {
  const row = db
    .prepare('SELECT disabled FROM user WHERE username = ?')
    .get(username) as { disabled: number | null } | undefined;
  return !!row?.disabled;
}

/** Runs inside the caller's transaction so setup and creation stay atomic. */
export function insertUser(
  db: Db,
  user: { username: string; passwordHash: string; role: UserRole },
): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO user (id, name, email, username, emailVerified, createdAt, updatedAt, twoFactorEnabled, role, disabled)
     VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?, 0)`,
  ).run(
    id,
    user.username,
    // Better Auth requires an email; this one is never deliverable or shown.
    `${id}@bridge.invalid`,
    user.username,
    now,
    now,
    user.role,
  );
  db.prepare(
    'INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), id, 'credential', id, user.passwordHash, now, now);
  return id;
}

export async function createUser(
  db: Db,
  input: CreateUserInput,
): Promise<ManagedUser> {
  const passwordHash = await hashPassword(input.password);
  const id = db
    .transaction(() => {
      if (
        db.prepare('SELECT id FROM user WHERE username = ?').get(input.username)
      )
        throw new AppError('USERNAME_TAKEN', 409);
      return insertUser(db, {
        username: input.username,
        passwordHash,
        role: input.role,
      });
    })
    .immediate();
  return getUser(db, id);
}

function revokeSessions(db: Db, userId: string) {
  db.prepare('DELETE FROM session WHERE userId = ?').run(userId);
}

/** At least one enabled administrator must always remain, otherwise nobody
 * could manage users again without direct database access. */
function assertAdministratorRemains(db: Db, withoutUserId: string) {
  const remaining = db
    .prepare(
      "SELECT count(*) AS count FROM user WHERE role = 'admin' AND COALESCE(disabled, 0) = 0 AND id <> ?",
    )
    .get(withoutUserId) as { count: number };
  if (!remaining.count) throw new AppError('LAST_ADMINISTRATOR', 409);
}

export function updateUser(
  db: Db,
  actorId: string,
  id: string,
  input: UpdateUserInput,
): ManagedUser {
  db.transaction(() => {
    const current = getUser(db, id);
    const role = input.role ?? current.role;
    const disabled = input.disabled ?? current.disabled;
    const losesAdministration =
      current.role === 'admin' && (role !== 'admin' || disabled);
    // Self-protection prevents an administrator from locking themselves out.
    if (losesAdministration && id === actorId)
      throw new AppError('CANNOT_MODIFY_SELF', 409);
    if (losesAdministration) assertAdministratorRemains(db, id);
    db.prepare(
      'UPDATE user SET role = ?, disabled = ?, updatedAt = ? WHERE id = ?',
    ).run(role, Number(disabled), Date.now(), id);
    if (disabled) revokeSessions(db, id);
  }).immediate();
  return getUser(db, id);
}

export async function resetUserPassword(db: Db, id: string, password: string) {
  getUser(db, id);
  const passwordHash = await hashPassword(password);
  db.transaction(() => {
    const result = db
      .prepare(
        "UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'",
      )
      .run(passwordHash, Date.now(), id);
    if (!result.changes) throw new AppError('NOT_FOUND', 404);
    revokeSessions(db, id);
  }).immediate();
}

/** For a lost authenticator. The user signs in with the password afterwards
 * and can enroll again; existing sessions end. */
export function resetUserTwoFactor(db: Db, id: string) {
  db.transaction(() => {
    getUser(db, id);
    db.prepare('DELETE FROM twoFactor WHERE userId = ?').run(id);
    db.prepare(
      'UPDATE user SET twoFactorEnabled = 0, updatedAt = ? WHERE id = ?',
    ).run(Date.now(), id);
    revokeSessions(db, id);
  }).immediate();
}

export function deleteUser(db: Db, actorId: string, id: string) {
  db.transaction(() => {
    const current = getUser(db, id);
    if (id === actorId) throw new AppError('CANNOT_MODIFY_SELF', 409);
    if (current.role === 'admin' && !current.disabled)
      assertAdministratorRemains(db, id);
    // Feeds first: their sources reference the accounts removed next. Events,
    // coverage and feed state follow through their own cascades.
    db.prepare('DELETE FROM feeds WHERE ownerId = ?').run(id);
    db.prepare('DELETE FROM webuntis_accounts WHERE ownerId = ?').run(id);
    db.prepare('DELETE FROM user WHERE id = ?').run(id);
  }).immediate();
}

/** Upgrades a single-administrator installation: the existing user becomes the
 * administrator and owns everything that was created before ownership existed.
 * Idempotent, so it also covers data seeded before the first setup. */
export function adoptLegacyData(db: Db) {
  db.transaction(() => {
    const hasAdministrator = db
      .prepare("SELECT 1 FROM user WHERE role = 'admin' LIMIT 1")
      .get();
    if (!hasAdministrator)
      db.prepare(
        "UPDATE user SET role = 'admin' WHERE id = (SELECT id FROM user ORDER BY createdAt, id LIMIT 1)",
      ).run();
    const owner = db
      .prepare(
        "SELECT id FROM user WHERE role = 'admin' ORDER BY createdAt, id LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (!owner) return;
    for (const table of ['webuntis_accounts', 'feeds'])
      db.prepare(`UPDATE ${table} SET ownerId = ? WHERE ownerId IS NULL`).run(
        owner.id,
      );
  }).immediate();
}
