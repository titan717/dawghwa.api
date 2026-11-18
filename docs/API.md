# Dawghwa API reference (v1.1.0)

Base path: `/api`. Request bodies are JSON (`Content-Type: application/json`; `text/plain` is also accepted so userscripts can skip a CORS preflight). The maximum body size is 16 KB.

Every response carries `X-Request-Id` (echoed if you send a valid one) and `X-Dawghwa-Version`. Rate-limited endpoints also send `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Policy`, plus `Retry-After` when you are limited.

- [Conventions](#conventions)
- [GET /api/sources](#get-apisources)
- [GET /api/sources/{id}](#get-apisourcesid)
- [POST /api/search](#post-apisearch)
- [POST /api/chapters](#post-apichapters)
- [POST /api/manga](#post-apimanga)
- [POST /api/pages](#post-apipages)
- [GET / POST /api/browse](#get--post-apibrowse)
- [Metadata](#metadata)
- [GET / POST /api/health](#get--post-apihealth)
- [GET / POST /api/frontpage](#get--post-apifrontpage)
- [GET /api/proxy/html](#get-apiproxyhtml)
- [Catalogue and metadata](#catalogue-and-metadata): `GET /api/catalog`, `/api/catalog/filters`, `/api/catalog/providers`, `/api/titles/{ref}`
- [Source availability](#source-availability): `GET /api/titles/{ref}/sources`, `/api/titles/{ref}/chapters`, `POST /api/availability`
- [Error codes](#error-codes)
- [Caching](#caching)
- [Rate limits](#rate-limits)
- [Compatibility with upstream](#compatibility-with-upstream)

## Conventions

- `source` takes a source **id** (see `/api/sources`). Display names (case-insensitive) and a few legacy aliases (for example `writers-scans` for `writers'-scans`) also work.
- Boolean flags accept `true/false` or `"1"/"0"`.
- `refresh: true` skips the cache read and stores the fresh value.
- Most responses include `meta.cache`: `hit` (fresh), `stale` (served from cache while a background refresh runs), `miss` (just fetched) or `bypass` (caching disabled).
- URLs in results are always absolute `http(s)` URLs. Titles are trimmed, numbers are finite, and duplicates are removed. Entries that cannot be repaired are dropped, never made up.

## GET /api/sources

Lists every source, ordered by priority and then name.

Query: `status=active|unstable|shutdown|disabled|operational`, `capability=search|chapters|mangaInfo|frontpage|chapterPages|browse|clientOnly`, `type=scanlator|aggregator`, `verbose=true` (adds aliases, allowed domains, rate limit, circuit and metrics).

```json
{
  "sources": [
    {
      "id": "mangadex",
      "name": "MangaDex",
      "baseUrl": "https://mangadex.org",
      "description": "MangaDex - https://mangadex.org",
      "clientOnly": false,
      "type": "aggregator",
      "status": "active",
      "priority": 100,
      "capabilities": { "search": true, "chapters": true, "mangaInfo": true, "frontpage": false, "chapterPages": true, "browse": true, "clientOnly": false },
      "circuit": "closed"
    }
  ],
  "total": 96
}
```

## GET /api/sources/{id}

Returns `{ "source": { ... } }`, one `sources[]` entry in verbose form. Unknown ids give `404 SOURCE_NOT_FOUND`.

## POST /api/search

```json
{ "query": "solo leveling", "source": "mangadex" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `query` | string, 1-200 chars | required |
| `source` | string | a source id, or `"all"` (default) |
| `sources` | string[] (1-100) | explicit subset for a multi-source search |
| `stream` | boolean | multi-source only; `false` returns one JSON document |
| `refresh` | boolean | bypass cache read |

**Single source** returns JSON:

```json
{
  "results": [
    {
      "id": "37f5cce0-8070-4ada-96e5-fa24b1bd4ff9",
      "title": "Kaguya-sama wa Kokurasetai",
      "url": "https://mangadex.org/title/37f5cce0-8070-4ada-96e5-fa24b1bd4ff9",
      "coverImage": "https://uploads.mangadex.org/covers/.../cover.jpg.256.jpg",
      "latestChapter": 281,
      "lastUpdated": "2 months ago",
      "lastUpdatedTimestamp": 1718000000000
    }
  ],
  "source": "MangaDex",
  "sourceId": "mangadex",
  "meta": { "cache": "miss", "age": 0, "durationMs": 412, "total": 1 }
}
```

**Multiple sources** (`source: "all"`, or `sources: [...]`) stream newline-delimited JSON (`application/x-ndjson`). There is one line per source, written as soon as that source finishes, and a final summary line:

```
{"source":"MangaDex","sourceId":"mangadex","results":[...],"done":false,"cached":false,"durationMs":388}
{"source":"Comix","sourceId":"comix","results":[],"error":"Upstream source is protected by an anti-bot challenge","errorCode":"UPSTREAM_BLOCKED","done":false,"durationMs":291}
{"source":"Greed Scans","sourceId":"greed-scans","results":[],"error":"Greed Scans did not finish within 12000ms","errorCode":"UPSTREAM_TIMEOUT","done":false,"durationMs":12001}
{"done":true,"totalSources":82,"completedSources":82,"failedSources":24,"timedOutSources":1,"totalResults":311,"durationMs":12022}
```

- `source: "all"` searches the operational sources only (not shut down or disabled). If you list a shut-down source explicitly in `sources`, it gets a `SOURCE_UNAVAILABLE` line.
- Concurrency is 16 sources at a time. Each source gets `SEARCH_SOURCE_TIMEOUT_MS` (12 s), and the whole search has a `SEARCH_OVERALL_TIMEOUT_MS` (25 s) deadline. Sources still pending at the deadline get an `UPSTREAM_TIMEOUT` line.
- If the client disconnects, all pending upstream requests are aborted.
- Each multi-source search also costs one token from the [expensive](#rate-limits) bucket.

`stream: false` returns `{ query, sources: [...lines], unavailable: [...], summary }`.

## POST /api/chapters

```json
{ "url": "https://mangadex.org/title/37f5cce0-8070-4ada-96e5-fa24b1bd4ff9", "order": "desc", "offset": 0, "limit": 50 }
```

| Field | Type | Notes |
| --- | --- | --- |
| `url` | string | manga URL on a supported source domain (exact host or subdomain) |
| `source` | string | optional; if given, the URL host must belong to it |
| `offset`, `limit` | integers | optional pagination over the cached list (`limit` up to 5000) |
| `order` | `source` \| `asc` \| `desc` | default `source` (the adapter's own order, as upstream) |
| `refresh` | boolean | |

```json
{
  "chapters": [
    { "id": "6f1c...", "number": 281, "title": "...", "url": "https://mangadex.org/chapter/6f1c...", "lastUpdated": "1 year ago",
      "group": { "id": "...", "name": "...", "url": "https://mangadex.org/group/..." } }
  ],
  "source": "MangaDex",
  "sourceId": "mangadex",
  "totalChapters": 317,
  "pagination": { "offset": 0, "limit": 50, "returned": 50, "total": 317, "hasMore": true },
  "meta": { "cache": "miss", "age": 0 }
}
```

URLs that are not `http(s)`, contain credentials, use non-default ports, or are not on the source's domains are rejected with `400 VALIDATION_ERROR` before any request is made. (Upstream accepted any URL that *contained* a source domain, for example `http://169.254.169.254/?mangadex.org`.)

## POST /api/manga

```json
{ "url": "https://mangadex.org/title/37f5cce0-8070-4ada-96e5-fa24b1bd4ff9" }
```

```json
{ "manga": { "title": "Kaguya-sama wa Kokurasetai", "id": "37f5cce0-...", "url": "https://mangadex.org/title/37f5cce0-..." },
  "source": "MangaDex", "sourceId": "mangadex", "meta": { "cache": "miss", "age": 0 } }
```

Sources that have a documented, stable id format (MangaDex) also accept `{ "source": "mangadex", "id": "<uuid>" }` instead of `url`; other sources answer `501 UNSUPPORTED_CAPABILITY` for an id.

This wraps the adapter's `extractMangaInfo()`. Fields beyond `title` and `id` depend on the adapter. MangaDex also returns `coverImage` and a [`metadata`](#metadata) object (with `rating` and `follows` from its statistics API).

## POST /api/pages

Returns image URLs for a chapter. It is only available for sources whose provider documents a page API: currently **MangaDex** ([MangaDex@Home](https://api.mangadex.org/docs/04-chapter/retrieving-chapter/)). Every other source returns `501 UNSUPPORTED_CAPABILITY`. You can check `capabilities.chapterPages` in `/api/sources`.

```json
{ "source": "mangadex", "chapterId": "a1b2c3d4-0000-4000-8000-000000000001", "dataSaver": false }
```

or `{ "url": "https://mangadex.org/chapter/<uuid>" }`.

```json
{
  "pages": [
    { "index": 0, "url": "https://cmdxd98sb0x3yprd.mangadex.network/data/<hash>/1-....png" }
  ],
  "totalPages": 18,
  "source": "MangaDex",
  "sourceId": "mangadex",
  "chapterId": "a1b2c3d4-...",
  "meta": { "cache": "miss", "age": 0, "dataSaver": false }
}
```

Notes:
- MangaDex@Home base URLs are temporary (about 15 minutes), so page lists are cached for only 5 minutes and never served stale. Validated MangaDex data and data-saver page URLs are rewritten to Dawghwa’s restricted /api/image relay. Other providers’ page URLs remain direct unless a provider-specific permitted relay is implemented.
- MangaDex asks clients to [report image load success/failure](https://api.mangadex.org/docs/04-chapter/retrieving-chapter/) for its network. For accepted *.mangadex.network node URLs, the server-side relay reports success/failure, bytes, duration and cache-hit status to MangaDex@Home asynchronously. uploads.mangadex.org URLs are not @Home nodes and are not reported.
- Chapters hosted externally (`externalUrl`) are not part of MangaDex chapter lists, so they have no pages here.

## GET / POST /api/browse

Filtered catalogue listing, only for sources whose provider documents a listing API: currently **MangaDex** (`GET /manga` and `GET /statistics/manga`). Check `capabilities.browse` in `/api/sources`.

`GET /api/browse` lists the sources that support it: `{ "sources": [{ "id": "mangadex", "name": "MangaDex" }] }`.

`GET /api/browse?source=mangadex` returns the vocabulary: `tags` (`{ name, group }`, groups `genre`, `theme`, `format`, `content`), `kinds`, `status`, `demographic`, `orders`, `maxOffset` (10000) and `maxLimit` (100).

```json
{ "includedTags": ["Fantasy", "Reincarnation"], "kinds": ["manhwa"], "status": ["completed"], "order": "rating", "offset": 0, "limit": 24 }
```

| Field | Type | Notes |
| --- | --- | --- |
| `source` | string | default: the first browse-capable source |
| `query` | string, 1-200 | optional title filter |
| `includedTags`, `excludedTags` | string[] (≤ 20) | tag names from the vocabulary, case-insensitive. **Unknown names give `400 VALIDATION_ERROR` with `details.unknownTags`**, never unfiltered results |
| `includedTagsMode` | `and` (default) \| `or` | |
| `kinds` | (`manga` \| `manhwa` \| `manhua` \| `comic`)[] | mapped to the original language (ja / ko / zh, zh-hk / en) |
| `status` | (`ongoing` \| `completed` \| `hiatus` \| `cancelled`)[] | |
| `demographic` | (`shounen` \| `shoujo` \| `seinen` \| `josei` \| `none`)[] | |
| `year` | integer | |
| `createdWithinDays` | integer | only titles added to the source in the last N days |
| `order` | `popular` (follows) \| `rating` \| `latest` (latest uploaded chapter) \| `new` (added) \| `relevance` \| `year` | default `popular` (`relevance` with a `query`) |
| `offset`, `limit` | integers | `limit` ≤ 100, `offset + limit` ≤ 10000 |
| `withStats` | boolean | default `true`: adds rating and follows (one batched request) |

Only titles with available English chapters and a `safe` or `suggestive` content rating are listed. The response has the search result shape plus `metadata`:

```json
{ "items": [ { "id": "...", "title": "Solo Leveling", "url": "https://mangadex.org/title/...", "coverImage": "...256.jpg", "latestChapter": 200,
    "lastUpdated": "10mo ago", "rating": 9.32, "followers": "320991", "metadata": { "kind": "manhwa", "longStrip": true, "genres": ["Action"], "...": "..." } } ],
  "total": 4683, "pagination": { "offset": 0, "limit": 24, "returned": 24, "total": 4683, "hasMore": true },
  "source": "MangaDex", "sourceId": "mangadex", "meta": { "cache": "miss", "age": 0 } }
```

Cached with the frontpage policy (5 min fresh, 30 min stale). Identical filters in a different order share one cache entry.

## Metadata

`metadata` is optional and appears on MangaDex search, browse and manga results. Every field is omitted when the provider does not supply it; nothing is guessed.

| Field | Notes |
| --- | --- |
| `altTitles`, `description` | description is plain text (≤ 4000 chars) |
| `tags`, `genres`, `themes`, `formats` | tag names as the provider publishes them |
| `kind`, `originalLanguage` | `kind` is derived from the original language only |
| `longStrip` | provider marks the title as a vertical long strip |
| `demographic`, `status`, `year`, `contentRating` | |
| `authors`, `artists` | |
| `rating`, `follows` | 0-10 bayesian rating and follow count (browse and manga; search omits them) |
| `coverImageLarge`, `availableLanguages`, `lastChapter`, `createdAt`, `updatedAt` | |

## GET / POST /api/health

`GET /api/health` returns the cached health of all operational sources (5 min fresh, 30 min stale-while-revalidate). On a cold cache, the response streams whitespace keep-alives until the check finishes (at most `HEALTH_OVERALL_TIMEOUT_MS`, 55 s). JSON parsers ignore that whitespace.

```json
{
  "sources": {
    "mangadex": { "status": "healthy", "message": "Source is operational", "responseTime": 402, "lastChecked": "2026-11-16T09:10:00.000Z", "circuit": "closed" },
    "comix": { "status": "cloudflare", "message": "Cloudflare / anti-bot protection detected", "responseTime": 291, "lastChecked": "...", "errorCode": "UPSTREAM_BLOCKED", "circuit": "closed" }
  },
  "cached": true, "cacheAge": 41, "stale": false,
  "summary": { "total": 82, "healthy": 58, "cloudflare": 22, "timeout": 1, "error": 1 },
  "unavailable": [ { "id": "mangapark", "status": "shutdown", "note": "Site shut down (upstream); HTTP 502 when probed 2026-11-16" } ]
}
```

- `status` is one of `healthy`, `cloudflare` (any anti-bot challenge), `timeout` or `error`, the same values upstream used.
- `GET /api/health?source=mangadex` probes one source (cached 2 minutes) and returns `{ source, health, circuit, metrics }`.
- `POST /api/health` forces a fresh full check and is charged to the expensive rate-limit bucket.
- Health probes are allowed through an open circuit breaker as its recovery trial, so a source that comes back is re-enabled automatically.

## GET / POST /api/frontpage

`GET` lists the sources that have frontpage sections:

```json
{ "sources": [ { "sourceId": "comix", "sourceName": "Comix", "availableSections": [ { "id": "trending", "title": "Most Recent Popular", "type": "trending", "supportsTimeFilter": true, "availableTimeFilters": [1,7,30,90,180,365] } ] } ],
  "sourceIds": ["comix"] }
```

`POST` fetches one section:

```json
{ "source": "comix", "section": "trending", "page": 1, "limit": 30, "days": 7 }
```

It returns `{ source, sourceName, section: { id, title, type, items: [...] }, fetchedAt, meta }`. Unknown sections or invalid `days` values give `400` with the allowed values. Sources without frontpage support give `501 UNSUPPORTED_CAPABILITY`. (Comix is currently behind an anti-bot challenge from datacenter networks, so this returns `502 UPSTREAM_BLOCKED` there.)

## GET /api/proxy/html

`GET /api/proxy/html?url=<https URL>` exists for the client-only sources (AsuraScan, WeebCentral) whose HTML is parsed in the client. Restrictions:

- Only `https`, default port, no credentials.
- The host must match exactly (or be a subdomain of) a domain of an operational client-only source. Upstream used an unanchored regex, which accepted `https://evil.example/?u=https://weebcentral.com`.
- The destination must not resolve to a private, loopback, link-local or reserved address. This is checked on every redirect hop, and redirects to other hosts are rejected.
- Only `text/html` responses are returned, with at most 5 MB and a 15 s timeout. Client cookies and headers are not forwarded.
- The response carries `Content-Security-Policy: sandbox; default-src 'none'; ...`, so proxied HTML can never run scripts on the API origin.

Rejections return `403 PROXY_FORBIDDEN`.

## GET /api/image

GET /api/image?url=... relays validated MangaDex cover and chapter page images.

- Covers accept only https://uploads.mangadex.org/covers/{uuid}/{file}, including .256.jpg and .512.jpg thumbnails.
- Chapter pages accept only MangaDex@Home /data/{hash}/{file} and /data-saver/{hash}/{file} paths on the exact MangaDex image hosts accepted by parseMangaDexPageUrl.
- Arbitrary hosts, URL credentials, non-default ports, query/hash modifiers, unexpected paths, and redirects are rejected. No client headers or cookies are forwarded.
- Cover responses are limited to 5 MB; chapter pages are limited to 20 MB. Only image/* responses are passed through, with timeouts and CDN/browser caching.
- This is not a general-purpose proxy. Other providers need explicit provider-specific host/path allowlists before their image bytes can be relayed.


## Catalogue and metadata

Series metadata (titles, alternative titles, covers, genres, tags, status, format, score, authors, cross-database ids) comes from three public databases. Dawghwa does not host this data. It forwards your query, normalizes the answer and caches it.

| Provider | id | Ref format | Notes |
| --- | --- | --- | --- |
| [AniList](https://anilist.co) | `anilist` (default) | `anilist:105398` or `al:105398` | GraphQL API. AniList documents 90 requests/min but currently enforces 30/min, so Dawghwa limits itself to `ANILIST_REQUESTS_PER_MINUTE` (default 30). Use is subject to the [AniList terms](https://docs.anilist.co/guide/terms-of-use): free use, no mass collection of data. |
| [MangaDex](https://mangadex.org) | `mangadex` | `mangadex:<uuid>` or `md:<uuid>` | Shares the MangaDex source adapter's 4 req/s budget. Credit MangaDex and the scanlation groups ([API docs](https://api.mangadex.org/docs/)). Pornographic entries are excluded unless `nsfw=true`. Browsing stops at 10,000 results. |
| [MangaUpdates](https://www.mangaupdates.com) | `mangaupdates` | `mangaupdates:15180124327`, `mu:15180124327` or the URL slug `mu:6z1uqw7` | Public read API at 2 req/s. Credit MangaUpdates. Has no status filter, and adult genres are excluded unless `nsfw=true`. |

Responses include `attribution` (`name`, `url`, `terms`). Show it in your client.

### GET /api/catalog

Browse or search the catalogue.

| Query | Meaning |
| --- | --- |
| `provider` | `anilist` (default), `mangadex`, `mangaupdates` |
| `q` | Title search |
| `genre` / `genres` | Repeatable or comma-separated. All of them must match. |
| `excludeGenre` | Repeatable or comma-separated |
| `tag` | Repeatable or comma-separated. AniList tags, MangaDex tags or MangaUpdates categories. |
| `status` | `ongoing`, `completed`, `hiatus`, `cancelled`, `upcoming` |
| `format` | `manga`, `manhwa`, `manhua`, `one_shot`, `novel`, `doujinshi`, `oel` |
| `year` | Start year |
| `sort` | `relevance` (needs `q`), `popularity`, `score`, `trending`, `updated`, `newest`, `title` |
| `nsfw` | Include adult entries (default `false`) |
| `page`, `limit` | Default 1 and 20. The maximum `limit` depends on the provider. |

A filter the provider cannot apply returns `400 VALIDATION_ERROR` with `details.supported`. It is never silently ignored. Example:

```bash
curl 'localhost:3000/api/catalog?genre=Action&format=manhwa&status=ongoing&sort=popularity&limit=10'
```

```json
{
  "provider": "anilist",
  "items": [
    {
      "ref": "anilist:105398", "provider": "anilist", "providerId": "105398",
      "title": "Solo Leveling", "altTitles": ["Na Honjaman Level Up", "나 혼자만 레벨업", "..."],
      "url": "https://anilist.co/manga/105398", "coverImage": "https://s4.anilist.co/...jpg",
      "format": "manhwa", "status": "completed", "year": 2018,
      "genres": ["Action", "Adventure", "Fantasy"], "score": 84, "adult": false, "latestChapter": 201
    }
  ],
  "pageInfo": { "page": 1, "limit": 10, "total": 5000, "hasNextPage": true },
  "attribution": { "name": "AniList", "url": "https://anilist.co", "terms": "https://docs.anilist.co/guide/terms-of-use" },
  "meta": { "cache": "miss", "age": 0 }
}
```

MangaDex list items also carry `description`, `tagNames` (every tag, genres included) and `demographic`, because MangaDex returns them in its list response. Other providers leave these fields out; use `/api/titles/{ref}` for full metadata.

### GET /api/catalog/filters?provider=

Returns the genres, tags, sorts, formats and statuses the provider supports. Use it to build filter UIs. It is cached for 24 hours.

### GET /api/catalog/providers

Lists the enabled providers with their capabilities, attribution and circuit state.

### GET /api/titles/{ref}

Full metadata for one series:
- `titles` (`english`, `romaji`, `native`) and `altTitles`
- `description` (plain text)
- `coverImage`, `bannerImage`
- `genres`, `tags` (with rank and spoiler flag)
- `authors`, `artists`
- `chapters`, `volumes`, `score`, `popularity`
- `countryOfOrigin`, `externalIds`, `links`

`?enrich=true` adds exact cross-database ids and links through MangaDex's own link table, for example AniList to MangaDex, MyAnimeList and MangaUpdates. These links are maintained by MangaDex. Dawghwa never guesses them from titles.

## Source availability

Comick let the reader choose which group or site to read a series from. Dawghwa does the same across the sources that work right now.

1. All known titles of the series are collected (English, romanized, synonyms; native-script titles are used for matching only).
2. Every working source is searched in parallel, using the same per-source isolation, rate limits, timeouts and cache as `/api/search`.
3. Each result is compared against every known title. Bracketed notes such as `(Manhwa)` are ignored, so sequels and spin-offs score lower. Novel editions are demoted unless the series is a novel.
4. Sources that returned no match are searched once more with an alternative title (`AVAILABILITY_MAX_ALT_QUERIES`).
5. Sources are ranked: exact matches first, then the furthest latest chapter, then source priority.

Match confidence:

| `confidence` | Score | Meaning |
| --- | --- | --- |
| `exact` | ≥ 0.95 | Same title after normalization |
| `high` | ≥ `minScore` (default 0.82) | Counted as available |
| `possible` | ≥ 0.6 | Listed in `candidates` only. Often a sequel, spin-off or other edition. |

Sources whose most recent observation was an anti-bot block or a failure are skipped and listed in `skipped` with a reason. The observation comes from live traffic or the last health check. After 30 minutes without new evidence they are tried again; `includeUnavailable=true` tries them right away. Shut-down and disabled sources are never searched. A source with no confident match is reported as `available: false`; Dawghwa never pretends a series is there.

### GET /api/titles/{ref}/sources

| Query | Meaning |
| --- | --- |
| `sources` | Comma-separated source ids (default: all working sources) |
| `stream` | `1` for NDJSON events, so a client can show sources as they answer |
| `minScore` | 0.6 to 1 (default `AVAILABILITY_MIN_SCORE`) |
| `includeUnavailable` | Also try sources that were recently blocked or failing |
| `refresh` | Skip the cache |

```json
{
  "title": { "ref": "anilist:105398", "title": "Solo Leveling", "altTitles": ["..."], "coverImage": "..." },
  "sources": [
    {
      "sourceId": "asurascan", "source": "AsuraScan", "type": "scanlator", "status": "active",
      "state": "working", "clientOnly": true, "chapterPages": false, "available": true,
      "best": {
        "id": "solo-leveling-7ba78ec7", "title": "Solo Leveling",
        "url": "https://asurascans.com/comics/solo-leveling-7ba78ec7",
        "latestChapter": 200, "lastUpdated": "...", "score": 1, "confidence": "exact",
        "matchedAgainst": "Solo Leveling"
      },
      "candidates": [{ "title": "Solo Leveling: Ragnarok", "score": 0.71, "confidence": "possible", "...": "..." }],
      "queries": ["Solo Leveling"], "cached": false, "durationMs": 1921
    }
  ],
  "skipped": [{ "sourceId": "weebcentral", "state": "blocked", "reason": "Source is behind anti-bot protection from this server; ..." }],
  "summary": {
    "done": true, "title": "Solo Leveling", "queries": ["Solo Leveling", "Na Honjaman Level Up"],
    "totalSources": 82, "availableSources": 17, "noMatchSources": 41, "failedSources": 0, "skippedSources": 24,
    "ranking": ["webtoonclub", "baetoon", "...", "asurascan"], "durationMs": 15097
  }
}
```

`sources` is sorted by `summary.ranking`, with sources that have no match after it. With `stream=1`, each line has an `event` field: `title`, then one `source` or `skipped` per source as it finishes, then `summary`, or `error` if the lookup fails. Pass `best.url` to `POST /api/chapters` with `source: sourceId`, or use the endpoint below.

All sources count as an expensive request (12/min by default). Lists of up to 3 sources do not.

### GET /api/titles/{ref}/chapters?source=

Finds the series on one chosen source and returns that source's chapter list. The response has title, source, sourceId, match, chapters, totalChapters and meta.cache. If the source has no confident match, the response is 404 NOT_FOUND. order is source, asc or desc. minScore and refresh work as above.

### GET /api/titles/{ref}/chapters/all

Aggregates chapters from operational providers that explicitly support chapter-page retrieval and are not client-only. The route discovers matching source titles, retrieves chapter lists with bounded concurrency, and returns one chronological list with source-specific variants.

Each chapter includes a stable key, number, optional title, and variants[] with sourceId, source, providerChapterId, source chapter URL and optional scanlation group. Same positive chapter number + normalized non-empty title are grouped as possible variants. Untitled/special rows remain source-specific.

The current scraper contract does not expose a reliable per-chapter language field. Therefore language is null and languageVerified is false: a grouped entry is not a guarantee that translations or editions are identical. Clients must let readers choose a variant and must not silently change language.

The response also includes per-source chapter retrieval status, skipped sources and summary counts. limit defaults to 32 and accepts 1–64; refresh bypasses cached title/chapter results. This is an expensive endpoint and consumes one token from the expensive rate-limit bucket.

### POST /api/availability

Runs the same lookup for a free-text title, without a metadata lookup:

```json
{ "title": "The Beginning After the End", "altTitles": ["TBATE"], "sources": ["mangadex", "mangakatana"],
  "format": "manhwa", "stream": false, "minScore": 0.82, "includeUnavailable": false, "refresh": false }
```

The response has the same shape as `GET /api/titles/{ref}/sources`.

## Error codes

Every error body has this shape: `{ "error": string, "code": string, "requestId": string, "details"?: object }`. `error` is a human-readable string, as in upstream. Internal exception messages and upstream response bodies are never included unless `EXPOSE_ERROR_DETAILS=true`.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid field (`details.issues` lists them), URL not on a source domain, etc. |
| 400 | `INVALID_JSON` | Body is not valid JSON |
| 400 | `BAD_REQUEST` | Other malformed request |
| 403 | `PROXY_FORBIDDEN` | Destination not allowed (proxy allowlist, private network, scheme, port, credentials) |
| 404 | `SOURCE_NOT_FOUND` | Unknown source id |
| 404 | `NOT_FOUND` | The source or metadata provider says the item does not exist, or the chosen source has no confident match (`details.candidates`) |
| 413 | `PAYLOAD_TOO_LARGE` | Body larger than `API_MAX_BODY_BYTES` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body is not JSON / text |
| 429 | `RATE_LIMITED` | Client exceeded its rate limit (`Retry-After` set) |
| 501 | `UNSUPPORTED_CAPABILITY` | The source cannot do this (pages, frontpage) |
| 502 | `UPSTREAM_BLOCKED` | Source served an anti-bot challenge (Cloudflare, DDoS-Guard, DataDome, Sucuri) |
| 502 | `UPSTREAM_HTTP_ERROR` | Source answered with an HTTP error (`details.upstreamStatus`) |
| 502 | `UPSTREAM_NETWORK_ERROR` | DNS/connection failure |
| 502 | `UPSTREAM_RESPONSE_TOO_LARGE` | Source response exceeded the size limit |
| 502 | `UPSTREAM_ERROR` | Adapter could not parse the source's response |
| 503 | `SOURCE_UNAVAILABLE` | Source is shut down or disabled, or its request queue is full |
| 503 | `SOURCE_CIRCUIT_OPEN` | Source temporarily disabled after repeated failures (`Retry-After` set) |
| 503 | `UPSTREAM_RATE_LIMITED` | Source returned HTTP 429 |
| 504 | `UPSTREAM_TIMEOUT` | Source did not answer within the time budget |
| 500 | `INTERNAL_ERROR` | Unexpected server error (logged with the request id) |

## Caching

| Data | Fresh (TTL) | Stale-while-revalidate | Variables |
| --- | --- | --- | --- |
| Search results (per source + normalized query) | 5 min | 30 min | `CACHE_SEARCH_TTL`, `CACHE_SEARCH_SWR` |
| Chapter lists | 10 min | 1 h | `CACHE_CHAPTERS_*` |
| Manga metadata | 1 h | 24 h | `CACHE_METADATA_*` |
| Frontpage sections | 5 min | 30 min | `CACHE_FRONTPAGE_*` |
| Source health | 5 min | 30 min | `CACHE_HEALTH_*` |
| Chapter pages | 5 min | none | `CACHE_PAGES_TTL` |
| Catalogue pages | 15 min | 1 h | `CACHE_CATALOG_TTL`, `CACHE_CATALOG_SWR` |
| Title metadata (AniList/MangaDex/MangaUpdates) | 1 h | 24 h | `CACHE_METADATA_*` |
| Catalogue filter options | 24 h | 7 days | none |

- A **stale** value is returned immediately while one background refresh runs. If that refresh fails, the stale value stays in place.
- Concurrent requests for the same uncached key share one upstream fetch (request coalescing). Identical in-flight upstream HTTP requests are also merged.
- Errors are never cached.
- When a source sends `ETag` / `Last-Modified` (and not `no-store`), later fetches are conditional, and a `304` reuses the stored body.
- Storage is in-memory LRU, bounded by `CACHE_MEMORY_MAX_ENTRIES` and `CACHE_MEMORY_MAX_BYTES`. When `REDIS_REST_URL` / `REDIS_REST_TOKEN` are set, Redis is added as a shared second tier. If Redis is unavailable, Dawghwa continues with memory only and tries Redis again after 30 s.
- `GET /api` reports the active cache backend.

## Rate limits

Inbound limits are per client, keyed by IP: `X-Forwarded-For` / `X-Real-IP` when `TRUST_PROXY=true`, otherwise the platform-provided IP.

| Bucket | Default | Applies to |
| --- | --- | --- |
| standard | 120 / minute | every endpoint except `GET /api` |
| expensive | 12 / minute | multi-source search, availability lookups over more than 3 sources, and `POST /api/health`; charged on top of standard |

The limiter is in-memory, so on serverless platforms each instance enforces it separately. Use your platform's firewall for a global limit.

Outbound limits apply per source, so Dawghwa stays polite to providers. Each source has a token bucket (default 5 req/s, burst 10) and a concurrency cap (6), with a bounded, cancellable queue. MangaDex is limited to 4 req/s with a concurrency of 4, staying under its documented global limit of about 5 req/s. Metadata providers have their own budgets: AniList 30 req/min (`ANILIST_REQUESTS_PER_MINUTE`), MangaDex shares the source budget, and MangaUpdates is limited to 2 req/s. Upstream `429` responses honour `Retry-After` up to `UPSTREAM_RETRY_MAX_MS`.

## Compatibility with upstream

Request bodies and response fields from comick-source-api keep working: `results`, `source`, `chapters`, `totalChapters`, the NDJSON search lines and summary, `sources` maps in health, and the frontpage shapes. The differences:

- Errors now also carry `code` and `requestId`, and status codes are more specific (for example `404 SOURCE_NOT_FOUND` instead of `400`).
- Shut-down sources are skipped in `"all"` searches instead of being searched.
- `/api/sources` is ordered by priority, and each entry has `status` and `capabilities`.
- `/api/proxy/html` only proxies the client-only sources' hosts.
