import { cacheKey, getCache } from "@/lib/core/cache";
import { DawghwaError } from "@/lib/core/errors";
import { metaJson, uniqueStrings } from "./client";
import type {
  CatalogCapabilities,
  CatalogFilterOptions,
  CatalogPage,
  CatalogQuery,
  CatalogSort,
  MetadataProvider,
  TitleFormat,
  TitleLink,
  TitleMetadata,
  TitleStatus,
  TitleSummary,
} from "./types";

/**
 * MangaDex REST API (https://api.mangadex.org/docs/). Public; the acceptable
 * usage policy requires crediting MangaDex and scanlation groups and not
 * running ads or paid services on top of it.
 */
const API = "https://api.mangadex.org";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MdRel {
  id: string;
  type: string;
  attributes?: { name?: string; fileName?: string } | null;
}

interface MdManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles: Record<string, string>[];
    description: Record<string, string>;
    links: Record<string, string> | null;
    originalLanguage: string;
    lastVolume: string | null;
    lastChapter: string | null;
    status: string | null;
    year: number | null;
    contentRating: string;
    publicationDemographic?: string | null;
    tags: { id: string; attributes: { name: Record<string, string>; group: string } }[];
    updatedAt: string;
  };
  relationships: MdRel[];
}

interface MdTag {
  id: string;
  attributes: { name: Record<string, string>; group: string };
}

const SORTS: Partial<Record<CatalogSort, [string, "asc" | "desc"]>> = {
  relevance: ["relevance", "desc"],
  popularity: ["followedCount", "desc"],
  score: ["rating", "desc"],
  updated: ["latestUploadedChapter", "desc"],
  newest: ["createdAt", "desc"],
  title: ["title", "asc"],
};

const LANGS: Partial<Record<TitleFormat, string[]>> = {
  manga: ["ja"],
  manhwa: ["ko"],
  manhua: ["zh", "zh-hk"],
  oel: ["en"],
};

const STATUSES: readonly TitleStatus[] = ["ongoing", "completed", "hiatus", "cancelled"];

export function formatFromMangaDex(lang: string, tagNames: string[]): TitleFormat {
  if (tagNames.some((t) => t.toLowerCase() === "oneshot")) return "one_shot";
  if (tagNames.some((t) => t.toLowerCase() === "doujinshi")) return "doujinshi";
  if (lang === "ko") return "manhwa";
  if (lang === "zh" || lang === "zh-hk") return "manhua";
  if (lang === "ja") return "manga";
  if (lang === "en") return "oel";
  return "other";
}

function pick(map: Record<string, string> | undefined, langs: string[]): string | undefined {
  if (!map) return undefined;
  for (const l of langs) if (map[l]) return map[l];
  return Object.values(map)[0];
}

/** Like pick() but without the any-language fallback. */
function pickExact(map: Record<string, string> | undefined, langs: string[]): string | undefined {
  if (!map) return undefined;
  for (const l of langs) if (map[l]) return map[l];
  return undefined;
}

function coverUrl(m: MdManga): string | undefined {
  const file = m.relationships.find((r) => r.type === "cover_art")?.attributes?.fileName;
  return file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.512.jpg` : undefined;
}

function toSummary(m: MdManga): TitleSummary {
  const a = m.attributes;
  const english = pickExact(a.title, ["en"]) ?? a.altTitles.map((t) => t.en).find(Boolean);
  const title = english ?? pick(a.title, [`${a.originalLanguage}-ro`, a.originalLanguage]) ?? "";
  const tagNames = a.tags.map((t) => t.attributes.name.en ?? "");
  const chapter = Number(a.lastChapter);
  return {
    ref: `mangadex:${m.id}`,
    provider: "mangadex",
    providerId: m.id,
    title,
    altTitles: uniqueStrings([...Object.values(a.title), ...a.altTitles.flatMap((t) => Object.values(t))]).filter(
      (t) => t !== title,
    ),
    url: `https://mangadex.org/title/${m.id}`,
    coverImage: coverUrl(m),
    format: formatFromMangaDex(a.originalLanguage, tagNames),
    status: a.status && (STATUSES as string[]).includes(a.status) ? (a.status as TitleStatus) : "unknown",
    year: a.year ?? undefined,
    genres: a.tags.filter((t) => t.attributes.group === "genre").map((t) => t.attributes.name.en).filter(Boolean),
    adult: a.contentRating === "erotica" || a.contentRating === "pornographic",
    latestChapter: Number.isFinite(chapter) && chapter > 0 ? chapter : undefined,
    // MangaDex returns these in the list response anyway; passing them on lets
    // clients rank and filter a page without one detail request per title.
    description: pick(a.description, ["en"])?.trim() || undefined,
    tagNames: tagNames.filter(Boolean),
    demographic: a.publicationDemographic ?? undefined,
  };
}

