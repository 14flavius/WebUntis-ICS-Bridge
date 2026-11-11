import { z } from 'zod';

const errorResponse = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  details: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .catch(undefined),
});

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details = '',
  ) {
    super(code);
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: options.signal,
    headers:
      options.body === undefined
        ? undefined
        : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data: unknown = await response.json().catch((error: unknown) => {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ApiError(
      response.status,
      response.ok ? 'INVALID_RESPONSE' : 'REQUEST_FAILED',
    );
  });
  if (!response.ok) {
    const error = errorResponse.safeParse(data).data;
    throw new ApiError(
      response.status,
      error?.code ?? error?.error ?? 'REQUEST_FAILED',
      error?.details
        ?.map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ') ?? '',
    );
  }
  return data as T;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body });
