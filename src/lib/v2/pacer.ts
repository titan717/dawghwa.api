/**
 * Politeness pacing for the v2 code paths: at most one request per second to
 * any one upstream host (per server instance). Callers reserve the next free
 * slot for the host; if that slot is further away than `maxWaitMs` the call is
 * refused instead of queueing without bound, and the caller treats it as a
 * failure (fallback / generic error). There is no retry and no alternate route.
 *
 * In-memory: on serverless every warm instance paces independently, so the
 * effective ceiling is 1 req/s x number of concurrently warm instances.
 */

export const HOST_INTERVAL_MS = 1_000;

export class HostPacer {
  private readonly next = new Map<string, number>();

  constructor(
    private readonly intervalMs = HOST_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly maxHosts = 5_000,
  ) {}

  /** Reserve a slot; returns the delay (ms) until it, or null when it exceeds maxWaitMs. */
  reserve(host: string, maxWaitMs: number): number | null {
    const key = host.toLowerCase();
    const t = this.now();
    const slot = Math.max(t, this.next.get(key) ?? 0);
    const delay = slot - t;
    if (delay > maxWaitMs) return null;
    if (!this.next.has(key) && this.next.size >= this.maxHosts) {
      for (const [k, v] of this.next) if (v <= t) this.next.delete(k);
      if (this.next.size >= this.maxHosts) {
        const oldest = this.next.keys().next().value;
        if (oldest !== undefined) this.next.delete(oldest);
      }
    }
    this.next.set(key, slot + this.intervalMs);
    return delay;
  }

  /** Wait for a slot. Resolves true when the request may go out, false if refused. */
  async wait(host: string, maxWaitMs: number, signal?: AbortSignal): Promise<boolean> {
    const delay = this.reserve(host, maxWaitMs);
    if (delay === null) return false;
    if (delay > 0) await this.sleep(delay);
    return !signal?.aborted;
  }
}

let shared: HostPacer | null = null;

export function v2Pacer(): HostPacer {
  if (!shared) shared = new HostPacer();
  return shared;
}

/** Test helper: optionally install a pacer with injected clock/sleep. */
export function setV2Pacer(p: HostPacer | null): void {
  shared = p;
}
