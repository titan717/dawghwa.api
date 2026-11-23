# Provider gates

Internal only. Never ship provider names to users. The deny-list for leak tests is [_names.json](_names.json). Keep it in sync with `src/lib/providers/manifest.generated.ts` in the API repo.

## Cycle 0 re-check (2026-11-23, SCOUT)

Gate numbers in this section follow MASTER_PROMPT section 11: 1 terms · 2 robots · 3 rights · 4 access without circumvention · 5 rate · 6 quality (12 titles) · 7 reliability · 8 hidden-source · 9 offline. The 2026-11-22 tables further down use the older numbering.

Method: light check only. One GET per robots.txt, plus the terms page where one was known. 28 requests in total across 19 hosts, at least 2.5 s apart per host. User agent `DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)`, no Referer or Origin, redirects not followed, stop on 401/403/429/challenge. MangaDex and the two open-licence candidates were also read through public docs and a fetch service. No title or chapter pages were fetched.

**Header rule (JUDGE, 2026-11-23):** the API sends a Chrome browser UA by default (`src/lib/core/config.ts`), a provider Referer, and a forged Origin for one provider (`src/lib/services/page-image.ts`). Access that depends on those headers does not count for gate 4. Gate runs must use the identifying bot UA and no Referer/Origin spoofing. MangaDex's own rules also require an unspoofed UA.

**Attribution conflict (for the owner):** if a provider's terms require attribution or forbid hiding the source, they conflict with Dawghwa's locked hidden-source rule, and the verdict is FAIL. This applies to MangaDex, Say Hello to Black Jack and Pepper&Carrot, the only sources found that grant explicit permission. Only the owner can change that rule.

| Provider / candidate | Gate 1 terms | Gate 2 robots (2026-11-23) | Gate 4 access (bot UA) | Verdict | Downloadable |
|---|---|---|---|---|---|
| [mangadex](mangadex.md) | FAIL: API policy requires credit to MangaDex and scanlation groups, and no ads; ToS bans bots and offline readers on the Site | main site disallows `/api`, `/terms`; api host not fetched | pass (no challenge today) | **FAIL (attribution conflict)** | false |
| [Say Hello to Black Jack](say-hello-to-black-jack.md) (author-licensed, self-hosted) | FAIL: free reuse, but the title, author and site name must be shown | n/a | n/a | **FAIL (attribution conflict)** | true if ever enabled |
| [Pepper&Carrot](pepper-and-carrot.md) (CC BY 4.0) | FAIL: credit and licence link required; not manga | n/a | n/a | **FAIL (attribution conflict)** | true if ever enabled |
| [mangakatana](mangakatana.md) | FAIL: no terms | pass | pass | FAIL | false |
| [manhuaplus](manhuaplus.md) | FAIL: personal non-commercial only; bans robots and offline readers | pass | pass | FAIL | false |
| [asurascan](asurascan.md) | FAIL: bans scraping, bots | `/api/` disallowed (not used) | pass | FAIL | false |
| [webtoon](webtoon.md) | FAIL: bans crawling/scraping; offline only inside the official app | FAIL `/*/search` | pass | FAIL | false |
| [weebcentral](weebcentral.md) | unverified | `Crawl-delay: 10` | robots 200; homepage 403 on 2026-11-22 | FAIL | false |
| [flamecomics](flamecomics.md) | unverified | FAIL `/api/` used by the adapter | robots 200 | FAIL | false |
| [comix (comix.to)](comix-to.md) | unverified | unreadable | **403**, stopped | blocked | false |
| [comix.ws](comix-ws.md) | unreadable (403 on 2026-11-22) | allow, ai-train=no | robots 200 | blocked | false |
| [Lux Manga](lux-manga.md) | FAIL: no terms | pass | pass | FAIL | false |
| [Eva Scans](eva-scans.md) | FAIL: terms name another site, no operator | pass | pass | FAIL | false |
| [Violet Scans](violet-scans.md) | FAIL: bans crawling/scraping | pass | pass | FAIL | false |
| [EZManga](ezmanga.md) | unverified | pass (now readable) | robots 200 (403 on 2026-11-22 with a browser UA) | FAIL | false |
| [RinkoComics](rinkocomics.md) | FAIL: bans bots, saving pages | pass | pass | FAIL | false |
| [MagusManga](magusmanga.md) | unverified | `/api/*` disallowed | robots 200; homepage challenge on 2026-11-22 | FAIL | false |
| [Thunderscans](thunderscans.md) | FAIL: bans crawling/scraping | pass | pass | FAIL | false |
| [Nyx Scans](nyx-scans.md) | FAIL: no terms | `/api/*` disallowed | pass | FAIL | false |
| [DivaScans](divascans.md) | FAIL: bans automated download/scrape | `/api/` disallowed | pass | FAIL | false |

