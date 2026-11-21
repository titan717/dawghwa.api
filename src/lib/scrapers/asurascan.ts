/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cheerio from "cheerio";
import { DawghwaError } from "@/lib/core/errors";
import { BaseScraper } from "./base";
import { ChapterPage, ScrapedChapter, SearchResult, SourceType } from "@/types";
import { astroProps, astroValue } from "./pages/strategies";
import { chapterLocked, formatChanged, num } from "./pages/extract";
import type { ImageRule } from "./pages/policy";

export class AsuraScanScraper extends BaseScraper {
  private readonly BASE_URL = "https://asurascans.com";

  protected override async fetchWithRetry(url: string): Promise<string> {
    // Direct fetch with proper headers (works in edge runtime)
    const response = await this.http(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: "https://asurascans.com/",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  }

  getName(): string {
    return "AsuraScan";
  }

  getBaseUrl(): string {
    return this.BASE_URL;
  }

  canHandle(url: string): boolean {
    return url.includes("asurascans.com") || url.includes("asuracomic.net");
  }

  /**
   * Search, chapter lists and chapter pages all run server-side from Asura's
   * public HTML, so Asura is a normal reader provider (not proxied to the client).
   */
  isClientOnly(): boolean {
    return false;
  }

  getType(): SourceType {
    return "scanlator";
  }

  pageImageRules(): ImageRule[] {
    return [{ host: "cdn.asurascans.com", pathPrefix: "/asura-images/" }];
  }

  /**
   * Asura's reader is an Astro island (`ChapterReader`) whose props carry the
   * ordered page list (`pages: [{url,width,height}]`) and the chapter's access
   * flags. Locked / premium chapters are reported, never unlocked.
   * Robots.txt disallows /api/, so only the public reader page is used.
   */
  async getChapterPages(ref: { chapterId?: string; url?: string }): Promise<ChapterPage[]> {
    const url = this.requireChapterUrl(ref);
    if (!/\/comics\/[^/]+\/chapter\/[^/?#]+/.test(new URL(url).pathname)) {
      throw new DawghwaError("VALIDATION_ERROR", "Not an Asura Scans chapter reader URL");
    }
    const html = await this.fetchWithRetry(url);
    const props = astroProps(html, /ChapterReader/);
    if (!props) throw formatChanged(this.getName(), "the ChapterReader component");
    const locked = astroValue(props.isLocked) === true;
    const premium = astroValue(props.isPremium) === true;
    const pages = astroValue(props.pages);
    if (locked) throw chapterLocked(this.getName(), premium ? "premium early access" : "locked");
    if (!Array.isArray(pages) || pages.length === 0) {
      if (premium) throw chapterLocked(this.getName(), "premium early access");
      throw formatChanged(this.getName(), "any pages in the ChapterReader props");
    }
    return this.finalize(
      (pages as { url?: string; width?: number; height?: number }[]).map((p) => ({ url: p?.url, width: num(p?.width), height: num(p?.height) })),
      url,
    );
  }

  /**
   * Identity evidence for cross-provider linking, from the public series page:
   * the title, the "alt-titles" line and the Author / Artist links. Title
   * alone is never enough to merge; these let the matcher use authors too.
   */
  async getIdentityHints(mangaUrl: string): Promise<{ title: string; altTitles: string[]; authors: string[] }> {
    const html = await this.fetchWithRetry(mangaUrl);
    const $ = cheerio.load(html);
    const title = $("h1").first().text().replace(/\s+/g, " ").trim();
    const altTitles = $("#alt-titles")
      .text()
      .split(/\s*[•|]\s*/)
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t && t !== title);
    const authors = new Set<string>();
    $('a[href*="/browse?author="], a[href*="/browse?artist="]').each((_, el) => {
      const name = $(el).text().replace(/\s+/g, " ").trim();
      if (name && !/^(-|n\/a|unknown|updating)$/i.test(name)) authors.add(name);
    });
    return { title, altTitles: [...new Set(altTitles)], authors: [...authors] };
  }

  async search(query: string): Promise<SearchResult[]> {
    const searchUrl = `${this.BASE_URL}/browse?search=${encodeURIComponent(query)}`;
    const html = await this.fetchWithRetry(searchUrl);
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $(".series-card").each((_, element) => {
      const $card = $(element);

      const $link = $card.find('a[href^="/comics/"]').first();
      const href = $link.attr("href");
      if (!href) return;

      const slugMatch = href.match(/\/comics\/([^/?]+)/);
      const id = slugMatch ? slugMatch[1] : "";

      const title = $card.find("h3").first().text().trim();
      if (!title) return;

      const coverImg = $card.find("img").first();
      const coverImage = coverImg.attr("src") || coverImg.attr("data-src");

      const chapterSpans = $card.find("span.text-xs.font-medium");
      let latestChapter = 0;
      chapterSpans.each((_, span) => {
        const text = $(span).text().trim();
        const chapterMatch = text.match(/^(\d+)\s+(Chs\.|Chapters?)$/i);
        if (chapterMatch) {
          latestChapter = parseInt(chapterMatch[1], 10);
        }
      });

      const ratingSpan = $card.find("span.text-\\[10px\\]").first();
      const rating = ratingSpan.length
        ? parseFloat(ratingSpan.text().trim())
        : undefined;

      const fullUrl = `${this.BASE_URL}${href}`;

      results.push({
        id,
        title,
        url: fullUrl,
        coverImage: coverImage?.startsWith("http")
          ? coverImage
          : coverImage
            ? `${this.BASE_URL}${coverImage}`
            : undefined,
        latestChapter,
        lastUpdated: "",
        rating,
      });
    });

    return results;
  }

  async extractMangaInfo(url: string): Promise<{ title: string; id: string }> {
    const html = await this.fetchWithRetry(url);
    const $ = cheerio.load(html);

    let title = $("h1").first().text().trim();

    if (!title) {
      title = $("h2").first().text().trim();
    }

    if (!title) {
      title = $("h3").first().text().trim();
    }

    if (!title) {
      const pageTitle = $("title").text();
      title = pageTitle.split(" - ")[0].split("|")[0].trim();
    }

    const urlMatch = url.match(/\/(?:comics|series)\/([^/?]+)/);
    const id = urlMatch ? urlMatch[1] : Date.now().toString();

    return { title, id };
  }

  async getChapterList(mangaUrl: string): Promise<ScrapedChapter[]> {
    const html = await this.fetchWithRetry(mangaUrl);
    const $ = cheerio.load(html);
    const chapters: ScrapedChapter[] = [];
    const seenChapterNumbers = new Set<number>();

    const chapterLinks = $('a[href*="/chapter/"]');

    chapterLinks.each((_: number, element: any) => {
      const $link = $(element);
      let href = $link.attr("href");

      if (!href) {
        return;
      }

      const chapterText =
        $link.find("span.font-medium").first().text().trim() ||
        $link.find("h3").first().text().trim();

      href = href.trim();

      let fullUrl: string;
      if (href.startsWith("http")) {
        fullUrl = href;
      } else if (href.startsWith("/")) {
        fullUrl = `${this.BASE_URL}${href}`;
      } else {
        fullUrl = `${this.BASE_URL}/comics/${href}`;
      }

      const chapterNumber = this.extractChapterNumber(fullUrl, chapterText);

      if (chapterNumber >= 0 && !seenChapterNumbers.has(chapterNumber)) {
        seenChapterNumbers.add(chapterNumber);
        chapters.push({
          id: `${chapterNumber}`,
          number: chapterNumber,
          title: chapterText,
          url: fullUrl,
        });
      }
    });

    return chapters.sort((a, b) => a.number - b.number);
  }

  protected override extractChapterNumber(chapterUrl: string, chapterText?: string): number {
    if (chapterText) {
      // Match concatenated chapters like "Chapter 5 + 6" or "Chapter 5 - 6"
      // But NOT "Chapter 34 - 11.Grand Forge" where the number after dash is a section title
      // The difference: concatenated chapters don't have a period after the second number
      const concatenatedMatch = chapterText.match(/Chapter\s+(\d+)\s*[\+\-]\s*(\d+)(?!\.)(?:\s*$|\s+[^0-9])/i);
      if (concatenatedMatch) {
        return -1;
      }

      const textMatch = chapterText.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
      if (textMatch) {
        return parseFloat(textMatch[1]);
      }
    }

    const patterns = [
      /\/chapter\/(\d+)(?:[.-](\d+))?/i,
      /chapter[/-](\d+)(?:[.-](\d+))?$/i,
    ];

    for (const pattern of patterns) {
      const match = chapterUrl.match(pattern);
      if (match) {
        const mainNumber = parseInt(match[1], 10);
        const decimalPart = match[2] ? match[2] : null;

        if (decimalPart) {
          const divisor = Math.pow(10, decimalPart.length);
          return mainNumber + parseInt(decimalPart, 10) / divisor;
        }
        return mainNumber;
      }
    }

    return -1;
  }
}
