# MagusManga (candidate)

Site: magustoon.org (search result titled "Magus Manga"; MagusManga is also listed as a translation group on comick.dev). Operator unknown.

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — site found; operator unknown |
| 2 Terms | unverified — not reached (stopped at gate 4) |
| 3 robots.txt | robots.txt read: `User-agent: *` `Allow: /`, `Disallow: /api/*` (also blocks ia_archiver and archive.org_bot); no content signals |
| 4 Access | FAIL — homepage returned 403 Cloudflare "Just a moment…" challenge |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a — no adapter code written (RELAY's job) |
| 7 Quality | not run (blocked at gate 4) |
| 8 Reliability | not run (blocked at gate 4) |

**Verdict: blocked (gate 4)**

## Notes

- robots.txt was served (200); the next request (homepage, to locate the terms link) got a JS challenge, so I stopped. Terms and DMCA pages were never located or read.
- The existing unused adapter `dawghwa.api/src/lib/scrapers/magustoon.ts` references `api.magustoon.org`; that host was not checked. On the main host `/api/*` is disallowed.
- Search shows some chapters are marked "Paid".


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://magustoon.org/robots.txt | 200 | 2026-11-22T15:42:58Z | a5e90c0e3bc6d647-IAD | page served |
| https://magustoon.org/ | 403 | 2026-11-22T15:43:00Z | a5e90c1aab4fd62d-IAD | status 403 → STOP |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt loads (200) with the bot UA: `User-agent: *` `Allow: /`, `Disallow: /api/*`, archive bots disallowed. The adapter uses the separate `api.magustoon.org` host (robots not checked). The homepage challenge from last cycle was not re-tested and terms remain unread.
- Gate verdict: **FAIL (gate 1 terms unverified; gate 4 challenge last cycle)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (unknown terms)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://magustoon.org/robots.txt | 200 | 2026-11-23T15:44:53Z | a5f14c3e5cde3aaa-DFW | page served |
