# Chapter page extraction

`POST /api/pages` returns the real page images for a chapter from the provider that listed it. Every adapter reports `capabilities.chapterPages` because it implements `getChapterPages()`. There is no flag to set by hand, and nothing in routing is special-cased for MangaDex. This document records, per provider, how its reader delivers pages, the evidence that extraction works, and why the remaining providers are not supported.

Summary (from `GET /api/sources/capabilities` on this branch): 96 registered providers, **46 with page extraction**, all 46 live-verified (pages and image bytes), and 5 also rendered in the app's native reader by the live E2E (MangaDex, WEBTOON, Dynasty Reader, Asura Scans, Thunderscans).

## How it works

1. The client sends the provider id and the chapter reference **exactly as that provider's chapter list returned it** (`url` or `chapterId`). The route resolves that adapter, and only that adapter. A URL on another provider's domain is rejected (`VALIDATION_ERROR`). Chapter ids are never assumed to be MangaDex UUIDs.
2. The adapter fetches the provider's public reader, using the same request the provider's own reader page makes, and locates the page list. Techniques differ per site (table below).
3. `finalizePages()` normalises the result: absolute HTTPS URLs, document order preserved, duplicates removed, non-page images (credit banners, promos) dropped. Every URL must match the adapter's declared `pageImageRules()` (exact host plus path prefix). Anything else is a `PAGE_FORMAT_CHANGED` error rather than an unvetted URL.
4. `/api/pages` rewrites every page to `/api/image?url=…&source=<id>`. The relay fetches only that provider's declared page hosts and sends that provider's referer. No client cookies or headers are forwarded. It follows at most 3 redirects, each of which must again be an allowed host, and refuses any hop that resolves to a private address. It accepts `application/octet-stream` only when the bytes sniff as JPEG/PNG/WebP/GIF/AVIF, and refuses HTML.
5. Results are cached per `pages:<provider>:<chapter url|id>:<dataSaver>`, so one provider's pages are never served for another provider's chapter.

Errors are explicit, so the app can offer an honest fallback instead of silently switching chapters:

| Code | HTTP | When |
| --- | --- | --- |
| `CHAPTER_LOCKED` | 403 | Premium, coin, early-access or role-gated chapter. Never bypassed. |
| `PAGES_NOT_FOUND` | 404 | Chapter removed, redirected to the site root, a text-only (novel) chapter, or an empty reader |
| `PAGES_PROTECTED` | 422 | The provider scrambles, encrypts or canvas-draws the pages. Not decrypted or reassembled. |
| `PAGE_FORMAT_CHANGED` | 502 | The reader markup or state no longer contains a recognisable page list, or it points at undeclared hosts |
| `UNSUPPORTED_CAPABILITY` | 501 | The adapter has no page extraction (see "Not supported") |

## Evidence

- Live verification: `npx tsx scripts/verify-readers.ts` runs, for every capable provider, search → the provider's own chapter list → `/api/pages` for the first, a middle and the latest chapter → image bytes through `/api/image` (magic bytes checked) for the first, middle and last page. The raw results are in [page-extraction-verification.json](page-extraction-verification.json) (run 2026-11-19 from the development sandbox).
- Replay fixtures: `src/tests/fixtures/pages/<id>.json.gz` hold real responses recorded from each live reader (`scripts/record-page-fixtures.ts`). A trimmed fixture is kept only if replaying it yields identical pages. `src/tests/adapters/page-extraction.test.ts` checks ordering, page counts, first/last URL, host allowlists, foreign and private URLs, upstream failures, and locked/protected/empty/changed readers. It also checks that every capable provider has a fixture and that `chapterPages` equals "implements `getChapterPages`". These tests need no network.
- Live tests (`LIVE_TESTS=1`): `src/tests/live/reader-providers.live.test.ts` covers MangaDex, WEBTOON, Dynasty, Asura Scans, Thunderscans, MangaKatana and Kayn Scans end to end.
- App E2E (`E2E_LIVE=1`, dawghwa `e2e/live-providers.spec.ts`): the native reader renders real pages and saves progress for MangaDex, WEBTOON, Dynasty Reader, Asura Scans (linked on a unified title page) and Thunderscans (reached via "Search all sources").
- Ledger: `src/lib/providers/verification.ts` records the above per provider. `GET /api/sources/capabilities` reports `declared` (the adapter implements it) separately from `verified` (the ledger).

