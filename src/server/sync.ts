import { DateTime } from 'luxon';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { accounts, accountCredentials } from './accounts.js';
import { WebUntisClient } from './webuntis/client.js';
import { fetchSnapshots } from './webuntis/snapshot.js';
import { commitSnapshots } from './events.js';
import { AppError } from './errors.js';

export class SyncService {
  private running = new Map<string, Promise<void>>();
  private rerun = new Set<string>();
  private allRunning?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    private db: Db,
    private config: Config,
  ) {}
  active() {
    return [...this.running.keys()];
  }
  startAccount(id: string, options: { restartActive?: boolean } = {}) {
    if (options.restartActive && this.running.has(id)) this.rerun.add(id);
    // Saving the account succeeds independently of its first remote sync.
    void this.syncAccount(id).catch(() => {
      this.db
        .prepare('UPDATE webuntis_accounts SET error = ? WHERE id = ?')
        .run('SYNC_CREDENTIALS_UNAVAILABLE', id);
    });
  }
  syncAccount(id: string): Promise<void> {
    const active = this.running.get(id);
    if (active) return active;
    const task = this.performLatest(id).finally(() => this.running.delete(id));
    this.running.set(id, task);
    return task;
  }
  private async performLatest(id: string) {
    do {
      this.rerun.delete(id);
      await this.perform(id);
    } while (this.rerun.has(id) && !this.stopped);
    this.rerun.delete(id);
  }
  private async perform(id: string) {
    const credentials = accountCredentials(
      this.db,
      id,
      this.config.encryptionKey,
    );
    const version = this.db
      .prepare('SELECT revision FROM webuntis_accounts WHERE id = ?')
      .get(id) as { revision: number };
    const client = new WebUntisClient(credentials);
    this.db
      .prepare('UPDATE webuntis_accounts SET lastAttempt = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    try {
      const range = this.db
        .prepare(
          `SELECT MAX(pastDays) AS past, MAX(futureDays) AS future
           FROM feeds WHERE enabled = 1 AND EXISTS (
             SELECT 1 FROM json_each(feeds.config, '$.sources') AS source
             WHERE json_extract(source.value, '$.accountId') = ?
           )`,
        )
        .get(id) as { past: number | null; future: number | null };
      const today = DateTime.now().setZone(credentials.timezone).startOf('day');
      const start = today.minus({ days: range.past ?? 14 }).toISODate()!;
      const end = today.plus({ days: range.future ?? 90 }).toISODate()!;
      const result = await fetchSnapshots(client, credentials, start, end);
      const current = this.db
        .prepare('SELECT revision FROM webuntis_accounts WHERE id = ?')
        .get(id) as { revision: number } | undefined;
      if (!current || current.revision !== version.revision)
        throw new AppError('ACCOUNT_CHANGED_DURING_SYNC', 409);
      const committed = commitSnapshots(this.db, id, result.snapshots);
      const warnings = [
        ...new Set([...result.warnings, ...committed.warnings]),
      ];
      if (warnings.length)
        this.db
          .prepare('UPDATE webuntis_accounts SET error = ? WHERE id = ?')
          .run(warnings.join(', '), id);
    } catch (error) {
      const code =
        error instanceof AppError ? error.code : 'SYNC_INVALID_RESPONSE';
      this.db
        .prepare('UPDATE webuntis_accounts SET error = ? WHERE id = ?')
        .run(code, id);
    } finally {
      await client.close();
    }
  }
  syncAll(): Promise<void> {
    // A manual request joining a scheduler run must not restart accounts that
    // already finished while another account in that run is still syncing.
    if (this.allRunning) return this.allRunning;
    const task = this.performAll().finally(() => {
      this.allRunning = undefined;
    });
    this.allRunning = task;
    return task;
  }
  private async performAll() {
    await this.syncAccounts(accounts(this.db).map((account) => account.id));
  }
  /** Sequential on purpose: one login at a time keeps load on schools low. */
  async syncAccounts(ids: string[]) {
    for (const id of ids) {
      if (this.stopped) break;
      try {
        await this.syncAccount(id);
      } catch {
        this.db
          .prepare('UPDATE webuntis_accounts SET error = ? WHERE id = ?')
          .run('SYNC_CREDENTIALS_UNAVAILABLE', id);
      }
    }
  }
  start() {
    this.stopped = false;
    const tick = async () => {
      await this.syncAll();
      if (this.stopped) return;
      const setting = this.db
        .prepare('SELECT intervalMinutes FROM settings WHERE id = 1')
        .get() as { intervalMinutes: number };
      this.timer = setTimeout(() => {
        void tick();
      }, setting.intervalMinutes * 60000);
      this.timer.unref();
    };
    this.timer = setTimeout(() => {
      void tick();
    }, 1000);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.allRunning;
    await Promise.all(this.running.values());
  }
}
