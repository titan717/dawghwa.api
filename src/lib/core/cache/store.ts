export interface CacheEntry<T = unknown> {
  value: T;
  /** Epoch ms when the value was produced. */
  storedAt: number;
  /** Fresh lifetime in seconds. */
  ttl: number;
  /** Stale-while-revalidate window in seconds after ttl. */
  swr: number;
}

export interface CacheStore {
  readonly name: string;
  get<T>(key: string): Promise<CacheEntry<T> | undefined>;
  set<T>(key: string, entry: CacheEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
  clear?(): Promise<void>;
}

function estimateBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 1024;
  }
}

/**
 * Bounded in-memory LRU store. Bounded both by entry count and by an estimate
 * of serialized size so a few huge chapter lists cannot exhaust memory.
 * Expired entries (past ttl + swr) are dropped lazily on read and on insert.
 */
export class MemoryStore implements CacheStore {
  readonly name = "memory";
  private map = new Map<string, { entry: CacheEntry; bytes: number; expiresAt: number }>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 2_000,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  get stats() {
    return { entries: this.map.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes };
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const item = this.map.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= this.now()) {
      this.remove(key);
      return undefined;
    }
    // Refresh LRU order.
    this.map.delete(key);
    this.map.set(key, item);
    return item.entry as CacheEntry<T>;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    if (this.maxEntries === 0) return;
    const bytes = estimateBytes(entry.value);
    if (bytes > this.maxBytes) return; // never cache a single oversize value
    this.remove(key);
    this.map.set(key, {
      entry,
      bytes,
      expiresAt: entry.storedAt + (entry.ttl + entry.swr) * 1000,
    });
    this.bytes += bytes;
    this.evict();
  }

  async delete(key: string): Promise<void> {
    this.remove(key);
  }

  async clear(): Promise<void> {
    this.map.clear();
    this.bytes = 0;
  }

  private remove(key: string): void {
    const item = this.map.get(key);
    if (item) {
      this.bytes -= item.bytes;
      this.map.delete(key);
    }
  }

  private evict(): void {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
}

/**
 * Redis store using the Upstash-compatible REST protocol (works on any
 * serverless platform without TCP sockets; self-hosted Redis can be used via
 * the open source `serverless-redis-http` bridge). All failures are swallowed:
 * Redis is an optimisation, never a hard dependency.
 */
export class RedisRestStore implements CacheStore {
  readonly name = "redis";
  private disabledUntil = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly prefix = "dawghwa:",
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly timeoutMs = 800,
  ) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    if (Date.now() < this.disabledUntil) return undefined;
    try {
      const res = await this.fetchImpl(this.url.replace(/\/$/, ""), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`redis ${res.status}`);
      const json = (await res.json()) as { result?: unknown; error?: string };
      if (json.error) throw new Error("redis error");
      return json.result;
    } catch {
      // Back off for 30s so an unavailable Redis does not add latency to every request.
      this.disabledUntil = Date.now() + 30_000;
      return undefined;
    }
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const raw = await this.command(["GET", this.prefix + key]);
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw) as CacheEntry<T>;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    const ttl = Math.max(1, Math.ceil(entry.ttl + entry.swr));
    await this.command(["SET", this.prefix + key, JSON.stringify(entry), "EX", ttl]);
  }

  async delete(key: string): Promise<void> {
    await this.command(["DEL", this.prefix + key]);
  }
}

/** L1 memory + optional L2 Redis. Reads fall through and backfill L1. */
export class TieredStore implements CacheStore {
  readonly name: string;
  constructor(
    private readonly l1: CacheStore,
    private readonly l2?: CacheStore,
  ) {
    this.name = l2 ? `${l1.name}+${l2.name}` : l1.name;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    const hit = await this.l1.get<T>(key);
    if (hit || !this.l2) return hit;
    const remote = await this.l2.get<T>(key);
    if (remote) await this.l1.set(key, remote);
    return remote;
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await this.l1.set(key, entry);
    if (this.l2) await this.l2.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    await this.l1.delete(key);
    if (this.l2) await this.l2.delete(key);
  }

  async clear(): Promise<void> {
    await this.l1.clear?.();
  }
}
