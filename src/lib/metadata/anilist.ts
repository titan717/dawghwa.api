import { DawghwaError } from "@/lib/core/errors";
import { metaJson, plainText, uniqueStrings } from "./client";
import type {
  CatalogCapabilities,
  CatalogFilterOptions,
  CatalogPage,
  CatalogQuery,
  CatalogSort,
  MetadataProvider,
  TitleFormat,
  TitleMetadata,
  TitleStatus,
  TitleSummary,
} from "./types";

/**
 * AniList GraphQL API (https://docs.anilist.co). Public, no key required for
 * reads. Limits: 90 req/min documented, currently degraded to 30 req/min;
 * free for non-commercial use; no bulk collection (we only proxy user queries
 * and cache the answers).
 */
const ENDPOINT = "https://graphql.anilist.co";

interface AlMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[] | null;
  format: string | null;
  status: string | null;
  countryOfOrigin: string | null;
  startDate: { year: number | null } | null;
  chapters: number | null;
  volumes: number | null;
  genres: string[] | null;
  averageScore: number | null;
  meanScore?: number | null;
  popularity: number | null;
  coverImage: { extraLarge: string | null; large: string | null } | null;
  bannerImage?: string | null;
  isAdult: boolean | null;
  siteUrl: string | null;
  updatedAt?: number | null;
  description?: string | null;
  tags?: { name: string; rank: number | null; isMediaSpoiler: boolean | null; category: string | null }[] | null;
  staff?: { edges: { role: string | null; node: { name: { full: string | null } | null } | null }[] } | null;
  externalLinks?: { site: string; url: string | null; type: string | null }[] | null;
}

const SUMMARY_FIELDS = `
  id idMal title { romaji english native } synonyms format status countryOfOrigin
  startDate { year } chapters volumes genres averageScore popularity
  coverImage { extraLarge large } isAdult siteUrl`;

const DETAIL_FIELDS = `${SUMMARY_FIELDS}
  meanScore bannerImage updatedAt description(asHtml: false)
  tags { name rank isMediaSpoiler category }
  staff(perPage: 12, sort: [RELEVANCE, ROLE]) { edges { role node { name { full } } } }
  externalLinks { site url type }`;

const SORTS: Partial<Record<CatalogSort, string>> = {
  relevance: "SEARCH_MATCH",
  popularity: "POPULARITY_DESC",
  score: "SCORE_DESC",
  trending: "TRENDING_DESC",
  updated: "UPDATED_AT_DESC",
  newest: "START_DATE_DESC",
  title: "TITLE_ROMAJI",
};

const STATUS_TO_AL: Partial<Record<TitleStatus, string>> = {
  ongoing: "RELEASING",
  completed: "FINISHED",
  hiatus: "HIATUS",
  cancelled: "CANCELLED",
  upcoming: "NOT_YET_RELEASED",
};

const STATUS_FROM_AL: Record<string, TitleStatus> = {
  RELEASING: "ongoing",
  FINISHED: "completed",
  HIATUS: "hiatus",
  CANCELLED: "cancelled",
  NOT_YET_RELEASED: "upcoming",
};

/** AniList stores manhwa/manhua as format MANGA + country of origin. */
const FORMAT_TO_AL: Partial<Record<TitleFormat, { format: string; country?: string }>> = {
  manga: { format: "MANGA", country: "JP" },
  manhwa: { format: "MANGA", country: "KR" },
  manhua: { format: "MANGA", country: "CN" },
  one_shot: { format: "ONE_SHOT" },
  novel: { format: "NOVEL" },
};

export function formatFromAniList(format: string | null, country: string | null): TitleFormat | undefined {
  if (!format) return undefined;
  if (format === "ONE_SHOT") return "one_shot";
  if (format === "NOVEL") return "novel";
  if (format !== "MANGA") return "other";
  if (country === "KR") return "manhwa";
  if (country === "CN" || country === "TW" || country === "HK") return "manhua";
  return "manga";
}

function preferredTitle(t: AlMedia["title"]): string {
  return t.english || t.romaji || t.native || "";
}

