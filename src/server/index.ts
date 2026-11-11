import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import { readConfig } from './config.js';

process.umask(0o077);
const db = openDatabase(process.env.DATABASE_PATH ?? 'data/bridge.sqlite');
const app = await buildApp(db, readConfig(), true);
await app.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
});
console.info('WebUntis ICS Bridge is ready.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    db.close();
  });
}
