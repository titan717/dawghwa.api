import { DawghwaError } from "./errors";

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt?: number;
  retryAt?: number;
}

/**
 * Per-source circuit breaker.
 *
 * closed    -> requests flow; N consecutive source failures open the circuit.
 * open      -> requests fail fast with SOURCE_CIRCUIT_OPEN until the cooldown ends.
 * half_open -> exactly one trial request is let through; success closes the
 *              circuit, failure re-opens it with an exponentially longer cooldown.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private cooldown: number;
  private trialInFlight = false;

  constructor(
    private readonly threshold: number,
    private readonly baseCooldownMs: number,
    private readonly maxCooldownMs = baseCooldownMs * 16,
    private readonly now: () => number = Date.now,
  ) {
    this.cooldown = baseCooldownMs;
  }

  snapshot(): BreakerSnapshot {
    this.tick();
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      openedAt: this.state === "closed" ? undefined : this.openedAt,
      retryAt: this.state === "open" ? this.openedAt + this.cooldown : undefined,
    };
  }

  private tick(): void {
    if (this.state === "open" && this.now() >= this.openedAt + this.cooldown) {
      this.state = "half_open";
      this.trialInFlight = false;
    }
  }

  /** Throws SOURCE_CIRCUIT_OPEN when the call must not proceed. */
  assertCanPass(sourceName: string): void {
    this.tick();
    if (this.state === "closed") return;
    if (this.state === "half_open" && !this.trialInFlight) {
      this.trialInFlight = true;
      return;
    }
    const retryAfter = Math.max(1, Math.ceil((this.openedAt + this.cooldown - this.now()) / 1000));
    throw new DawghwaError(
      "SOURCE_CIRCUIT_OPEN",
      `${sourceName} is temporarily disabled after repeated failures`,
      { retryable: true, retryAfter, details: { retryAfter } },
    );
  }

  onSuccess(): void {
    this.state = "closed";
    this.failures = 0;
    this.cooldown = this.baseCooldownMs;
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.tick();
    if (this.state === "half_open") {
      this.cooldown = Math.min(this.maxCooldownMs, this.cooldown * 2);
      this.open();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.open();
  }

  /** A non-source failure (e.g. 404 for a bad URL) must not keep a trial slot. */
  onNeutral(): void {
    this.trialInFlight = false;
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.trialInFlight = false;
  }

  reset(): void {
    this.onSuccess();
  }
}