/** MangaDex `links` keys (documented in the Manga model). */
const LINK_SITES: Record<string, { site: string; url: (v: string) => string; type: TitleLink["type"] }> = {
  al: { site: "AniList", url: (v) => `https://anilist.co/manga/${v}`, type: "tracking" },
  mu: { site: "MangaUpdates", url: (v) => (/^\d+$/.test(v) ? `https://www.mangaupdates.com/series.html?id=${v}` : `https://www.mangaupdates.com/series/${v}`), type: "tracking" },
  mal: { site: "MyAnimeList", url: (v) => `https://myanimelist.net/manga/${v}`, type: "tracking" },
  kt: { site: "Kitsu", url: (v) => `https://kitsu.app/manga/${v}`, type: "tracking" },
  ap: { site: "Anime-Planet", url: (v) => `https://www.anime-planet.com/manga/${v}`, type: "tracking" },
  bw: { site: "BookWalker", url: (v) => `https://bookwalker.jp/${v}`, type: "official" },
  amz: { site: "Amazon", url: (v) => v, type: "official" },
  ebj: { site: "eBookJapan", url: (v) => v, type: "official" },
  cdj: { site: "CDJapan", url: (v) => v, type: "official" },
  raw: { site: "Raw", url: (v) => v, type: "raw" },
  engtl: { site: "Official English", url: (v) => v, type: "official" },
};

/** MangaDex stores new-style MangaUpdates ids as base36 slugs; convert to the numeric series id. */
export function muSlugToId(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (/^\d+$/.test(v) && v.length < 7) return undefined; // legacy numeric ids are not series_id
  if (!/^[0-9a-z]{4,12}$/.test(v)) return undefined;
  let n = BigInt(0);
  for (const ch of v) n = n * BigInt(36) + BigInt(parseInt(ch, 36));
  return n.toString();
}

