import { BrowseQuery, BrowseResult, BrowseVocabulary, ChapterPage, MangaMetadata, ScrapedChapter, SearchResult, SourceType } from "@/types";
import { currentContext } from "@/lib/core/context";
import { upstreamFetch, upstreamText } from "@/lib/core/http";
import { sleep } from "@/lib/core/retry";
import { getConfig } from "@/lib/core/config";

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
   * Chapter page (image) retrieval. Only implemented by adapters whose provider
   * offers a documented, permitted API for it (see docs/API.md#chapter-pages).
   */
  getChapterPages?(chapter: { chapterId?: string; url?: string }, options?: { dataSaver?: boolean }): Promise<ChapterPage[]>;

  supportsChapterPages(): boolean {
    return typeof this.getChapterPages === "function";
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
