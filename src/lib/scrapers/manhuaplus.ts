/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cheerio from "cheerio";
import { BaseScraper } from "./base";
import { ScrapedChapter, SearchResult, SourceType } from "@/types";
import { domPages } from "./pages/strategies";
import { formatChanged, pagesNotFound } from "./pages/extract";
import { UpstreamHttpError } from "@/lib/core/errors";
import { type ImageRule } from "./pages/policy";

export class ManhuaPlusScraper extends BaseScraper {
  getName(): string {
    return "Manhuaplus";
  }

  getBaseUrl(): string {
    return "https://manhuaplus.top";
  }

  getType(): SourceType {
    return "aggregator";
  }

  canHandle(url: string): boolean {
    return url.includes("manhuaplus.top");
  }

  async extractMangaInfo(url: string): Promise<{ title: string; id: string }> {
    const html = await this.fetchWithRetry(url);
    const $ = cheerio.load(html);

    const title =
      $("h1").first().text().trim() ||
      $(".post-title h1").first().text().trim() ||
      $("title").text().split(" - ")[0].trim();

    const urlMatch = url.match(/\/manga\/([^/]+)/);
    const id = urlMatch ? urlMatch[1] : Date.now().toString();

    return { title, id };
  }

  async getChapterList(mangaUrl: string): Promise<ScrapedChapter[]> {
    const html = await this.fetchWithRetry(mangaUrl);
    const $ = cheerio.load(html);
    const chapters: ScrapedChapter[] = [];
    const seenChapterNumbers = new Set<number>();

    $("nav ul li.row .chapter a").each((_: number, element: any) => {
      const $link = $(element);
      const href = $link.attr("href");
      const chapterText = $link.text().trim();

      if (href) {
        const fullUrl = href.startsWith("http")
          ? href
          : `https://manhuaplus.top${href}`;
        const chapterNumber = this.extractChapterNumber(fullUrl);

        if (chapterNumber >= 0 && !seenChapterNumbers.has(chapterNumber)) {
          seenChapterNumbers.add(chapterNumber);
          chapters.push({
            id: `${chapterNumber}`,
            number: chapterNumber,
            title: chapterText,
            url: fullUrl,
          });
        }
      }
    });

    return chapters.sort((a, b) => a.number - b.number);
  }

  protected extractChapterNumber(chapterUrl: string): number {
    const patterns = [
      /\/chapter[/-](\d+)(?:[.-](\d+))?/i,
      /chapter[/-](\d+)(?:[.-](\d+))?$/i,
    ];

    for (const pattern of patterns) {
      const match = chapterUrl.match(pattern);
      if (match) {
        const mainNumber = parseInt(match[1], 10);
        const decimalPart = match[2] ? parseInt(match[2], 10) : 0;

        if (decimalPart > 0) {
          return mainNumber + decimalPart / 10;
        }
        return mainNumber;
      }
    }

    return -1;
  }

  async search(query: string): Promise<SearchResult[]> {
    const searchUrl = `https://manhuaplus.top/search?keyword=${encodeURIComponent(query)}`;
    const html = await this.fetchWithRetry(searchUrl);
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $(".item.item-follow")
      .slice(0, 5)
      .each((_, element) => {
        const $item = $(element);

        const titleLink = $item.find("figcaption h3 a").first();
        const url = titleLink.attr("href");
        const title = titleLink.text().trim();

        if (!url) return;

        const fullUrl = url.startsWith("http")
          ? url
          : `https://manhuaplus.top${url}`;

        const slugMatch = url.match(/\/manga\/([^/]+)/);
        const id = slugMatch ? slugMatch[1] : "";

        const coverImg = $item.find(".image img").first();
        const coverImage = coverImg.attr("src") || coverImg.attr("data-original");

        const latestChapterLink = $item.find("ul.comic-item li.chapter a").first();
        const latestChapterText = latestChapterLink.text().trim();
        const chapterMatch = latestChapterText.match(/Chapter\s+([\d.]+)/i);
        const latestChapter = chapterMatch ? parseFloat(chapterMatch[1]) : 0;

        const lastUpdatedElement = $item.find("ul.comic-item li.chapter i.time").first();
        const lastUpdated = lastUpdatedElement.text().trim();

        const heartsElement = $item.find(".view .fa-heart").next();
        const heartsText = heartsElement.text().trim();
        const followers = heartsText || undefined;

        results.push({
          id,
          title,
          url: fullUrl,
          coverImage: coverImage?.startsWith("http")
            ? coverImage
            : coverImage
              ? `https://manhuaplus.top${coverImage}`
              : undefined,
          latestChapter,
          lastUpdated,
          followers,
        });
      });

    return results;
  }

  pageImageRules(): ImageRule[] {
    return [{ host: "cdn.manhuaplus.cc" }];
  }

  /**
   * The reader page ships placeholders and then replaces #image_container with
   * the HTML returned by `POST /ajax/image/list/chap/<CHAPTER_ID>` (robots.txt
   * allows it). The same call is made here, with the reader page as Referer.
   */
  async getChapterPages(ref: { chapterId?: string; url?: string }) {
    const url = this.requireChapterUrl(ref);
    const page = await this.http(url);
    if (!page.ok) throw new UpstreamHttpError(page.status, url);
    const html = await page.text();
    const id = html.match(/const\s+CHAPTER_ID\s*=\s*(\d+)/)?.[1];
    if (!id) return this.finalize(domPages("#image_container .page-chapter img")(html, this.getName()), url);
    const res = await this.http(`${new URL(url).origin}/ajax/image/list/chap/${id}`, {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", Referer: url, Accept: "application/json" },
    });
    if (!res.ok) throw new UpstreamHttpError(res.status, url);
    let body: { status?: boolean; html?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw formatChanged(this.getName(), "the chapter image list response");
    }
    if (!body.status || typeof body.html !== "string") throw pagesNotFound(this.getName());
    return this.finalize(domPages(".page-chapter img", { container: ".page-chapter" })(`<div>${body.html}</div>`, this.getName()), url);
  }
}
