export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
};

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function parseRetryAfter(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}

export function calculateRetryDelay(
  attemptNumber: number,
  retryAfterMs?: number,
  random = Math.random,
  policy = DEFAULT_RETRY_POLICY,
): number {
  const exponent = Math.max(0, attemptNumber - 1);
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jittered = base * (0.8 + random() * 0.4);
  const requested = Math.max(jittered, retryAfterMs ?? 0);
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(requested)));
}

export function classifyResponse(status: number): "success" | "retryable" | "permanent" {
  if (status >= 200 && status < 300) return "success";
  return isRetryableStatus(status) ? "retryable" : "permanent";
}

export function retryDelayMs(attemptNumber: number, retryAfter?: string | null): number {
  return calculateRetryDelay(attemptNumber, parseRetryAfter(retryAfter));
}