## Supported providers

"Native reader" = yes when the app's live E2E rendered the pages. "API" = pages and image bytes verified through `/api/pages` and `/api/image`, but not yet driven through the app UI. Sample = chapter number: page count from the live run.

| Provider | Technique | Live sample | Native reader | robots.txt (`User-agent: *`) |
| --- | --- | --- | --- | --- |
| Asmodeus Scans | `#chapter-offline-data` JSON (`pages`, `locked`/`paid`) | ch 1: 44; ch 6: 21; ch 10: 34 | API | no disallow; Content-Signal `search=yes,ai-train=no,use=reference` |
| AsuraScan | Astro `ChapterReader` island props in reader HTML (no `/api/`) | ch 1: 19; ch 37: 14; ch 73: 22 | yes | Disallow `/login`, `/register`, `/settings`, `/bookmarks` … (reader paths not covered) |
| Chikari | Public chapter JSON the reader loads; `scan_fallback` refused | ch 1: 19; ch 37: 14; ch 73: 22 | API | no disallow |
| Danke fürs Lesen | Guya public series JSON (`/api/series/<slug>/`) | ch 1: 1; ch 33: 4; ch 50.93: 1 | API | Disallow `/admin/*`, `/admin_home/`, `/read/update_view_count/`, `/api/download_chapter/*` … (reader paths not covered) |
| Diva Scans | Next.js CMS flight data (`pages[]`); scrambled pages refused | ch 1: 10; ch 13: 10; ch 25: 11 | API | Disallow `/admin`, `/api/`, `/store/success`, `/settings` … (reader paths not covered); Content-Signal `search=yes, ai-input=yes, ai-train=yes` |
| Drake Scans | Next.js CMS flight data (`pages[]`); scrambled pages refused | ch 1: 37; ch 8: 34; ch 14: 30 | API | Disallow `/admin`, `/api/`, `/store/success`, `/settings` … (reader paths not covered); Content-Signal `search=yes, ai-input=yes, ai-train=yes` |
| Dynasty Reader | Public chapter JSON manifest | ch 1: 12; ch 2: 9 | yes | no disallow |
| Elf Toon | Next.js CMS flight data (`pages[]`); scrambled pages refused | ch 1: 15; ch 12: 15; ch 22: 12 | API | Disallow `/admin`, `/api/`, `/store/success`, `/settings` … (reader paths not covered); Content-Signal `search=yes, ai-input=yes, ai-train=yes` |
| Eva Scans | MangaThemesia `ts_reader.run` JSON in reader HTML | ch 1: 25; ch 22: 21; ch 43: 10 | API | no disallow; Content-Signal `search=yes,ai-train=no,use=reference` |
| Genz Toons | Keyoapp `#pages img[uid]`, CDN origin from inline script | ch 101: 20; ch 127: 18; ch 152: 18 | API | no disallow; Content-Signal `search=yes,ai-train=no,use=reference` |
| Hachirumi | Guya public series JSON (`/api/series/<slug>/`) | ch 1: 5; ch 4: 5; ch 7: 6 | API | Disallow `/admin/*`, `/admin_home/`, `/read/update_view_count/`, `/proxy/*` … (reader paths not covered); Content-Signal `search=yes,ai-train=no,use=reference` |
| KappaBeast | Strapi `/chapters` with the site's public client key; pages media or `htmlContent` images | ch 1: 42; ch 4: 39; ch 6: 31 | API | robots.txt not served |
| Kayn Scans | Next.js CMS flight data (`pages[]`); scrambled pages refused | ch 1: 25; ch 13: 22; ch 24: 16 | API | Disallow `/admin`, `/api/`, `/store/success`, `/settings` … (reader paths not covered); Content-Signal `search=yes, ai-input=yes, ai-train=yes` |
| Kenscans | Iken/vcomics dehydrated route state (`publicImages`) | ch 1: 47; ch 76: 15; ch 88: 33 | API | Disallow `/api/*` (reader paths not covered) |
| KuraManga | server-rendered `<img>` list in the reader container | ch 1: 38; ch 13: 30; ch 25: 32 | API | Disallow `/settings`, `/partials/`, `/search?` (reader paths not covered) |
| Lua Comic | Next.js flight data URL list | ch 1: 21; ch 29: 11; ch 56: 10 | API | Disallow `/dashboard`, `/preview`, `/api/`, `/login` … (reader paths not covered) |
| Madarascans | MangaThemesia `ts_reader.run` JSON in reader HTML | ch 1: 44; ch 12: 16; ch 22: 24 | API | Disallow `/wp-admin/` (reader paths not covered) |
| MangaDex | Documented MangaDex@Home API (`/at-home/server/{id}`) | ch 1: 31 | yes | public documented API |
| MangaK | `__NEXT_DATA__` page list | ch 0: 3; ch 46: 27; ch 92: 4 | API | no disallow; Content-Signal `search=yes,ai-train=no,use=reference` |
| MangaKatana | inline page array named by the reader script | ch 1: 39; ch 4: 29; ch 5.5: 9 | API | no disallow |
| MangaRead | Madara `.reading-content` images in reader HTML | ch 1: 26; ch 14: 20; ch 27: 118 | API | Disallow `/wp-admin/`, `/WP-manga/` (reader paths not covered) |
| Mangasushi | Madara `.reading-content` images in reader HTML | ch 1: 35 | API | no disallow |
| Mangataro | MangaPeak theme chapter-content JSON the reader calls | ch 1: 66; ch 47: 48; ch 92: 60 | API | Disallow `/wp-admin/` (reader paths not covered); Content-Signal `search=yes,ai-train=no,use=reference` |
| Manhuaplus | reader HTML, then the reader's own `/ajax/image/list/chap/<id>` | ch 0: 1; ch 36: 17; ch 73: 12 | API | Disallow `/panel/` (reader paths not covered) |
| Manhuaus | Madara `.reading-content` images in reader HTML | ch 1: 26; ch 14: 20; ch 27: 117 | API | Disallow `/wp-admin/` (reader paths not covered) |
| Mgeko | server-rendered `<img>` list in the reader container | ch 1: 26; ch 14: 20; ch 27: 117 | API | no disallow |
| Nyx Scans | Iken/vcomics dehydrated route state (`publicImages`) | ch 1: 185; ch 126: 206; ch 251: 39 | API | Disallow `/api/*` (reader paths not covered) |
| Orion Scans | Iken/vcomics dehydrated route state (`publicImages`) | ch 1: 49; ch 29: 30; ch 53: 32 | API | Disallow `/api/*` (reader paths not covered) |
| Qi Scans | server-rendered `<img>` list in the reader container | ch 1: 57; ch 37: 11; ch 78: 98 | API | Disallow `/profile`, `/notifications`, `/store`, `/tickets` … (reader paths not covered) |
| RD Scans | Madara `.reading-content` images in reader HTML | ch 1: 33; ch 5: 31; ch 9: PAGES_NOT_FOUND | API | robots.txt not served |
| Ritharscans | Livewire/Alpine `x-data` pages + access flags | ch 1: 34; ch 3: 32; ch 5: 31 | API | Disallow `/announcement-previews/`, `/dashboard/`, `/downloads/`, `/lotteries/` … (reader paths not covered) |
| Rizz Fables | MangaThemesia reader HTML; promo banner filtered | ch 1: 19; ch 51: 20; ch 100.5: 1 | API | no disallow; Content-Signal `search=yes,ai-train=no,use=reference` |
| Rokari Comics | MangaThemesia `ts_reader.run` JSON in reader HTML | ch 1: 7; ch 27: 10; ch 53: 10 | API | Disallow `/wp-admin/`, `/?s=`, `/search/`, `/tag/` … (reader paths not covered) |
| RoliaScan | MangaPeak theme chapter-content JSON the reader calls | ch 1: 38; ch 102: 34; ch 203: 9 | API | Disallow `/wp-admin/`, `/*?s=`, `/*&s=`, `/*?replytocom=` … (reader paths not covered) |
| Sana Scans | Iken/vcomics dehydrated route state (`publicImages`) | ch 1: 38; ch 7: 26; ch 13: 10 | API | Disallow `/api/*` (reader paths not covered) |
| Siren Scans | `#chapter-offline-data` JSON (`pages`, `locked`/`paid`) | ch 1: 4; ch 21: 3; ch 40: 4 | API | no disallow |
| Spider Scans | server-rendered `<img>` list in the reader container | ch 1: 17; ch 38: 24; ch 74: 17 | API | Disallow `/wp-admin/` (reader paths not covered); Content-Signal `search=yes,ai-train=no,use=reference` |
| TCB Scans | server-rendered `<img>` list in the reader container | ch 1: 57; ch 189: 18; ch 391.5: 14 | API | no disallow |
| Thunderscans | MangaThemesia `ts_reader.run` JSON in reader HTML | ch 1: 26; ch 13: 20; ch 24: 25 | yes | Disallow `/wp-admin/` (reader paths not covered) |
| Valir Scans | Next.js CMS flight data (`pages[]`); scrambled pages refused | ch 1: 39; ch 17: 31; ch 33: 44 | API | Disallow `/admin`, `/api/`, `/store/success`, `/settings` … (reader paths not covered); Content-Signal `search=yes, ai-input=yes, ai-train=yes` |
| Violetscans | MangaThemesia `ts_reader.run` JSON in reader HTML | ch 1: 12; ch 33: 18; ch 67: 37 | API | no disallow; Content-Signal `search=yes,ai-train=no,use=reference` |
| Vortex Scans | Iken/vcomics dehydrated route state (`publicImages`) | ch 1: 221; ch 13: 157; ch 24: 15 | API | Disallow `/api/*` (reader paths not covered) |
| WEBTOON | Public viewer HTML (`#_imageList img`) | ch 1: 221; ch 43: 148; ch 84: 150 | yes | Disallow `/challenge/report`, `/*/creators/series`, `/*/challenge/saveTitle`, `/member/login` … (reader paths not covered) |
| WebtoonClub | flight data `chapter.images`, resolved like the reader | ch 0: 12; ch 97: 122; ch 203: 1 | API | Disallow `/admin`, `/api/`, `/profile`, `/login` … (reader paths not covered) |
| Writers' Scans | Keyoapp `#pages img[uid]`, CDN origin from inline script | ch 1: 5; ch 10: 5; ch 19: 5 | API | no disallow |
| XComic | reader HTML image list | ch 0: 15; ch 101: 120; ch 200.5: 3 | API | no disallow; Content-Signal `search=yes,ai-train=no,use=reference` |

