export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: boolean;
  onRetry?: (err: unknown, attempt: number) => void;
  shouldRetry?: (err: unknown) => boolean;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    retries = 3,
    baseMs = 250,
    maxMs = 5000,
    factor = 2,
    jitter = true,
    onRetry,
    shouldRetry = () => true,
  } = opts;

  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > retries || !shouldRetry(err)) break;
      const exp = Math.min(maxMs, baseMs * Math.pow(factor, attempt - 1));
      const delay = jitter ? Math.floor(Math.random() * exp) + Math.floor(exp / 2) : exp;
      onRetry?.(err, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
