# RELAY design note, cycle 1: v2 chapter + image proxy hardening, `/api/updates`

Owner: RELAY (API core). Repo: `titan717/dawghwa.api`. Base: `agent/cycle-1` (= main `0dd3ca0`).
Branch: `agent/c1-relay-v2-core`. Reviewer: JUDGE. Consumers: QUILL (reader, "Try another version"), PULSE (offline, inbox).
Internal document (may name code paths; it does not name providers).

## 1. What Spec H already has (inspected on `0dd3ca0`)

| Spec H item | Status | Where |
|---|---|---|
| Canonical title ids (`dwg:md|al|mu:<id>`) and canonical chapter numbers | Done | `src/lib/v2/chapter.ts` `parseCanonicalTitle`, `canonicalNumber` |
| Source picked by stable rank, automatic fallback | Done | `orderVersions`, `attemptPlan` (official never silently becomes scanlation) |
| Circuit breaker per source (3 fails, 60 s half-open, doubling) | Done | `src/lib/v2/breaker.ts` |
| 1 req/s per upstream host, bounded wait | Done | `src/lib/v2/pacer.ts` |
| Signed, opaque, short-lived image tokens (AES-256-GCM + HMAC, HKDF keys, expiry buckets) | Done, stronger than the sketch | `src/lib/v2/token.ts` |
| Inert unless `IMAGE_PROXY` + `IMAGE_PROXY_SECRET` (>= 32 chars) | Done (503 before any upstream call) | `src/lib/v2/config.ts` |
| Proxy: allow-list re-check, public-destination check, manual redirects within allow-list (max 3), https only, size cap, magic-byte sniff (no SVG/HTML), no upstream headers forwarded | Done | `src/lib/v2/image.ts`, `services/page-image.ts`, `core/net-guard.ts` (connect-time pinned lookup), `scrapers/pages/policy.ts` |
| Per-client image rate limit (600/min, per instance) | Done | `takeImageRate` |
| Leak guard (registry terms) + leak tests | Done, registry-based only | `src/lib/v2/leak.ts`, `src/tests/v2/routes-leak.test.ts` |
| Baseline: `npx vitest run src/tests/v2` | 4 files, 52 tests passed | local run 2026-11-23 |

## 2. Gaps (to build in cycle 1)

1. **Header spoofing (JUDGE, required).** `pageImageHeaders()` sends a provider `Referer`, a forged `Origin` for one provider, and the default UA is a desktop Chrome string (`core/config.ts`). v2 image delivery uses it. Fix: v2 gets its own `v2ImageHeaders()` = `{ Accept, "User-Agent": "DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)" }`, nothing else. A refusal (401/403/429/challenge/non-image) is a failure: 502, no retry, and it now feeds the v2 breaker for that source (today image delivery does not). v1 `/api/image` is not touched here (live app depends on it; flagged to /root for cycle 2). Unit test asserts the exact outgoing header set.
2. **Provider gates not enforced in v2.** v2 would use every operational registry provider once the proxy is on. Fix: v2 only considers a provider whose flag `PROVIDER_<ID>` (id upper-cased, non-alphanumerics to `_`) is truthy. Read-only; no env var is created or changed. With 0 providers passing the gates, v2 stays 503 even with the proxy on. Same check in chapter resolution and image delivery (a token for a provider whose flag was turned off stops working).
3. **`downloadable` missing.** Add `downloadable: boolean` = `true` only when the serving provider's `offlineAllowed === true` (new optional `offlineAllowed?: boolean` on `ProviderDescriptor`, default absent = false; WEAVER's `ProviderAdapter.offlineAllowed` maps onto it). Anything unclear is `false`.
4. **Response shape vs Spec G/P.** v2 has no app consumer yet (checked: the app calls only v1), so I align it with Spec G now:
   ```
   200 { "title": "dwg:md:…", "chapter": { "number": "10.5", "display": "Chapter 10.5", "title"?: "…", "volume"?: "2", "language": "en" },
         "pages": [{ "i": 0, "url": "https://<api>/api/v2/img/<token>", "w"?: 800, "h"?: 1200 }],
         "downloadable": false, "expiresAt": 1767225600000, "version": "<opaque>" }
   ```
   Removed: `version.index/count/next/edition` and `totalPages` (they tell the user how many versions exist, Spec P forbids that).
