/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cheerio from "cheerio";
import { BaseScraper } from "./base";
import { DawghwaError, UpstreamHttpError } from "@/lib/core/errors";
import { pagesNotFound } from "./pages/extract";
import { parseWebtoonPageUrl } from "@/lib/services/cover-image";
import { ChapterPage, ScrapedChapter, SearchResult, SourceType } from "@/types";

export class WebtoonScraper extends BaseScraper {
  private readonly BASE_URL = "https://www.webtoons.com";

  getName(): string {
    return "WEBTOON";
  }

  override allowPageImage(raw: string | URL | null | undefined): URL | null {
    return raw ? parseWebtoonPageUrl(raw.toString()) : null;
  }

  override pageImageReferer(): string {
    return "https://www.webtoons.com/";
  }

  pageImageUserAgent(): "identifying" | "browser" {
    return "identifying";
  }

  getBaseUrl(): string {
    return this.BASE_URL;
  }

  getType(): SourceType {
    return "aggregator";
  }

  canHandle(url: string): boolean {
    return url.includes("webtoons.com");
  }

  async extractMangaInfo(url: string): Promise<{ title: string; id: string }> {
    const html = await this.fetchWithRetry(url);
    const $ = cheerio.load(html);

    const title =
      $(".detail_header .subj").first().text().trim() ||
      $("h1").first().text().trim() ||
      $("meta[property='og:title']").attr("content")?.trim() ||
      $("title").text().split("|")[0].trim();

    const titleNoMatch = url.match(/title_no=(\d+)/);
    const id = titleNoMatch ? titleNoMatch[1] : Date.now().toString();

    return { title, id };
  }

  /**
   * Extract publicly available episode panels from WEBTOON's normal viewer HTML.
   * Locked/app-only episodes return no panels and are treated as unavailable;
   * this adapter does not attempt to bypass those restrictions.
   */
  async getChapterPages(chapter: { chapterId?: string; url?: string }): Promise<ChapterPage[]> {
    if (!chapter.url) throw new DawghwaError("VALIDATION_ERROR", "WEBTOON chapters are addressed by their viewer URL; pass the chapter url");
    const chapterUrl = new URL(chapter.url);
    if (chapterUrl.hostname !== "www.webtoons.com" || !chapterUrl.pathname.endsWith("/viewer")) {
      throw new DawghwaError("VALIDATION_ERROR", "That URL is not a WEBTOON episode viewer");
    }

    const response = await this.http(chapterUrl, {
      headers: {
        "User-Agent": this.config.userAgent,
        Accept: "text/html,application/xhtml+xml",
        Referer: this.BASE_URL + "/",
      },
    });
    if (!response.ok) throw new UpstreamHttpError(response.status, chapterUrl.toString());
    const html = await response.text();
    const $ = cheerio.load(html);
    const pages: ChapterPage[] = [];

    $("#_imageList img").each((_index, element) => {
      const image = $(element);
      const raw = image.attr("data-url") || image.attr("data-src") || image.attr("src");
      if (!raw || /transparency\.png/i.test(raw)) return;
      const url = new URL(raw, chapterUrl);
      if (
        url.protocol !== "https:" ||
        !["webtoon-phinf.pstatic.net", "swebtoon-phinf.pstatic.net"].includes(url.hostname.toLowerCase())
      ) return;

      const width = Number(image.attr("width"));
      const height = Number(image.attr("height"));
      pages.push({
        index: pages.length,
        url: url.toString(),
        ...(Number.isFinite(width) && width > 0 ? { width } : {}),
        ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      });
    });

    if (pages.length === 0) throw pagesNotFound(this.getName(), "returned no publicly readable episode panels");
    return pages;
  }

  /** WEBTOON serves each translation under a language path (/en/, /es/, /fr/, /zh-hant/ ...). */
  languageOf(url: string): string {
    try {
      const first = new URL(url).pathname.split("/")[1]?.toLowerCase() ?? "";
      if (/^[a-z]{2}(?:-[a-z]{2,4})?$/.test(first)) return first;
    } catch {
      /* fall through */
    }
    return "en";
  }

