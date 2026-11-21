import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager, MemoryStore, keepAlive } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { SUSPENDED_GRACE_MS, isSuspendedRun, probeAll } from "@/lib/services/health";

/**
 * On Vercel, work left running after a response is frozen and resumes later,
 * so its timers fire minutes late. Background refreshes must ask the platform
 * to stay alive, and a health run the process slept through must not be kept.
 */
const CTX = Symbol.for("@vercel/request-context");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[CTX];
});

describe("keepAlive", () => {
  it("hands the promise to the platform's waitUntil when a request context exists", () => {
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[CTX] = { get: () => ({ waitUntil }) };
    const p = Promise.resolve();
    keepAlive(p);
    expect(waitUntil).toHaveBeenCalledWith(p);
  });

  it("is a no-op without one (next start, tests)", () => {
    expect(() => keepAlive(Promise.resolve())).not.toThrow();
  });

  it("stale-while-revalidate refreshes are kept alive", async () => {
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[CTX] = { get: () => ({ waitUntil }) };
    let now = 0;
    const m = new CacheManager(new MemoryStore(100, 1_000_000, () => now), true, () => now);
    await m.wrap("k", { ttl: 10, swr: 20 }, async () => "v1");
    expect(waitUntil).not.toHaveBeenCalled();
    now = 15_000;
    expect(await m.wrap("k", { ttl: 10, swr: 20 }, async () => "v2")).toMatchObject({ cache: "stale" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await m.settle();
  });
});

describe("health runs the process slept through", () => {
  it("a run that outlived its own deadline is flagged and a normal one is not", async () => {
    expect(isSuspendedRun(await probeAll([]))).toBe(false);
    const real = Date.now;
    let calls = 0;
    // first read is the start; every later read is far past the overall deadline
    vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? real() : real() + getConfig().health.overallTimeoutMs + SUSPENDED_GRACE_MS + 60_000));
    expect(isSuspendedRun(await probeAll([]))).toBe(true);
  });
});
