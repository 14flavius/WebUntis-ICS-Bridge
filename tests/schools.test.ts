import { expect, test, vi } from 'vitest';
import { searchSchools } from '../src/server/webuntis/schools.js';
import type { Transport } from '../src/server/webuntis/http.js';

function fixtureTransport(response: unknown): Transport {
  return {
    fetch: vi.fn(async () => Response.json(response)),
    close: vi.fn(async () => {}),
  };
}

test('school search reads schools even with size zero and normalizes hostnames', async () => {
  const transport = fixtureTransport({
    id: 'school-search',
    jsonrpc: '2.0',
    result: {
      size: 0,
      schools: [
        {
          displayName: 'Example School',
          loginName: 'example-school',
          server: 'example-school.webuntis.com',
          address: 'Example Town',
          schoolId: 123,
          tenantId: '123',
          mobileServiceUrl: null,
          serverUrl:
            'https://example-school.webuntis.com/WebUntis/?school=example-school',
        },
      ],
    },
  });
  expect(await searchSchools('example', transport)).toEqual([
    {
      displayName: 'Example School',
      loginName: 'example-school',
      server: 'https://example-school.webuntis.com',
      address: 'Example Town',
    },
  ]);
  expect(transport.fetch).toHaveBeenCalledWith(
    'https://schoolsearch.webuntis.com/schoolquery2',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        id: 'bridge',
        jsonrpc: '2.0',
        method: 'searchSchool',
        params: [{ search: 'example' }],
      }),
    }),
  );
  expect(transport.close).toHaveBeenCalledOnce();
});

test('empty school results are distinct from broad searches and malformed replies', async () => {
  expect(
    await searchSchools('none', fixtureTransport({ result: { schools: [] } })),
  ).toEqual([]);
  for (const [response, code] of [
    [
      { error: { code: -6003, message: 'too many results' } },
      'SCHOOL_SEARCH_TOO_BROAD',
    ],
    [{ error: { code: -1 } }, 'SCHOOL_SEARCH_INVALID'],
    [
      { result: { schools: [{ server: 'example.webuntis.com' }] } },
      'SCHOOL_SEARCH_INVALID',
    ],
  ] as const) {
    const transport = fixtureTransport(response);
    await expect(searchSchools('example', transport)).rejects.toMatchObject({
      code,
    });
    expect(transport.close).toHaveBeenCalledOnce();
  }
});

test('school search reports network, timeout and HTTP failures without leaking details', async () => {
  for (const [error, code] of [
    [new TypeError('fetch failed'), 'SCHOOL_SEARCH_UNAVAILABLE'],
    [new DOMException('timeout', 'TimeoutError'), 'SCHOOL_SEARCH_TIMEOUT'],
  ] as const) {
    const transport: Transport = {
      fetch: async () => {
        throw error;
      },
      close: vi.fn(async () => {}),
    };
    await expect(searchSchools('example', transport)).rejects.toMatchObject({
      code,
    });
    expect(transport.close).toHaveBeenCalledOnce();
  }
  await expect(
    searchSchools('example', {
      fetch: async () => new Response(null, { status: 503 }),
      close: async () => {},
    }),
  ).rejects.toMatchObject({ code: 'SCHOOL_SEARCH_UNAVAILABLE' });
});
