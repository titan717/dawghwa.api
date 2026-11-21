import { CachePolicy, getConfig } from "../config";
import { SingleFlight } from "../singleflight";
import { CacheEntry, CacheStore, MemoryStore, RedisRestStore, TieredStore } from "./store";

export type CacheStatus = "hit" | "stale" | "miss" | "bypass";

/**
 * Keep the serverless function alive until a background promise settles.
 * On Vercel, work still running after the response is sent is frozen and
 * resumes on a later invocation, so its timers fire minutes late: upstream
 * calls "time out", breakers open and health records every source as down.
 * This is the request context that @vercel/functions' waitUntil() reads;
 * elsewhere (next start, tests) it is absent and this is a no-op.
 */
export function keepAlive(p: Promise<unknown>): void {
  try {
    const store = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
      | { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined }
      | undefined;
    store?.get?.()?.waitUntil?.(p);
  } catch {
    // no request context: nothing to extend
  }
}

export interface CachedResult<T> {
  value: T;
  cache: CacheStatus;
  /** Age of the served value in seconds. */
  age: number;
}

export interface CachedOptions {
  /** Skip reading the cache (still writes the fresh value). */
  forceRefresh?: boolean;
  /** Do not cache this value (e.g. empty results from an unhealthy source). */
  shouldCache?: (value: unknown) => boolean;
}

/**
 * Cache manager with stale-while-revalidate and request coalescing.
 *
 *  fresh (age < ttl)            -> return cached value ("hit")
 *  stale (ttl <= age < ttl+swr) -> return cached value immediately ("stale") and
 *                                  refresh it in the background (deduplicated)
 *  expired / missing            -> load once for all concurrent callers ("miss")
 *
 * Loader errors are never cached.
 */
export class CacheManager {
  private flights = new SingleFlight<unknown>();
  readonly backgroundRefreshes = new Set<Promise<unknown>>();

  constructor(
    readonly store: CacheStore,
    private readonly enabled = true,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    return this.store.get<T>(key);
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }

  async wrap<T>(
    key: string,
    policy: CachePolicy,
    loader: () => Promise<T>,
    opts: CachedOptions = {},
  ): Promise<CachedResult<T>> {
    if (!this.enabled || policy.ttl <= 0) {
      const { promise } = this.flights.do(`nocache:${key}`, loader);
      return { value: (await promise) as T, cache: "bypass", age: 0 };
    }

    if (!opts.forceRefresh) {
      const entry = await this.store.get<T>(key);
      if (entry) {
        const age = (this.now() - entry.storedAt) / 1000;
        if (age < entry.ttl) return { value: entry.value, cache: "hit", age: Math.floor(age) };
        if (age < entry.ttl + entry.swr) {
          this.revalidate(key, policy, loader, opts);
          return { value: entry.value, cache: "stale", age: Math.floor(age) };
        }
      }
    }

    const value = (await this.load(key, policy, loader, opts)) as T;
    return { value, cache: "miss", age: 0 };
  }

  private load<T>(key: string, policy: CachePolicy, loader: () => Promise<T>, opts: CachedOptions) {
    return this.flights.do(key, async () => {
      const value = await loader();
      if (!opts.shouldCache || opts.shouldCache(value)) {
        await this.store.set(key, { value, storedAt: this.now(), ttl: policy.ttl, swr: policy.swr });
      }
      return value;
    }).promise;
  }

  private revalidate<T>(key: string, policy: CachePolicy, loader: () => Promise<T>, opts: CachedOptions) {
    if (this.flights.has(key)) return; // already refreshing
    const p = this.load(key, policy, loader, opts)
      .catch(() => undefined) // keep serving the stale value; breaker/health record the failure
      .finally(() => this.backgroundRefreshes.delete(p));
    this.backgroundRefreshes.add(p);
    keepAlive(p);
  }

  /** Test helper: wait for all background revalidations. */
  async settle(): Promise<void> {
    await Promise.all([...this.backgroundRefreshes]);
  }
}

let manager: CacheManager | null = null;
let memory: MemoryStore | null = null;

export function getCache(): CacheManager {
  if (manager) return manager;
  const cfg = getConfig().cache;
  memory = new MemoryStore(cfg.memoryMaxEntries, cfg.memoryMaxBytes);
  const redis =
    cfg.redisUrl && cfg.redisToken
      ? new RedisRestStore(cfg.redisUrl, cfg.redisToken, cfg.redisPrefix)
      : undefined;
  manager = new CacheManager(new TieredStore(memory, redis), cfg.enabled);
  return manager;
}

export function getCacheInfo() {
  const m = getCache();
  return { backend: m.store.name, memory: memory?.stats };
}

/** Test helper. */
export function resetCache(): void {
  manager = null;
  memory = null;
}

/** Stable cache key from parts. Callers normalise case where it is safe (queries). */
export function cacheKey(namespace: string, ...parts: (string | number | undefined)[]): string {
  return [namespace, ...parts.map((p) => (p === undefined ? "" : encodeURIComponent(String(p))))].join("|");
}

/** Normalise free-text search queries for cache keys and deduplication. */
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export * from "./store";
