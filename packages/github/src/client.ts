/** A GitHub API call failed. `retryable` and `retryAfterMs` drive the outbox retry policy. */
export class ForgeError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { status?: number; retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ForgeError';
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type Fetch = typeof fetch;

export interface GitHubRequestOptions {
  readonly fetch: Fetch;
  readonly baseUrl: string;
  readonly token: string;
  readonly now?: () => number;
}

const USER_AGENT = 'software-factory';

/** One REST call. Maps failures to ForgeError, including GitHub's rate-limit signals. */
export async function githubRequest<T>(
  options: GitHubRequestOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await options.fetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // Network failure: the request may or may not have reached GitHub.
    throw new ForgeError(`GitHub ${method} ${path} failed: ${String(error)}`, {
      retryable: true,
      cause: error,
    });
  }

  if (response.ok) {
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  const detail = await response.text().catch(() => '');
  const retryAfterMs = rateLimitDelay(response, options.now ?? Date.now);
  const rateLimited = retryAfterMs !== undefined && (response.status === 403 || response.status === 429);
  throw new ForgeError(`GitHub ${method} ${path} returned ${response.status}: ${detail.slice(0, 300)}`, {
    status: response.status,
    retryable: rateLimited || response.status === 429 || response.status >= 500,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** Retry-After, or the reset time of an exhausted primary rate limit. */
function rateLimitDelay(response: Response, now: () => number): number | undefined {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset)) {
      return Math.max(0, reset * 1000 - now());
    }
  }
  return undefined;
}
