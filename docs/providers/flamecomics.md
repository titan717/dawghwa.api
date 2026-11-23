# Flame Comics (existing API provider `flamecomics`)

Site: flamecomics.xyz (+ cdn.flamecomics.xyz); operator unknown (an App Store listing names an individual developer, unverified as the site operator). Endpoints in use: `flamecomics.xyz/api/series`, `/series/<id>`, CDN images.

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — endpoints known; operator unverified |
| 2 Terms | unverified — terms not located (stopped at gate 4) |
| 3 robots.txt | FAIL — robots.txt disallows `/api/` for all agents, and the adapter's search uses `/api/series`; several AI crawlers fully disallowed |
| 4 Access | FAIL — homepage 403 Cloudflare "Just a moment…" challenge |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a |
| 7 Quality | from PR #32 (not re-run): blocked on every title |
| 8 Reliability | not run |

**Verdict: blocked (gates 3 and 4) — no config change made**

## Notes

- Gate 7 source: [PR #32](https://github.com/titan717/dawghwa/pull/32), `docs/research/providers-2026-11.md` (branch `agent/p4-provider-research`, run 2026-11-22 ~14:24–14:29 UTC).


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://flamecomics.xyz/robots.txt | 200 | 2026-11-22T15:43:02Z | a5e90c272d15b1f6-IAD | page served |
| https://flamecomics.xyz/ | 403 | 2026-11-22T15:43:04Z | a5e90c327ac7d65d-IAD | status 403 → STOP |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt still has `User-agent: *` `Disallow: /api/`, and the adapter uses `/api/series`. AI crawlers are disallowed site-wide. Terms not located.
- Gate verdict: **FAIL (gate 2 robots, unchanged; terms unverified)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (unknown terms)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://flamecomics.xyz/robots.txt | 200 | 2026-11-23T15:44:45Z | a5f14c0f3bfb0f5f-EWR | page served |
