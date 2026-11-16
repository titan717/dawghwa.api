# Audit of the upstream code

Scope: [GooglyBlox/comick-source-api](https://github.com/GooglyBlox/comick-source-api) at commit `086d006` (tag `upstream-baseline`). This covers every adapter (96 files, 19,811 lines), every route, the shared base classes, dependencies, tests, config, and the GitHub workflow. Live behaviour was measured on 2026-11-16 by running the unmodified upstream build locally and probing every source domain from a datacenter network.

Each finding lists how Dawghwa handles it. Code references point at the Dawghwa tree.

## Source availability

Upstream's README listed 63 active, 14 shut down and 13 unstable sources. A direct probe of every base URL (2026-11-16) gave:

- **57** returned HTTP 200.
- **28** returned 403, mostly Cloudflare "Just a moment" challenges.
- **4** domains no longer resolve: kaliscan, mangaloom, mangayy, weebdex.
- **4** returned 502 (firescans, likemanga, mangapark, witchscans), plus rinkocomics 500 and TCB Scans 521.

A search across all sources on the upstream build returned errors for 32 of 96: 76 HTTP 403 log lines, 16 × 502, 16 "fetch failed", 8 timeouts at 20 s and 4 × 404.

**Dawghwa:** the 14 upstream-shutdown sources plus the 4 dead domains are marked `shutdown` (`lib/shutdown-sources.ts`, `lib/providers/status.ts`) and are never called. Requests to them return `SOURCE_UNAVAILABLE` instead of an empty list. Every source shows its status in `/api/sources`, and live results are published in `docs/SOURCE_STATUS.md`. The in-process probe from this sandbox found 58 of 82 operational sources healthy, 22 behind anti-bot challenges, 1 HTTP 403 and 1 timeout.

## Reliability and performance

| # | Finding (upstream) | Impact | Dawghwa |
| --- | --- | --- | --- |
| R1 | 64 adapter/frontpage files had 81 raw `fetch()` calls that bypassed `BaseScraper.fetchWithRetry` | No timeouts, retries or UA handling on most requests | All call sites now use `this.http()`, which goes through the shared client (`lib/core/http.ts`) |
| R2 | `fetchWithRetry` retried **every** failure, including 403 and 404, 3× with 1-3 s linear delays | Blocked sources took seconds to fail and hit the site 4× | Retries only for 408/425/429/5xx/network errors, with full-jitter exponential backoff, `Retry-After`, and a deadline check |
| R3 | "all" search wrapped each source in `Promise.race` with a 20 s timer, but the losing fetch kept running | Leaked sockets/memory; every all-search took ~20 s | Real cancellation via `AbortSignal` through the operation context. Per-source timeout 12 s, overall deadline 25 s |
| R4 | "all" search started all 96 sources at once, including the 14 shut-down ones | Burst of ~100+ concurrent requests per user | Bounded pool (16), shut-down sources skipped, per-provider token bucket and concurrency cap |
| R5 | No caching except a 5 min health cache | Every request hit the source | Tiered cache (memory LRU + optional Redis) with per-type TTL/SWR, singleflight and in-flight HTTP dedup |
| R6 | 10 adapters catch errors and return `[]` (baetoon, luminare, mangaball, mangak, mkissa, reimanga, spiderscans, swarm, webtoonclub, xcomic) | Outages looked like "no results" and were cached as such | `Provider.run` turns an empty result into an error when every upstream request failed (`stats.upstreamSuccesses === 0`) |
| R7 | ~20 adapters fetch pages one after another (for example the MangaDex feed offset loop and Mangaball chapter pages) | Long chapter lists were slow | MangaDex feed and Mangaball pages now fetch pages 2..N in parallel, within the provider rate limit. Other loops depend on the previous page and were left alone |
| R8 | Adapter-level retry loops (mkissa, novelcool, stonescape, MangaDex 429 loop) stacked on base retries | Retry amplification | Base retries set to 0 for `fetchWithRetry`; the shared client owns retries. The adapter loops are kept, but each attempt is bounded by the operation deadline |
| R9 | Fixed `delay()` sleeps (atsumoe, bato, comix, weebdex) ignored cancellation | Requests kept sleeping after the client left | `delay()` is now abortable through the operation signal |
| R10 | `detectCloudflare` matched `/cloudflare/i` anywhere in the HTML | Healthy pages that load `cdnjs.cloudflare.com` were reported as blocked | `lib/core/antibot.ts` matches only real challenge markers (titles, `cf-chl`, `challenge-platform`, `cf-mitigated` header, DDoS-Guard, DataDome, Sucuri) |
| R11 | Health check probed sources with long sequential retries and no global deadline | Cold `/api/health` could exceed function limits | Bounded pool (12), 15 s per source, 55 s overall, whitespace keep-alive streaming, SWR cache |
| R12 | No circuit breaker | Dead sources were retried on every request | Per-source breaker (5 failures, 60 s cooldown that doubles up to 16×, one half-open trial). Health probes act as the trial |
| R13 | Health workflow called the upstream author's hosted API (`comick-source-api.notaspider.dev`) | Runtime dependency on a third party | `scripts/update-readme-health.ts` probes in-process; no hosted API involved |
| R14 | Unbounded in-memory structures in some paths | Memory growth | All caches, queues, DNS cache, conditional cache and rate-limit keys are bounded |

## Security

| # | Finding (upstream) | Severity | Dawghwa |
| --- | --- | --- | --- |
| S1 | `/api/proxy/html` checked the URL with **unanchored** regexes (`/https?:\/\/(www\.)?weebcentral\.com/.test(url)`), so `https://evil.example/?u=https://weebcentral.com` passed | High (open proxy / SSRF) | Exact host allowlist built from the client-only sources' domains; https only; default port; no credentials |
| S2 | The proxy followed redirects automatically | High (redirect to internal hosts) | Manual redirects; every hop is re-validated against the allowlist and the private-network guard |
| S3 | `/api/chapters` picked the adapter with `url.includes(domain)`, so `http://169.254.169.254/?mangadex.org` was fetched server-side | High (SSRF to cloud metadata) | `resolveSourceUrl` parses the URL and requires an exact or subdomain host match. The shared client additionally refuses private, loopback, link-local, CGNAT and reserved addresses after DNS resolution, on every request |
| S4 | The proxy returned third-party HTML from the API origin with no CSP | Medium (stored XSS on the API origin) | `Content-Security-Policy: sandbox; default-src 'none'`, `nosniff`, HTML-only content types, 5 MB cap |
| S5 | The proxy double-decoded `decodeURIComponent` | Low (filter confusion) | Single parse with `URL` |
| S6 | Error responses included raw exception messages | Medium (information disclosure) | Standard error body with `code` and `requestId`. Internal reasons are hidden unless `EXPOSE_ERROR_DETAILS=true` |
| S7 | No input validation and no body-size limits | Medium (resource abuse) | zod schemas on every route; 16 KB body limit, checked on `Content-Length` and while streaming |
| S8 | No rate limiting | Medium (amplification: one request fans out to 96 sites) | Per-client token buckets: standard 120/min and an extra "expensive" 12/min bucket for fan-out endpoints |
| S9 | No security headers | Low | `nosniff`, `Referrer-Policy`, `X-Frame-Options`, HSTS, COOP, strict CSP for API JSON and the docs page, `poweredByHeader: false` |
| S10 | Responses had no size limit | Medium (memory exhaustion) | 8 MB streaming cap per upstream response |

No secrets, credentials or deployment-specific private configuration were found in the upstream repository. Nothing like that was copied, and `.env*` files are git-ignored.

## Tests and tooling (upstream)

- 2 test files. `src/tests/sources/scrapers.test.ts` hits every live site, so it is non-deterministic; it is now opt-in via `npm run test:live`. `cloudflare.test.ts` is kept and still passes against the compatibility wrapper.
- No CI for build, lint or test. Dawghwa adds `.github/workflows/ci.yml`.
- Dependencies: Next 14.2.35, cheerio 1.1.2, React 18. Dawghwa adds only `zod`. `npm audit` was not used to drive any changes.

## Not changed on purpose

- Adapter parsing logic, apart from the fetch/timeout/retry plumbing above. Rewriting 96 parsers without per-site fixtures would risk silent regressions.
- Madara- and MangaThemesia-style duplication (see `docs/ARCHITECTURE.md`).
- No anti-bot bypassing (no headless browsers, no challenge solving, no cookie replay). A blocked source is reported as blocked.
- Chapter pages are not parsed out of reader HTML for any source. Only MangaDex's documented API is used.
