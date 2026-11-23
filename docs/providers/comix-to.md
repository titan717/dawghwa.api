# Comix (existing API provider `comix` = comix.to)

Site: comix.to (`src/lib/scrapers/comix.ts` baseUrl `https://comix.to`, apiBase `https://comix.to/api/v2`); operator unknown. Not comix.ws.

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — endpoints known; operator unknown |
| 2 Terms | unverified — not reached (stopped at gate 4) |
| 3 robots.txt | unverified — robots.txt itself returned 403 |
| 4 Access | FAIL — Cloudflare "Sorry, you have been blocked" (403) on robots.txt |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a |
| 7 Quality | from PR #32 (not re-run): UPSTREAM_BLOCKED (anti-bot) on every title |
| 8 Reliability | not run |

**Verdict: blocked (gate 4) — no config change made**

## Notes

- I stopped on the first request, and terms weren't attempted. This matches the live API result in PR #32 (source marked `unstable`).
- Gate 7 source: [PR #32](https://github.com/titan717/dawghwa/pull/32), `docs/research/providers-2026-11.md` (branch `agent/p4-provider-research`, run 2026-11-22 ~14:24–14:29 UTC).


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://comix.to/robots.txt | 403 | 2026-11-22T15:43:03Z | a5e90c2c7eb624ad-IAD | status 403 → STOP |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt returned a Cloudflare 403 "Attention Required" page on the first request, with the identifying bot UA. Stopped; nothing else sent.
- Gate verdict: **blocked (gate 4, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (unknown terms)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://comix.to/robots.txt | 403 | 2026-11-23T15:44:22Z | a5f14b7fa80cfc15-ATL | 403 Cloudflare block page, STOP |
