# Architecture

```
src/
  app/api/*/route.ts        thin route handlers: validation (zod), response shape
  middleware.ts             CORS, preflight, early body-size check
  lib/api/                  route wrapper (request id, rate limits, error format), shared schemas
  lib/services/             search (single + streaming multi-source), catalog (chapters, manga,
                            frontpage, pages, URL validation), health (probes)
  lib/providers/            registry, Provider (isolation wrapper), status data, normalization,
                            generated domain manifest
  lib/core/                 config, errors, http client, net guard, retry/backoff, rate limiter,
                            circuit breaker, cache (memory/redis/tiered, SWR), singleflight, pool,
                            anti-bot detection, async operation context
  lib/scrapers/             96 source adapters (from upstream) + BaseScraper
  lib/frontpages/           frontpage adapters (Comix)
```

## Request flow

1. **Route** (`lib/api/handler.ts` `route()`): assigns a request id, applies the per-client rate limit, reads the body with a streaming size limit, validates it with zod, and converts any thrown error into the standard error body.
2. **Service**: builds a cache key and calls `CacheManager.wrap()` with the policy for that data type. Concurrent identical requests share one loader (singleflight). A stale value is served while one background refresh runs.
3. **Provider.run()**: checks the source is operational and its circuit is closed. It then runs the adapter call inside an `AsyncLocalStorage` operation context that holds a deadline, an `AbortSignal`, the provider id and stats. Failures are classified, and the breaker and metrics are updated. An empty result is turned into an error when every upstream request in the operation failed (adapters that swallow errors).
4. **Adapter**: the upstream parsing logic, mostly unchanged. All network access goes through `this.http()` / `fetchWithRetry()`, which delegate to the shared client.
5. **HTTP client** (`lib/core/http.ts`), in order:
   - SSRF guard on every hop (redirects are followed manually)
   - per-provider token bucket and concurrency limiter, taken from the operation context
   - per-attempt timeout combined with the operation deadline and caller signal
   - retries only for 408/425/429/5xx/network errors, with full-jitter backoff and `Retry-After`
   - anti-bot challenge detection (no bypass)
   - response size limit
   - ETag / Last-Modified conditional revalidation
   - dedup of identical in-flight GET/POST requests; every caller gets its own `Response` copy

## Why the adapters were kept as-is

The 96 adapters contain a lot of duplicated code. About 17 follow Madara-like markup and 13 MangaThemesia-like markup. They were deliberately **not** merged into shared base classes:

- Each site drifts on its own schedule. Shared parsers couple failures together, which is the opposite of "one broken website cannot break the whole API".
- Merging them without a fixture corpus for every site would change behaviour silently.

The cross-cutting concerns that were duplicated (fetching, retries, timeouts, error handling, URL ownership) now live in the shared core. Upstream adapters had 81 raw `fetch()` call sites; all of them now use `this.http()`.

## Source metadata

- `lib/shutdown-sources.ts` (from upstream) and `lib/providers/status.ts` hold the declared status (`active`, `unstable`, `shutdown`), notes, aliases, priorities and special rate limits.
- `lib/providers/manifest.generated.ts` comes from `scripts/generate-source-manifest.mjs`. It lists each adapter's allowed domains (taken from its `canHandle()` and base URL) and is used for exact host matching. CI fails if it is out of date.
- Capabilities are detected from the adapter: `frontpage` when a frontpage adapter is registered, `chapterPages` when the adapter implements `getChapterPages`, and `clientOnly` from `isClientOnly()`.

## Adding chapter-page support to another source

Implement `getChapterPages(chapter, options)` on the adapter **only** if the provider offers a documented, permitted API for it. The capability then turns on automatically. Do not parse reader pages that a provider protects or forbids.