**Result: 0 of 20 pass. Every `PROVIDER_*` flag stays OFF, and every `downloadable` is false.** Gates 6 to 8 were not run, because each candidate fails gate 1 first. The cycle 1 gate runner (WEAVER) is still to run once something can pass gate 1.

Licensed platforms: Webtoon (above) forbids third-party automated use. Other official platforms (for example MANGA Plus, K MANGA, Tapas) were not checked this cycle. I know of no public API from them that licenses re-serving content in a third-party app, but that is unverified. The realistic legal routes are an owner-negotiated licence, or self-hosting author-licensed works with credit, which needs an owner exception to the hidden-source rule.

---

## Earlier record: provider gates, cycle 1 (2026-11-22)

Author: SCOUT (provider researcher). Checks ran 2026-11-22 15:42–15:44 UTC from the agent sandbox. Each host got a few plain GETs (robots.txt, the homepage to find legal links, and terms/DMCA), at least 1.5 s apart, with one fixed browser user agent. A host was stopped at its first 403 or challenge, with no retries, mirrors, caches, proxies or browser. No title or chapter pages were fetched in this cycle. No adapter code or config was touched.

Gates: 1 site/operator/endpoints · 2 terms (ToS, DMCA, API terms; unreadable or unclear = FAIL) · 3 robots.txt and content signals · 4 access (any 403/challenge = STOP) · 5 politeness · 6 original code · 7 quality (12+ titles) · 8 reliability · 9 evidence (in each file).

Verdict key: **enabled** = all gates pass · **disabled** = reachable, but a terms/robots/quality gate fails · **blocked** = stopped at gate 4. For existing providers the verdict is a gate result and a recommendation only. Production config is unchanged.

## Candidates

| Candidate | Site / operator | 1 | 2 Terms | 3 robots | 4 Access | 5 | 6 | 7 | 8 | Verdict | Date |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [Lux Manga](lux-manga.md) | luxmanga.net / unnamed (luxmanga.org: no DNS) | partial | FAIL (no terms page) | pass, ai-train=no | pass | pass | n/a | not run | not run | disabled | 2026-11-22 |
| [Eva Scans](eva-scans.md) | evascans.net / unnamed | partial | FAIL (terms name another site, no operator) | pass, ai-train=no | pass | pass | n/a | not run | not run | disabled | 2026-11-22 |
| [Violet Scans](violet-scans.md) | violetmanga.com / "Website Operator" | partial | FAIL (bans crawling/scraping) | pass | pass | pass | n/a | not run | not run | disabled | 2026-11-22 |
| [EZManga](ezmanga.md) | ezmanga.org / unknown | partial | unverified | unverified | FAIL (403 on robots.txt) | pass | n/a | not run | not run | blocked | 2026-11-22 |
| [RinkoComics](rinkocomics.md) | rinkocomics.com / "Rinko Comics" | pass | FAIL (bans bots/scrapers, redistribution) | pass | pass | pass | n/a | not run | not run | disabled | 2026-11-22 |
| [MagusManga](magusmanga.md) | magustoon.org / unknown | partial | unverified | read, `/api/*` disallowed | FAIL (challenge on homepage) | pass | n/a | not run | not run | blocked | 2026-11-22 |
| [Thunderscans](thunderscans.md) | en-thunderscans.com / unnamed | partial | FAIL (terms for another domain; bans scraping) | pass | pass | pass | n/a | not run | not run | disabled | 2026-11-22 |
| [Nyx Scans](nyx-scans.md) | nyxscans.com / unnamed | partial | FAIL (no ToS; DMCA page silent on access/reuse) | pass, `/api/*` disallowed | pass | pass | n/a | not run | not run | disabled | 2026-11-22 |
| [DivaScans](divascans.md) | divascans.org / "DivaScans" | pass | FAIL (bans automated download/scrape; rejects DMCA) | partial, ai-train=no | pass | pass | n/a | not run | not run | disabled | 2026-11-22 |
| [comix.ws](comix-ws.md) | comix.ws / unknown | partial | FAIL (unreadable, 403) | per PR #32: allow, ai-train=no | FAIL (challenge, 1 request) | pass | n/a | not run | not run | blocked | 2026-11-22 |

