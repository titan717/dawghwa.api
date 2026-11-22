# API v2: canonical chapter endpoint and opaque image proxy

Internal document (may name providers). Additive: every v1 route (`/api/pages`, `/api/image`,
`/api/titles/:ref/chapters/all`, ...) is unchanged.

Code: `src/lib/v2/*`, routes `src/app/api/v2/chapter/route.ts` and `src/app/api/v2/img/[token]/route.ts`.
Tests: `src/tests/v2/*`.

## GET /api/v2/chapter

```
GET /api/v2/chapter?title=<canonicalTitleId>&n=<chapterNumber>[&lang=<lang>][&alt=<k>]
```

| Param | Required | Meaning |
|---|---|---|
| `title` | yes | Canonical title id from `chapters/all` (`dwg:md:<uuid>`, `dwg:al:<id>`, `dwg:mu:<id>`). Metadata refs (`al:105398`, `anilist:105398`, `md:<uuid>`) are also accepted. Max 96 chars. |
| `n` | yes | Chapter number, normalised like the merge (`10.0` = `10`, `010.5` = `10.5`, `1.10` != `1.1`). Regular chapters only; a numbered special ("Bonus Episode 2") never answers `n=2`. |
| `lang` | no (`en`) | Translation language (`[a-z]{2,3}(-[a-z0-9]{2,8})?`). Never changed by fallback. |
| `alt` | no | Version index (0..99) to start from: "Try another version". Pass the previous response's `version.next`. |

### 200 response

```jsonc
{
  "title": "dwg:md:814b682b-…",            // canonical title id
  "chapter": {
    "number": "10.5",
    "display": "Chapter 10.5",
    "title": "Rain",                         // omitted when absent or when it names a provider
    "volume": "2",                           // omitted when unknown
    "language": "en"
  },
  "pages": [{ "index": 0, "url": "https://<api>/api/v2/img/<token>", "width": 800, "height": 1200 }],
  "totalPages": 24,
  "version": { "index": 0, "count": 3, "next": 1, "edition": "official" }, // edition: official | scanlation | unknown
  "pagesExpireAt": "2026-11-22T13:40:00.000Z"                              // only when page URLs are tokens
}
```

Headers: `Cache-Control: no-store`, `X-Request-Id`, `X-Dawghwa-Version`, `RateLimit-*` (standard bucket,
`RATE_LIMIT_PER_MINUTE`). No provider names, ids, slugs, domains or hosts appear in body or headers (tested against every
term in the registry, see "Leak guard").

### Errors

Every error body is exactly `{"error":"Chapter unavailable"}`:

