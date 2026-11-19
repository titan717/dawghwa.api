# Unified chapters and the native reader (API)

This is the reference for Dawghwa's multi-source reading engine: how a title is
identified, how provider chapter lists are merged into one list, how pages and
images reach the app's native reader, and how fallback works. The app side is
documented in the app repository at `docs/UNIFIED_READER.md`.

## Architecture

```
GET /api/titles/:ref/chapters/all
  │
  ├─ metadata (AniList / MangaDex / MangaUpdates, enriched cross-references)
  ├─ canonical title            src/lib/identity        dwg:md:<uuid> | dwg:al:<id> | dwg:mu:<id>
  ├─ provider links             src/lib/services/unified.ts discoverLinks()
  │     1. exact cross-references (MangaDex id, official WEBTOON link)
  │     2. search + corroboration (title AND author, no contradictions)
  ├─ chapter lists              bounded concurrency (4), per-provider budget 25 s,
  │                             each list cached independently (10 min fresh / 1 h SWR)
  ├─ merge                      src/lib/chapters/merge.ts (pure, deterministic)
  └─ response                   JSON (paginated) or NDJSON stream (progressive)

POST /api/pages        page manifest for one provider chapter (variant)
GET  /api/image        restricted image relay for allowlisted provider hosts
POST /api/reports      reader-reported variant failures / fallback outcomes
GET  /api/sources/capabilities   honest capability matrix
GET  /api/titles/:ref/identity   why each provider record was (not) linked
```

Only providers that implement a permitted page API and are not client-only take
part: today **MangaDex** (MangaDex@Home API), **WEBTOON** (public episodes) and
**Dynasty Reader** (public chapter manifest). The other registered adapters can
search and list chapters but are not readable in the native reader and are not
counted as supported.

## Data model

### Canonical title (`title` in responses)

| Field | Meaning |
|---|---|
| `id` | `dwg:md:<mangadex uuid>`, else `dwg:al:<anilist id>`, else `dwg:mu:<mangaupdates id>`. The same series reached through `al:` or `md:` refs resolves to the same id once the exact cross-reference is known. |
| `aliases` | All known titles (deduplicated by normalized form) used for matching. |
| `authors`, `artists`, `year`, `format` | Corroboration signals. |

### Unified chapter row

```jsonc
{
  "key": "dwg:md:814b…/en/s0/ch:10.5",   // stable canonical chapter id
  "canonicalTitleId": "dwg:md:814b…",
  "kind": "regular",                      // prologue | regular | epilogue | special | oneshot | unnumbered
  "number": "10.5",                       // exact string, never a lossy float; null if unnumbered
  "numberValue": 10.5,                    // float for legacy clients only
  "season": 2,                            // when the provider labels seasons
  "volume": "2",
  "title": "Rain",
  "display": "Chapter 10.5",
  "language": "en",
  "translations": 2,                      // distinct provider/group translations in the row
  "order": 41,                            // ascending index (stable)
  "variants": [ /* one per provider upload */ ]
}
```

Key format: `<canonicalId>/<language|und>/<s<season>|s0>/<ch|prologue|epilogue|special|oneshot>:<number>` or, for
unnumbered entries, `<kind>:<title-slug>` (or `<kind>:<source>-<id>` when the title is not meaningful). If two rows
would collide (e.g. the same provider lists chapter 4 twice), the later row gets a `~<source>-<id>` suffix.

### Variant

| Field | Meaning |
|---|---|
| `variantId` | `<sourceId>:<providerChapterId>` |
| `sourceId`, `source`, `providerChapterId`, `url` | Where the pages come from |
| `language` | Translation language (MangaDex `translatedLanguage`, WEBTOON URL language, Dynasty `en`) |
| `edition` | `official` (WEBTOON) / `scanlation` (MangaDex, Dynasty) / `unknown` |
| `group` | Scanlation group, when the provider exposes it |
| `originalNumber` | The provider's raw chapter label |
| `match` | `exact` (number and meaningful title agree), `number` (number agrees, titles absent/neutral), `source-only` (only this provider has the row) |

## Chapter number parsing (`src/lib/chapters/number.ts`)

Numbers are kept as strings: `1`, `1.5`, `1.1` and `1.10` are four different chapters. `10.0` normalizes to `10` and leading
zeros are dropped. Labels are read when the provider gives no number (`Episode 25`, `Ch. 12.5`, `(S2) Episode 4`).

