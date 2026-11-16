/**
 * Exponential backoff with "full jitter" (AWS architecture blog), bounded by an
 * optional deadline and cancellable through an AbortSignal.
 */

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Injected for deterministic tests. */
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const random = opts.random ?? Math.random;
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.floor(random() * exp);
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(message = "The operation was aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function timeoutError(message = "The operation timed out"): Error {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

/**
 * Combine signals. Uses AbortSignal.any when available (Node >= 20.3) and a
 * small fallback otherwise. Returns a cleanup function so listeners and timers
 * never outlive the operation.
 */
export function combineSignals(
  signals: (AbortSignal | undefined)[],
  timeoutMs?: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const listeners: [AbortSignal, () => void][] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener("abort", onAbort, { once: true });
    listeners.push([s, onAbort]);
  }
  if (timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(
      () => controller.abort(timeoutError(`Timed out after ${timeoutMs}ms`)),
      Math.max(0, timeoutMs),
    );
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      for (const [s, l] of listeners) s.removeEventListener("abort", l);
    },
  };
}
