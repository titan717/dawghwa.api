import { DawghwaError } from "@/lib/core/errors";
import { getFilterOptions } from "@/lib/metadata";
import { anilist, FORMAT_TO_AL, gql, SUMMARY_FIELDS, toSummary, type AlMedia } from "@/lib/metadata/anilist";
import type { BackendListQuery, BackendPage, BackendRecommendations, CatalogueBackend, CatalogueVocabulary, ListOrder } from "./types";

/**
 * AniList as the catalogue backend. Every call goes through the AniList
 * metadata client (shared HTTP client, 27 req/min limiter, circuit breaker,
 * error mapping); results are cached by the facade, not here.
 */

const SORTS: Record<ListOrder, string[]> = {
  trending: ["TRENDING_DESC", "POPULARITY_DESC"],
  popular: ["POPULARITY_DESC"],
  score: ["SCORE_DESC", "POPULARITY_DESC"],
  newest: ["START_DATE_DESC", "POPULARITY_DESC"],
};

/** Formats a reader can open: novels and anything else AniList files under MANGA are left out. */
const READABLE_FORMATS = ["MANGA", "ONE_SHOT"];

/**
 * AniList's GenreCollection has no adult flag; "Hentai" is the genre AniList
 * reserves for adult (isAdult) entries. Tags carry their own isAdult flag.
 */
const ADULT_GENRES = new Set(["hentai"]);

export const LIST_QUERY = `query ($page: Int, $perPage: Int, $sort: [MediaSort], $genre_in: [String], $tag_in: [String],
  $format_in: [MediaFormat], $country: CountryCode, $isAdult: Boolean, $startFrom: FuzzyDateInt,
  $startTo: FuzzyDateInt) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: MANGA, sort: $sort, genre_in: $genre_in, tag_in: $tag_in, format_in: $format_in,
          countryOfOrigin: $country, isAdult: $isAdult, startDate_greater: $startFrom,
          startDate_lesser: $startTo, status_not: NOT_YET_RELEASED) { ${SUMMARY_FIELDS} }
  }
}`;

export const BY_IDS_QUERY = `query ($ids: [Int], $perPage: Int) {
  Page(page: 1, perPage: $perPage) { media(id_in: $ids, type: MANGA) { ${SUMMARY_FIELDS} } }
}`;

export const RECOMMENDATIONS_QUERY = `query ($id: Int, $page: Int, $perPage: Int) {
  Media(id: $id, type: MANGA) {
    ${SUMMARY_FIELDS}
    recommendations(page: $page, perPage: $perPage, sort: [RATING_DESC, ID]) {
      pageInfo { hasNextPage }
      nodes { rating mediaRecommendation { type ${SUMMARY_FIELDS} } }
    }
  }
}`;

/** `YYYY-MM-DD` -> AniList FuzzyDateInt `YYYYMMDD`. */
export function fuzzyDate(iso: string): number {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new DawghwaError("VALIDATION_ERROR", `Invalid date "${iso}"`);
  return Number(`${m[1]}${m[2]}${m[3]}`);
}

/** GraphQL variables for a list query. Exported for tests. */
export function listVariables(q: BackendListQuery): Record<string, unknown> {
  const fmt = q.kind ? FORMAT_TO_AL[q.kind] : undefined;
  return {
    page: q.page,
    perPage: q.limit,
    sort: SORTS[q.order],
    genre_in: q.genre ? [q.genre] : undefined,
    tag_in: q.tag ? [q.tag] : undefined,
    format_in: fmt ? [fmt.format] : READABLE_FORMATS,
    country: fmt?.country,
    isAdult: q.nsfw ? undefined : false,
    // AniList compares strictly; shift by one to make the window inclusive.
    startFrom: q.startedFrom ? fuzzyDate(q.startedFrom) - 1 : undefined,
    startTo: q.startedTo ? fuzzyDate(q.startedTo) + 1 : undefined,
  };
}

const MAX_LIMIT = 50;

export const anilistCatalogue: CatalogueBackend = {
  id: "anilist",
  attribution: { name: "AniList", url: "https://anilist.co" },
  maxLimit: MAX_LIMIT,
  maxDepth: anilist.capabilities.maxDepth ?? 5_000,

  async list(q: BackendListQuery): Promise<BackendPage> {
    const data = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; media: AlMedia[] } }>(LIST_QUERY, listVariables(q));
    return {
      items: data.Page.media.map(toSummary),
      pageInfo: { page: q.page, limit: q.limit, hasNextPage: data.Page.pageInfo.hasNextPage },
    };
  },

  async byIds(ids: string[]) {
    const nums = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const out = [];
    for (let i = 0; i < nums.length; i += MAX_LIMIT) {
      const chunk = nums.slice(i, i + MAX_LIMIT);
      const data = await gql<{ Page: { media: AlMedia[] } }>(BY_IDS_QUERY, { ids: chunk, perPage: chunk.length });
      out.push(...data.Page.media.map(toSummary));
    }
    return out;
  },

  async recommendations(id, q): Promise<BackendRecommendations> {
    const data = await gql<{
      Media:
        | (AlMedia & {
            recommendations: {
              pageInfo: { hasNextPage: boolean };
              nodes: { rating: number | null; mediaRecommendation: (AlMedia & { type: string | null }) | null }[];
            };
          })
        | null;
    }>(RECOMMENDATIONS_QUERY, { id: Number(id), page: q.page, perPage: q.limit }, `AniList has no manga with id ${id}`);
    if (!data.Media) throw new DawghwaError("NOT_FOUND", `AniList has no manga with id ${id}`);
    const seedId = data.Media.id;
    const items = data.Media.recommendations.nodes
      // rating is the net of user up/down votes; <= 0 means users disagree with the pairing
      .filter((n) => (n.rating ?? 0) > 0 && n.mediaRecommendation && n.mediaRecommendation.type === "MANGA")
      .map((n) => n.mediaRecommendation!)
      .filter((m) => m.id !== seedId && (q.nsfw || !m.isAdult) && (!m.format || READABLE_FORMATS.includes(m.format)))
      .map(toSummary);
    return {
      seed: toSummary(data.Media),
      items,
      pageInfo: { page: q.page, limit: q.limit, hasNextPage: data.Media.recommendations.pageInfo.hasNextPage },
    };
  },

  async vocabulary(): Promise<CatalogueVocabulary> {
    const { options } = await getFilterOptions(anilist);
    return {
      genres: options.genres.map((name) => ({ name, adult: ADULT_GENRES.has(name.toLowerCase()) })),
      tags: options.tags.map((t) => ({ name: t.name, group: t.group, adult: Boolean(t.adult) })),
    };
  },

  linkedId(meta) {
    if (meta.provider === "anilist") return meta.providerId;
    return meta.externalIds.anilist ? String(meta.externalIds.anilist) : undefined;
  },
};
