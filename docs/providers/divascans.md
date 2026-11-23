# DivaScans (candidate)

Site: divascans.org; operator self-named "DivaScans", legal contact on the divascans.org mail domain; jurisdiction not stated

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | pass — site and self-named operator identified |
| 2 Terms | FAIL — terms forbid automated tools that download or scrape content; the content-takedown page states it doesn't follow DMCA |
| 3 robots.txt | partial — public title paths allowed, `/api/` and `/_next/` disallowed; Content-Signal `search=yes, ai-input=yes, ai-train=no`; header comments say chapter text is not licensed for training; 583 Disallow lines in total |
| 4 Access | pass (4 × 200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a — no adapter code written (RELAY's job) |
| 7 Quality | not run (blocked at gate 2) |
| 8 Reliability | not run (blocked at gate 2) |

**Verdict: disabled (gate 2 fail)**

## Terms summary (own words)

- `/terms`: accounts, coins for premium chapters (non-refundable), and a content section saying everything on the site is copyright-protected. Users may not copy, distribute or modify content without permission, or **use automated tools to download or scrape content**.
- `/dmca` ("Content Takedown Policy"): says the site is outside US jurisdiction, isn't bound by the DMCA, and will normally remove content only on a court order from its own (unnamed) jurisdiction or at its discretion.
- Why FAIL: an explicit ban on automated download/scraping, plus a stated refusal to honour DMCA notices. That's a legal risk for anything Dawghwa builds on top.


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://divascans.org/robots.txt | 200 | 2026-11-22T15:42:58Z | a5e90c0e1de10ab4-IAD | page served |
| https://divascans.org/ | 200 | 2026-11-22T15:42:59Z | a5e90c17fc9f05f9-IAD | page served |
| https://divascans.org/terms | 200 | 2026-11-22T15:43:02Z | a5e90c25fbaddb3c-IAD | page served |
| https://divascans.org/dmca | 200 | 2026-11-22T15:43:04Z | a5e90c32abe0dc30-IAD | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt: Content-Signal `search=yes, ai-input=yes, ai-train=no`; `Disallow: /api/` and account paths. Terms still forbid using automated tools to download or scrape content and copying or distributing content without permission.
- Gate verdict: **FAIL (gate 1 terms, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (terms forbid automated download)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://divascans.org/robots.txt | 200 | 2026-11-23T15:44:27Z | a5f14b9ced551697-IAD | page served |
| https://divascans.org/terms | 200 | 2026-11-23T15:44:30Z | a5f14bad3fdae07f-EWR | page served |
