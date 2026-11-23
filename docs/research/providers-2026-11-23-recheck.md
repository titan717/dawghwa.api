# Provider re-check and licensed-source search (2026-11-23, cycle 0)

Author: SCOUT. Internal only. Per-provider records are in [../providers/README.md](../providers/README.md).

## Findings

1. **0 of 20 providers and candidates pass. Every flag stays OFF and every `downloadable` is false.** Terms have not changed since 2026-11-22. The ten sites with readable terms ban scraping or automation, or limit use to personal non-commercial reading. The rest have no terms or unreadable ones.
2. **The sources with explicit permission all require attribution.** Under the locked hidden-source rule that means FAIL:
   - MangaDex API: credit MangaDex and the scanlation groups, honor group takedowns, no ads or paid services. About 5 req/s per IP, at-home 40/min, real UA required, own image proxy required. No offline right. https://api.mangadex.org/docs/ and https://api.mangadex.org/docs/2-limitations/ (2026-11-23)
   - Say Hello to Black Jack (Shuho Sato): free reuse, commercial included, redistribution of the official data allowed (offline OK), but the title, author and site name must be shown. https://note.com/shuho_sato/n/na1c3e7c1aa60?hl=en (2026-11-23)
   - Pepper&Carrot: CC BY 4.0, credit and licence link required. Western webcomic. https://www.peppercarrot.com/en/about/index.html (2026-11-23)
   **Owner decision:** only an exception to the hidden-source rule (a visible credit line) could let any of these pass gate 1.
3. **Header practices.** With the identifying `DawghwaBot/1.0` UA, robots.txt loaded on ezmanga, flamecomics, weebcentral and magustoon, which had 403s or challenges with last cycle's browser UA. comix.to still returns 403. JUDGE's finding stands: the API's Chrome UA, provider Referer and forged Webtoon Origin mean earlier gate 4 passes don't count. MangaDex explicitly forbids a spoofed UA.
4. **Leak hits found while building the deny-list** (for SHIELD and RELAY; not fixed here because they are other agents' files). These are case-insensitive substring hits outside tests and fixtures:
   - app `src/routes/About.tsx`: names `mangadex` and links to a third-party `comick-…` repo
   - app `src/lib/query.ts` (`BROWSE_SOURCE = "mangadex"`), plus `src/lib/api/{catalog,endpoints,images}.ts`, `src/lib/titles.ts`, `src/lib/search/run.ts`, `src/lib/intel/themes.ts`: provider id `mangadex` in client code. It may reach the bundle.
   - API `src/app/layout.tsx` and `src/app/page.tsx`: metadata and landing copy list provider names (MangaPark, AsuraScan, AtsuMoe, MangaDex, Comix)
   - API routes `titles/[ref]/*`, `pages`, `catalog`, `image`, `proxy/html`: provider ids in route code. Response exposure is unverified.

## Deny-list

[../providers/_names.json](../providers/_names.json) has 171 `names` (provider display names, adapter ids and domain stems, all safe for substring matching), 148 `domains`, and 9 `generic` terms (`webtoon(s)`, `comix`, `bato`, `danke`, `luminare`, `mangak`, `utoon`, `swarm`). The generic terms clash with ordinary words or reader copy (for example the webtoon reading mode, or `MangaKind`), so leak tests should match them only in hostnames, source-id fields and headers. Generated from `src/lib/providers/manifest.generated.ts`, the adapter file names, and the hosts hard-coded in `src/lib/scrapers` and `src/lib/frontpages` (API repo, 2026-11-23), plus SCOUT's candidates.

## Recommendation

Keep all providers OFF. Don't build new adapters. Escalate the attribution conflict to the owner. Fix the header defaults (honest UA, no forged Referer/Origin) before any future gate 4 run. Have SHIELD's leak test use `_names.json` and fix the client-side `mangadex` references.
