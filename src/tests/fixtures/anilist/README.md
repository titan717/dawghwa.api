# AniList captures

Real responses from `https://graphql.anilist.co`, captured on 2026-11-22 (UTC) with the
queries exported by `src/lib/catalogue/anilist.ts` (`LIST_QUERY`, `BY_IDS_QUERY`,
`RECOMMENDATIONS_QUERY`) and the vocabulary query used by `anilist.filterOptions()`.
Each file holds `{ capturedAt, status, variables, body }`; `body` is the unmodified upstream JSON.

| File | Variables |
| --- | --- |
| `vocabulary.json` | none (`GenreCollection`, `MediaTagCollection`) |
| `list-trending.json` | trending, limit 5 |
| `list-popular-manhwa.json` | popular, kind manhwa (MANGA + KR), limit 5 |
| `list-new.json` | popular, started 2025-11-22..2026-11-22, limit 5 |
| `list-genre-action.json` | popular, genre Action, limit 5 |
| `list-tag-isekai-manhua.json` | popular, tag Isekai, kind manhua, limit 5 |
| `list-empty.json` | genre Mecha, kind manhwa, started in 1950: a real zero-result answer |
| `recommendations-105398.json` | Solo Leveling (105398), page 1, 10 per page |
| `by-ids.json` | ids 105398, 119257, 85143 |

`../mangadex/title-*.json` are `GET https://api.mangadex.org/manga/{id}?includes[]=cover_art&includes[]=author&includes[]=artist`
captured the same day: Solo Leveling (links to AniList 105398) and "Love that Does Not Begin"
(no tracker links at all).
