# Changelog

All notable changes to Dawghwa API. The project follows [Semantic Versioning](https://semver.org/). Breaking changes to request/response shapes only happen in a major version.

## [Unreleased]

### Added
- MangaDex catalogue items include optional `description`, `tagNames` and `demographic`. This is additive; other providers omit them.

## [1.1.0] - 2026-11-17

### Added
- Catalogue and metadata from AniList, MangaDex and MangaUpdates.
  - `GET /api/catalog` filters by genre, excluded genre, tag, status, format, year, sort and nsfw, with pagination.
  - Also `GET /api/catalog/filters`, `GET /api/catalog/providers` and `GET /api/titles/{ref}`.
  - Title refs look like `anilist:`, `mangadex:` or `mangaupdates:`, with short forms `al:`, `md:` and `mu:`. MangaUpdates URL slugs are accepted.
  - `?enrich=true` adds exact cross-database ids via MangaDex links.
  - Every response carries attribution. Providers have their own rate limits (AniList 30/min, MangaDex shared 4 req/s, MangaUpdates 2 req/s) and circuit breakers, and results are cached (`catalog` policy, 15 min / 1 h SWR).
- Comick-style source choice.
  - `GET /api/titles/{ref}/sources` searches every working source in parallel, matches results against all known titles, and ranks the sources that carry the series. Each match has a confidence of exact, high or possible, plus candidates. JSON and NDJSON streaming are both supported.
  - `GET /api/titles/{ref}/chapters?source=` loads the chapter list from the source the user picked.
  - `POST /api/availability` runs the same lookup for free-text titles.
  - Sources recently seen blocked by anti-bot protection or failing are skipped and reported, and retried after 30 minutes or with `includeUnavailable=true`. Novel editions are not matched for comic series. Sources with no confident match are reported as unavailable, never guessed.
- Config: `METADATA_PROVIDERS`, `METADATA_DEFAULT_PROVIDER`, `METADATA_TIMEOUT_MS`, `ANILIST_REQUESTS_PER_MINUTE`, `AVAILABILITY_MIN_SCORE`, `AVAILABILITY_MAX_ALT_QUERIES`, `CACHE_CATALOG_TTL`, `CACHE_CATALOG_SWR`.
- 41 new offline tests covering matching, refs, provider normalizers, unsupported filters, availability (alt-title fallback, skipping, ranking, editions) and routes. 558 offline tests in total.

### Fixed
- Multi-source searches no longer trigger Node's `MaxListenersExceededWarning` on the shared abort signal.

## [1.0.0] - 2026-11-16

First Dawghwa release. It is forked from [GooglyBlox/comick-source-api](https://github.com/GooglyBlox/comick-source-api) at `086d006` (tag `upstream-baseline`), with the full upstream history kept.

### Added
- `POST /api/pages`: chapter page URLs through MangaDex's documented @Home API. Capability-gated; other sources return `501`.
- `POST /api/manga` (metadata) and `GET /api/sources/{id}`.
- `GET /api` service index.
- Multi-source search with an explicit `sources` list, `stream:false` aggregate mode, and an `errorCode` per source line.
- Chapter list pagination and ordering (`offset`, `limit`, `order`).
- `GET /api/health?source=id`, health summary counts, and the `unavailable` list.
- Source `status` (active/unstable/shutdown/disabled), `capabilities`, `priority` and circuit state in `/api/sources`, with filters.
- Core runtime: shared HTTP client (timeouts, jittered retries, `Retry-After`, ETag/Last-Modified revalidation, in-flight dedup, size limits, anti-bot detection), per-source rate limiter, circuit breaker, operation deadlines and cancellation, tiered cache (memory LRU + optional Upstash-compatible Redis) with stale-while-revalidate and request coalescing.
- Configuration through environment variables (`.env.example`).
- 517 offline tests: core utilities, every adapter's contract, MangaDex fixtures, API routes, SSRF/proxy security. Live tests are opt-in.
- CI workflow (manifest check, lint, typecheck, test, build), Dockerfile, `vercel.json`, and docs (API, sources, status, architecture, audit, benchmarks, deployment).
- `npm run health:report` (in-process source probe) and `npm run docs:sources`.

### Changed
- Rebranded to Dawghwa API. The upstream MIT license and copyright are kept, and NOTICE adds attribution.
- All adapters use the shared HTTP client (81 raw `fetch` call sites migrated).
- MangaDex chapter feed and Mangaball chapter pages fetch pages 2..N in parallel.
- Errors use one format, `{ error, code, requestId, details? }`, with specific status codes.
- "All" search skips shut-down sources and uses bounded concurrency with a 12 s per-source and 25 s overall timeout (previously all 96 sources at once with a 20 s timer that did not cancel requests).
- Anti-bot detection no longer flags pages that just load assets from Cloudflare's CDN.
- The health workflow runs weekly and in-process, without calling the upstream hosted API.

### Fixed
- SSRF in `/api/chapters` (substring domain matching) and `/api/proxy/html` (unanchored regex, redirects followed).
- Swallowed adapter errors returned as empty results.
- Leaked requests after search timeouts.
- `writers'-scans` is reachable via the `writers-scans` alias, and the domain manifest handles names with apostrophes.

### Security
- Private, loopback, link-local and reserved destinations are blocked on every outbound request and redirect hop.
- Request validation, body size limits, per-client rate limits, security headers, and a sandbox CSP for proxied HTML.
- Internal error details are hidden by default.

## Upstream

For history before the fork, see the upstream repository and this repository's git log up to the `upstream-baseline` tag.
