import { cacheKey, getCache, CacheStatus } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { DawghwaError } from "@/lib/core/errors";
import { normalizeChapters, normalizeMetadata, normalizePages, normalizeSearchResults } from "@/lib/providers/normalize";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import type { BrowseQuery, BrowseResult, BrowseVocabulary, ChapterPage, FrontpageSection, MangaMetadata, ScrapedChapter } from "@/types";

export interface CacheMeta {
  cache: CacheStatus;
  age: number;
}

/**
 * Validate a user-supplied manga/chapter URL and resolve its provider.
 *
 * SSRF protection: only http(s) URLs whose host is one of the source's known
 * domains are accepted (exact or subdomain match). Upstream used substring
 * matching, so `http://169.254.169.254/?mangadex.org` was fetched.
 */
export function resolveSourceUrl(rawUrl: string, sourceHint?: string): { provider: Provider; url: URL } {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new DawghwaError("VALIDATION_ERROR", "url must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DawghwaError("VALIDATION_ERROR", "url must use http or https");
  }
  if (url.username || url.password) {
    throw new DawghwaError("VALIDATION_ERROR", "url must not contain credentials");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new DawghwaError("VALIDATION_ERROR", "url must not use a custom port");
  }
  const registry = getRegistry();
  const hinted = sourceHint ? registry.get(sourceHint) : undefined;
  if (sourceHint && !hinted) {
    throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${sourceHint}"`, {
      details: { source: sourceHint },
    });
  }
  const provider = hinted && hinted.ownsUrl(url) ? hinted : registry.forUrl(url);
  if (!provider) {
    throw new DawghwaError(
      "VALIDATION_ERROR",
      "No source found for this URL. Provide a manga URL from a supported source domain.",
      { details: { host: url.hostname } },
    );
  }
  if (hinted && provider !== hinted) {
    throw new DawghwaError(
      "VALIDATION_ERROR",
      `URL host ${url.hostname} does not belong to source "${hinted.id}"`,
      { details: { host: url.hostname, source: hinted.id, allowedDomains: hinted.descriptor.domains } },
    );
  }
  return { provider, url };
}

export async function getChapters(
  provider: Provider,
  url: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ chapters: ScrapedChapter[] } & CacheMeta> {
  provider.assertOperational();
  const out = await getCache().wrap(
    cacheKey("chapters", provider.id, url),
    getConfig().cache.policies.chapters,
    async () => {
      const { value } = await provider.run("chapters", () => provider.scraper.getChapterList(url));
      return normalizeChapters(value, provider.descriptor.baseUrl).chapters;
    },
    { forceRefresh: opts.forceRefresh },
  );
  return { chapters: out.value, cache: out.cache, age: out.age };
}

export async function getMangaInfo(
  provider: Provider,
  url: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ info: { title: string; id: string; coverImage?: string; metadata?: MangaMetadata } } & CacheMeta> {
  provider.assertOperational();
  const out = await getCache().wrap(
    cacheKey("manga", provider.id, url),
    getConfig().cache.policies.metadata,
    async () => {
      const { value } = await provider.run("mangaInfo", () => provider.scraper.extractMangaInfo(url));
      const title = typeof value?.title === "string" ? value.title.trim() : "";
      const id = value?.id !== undefined ? String(value.id) : "";
      if (!title) throw new DawghwaError("UPSTREAM_ERROR", "Source returned no title for this URL");
      const base = provider.descriptor.baseUrl;
      const metadata = normalizeMetadata(value?.metadata, base);
      let coverImage: string | undefined;
      if (typeof value?.coverImage === "string") {
        try {
          const u = new URL(value.coverImage, base);
          if (u.protocol === "https:" || u.protocol === "http:") coverImage = u.toString();
        } catch {
          coverImage = undefined;
        }
      }
      return { title, id, ...(coverImage ? { coverImage } : {}), ...(metadata ? { metadata } : {}) };
    },
    { forceRefresh: opts.forceRefresh },
  );
  return { info: out.value, cache: out.cache, age: out.age };
}

