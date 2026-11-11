import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import Database from 'better-sqlite3';

process.umask(0o077);
const MAGIC = Buffer.from('WUIB1');
const root = process.cwd();
function inside(path) {
  const target = resolve(root, path);
  const local = relative(root, target);
  if (local.startsWith('..') || isAbsolute(local) || !local)
    throw new Error('Use a path inside the current project directory');
  let current = target;
  while (current !== root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error('Symbolic links are not allowed');
    current = dirname(current);
  }
  return target;
}
function derive(password, salt) {
  return scryptSync(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 });
}
function encrypt(payload, password) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(password, salt), nonce);
  cipher.setAAD(MAGIC);
  const content = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([MAGIC, salt, nonce, cipher.getAuthTag(), content]);
}
function decrypt(archive, password) {
  if (!archive.subarray(0, 5).equals(MAGIC) || archive.length < 50)
    throw new Error('Invalid backup');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(password, archive.subarray(5, 21)),
    archive.subarray(21, 33),
  );
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(archive.subarray(33, 49));
  return Buffer.concat([
    decipher.update(archive.subarray(49)),
    decipher.final(),
  ]);
}
async function create(password) {
  const databasePath = inside(
    process.env.DATABASE_PATH ?? 'data/bridge.sqlite',
  );
  const secret = process.env.BETTER_AUTH_SECRET;
  const key = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 32 || !key || !/^[a-f0-9]{64}$/i.test(key))
    throw new Error(
      'Original authentication and encryption secrets are required',
    );
  const directory = inside('data/backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const basename = `bridge-${stamp}-${randomBytes(4).toString('hex')}`;
  const temporary = join(directory, '.' + basename + '.sqlite');
  const target = join(directory, basename + '.wub');
  const db = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await db.backup(temporary);
    // Normalize only the private snapshot, never the running WAL database.
    const snapshot = new Database(temporary);
    try {
      snapshot.pragma('journal_mode = DELETE');
      if (snapshot.pragma('quick_check', { simple: true }) !== 'ok')
        throw new Error('Snapshot failed integrity check');
    } finally {
      snapshot.close();
    }
    const env = [
      'PUBLIC_URL=' + (process.env.PUBLIC_URL ?? 'http://127.0.0.1:5173'),
      'HOST=127.0.0.1',
      'PORT=3000',
      'DATABASE_PATH=data/bridge.sqlite',
      'BETTER_AUTH_SECRET=' + secret,
      'ENCRYPTION_KEY=' + key,
      '',
    ].join('\n');
    const payload = JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      env,
      database: readFileSync(temporary).toString('base64'),
    });
    writeFileSync(target, encrypt(Buffer.from(payload), password), {
      flag: 'wx',
      mode: 0o600,
    });
    console.info('Encrypted backup created: ' + relative(root, target));
  } finally {
    db.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function restore(password, archivePath, destination) {
  if (!archivePath || !destination)
    throw new Error('Usage: backup.mjs restore <archive.wub> <new-directory>');
  const target = inside(destination);
  if (existsSync(target))
    throw new Error(
      'Restore destination already exists; nothing was overwritten',
    );
  const payload = JSON.parse(
    decrypt(readFileSync(inside(archivePath)), password).toString('utf8'),
  );
  if (
    payload.version !== 1 ||
    typeof payload.env !== 'string' ||
    typeof payload.database !== 'string'
  )
    throw new Error('Invalid backup payload');
  const database = Buffer.from(payload.database, 'base64');
  const db = new Database(database);
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok')
      throw new Error('Backup database failed integrity check');
  } finally {
    db.close();
  }
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(join(target, 'data'), { mode: 0o700 });
  writeFileSync(join(target, 'data/bridge.sqlite'), database, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(join(target, '.env'), payload.env, { flag: 'wx', mode: 0o600 });
  console.info(
    'Restored database and original secrets into a new private directory. Review PUBLIC_URL before starting.',
  );
}
const command = process.argv[2];
if (!['create', 'restore'].includes(command))
  throw new Error('Choose create or restore; pass the passphrase on stdin');
const password = readFileSync(0, 'utf8');
if (password.length < 12 || password.length > 1024)
  throw new Error('Passphrase must contain 12–1024 characters');
if (command === 'create') await create(password);
else restore(password, process.argv[3], process.argv[4]);
