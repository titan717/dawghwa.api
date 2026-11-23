# Thunderscans (candidate)

Site: en-thunderscans.com ("Thunderscans EN"); operator unnamed

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — site found; operator unnamed |
| 2 Terms | FAIL — the terms page governs a different domain (ozulscans.com) and prohibits spidering, crawling and scraping |
| 3 robots.txt | pass — only `/wp-admin/` disallowed; no content signals |
| 4 Access | pass (4 × 200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a — no adapter code written (RELAY's job) |
| 7 Quality | not run (blocked at gate 2) |
| 8 Reliability | not run (blocked at gate 2) |

**Verdict: disabled (gate 2 fail)**

## Terms summary (own words)

- `/terms-and-conditions/`: the same stock template as Violet Scans, but it says it covers the ozulscans.com website, not en-thunderscans.com. It bans spidering, crawling and scraping, and keeps all IP with the "Website Operator".
- `/dmca-statement/`: speaks as "Ozulscansen". It says it doesn't support piracy, describes the material as crowdsourced fragments it can't fully control, and gives a standard DMCA notice process.
- Why FAIL: terms are for another domain (unclear who the operator is), and crawling/scraping are explicitly prohibited either way.
- Context: `thunderscans.com` (a different domain) appears in Webtoon's DMCA subpoena list reported by [TorrentFreak](https://torrentfreak.com/webtoon-targets-170-pirate-domains-through-dmca-subpoena-240821/).


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://en-thunderscans.com/robots.txt | 200 | 2026-11-22T15:42:58Z | a5e90c0e2b557d04-IAD | page served |
| https://en-thunderscans.com/ | 200 | 2026-11-22T15:42:59Z | a5e90c185bc9204b-IAD | page served |
| https://en-thunderscans.com/dmca-statement/ | 200 | 2026-11-22T15:43:01Z | a5e90c25c960e621-IAD | page served |
| https://en-thunderscans.com/terms-and-conditions/ | 200 | 2026-11-22T15:43:03Z | a5e90c31ee4ee646-IAD | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt unchanged (only `/wp-admin/`). Terms still forbid spidering, crawling and scraping.
- Gate verdict: **FAIL (gate 1 terms, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://en-thunderscans.com/robots.txt | 200 | 2026-11-23T15:45:27Z | a5f14d12999b98ac-ATL | page served |
| https://en-thunderscans.com/terms-and-conditions/ | 200 | 2026-11-23T15:45:29Z | a5f14d23cbfe6c4c-DFW | page served |