export async function getFrontpageSection(
  provider: Provider,
  section: string,
  options: { page: number; limit: number; days: number },
  opts: { forceRefresh?: boolean } = {},
): Promise<{ section: FrontpageSection } & CacheMeta> {
  provider.assertOperational();
  const frontpage = provider.frontpage;
  if (!frontpage) {
    throw new DawghwaError("UNSUPPORTED_CAPABILITY", `${provider.name} does not support frontpages`);
  }
  const out = await getCache().wrap(
    cacheKey("frontpage", provider.id, section, options.page, options.limit, options.days),
    getConfig().cache.policies.frontpage,
    async () => {
      const { value } = await provider.run("frontpage", () => frontpage.fetchSection(section, options));
      return value;
    },
    { forceRefresh: opts.forceRefresh, shouldCache: (v) => ((v as FrontpageSection)?.items?.length ?? 0) > 0 },
  );
  return { section: out.value, cache: out.cache, age: out.age };
}

export async function getChapterPages(
  provider: Provider,
  ref: { chapterId?: string; url?: string },
  opts: { dataSaver?: boolean; forceRefresh?: boolean } = {},
): Promise<{ pages: ChapterPage[] } & CacheMeta> {
  provider.assertOperational();
  const scraper = provider.scraper;
  if (!scraper.getChapterPages) {
    throw new DawghwaError(
      "UNSUPPORTED_CAPABILITY",
      `${provider.name} does not offer an explicit supported chapter page reader, so Dawghwa does not retrieve its pages`,
      { details: { source: provider.id, capability: "chapterPages" } },
    );
  }
  const getPages = scraper.getChapterPages.bind(scraper);
  const out = await getCache().wrap(
    cacheKey("pages", provider.id, ref.url ?? ref.chapterId, opts.dataSaver ? "ds" : "full"),
    getConfig().cache.policies.pages,
    async () => {
      const { value } = await provider.run("chapterPages", () => getPages(ref, { dataSaver: opts.dataSaver }));
      return normalizePages(value);
    },
    { forceRefresh: opts.forceRefresh },
  );
  return { pages: out.value, cache: out.cache, age: out.age };
}

function stableQueryKey(q: BrowseQuery): string {
  const norm = {
    query: q.query?.trim().toLowerCase() || undefined,
    includedTags: q.includedTags?.map((t) => t.toLowerCase()).sort(),
    excludedTags: q.excludedTags?.map((t) => t.toLowerCase()).sort(),
    includedTagsMode: q.includedTagsMode,
    kinds: q.kinds ? [...q.kinds].sort() : undefined,
    status: q.status ? [...q.status].sort() : undefined,
    demographic: q.demographic ? [...q.demographic].sort() : undefined,
    year: q.year,
    createdWithinDays: q.createdWithinDays,
    order: q.order,
    offset: q.offset ?? 0,
    limit: q.limit ?? 24,
    withStats: q.withStats !== false,
  };
  return JSON.stringify(norm);
}

function assertBrowse(provider: Provider) {
  provider.assertOperational();
  if (!provider.scraper.browse) {
    throw new DawghwaError("UNSUPPORTED_CAPABILITY", `${provider.name} does not offer a documented catalogue listing API`, {
      details: { source: provider.id, capability: "browse" },
    });
  }
}

export async function browseCatalog(
  provider: Provider,
  query: BrowseQuery,
  opts: { forceRefresh?: boolean } = {},
): Promise<BrowseResult & CacheMeta> {
  assertBrowse(provider);
  const browse = provider.scraper.browse!.bind(provider.scraper);
  const out = await getCache().wrap(
    cacheKey("browse", provider.id, stableQueryKey(query)),
    getConfig().cache.policies.frontpage,
    async () => {
      const { value } = await provider.run("browse", () => browse(query));
      const { results } = normalizeSearchResults(value?.items, provider.descriptor.baseUrl);
      return { ...value, items: results } as BrowseResult;
    },
    { forceRefresh: opts.forceRefresh },
  );
  return { ...out.value, cache: out.cache, age: out.age };
}

export async function getBrowseVocabulary(provider: Provider): Promise<{ vocabulary: BrowseVocabulary } & CacheMeta> {
  assertBrowse(provider);
  if (!provider.scraper.browseVocabulary) {
    throw new DawghwaError("UNSUPPORTED_CAPABILITY", `${provider.name} does not publish a browse vocabulary`);
  }
  const vocab = provider.scraper.browseVocabulary.bind(provider.scraper);
  const out = await getCache().wrap(
    cacheKey("browse-vocabulary", provider.id),
    getConfig().cache.policies.metadata,
    async () => (await provider.run("browse", () => vocab())).value,
  );
  return { vocabulary: out.value, cache: out.cache, age: out.age };
}
