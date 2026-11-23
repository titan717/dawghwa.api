# Changelog

All notable changes to Dawghwa API. The project follows [Semantic Versioning](https://semver.org/). Breaking changes to request/response shapes only happen in a major version.

## [Unreleased]

## [1.3.0] - 2026-11-23

Baseline release for the current production build. It covers everything merged since `v1.1.0`, including the work that was declared as 1.2.0 in `package.json` ([#5](https://github.com/titan717/dawghwa.api/pull/5)) but never tagged. All changes are additive: every v1 request and response shape still works.

### Added
- API v2: `GET /api/v2/chapter` (canonical chapter endpoint with silent version fallback, a per-source circuit breaker and "Try another version" via `alt`) and `GET /api/v2/img/<token>` (opaque, signed image proxy). Both are inert until the owner sets `IMAGE_PROXY` and `IMAGE_PROXY_SECRET`: the chapter endpoint answers 503 and the image route 404. Contract in `docs/API_V2.md` ([#11](https://github.com/titan717/dawghwa.api/pull/11)).
- Source-neutral catalogue model: normalization, conservative cross-catalogue deduplication, a shared genre vocabulary, optional `externalIds` on list items and `capabilities.signals` for sorts backed by real signals ([#10](https://github.com/titan717/dawghwa.api/pull/10)).
- Unified reading engine: canonical title identity, a deterministic merged chapter list across sources and native page delivery ([#4](https://github.com/titan717/dawghwa.api/pull/4), [#5](https://github.com/titan717/dawghwa.api/pull/5)).
- Chapter page extraction for more sources, with recorded-response tests and a live verifier ([#6](https://github.com/titan717/dawghwa.api/pull/6)).
- Catalogue filters: multi-value status and format, demographic, and AND/OR tag modes ([#7](https://github.com/titan717/dawghwa.api/pull/7)).
- Catalogue browse endpoint (`GET` and `POST /api/browse`) with optional metadata on search, browse and title results ([#1](https://github.com/titan717/dawghwa.api/pull/1)); synopsis, tag names and demographic on list items ([#2](https://github.com/titan717/dawghwa.api/pull/2)).
- `GET /api/image`: CDN-cacheable relay for cover images from an allow-listed host ([#3](https://github.com/titan717/dawghwa.api/pull/3)).
- Release note categories (`.github/release.yml`) and the release process in `docs/RELEASE.md` ([#12](https://github.com/titan717/dawghwa.api/pull/12)).

### Fixed
- Production metadata failures: the guarded HTTP agent now uses undici's own fetch ([#8](https://github.com/titan717/dawghwa.api/pull/8)).
- Background cache refreshes stay alive on Vercel, and suspended health runs are not cached ([#9](https://github.com/titan717/dawghwa.api/pull/9)).

### Security
- Page extraction fails closed: HTTPS only, a connect-time DNS guard, and robots.txt and CDN blocks are honoured ([#6](https://github.com/titan717/dawghwa.api/pull/6)).
- Image relay responses are streamed within size limits and their DNS destinations are validated ([#4](https://github.com/titan717/dawghwa.api/pull/4)).
- v2 image tokens are signed and expire; tampered or expired tokens are refused, and v2 never returns upstream image URLs ([#11](https://github.com/titan717/dawghwa.api/pull/11)).

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

[Unreleased]: https://github.com/titan717/dawghwa.api/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/titan717/dawghwa.api/compare/v1.1.0...v1.3.0
[1.1.0]: https://github.com/titan717/dawghwa.api/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/titan717/dawghwa.api/releases/tag/v1.0.0
