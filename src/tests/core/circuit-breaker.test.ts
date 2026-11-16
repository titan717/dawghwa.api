import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "@/lib/core/circuit-breaker";

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures and fails fast", () => {
    const now = 0;
    const b = new CircuitBreaker(3, 1000, 8000, () => now);
    b.onFailure();
    b.onFailure();
    expect(b.snapshot().state).toBe("closed");
    b.onFailure();
    expect(b.snapshot().state).toBe("open");
    expect(() => b.assertCanPass("X")).toThrowError(expect.objectContaining({ code: "SOURCE_CIRCUIT_OPEN" }));
  });

  it("allows exactly one half-open trial; success closes", () => {
    let now = 0;
    const b = new CircuitBreaker(1, 1000, 8000, () => now);
    b.onFailure();
    now = 1000;
    expect(b.snapshot().state).toBe("half_open");
    b.assertCanPass("X");
    expect(() => b.assertCanPass("X")).toThrow();
    b.onSuccess();
    expect(b.snapshot().state).toBe("closed");
    b.assertCanPass("X");
  });

  it("failed trial re-opens with doubled cooldown", () => {
    let now = 0;
    const b = new CircuitBreaker(1, 1000, 8000, () => now);
    b.onFailure();
    now = 1000;
    b.assertCanPass("X");
    b.onFailure();
    const snap = b.snapshot();
    expect(snap.state).toBe("open");
    expect(snap.retryAt! - snap.openedAt!).toBe(2000);
  });

  it("success resets the failure count", () => {
    const b = new CircuitBreaker(2, 1000);
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    expect(b.snapshot().state).toBe("closed");
  });
});
