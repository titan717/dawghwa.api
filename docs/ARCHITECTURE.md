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
  lib/metadata/             catalogue/metadata providers (AniList, MangaDex, MangaUpdates), shared
                            client (rate limits, breaker, error mapping), title matching
  lib/services/availability.ts  "which sources carry this title" (fan-out search + matching)
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

## Metadata and source availability

The metadata layer (`lib/metadata/`) is separate from the source adapters.

- Each provider (`anilist.ts`, `mangadex.ts`, `mangaupdates.ts`) implements `MetadataProvider`: `parseId`, `getTitle`, `browse` and `filterOptions`. It maps the provider's own vocabulary to one shared model (`TitleSummary` / `TitleMetadata`, plus format, status and sort enums).
- Each provider declares `capabilities.filters`. `clampCatalogQuery` rejects a filter the provider cannot apply with a 400, instead of silently ignoring it.
- `client.ts` sends every request through the shared HTTP client (SSRF guard, retries, size limits), adds a per-provider rate limit and circuit breaker, and maps 404/400/429 to `NOT_FOUND`/`VALIDATION_ERROR`/`UPSTREAM_RATE_LIMITED`. Requests identify themselves as `dawghwa-api/<version>`, not as a browser (MangaDex rejects spoofed browser user agents). MangaDex metadata shares the MangaDex adapter's rate-limit key, so both stay within one budget.
- Results go through the tiered cache (policies `metadata`, `catalog`).
- Cross-database ids (`?enrich=true`) come only from MangaDex's `links` table. MangaUpdates slugs are base36 series ids and are decoded exactly.

`lib/metadata/match.ts` scores titles:
- It normalizes the title (NFKD, removes diacritics and punctuation, case) and strips bracketed notes.
- It takes the larger of character-bigram Dice similarity and token overlap, then penalizes length differences, so "Solo Leveling" against "Solo Leveling: Ragnarok" scores 0.71.
- `searchableTitles` keeps Latin-script titles as queries; native-script titles are used only for matching.

`lib/services/availability.ts` works in three steps:
- Filter: it decides each source's `state` from the most recent evidence, either passive metrics from real traffic or the last cached health report. Blocked or failing sources are skipped, and that evidence expires after 30 minutes.
- Search: `searchAll` runs with the primary title. Sources with no match get one more query with an alternative title, within the remaining time budget.
- Rank: confidence, then latest chapter, then priority. Each source line is emitted as soon as it is final, which drives the NDJSON stream.

Because it reuses `searchAll`, availability inherits per-source isolation. One broken source becomes one `error` line, and source search results share the search cache with `/api/search`.

## Adding chapter-page support to another source

Implement `getChapterPages(chapter, options)` on the adapter **only** if the provider offers a documented, permitted API for it. The capability then turns on automatically. Do not parse reader pages that a provider protects or forbids.
