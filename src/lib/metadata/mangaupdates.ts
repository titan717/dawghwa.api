import { cacheKey, getCache } from "@/lib/core/cache";
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
 * MangaUpdates public API v1 (https://api.mangaupdates.com). Reads need no
 * account. Acceptable use: credit MangaUpdates, space requests reasonably and
 * cache responses.
 */
const API = "https://api.mangaupdates.com/v1";

/** Genres MangaUpdates uses for explicit content; excluded unless nsfw=true. */
export const MU_ADULT_GENRES = ["Adult", "Hentai", "Smut", "Lolicon", "Shotacon"];

interface MuImage {
  url?: { original?: string | null; thumb?: string | null } | null;
}

interface MuRecord {
  series_id: number;
  title: string;
  url: string;
  description?: string | null;
  image?: MuImage | null;
  type?: string | null;
  year?: string | null;
  bayesian_rating?: number | null;
  genres?: { genre: string }[] | null;
  latest_chapter?: number | null;
  status?: string | null;
  completed?: boolean | null;
  associated?: { title: string }[] | null;
  categories?: { category: string; votes?: number }[] | null;
  authors?: { name: string; type: string }[] | null;
  last_updated?: { timestamp?: number } | null;
}

const TYPE_TO_FORMAT: Record<string, TitleFormat> = {
  manga: "manga",
  manhwa: "manhwa",
  manhua: "manhua",
  novel: "novel",
  doujinshi: "doujinshi",
  oel: "oel",
};

const FORMAT_TO_TYPE: Partial<Record<TitleFormat, string>> = {
  manga: "Manga",
  manhwa: "Manhwa",
  manhua: "Manhua",
  novel: "Novel",
  doujinshi: "Doujinshi",
  oel: "OEL",
};

const SORTS: Partial<Record<CatalogSort, string>> = {
  // MangaUpdates orders by search score when a query is given.
  relevance: "score",
  popularity: "list_reading",
  score: "rating",
  trending: "week_pos",
  newest: "date_added",
  title: "title",
};

export function muStatus(rec: Pick<MuRecord, "status" | "completed">): TitleStatus {
  const text = (rec.status ?? "").toLowerCase();
  if (/cancel|discontinu|axed/.test(text)) return "cancelled";
  if (/hiatus/.test(text)) return "hiatus";
  if (rec.completed || /\(complete\)/.test(text)) return "completed";
  if (/ongoing/.test(text)) return "ongoing";
  return rec.completed === false ? "ongoing" : "unknown";
}

function toSummary(r: MuRecord, withStatus = false): TitleSummary {
  const genres = (r.genres ?? []).map((g) => g.genre);
  const year = Number(r.year);
  return {
    ref: `mangaupdates:${r.series_id}`,
    provider: "mangaupdates",
    providerId: String(r.series_id),
    title: plainText(r.title) ?? r.title,
    altTitles: uniqueStrings((r.associated ?? []).map((a) => a.title)).filter((t) => t !== r.title),
    url: r.url,
    coverImage: r.image?.url?.original ?? undefined,
    format: r.type ? (TYPE_TO_FORMAT[r.type.toLowerCase()] ?? "other") : undefined,
    status: withStatus ? muStatus(r) : undefined,
    year: Number.isInteger(year) && year > 0 ? year : undefined,
    genres,
    score: typeof r.bayesian_rating === "number" ? Math.round(r.bayesian_rating * 10) : undefined,
    adult: genres.some((g) => MU_ADULT_GENRES.includes(g)),
    latestChapter: r.latest_chapter || undefined,
    externalIds: { mangaupdates: String(r.series_id) },
  };
}

function toMetadata(r: MuRecord): TitleMetadata {
  const s = toSummary(r, true);
  return {
    ...s,
    titles: { english: s.title },
    description: plainText(r.description),
    tags: (r.categories ?? [])
      .slice()
      .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0))
      .slice(0, 40)
      .map((c) => ({ name: c.category })),
    authors: uniqueStrings((r.authors ?? []).filter((a) => a.type === "Author").map((a) => a.name)),
    artists: uniqueStrings((r.authors ?? []).filter((a) => a.type === "Artist").map((a) => a.name)),
    chapters: s.status === "completed" ? s.latestChapter : undefined,
    externalIds: { mangaupdates: String(r.series_id) },
    links: [{ site: "MangaUpdates", url: r.url, type: "tracking" }],
    updatedAt: r.last_updated?.timestamp ? new Date(r.last_updated.timestamp * 1000).toISOString() : undefined,
  };
}

