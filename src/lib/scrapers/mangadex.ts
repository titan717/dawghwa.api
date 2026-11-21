/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseScraper } from "./base";
import { parseMangaDexPageUrl } from "@/lib/services/cover-image";
import {
  BrowseItem,
  BrowseQuery,
  BrowseResult,
  BrowseVocabulary,
  ChapterPage,
  MangaKind,
  MangaMetadata,
  ScrapedChapter,
  SearchResult,
  SourceType,
} from "@/types";
import { DawghwaError } from "@/lib/core/errors";

interface MangaDexRelationship {
  id: string;
  type: string;
  attributes?: Record<string, any>;
}

interface MangaDexTag {
  id: string;
  type?: string;
  attributes: { name: Record<string, string>; group: string };
}

interface MangaDexManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles?: Record<string, string>[];
    description?: Record<string, string>;
    lastChapter?: string | null;
    updatedAt?: string;
    createdAt?: string;
    originalLanguage?: string;
    publicationDemographic?: string | null;
    status?: string;
    year?: number | null;
    contentRating?: string;
    tags?: MangaDexTag[];
    availableTranslatedLanguages?: (string | null)[];
  };
  relationships?: MangaDexRelationship[];
}

interface MangaDexChapter {
  id: string;
  attributes: {
    chapter: string | null;
    volume?: string | null;
    translatedLanguage?: string;
    title: string | null;
    pages: number;
    publishAt: string;
    externalUrl: string | null;
  };
  relationships?: MangaDexRelationship[];
}

interface MangaDexList<T> {
  data: T[];
  total: number;
}

/** MangaDex documents `offset + limit <= 10000` for list endpoints. */
const MAX_WINDOW = 10_000;
const KIND_LANGUAGES: Record<MangaKind, string[]> = {
  manga: ["ja"],
  manhwa: ["ko"],
  manhua: ["zh", "zh-hk"],
  comic: ["en"],
};
const STATUS = ["ongoing", "completed", "hiatus", "cancelled"];
const DEMOGRAPHIC = ["shounen", "shoujo", "seinen", "josei", "none"];
const ORDER_PARAM: Record<string, string> = {
  popular: "order[followedCount]=desc",
  rating: "order[rating]=desc",
  latest: "order[latestUploadedChapter]=desc",
  new: "order[createdAt]=desc",
  relevance: "order[relevance]=desc",
  year: "order[year]=desc",
};

export function kindFromLanguage(lang?: string): MangaKind | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase();
  if (l === "ja" || l === "ja-ro") return "manga";
  if (l === "ko" || l === "ko-ro") return "manhwa";
  if (l === "zh" || l === "zh-hk" || l === "zh-ro") return "manhua";
  return "comic";
}

/** Strip MangaDex's markdown/BBCode-ish decoration down to readable plain text. */
export function plainDescription(raw?: string): string | undefined {
  if (!raw) return undefined;
  const text = raw
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/^-{3,}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}

export class MangaDexScraper extends BaseScraper {
  private tagCache?: { at: number; tags: MangaDexTag[] };

  private readonly BASE_URL = "https://mangadex.org";
  private readonly API_URL = "https://api.mangadex.org";
  private readonly COVER_URL = "https://uploads.mangadex.org/covers";
  private readonly USER_AGENT = "dawghwa-api/1.0 (+https://github.com/titan717/dawghwa.api)";
  private readonly RATINGS =
    "contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica";

  getName(): string {
    return "MangaDex";
  }

  /** MangaDex@Home: only documented data/data-saver paths on MangaDex-owned hosts. */
  override allowPageImage(raw: string | URL | null | undefined): URL | null {
    return raw ? parseMangaDexPageUrl(raw.toString()) : null;
  }

  /** MangaDex asks API clients to identify themselves rather than pose as a browser. */
  pageImageUserAgent(): "identifying" | "browser" {
    return "identifying";
  }

  getBaseUrl(): string {
    return this.BASE_URL;
  }

  canHandle(url: string): boolean {
    return url.includes("mangadex.org");
  }

  getType(): SourceType {
    return "aggregator";
  }

