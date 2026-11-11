import { z } from 'zod';

const configSchema = z.object({
  publicUrl: z.url(),
  authSecret: z.string().min(32),
  encryptionKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
  production: z.boolean(),
});
export type Config = z.infer<typeof configSchema>;

export function trustedOrigins(config: Config): string[] {
  const url = new URL(config.publicUrl);
  const origins = [url.origin];
  // Local Vite links may use either loopback name. Keep the same port and
  // protocol, and never broaden a deployed instance's configured origin.
  if (!config.production && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    origins.push(url.origin);
  }
  return origins;
}

export function readConfig(): Config {
  const config = configSchema.parse({
    publicUrl: process.env.PUBLIC_URL ?? 'http://127.0.0.1:5173',
    authSecret: process.env.BETTER_AUTH_SECRET,
    encryptionKey: process.env.ENCRYPTION_KEY,
    production: process.env.NODE_ENV === 'production',
  });
  const url = new URL(config.publicUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('PUBLIC_URL must use HTTP or HTTPS');
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('PUBLIC_URL must be an origin');
  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Public deployments require HTTPS');
  if (config.authSecret === config.encryptionKey)
    throw new Error('Independent secrets are required');
  return config;
}
