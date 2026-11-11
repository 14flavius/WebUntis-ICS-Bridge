import { expect, test, vi } from 'vitest';
import type * as Undici from 'undici';
import { secureTransport } from '../src/server/webuntis/http.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  const { gzipSync } = await import('node:zlib');
  return {
    ...actual,
    // Exercise native fetch's real handler contract against Undici 8 while
    // keeping the regression test fully offline. Do not replace the adapter.
    Agent: class extends actual.MockAgent {
      constructor() {
        super();
        this.disableNetConnect();
        this.get('https://example.webuntis.com')
          .intercept({ path: '/probe', method: 'POST' })
          .reply(200, gzipSync('{"ok":true}'), {
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
            },
          });
      }
    },
  };
});

test('native fetch works through the Undici adapter, including response headers and gzip', async () => {
  const transport = secureTransport();
  try {
    const response = await transport.fetch(
      'https://example.webuntis.com/probe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"probe":true}',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });
  } finally {
    await transport.close();
  }
});