In every case, the paths Dawghwa requests are the public chapter reader page (or the public JSON that reader itself loads) and the image files. None of them is covered by a `Disallow` rule. Where a site disallows `/api/` (Asura, Diva/Drake/Elf/Kayn/Valir, Lua, Nyx/Orion/Sana/Vortex/Kenscans, WebtoonClub), only the reader HTML is read. Content-Signal values restrict AI training and use. Dawghwa only displays pages to a reader and does neither.

### Provider-specific notes

- **Asura Scans**: robots.txt disallows `/api/`, so pages come from the `ChapterReader` props embedded in the public reader HTML. Premium/locked chapters return `CHAPTER_LOCKED`. The CDN refuses foreign referers, so pages always go through `/api/image`. Asura is no longer a client-only source. It joins unified title lists only on evidence beyond the title: the series page's author/artist links and alternative titles. For example, "Solo Leveling: Ragnarok" links to its MangaDex record with 73 chapters.
- **Stonescape and KS Group**: extraction was implemented and worked, but was **removed** because robots.txt forbids it. KS Group has `Disallow: /` for all agents. Stonescape disallows `/api/`, `/read/` and `/pub/`, which are exactly the chapter API and image paths. Note: the pre-existing search/chapter adapters for both sites predate this work and also touch disallowed paths. They are left unchanged and flagged for a maintainer decision.
- **KappaBeast** uses the public client API key shipped in the site's own JavaScript bundle. The existing adapter already did this. Early-access chapters return `CHAPTER_LOCKED`.
- **Chikari** refuses its reader's `scan_fallback` mode (third-party mirrored scans).
- **Mangataro / RoliaScan** (MangaPeak theme): text chapters return `PAGES_NOT_FOUND`, and `INSUFFICIENT_ROLE` returns `CHAPTER_LOCKED`.
- **Siren Scans**' CDN labels images `application/octet-stream`. They are accepted only after byte sniffing.
- **Kenscans** redirects between its two storage hosts. Both are allowlisted, with at most 3 hops.
- **Rizz Fables** inlines a promo banner in the reader, which is filtered out. **WebtoonClub** publishes some chapters as a single notice image. **RD Scans** has chapters removed upstream (`PAGES_NOT_FOUND`).
- **Next.js CMS sites** (Diva, Drake, Elf, Kayn, Valir) can mark pages as encrypted/tiled/stripped/fragmented. Those chapters return `PAGES_PROTECTED` and are never reassembled.
- **Unified titles**: providers other than MangaDex, WEBTOON, Dynasty and Asura expose no identity hints (author, alt titles, external ids). They are therefore never auto-merged into a unified title, because a title match alone is not enough evidence. Users reach them via "Search all sources", which opens the provider's own title page and reads natively there.