const CAPABILITIES: CatalogCapabilities = {
  filters: ["q", "genres", "excludeGenres", "tags", "format", "year", "sort", "nsfw"],
  sorts: ["relevance", "popularity", "score", "trending", "newest", "title"],
  formats: ["manga", "manhwa", "manhua", "novel", "doujinshi", "oel"],
  statuses: [],
  signals: {
    readership: { sort: "popularity", basis: "Number of MangaUpdates users with the title on their reading list (list_reading)" },
    trending: { sort: "trending", basis: "MangaUpdates weekly rank position (week_pos)" },
  },
  maxLimit: 100,
};

export const mangaupdates: MetadataProvider = {
  id: "mangaupdates",
  name: "MangaUpdates",
  attribution: {
    name: "MangaUpdates",
    url: "https://www.mangaupdates.com",
    terms: "https://api.mangaupdates.com/#section/Acceptable-Use-Policy",
  },
  capabilities: CAPABILITIES,

  parseId(raw) {
    const id = raw.trim().toLowerCase();
    if (/^\d{6,20}$/.test(id)) return String(BigInt(id));
    // Short slug from mangaupdates.com/series/<slug>/... (base36 of the id).
    if (/^[0-9a-z]{4,12}$/.test(id) && /[a-z]/.test(id)) {
      let n = BigInt(0);
      for (const ch of id) n = n * BigInt(36) + BigInt(parseInt(ch, 36));
      return n.toString();
    }
    throw new DawghwaError("VALIDATION_ERROR", "MangaUpdates ids are numeric series ids or URL slugs");
  },

  async getTitle(id) {
    const r = await metaJson<MuRecord>("mangaupdates", `${API}/series/${id}`, {}, {
      notFoundMessage: `MangaUpdates has no series with id ${id}`,
    });
    if (!r?.series_id) throw new DawghwaError("NOT_FOUND", `MangaUpdates has no series with id ${id}`);
    return toMetadata(r);
  },

  async browse(q: CatalogQuery): Promise<CatalogPage> {
    if (q.status) {
      throw new DawghwaError("VALIDATION_ERROR", "MangaUpdates does not support filtering by status");
    }
    const sort = q.sort ?? (q.q ? "relevance" : "popularity");
    const orderby = SORTS[sort];
    if (!orderby) {
      throw new DawghwaError("VALIDATION_ERROR", `MangaUpdates does not support sort "${sort}"`, {
        details: { supported: CAPABILITIES.sorts },
      });
    }
    if (q.format && !FORMAT_TO_TYPE[q.format]) {
      throw new DawghwaError("VALIDATION_ERROR", `MangaUpdates does not support format "${q.format}"`, {
        details: { supported: CAPABILITIES.formats },
      });
    }
    const exclude = uniqueStrings([...(q.excludeGenres ?? []), ...(q.nsfw ? [] : MU_ADULT_GENRES)]);
    const body: Record<string, unknown> = {
      page: q.page,
      perpage: q.limit,
      orderby,
    };
    if (q.q) body.search = q.q;
    if (q.genres?.length) body.genre = q.genres;
    if (exclude.length) body.exclude_genre = exclude;
    if (q.tags?.length) body.category = q.tags;
    if (q.format) body.type = [FORMAT_TO_TYPE[q.format]];
    else body.filter_types = ["Novel", "Drama CD", "Artbook"];
    if (q.year) body.year = String(q.year);
    const res = await metaJson<{ total_hits: number; results: { record: MuRecord }[] }>(
      "mangaupdates",
      `${API}/series/search`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const items = (res.results ?? []).map((r) => toSummary(r.record));
    return {
      provider: "mangaupdates",
      items,
      pageInfo: {
        page: q.page,
        limit: q.limit,
        total: res.total_hits,
        hasNextPage: q.page * q.limit < (res.total_hits ?? 0),
      },
    };
  },

  async filterOptions(): Promise<CatalogFilterOptions> {
    const out = await getCache().wrap(cacheKey("meta", "mangaupdates", "genres"), { ttl: 86_400, swr: 604_800 }, () =>
      metaJson<{ genre: string }[]>("mangaupdates", `${API}/genres`),
    );
    return {
      provider: "mangaupdates",
      capabilities: CAPABILITIES,
      genres: out.value.map((g) => g.genre),
      // MangaUpdates has ~2,000 user-voted categories; any category name is accepted as a tag filter.
      tags: [],
    };
  },
};
