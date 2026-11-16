import { describe, expect, it, vi } from "vitest";
import { CacheManager, MemoryStore, RedisRestStore, TieredStore, cacheKey, normalizeQuery } from "@/lib/core/cache";
import type { CacheEntry, CacheStore } from "@/lib/core/cache";

const policy = { ttl: 10, swr: 20 };

function manager(now: () => number) {
  return new CacheManager(new MemoryStore(100, 1_000_000, now), true, now);
}

describe("CacheManager", () => {
  it("returns hit within ttl without calling the loader", async () => {
    let now = 0;
    const m = manager(() => now);
    const loader = vi.fn(async () => "v1");
    expect(await m.wrap("k", policy, loader)).toMatchObject({ value: "v1", cache: "miss" });
    now = 5_000;
    expect(await m.wrap("k", policy, loader)).toMatchObject({ value: "v1", cache: "hit", age: 5 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves stale and revalidates in the background (SWR)", async () => {
    let now = 0;
    const m = manager(() => now);
    let n = 0;
    const loader = vi.fn(async () => `v${++n}`);
    await m.wrap("k", policy, loader);
    now = 15_000;
    expect(await m.wrap("k", policy, loader)).toMatchObject({ value: "v1", cache: "stale" });
    await m.settle();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(await m.wrap("k", policy, loader)).toMatchObject({ value: "v2", cache: "hit" });
  });

  it("reloads after ttl + swr", async () => {
    let now = 0;
    const m = manager(() => now);
    let n = 0;
    await m.wrap("k", policy, async () => `v${++n}`);
    now = 31_000;
    expect(await m.wrap("k", policy, async () => `v${++n}`)).toMatchObject({ value: "v2", cache: "miss" });
  });

  it("deduplicates concurrent misses", async () => {
    const m = manager(Date.now);
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => m.wrap("k", policy, loader)));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.value === 42)).toBe(true);
  });

  it("never caches errors", async () => {
    const m = manager(Date.now);
    await expect(m.wrap("k", policy, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await m.wrap("k", policy, async () => "ok")).toMatchObject({ value: "ok", cache: "miss" });
  });

  it("keeps serving stale when revalidation fails", async () => {
    let now = 0;
    const m = manager(() => now);
    await m.wrap("k", policy, async () => "good");
    now = 15_000;
    expect(await m.wrap("k", policy, async () => Promise.reject(new Error("down")))).toMatchObject({
      value: "good",
      cache: "stale",
    });
    await m.settle();
  });

  it("respects shouldCache and forceRefresh", async () => {
    const m = manager(Date.now);
    await m.wrap("k", policy, async () => [], { shouldCache: (v) => (v as unknown[]).length > 0 });
    expect((await m.wrap("k", policy, async () => [1])).cache).toBe("miss");
    expect((await m.wrap("k", policy, async () => [2], { forceRefresh: true })).value).toEqual([2]);
    expect((await m.wrap("k", policy, async () => [3])).value).toEqual([2]);
  });

  it("bypasses when disabled or ttl is 0", async () => {
    const m = new CacheManager(new MemoryStore(), false);
    expect((await m.wrap("k", policy, async () => 1)).cache).toBe("bypass");
    const m2 = manager(Date.now);
    expect((await m2.wrap("k", { ttl: 0, swr: 0 }, async () => 1)).cache).toBe("bypass");
  });
});

describe("MemoryStore", () => {
  const entry = (value: unknown): CacheEntry => ({ value, storedAt: 0, ttl: 10, swr: 0 });

  it("evicts least recently used entries beyond maxEntries", async () => {
    const s = new MemoryStore(2, 1_000_000, () => 0);
    await s.set("a", entry(1));
    await s.set("b", entry(2));
    await s.get("a");
    await s.set("c", entry(3));
    expect(await s.get("b")).toBeUndefined();
    expect(await s.get("a")).toBeDefined();
    expect(s.stats.entries).toBe(2);
  });

  it("is bounded by bytes", async () => {
    const s = new MemoryStore(1000, 100, () => 0);
    for (let i = 0; i < 20; i++) await s.set(`k${i}`, entry("x".repeat(30)));
    expect(s.stats.bytes).toBeLessThanOrEqual(100);
  });

  it("expires entries after ttl + swr", async () => {
    let now = 0;
    const s = new MemoryStore(10, 1_000_000, () => now);
    await s.set("a", { value: 1, storedAt: 0, ttl: 1, swr: 1 });
    now = 2_500;
    expect(await s.get("a")).toBeUndefined();
  });
});

describe("TieredStore / RedisRestStore", () => {
  it("falls back to L2 and promotes into L1", async () => {
    const l1 = new MemoryStore();
    const l2: CacheStore = {
      name: "fake",
      get: vi.fn(async () => ({ value: "remote", storedAt: Date.now(), ttl: 10, swr: 0 })) as unknown as CacheStore["get"],
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const t = new TieredStore(l1, l2);
    expect(t.name).toBe("memory+fake");
    expect((await t.get("k"))?.value).toBe("remote");
    expect((await l1.get("k"))?.value).toBe("remote");
  });

  it("RedisRestStore never throws and backs off when Redis is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = new RedisRestStore("https://redis.example", "token", "t:", fetchImpl);
    expect(await r.get("k")).toBeUndefined();
    await expect(r.set("k", { value: 1, storedAt: 0, ttl: 1, swr: 0 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second call skipped during back-off
  });

  it("RedisRestStore round-trips with the Upstash REST protocol", async () => {
    const data = new Map<string, string>();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const [cmd, key, value] = JSON.parse(String(init.body));
      if (cmd === "SET") data.set(key, value);
      return new Response(JSON.stringify({ result: cmd === "GET" ? (data.get(key) ?? null) : "OK" }));
    }) as unknown as typeof fetch;
    const r = new RedisRestStore("https://redis.example", "token", "t:", fetchImpl);
    await r.set("k", { value: { a: 1 }, storedAt: 1, ttl: 5, swr: 5 });
    expect(data.has("t:k")).toBe(true);
    expect((await r.get<{ a: number }>("k"))?.value).toEqual({ a: 1 });
  });
});

describe("keys", () => {
  it("normalizes queries", () => {
    expect(normalizeQuery("  Solo   LEVELING ")).toBe("solo leveling");
    expect(cacheKey("search", "mangadex", "a|b")).toBe("search|mangadex|a%7Cb");
  });
});