function toSummary(m: AlMedia): TitleSummary {
  const title = preferredTitle(m.title);
  return {
    ref: `anilist:${m.id}`,
    provider: "anilist",
    providerId: String(m.id),
    title,
    altTitles: uniqueStrings([m.title.english, m.title.romaji, m.title.native, ...(m.synonyms ?? [])]).filter(
      (t) => t !== title,
    ),
    url: m.siteUrl || `https://anilist.co/manga/${m.id}`,
    coverImage: m.coverImage?.extraLarge || m.coverImage?.large || undefined,
    format: formatFromAniList(m.format, m.countryOfOrigin),
    status: m.status ? (STATUS_FROM_AL[m.status] ?? "unknown") : undefined,
    year: m.startDate?.year ?? undefined,
    genres: m.genres ?? [],
    score: m.averageScore ?? undefined,
    adult: Boolean(m.isAdult),
    latestChapter: m.chapters ?? undefined,
  };
}

function toMetadata(m: AlMedia): TitleMetadata {
  const authors: string[] = [];
  const artists: string[] = [];
  for (const e of m.staff?.edges ?? []) {
    const name = e.node?.name?.full;
    const role = (e.role ?? "").toLowerCase();
    if (!name) continue;
    if (role.includes("story")) authors.push(name);
    if (role.includes("art")) artists.push(name);
  }
  return {
    ...toSummary(m),
    titles: {
      english: m.title.english ?? undefined,
      romaji: m.title.romaji ?? undefined,
      native: m.title.native ?? undefined,
    },
    description: plainText(m.description),
    bannerImage: m.bannerImage ?? undefined,
    tags: (m.tags ?? []).map((t) => ({
      name: t.name,
      rank: t.rank ?? undefined,
      spoiler: Boolean(t.isMediaSpoiler),
      group: t.category ?? undefined,
    })),
    authors: uniqueStrings(authors),
    artists: uniqueStrings(artists),
    chapters: m.chapters ?? undefined,
    volumes: m.volumes ?? undefined,
    popularity: m.popularity ?? undefined,
    countryOfOrigin: m.countryOfOrigin ?? undefined,
    externalIds: { anilist: m.id, mal: m.idMal ?? undefined },
    links: [
      { site: "AniList", url: m.siteUrl || `https://anilist.co/manga/${m.id}`, type: "tracking" as const },
      ...(m.idMal ? [{ site: "MyAnimeList", url: `https://myanimelist.net/manga/${m.idMal}`, type: "tracking" as const }] : []),
      ...(m.externalLinks ?? [])
        .filter((l) => l.url && /^https:\/\//i.test(l.url))
        .map((l) => ({
          site: l.site,
          url: l.url!,
          type: (l.type === "STREAMING" ? "official" : l.type === "INFO" ? "info" : "other") as "official" | "info" | "other",
        })),
    ],
    updatedAt: m.updatedAt ? new Date(m.updatedAt * 1000).toISOString() : undefined,
  };
}

async function gql<T>(query: string, variables: Record<string, unknown>, notFound?: string): Promise<T> {
  const body = await metaJson<{ data?: T; errors?: { message: string; status?: number }[] }>(
    "anilist",
    ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    { notFoundMessage: notFound },
  );
  if (!body?.data) {
    const status = body?.errors?.[0]?.status;
    if (status === 404) throw new DawghwaError("NOT_FOUND", notFound ?? "AniList has no matching entry");
    throw new DawghwaError("UPSTREAM_ERROR", "AniList returned no data", { details: { upstreamStatus: status } });
  }
  return body.data;
}

const CAPABILITIES: CatalogCapabilities = {
  filters: ["q", "genres", "excludeGenres", "tags", "status", "format", "year", "sort", "nsfw"],
  sorts: ["relevance", "popularity", "score", "trending", "updated", "newest", "title"],
  formats: ["manga", "manhwa", "manhua", "one_shot", "novel"],
  statuses: ["ongoing", "completed", "hiatus", "cancelled", "upcoming"],
  maxLimit: 50,
  maxDepth: 5_000,
};

export const anilist: MetadataProvider = {
  id: "anilist",
  name: "AniList",
  attribution: {
    name: "AniList",
    url: "https://anilist.co",
    terms: "https://docs.anilist.co/guide/terms-of-use",
  },
  capabilities: CAPABILITIES,

  parseId(raw) {
    const id = raw.trim();
    if (!/^\d{1,9}$/.test(id)) throw new DawghwaError("VALIDATION_ERROR", "AniList ids are numeric");
    return String(Number(id));
  },

  async getTitle(id) {
    const data = await gql<{ Media: AlMedia | null }>(
      `query ($id: Int) { Media(id: $id, type: MANGA) { ${DETAIL_FIELDS} } }`,
      { id: Number(id) },
      `AniList has no manga with id ${id}`,
    );
    if (!data.Media) throw new DawghwaError("NOT_FOUND", `AniList has no manga with id ${id}`);
    return toMetadata(data.Media);
  },

  async browse(q: CatalogQuery): Promise<CatalogPage> {
    const sort = q.sort ?? (q.q ? "relevance" : "popularity");
    if (sort === "relevance" && !q.q) {
      throw new DawghwaError("VALIDATION_ERROR", "sort=relevance requires a search query (q)");
    }
    const fmt = q.format ? FORMAT_TO_AL[q.format] : undefined;
    if (q.format && !fmt) {
      throw new DawghwaError("VALIDATION_ERROR", `AniList does not support format "${q.format}"`, {
        details: { supported: CAPABILITIES.formats },
      });
    }
    if (q.status && !STATUS_TO_AL[q.status]) {
      throw new DawghwaError("VALIDATION_ERROR", `AniList does not support status "${q.status}"`);
    }
    const variables: Record<string, unknown> = {
      page: q.page,
      perPage: q.limit,
      search: q.q || undefined,
      sort: [SORTS[sort]],
      genre_in: q.genres?.length ? q.genres : undefined,
      genre_not_in: q.excludeGenres?.length ? q.excludeGenres : undefined,
      tag_in: q.tags?.length ? q.tags : undefined,
      status: q.status ? STATUS_TO_AL[q.status] : undefined,
      format: fmt?.format,
      country: fmt?.country,
      isAdult: q.nsfw ? undefined : false,
      startFrom: q.year ? q.year * 10_000 : undefined,
      startTo: q.year ? (q.year + 1) * 10_000 : undefined,
    };
    const data = await gql<{
      Page: { pageInfo: { total: number; hasNextPage: boolean }; media: AlMedia[] };
    }>(
      `query ($page: Int, $perPage: Int, $search: String, $sort: [MediaSort], $genre_in: [String],
              $genre_not_in: [String], $tag_in: [String], $status: MediaStatus, $format: MediaFormat,
              $country: CountryCode, $isAdult: Boolean, $startFrom: FuzzyDateInt, $startTo: FuzzyDateInt) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { total hasNextPage }
          media(type: MANGA, search: $search, sort: $sort, genre_in: $genre_in, genre_not_in: $genre_not_in,
                tag_in: $tag_in, status: $status, format: $format, countryOfOrigin: $country,
                isAdult: $isAdult, startDate_greater: $startFrom, startDate_lesser: $startTo) { ${SUMMARY_FIELDS} }
        }
      }`,
      variables,
    );
    return {
      provider: "anilist",
      items: data.Page.media.map(toSummary),
      pageInfo: {
        page: q.page,
        limit: q.limit,
        total: data.Page.pageInfo.total,
        hasNextPage: data.Page.pageInfo.hasNextPage,
      },
    };
  },

  async filterOptions(): Promise<CatalogFilterOptions> {
    const data = await gql<{
      GenreCollection: string[];
      MediaTagCollection: { name: string; category: string | null; isAdult: boolean | null }[];
    }>(`query { GenreCollection MediaTagCollection { name category isAdult } }`, {});
    return {
      provider: "anilist",
      capabilities: CAPABILITIES,
      genres: data.GenreCollection,
      tags: data.MediaTagCollection.map((t) => ({ name: t.name, group: t.category ?? undefined, adult: Boolean(t.isAdult) })),
    };
  },
};
