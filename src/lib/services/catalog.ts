import { cacheKey, getCache, CacheStatus } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { DawghwaError } from "@/lib/core/errors";
import { normalizeChapters, normalizePages } from "@/lib/providers/normalize";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import type { ChapterPage, FrontpageSection, ScrapedChapter } from "@/types";

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
): Promise<{ info: { title: string; id: string } } & CacheMeta> {
  provider.assertOperational();
  const out = await getCache().wrap(
    cacheKey("manga", provider.id, url),
    getConfig().cache.policies.metadata,
    async () => {
      const { value } = await provider.run("mangaInfo", () => provider.scraper.extractMangaInfo(url));
      const title = typeof value?.title === "string" ? value.title.trim() : "";
      const id = value?.id !== undefined ? String(value.id) : "";
      if (!title) throw new DawghwaError("UPSTREAM_ERROR", "Source returned no title for this URL");
      return { title, id };
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
      `${provider.name} does not offer a documented chapter page API, so Dawghwa does not retrieve its pages`,
      { details: { source: provider.id, capability: "chapterPages" } },
    );
  }
  const getPages = scraper.getChapterPages.bind(scraper);
  const out = await getCache().wrap(
    cacheKey("pages", provider.id, ref.chapterId ?? ref.url, opts.dataSaver ? "ds" : "full"),
    getConfig().cache.policies.pages,
    async () => {
      const { value } = await provider.run("chapterPages", () => getPages(ref, { dataSaver: opts.dataSaver }));
      return normalizePages(value);
    },
    { forceRefresh: opts.forceRefresh },
  );
  return { pages: out.value, cache: out.cache, age: out.age };
}