**Result: 0 of 10 candidates enabled.** Seven were reachable, and all seven failed on terms. Three were blocked.

## Existing API providers (terms and robots re-check only)

Gate 7 is reused from the live-API quality table in [PR #32](https://github.com/titan717/dawghwa/pull/32) (`docs/research/providers-2026-11.md`, 12 titles × 8 providers, 2026-11-22 ~14:24 UTC). It was not re-run.

| Provider | Site / operator | 1 | 2 Terms | 3 robots | 4 Access | 7 (PR #32) | Gate result | Date |
|---|---|---|---|---|---|---|---|---|
| [mangadex](mangadex.md) | mangadex.org, api.mangadex.org / MangaDex | pass | unverified (challenged) | unverified | FAIL from sandbox (own JS challenge) | matches 12/12, readable 5/12 | blocked (sandbox) | 2026-11-22 |
| [mangakatana](mangakatana.md) | mangakatana.com / unknown | partial | FAIL (no terms page) | pass | pass | strong (manga) | disabled | 2026-11-22 |
| [manhuaplus](manhuaplus.md) | manhuaplus.top / unnamed | partial | FAIL (personal non-commercial only) | pass | pass | strong (manhua/manhwa) | disabled | 2026-11-22 |
| [asurascan](asurascan.md) | asurascans.com / "Asura Scans" | pass | FAIL (bans scraping without permission) | pass | pass | strong (manhwa) | disabled | 2026-11-22 |
| [webtoon](webtoon.md) | webtoons.com / WEBTOON Entertainment | pass | FAIL (bans unauthorized crawling/scraping) | FAIL (`/*/search` disallowed) | pass | limited (originals) | disabled | 2026-11-22 |
| [weebcentral](weebcentral.md) | weebcentral.com / unknown | partial | unverified | Crawl-delay 10 | FAIL (challenge) | blocked every title | blocked | 2026-11-22 |
| [flamecomics](flamecomics.md) | flamecomics.xyz / unverified | partial | unverified | FAIL (`/api/` disallowed, used by adapter) | FAIL (challenge) | blocked every title | blocked | 2026-11-22 |
| [comix](comix-to.md) | comix.to / unknown | partial | unverified | unverified | FAIL (403 on robots.txt) | blocked every title | blocked | 2026-11-22 |

**Result: 0 of 8 existing providers pass every gate.** This is for the lead to decide on, and nothing was changed here. MangaDex is the only one where the failure might be environmental: the terms couldn't be read from the sandbox. A human should read its ToS and API acceptable-use policy in a normal browser.

## Other notes

- Unused adapter files already exist in `dawghwa.api/src/lib/scrapers/` for several candidates (divascans, evascans, magustoon, nyxscans, rinkocomics, thunderscans, violetscans). This cycle found none that pass the gates. `violetscans.ts` points at violetscans.org, which differs from the violetmanga.com site found by search. The `api.*` hosts used by the nyxscans and magustoon adapters were not checked.
- luxmanga.net, mangakatana.com and thunderscans.com appear in a Webtoon DMCA subpoena domain list reported by [TorrentFreak](https://torrentfreak.com/webtoon-targets-170-pirate-domains-through-dmca-subpoena-240821/).
- Internal UX notes: [ux-notes.md](ux-notes.md).
