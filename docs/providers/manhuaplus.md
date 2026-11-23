# ManhuaPlus (existing API provider `manhuaplus`)

Site: manhuaplus.top; operator not named (terms use "we" throughout). Endpoints in use: `/search?keyword=…`, title and chapter pages.

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — site/endpoints known; operator unnamed |
| 2 Terms | FAIL — terms allow personal, non-commercial use only and forbid copying or distributing any part without written authorization |
| 3 robots.txt | pass — `Allow: /`, `Disallow: /panel/`; no content signals |
| 4 Access | pass (3 × 200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a |
| 7 Quality | from PR #32 (not re-run): good manhua/manhwa coverage, e.g. Martial Peak 3363, ORV 313, ToDaG 521 chapters |
| 8 Reliability | not run this cycle |

**Verdict: disabled by gates (gate 2 fail) — recommendation only, no config change made**

## Terms summary (own words)

- `/terms` ("Terms of usage"): use is limited to personal, non-commercial purposes. Nothing may be copied or distributed without prior written authorization. Automated systems may not send more requests than a human could with a browser. Search engines may index but not cache or archive. Content is claimed as owned or licensed by the site and may only be used for personal information.
- Why FAIL: Dawghwa re-presenting chapters to its own users is not personal use and has no written authorization.
- Gate 7 source: [PR #32](https://github.com/titan717/dawghwa/pull/32), `docs/research/providers-2026-11.md` (branch `agent/p4-provider-research`, run 2026-11-22 ~14:24–14:29 UTC).


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://manhuaplus.top/robots.txt | 200 | 2026-11-22T15:42:58Z | a5e90c107f92f83a-IAD | page served |
| https://manhuaplus.top/ | 200 | 2026-11-22T15:43:00Z | a5e90c1dd903c97e-IAD | page served |
| https://manhuaplus.top/terms | 200 | 2026-11-22T15:43:03Z | a5e90c2d2f9fd6ed-IAD | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt unchanged (`Allow: /`, `Disallow: /panel/`). Terms still limit use to personal non-commercial use and forbid automated systems, explicitly naming robots, spiders and offline readers, that send more requests than a human reasonably could.
- Gate verdict: **FAIL (gate 1 terms, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (terms name offline readers as prohibited)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://manhuaplus.top/robots.txt | 200 | 2026-11-23T15:45:09Z | a5f14ca08efa602b-ATL | page served |
| https://manhuaplus.top/terms | 200 | 2026-11-23T15:45:12Z | a5f14cb36fb26de9-DFW | page served |