  private formatRelativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    if (diffYears > 0) return `${diffYears}y ago`;
    if (diffMonths > 0) return `${diffMonths}mo ago`;
    if (diffWeeks > 0) return `${diffWeeks}w ago`;
    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    if (diffMins > 0) return `${diffMins}m ago`;
    return "just now";
  }

  private async getJson<T>(path: string): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.http(`${this.API_URL}${path}`, {
        headers: {
          "User-Agent": this.USER_AGENT,
          Accept: "application/json",
        },
      });

      if (response.status === 429 && attempt < 2) {
        await this.delay(1000 * (attempt + 1));
        continue;
      }

      if (response.status === 404) {
        throw new DawghwaError("NOT_FOUND", "MangaDex resource not found");
      }
      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      return (await response.json()) as T;
    }
    throw new Error("API request failed: 429");
  }

  private getMangaId(url: string): string {
    const match = url.match(/\/(?:title|manga)\/([0-9a-f-]{36})/i);
    return match ? match[1] : "";
  }

  private pickTitle(manga: MangaDexManga): string {
    const { title, altTitles } = manga.attributes;
    if (title?.en) return title.en;
    const alt = (altTitles || []).find((t) => t.en);
    if (alt) return alt.en;
    return Object.values(title || {})[0] || "Untitled";
  }

  private parseLast(manga: MangaDexManga): number {
    const last = parseFloat(manga.attributes.lastChapter || "");
    return isNaN(last) ? 0 : last;
  }

  private async getLatestChapter(manga: MangaDexManga): Promise<number> {
    const last = this.parseLast(manga);
    if (last > 0) return last;

    const data = await this.getJson<{
      volumes?: Record<string, { chapters?: Record<string, unknown> }>;
    }>(`/manga/${manga.id}/aggregate?translatedLanguage[]=en`);

    let max = 0;
    for (const volume of Object.values(data.volumes || {})) {
      for (const key of Object.keys(volume.chapters || {})) {
        const n = parseFloat(key);
        if (!isNaN(n) && n > max) max = n;
      }
    }
    return max;
  }

  private coverUrl(manga: MangaDexManga, size: 256 | 512): string | undefined {
    const cover = manga.relationships?.find((r) => r.type === "cover_art");
    const fileName = cover?.attributes?.fileName;
    return fileName ? `${this.COVER_URL}/${manga.id}/${fileName}.${size}.jpg` : undefined;
  }

  /** Map the documented MangaDex manga attributes to Dawghwa's metadata shape. */
  toMetadata(manga: MangaDexManga, stats?: { rating?: number; follows?: number }): MangaMetadata {
    const a = manga.attributes;
    const tagsBy = (group: string) =>
      (a.tags || [])
        .filter((t) => t.attributes?.group === group)
        .map((t) => t.attributes.name?.en)
        .filter((n): n is string => Boolean(n));
    const genres = tagsBy("genre");
    const themes = tagsBy("theme");
    const formats = tagsBy("format");
    const people = (type: string) =>
      (manga.relationships || [])
        .filter((r) => r.type === type)
        .map((r) => r.attributes?.name as string | undefined)
        .filter((n): n is string => Boolean(n));
    const primary = this.pickTitle(manga);
    const altTitles = [
      ...Object.values(a.title || {}),
      ...(a.altTitles || []).flatMap((t) => Object.values(t)),
    ].filter((t, i, all) => t && t !== primary && all.indexOf(t) === i);
    const last = parseFloat(a.lastChapter || "");
    return {
      altTitles,
      description: plainDescription(a.description?.en || Object.values(a.description || {})[0]),
      tags: [...genres, ...themes, ...formats],
      genres,
      themes,
      formats,
      kind: kindFromLanguage(a.originalLanguage),
      longStrip: formats.includes("Long Strip"),
      originalLanguage: a.originalLanguage,
      demographic: a.publicationDemographic || undefined,
      status: a.status,
      year: a.year ?? undefined,
      contentRating: a.contentRating,
      authors: people("author"),
      artists: people("artist"),
      rating: stats?.rating,
      follows: stats?.follows,
      coverImageLarge: this.coverUrl(manga, 512),
      availableLanguages: (a.availableTranslatedLanguages || []).filter((l): l is string => Boolean(l)),
      lastChapter: Number.isFinite(last) && last > 0 ? last : undefined,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  private toResult(manga: MangaDexManga, latestChapter: number, stats?: { rating?: number; follows?: number }): BrowseItem {
    const updated = manga.attributes.updatedAt ? new Date(manga.attributes.updatedAt) : null;
    return {
      id: manga.id,
      title: this.pickTitle(manga),
      url: `${this.BASE_URL}/title/${manga.id}`,
      coverImage: this.coverUrl(manga, 256),
      latestChapter,
      lastUpdated: updated ? this.formatRelativeTime(updated) : "",
      lastUpdatedTimestamp: updated ? updated.getTime() : undefined,
      ...(stats?.rating !== undefined ? { rating: stats.rating } : {}),
      ...(stats?.follows !== undefined ? { followers: String(stats.follows) } : {}),
      metadata: this.toMetadata(manga, stats),
    };
  }

  /** Batched statistics (rating, follows) from GET /statistics/manga. */
  private async statistics(ids: string[]): Promise<Record<string, { rating?: number; follows?: number }>> {
    if (!ids.length) return {};
    const q = ids.map((id) => `manga[]=${id}`).join("&");
    const data = await this.getJson<{
      statistics?: Record<string, { rating?: { bayesian?: number | null; average?: number | null }; follows?: number }>;
    }>(`/statistics/manga?${q}`);
    const out: Record<string, { rating?: number; follows?: number }> = {};
    for (const [id, s] of Object.entries(data.statistics || {})) {
      const rating = s.rating?.bayesian ?? s.rating?.average ?? undefined;
      out[id] = {
        rating: typeof rating === "number" && Number.isFinite(rating) ? Math.round(rating * 100) / 100 : undefined,
        follows: typeof s.follows === "number" ? s.follows : undefined,
      };
    }
    return out;
  }

  private async tags(): Promise<MangaDexTag[]> {
    if (this.tagCache && Date.now() - this.tagCache.at < 24 * 3600 * 1000) return this.tagCache.tags;
    const data = await this.getJson<{ data: MangaDexTag[] }>(`/manga/tag`);
    this.tagCache = { at: Date.now(), tags: data.data || [] };
    return this.tagCache.tags;
  }

  urlForId(id: string): string | undefined {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? `${this.BASE_URL}/title/${id.toLowerCase()}` : undefined;
  }

  async browseVocabulary(): Promise<BrowseVocabulary> {
    const tags = await this.tags();
    return {
      tags: tags
        .map((t) => ({ name: t.attributes.name?.en || "", group: t.attributes.group }))
        .filter((t) => t.name)
        .sort((x, y) => x.group.localeCompare(y.group) || x.name.localeCompare(y.name)),
      kinds: ["manga", "manhwa", "manhua", "comic"],
      status: STATUS,
      demographic: DEMOGRAPHIC,
      orders: ["popular", "rating", "latest", "new", "relevance", "year"],
      maxOffset: MAX_WINDOW,
      maxLimit: 100,
    };
  }

  async browse(query: BrowseQuery): Promise<BrowseResult> {
    const limit = Math.min(100, Math.max(1, query.limit ?? 24));
    const offset = Math.max(0, query.offset ?? 0);
    if (offset + limit > MAX_WINDOW) {
      throw new DawghwaError("VALIDATION_ERROR", `offset + limit must be at most ${MAX_WINDOW} for MangaDex`);
    }
    const params: string[] = [
      `limit=${limit}`,
      `offset=${offset}`,
      "includes[]=cover_art",
      "includes[]=author",
      "includes[]=artist",
      "availableTranslatedLanguage[]=en",
      "hasAvailableChapters=true",
      "contentRating[]=safe",
      "contentRating[]=suggestive",
    ];
    if (query.query) params.push(`title=${encodeURIComponent(query.query)}`);
    const unknownTags: string[] = [];
    if (query.includedTags?.length || query.excludedTags?.length) {
      const all = await this.tags();
      const byName = new Map(all.map((t) => [(t.attributes.name?.en || "").toLowerCase(), t.id]));
      const resolve = (names: string[] | undefined, key: string) => {
        for (const name of names || []) {
          const id = byName.get(name.toLowerCase());
          if (id) params.push(`${key}[]=${id}`);
          else unknownTags.push(name);
        }
      };
      resolve(query.includedTags, "includedTags");
      resolve(query.excludedTags, "excludedTags");
      if (unknownTags.length) {
        // Never return unfiltered results for a filter the caller asked for.
        throw new DawghwaError("VALIDATION_ERROR", `Unknown tag(s): ${unknownTags.join(", ")}. See GET /api/browse?source=mangadex`, {
          details: { unknownTags },
        });
      }
      params.push(`includedTagsMode=${query.includedTagsMode === "or" ? "OR" : "AND"}`, "excludedTagsMode=OR");
    }
    for (const kind of query.kinds || []) for (const lang of KIND_LANGUAGES[kind] || []) params.push(`originalLanguage[]=${lang}`);
    for (const st of query.status || []) if (STATUS.includes(st)) params.push(`status[]=${st}`);
    for (const d of query.demographic || []) if (DEMOGRAPHIC.includes(d)) params.push(`publicationDemographic[]=${d}`);
    if (query.year) params.push(`year=${query.year}`);
    if (query.createdWithinDays) {
      const since = new Date(Date.now() - query.createdWithinDays * 86_400_000).toISOString().slice(0, 19);
      params.push(`createdAtSince=${since}`);
    }
    const order = query.order ?? (query.query ? "relevance" : "popular");
    params.push(order === "relevance" && !query.query ? ORDER_PARAM.popular : ORDER_PARAM[order]);

    const data = await this.getJson<MangaDexList<MangaDexManga> & { offset?: number; limit?: number }>(
      `/manga?${params.join("&")}`,
    );
    const mangas = data.data || [];
    const stats = query.withStats === false ? {} : await this.statistics(mangas.map((m) => m.id)).catch(() => ({}));
    const items = mangas.map((m) => this.toResult(m, this.parseLast(m), (stats as Record<string, { rating?: number; follows?: number }>)[m.id]));
    const total = Math.min(data.total || 0, MAX_WINDOW);
    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + mangas.length < total,
    };
  }

  async search(query: string): Promise<SearchResult[]> {
    try {
      const data = await this.getJson<MangaDexList<MangaDexManga>>(
        `/manga?title=${encodeURIComponent(query)}&limit=20&includes[]=cover_art&includes[]=author&includes[]=artist&availableTranslatedLanguage[]=en&order[relevance]=desc&${this.RATINGS}`,
      );
      const items = data.data || [];

      const latest = await Promise.all(
        items.map((manga, index) =>
          index < 5
            ? this.getLatestChapter(manga).catch(() => 0)
            : Promise.resolve(this.parseLast(manga)),
        ),
      );

      return items.map((manga, index) => this.toResult(manga, latest[index]));
    } catch (error) {
      console.error("[MangaDex] search error:", error);
      throw error;
    }
  }

  async extractMangaInfo(
    url: string,
  ): Promise<{ title: string; id: string; coverImage?: string; metadata?: MangaMetadata }> {
    const id = this.getMangaId(url);

    if (!id) {
      throw new Error("Could not extract manga id from URL");
    }

    const data = await this.getJson<{ data: MangaDexManga }>(
      `/manga/${id}?includes[]=cover_art&includes[]=author&includes[]=artist`,
    );
    const stats = await this.statistics([id]).catch(() => ({}) as Record<string, { rating?: number; follows?: number }>);

    return {
      title: this.pickTitle(data.data),
      id,
      coverImage: this.coverUrl(data.data, 256),
      metadata: this.toMetadata(data.data, stats[id]),
    };
  }

  async getIdentityHints(mangaUrl: string): Promise<{ title: string; altTitles: string[]; authors: string[]; status?: string; year?: number }> {
    const info = await this.extractMangaInfo(mangaUrl);
    return {
      title: info.title,
      altTitles: info.metadata?.altTitles ?? [],
      authors: [...(info.metadata?.authors ?? []), ...(info.metadata?.artists ?? [])],
      status: info.metadata?.status,
      year: info.metadata?.year,
    };
  }

  async getChapterList(mangaUrl: string): Promise<ScrapedChapter[]> {
    try {
      const id = this.getMangaId(mangaUrl);

      if (!id) {
        throw new Error("Could not extract manga id from URL");
      }

      // The first page reports the total, so the remaining pages are fetched
      // in parallel (bounded by the MangaDex provider rate limit) instead of
      // one after another.
      const limit = 500;
      const feedPath = (offset: number) =>
        `/manga/${id}/feed?translatedLanguage[]=en&order[chapter]=asc&limit=${limit}&offset=${offset}&includes[]=scanlation_group&${this.RATINGS}`;
      const first = await this.getJson<MangaDexList<MangaDexChapter>>(feedPath(0));
      const total = first.total || 0;
      const offsets: number[] = [];
      for (let offset = limit; offset < total; offset += limit) offsets.push(offset);
      const rest = await Promise.all(
        offsets.map((offset) => this.getJson<MangaDexList<MangaDexChapter>>(feedPath(offset))),
      );
      const chapters: MangaDexChapter[] = [
        ...(first.data || []),
        ...rest.flatMap((page) => page.data || []),
      ];

      // Keep every scanlation-group upload as its own variant: different
      // groups are different translations, and the unified engine decides
      // what is equivalent. Only exact re-uploads (same number label, same
      // group, same language) are collapsed to the newest one.
      const byVariant = new Map<string, { chapter: ScrapedChapter; published: number }>();

      for (const chapter of chapters) {
        const { externalUrl, pages, publishAt } = chapter.attributes;
        // externalUrl chapters are hosted by an official publisher outside
        // MangaDex and have no MangaDex@Home pages; they are not readable here.
        if (externalUrl || pages === 0) continue;
        const label = chapter.attributes.chapter?.trim() || null;
        const parsed = parseFloat(label || "");
        const number = Number.isFinite(parsed) ? parsed : 0;
        const published = new Date(publishAt).getTime() || 0;
        const groupRel = chapter.relationships?.find((r) => r.type === "scanlation_group");
        const groupName = groupRel?.attributes?.name;
        const language = chapter.attributes.translatedLanguage || "en";
        const key = `${label ?? `id:${chapter.id}`}|${groupRel?.id ?? "-"}|${language}`;
        const existing = byVariant.get(key);
        if (existing && existing.published >= published) continue;

        byVariant.set(key, {
          published,
          chapter: {
            id: chapter.id,
            number,
            chapterLabel: label,
            numberSource: "provider",
            title: chapter.attributes.title || undefined,
            url: `${this.BASE_URL}/chapter/${chapter.id}`,
            lastUpdated: published ? this.formatRelativeTime(new Date(published)) : undefined,
            publishedAt: published ? new Date(published).toISOString() : undefined,
            volume: chapter.attributes.volume || undefined,
            language,
            pages,
            group:
              groupRel && groupName
                ? { id: groupRel.id, name: groupName, url: `${this.BASE_URL}/group/${groupRel.id}` }
                : undefined,
          },
        });
      }

      return Array.from(byVariant.values())
        .map((entry) => entry.chapter)
        .sort((a, b) => a.number - b.number || (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""))
        .map((chapter, index) => ({ ...chapter, sequence: index + 1 }));
    } catch (error) {
      console.error("[MangaDex] chapter list error:", error);
      throw error;
    }
  }

  /**
   * Chapter pages via the official MangaDex@Home API
   * (https://api.mangadex.org/docs/04-chapter/retrieving-chapter/).
   * Returned URLs point at MangaDex@Home servers and expire after ~15 minutes.
   * forcePort443 keeps image hosts on standard HTTPS so the restricted relay can
   * apply DNS/private-address checks without opening arbitrary ports.
   */
  async getChapterPages(
    chapter: { chapterId?: string; url?: string },
    options: { dataSaver?: boolean } = {},
  ): Promise<ChapterPage[]> {
    const id =
      chapter.chapterId ||
      (chapter.url ? chapter.url.match(/\/chapter\/([0-9a-f-]{36})/i)?.[1] : undefined);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new DawghwaError("VALIDATION_ERROR", "A MangaDex chapter UUID (or /chapter/<uuid> URL) is required");
    }
    const data = await this.getJson<{
      result: string;
      baseUrl: string;
      chapter: { hash: string; data: string[]; dataSaver: string[] };
    }>(`/at-home/server/${id}?forcePort443=true`);
    if (!data.baseUrl || !data.chapter?.hash) {
      throw new DawghwaError("UPSTREAM_ERROR", "MangaDex returned no page data for this chapter");
    }
    const quality = options.dataSaver ? "data-saver" : "data";
    const files = options.dataSaver ? data.chapter.dataSaver : data.chapter.data;
    return (files || []).map((file, index) => ({
      index,
      url: `${data.baseUrl}/${quality}/${data.chapter.hash}/${file}`,
    }));
  }
}
