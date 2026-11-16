/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseScraper } from "./base";
import { ChapterPage, ScrapedChapter, SearchResult, SourceType } from "@/types";
import { DawghwaError } from "@/lib/core/errors";

interface MangaDexRelationship {
  id: string;
  type: string;
  attributes?: Record<string, any>;
}

interface MangaDexManga {
  id: string;
  attributes: {
    title: Record<string, string>;
    altTitles?: Record<string, string>[];
    lastChapter?: string | null;
    updatedAt?: string;
  };
  relationships?: MangaDexRelationship[];
}

interface MangaDexChapter {
  id: string;
  attributes: {
    chapter: string | null;
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

export class MangaDexScraper extends BaseScraper {
  private readonly BASE_URL = "https://mangadex.org";
  private readonly API_URL = "https://api.mangadex.org";
  private readonly COVER_URL = "https://uploads.mangadex.org/covers";
  private readonly USER_AGENT = "dawghwa-api/1.0 (+https://github.com/titan717/dawghwa.api)";
  private readonly RATINGS =
    "contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica";

  getName(): string {
    return "MangaDex";
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

  async search(query: string): Promise<SearchResult[]> {
    try {
      const data = await this.getJson<MangaDexList<MangaDexManga>>(
        `/manga?title=${encodeURIComponent(query)}&limit=20&includes[]=cover_art&availableTranslatedLanguage[]=en&order[relevance]=desc&${this.RATINGS}`,
      );
      const items = data.data || [];

      const latest = await Promise.all(
        items.map((manga, index) =>
          index < 5
            ? this.getLatestChapter(manga).catch(() => 0)
            : Promise.resolve(this.parseLast(manga)),
        ),
      );

      return items.map((manga, index) => {
        const cover = manga.relationships?.find((r) => r.type === "cover_art");
        const fileName = cover?.attributes?.fileName;
        const updated = manga.attributes.updatedAt
          ? new Date(manga.attributes.updatedAt)
          : null;

        return {
          id: manga.id,
          title: this.pickTitle(manga),
          url: `${this.BASE_URL}/title/${manga.id}`,
          coverImage: fileName
            ? `${this.COVER_URL}/${manga.id}/${fileName}.256.jpg`
            : undefined,
          latestChapter: latest[index],
          lastUpdated: updated ? this.formatRelativeTime(updated) : "",
          lastUpdatedTimestamp: updated ? updated.getTime() : undefined,
        };
      });
    } catch (error) {
      console.error("[MangaDex] search error:", error);
      throw error;
    }
  }

  async extractMangaInfo(url: string): Promise<{ title: string; id: string }> {
    const id = this.getMangaId(url);

    if (!id) {
      throw new Error("Could not extract manga id from URL");
    }

    const data = await this.getJson<{ data: MangaDexManga }>(`/manga/${id}`);

    return { title: this.pickTitle(data.data), id };
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

      const byNumber = new Map<
        number,
        { chapter: ScrapedChapter; published: number }
      >();

      for (const chapter of chapters) {
        const { externalUrl, pages, publishAt } = chapter.attributes;
        const number = parseFloat(chapter.attributes.chapter || "");

        if (externalUrl || pages === 0 || isNaN(number)) {
          continue;
        }

        const published = new Date(publishAt).getTime() || 0;
        const existing = byNumber.get(number);

        if (existing && existing.published >= published) {
          continue;
        }

        const groupRel = chapter.relationships?.find(
          (r) => r.type === "scanlation_group",
        );
        const groupName = groupRel?.attributes?.name;

        byNumber.set(number, {
          published,
          chapter: {
            id: chapter.id,
            number,
            title: chapter.attributes.title || undefined,
            url: `${this.BASE_URL}/chapter/${chapter.id}`,
            lastUpdated: published
              ? this.formatRelativeTime(new Date(published))
              : undefined,
            group:
              groupRel && groupName
                ? {
                    id: groupRel.id,
                    name: groupName,
                    url: `${this.BASE_URL}/group/${groupRel.id}`,
                  }
                : undefined,
          },
        });
      }

      return Array.from(byNumber.values())
        .map((entry) => entry.chapter)
        .sort((a, b) => a.number - b.number);
    } catch (error) {
      console.error("[MangaDex] chapter list error:", error);
      throw error;
    }
  }

  /**
   * Chapter pages via the official MangaDex@Home API
   * (https://api.mangadex.org/docs/04-chapter/retrieving-chapter/).
   * Returned URLs point at MangaDex@Home servers and expire after ~15 minutes;
   * Dawghwa never proxies or re-hosts the images.
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
    }>(`/at-home/server/${id}`);
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
