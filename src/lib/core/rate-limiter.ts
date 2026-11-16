import { DawghwaError } from "./errors";
import { abortError } from "./retry";

export interface ProviderRateLimit {
  /** Sustained requests per second. */
  rps: number;
  /** Bucket size (max burst). */
  burst: number;
  /** Maximum simultaneous in-flight upstream requests. */
  maxConcurrent: number;
  /** Maximum queued waiters before new requests are rejected. */
  maxQueue?: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Token bucket + concurrency limiter for outbound requests to one provider.
 * Waiters are served FIFO, are cancellable, and the queue is bounded so a slow
 * source cannot accumulate unbounded pending work (memory).
 */
export class ProviderLimiter {
  private tokens: number;
  private lastRefill: number;
  private active = 0;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly limits: ProviderRateLimit,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = limits.burst;
    this.lastRefill = now();
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.queue.length;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.limits.burst, this.tokens + elapsed * this.limits.rps);
      this.lastRefill = t;
    }
  }

  private canRun(): boolean {
    this.refill();
    return this.active < this.limits.maxConcurrent && this.tokens >= 1;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    if (this.queue.length === 0 && this.canRun()) {
      return Promise.resolve(this.take());
    }
    if (this.queue.length >= (this.limits.maxQueue ?? 100)) {
      return Promise.reject(
        new DawghwaError("SOURCE_UNAVAILABLE", "Source request queue is full, try again shortly", {
          retryable: true,
          retryAfter: 1,
        }),
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.queue = this.queue.filter((w) => w !== waiter);
          reject(signal.reason ?? abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.schedule();
    });
  }

  private take(): () => void {
    this.tokens -= 1;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.queue.length > 0 && this.canRun()) {
      const waiter = this.queue.shift()!;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      // Capacity is reserved synchronously on behalf of the waiter.
      waiter.resolve(this.take());
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    this.refill();
    if (this.active >= this.limits.maxConcurrent) return; // a release will drain
    const missing = Math.max(0, 1 - this.tokens);
    const wait = Math.max(1, Math.ceil((missing / this.limits.rps) * 1000));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, wait);
  }
}

/**
 * Fixed-window-ish client rate limiter (token bucket per key) with a bounded
 * key set, used to protect the public API from abuse.
 */
export class KeyedRateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns remaining tokens, or a negative retry-after (seconds) when limited. */
  take(key: string, cost = 1): { allowed: boolean; remaining: number; retryAfter: number; limit: number } {
    const t = this.now();
    const ratePerMs = this.perMinute / 60_000;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict the oldest key (Map preserves insertion order).
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.perMinute, last: t };
    } else {
      this.buckets.delete(key); // refresh LRU position
      bucket.tokens = Math.min(this.perMinute, bucket.tokens + (t - bucket.last) * ratePerMs);
      bucket.last = t;
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfter: 0, limit: this.perMinute };
    }
    const retryAfter = Math.ceil((cost - bucket.tokens) / ratePerMs / 1000);
    return { allowed: false, remaining: 0, retryAfter, limit: this.perMinute };
  }

  get size(): number {
    return this.buckets.size;
  }
}
