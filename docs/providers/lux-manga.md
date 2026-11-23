# Lux Manga (candidate)

Site: luxmanga.net (operator unverified; the @LuxManga X profile links luxmanga.net). luxmanga.org also appears in search results titled "Lux" but did not resolve in DNS today.

Checked 2026-11-22 by SCOUT (cycle 1) from the agent sandbox. Plain HTTPS GETs, one fixed ordinary browser user agent for every host (never changed), no cookies, no login, ≥1.5 s between requests to the same host, stop at the first 403/challenge. Raw responses were inspected locally and are not committed; nothing from the site (text, markup, styles, images) is reproduced here beyond short quoted robots.txt directives.

## Gates

| Gate | Result |
|---|---|
| 1 Site/operator/endpoints | partial — site found; operator not identified; no endpoints chosen |
| 2 Terms | FAIL — homepage links no terms, DMCA or legal page; none found, so terms are unreadable |
| 3 robots.txt | pass — `User-agent: *` `Allow: /`; Content-Signal `search=yes,ai-train=no,use=reference`; ~30 AI/training crawlers disallowed |
| 4 Access | pass for robots + homepage (200, no challenge) |
| 5 Politeness | pass (handful of requests, ≥1.5 s apart) |
| 6 Original code | n/a — no adapter code written (RELAY's job) |
| 7 Quality | not run (blocked at gate 2) |
| 8 Reliability | not run (blocked at gate 2) |

**Verdict: disabled (gate 2 fail)**

## Notes

- Existence: search shows the [@LuxManga X profile](https://x.com/LuxManga) pointing to luxmanga.net, and [MangaUpdates](https://www.mangaupdates.com/series/lnxas9h/my-husband-is-definitely-a-paladin) lists a group "LuxManga (2026)". Search also indexed [luxmanga.org](https://luxmanga.org/), but `luxmanga.org` returned no DNS answer at 15:42 UTC, so it was not contacted further. Whether the two domains share an operator is unverified.
- luxmanga.net appears in the domain list of Webtoon's 2024 DMCA subpoena reported by [TorrentFreak](https://torrentfreak.com/webtoon-targets-170-pirate-domains-through-dmca-subpoena-240821/).
- Terms: the homepage has no link to terms, DMCA, privacy or contact pages. I did not guess URLs. Terms unreadable = gate 2 FAIL.
- ai-train=no: Dawghwa must never use this content for AI training (it doesn't).


## Evidence (gate 9)

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://luxmanga.org/robots.txt | ERR | 2026-11-22T15:42:58Z | - | DNS did not resolve (no HTTP response) |
| https://luxmanga.net/robots.txt | 200 | 2026-11-22T15:43:59Z | a5e90d8b6cd9c09f-IAD | page served |
| https://luxmanga.net/ | 200 | 2026-11-22T15:44:01Z | a5e90d970e515263-IAD | page served |


## Re-check 2026-11-23 (cycle 0, SCOUT)

Method: one plain GET per URL below from the agent sandbox, user agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no cookies, no Referer/Origin, redirects not followed, at least 2.5 s between requests to a host, stop at the first 401/403/429 or challenge. Raw responses were inspected locally and not committed.

Gate runs must use the identifying `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)` user agent with no Referer or Origin spoofing. JUDGE found that the API currently sends a Chrome browser UA by default (`src/lib/core/config.ts`, `UPSTREAM_USER_AGENT` fallback), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Any earlier access that relied on those headers, including last cycle's checks, which used a fixed browser UA, does not count for gate 4.

- Findings: robots.txt unchanged (`Allow: /`, Content-Signal `search=yes,ai-train=no,use=reference`). No terms page was found last cycle; not re-searched.
- Gate verdict: **FAIL (gate 1 no terms, unchanged)**. Flag `PROVIDER_*` stays OFF.
- Downloadable (gate 9, `offlineAllowed`): **false (no terms)**.

| URL | HTTP | Time (UTC) | cf-ray | Result |
|---|---|---|---|---|
| https://luxmanga.net/robots.txt | 200 | 2026-11-23T15:44:49Z | a5f14c272c70f045-ATL | page served |
