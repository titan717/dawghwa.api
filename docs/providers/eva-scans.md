# Eva Scans (candidate)

Site: evascans.net (operator not named on the site)

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — site found; operator unnamed; no endpoints chosen |
| 2 Terms | FAIL — terms are unclear: the Eva Scans terms and DMCA pages name a different site ("VioletScans") throughout, never name an operator, and grant no right to reuse content |
| 3 robots.txt | pass — `User-agent: *` `Allow: /`; Content-Signal `search=yes,ai-train=no,use=reference`; AI/training crawlers disallowed |
| 4 Access | pass (all 4 requests 200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a — no adapter code written (RELAY's job) |
| 7 Quality | not run (blocked at gate 2) |
| 8 Reliability | not run (blocked at gate 2) |

**Verdict: disabled (gate 2 fail)**

## Terms summary (own words)

- `/terms-and-conditions/`: a short generic page. It says using the site means accepting its rules, that third-party works belong to their owners and the site doesn't claim them, and it forbids interfering with the site, unauthorized access, and automated activity that harms availability (search-engine indexing is said to be fine). Every reference names "VioletScans", not Eva Scans. No operator, jurisdiction or contact address is given.
- `/dmca/`: says works are shown as "previews", asks rights holders to send notices with the usual identifying details, and says material may be removed. Also names "VioletScans"; no contact address on the page.
- Why FAIL: the terms don't identify who is agreeing with whom (wrong site name, no operator), and the site disclaims ownership of the works, so nothing grants Dawghwa any right to re-serve them. Unclear = FAIL.
- Search confirms the site exists ([evascans.net](https://evascans.net/)); its homepage says the comics are previews and to buy the original.


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://evascans.net/robots.txt | 200 | 2026-11-22T15:42:58Z | a5e90c0e3c640569-IAD | page served |
| https://evascans.net/ | 200 | 2026-11-22T15:43:00Z | a5e90c1d1bf29a8e-IAD | page served |
| https://evascans.net/dmca/ | 200 | 2026-11-22T15:43:03Z | a5e90c32081120d7-IAD | page served |
| https://evascans.net/terms-and-conditions/ | 200 | 2026-11-22T15:43:06Z | a5e90c3fbb3b5aec-IAD | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt unchanged (`Allow: /`, Content-Signal `search=yes,ai-train=no,use=reference`). The terms page still names a different site throughout and names no operator; it only bans automation that harms availability. No right to re-serve content is granted.
- Gate verdict: **FAIL (gate 1 terms unclear, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (unclear = false)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://evascans.net/robots.txt | 200 | 2026-11-23T15:44:34Z | a5f14bc70b48b0d5-ATL | page served |
| https://evascans.net/terms-and-conditions/ | 200 | 2026-11-23T15:44:37Z | a5f14bdb796e06e6-ATL | page served |
