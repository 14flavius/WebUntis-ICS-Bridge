import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from '../src/web/lib/api.js';

afterEach(() => vi.unstubAllGlobals());

test.each([
  { body: '<html>Too many requests</html>', status: 429 },
  { body: '', status: 401 },
  { body: 'null', status: 502 },
  { body: '{"code":42,"error":{}}', status: 500 },
])(
  'preserves HTTP $status when the error body is unusable',
  async ({ body, status }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { status })),
    );
    await expect(api('/api/status')).rejects.toMatchObject({
      status,
      code: 'REQUEST_FAILED',
      details: '',
    });
  },
);

test('ignores malformed validation details while preserving the actual error code', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          error: 'INVALID_INPUT',
          details: { message: 'unexpected shape' },
        },
        { status: 400 },
      ),
    ),
  );
  await expect(api('/api/accounts')).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_INPUT',
    details: '',
  });
});

test('retains supported validation details and Better Auth error codes', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        {
          error: 'INVALID_INPUT',
          details: [{ path: 'name', message: 'Required' }],
        },
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          code: 'INVALID_PASSWORD',
          message: 'Invalid password',
        },
        { status: 401 },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  await expect(api('/api/accounts')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    details: 'name: Required',
  });
  await expect(api('/api/auth/sign-in/username')).rejects.toMatchObject({
    status: 401,
    code: 'INVALID_PASSWORD',
  });
});

test('rejects invalid successful JSON without hiding body-read cancellation', async () => {
  const abort = new DOMException('Aborted', 'AbortError');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>Proxy page</html>'))
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.reject(abort),
      }),
  );
  await expect(api('/api/status')).rejects.toEqual(
    new ApiError(200, 'INVALID_RESPONSE'),
  );
  await expect(api('/api/status')).rejects.toBe(abort);
});
