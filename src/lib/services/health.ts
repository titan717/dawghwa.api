import { cacheKey, getCache, CacheStatus } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { DawghwaError, toDawghwaError } from "@/lib/core/errors";
import { runPool } from "@/lib/core/pool";
import type { Provider } from "@/lib/providers/provider";

/** Upstream-compatible statuses. */
export enum SourceStatus {
  HEALTHY = "healthy",
  CLOUDFLARE = "cloudflare",
  TIMEOUT = "timeout",
  ERROR = "error",
}

export interface SourceHealthResult {
  status: SourceStatus;
  message: string;
  responseTime?: number;
  lastChecked: string;
  /** Dawghwa additions */
  errorCode?: string;
  circuit?: string;
}

const HEALTH_QUERIES = ["the", "a"];

/**
 * Actively probe one source with a tiny search. Health probes are allowed
 * through an open circuit breaker (they are the half-open trial), and their
 * outcome feeds the breaker, so a recovered source is re-enabled automatically.
 */
export async function probeProvider(
  provider: Provider,
  timeoutMs?: number,
  queries: string[] = HEALTH_QUERIES,
): Promise<SourceHealthResult> {
  const lastChecked = new Date().toISOString();
  const started = Date.now();
  const budget = timeoutMs ?? getConfig().health.perSourceTimeoutMs;
  try {
    const { value } = await provider.run(
      "health",
      async () => {
        let results: unknown[] = [];
        for (const q of queries) {
          results = await provider.scraper.search(q);
          if (!Array.isArray(results) || results.length > 0) break;
        }
        if (!Array.isArray(results)) {
          throw new DawghwaError("UPSTREAM_ERROR", "Unexpected response format");
        }
        if (results.length === 0) {
          throw new DawghwaError("UPSTREAM_ERROR", `Search returned no results for ${queries.map((q) => `"${q}"`).join(" or ")}`);
        }
        return results;
      },
      { timeoutMs: budget, probe: true },
    );
    void value;
    return {
      status: SourceStatus.HEALTHY,
      message: "Source is operational",
      responseTime: Date.now() - started,
      lastChecked,
      circuit: provider.circuit().state,
    };
  } catch (e) {
    const err = toDawghwaError(e);
    const status =
      err.code === "UPSTREAM_BLOCKED"
        ? SourceStatus.CLOUDFLARE
        : err.code === "UPSTREAM_TIMEOUT"
          ? SourceStatus.TIMEOUT
          : SourceStatus.ERROR;
    return {
      status,
      message: err.code === "UPSTREAM_BLOCKED" ? "Cloudflare / anti-bot protection detected" : err.message,
      responseTime: Date.now() - started,
      lastChecked,
      errorCode: err.code,
      circuit: provider.circuit().state,
    };
  }
}

/**
 * Runs whose results cannot be trusted: the run took far longer than its own
 * overall deadline, which only happens when the process was suspended mid-run
 * (a frozen serverless function). Their "timeouts" are not observations.
 */
const suspendedRuns = new WeakSet<object>();
/** Slack over the overall deadline before a run counts as suspended. */
export const SUSPENDED_GRACE_MS = 10_000;
export function isSuspendedRun(results: unknown): boolean {
  return typeof results === "object" && results !== null && suspendedRuns.has(results);
}

export async function probeAll(providers: Provider[]): Promise<Record<string, SourceHealthResult>> {
  const cfg = getConfig().health;
  const startedAt = Date.now();
  const results: Record<string, SourceHealthResult> = {};
  const lastChecked = new Date().toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, cfg.overallTimeoutMs);
  });
  await Promise.race([
    runPool(
      providers,
      cfg.concurrency,
      async (p) => {
        results[p.id] = await probeProvider(p, cfg.perSourceTimeoutMs);
      },
      controller.signal,
    ),
    deadline,
  ]);
  clearTimeout(timer);
  for (const p of providers) {
    if (!results[p.id]) {
      results[p.id] = {
        status: SourceStatus.TIMEOUT,
        message: `Health check did not finish within ${cfg.overallTimeoutMs / 1000}s`,
        responseTime: cfg.overallTimeoutMs,
        lastChecked,
        errorCode: "UPSTREAM_TIMEOUT",
      };
    }
  }
  // Stable key order for consumers that diff the output.
  const out = Object.fromEntries(Object.entries(results).sort(([a], [b]) => a.localeCompare(b)));
  if (Date.now() - startedAt > cfg.overallTimeoutMs + SUSPENDED_GRACE_MS) suspendedRuns.add(out);
  return out;
}

export async function getHealth(
  providers: Provider[],
  opts: { forceRefresh?: boolean; scope?: string } = {},
): Promise<{ sources: Record<string, SourceHealthResult>; cache: CacheStatus; age: number }> {
  const out = await getCache().wrap(
    cacheKey("health", opts.scope ?? "all"),
    getConfig().cache.policies.health,
    () => probeAll(providers),
    // never store a run the process slept through (see isSuspendedRun)
    { forceRefresh: opts.forceRefresh, shouldCache: (v) => !isSuspendedRun(v) },
  );
  return { sources: out.value, cache: out.cache, age: out.age };
}
