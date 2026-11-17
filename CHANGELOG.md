# Changelog

All notable changes to Dawghwa API. The project follows [Semantic Versioning](https://semver.org/). Breaking changes to request/response shapes only happen in a major version.


## Unreleased

- `POST /api/browse` and `GET /api/browse`: filtered and ordered catalogue listing (tags, kinds, status, demographic, year, recency) through MangaDex's documented API, with rating and follows from its statistics API. Unknown tags are rejected rather than ignored.
- Optional `metadata` on search, browse and manga results (genres, themes, formats, authors, artists, status, year, demographic, kind, long strip, rating, follows, description, alternative titles). Sanitised by `normalizeMetadata`.
- `POST /api/manga` for MangaDex now also returns `coverImage` and `metadata`.
- New `browse` capability in `/api/sources`.

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
