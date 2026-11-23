# Asura Scans (existing API provider `asurascan`)

Site: asurascans.com ("Asura Scans", contact by email). Endpoints in use: `/browse?search=…`, `/comics/<slug>`, chapter pages.

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | pass — site, self-named operator, endpoints identified |
| 2 Terms | FAIL — terms forbid scraping or copying content without permission and the use of bots/scripts/automation to abuse the service |
| 3 robots.txt | pass for used paths — `Allow: /`; disallows `/api/`, login/register/settings/bookmarks/history/notifications; no content signals |
| 4 Access | pass (3 × 200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a |
| 7 Quality | from PR #32 (not re-run): strong manhwa coverage, e.g. Solo Leveling 201, ORV 312, Greatest Estate Developer 223 |
| 8 Reliability | not run this cycle |

**Verdict: disabled by gates (gate 2 fail) — recommendation only, no config change made**

## Terms summary (own words)

- `/terms-of-service` (updated April 2026): lawful use only. No unauthorized access, no disruption, no malware, **no scraping or copying of content without permission**, and no bots or automation used to manipulate or abuse the service. The site says it doesn't own the original works. Some features are premium.
- `/dmca`: a standard DMCA notice and counter-notice process with a repeat-infringer policy and an email agent.
- Why FAIL: Dawghwa's adapter reads pages automatically without permission.
- Gate 7 source: [PR #32](https://github.com/titan717/dawghwa/pull/32), `docs/research/providers-2026-11.md` (branch `agent/p4-provider-research`, run 2026-11-22 ~14:24–14:29 UTC).


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://asurascans.com/robots.txt | 200 | 2026-11-22T15:43:00Z | a5e90c1978fce06b-IAD | page served |
| https://asurascans.com/terms-of-service | 200 | 2026-11-22T15:43:01Z | a5e90c239e7e4967-IAD | page served |
| https://asurascans.com/dmca | 200 | 2026-11-22T15:43:03Z | a5e90c2ee9c5aa23-IAD | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt now reads `User-agent: *` `Allow: /` with `Disallow: /api/` plus account paths. The adapter's paths (`/comics/`, `/chapter/`, image host) are not disallowed. Terms still forbid scraping or copying content without permission and using bots or automation.
- Gate verdict: **FAIL (gate 1 terms, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (terms give no offline/download right)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://asurascans.com/robots.txt | 200 | 2026-11-23T15:44:15Z | a5f14b50d89133a6-EWR | page served |
| https://asurascans.com/terms-of-service | 200 | 2026-11-23T15:44:17Z | a5f14b614bd29da2-ATL | page served |
