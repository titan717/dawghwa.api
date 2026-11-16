# Dawghwa API

A self-hostable API that searches manga/manhwa sources, lists chapters, reads source frontpages and reports source health through one consistent JSON interface.

Dawghwa API is a fork of [GooglyBlox/comick-source-api](https://github.com/GooglyBlox/comick-source-api) (MIT). It started from the upstream source code at commit [`086d006`](https://github.com/GooglyBlox/comick-source-api/commit/086d006) (tag `upstream-baseline` in this repository) and keeps all 96 upstream source adapters, their behaviour and the original endpoints, on top of a rebuilt runtime: shared HTTP client, per-source isolation, caching, validation and SSRF protection. Dawghwa does not call the upstream hosted API at runtime; the upstream repository is only a code reference.

> Status: **1.0.0**. 517 offline tests pass, lint/typecheck/build are clean. Source reachability changes constantly: see [docs/SOURCE_STATUS.md](docs/SOURCE_STATUS.md) for the latest probe.

## Contents

- [Quick start](#quick-start)
- [Endpoints](#endpoints)
- [Sources](#sources)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Development](#development)
- [Documentation](#documentation)
- [Attribution and license](#attribution-and-license)

## Quick start

```bash
git clone https://github.com/titan717/dawghwa.api.git
cd dawghwa.api
npm ci
npm run dev            # http://localhost:3000
```

```bash
curl -s localhost:3000/api/sources | jq '.sources[0]'
curl -s -X POST localhost:3000/api/search -H 'content-type: application/json' \
  -d '{"query":"kaguya","source":"mangadex"}' | jq '.results[0]'
```

Production: `npm run build && npm start`, the [Dockerfile](Dockerfile), or Vercel. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Endpoints

All endpoints are under `/api`. Full reference with request/response examples and error codes: [docs/API.md](docs/API.md).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api` | Index: version, endpoints, cache backend |
| GET | `/api/sources` | All sources with status and capabilities (`?verbose=1` adds circuit/metrics) |
| GET | `/api/sources/{id}` | One source |
| POST | `/api/search` | Search one source (JSON) or many/all sources (NDJSON stream, or `stream:false` for one document) |
| POST | `/api/chapters` | Chapter list for a manga URL, with optional `offset`/`limit`/`order` |
| POST | `/api/manga` | Basic metadata (title, id) for a manga URL |
| POST | `/api/pages` | Chapter page image URLs, only where the provider documents an API for it (MangaDex) |
| GET | `/api/health` | Cached health of all sources, or `?source=id` |
| POST | `/api/health` | Force a fresh health check (rate limited) |
| GET | `/api/frontpage` | Sources with frontpage sections |
| POST | `/api/frontpage` | One frontpage section (trending, latest, ...) |
| GET | `/api/proxy/html` | HTML fetch for client-only sources, restricted to an exact host allowlist |

The upstream request bodies and response fields still work. Dawghwa adds fields (`sourceId`, `meta`, `pagination`, `status`, `capabilities`) and never removes existing ones. Errors always look like:

```json
{ "error": "Unknown source \"nope\"", "code": "SOURCE_NOT_FOUND", "requestId": "1b4e..." }
```

## Sources

96 adapters: **69 active, 13 unstable, 14 shut down**. The full directory with base URLs, types, status and capabilities is in [docs/SOURCES.md](docs/SOURCES.md).

- **Active**: maintained adapter; normally works, though anti-bot protection can block it from some networks.
- **Unstable**: known to fail intermittently.
- **Shut down**: site gone or adapter broken. These sources are never called. Requests to them return `SOURCE_UNAVAILABLE` instead of an empty list that looks like a real result.

Latest probe from a datacenter network (2026-11-16, [docs/SOURCE_STATUS.md](docs/SOURCE_STATUS.md)): 58 of 82 operational sources healthy, 22 blocked by anti-bot challenges, 1 HTTP 403, 1 timeout. Dawghwa reports challenges as `UPSTREAM_BLOCKED` and does not try to bypass them.

Chapter page retrieval (`POST /api/pages`) is only implemented for **MangaDex**, through its documented [MangaDex@Home API](https://api.mangadex.org/docs/04-chapter/retrieving-chapter/). No other adapter claims page support. Image bytes are never proxied.

## How it works

```
route (validation, rate limit, error format)
  -> service (cache + stale-while-revalidate + request coalescing)
    -> Provider.run (deadline, cancellation, circuit breaker, metrics)
      -> adapter (unchanged upstream scraping logic, independent per source)
        -> shared HTTP client (SSRF guard, per-source rate limit, retries with
           backoff + jitter, ETag/Last-Modified revalidation, size limit,
           anti-bot detection, in-flight dedup)
```

- **Isolation.** Each adapter runs inside its own `Provider` with a time budget, an AbortSignal that really cancels its requests, a circuit breaker, and its own rate limiter. One broken site cannot stall or crash the others.
- **Multi-source search.** Runs with bounded concurrency (16), a 12 s timeout per source and a 25 s overall deadline. Results stream as each source finishes, so the response time is set by the per-source timeout rather than by the slowest site.
- **Caching.** In-memory LRU, bounded by entry count and bytes, with optional Redis (Upstash REST protocol). Each data type has its own TTL and SWR window. Errors and suspicious empty results are not cached.
- **Honest failures.** If an adapter returns `[]` after every one of its upstream requests failed, Dawghwa reports the error instead of "no results".

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The issues found in the upstream code and how each was handled: [docs/AUDIT.md](docs/AUDIT.md).

## Configuration

Every setting is optional and controlled by environment variables. See [.env.example](.env.example) for all of them with defaults. The most important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `REDIS_REST_URL`, `REDIS_REST_TOKEN` | unset | Shared Redis cache (Upstash-compatible REST) |
| `DISABLED_SOURCES` | empty | Comma-separated source ids to turn off |
| `SOURCE_PRIORITY` | empty | Source ids searched / matched first |
| `SEARCH_SOURCE_TIMEOUT_MS` | 12000 | Per-source budget in multi-source search |
| `RATE_LIMIT_PER_MINUTE` | 120 | Per-client API limit |
| `RATE_LIMIT_EXPENSIVE_PER_MINUTE` | 12 | Multi-source search and forced health checks |
| `TRUST_PROXY` | true | Use `X-Forwarded-For` for client identity (only behind a proxy that sets it) |
| `CORS_ORIGINS` | `*` | Allowed browser origins |

## Development

```bash
npm run lint          # ESLint (next lint)
npm run typecheck     # tsc --noEmit
npm test              # offline unit, adapter-contract, API and security tests
npm run test:live     # opt-in: hits the real sites (LIVE_TESTS=1)
npm run build         # production build
npm run health:report # probe every source in-process -> docs/SOURCE_STATUS.md
npm run docs:sources  # regenerate docs/SOURCES.md
npm run manifest      # regenerate the adapter domain allowlist after adding an adapter
npm run bench -- http://localhost:3000 label   # HTTP benchmark of a running server
```

CI (`.github/workflows/ci.yml`) runs the manifest check, lint, typecheck, tests and the build on every push and pull request. A weekly workflow regenerates the source status report. Adding an adapter: [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [docs/API.md](docs/API.md): endpoint reference, examples, error codes, caching, rate limits
- [docs/SOURCES.md](docs/SOURCES.md): supported source directory
- [docs/SOURCE_STATUS.md](docs/SOURCE_STATUS.md): latest live probe
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): internals
- [docs/AUDIT.md](docs/AUDIT.md): audit of the upstream code
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md): before/after measurements
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Vercel, Docker, self-hosting, environment
- [CHANGELOG.md](CHANGELOG.md): versions

## Attribution and license

Dawghwa API is derived from [comick-source-api](https://github.com/GooglyBlox/comick-source-api) by GooglyBlox, used under the MIT License. The original copyright notice is kept in [LICENSE](LICENSE), and [NOTICE](NOTICE) describes what was derived. The complete upstream history is kept in this repository's git history, and the unmodified import is tagged `upstream-baseline`.

Dawghwa is an index/metadata API. It does not host content, respects provider protections (it never solves or bypasses anti-bot challenges), and only returns page URLs where the provider offers a documented API. Please follow each source's terms of service.

MIT License, see [LICENSE](LICENSE).
