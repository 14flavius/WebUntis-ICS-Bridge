import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.cwd() !== root) throw new Error('Run setup from the project root');
for (const directory of ['data', '.cache', '.cache/npm', '.cache/tmp']) {
  const path = resolve(root, directory);
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error('Project directories must not be symbolic links');
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
try {
  const content = [
    'PUBLIC_URL=http://127.0.0.1:5173',
    'HOST=127.0.0.1',
    'PORT=3000',
    'DATABASE_PATH=data/bridge.sqlite',
    'BETTER_AUTH_SECRET=' + randomBytes(32).toString('hex'),
    'ENCRYPTION_KEY=' + randomBytes(32).toString('hex'),
    '',
  ].join('\n');
  writeFileSync('.env', content, { flag: 'wx', mode: 0o600 });
  console.info('Created .env with two independent random secrets.');
} catch (error) {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'EEXIST'
  )
    console.info('Existing .env preserved. No secrets changed.');
  else throw error;
}
