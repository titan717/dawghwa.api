import { describe, expect, it } from "vitest";
import { backoffDelay, combineSignals, parseRetryAfter, sleep } from "@/lib/core/retry";

describe("backoffDelay (exponential, full jitter)", () => {
  it("grows exponentially and is capped", () => {
    const max = { baseMs: 100, maxMs: 1000, random: () => 0.999999 };
    expect(backoffDelay(0, max)).toBe(99);
    expect(backoffDelay(1, max)).toBe(199);
    expect(backoffDelay(2, max)).toBe(399);
    expect(backoffDelay(10, max)).toBe(999);
  });
  it("applies jitter in [0, cap)", () => {
    expect(backoffDelay(3, { baseMs: 100, maxMs: 10_000, random: () => 0 })).toBe(0);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(2, { baseMs: 100, maxMs: 10_000 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(400);
    }
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("sleep / combineSignals", () => {
  it("sleep is cancellable", async () => {
    const c = new AbortController();
    const p = sleep(10_000, c.signal);
    c.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
  it("combineSignals aborts on timeout with TimeoutError and cleans up", async () => {
    const { signal, cleanup } = combineSignals([], 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
    cleanup();
  });
  it("combineSignals follows parent signals", () => {
    const parent = new AbortController();
    const { signal, cleanup } = combineSignals([parent.signal]);
    parent.abort(new Error("parent"));
    expect(signal.aborted).toBe(true);
    cleanup();
  });
});
