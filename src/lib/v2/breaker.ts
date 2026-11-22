import { CircuitBreaker, type BreakerState } from "@/lib/core/circuit-breaker";

/**
 * Per-source circuit breakers for the v2 chapter path.
 *
 * Reuses the core CircuitBreaker (closed -> open after N consecutive
 * failures -> half_open after the cooldown -> one trial -> closed/open). It is
 * separate from each Provider's own operation breaker because it counts
 * outcomes of whole chapter resolutions (manifest + image-host validation),
 * which is what decides fallback order.
 *
 * In-memory and per server instance: on serverless each warm instance has its
 * own view; a cold instance starts with every breaker closed.
 */

export const V2_BREAKER_THRESHOLD = 3;
export const V2_BREAKER_COOLDOWN_MS = 60_000;

export class SourceBreakers {
  private readonly map = new Map<string, CircuitBreaker>();

  constructor(
    private readonly threshold = V2_BREAKER_THRESHOLD,
    private readonly cooldownMs = V2_BREAKER_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private get(id: string): CircuitBreaker {
    let b = this.map.get(id);
    if (!b) {
      b = new CircuitBreaker(this.threshold, this.cooldownMs, this.cooldownMs * 16, this.now);
      this.map.set(id, b);
    }
    return b;
  }

  state(id: string): BreakerState {
    return this.map.get(id)?.snapshot().state ?? "closed";
  }

  /** Claim permission to call the source now (takes the single half-open trial slot). */
  tryAcquire(id: string): boolean {
    try {
      this.get(id).assertCanPass(id);
      return true;
    } catch {
      return false;
    }
  }

  success(id: string): void {
    this.get(id).onSuccess();
  }

  failure(id: string): void {
    this.get(id).onFailure();
  }

  /** Outcome that says nothing about the source's health (e.g. chapter locked). */
  neutral(id: string): void {
    this.get(id).onNeutral();
  }

  /**
   * Fallback ordering: keeps the given (stable) order, puts half-open sources
   * after closed ones and drops open ones.
   */
  order<T>(items: T[], idOf: (t: T) => string): T[] {
    const closed: T[] = [];
    const half: T[] = [];
    for (const it of items) {
      const s = this.state(idOf(it));
      if (s === "closed") closed.push(it);
      else if (s === "half_open") half.push(it);
    }
    return [...closed, ...half];
  }

  reset(): void {
    this.map.clear();
  }
}

let shared: SourceBreakers | null = null;

export function v2Breakers(): SourceBreakers {
  if (!shared) shared = new SourceBreakers();
  return shared;
}

/** Test helper. */
export function resetV2Breakers(): void {
  shared = null;
}
