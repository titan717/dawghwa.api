/**
 * Request coalescing: concurrent callers for the same key share one in-flight
 * promise. The entry is removed as soon as the promise settles, so the map can
 * never grow beyond the number of distinct keys currently in flight.
 */
export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();

  get size(): number {
    return this.inflight.size;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  do(key: string, fn: () => Promise<T>): { promise: Promise<T>; shared: boolean } {
    const existing = this.inflight.get(key);
    if (existing) return { promise: existing, shared: true };
    const promise = fn().finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return { promise, shared: false };
  }
}