| Status | When |
|---|---|
| 400 | Missing/invalid `title`, `n`, `lang` or `alt` |
| 404 | Title unknown, no regular chapter with that number in that language, or `alt` >= version count |
| 502 | Every version that was allowed to be tried failed (or metadata/aggregation failed) |
| 503 | Versions exist but every source is currently circuit-open |
| 429 | Client rate limit (body is the shared limiter's generic "Too many requests" message, `Retry-After` set) |

### How a version is chosen

1. Title metadata (`getTitleMetadata`, enriched) and the merged chapter list (`aggregateChapters`, the same cached and
   coalesced aggregation as `chapters/all`).
2. Row: `number == n`, `language == lang`, `kind == regular` (if several rows conflict, the one with most variants).
3. Versions (row variants) in a **stable** order, independent of breaker state so `alt` indices keep their meaning:
   verified cross-source matches (`exact`, `number`) before `source-only`, `official` before `scanlation` before
   `unknown`, provider priority (registry), then `variantId`.
4. Attempt plan:
   * no `alt`: version 0, then only safe silent replacements: same known language, same edition, and a verified match
     (a `source-only` version is allowed only from version 0's own source, e.g. another group's upload). An official
     edition never silently becomes a scanlation (UNIFIED_CHAPTERS.md fallback rules).
   * `alt=k`: versions k, k+1, ... of any edition (the user asked for another version). `next` wraps to 0.
   * v2 breaker: open sources are dropped; half-open sources go last and get one trial.
5. For each version: page manifest via the existing `getChapterPages` (same cache key as `/api/pages`), paced at
   1 request/s per chapter host when not a fresh cache hit. A version fails on any error, an empty manifest, or any page
   outside the provider's declared image hosts (fail closed). 403 / challenge / blocked are failures: the next version is
   tried; there is never a retry through another route, proxy, header change or automation.

## Image URLs and GET /api/v2/img/<token>

Controlled by env (read per request):

| Env var | Default | Meaning |
|---|---|---|
| `IMAGE_PROXY` | unset (off) | `1`/`true` turns on opaque page URLs |
| `IMAGE_PROXY_SECRET` | unset | Required when `IMAGE_PROXY` is on; at least 32 characters, same value on every instance |
| `IMAGE_PROXY_TTL_SECONDS` | 1800 | Token lifetime (300..86400), rounded up to a 10-minute bucket |
| `IMAGE_PROXY_RATE_PER_MINUTE` | 600 | Per-client image requests per minute |

* **Off** (default) or **on without a usable secret**: page URLs are the existing relay URLs exactly as `POST /api/pages`
  issues them (`/api/image?url=<upstream>&source=<id>`), i.e. current behaviour. These URLs do contain the upstream URL
  and source id; the v2 "no provider details" guarantee for page URLs holds only with the proxy on. Everything else in
  the v2 body is provider-free either way (tested). A per-instance random secret is deliberately not used as a
  fallback: on serverless, tokens would fail whenever a request lands on another instance.
* **On**: `pages[].url = <origin>/api/v2/img/<token>`.

Token: `b64url(0x01 | iv[12] | AES-256-GCM(payload) | tag[16]) "." b64url(HMAC-SHA256(macKey, part1))`, payload
`{"s":sourceId,"u":upstreamUrl,"e":expiryUnixSeconds}`. Keys are derived from the secret with HKDF (separate encryption,
MAC and IV keys). The HMAC is verified first in constant time, then the payload is decrypted, then expiry is checked. The
upstream URL and source id are encrypted, not just encoded. Encryption is deterministic within an expiry bucket (IV =
HMAC of the plaintext) so the same page gets the same URL and browser/CDN caches hit.

`GET /api/v2/img/<token>`:

| Status | Body | When |
|---|---|---|
| 200 | image bytes | `Content-Type` is the sniffed type (JPEG/PNG/GIF/WebP/AVIF), `Cache-Control: public, max-age=<seconds until expiry>, immutable`, `X-Content-Type-Options: nosniff`, CORP cross-origin. No upstream header is forwarded. |
| 404 | `{"error":"Image unavailable"}` | Proxy off, malformed/tampered token, unknown source, URL no longer on the source's image allowlist, private destination |
| 410 | `{"error":"Image unavailable"}` | Token expired: re-request the chapter |
| 429 | `{"error":"Too many requests"}` | Per-client limit (`Retry-After`) |
| 502 / 504 | `{"error":"Image unavailable"}` | Upstream non-200 (incl. 403/challenge, no retry), not an image, over the size limit, timeout (12 s) |
| 503 | `{"error":"Image unavailable"}` | Host pacing budget exceeded (`Retry-After: 2`) |

Limits: re-validation with `allowPageImage` (per-provider host/path allowlist), public-destination check, redirects only
within the provider's page hosts (max 3, existing `fetchPageImage`), 20 MB cap checked against `Content-Length` and while
streaming, bytes must sniff as an allowed raster type (SVG and HTML refused even if labelled `image/*`). MangaDex@Home
outcomes are reported as in `/api/image`.

## Circuit breaker (v2)

`src/lib/v2/breaker.ts` wraps the core `CircuitBreaker` per source: opens after **3** consecutive failures, half-open
after **60 s** (doubling per failed trial, max 16x), one trial in half-open, success closes. It counts whole chapter
resolutions: source failures (`isSourceFailure`: HTTP errors incl. 403, blocked/challenge, timeouts, network) and
`PAGE_FORMAT_CHANGED` count; chapter-specific outcomes (locked, empty) are neutral. Image delivery does not feed it yet
(follow-up). Separate from each Provider's own operation breaker, which still applies inside `getChapterPages`.

## Politeness

* `src/lib/v2/pacer.ts`: at most 1 request/second per upstream host from v2 paths (chapter manifests keyed by the chapter
  URL host, images by the image host). A request whose slot is further away than the budget (5 s manifests, 20 s images)
  is refused, not queued indefinitely, and counts as a failure for that attempt.
* The title aggregation reused from `chapters/all` keeps its existing per-provider limiters (`RATE_LIMITS`), which are
  not changed here.
* No retries on 403/challenge anywhere in v2.

## Serverless limits (in-memory state)

Breakers, host pacing and the image rate limiter are per instance. On Vercel each warm instance has its own state, so the
effective upstream ceiling is 1 req/s per host per concurrently warm instance, a client can exceed the image limit by
spreading over instances, and a cold instance starts with all breakers closed. A shared store (the Redis REST cache
already supported by `src/lib/core/cache`) would be needed for global limits.

1 req/s per image host means a 40-page chapter from one CDN takes about 40 s to fully relay through one instance; the
reader should load pages progressively (it already lazy-loads). Edge caching of the stable token URLs offsets repeat
reads.

## Leak guard

`src/lib/v2/leak.ts` builds the term list from the registry (every provider id, name, alias, domain, base-URL host and
declared page-image host, plus code-validated image hosts and the metadata database ids). Chapter titles containing a
term are dropped. `src/tests/v2/routes-leak.test.ts` asserts that success, fallback, `alt`, every error status, rate
limited, and image responses (bodies and headers) contain none of the terms.