## Not supported

| Provider(s) | Why |
| --- | --- |
| Hive Toon, BaeToon | Page lists extract correctly, but their image CDNs (`storage.hivetoon.com`, `bulbasaur.poke-black-and-white.net`) answer server requests with 403 Cloudflare challenge pages, with or without the site referer. The relay would only return errors, so `getChapterPages` was removed. Re-enable after verifying image delivery from the production network. Hive Toon also disallows `/api/*`. |
| KS Group | robots.txt: `User-agent: *` / `Disallow: /` |
| Stonescape | robots.txt disallows `/api/`, `/read/`, `/pub/` (the chapter API and image paths) |
| Swarm | Pages are fetched by POSTing an encoded/encrypted payload to `/api/sp`, and robots.txt disallows `/uploads` (the image path) |
| MangaGo | The page list (`var imgsrcs`) is AES-encrypted. Decrypting it would circumvent a protection measure. |
| Rinko Comics | Pages are drawn onto `<canvas>`, and no image URL exists in the document |
| NovelCool | Chapters are text novel chapters with no page images |
| Flame Comics, WeebCentral, Comix, Atsumoe, Athrea, Lagoon, LH Translation, Magus, Philia, TopManhua, Arya, Demonic, Galaxy Degen, Greed, KDT, Kero, Luminare, MangaBall, MangaCloud, Mist, Project Suki, Raven, Rage, Scythe, Temple, Yaksha Comics, MKissa, Reimanga | Reader pages are behind a Cloudflare/anti-bot challenge for server requests. Challenges are not bypassed, so no pages are extracted. |
| Arven, Bato, Falcon, Fire Scans, Hades, KaliScan, LikeManga, MangaLoom, MangaPark, Mangayy, UToon, WeebDex, Witch Scans, Yaksha Scans | Marked shut down in the registry. No live site to read from. |

## Maintaining

- When a provider changes its reader, the adapter returns `PAGE_FORMAT_CHANGED` instead of wrong pages. Re-run `npx tsx scripts/probe-readers.ts` and `scripts/verify-readers.ts`, fix the locator, then re-record its fixture with `npx tsx scripts/record-page-fixtures.ts /tmp/probe.json <id>`.
- Add a provider to `READER_VERIFICATION` only after the live verifier passes for it. Set `nativeReader: true` only after the app's live E2E renders its pages.
