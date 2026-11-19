import { BrowseQuery, BrowseResult, BrowseVocabulary, ChapterPage, MangaMetadata, ScrapedChapter, SearchResult, SourceType } from "@/types";
import { currentContext } from "@/lib/core/context";
import { upstreamFetch, upstreamText } from "@/lib/core/http";
import { sleep } from "@/lib/core/retry";
import { getConfig } from "@/lib/core/config";
import { DawghwaError, UpstreamHttpError } from "@/lib/core/errors";
import { finalizePages, pagesNotFound, type RawPage } from "./pages/extract";
import { matchesImageRules, type ImageRule } from "./pages/policy";

interface ScraperConfig {
  retryAttempts: number;
  downloadDelay: number;
  userAgent: string;
}

export abstract class BaseScraper {
  protected config: ScraperConfig;

  constructor(config?: Partial<ScraperConfig>) {
    this.config = {
      // Retries are centralised in the shared HTTP layer; adapter-level retry
      // loops run once by default to avoid multiplicative retry storms.
      retryAttempts: 0,
      downloadDelay: 500,
      userAgent: getConfig().http.userAgent,
      ...config,
    };
  }

  abstract getName(): string;
  abstract getBaseUrl(): string;
  abstract canHandle(url: string): boolean;
  abstract extractMangaInfo(
    url: string,
  ): Promise<{ title: string; id: string; coverImage?: string; metadata?: MangaMetadata }>;
  abstract getChapterList(mangaUrl: string): Promise<ScrapedChapter[]>;
  abstract search(query: string): Promise<SearchResult[]>;

  /**
   * fetch()-compatible client for adapters. Routed through the shared Dawghwa
   * HTTP layer (timeouts, cancellation, retries with backoff + jitter,
   * per-source rate limits, request deduplication, ETag revalidation and
   * anti-bot detection). Adapters must use this instead of global fetch.
   */
  protected http(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return upstreamFetch(input, init);
  }

  /**
   * Fetch a page as text. Kept for upstream compatibility; the `retries`
   * argument is ignored because retry policy is now centralised (and no longer
   * retries non-retryable responses such as 403/404).
   */
  protected async fetchWithRetry(url: string, _retries?: number): Promise<string> {
    void _retries;
    return upstreamText(url);
  }

  /** Cancellable delay (aborts with the current operation). */
  protected async delay(ms: number): Promise<void> {
    return sleep(ms, currentContext()?.signal);
  }

  protected extractChapterNumber(chapterUrl: string): number {
    const match = chapterUrl.match(/chapter[/-](\d+(?:\.\d+)?)/i);
    return match ? parseFloat(match[1]) : 0;
  }

  protected sanitizeFilename(filename: string): string {
    return filename.replace(/[<>:"/\\|?*]/g, "_").trim();
  }

  getId(): string {
    return this.getName().toLowerCase().replace(/\s+/g, "-");
  }

  getDescription(): string {
    return `${this.getName()} - ${this.getBaseUrl()}`;
  }

  isClientOnly(): boolean {
    return false;
  }

  getType(): SourceType {
    return "aggregator";
  }

  /**
   * Chapter page (image) retrieval through the provider's own public reader.
   * Implemented only where extraction was verified against the live provider
   * (see docs/PAGE_EXTRACTION.md). Never bypasses locks, logins, paywalls or
   * anti-bot challenges; those surface as CHAPTER_LOCKED / UPSTREAM_BLOCKED.
   */
  getChapterPages?(chapter: { chapterId?: string; url?: string }, options?: { dataSaver?: boolean }): Promise<ChapterPage[]>;

  supportsChapterPages(): boolean {
    return typeof this.getChapterPages === "function";
  }

  /**
   * Hosts that serve this provider's page images. /api/image relays only
   * these. Adapters that implement getChapterPages must declare them.
   */
  pageImageRules(): ImageRule[] {
    return [];
  }

  /** Referer the provider's own reader sends with image requests. */
  pageImageReferer(): string {
    return `${this.getBaseUrl().replace(/\/$/, "")}/`;
  }

  /**
   * User-Agent for page image requests: "identifying" (Dawghwa's own UA, for
   * providers with an API etiquette) or "browser" (the same UA used for the
   * provider's HTML pages, for plain image CDNs).
   */
  pageImageUserAgent(): "identifying" | "browser" {
    return "browser";
  }

  /** Validated page image URL, or null when it is not one of this provider's page hosts. */
  allowPageImage(raw: string | URL | null | undefined): URL | null {
    if (!raw) return null;
    let u: URL;
    try {
      u = typeof raw === "string" ? new URL(raw) : raw;
    } catch {
      return null;
    }
    return matchesImageRules(u, this.pageImageRules()) ? u : null;
  }

  /** The chapter reader URL from a page request; it must belong to this provider. */
  protected requireChapterUrl(ref: { chapterId?: string; url?: string }): string {
    if (!ref.url) {
      throw new DawghwaError("VALIDATION_ERROR", `${this.getName()} chapters are addressed by their reader URL; pass the chapter url`);
    }
    if (!this.canHandle(ref.url)) {
      throw new DawghwaError("VALIDATION_ERROR", `That URL is not a ${this.getName()} chapter`);
    }
    return ref.url;
  }

  /** Normalize + validate raw pages against this provider's image hosts. */
  protected finalize(raw: RawPage[], base: string) {
    return finalizePages(raw, { base, source: this.getName(), allow: (u) => this.allowPageImage(u) !== null });
  }

  /**
   * Fetch the chapter reader page and run an engine page locator over it.
   * `html` is the provider's own public reader HTML; nothing is unlocked.
   */
  protected async readerPages(ref: { chapterId?: string; url?: string }, locate: (html: string, source: string) => RawPage[]) {
    const url = this.requireChapterUrl(ref);
    const res = await this.http(url);
    if (!res.ok) throw new UpstreamHttpError(res.status, url);
    // Removed chapters on WordPress sites redirect to the site root; that is
    // "no pages", not a reader format change.
    const landed = res.url ? new URL(res.url) : undefined;
    if (landed && landed.pathname.replace(/\/+$/, "") === "" && new URL(url).pathname.replace(/\/+$/, "") !== "") {
      await res.body?.cancel().catch(() => undefined);
      throw pagesNotFound(this.getName(), "has removed this chapter (its link redirects to the home page)");
    }
    const html = await res.text();
    return this.finalize(locate(html, this.getName()), url);
  }

  /**
   * Catalogue browsing with filters and ordering. Only implemented by adapters
   * whose provider offers a documented listing API (see docs/API.md#post-apibrowse).
   */
  browse?(query: BrowseQuery): Promise<BrowseResult>;
  /** Canonical manga URL for a source-specific id, when the id format is documented and stable. */
  urlForId?(id: string): string | undefined;
  browseVocabulary?(): Promise<BrowseVocabulary>;

  /**
   * Identity hints for cross-provider title linking (authors, aliases).
   * Optional; providers without it are only linked by exact cross-references
   * or left for review.
   */
  getIdentityHints?(mangaUrl: string): Promise<{ title: string; altTitles: string[]; authors: string[]; status?: string; year?: number }>;

  supportsBrowse(): boolean {
    return typeof this.browse === "function";
  }
}
