# Nyx Scans (candidate)

Site: nyxscans.com; operator not named

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — site found; operator unnamed |
| 2 Terms | FAIL — no terms-of-service page is linked; the DMCA page mixes general rules with a takedown process and says nothing about automated access or reuse rights |
| 3 robots.txt | pass for public pages — `Allow: /`, `Disallow: /api/*` (also blocks ia_archiver/archive.org_bot); no content signals |
| 4 Access | pass (3 × 200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a — no adapter code written (RELAY's job) |
| 7 Quality | not run (blocked at gate 2) |
| 8 Reliability | not run (blocked at gate 2) |

**Verdict: disabled (gate 2 fail)**

## Terms summary (own words)

- The homepage footer links only Privacy Policy and DMCA. There's no standalone terms page.
- `/dmca-policy`: opens with a minimum age (13), community rules (no spam, explicit content, unmarked spoilers, hate or misinformation), then a standard DMCA notice checklist sent to a designated agent. It doesn't cover automated access or reuse, and it doesn't say who owns the content.
- Why FAIL: no readable terms covering access or reuse = unclear.
- The existing unused adapter `nyxscans.ts` references `api.nyxscans.com` (not checked). On the main host `/api/*` is disallowed.


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://nyxscans.com/robots.txt | 200 | 2026-11-22T15:42:58Z | a5e90c0e3a1968e7-IAD | page served |
| https://nyxscans.com/ | 200 | 2026-11-22T15:42:59Z | a5e90c185b92beb1-IAD | page served |
| https://nyxscans.com/dmca-policy | 200 | 2026-11-22T15:43:01Z | a5e90c250d2ecbf8-IAD | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt unchanged: `Allow: /`, `Disallow: /api/*`, archive bots disallowed. The adapter uses `api.nyxscans.com` (robots not checked). Still no terms of service.
- Gate verdict: **FAIL (gate 1 no terms, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (no terms)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://nyxscans.com/robots.txt | 200 | 2026-11-23T15:45:16Z | a5f14ccd380755cb-DFW | page served |