  /** Identity hints from the public series page (author meta tag). */
  async getIdentityHints(mangaUrl: string): Promise<{ title: string; altTitles: string[]; authors: string[] }> {
    const html = await this.fetchWithRetry(this.buildListUrl(mangaUrl, 1));
    const $ = cheerio.load(html);
    const title = $("meta[property='og:title']").attr("content")?.trim() || $(".detail_header .subj").first().text().trim();
    const author = $("meta[property='com-linewebtoon:webtoon:author']").attr("content")?.trim() || "";
    return { title, altTitles: [], authors: author.split(/\s*[,/]\s*/).filter(Boolean) };
  }

  private getAppLockedCount($: cheerio.CheerioAPI): number {
    const lockedText = $(".detail_install_app strong em").first().text().trim();
    return parseInt(lockedText, 10) || 0;
  }

  private buildListUrl(mangaUrl: string, page: number): string {
    const url = new URL(mangaUrl);
    if (!url.pathname.endsWith("/list")) {
      url.pathname = url.pathname.replace(/\/$/, "") + "/list";
    }
    url.searchParams.set("page", page.toString());
    return url.toString();
  }

  private parseChaptersFromPage(
    $: cheerio.CheerioAPI,
    chapters: ScrapedChapter[],
    seenEpisodes: Set<number>,
  ): void {
    $("#_listUl li._episodeItem").each((_: number, element: any) => {
      const $episode = $(element);
      const episodeNo = parseInt(
        $episode.attr("data-episode-no") || "0",
        10,
      );

      if (episodeNo <= 0 || seenEpisodes.has(episodeNo)) return;

      const $link = $episode.find("a").first();
      const href = $link.attr("href") || "";

      if (!href) return;

      const fullUrl = href.startsWith("http")
        ? href
        : `${this.BASE_URL}${href}`;
      const title = $episode.find(".subj span").first().text().trim();
      const dateText = $episode.find(".date").text().trim();

      seenEpisodes.add(episodeNo);
      const label = title || `Episode ${episodeNo}`;
      const published = Date.parse(dateText);
      chapters.push({
        id: `${episodeNo}`,
        number: episodeNo,
        // The episode_no is WEBTOON's list position (prologues and notices
        // count), so the chapter number comes from the label when it has one.
        chapterLabel: null,
        numberSource: "position",
        title: label,
        url: fullUrl,
        lastUpdated: dateText || undefined,
        ...(Number.isFinite(published) ? { publishedAt: new Date(published).toISOString() } : {}),
        language: this.languageOf(fullUrl),
        sequence: episodeNo,
      });
    });
  }

  private hasHigherPage(
    $: cheerio.CheerioAPI,
    currentPage: number,
  ): boolean {
    let found = false;
    $(".paginate a span").each((_: number, element: any) => {
      const num = parseInt($(element).text().trim(), 10);
      if (!isNaN(num) && num > currentPage) {
        found = true;
        return false;
      }
    });
    return found;
  }