* Prologue / epilogue / special / oneshot are classified from the title (`Extras`, `Side Story`, `Bonus`, `Omake`, `Notice`…).
* A numbered special (`Bonus Episode 2`) keeps kind `special` and never joins regular chapter 2.
* **List positions are never chapter numbers.** WEBTOON `episode_no` is a position (unOrdinary's `episode_no=2` is "Episode 1");
  WEBTOON chapters are numbered only from their titles.

Ordering: prologue → numbered chapters by (season, major, minor as an integer part) with a numbered special right after its
chapter → unnumbered epilogue → unnumbered specials → other unnumbered entries; ties keep provider sequence then title, so the
order is stable. `order=desc` is the exact reverse.

## Merge rules (`src/lib/chapters/merge.ts`)

A provider chapter joins an existing row only if **all** hold:

1. same canonical number string and kind (or, if unnumbered, identical meaningful title),
2. same season,
3. same language — an unknown language never joins a known one,
4. no volume contradiction (both known and different ⇒ separate rows),
5. no title contradiction (both meaningful and clearly different ⇒ separate rows),
6. not a second entry from the same provider and same group (a provider's own duplicates stay separate).

Different scanlation groups and editions of the same chapter stay as separate variants in one row. The merge is pure and
sorts inputs by source id, so the output does not depend on provider response order (tested).

## Title identity (`src/lib/identity`)

| Method | Decision |
|---|---|
| Exact MangaDex id (ref or metadata cross-reference) | linked, confidence 1 |
| Official WEBTOON `…/list?title_no=` link from metadata | linked, confidence 1 |
| Search match with title score ≥ 0.9 **and** an author/artist match | linked (`corroborated-match`) |
| Title score ≥ 0.9 but provider exposes no authors | `review` — never merged |
| Different authors, novel edition, year differs by > 2 | `rejected` |

`GET /api/titles/:ref/identity` returns the links with their evidence signals and every considered-but-not-linked candidate.
`sources[].link.evidence` and `sources[].considered` carry the same evidence inside `chapters/all`.

## Endpoints

### GET /api/titles/{ref}/chapters/all

Query: `stream=1` (NDJSON), `order=asc|desc`, `offset`, `limit` (1–5000, default all), `language=en`, `refresh=1`.

JSON: `{ title, metadata, chapters, pagination, totalChapters, languages, sources, summary }`.
`sources[]`: `{ sourceId, source, status: ok|error|timeout|cancelled|no-match|review, link?, considered?, chapterCount?, cache?, durationMs?, error?, errorCode? }`.
`summary`: `{ canonicalTitleId, readerProviders, linkedSources, succeededSources, failedSources, totalChapters, totalVariants, mergedRows, firstResultMs, durationMs }`.

NDJSON events (one JSON object per line): `identity`, `source` (repeated per provider as status changes), `chapters`
(`{ chapters, complete, sourcesDone, sourcesTotal, pagination }`, a merged snapshot after every provider), `summary`, or `error`.
A failing or slow provider never blocks the others; its row shows `status: "error" | "timeout"` and the list is partial.
Expensive endpoint (one token from the expensive rate-limit bucket).

### POST /api/pages

`{ source, chapterId }` or `{ source, url }` → `{ pages: [{ url, index }], totalPages, sourceId, meta: { cache } }`.
Dynasty accepts its chapter slug as `chapterId`; WEBTOON needs the viewer `url` from the variant. Page URLs for the three
reader providers are rewritten to `/api/image?url=…`.

### GET /api/image

Relays images only from allowlisted host/path patterns per provider (MangaDex@Home `/data|data-saver/`, WEBTOON
`webtoon-phinf.pstatic.net`, Dynasty `/system/releases/`). See [Image security](#image-delivery-and-security).

### POST /api/reports

`{ sourceId, kind: "pages"|"image"|"empty", chapterKey?, providerChapterId?, errorCode?, fallback?: { attempted, succeeded, toSourceId? } }` → 202.
Counts appear in `/api/sources/capabilities` under `availability.readerReports`. Reports are unauthenticated, so they
**never** open a circuit or hide a provider; they are operator signals only.

### GET /api/sources/capabilities

One row per registered provider: `declared` (what the adapter implements), `verified` (from the live-verification ledger
`src/lib/providers/verification.ts`), live `availability` (state, circuit, request/failure counts, average latency, reader
reports) and `limitations`. `totals.nativeReaderVerified` counts only ledger providers (currently 3 of 96 registered).

## Capability matrix (verified 2026-11-19)

| Provider | Registered | Search | Metadata | Chapters | Pages | Image delivery | Native reader | Limitations |
|---|---|---|---|---|---|---|---|---|
| MangaDex | yes | verified | verified | verified | verified | verified | verified | Licensed / externally hosted chapters have no pages; English feed only |
| WEBTOON | yes | verified | verified | verified | verified | verified | verified | Public episodes only (no Daily/Fast Pass); numbers from titles |
| Dynasty Reader | yes | verified | verified | verified | verified | verified | verified | Small, niche catalogue |
| 93 other adapters | yes | not verified here | — | — | no page API | — | **no** | Not readable in the native reader |

"Verified" means exercised against the live provider by `src/tests/live/reader-providers.live.test.ts` (API) and the app's
`e2e/live-providers.spec.ts` (browser, real images in the native reader).

## Image delivery and security

* Allowlists per provider (host and path); no arbitrary URL proxying (`/api/proxy` is a separate, restricted endpoint).
* `https:` only, standard ports, no credentials in URLs; DNS is resolved and private/loopback/link-local ranges are refused (SSRF guard).
* Redirects are not followed (`redirect: "manual"`), so every hop would have to pass validation again — a redirect is a failure.
* `Content-Type` must be an image type; size limits 5 MB (MangaDex covers) / 20 MB (pages); 12 s timeout.
* No cookies, tokens or user identifiers are forwarded or logged.
* Paywalls, logins and anti-bot protection are never bypassed. WEBTOON locked episodes are not requested; providers behind
  challenges are reported as `blocked` and skipped.

## Fallback

The API exposes everything the client needs for a safe fallback; the decision is made in the app reader because only it
knows what failed. Rules (`fallbackCompatibility`):

* candidate must be another variant **of the same row** (same canonical chapter),
* same, known language — never changes language,
* automatic only within the same edition (scanlation ↔ scanlation); official ↔ scanlation requires the user,
* a different scanlation group is allowed but reported to the user,
* `source-only` (unverified) matches are never used automatically.

The reader reports the failed variant through `POST /api/reports`.

## Caching

| Data | Fresh | Stale-while-revalidate |
|---|---|---|
| Provider chapter list (per provider + URL) | 10 min | 1 h |
| Identity hints (author/alias per provider record) | 1 day | 7 days |
| Search results (discovery) | 5 min | 30 min |
| Page manifests | 5 min | none (MangaDex@Home URLs expire) |

Identical concurrent `chapters/all` JSON requests share one aggregation. `refresh=1` bypasses every layer.

## Performance (measured locally, 2026-11-19, warm process, cold caches)

| Title | Providers | Rows / variants | First result | Full aggregation |
|---|---|---|---|---|
| Aiura | MangaDex + Dynasty | 113 / 219 (106 merged) | 3.45 s | 3.65 s |
| unOrdinary | WEBTOON (MangaDex has 0 readable) | 414 / 414 | 0.60 s | 1.50 s |
| Lore Olympus | WEBTOON | 9 public episodes | — | 1.2 s |

WEBTOON chapter lists used to walk one HTML page per 10 episodes (unOrdinary exceeded the 25 s budget); they now use the
public mobile-site episode list (one request, 414 episodes in ~0.7 s) with the HTML pagination as fallback.

Page manifests: MangaDex 0.4–1.0 s, Dynasty 0.13 s, WEBTOON 1.2 s. First image through the relay: 20–600 ms.

## Testing

* `src/tests/chapters/number.test.ts` — number parsing and ordering (1 vs 1.5, 1.1 vs 1.10, 0 / 0.5, prologue/epilogue/specials, seasons, list positions).
* `src/tests/chapters/merge.test.ts` — merge rules, language/volume/title/group separation, determinism, fallback compatibility.
* `src/tests/chapters/identity.test.ts` — exact links, corroboration, title-only ⇒ review, contradictions ⇒ rejected.
* `src/tests/services/unified.test.ts` — aggregation with real Provider objects and stubbed adapters: multi-provider merge, failing provider, timeout, progressive stream, cancellation, invalid rows, cache hit/refresh, request coalescing, 1 500-chapter lists.
* `src/tests/api/reader-engine.test.ts` — capability matrix honesty, reports endpoint.
* `src/tests/live/reader-providers.live.test.ts` — **live**: search on all three providers, MangaDex + Dynasty merge and page/image reading, WEBTOON full list and reading. `npm run test:live`.

## Known limitations

* MangaDex feed requests English translations only (`translatedLanguage[]=en`); other languages are modelled but not fetched yet.
* Dynasty volume extras and WEBTOON recap/bonus episodes stay source-only (correctly), so they appear as separate rows.
* Exact page-position mapping between providers is not possible (different page splits); the app maps by fraction and says so.
* Reader failure reports are in-memory per server instance.