function toMetadata(m: MdManga): TitleMetadata {
  const a = m.attributes;
  const s = toSummary(m);
  const links: TitleLink[] = [{ site: "MangaDex", url: s.url, type: "tracking" }];
  for (const [k, v] of Object.entries(a.links ?? {})) {
    const def = LINK_SITES[k];
    if (!def || !v) continue;
    const url = def.url(v);
    if (/^https:\/\//i.test(url)) links.push({ site: def.site, url, type: def.type });
  }
  const al = Number(a.links?.al);
  const mal = Number(a.links?.mal);
  return {
    ...s,
    titles: {
      english: pickExact(a.title, ["en"]) ?? a.altTitles.map((t) => t.en).find(Boolean),
      romaji: pickExact(a.title, [`${a.originalLanguage}-ro`]) ?? a.altTitles.map((t) => t[`${a.originalLanguage}-ro`]).find(Boolean),
      native: a.title[a.originalLanguage] ?? a.altTitles.map((t) => t[a.originalLanguage]).find(Boolean),
    },
    description: pick(a.description, ["en"])?.trim() || undefined,
    tags: a.tags
      .filter((t) => t.attributes.group !== "genre")
      .map((t) => ({ name: t.attributes.name.en, group: t.attributes.group }))
      .filter((t) => t.name),
    authors: uniqueStrings(m.relationships.filter((r) => r.type === "author").map((r) => r.attributes?.name)),
    artists: uniqueStrings(m.relationships.filter((r) => r.type === "artist").map((r) => r.attributes?.name)),
    chapters: s.latestChapter,
    volumes: Number(a.lastVolume) > 0 ? Number(a.lastVolume) : undefined,
    originalLanguage: a.originalLanguage,
    externalIds: {
      mangadex: m.id,
      anilist: Number.isInteger(al) && al > 0 ? al : undefined,
      mal: Number.isInteger(mal) && mal > 0 ? mal : undefined,
      mangaupdates: a.links?.mu ? muSlugToId(a.links.mu) : undefined,
    },
    links,
    updatedAt: a.updatedAt,
  };
}

const CAPABILITIES: CatalogCapabilities = {
  filters: [
    "q",
    "genres",
    "excludeGenres",
    "tags",
    "status",
    "format",
    "statuses",
    "formats",
    "demographics",
    "genreMode",
    "excludeMode",
    "year",
    "sort",
    "nsfw",
  ],
  sorts: ["relevance", "popularity", "score", "updated", "newest", "title"],
  formats: ["manga", "manhwa", "manhua", "one_shot", "oel", "doujinshi"],
  statuses: ["ongoing", "completed", "hiatus", "cancelled"],
  demographics: ["shounen", "shoujo", "seinen", "josei", "none"],
  maxLimit: 100,
  maxDepth: 10_000,
};

async function tagList(): Promise<MdTag[]> {
  const out = await getCache().wrap(cacheKey("meta", "mangadex", "tags"), { ttl: 86_400, swr: 604_800 }, async () => {
    const body = await metaJson<{ data: MdTag[] }>("mangadex", `${API}/manga/tag`);
    return body.data;
  });
  return out.value;
}

async function tagIds(names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const tags = await tagList();
  const byName = new Map(tags.map((t) => [(t.attributes.name.en ?? "").toLowerCase(), t.id]));
  const unknown = names.filter((n) => !byName.has(n.toLowerCase()));
  if (unknown.length) {
    throw new DawghwaError("VALIDATION_ERROR", `Unknown MangaDex tag(s): ${unknown.join(", ")}`, {
      details: { unknown, hint: "GET /api/catalog/filters?provider=mangadex lists valid names" },
    });
  }
  return names.map((n) => byName.get(n.toLowerCase())!);
}

export const mangadexMeta: MetadataProvider = {
  id: "mangadex",
  name: "MangaDex",
  attribution: {
    name: "MangaDex",
    url: "https://mangadex.org",
    terms: "https://api.mangadex.org/docs/#acceptable-usage-policy",
  },
  capabilities: CAPABILITIES,

  parseId(raw) {
    const id = raw.trim().toLowerCase();
    if (!UUID.test(id)) throw new DawghwaError("VALIDATION_ERROR", "MangaDex ids are UUIDs");
    return id;
  },

  async getTitle(id) {
    const body = await metaJson<{ data: MdManga }>(
      "mangadex",
      `${API}/manga/${id}?includes[]=cover_art&includes[]=author&includes[]=artist`,
      {},
      { notFoundMessage: `MangaDex has no manga with id ${id}` },
    );
    return toMetadata(body.data);
  },

  async browse(q: CatalogQuery): Promise<CatalogPage> {
    const sort = q.sort ?? (q.q ? "relevance" : "popularity");
    const order = SORTS[sort];
    if (!order) {
      throw new DawghwaError("VALIDATION_ERROR", `MangaDex does not support sort "${sort}"`, {
        details: { supported: CAPABILITIES.sorts },
      });
    }
    const formats = q.formats?.length ? q.formats : q.format ? [q.format] : [];
    const statuses = q.statuses?.length ? q.statuses : q.status ? [q.status] : [];
    const badFormat = formats.filter((f) => !CAPABILITIES.formats.includes(f));
    if (badFormat.length) {
      throw new DawghwaError("VALIDATION_ERROR", `MangaDex does not support format "${badFormat.join(", ")}"`, {
        details: { supported: CAPABILITIES.formats },
      });
    }
    const badStatus = statuses.filter((st) => !CAPABILITIES.statuses.includes(st));
    if (badStatus.length) {
      throw new DawghwaError("VALIDATION_ERROR", `MangaDex does not support status "${badStatus.join(", ")}"`, {
        details: { supported: CAPABILITIES.statuses },
      });
    }
    // Language formats (manga/manhwa/manhua/oel) map to originalLanguage[], which
    // MangaDex ORs. One-shot and doujinshi are tags, which combine with the
    // language filter and the genre filter by genreMode, so they cannot be
    // OR-ed with other formats or used with genreMode=or without changing the
    // meaning of the query. Refuse instead of returning a different result set.
    const tagFormats = formats.filter((f) => f === "one_shot" || f === "doujinshi");
    if (tagFormats.length && formats.length > 1) {
      throw new DawghwaError("VALIDATION_ERROR", "MangaDex cannot combine one-shot or doujinshi with other formats", {
        details: { formats },
      });
    }
    if (tagFormats.length && q.genreMode === "or" && (q.genres?.length || q.tags?.length)) {
      throw new DawghwaError("VALIDATION_ERROR", "MangaDex cannot apply a one-shot/doujinshi format with genreMode=or", {
        details: { formats },
      });
    }
    const offset = (q.page - 1) * q.limit;
    if (offset + q.limit > CAPABILITIES.maxDepth!) {
      throw new DawghwaError("VALIDATION_ERROR", `MangaDex only allows browsing the first ${CAPABILITIES.maxDepth} results`);
    }
    const params = new URLSearchParams();
    if (q.q) params.set("title", q.q);
    params.set("limit", String(q.limit));
    params.set("offset", String(offset));
    params.set(`order[${order[0]}]`, order[1]);
    for (const inc of ["cover_art"]) params.append("includes[]", inc);
    const included = [...(q.genres ?? []), ...(q.tags ?? [])];
    if (formats.includes("one_shot")) included.push("Oneshot");
    if (formats.includes("doujinshi")) included.push("Doujinshi");
    for (const id of await tagIds(included)) params.append("includedTags[]", id);
    const excluded = q.excludeGenres ?? [];
    for (const id of await tagIds(excluded)) params.append("excludedTags[]", id);
    if (included.length) params.set("includedTagsMode", q.genreMode === "or" ? "OR" : "AND");
    if (excluded.length) params.set("excludedTagsMode", q.excludeMode === "and" ? "AND" : "OR");
    for (const st of statuses) params.append("status[]", st);
    for (const l of new Set(formats.flatMap((f) => LANGS[f] ?? []))) params.append("originalLanguage[]", l);
    for (const d of q.demographics ?? []) params.append("publicationDemographic[]", d);
    if (q.year) params.set("year", String(q.year));
    for (const r of q.nsfw ? ["safe", "suggestive", "erotica", "pornographic"] : ["safe", "suggestive"]) {
      params.append("contentRating[]", r);
    }
    const body = await metaJson<{ data: MdManga[]; total: number; limit: number; offset: number }>(
      "mangadex",
      `${API}/manga?${params.toString()}`,
    );
    return {
      provider: "mangadex",
      items: body.data.map(toSummary),
      pageInfo: {
        page: q.page,
        limit: q.limit,
        total: body.total,
        hasNextPage: offset + body.data.length < Math.min(body.total, CAPABILITIES.maxDepth!),
      },
    };
  },

  async filterOptions(): Promise<CatalogFilterOptions> {
    const tags = await tagList();
    const named = tags.map((t) => ({ name: t.attributes.name.en, group: t.attributes.group })).filter((t) => t.name);
    return {
      provider: "mangadex",
      capabilities: CAPABILITIES,
      genres: named.filter((t) => t.group === "genre").map((t) => t.name).sort(),
      tags: named.filter((t) => t.group !== "genre").sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
};

export interface MangaDexLink {
  id: string;
  externalIds: TitleMetadata["externalIds"];
  links: TitleLink[];
}

/**
 * Find the MangaDex entry that links to an AniList or MangaUpdates id. MangaDex
 * stores tracker ids in `links` (al, mu, mal), which makes this an exact
 * cross-reference rather than a fuzzy title guess.
 */
export async function findMangaDexByLink(
  key: "al" | "mu",
  value: string,
  titles: string[],
): Promise<MangaDexLink | undefined> {
  const matches = (m: MdManga) => {
    const v = m.attributes.links?.[key];
    if (!v) return false;
    return key === "mu" ? muSlugToId(v) === value || v === value : v === value;
  };
  for (const title of uniqueStrings(titles).slice(0, 2)) {
    const params = new URLSearchParams({ title, limit: "10" });
    for (const r of ["safe", "suggestive", "erotica", "pornographic"]) params.append("contentRating[]", r);
    const body = await metaJson<{ data: MdManga[] }>("mangadex", `${API}/manga?${params.toString()}`);
    const hit = body.data.find(matches);
    if (hit) {
      const md = toMetadata({ ...hit, relationships: hit.relationships ?? [] });
      return { id: hit.id, externalIds: md.externalIds, links: md.links };
    }
  }
  return undefined;
}
