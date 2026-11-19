/**
 * Central runtime configuration for Dawghwa API.
 *
 * Every value can be overridden with an environment variable. Values are read
 * lazily (on each call to `getConfig()`), so tests can change `process.env`
 * and call `resetConfig()`.
 */

function num(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function list(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface CachePolicy {
  /** Seconds an entry is served as fresh. */
  ttl: number;
  /** Extra seconds an expired entry may be served while it is revalidated. 0 disables SWR. */
  swr: number;
}

export interface DawghwaConfig {
  version: string;
  http: {
    userAgent: string;
    /** Per-attempt upstream request timeout. */
    requestTimeoutMs: number;
    /** Extra attempts after the first one for retryable failures. */
    retries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    /** Maximum upstream response body we are willing to buffer. */
    maxResponseBytes: number;
    /** Entries kept for ETag / Last-Modified revalidation. */
    conditionalCacheEntries: number;
    conditionalCacheMaxBytes: number;
  };
  providers: {
    /** Overall budget for one provider operation (search, chapters, ...). */
    operationTimeoutMs: number;
    defaultRps: number;
    defaultBurst: number;
    defaultMaxConcurrent: number;
    breakerFailureThreshold: number;
    breakerCooldownMs: number;
    /** Source ids disabled by the operator (comma separated DISABLED_SOURCES). */
    disabled: string[];
    /** Source ids searched first in "all" searches (comma separated SOURCE_PRIORITY). */
    priority: string[];
  };
  search: {
    concurrency: number;
    perSourceTimeoutMs: number;
    overallTimeoutMs: number;
  };
  health: {
    concurrency: number;
    perSourceTimeoutMs: number;
    overallTimeoutMs: number;
  };
  cache: {
    enabled: boolean;
    memoryMaxEntries: number;
    memoryMaxBytes: number;
    redisUrl?: string;
    redisToken?: string;
    redisPrefix: string;
    policies: {
      search: CachePolicy;
      chapters: CachePolicy;
      metadata: CachePolicy;
      frontpage: CachePolicy;
      health: CachePolicy;
      pages: CachePolicy;
      catalog: CachePolicy;
    };
  };
  metadata: {
    /** Metadata/catalogue providers that may be used (METADATA_PROVIDERS). */
    providers: string[];
    defaultProvider: string;
    timeoutMs: number;
    /** AniList documents 90 req/min (currently degraded to 30). */
    anilistPerMinute: number;
  };
  availability: {
    /** Minimum title similarity (0-1) for a source result to count as the same title. */
    minScore: number;
    /** Alternative titles tried for sources that had no match for the main title. */
    maxAltQueries: number;
  };
  api: {
    maxBodyBytes: number;
    rateLimitEnabled: boolean;
    /** Requests per minute per client for normal endpoints. */
    rateLimitPerMinute: number;
    /** Requests per minute per client for expensive endpoints (search all, health refresh). */
    rateLimitExpensivePerMinute: number;
    trustProxy: boolean;
    corsOrigins: string[];
    exposeErrorDetails: boolean;
  };
}

let cached: DawghwaConfig | null = null;

export function resetConfig(): void {
  cached = null;
}

export function getConfig(): DawghwaConfig {
  if (cached) return cached;
  cached = {
    version: process.env.DAWGHWA_VERSION || "1.2.0",
    http: {
      userAgent:
        process.env.UPSTREAM_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      requestTimeoutMs: num("UPSTREAM_TIMEOUT_MS", 10_000, 500, 120_000),
      retries: num("UPSTREAM_RETRIES", 2, 0, 5),
      retryBaseDelayMs: num("UPSTREAM_RETRY_BASE_MS", 300, 0, 10_000),
      retryMaxDelayMs: num("UPSTREAM_RETRY_MAX_MS", 4_000, 0, 60_000),
      maxResponseBytes: num("UPSTREAM_MAX_RESPONSE_BYTES", 8 * 1024 * 1024, 64 * 1024),
      conditionalCacheEntries: num("CONDITIONAL_CACHE_ENTRIES", 500, 0, 100_000),
      conditionalCacheMaxBytes: num("CONDITIONAL_CACHE_MAX_BYTES", 64 * 1024 * 1024, 0),
    },
    providers: {
      operationTimeoutMs: num("SOURCE_OPERATION_TIMEOUT_MS", 25_000, 1_000, 300_000),
      defaultRps: num("SOURCE_DEFAULT_RPS", 5, 0.1, 1_000),
      defaultBurst: num("SOURCE_DEFAULT_BURST", 10, 1, 1_000),
      defaultMaxConcurrent: num("SOURCE_DEFAULT_MAX_CONCURRENT", 6, 1, 1_000),
      breakerFailureThreshold: num("BREAKER_FAILURE_THRESHOLD", 5, 1, 1_000),
      breakerCooldownMs: num("BREAKER_COOLDOWN_MS", 60_000, 1_000, 3_600_000),
      disabled: list("DISABLED_SOURCES"),
      priority: list("SOURCE_PRIORITY"),
    },
    search: {
      concurrency: num("SEARCH_CONCURRENCY", 16, 1, 200),
      perSourceTimeoutMs: num("SEARCH_SOURCE_TIMEOUT_MS", 12_000, 500, 120_000),
      overallTimeoutMs: num("SEARCH_OVERALL_TIMEOUT_MS", 25_000, 1_000, 300_000),
    },
    health: {
      concurrency: num("HEALTH_CONCURRENCY", 12, 1, 200),
      perSourceTimeoutMs: num("HEALTH_SOURCE_TIMEOUT_MS", 15_000, 500, 120_000),
      overallTimeoutMs: num("HEALTH_OVERALL_TIMEOUT_MS", 55_000, 1_000, 600_000),
    },
    cache: {
      enabled: bool("CACHE_ENABLED", true),
      memoryMaxEntries: num("CACHE_MEMORY_MAX_ENTRIES", 2_000, 0, 1_000_000),
      memoryMaxBytes: num("CACHE_MEMORY_MAX_BYTES", 64 * 1024 * 1024, 0),
      redisUrl: process.env.REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL || undefined,
      redisToken: process.env.REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || undefined,
      redisPrefix: process.env.REDIS_PREFIX || "dawghwa:",
      policies: {
        search: { ttl: num("CACHE_SEARCH_TTL", 300), swr: num("CACHE_SEARCH_SWR", 1_800) },
        chapters: { ttl: num("CACHE_CHAPTERS_TTL", 600), swr: num("CACHE_CHAPTERS_SWR", 3_600) },
        metadata: { ttl: num("CACHE_METADATA_TTL", 3_600), swr: num("CACHE_METADATA_SWR", 86_400) },
        frontpage: { ttl: num("CACHE_FRONTPAGE_TTL", 300), swr: num("CACHE_FRONTPAGE_SWR", 1_800) },
        health: { ttl: num("CACHE_HEALTH_TTL", 300), swr: num("CACHE_HEALTH_SWR", 1_800) },
        // MangaDex@Home base URLs are only valid for a limited time, so no SWR.
        pages: { ttl: num("CACHE_PAGES_TTL", 300), swr: 0 },
        catalog: { ttl: num("CACHE_CATALOG_TTL", 900), swr: num("CACHE_CATALOG_SWR", 3_600) },
      },
    },
    metadata: {
      providers: list("METADATA_PROVIDERS").length
        ? list("METADATA_PROVIDERS").map((s) => s.toLowerCase())
        : ["anilist", "mangadex", "mangaupdates"],
      defaultProvider: (process.env.METADATA_DEFAULT_PROVIDER || "anilist").toLowerCase(),
      timeoutMs: num("METADATA_TIMEOUT_MS", 10_000, 1_000, 60_000),
      anilistPerMinute: num("ANILIST_REQUESTS_PER_MINUTE", 30, 1, 90),
    },
    availability: {
      minScore: num("AVAILABILITY_MIN_SCORE", 0.82, 0.5, 1),
      maxAltQueries: num("AVAILABILITY_MAX_ALT_QUERIES", 1, 0, 3),
    },
    api: {
      maxBodyBytes: num("API_MAX_BODY_BYTES", 16 * 1024, 256, 1024 * 1024),
      rateLimitEnabled: bool("RATE_LIMIT_ENABLED", true),
      rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 120, 1),
      rateLimitExpensivePerMinute: num("RATE_LIMIT_EXPENSIVE_PER_MINUTE", 12, 1),
      trustProxy: bool("TRUST_PROXY", true),
      corsOrigins: list("CORS_ORIGINS").length ? list("CORS_ORIGINS") : ["*"],
      exposeErrorDetails: bool("EXPOSE_ERROR_DETAILS", false),
    },
  };
  return cached;
}
