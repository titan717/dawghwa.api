import { describe, expect, it } from "vitest";
import { KeyedRateLimiter, ProviderLimiter } from "@/lib/core/rate-limiter";

describe("ProviderLimiter", () => {
  it("limits concurrency", async () => {
    const limiter = new ProviderLimiter({ rps: 1000, burst: 1000, maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const release = await limiter.acquire();
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        release();
      }),
    );
    expect(peak).toBe(2);
    expect(limiter.inFlight).toBe(0);
  });

  it("enforces a token-bucket rate", async () => {
    const limiter = new ProviderLimiter({ rps: 50, burst: 2, maxConcurrent: 10 });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) (await limiter.acquire())();
    // 2 burst + 3 at 50 rps ~= 60ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it("bounds the queue and rejects overflow", async () => {
    const limiter = new ProviderLimiter({ rps: 1000, burst: 1000, maxConcurrent: 1, maxQueue: 1 });
    const release = await limiter.acquire();
    const queued = limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    release();
    (await queued)();
  });

  it("removes aborted waiters", async () => {
    const limiter = new ProviderLimiter({ rps: 1000, burst: 1000, maxConcurrent: 1 });
    const release = await limiter.acquire();
    const c = new AbortController();
    const waiting = limiter.acquire(c.signal);
    expect(limiter.queued).toBe(1);
    c.abort(new Error("gone"));
    await expect(waiting).rejects.toThrow("gone");
    expect(limiter.queued).toBe(0);
    release();
  });

  it("release is idempotent", async () => {
    const limiter = new ProviderLimiter({ rps: 1000, burst: 1000, maxConcurrent: 1 });
    const release = await limiter.acquire();
    release();
    release();
    expect(limiter.inFlight).toBe(0);
  });
});

describe("KeyedRateLimiter", () => {
  it("allows up to the limit then reports retry-after", () => {
    let now = 0;
    const rl = new KeyedRateLimiter(3, 100, () => now);
    expect(rl.take("a").allowed).toBe(true);
    expect(rl.take("a").allowed).toBe(true);
    expect(rl.take("a").allowed).toBe(true);
    const denied = rl.take("a");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(rl.take("b").allowed).toBe(true); // independent keys
    now += 20_000; // refills 1 token per 20s at 3/min
    expect(rl.take("a").allowed).toBe(true);
  });
  it("bounds the number of tracked keys", () => {
    const rl = new KeyedRateLimiter(10, 5);
    for (let i = 0; i < 50; i++) rl.take(`k${i}`);
    expect(rl.size).toBe(5);
  });
});