5. **"Try another version" contract (to agree with QUILL).**
   `GET /api/v2/chapter?title=&n=&lang=&alt=1&v=<version from the previous 200>`
   `version` is an encrypted, MAC'd, 30-min token (same scheme as image tokens, separate HKDF key `ver`) holding `{title, n, lang, exclude:[internal version ids served or already tried], exp}`. The server skips every excluded version and serves the next ranked one (any edition, the user asked). The new 200 carries a new `version` that excludes one more. No more versions: `404 {"error":"UNAVAILABLE"}` (UI: "This chapter isn't available right now."). `alt=1` without `v` skips the default (first-ranked) version. A `v` that is tampered, expired, or for another title/chapter/lang is ignored (treated as no `v`), never an error that reveals anything. `alt` other than `1`, or `v` without `alt=1`: 400. Cap 16 excluded ids.
6. **Errors not generic enough.** Today `{"error":"Chapter unavailable"}`/`"Image unavailable"`/`"Too many requests"`, and the `route()` limiter's 429 returns the shared error body with a code. New: every v2 and `/api/updates` error body is exactly `{"error":"UNAVAILABLE"}` (400, 404, 410, 429, 502, 503, 504), statuses unchanged, `Retry-After` kept on 429/503. v1 (used by the live app): only remove leaky fields SHIELD found (`/api/proxy/html` 403 `details.allowedDomains`; `/api/image` messages that name a provider become generic), codes and statuses unchanged.
7. **Rate limits (SHIELD #7).** `/api/v2/chapter` moves off the 120/min `standard` class to its own per-client limiter: 30/min plus a daily cap of 600 chapter resolutions per client (best-effort, per instance; Spec G daily cap). Images stay 600/min. `/api/updates`: 6/min. All in-memory per instance (documented; a shared store is cycle 2 and needs an owner-provided store).
8. **CORS on the image proxy (share-card canvas).** Middleware defaults to `ACAO: *` from `CORS_ORIGINS` (env, not changed). For `/api/v2/img/*` the route sets an explicit allow-list in code: `https://dawghwa.vercel.app`, `https://localhost`, `capacitor://localhost` (Capacitor), plus `http://localhost:4173` and `:5173` only when `NODE_ENV !== "production"`; `Vary: Origin`; no credentials. Unknown origin: no ACAO header (the `<img>` still loads; only canvas export is blocked). Middleware is changed to skip its own CORS headers for `/api/v2/img/*` so the two never conflict. Risk: Vercel PR previews of the app cannot export share cards from proxied covers (acceptable; noted for PULSE).
9. **Vercel response limit.** Function responses are capped at 4.5 MB unless streamed ([Vercel Functions limits](https://vercel.com/docs/functions/limitations), accessed 2026-11-23). v2 buffers the image (to sniff bytes) with a 20 MB cap, so a 5-20 MB page would fail as a platform 500. Fix: v2 cap = 4 MiB; over the cap is `502 UNAVAILABLE` and a breaker failure. Streaming with sniff-first is a cycle 2 follow-up if real pages exceed it. Will reconcile with WARDEN's `docs/research/vercel-limits.md` when it lands.
10. **`/api/updates` (PULSE, Spec M).** New:
    ```
    GET /api/updates?ids=<canonicalId,…≤100>&since=<epoch ms>
    200 { "items": [{ "id": "upd:<canonicalId>:<number>", "kind": "update", "titleId": "<canonicalId>", "chapter": 57, "at": 1767225600000 }],
          "checkedAt": 1767225601234, "partial": false }
    400/429/502 { "error": "UNAVAILABLE" }
    ```
    Data: cached title metadata only (`getTitleMetadata`, latest chapter + updated time), never a chapter-source fan-out. Concurrency 4, 8 s total budget; titles not answered in budget are left out and `partial: true` (client keeps "last checked" honest). Invalid ids are skipped silently. Duplicate ids de-duplicated. `Cache-Control: private, max-age=300`. 6/min per client. One item per title at most (the latest chapter if `at > since`).
11. **Leak test with SCOUT's deny-list.** Tests load `docs/providers/_names.json` (`{ "names": [...] }`, internal, never imported by route code) and union it with the registry terms. They run every representative request (chapter success, fallback, `alt=1` with and without `v`, every error status, proxy off/misconfigured, rate limited, images 200/404/410/429/502, CORS preflight, `/api/updates` success/partial/errors) and assert 0 matches in bodies and every header. If the file is missing the test fails with a pointer to SCOUT (not skipped).
12. **Test files (mocked upstreams only, no real provider calls).**
    - `src/tests/v2/ssrf.test.ts`: private IPv4/IPv6/mapped, DNS names resolving private (rebinding via mocked resolver), `localhost`/`.internal`, redirects to private / off-allow-list / http, non-https token URL, non-allow-listed host, credentials and odd ports in URL.
    - `src/tests/v2/token.test.ts` (extend): bit flips in body and MAC, swapped MAC, wrong secret, expired at bucket edge, oversized, wrong version byte; same for `version` tokens incl. cross-title reuse.
    - `src/tests/v2/rate-limit.test.ts`: chapter 30/min and daily cap, image 600/min, updates 6/min, per-client isolation, `Retry-After`, generic body.
    - `src/tests/v2/headers.test.ts`: exact outgoing image request headers (no Referer/Origin, bot UA); 403 upstream -> 502 + breaker failure, exactly one upstream call.
    - `src/tests/v2/cors.test.ts`: allowed/unknown origin, `Vary: Origin`, preflight.
    - `src/tests/v2/downloadable.test.ts`, `src/tests/v2/alt.test.ts`, `src/tests/api/updates.test.ts`, `src/tests/v2/gates.test.ts` (flag off -> provider never tried).

## 3. Acceptance criteria

- `npm test` all pass (new tests included); `tsc --noEmit` 0; `next lint` 0 new warnings; `next build` ok (via heavy.sh).
- No env var created/changed. `IMAGE_PROXY`/`IMAGE_PROXY_SECRET` names kept. Production behaviour without the env: unchanged (v2 503 `{"error":"UNAVAILABLE"}`).
- Leak test passes with `_names.json` + registry terms over every path above.
- v2 image requests carry no Referer/Origin and an identifying UA (tested).
- No new dependency.

## 4. Files

`src/lib/v2/{chapter,image,config,leak,token}.ts`, new `src/lib/v2/{gates,limits,cors,version,updates}.ts`, `src/app/api/v2/chapter/route.ts`, `src/app/api/v2/img/[token]/route.ts`, new `src/app/api/updates/route.ts`, `src/middleware.ts` (skip for `/api/v2/img/*`), `src/lib/providers/provider.ts` (optional `offlineAllowed`), `src/app/api/proxy/html/route.ts` and `src/app/api/image/route.ts` (generic messages only), tests above, `docs/API_V2.md`, `docs/loop/relay-c1.md`.

## 5. Flags and env

Reads (never sets): `IMAGE_PROXY`, `IMAGE_PROXY_SECRET`, `IMAGE_PROXY_TTL_SECONDS`, `IMAGE_PROXY_RATE_PER_MINUTE`, `PROVIDER_<ID>`. Owner action to go live: set the two proxy vars AND a provider must pass all 9 gates (SCOUT) before its `PROVIDER_<ID>` is set.

## 6. Risks

- In-memory limits/breakers are per instance (Vercel): best-effort only. Documented; shared store needs owner keys.
- Response shape change: safe now (no v2 consumer), QUILL/PULSE must code against section 2.4/2.5/2.10.
- 4 MiB image cap could reject very tall strip pages; measured follow-up.
- `/api/updates` depends on metadata freshness, not on chapter sources: "new chapter" may lag a source by the metadata DB's delay. Honest and cheap; acceptable for cycle 1.
- Client IP through the app's rewrite (SHIELD 3.1): if Vercel forwards the edge IP, all users share one bucket. I will log only `clientId` cardinality (hashed) in a test deploy check; not changing `TRUST_PROXY`.
