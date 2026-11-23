# WEBTOON (existing API provider `webtoon`)

Site: www.webtoons.com / m.webtoons.com, operated by WEBTOON Entertainment (licensed publisher). Endpoints in use: `www.webtoons.com/en/search?keyword=…`, `m.webtoons.com/api/v1/webtoon/<titleNo>/episodes`.

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | pass — operator and endpoints identified |
| 2 Terms | FAIL — Terms of Use forbid unauthorized crawling, scraping or harvesting, and limit content to personal non-commercial viewing |
| 3 robots.txt | FAIL for search — robots disallows `/*/search`, which the adapter's search URL matches; also disallows `/*/*/*/list?title_no=*&page=1`. `m.webtoons.com` robots not checked |
| 4 Access | pass (2 × 200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a |
| 7 Quality | from PR #32 (not re-run): Tower of God 652, Greatest Estate Developer 7 (free episodes), Dandadan 1 (probably a different work) |
| 8 Reliability | not run this cycle |

**Verdict: disabled by gates (gates 2 and 3 fail) — recommendation only, no config change made**

## Terms summary (own words)

- `/en/terms`: WEBTOON grants a limited, revocable, personal, non-commercial licence to view content. Users may not copy, redistribute, display or sublicense it, or bypass protections. Users may not engage in unauthorized crawling, scraping or harvesting, or use other unauthorized automated means to compile information from the services.
- Why FAIL: the content is legitimately licensed, but the terms rule out third-party automated access, and the search path is disallowed in robots.txt. The legal route would be linking out or a partnership, not an adapter.
- Gate 7 source: [PR #32](https://github.com/titan717/dawghwa/pull/32), `docs/research/providers-2026-11.md` (branch `agent/p4-provider-research`, run 2026-11-22 ~14:24–14:29 UTC).


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://www.webtoons.com/robots.txt | 200 | 2026-11-22T15:43:00Z | - | page served |
| https://www.webtoons.com/en/terms | 200 | 2026-11-22T15:43:02Z | - | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt still disallows `/*/search` for `*`. Terms still ban unauthorized crawling, scraping and automated harvesting. Downloads are allowed only to the user's own device inside the official app, for up to 30 days; that right is personal and does not extend to a third-party app. The API also sends a forged `Origin` header for this provider (see below), which the gate rules forbid.
- Gate verdict: **FAIL (gates 1 and 2, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (offline right exists only inside the official app)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://www.webtoons.com/robots.txt | 200 | 2026-11-23T15:45:40Z | - | page served |
| https://www.webtoons.com/en/terms | 200 | 2026-11-23T15:45:43Z | - | page served |