  /**
   * Full public episode list from the mobile site's JSON list (one request
   * instead of one HTML page per 10 episodes). Only episodes WEBTOON lists
   * publicly are returned; Fast Pass / app-only episodes are not requested.
   */
  private async getEpisodeListJson(mangaUrl: string): Promise<ScrapedChapter[] | undefined> {
    const url = new URL(mangaUrl);
    const titleNo = url.searchParams.get("title_no");
    if (!titleNo || !/^\d{1,9}$/.test(titleNo)) return undefined;
    const language = this.languageOf(mangaUrl);
    const response = await this.http(`https://m.webtoons.com/api/v1/webtoon/${titleNo}/episodes?pageSize=99999`, {
      headers: {
        "User-Agent": this.config.userAgent,
        Accept: "application/json",
        Referer: "https://m.webtoons.com/",
      },
    });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => undefined)) as
      | { result?: { episodeList?: { episodeNo?: number; episodeTitle?: string; viewerLink?: string; exposureDateMillis?: number }[] } }
      | undefined;
    const list = body?.result?.episodeList;
    if (!Array.isArray(list) || !list.length) return undefined;
    const out: ScrapedChapter[] = [];
    for (const ep of list) {
      if (!Number.isInteger(ep.episodeNo) || !ep.viewerLink || !ep.viewerLink.startsWith("/")) continue;
      const viewer = new URL(ep.viewerLink, this.BASE_URL);
      if (!viewer.pathname.endsWith("/viewer")) continue;
      // The JSON list is served from the English mobile site; keep the language path of the series URL.
      const title = (ep.episodeTitle || "").trim() || `Episode ${ep.episodeNo}`;
      out.push({
        id: String(ep.episodeNo),
        number: ep.episodeNo!,
        chapterLabel: null,
        numberSource: "position",
        title,
        url: viewer.toString(),
        ...(ep.exposureDateMillis ? { publishedAt: new Date(ep.exposureDateMillis).toISOString() } : {}),
        language,
        sequence: ep.episodeNo,
      });
    }
    return out.sort((a, b) => a.number - b.number);
  }

  async getChapterList(mangaUrl: string): Promise<ScrapedChapter[]> {
    const fast = await this.getEpisodeListJson(mangaUrl).catch(() => undefined);
    if (fast?.length) return fast;
    const chapters: ScrapedChapter[] = [];
    const seenEpisodes = new Set<number>();

    try {
      let page = 1;

      while (true) {
        const pageUrl = this.buildListUrl(mangaUrl, page);
        const html = await this.fetchWithRetry(pageUrl);
        const $ = cheerio.load(html);

        const beforeCount = chapters.length;
        this.parseChaptersFromPage($, chapters, seenEpisodes);

        if (chapters.length === beforeCount) break;

        const hasNextPage = $(".paginate a.pg_next").length > 0;
        const hasHigherPages = this.hasHigherPage($, page);

        if (!hasNextPage && !hasHigherPages) break;

        page++;
      }
    } catch (error) {
      console.error("[WEBTOON] Chapter fetch error:", error);
    }

    return chapters.sort((a, b) => a.number - b.number);
  }

  private async fetchLatestChapterInfo(
    listUrl: string,
  ): Promise<{ latestChapter: number; lastUpdated: string }> {
    try {
      const pageUrl = this.buildListUrl(listUrl, 1);
      const html = await this.fetchWithRetry(pageUrl);
      const $ = cheerio.load(html);

      const appLockedCount = this.getAppLockedCount($);

      let highestEpisode = 0;
      let latestDate = "";

      $("#_listUl li._episodeItem").each((_: number, element: any) => {
        const episodeNo = parseInt(
          $(element).attr("data-episode-no") || "0",
          10,
        );
        if (episodeNo > highestEpisode) {
          highestEpisode = episodeNo;
          latestDate = $(element).find(".date").text().trim();
        }
      });

      return {
        latestChapter: highestEpisode + appLockedCount,
        lastUpdated: latestDate,
      };
    } catch {
      return { latestChapter: 0, lastUpdated: "" };
    }
  }

  async search(query: string): Promise<SearchResult[]> {
    const searchUrl = `${this.BASE_URL}/en/search?keyword=${encodeURIComponent(query)}`;
    const html = await this.fetchWithRetry(searchUrl);
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    const basicResults: {
      title: string;
      url: string;
      coverImage?: string;
      id: string;
    }[] = [];

    $(".webtoon_list li")
      .slice(0, 5)
      .each((_: number, element: any) => {
        const $item = $(element);
        const $link = $item.find("a.link").first();

        const url = $link.attr("href") || "";
        if (!url) return;

        const fullUrl = url.startsWith("http")
          ? url
          : `${this.BASE_URL}${url}`;
        const title = $item.find(".title").text().trim();
        const coverImage = $item.find(".image_wrap img").attr("src");
        const titleNo = $link.attr("data-title-no") || "";

        basicResults.push({
          title,
          url: fullUrl,
          coverImage,
          id: titleNo,
        });
      });

    const chapterInfoPromises = basicResults.map((result) =>
      this.fetchLatestChapterInfo(result.url),
    );
    const chapterInfos = await Promise.all(chapterInfoPromises);

    for (let i = 0; i < basicResults.length; i++) {
      const basic = basicResults[i];
      const chapterInfo = chapterInfos[i];

      results.push({
        id: basic.id,
        title: basic.title,
        url: basic.url,
        coverImage: basic.coverImage,
        latestChapter: chapterInfo.latestChapter,
        lastUpdated: chapterInfo.lastUpdated,
      });
    }

    return results;
  }
}
