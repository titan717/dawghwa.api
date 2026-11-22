# HTTP facts to record per endpoint

Record facts, not content. Field names and types are fine. Don't copy full bodies, images, or markup.

## Request
- Method, URL template (use `{id}`, `{page}`), required query parameters, and accepted values. Note whether they came from the existing adapter or from public docs.
- Time (UTC), attempt number, and latency.

## Response
- Status code and redirects (record `Location`, don't follow cross-host redirects automatically).
- `Content-Type`, body size, and encoding.
- Shape: the top-level keys and nested field types, written as a TypeScript-like outline. Mark fields that are sometimes missing or null as optional. Note the date format, the ID format, and whether URLs are relative or absolute.

## Caching
- `Cache-Control` (`max-age`, `s-maxage`, `no-store`, `private`, `stale-while-revalidate`), `Expires`, `Age`, `Vary`.
- Validators: `ETag` (strong or weak) and `Last-Modified`. When present, test one conditional request (`If-None-Match` / `If-Modified-Since`) and record whether you get a 304. That costs one extra request, so count it against the budget.
- Recommend a TTL for our cache that is no longer than what the site allows.

## Rate limits
- `Retry-After` (seconds or HTTP date) on 429 or 503.
- IETF `RateLimit` / `RateLimit-Policy` (draft-ietf-httpapi-ratelimit-headers) and the legacy `X-RateLimit-Limit/Remaining/Reset`.
- Documented limits from API terms.
- If no limits are documented, write "none documented". Never probe for limits by speeding up.
- Record what you used: by default 1 req/s per host, backoff of 1, 2, 4, 8, 16 s (max 5 retries), Retry-After honoured, stop if it's over 60 s.

## Pagination
- Style: page/limit, offset/limit, cursor, or `Link: rel="next"`.
- Page size limits, how the total is reported, and what a past-the-end page returns.
- Study page 1 and at most one more page. Don't walk the whole catalogue.

## Errors
- The body shape for 4xx and 5xx, and what "not found" looks like (404 or 200 with an empty result).
- Anti-bot behaviour (`server: cloudflare`, `cf-mitigated`, challenge HTML). This is a stop condition.
