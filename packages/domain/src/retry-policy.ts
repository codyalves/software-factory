/**
 * Why a step failed to run. Gate failures are not listed here: a step that ran
 * and produced wrong code is handled by agent iteration in the run state
 * machine, never by an infrastructure retry.
 *
 * - transient: network blip, HTTP 408/429/5xx, worker lost. Safe to retry.
 * - timeout: the step overran its deadline. Retried once, then dead-lettered.
 * - permanent: bad config, missing access, invalid input. Retrying cannot help.
 */
export type FailureClass = 'transient' | 'timeout' | 'permanent';

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly reason: string }
  | { readonly retry: false; readonly reason: string };

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 300_000 };

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);

export function classifyFailure(failure: { status?: number; error?: unknown }): FailureClass {
  const { status, error } = failure;

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500 ? 'transient' : 'permanent';
  }
  if (error instanceof Error) {
    const code =
      (error as Error & { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
      return 'transient';
    }
  }
  return 'permanent';
}

/**
 * @param attempt The attempt that just failed, starting at 1.
 * @param retryAfterMs Server-provided Retry-After, if any. Never undercut.
 * @param random Source of jitter in [0, 1); injectable for tests.
 */
export function decideRetry(
  policy: RetryPolicy,
  failure: FailureClass,
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): RetryDecision {
  if (failure === 'permanent') {
    return { retry: false, reason: 'permanent failure' };
  }
  if (failure === 'timeout' && attempt >= 2) {
    return { retry: false, reason: 'timed out twice' };
  }
  if (failure === 'transient' && attempt >= policy.maxAttempts) {
    return { retry: false, reason: `gave up after ${policy.maxAttempts} attempts` };
  }

  // Exponential backoff with full jitter: uniform in [0, min(max, base * 2^(n-1))].
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  let delayMs = random() * ceiling;
  if (retryAfterMs !== undefined && retryAfterMs > delayMs) {
    delayMs = retryAfterMs;
  }

  return { retry: true, delayMs, reason: `${failure} failure, attempt ${attempt}` };
}
