import * as cheerio from "cheerio";
import { BaseScraper } from "./base";
import { ChapterPage, ScrapedChapter, SearchResult, SourceType } from "@/types";

interface DynastyTag {
  type: string;
  name: string;
  permalink: string;
}

interface DynastyTagging {
  header?: string;
  title?: string;
  permalink?: string;
  released_on?: string | null;
  tags?: DynastyTag[];
}

interface DynastySeries {
  name: string;
  permalink: string;
  cover?: string | null;
  taggings?: DynastyTagging[];
}

export class DynastyScansScraper extends BaseScraper {
  private readonly BASE_URL = "https://dynasty-scans.com";

  getName(): string {
    return "Dynasty Reader";
  }

  getBaseUrl(): string {
    return this.BASE_URL;
  }

  canHandle(url: string): boolean {
    return url.includes("dynasty-scans.com");
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

  private async getSeriesJson(slug: string): Promise<DynastySeries> {
    const response = await this.http(`${this.BASE_URL}/series/${slug}.json`, {
      headers: {
        "User-Agent": this.config.userAgent,
        Accept: "application/json, text/plain, */*",
        Referer: `${this.BASE_URL}/`,
      },
    });

    if (!response.ok) {
      throw new Error(`Series request failed: ${response.status}`);
    }

    return (await response.json()) as DynastySeries;
  }

  private getSlug(url: string): string {
    const match = url.match(/\/series\/([^/?#.]+)/);
    return match ? match[1] : "";
  }

  private parseNumber(title: string): number | null {
    const match = title.match(/^(?:chapter|ch\.?)\s*(\d+(?:\.\d+)?)/i);
    return match ? parseFloat(match[1]) : null;
  }

  private parseChapters(
    series: DynastySeries,
  ): (ScrapedChapter & { duplicate: boolean; released: number })[] {
    const entries = (series.taggings || []).filter(
      (t) => !t.header && t.permalink && t.title,
    );
    const numbered = entries.some((t) => this.parseNumber(t.title!) !== null);

    return entries.flatMap((entry, index) => {
      const parsed = this.parseNumber(entry.title!);
      if (numbered && parsed === null) {
        return [];
      }

      const number = numbered ? (parsed as number) : index + 1;
      const released = entry.released_on
        ? new Date(entry.released_on).getTime()
        : 0;
      const scanlator = (entry.tags || []).find((t) => t.type === "Scanlator");
      const subtitle = entry.title!.match(/^[^:]*:\s*(.+)$/);

      return [
        {
          id: entry.permalink!,
          number,
          title: numbered ? subtitle?.[1] : entry.title,
          url: `${this.BASE_URL}/chapters/${entry.permalink}`,
          lastUpdated: released
            ? this.formatRelativeTime(new Date(released))
            : undefined,
          group: scanlator
            ? {
                id: scanlator.permalink,
                name: scanlator.name,
                url: `${this.BASE_URL}/scanlators/${scanlator.permalink}`,
              }
            : undefined,
          duplicate: (entry.tags || []).some((t) => t.name === "Duplicate"),
          released,
        },
      ];
    });
  }

  async search(query: string): Promise<SearchResult[]> {
    try {
      const html = await this.fetchWithRetry(
        `${this.BASE_URL}/search?q=${encodeURIComponent(query)}&classes[]=Series`,
      );
      const $ = cheerio.load(html);

      const found: { slug: string; title: string }[] = [];
      $("dl.chapter-list dd a.name").each((_, el) => {
        const slug = this.getSlug($(el).attr("href") || "");
        const title = $(el).text().trim();
        if (slug && title) found.push({ slug, title });
      });

      return await Promise.all(
        found.slice(0, 20).map(async ({ slug, title }, index) => {
          let cover: string | undefined;
          let latestChapter = 0;
          let updated: Date | null = null;

          if (index < 5) {
            try {
              const series = await this.getSeriesJson(slug);
              cover = series.cover ? `${this.BASE_URL}${series.cover}` : undefined;
              const chapters = this.parseChapters(series);
              latestChapter = Math.max(0, ...chapters.map((c) => c.number));
              const stamp = Math.max(0, ...chapters.map((c) => c.released));
              updated = stamp ? new Date(stamp) : null;
            } catch {
              latestChapter = 0;
            }
          }

          return {
            id: slug,
            title,
            url: `${this.BASE_URL}/series/${slug}`,
            coverImage: cover,
            latestChapter,
            lastUpdated: updated ? this.formatRelativeTime(updated) : "",
            lastUpdatedTimestamp: updated ? updated.getTime() : undefined,
          };
        }),
      );
    } catch (error) {
      console.error("[Dynasty Reader] search error:", error);
      throw error;
    }
  }

  async extractMangaInfo(url: string): Promise<{ title: string; id: string }> {
    const slug = this.getSlug(url);

    if (!slug) {
      throw new Error("Could not extract manga slug from URL");
    }

    const series = await this.getSeriesJson(slug);

    return { title: series.name, id: slug };
  }

  /**
   * Extract public page URLs from Dynasty Reader's chapter page data.
   * This uses the same public page list rendered by the site's reader; it does
   * not execute scripts, defeat challenges, or access restricted content.
   */
  async getChapterPages(chapter: { chapterId?: string; url?: string }): Promise<ChapterPage[]> {
    if (!chapter.url) throw new Error("Dynasty Reader chapter URL is required");
    const chapterUrl = new URL(chapter.url);
    if (chapterUrl.hostname !== "dynasty-scans.com" || !chapterUrl.pathname.startsWith("/chapters/")) {
      throw new Error("Invalid Dynasty Reader chapter URL");
    }

    const response = await this.http(chapterUrl, {
      headers: {
        "User-Agent": this.config.userAgent,
        Accept: "text/html,application/xhtml+xml",
        Referer: this.BASE_URL + "/",
      },
    });
    if (!response.ok) throw new Error(`Dynasty Reader chapter request failed: HTTP ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    let rawPages: { name?: string; image?: string }[] = [];

    // The reader exposes a JSON page manifest in its inline script. Parse JSON
    // only; never eval or execute provider-supplied JavaScript.
    $("script").each((_, element) => {
      if (rawPages.length) return;
      const script = $(element).html() || "";
      const match = script.match(/(?:window\.)?pages\s*=\s*(\[[\s\S]*?\])\s*;?/);
      if (!match?.[1]) return;
      try {
        const parsed: unknown = JSON.parse(match[1]);
        if (Array.isArray(parsed)) {
          rawPages = parsed.filter((item): item is { name?: string; image?: string } =>
            Boolean(item && typeof item === "object" && typeof (item as { image?: unknown }).image === "string"),
          );
        }
      } catch {
        // Some deployments emit a non-JSON JS literal; the safe DOM fallback below handles the first page.
      }
    });

    if (rawPages.length === 0) {
      const first = $("#image > img").first();
      const firstUrl = first.attr("src");
      const pageName = first.attr("alt")?.trim();
      const pageLinks = $("#image > .pages-list > .page");
      if (firstUrl && pageName && pageLinks.length > 0) {
        const marker = firstUrl.lastIndexOf(pageName, firstUrl.lastIndexOf("."));
        if (marker >= 0) {
          const prefix = firstUrl.slice(0, marker);
          const suffix = firstUrl.slice(marker + pageName.length);
          pageLinks.each((_, element) => {
            const name = $(element).text().trim();
            if (name) rawPages.push({ name, image: prefix + encodeURIComponent(name) + suffix });
          });
        }
      }
    }

    const pages: ChapterPage[] = [];
    for (const item of rawPages) {
      if (!item.image) continue;
      const url = new URL(item.image, chapterUrl);
      if (
        url.protocol !== "https:" ||
        !(url.hostname === "dynasty-scans.com" || url.hostname.endsWith(".dynasty-scans.com")) ||
        !/\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname)
      ) continue;
      if (pages.some((page) => page.url === url.toString())) continue;
      pages.push({ index: pages.length, url: url.toString() });
    }

    if (pages.length === 0) throw new Error("Dynasty Reader returned no publicly readable chapter pages");
    return pages;
  }

  async getChapterList(mangaUrl: string): Promise<ScrapedChapter[]> {
    try {
      const slug = this.getSlug(mangaUrl);

      if (!slug) {
        throw new Error("Could not extract manga slug from URL");
      }

      const series = await this.getSeriesJson(slug);
      const byNumber = new Map<
        number,
        ScrapedChapter & { duplicate: boolean; released: number }
      >();

      for (const chapter of this.parseChapters(series)) {
        const existing = byNumber.get(chapter.number);
        if (existing && !existing.duplicate && chapter.duplicate) {
          continue;
        }
        byNumber.set(chapter.number, chapter);
      }

      return Array.from(byNumber.values())
        .sort((a, b) => a.number - b.number)
        .map((chapter) => ({
          id: chapter.id,
          number: chapter.number,
          title: chapter.title,
          url: chapter.url,
          lastUpdated: chapter.lastUpdated,
          group: chapter.group,
        }));
    } catch (error) {
      console.error("[Dynasty Reader] chapter list error:", error);
      throw error;
    }
  }
}
