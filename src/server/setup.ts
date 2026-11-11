import type { SetupStatus } from '../shared/auth.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

const SETUP_WINDOW_SECONDS = 2 * 60 * 60;

export function setupStatus(db: Db): SetupStatus {
  const required = !db.prepare('SELECT id FROM user LIMIT 1').get();
  // Process uptime is monotonic: browser reloads and wall-clock corrections
  // cannot reopen setup. Only restarting the application resets this window.
  const remainingSeconds = required
    ? Math.max(0, Math.ceil(SETUP_WINDOW_SECONDS - process.uptime()))
    : 0;
  return {
    required,
    expired: required && remainingSeconds === 0,
    remainingSeconds,
  };
}

export function assertSetupAllowed(db: Db) {
  const status = setupStatus(db);
  if (!status.required) throw new AppError('SETUP_COMPLETE', 409);
  if (status.expired) throw new AppError('SETUP_EXPIRED', 403);
}
