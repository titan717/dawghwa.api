# EZManga (candidate)

Site: ezmanga.org (search also shows ezmanhwa.com with the same title; relationship unverified, not contacted)

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — site found via search; operator unknown |
| 2 Terms | unverified — not reached (stopped at gate 4) |
| 3 robots.txt | unverified — robots.txt itself returned 403 |
| 4 Access | FAIL — Cloudflare "Sorry, you have been blocked" (403) on the first request, robots.txt |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a — no adapter code written (RELAY's job) |
| 7 Quality | not run (blocked at gate 4) |
| 8 Reliability | not run (blocked at gate 4) |

**Verdict: blocked (gate 4)**

## Notes

- Search found [ezmanga.org](https://ezmanga.org/) and [ezmanhwa.com](https://ezmanhwa.com/), both titled "EzManga – Read Manhwa, Manga & Manhua Online".
- The first request (robots.txt) got a Cloudflare block page. Per the rules I stopped: no retry, no mirror domain (ezmanhwa.com is an alternate route and was deliberately not tried), no cache/archive, no browser.


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://ezmanga.org/robots.txt | 403 | 2026-11-22T15:42:58Z | a5e90c0e3f8f0143-IAD | status 403 → STOP |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt now loads (200) with the identifying bot UA, where last cycle's browser-UA request got a 403. It reads `User-agent: *` `Allow: /` with account paths disallowed. Terms were not located or read this cycle, so gate 1 stays unverified.
- Gate verdict: **FAIL (gate 1 terms unverified; gate 4 not re-demonstrated beyond robots.txt)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (unknown terms)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://ezmanga.org/robots.txt | 200 | 2026-11-23T15:44:42Z | a5f14bf77d5c38ab-IAD | page served |
