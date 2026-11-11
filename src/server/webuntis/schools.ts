import { z } from 'zod';
import {
  secureTransport,
  responseText,
  serverOrigin,
  type Transport,
} from './http.js';
import { AppError } from '../errors.js';
const TOO_MANY_RESULTS = -6003;
const searchResult = z.object({
  result: z
    .object({
      schools: z.array(
        z.object({
          displayName: z.string(),
          loginName: z.string(),
          server: z.string(),
          address: z.string().optional(),
        }),
      ),
    })
    .optional(),
  error: z.object({ code: z.number() }).optional(),
});
export async function searchSchools(
  search: string,
  transport: Transport = secureTransport(),
) {
  try {
    const response = await transport.fetch(
      'https://schoolsearch.webuntis.com/schoolquery2',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'bridge',
          jsonrpc: '2.0',
          method: 'searchSchool',
          params: [{ search }],
        }),
      },
    );
    if (!response.ok) throw new AppError('SCHOOL_SEARCH_UNAVAILABLE', 503);
    const result = searchResult.parse(
      JSON.parse(await responseText(response)) as unknown,
    );
    if (result.error?.code === TOO_MANY_RESULTS)
      throw new AppError('SCHOOL_SEARCH_TOO_BROAD', 422);
    if (result.error || !result.result)
      throw new AppError('SCHOOL_SEARCH_INVALID', 502);
    return result.result.schools.map((school) => ({
      ...school,
      server: serverOrigin(school.server),
    }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new AppError('SCHOOL_SEARCH_INVALID', 502);
    if (
      error instanceof Error &&
      ['TimeoutError', 'AbortError'].includes(error.name)
    )
      throw new AppError('SCHOOL_SEARCH_TIMEOUT', 504);
    throw new AppError('SCHOOL_SEARCH_UNAVAILABLE', 503);
  } finally {
    await transport.close();
  }
}
