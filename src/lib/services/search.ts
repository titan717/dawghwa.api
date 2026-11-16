import { cacheKey, getCache, normalizeQuery, CacheStatus } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { DawghwaError, ErrorCode, toDawghwaError } from "@/lib/core/errors";
import { runPool } from "@/lib/core/pool";
import { combineSignals } from "@/lib/core/retry";
import { normalizeSearchResults } from "@/lib/providers/normalize";
import type { Provider } from "@/lib/providers/provider";
import type { SearchResult } from "@/types";

export interface SourceSearchOutcome {
  results: SearchResult[];
  cache: CacheStatus;
  age: number;
  durationMs: number;
}

export async function searchProvider(
  provider: Provider,
  query: string,
  opts: { forceRefresh?: boolean; timeoutMs?: number } = {},
): Promise<SourceSearchOutcome> {
  provider.assertOperational();
  const started = Date.now();
  const cache = getCache();
  const policy = getConfig().cache.policies.search;
  const out = await cache.wrap(
    cacheKey("search", provider.id, normalizeQuery(query)),
    policy,
    async () => {
      // The loader is shared by concurrent callers, so it is deliberately not
      // bound to any single client's AbortSignal; it is bounded by timeoutMs.
      const { value } = await provider.run("search", () => provider.scraper.search(query), {
        timeoutMs: opts.timeoutMs,
      });
      return normalizeSearchResults(value, provider.descriptor.baseUrl).results;
    },
    { forceRefresh: opts.forceRefresh },
  );
  return { results: out.value, cache: out.cache, age: out.age, durationMs: Date.now() - started };
}

/** One NDJSON line per source (upstream-compatible fields first). */
export interface StreamingSourceResult {
  source: string;
  results: SearchResult[];
  error?: string;
  done: false;
  sourceId: string;
  errorCode?: ErrorCode;
  cached?: boolean;
  durationMs: number;
}

export interface SearchSummary {
  done: true;
  totalSources: number;
  completedSources: number;
  failedSources: number;
  timedOutSources: number;
  totalResults: number;
  durationMs: number;
}

export interface SearchAllOptions {
  providers: Provider[];
  concurrency?: number;
  perSourceTimeoutMs?: number;
  overallTimeoutMs?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  onResult: (line: StreamingSourceResult) => void;
}

/**
 * Parallel multi-source search with bounded concurrency, per-source timeouts,
 * an overall deadline and cancellation. Results are emitted as each source
 * finishes (streaming), cached per source, and a slow or broken source never
 * delays the others beyond its own timeout.
 */
export async function searchAll(query: string, opts: SearchAllOptions): Promise<SearchSummary> {
  const cfg = getConfig().search;
  const started = Date.now();
  const perSource = opts.perSourceTimeoutMs ?? cfg.perSourceTimeoutMs;
  const overall = opts.overallTimeoutMs ?? cfg.overallTimeoutMs;
  const { signal, cleanup } = combineSignals([opts.signal], overall);
  const emitted = new Set<string>();
  let completed = 0;
  let failed = 0;
  let timedOut = 0;
  let totalResults = 0;

  const emit = (line: StreamingSourceResult) => {
    if (emitted.has(line.sourceId)) return;
    emitted.add(line.sourceId);
    // Upstream semantics: completedSources counts every finished source, failed ones included.
    completed++;
    if (line.error) failed++;
    if (line.errorCode === "UPSTREAM_TIMEOUT") timedOut++;
    totalResults += line.results.length;
    opts.onResult(line);
  };

  const deadline = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

  const pool = runPool(
    opts.providers,
    opts.concurrency ?? cfg.concurrency,
    async (provider) => {
      const t0 = Date.now();
      const task = searchProvider(provider, query, { forceRefresh: opts.forceRefresh, timeoutMs: perSource })
        .then((r) =>
          emit({
            source: provider.name,
            sourceId: provider.id,
            results: r.results,
            done: false,
            cached: r.cache === "hit" || r.cache === "stale",
            durationMs: r.durationMs,
          }),
        )
        .catch((e) => {
          const err = toDawghwaError(e);
          emit({
            source: provider.name,
            sourceId: provider.id,
            results: [],
            error: err.message,
            errorCode: err.code,
            done: false,
            durationMs: Date.now() - t0,
          });
        });
      // Do not let one source hold a pool lane past the overall deadline.
      await Promise.race([task, deadline]);
    },
    signal,
  );

  await Promise.race([pool, deadline]);
  cleanup();

  const reason = opts.signal?.aborted ? "Search cancelled" : `Search deadline of ${overall}ms reached`;
  for (const provider of opts.providers) {
    if (!emitted.has(provider.id)) {
      emit({
        source: provider.name,
        sourceId: provider.id,
        results: [],
        error: reason,
        errorCode: opts.signal?.aborted ? "CANCELLED" : "UPSTREAM_TIMEOUT",
        done: false,
        durationMs: Date.now() - started,
      });
    }
  }

  return {
    done: true,
    totalSources: opts.providers.length,
    completedSources: completed,
    failedSources: failed,
    timedOutSources: timedOut,
    totalResults,
    durationMs: Date.now() - started,
  };
}

export function assertQuery(query: string): string {
  const q = query.trim();
  if (!q) throw new DawghwaError("VALIDATION_ERROR", "Search query is required");
  return q;
}
