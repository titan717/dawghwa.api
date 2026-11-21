import { cacheKey, getCache, CacheStatus } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { DawghwaError } from "@/lib/core/errors";
import { breakerFor } from "./client";
import { anilist } from "./anilist";
import { findMangaDexByLink, mangadexMeta } from "./mangadex";
import { mangaupdates } from "./mangaupdates";
import {
  METADATA_PROVIDER_IDS,
  type CatalogFilterOptions,
  type CatalogPage,
  type CatalogQuery,
  type MetadataProvider,
  type MetadataProviderId,
  type TitleLink,
  type TitleMetadata,
  type TitleRef,
} from "./types";

export * from "./types";

const ALL: Record<MetadataProviderId, MetadataProvider> = {
  anilist,
  mangadex: mangadexMeta,
  mangaupdates,
};

export interface CachedMeta {
  cache: CacheStatus;
  age: number;
}

export function enabledMetadataProviders(): MetadataProvider[] {
  const enabled = new Set(getConfig().metadata.providers);
  return METADATA_PROVIDER_IDS.filter((id) => enabled.has(id)).map((id) => ALL[id]);
}

export function getMetadataProvider(id: string | undefined): MetadataProvider {
  const key = (id || getConfig().metadata.defaultProvider).trim().toLowerCase();
  const provider = (METADATA_PROVIDER_IDS as readonly string[]).includes(key) ? ALL[key as MetadataProviderId] : undefined;
  if (!provider) {
    throw new DawghwaError("VALIDATION_ERROR", `Unknown metadata provider "${key}"`, {
      details: { supported: METADATA_PROVIDER_IDS },
    });
  }
  if (!getConfig().metadata.providers.includes(provider.id)) {
    throw new DawghwaError("SOURCE_UNAVAILABLE", `${provider.name} metadata is disabled on this server`, {
      details: { provider: provider.id },
    });
  }
  return provider;
}

/** Parse `anilist:105398`, `mangadex:<uuid>`, `mangaupdates:<id|slug>` (also `al:`, `md:`, `mu:`). */
export function parseTitleRef(raw: string): TitleRef {
  const value = decodeURIComponent(raw).trim();
  const m = value.match(/^([a-z]+):(.+)$/i);
  if (!m) {
    throw new DawghwaError("VALIDATION_ERROR", "Title ref must look like <provider>:<id>, e.g. anilist:105398", {
      details: { supported: METADATA_PROVIDER_IDS },
    });
  }
  const alias: Record<string, MetadataProviderId> = { al: "anilist", md: "mangadex", mu: "mangaupdates" };
  const provider = getMetadataProvider(alias[m[1].toLowerCase()] ?? m[1]);
  if (m[2].length > 64) throw new DawghwaError("VALIDATION_ERROR", "Title id is too long");
  return { provider: provider.id, id: provider.parseId(m[2]) };
}

export function formatRef(ref: TitleRef): string {
  return `${ref.provider}:${ref.id}`;
}

function mergeLinks(a: TitleLink[], b: TitleLink[]): TitleLink[] {
  const seen = new Set(a.map((l) => l.url));
  return [...a, ...b.filter((l) => !seen.has(l.url) && seen.add(l.url))];
}

/**
 * Exact cross-references between databases (no title guessing): MangaDex
 * records link to AniList, MAL and MangaUpdates, so AniList/MangaUpdates titles
 * are linked through the MangaDex entry that points back at them.
 */
async function enrich(meta: TitleMetadata): Promise<TitleMetadata> {
  if (meta.provider === "mangadex" || !getConfig().metadata.providers.includes("mangadex")) return meta;
  const key = meta.provider === "anilist" ? "al" : "mu";
  const value = meta.provider === "anilist" ? String(meta.externalIds.anilist) : meta.externalIds.mangaupdates;
  if (!value) return meta;
  const titles = [meta.titles.english, meta.titles.romaji, meta.title].filter((t): t is string => Boolean(t));
  const hit = await findMangaDexByLink(key, value, titles).catch(() => undefined);
  if (!hit) return meta;
  return {
    ...meta,
    externalIds: { ...hit.externalIds, ...stripUndefined(meta.externalIds), mangadex: hit.id },
    links: mergeLinks(meta.links, hit.links),
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function getTitleMetadata(
  ref: TitleRef,
  opts: { enrich?: boolean; forceRefresh?: boolean } = {},
): Promise<{ title: TitleMetadata } & CachedMeta> {
  const provider = ALL[ref.provider];
  const out = await getCache().wrap(
    cacheKey("title", ref.provider, ref.id, opts.enrich ? "x" : "-"),
    getConfig().cache.policies.metadata,
    async () => {
      const meta = await provider.getTitle(ref.id);
      return opts.enrich ? enrich(meta) : meta;
    },
    { forceRefresh: opts.forceRefresh },
  );
  return { title: out.value, cache: out.cache, age: out.age };
}

export function clampCatalogQuery(provider: MetadataProvider, q: CatalogQuery): CatalogQuery {
  const limit = Math.min(Math.max(1, q.limit), provider.capabilities.maxLimit);
  const page = Math.max(1, q.page);
  const depth = provider.capabilities.maxDepth;
  if (depth && page * limit > depth) {
    throw new DawghwaError("VALIDATION_ERROR", `${provider.name} only allows browsing the first ${depth} results`, {
      details: { maxDepth: depth },
    });
  }
  for (const f of [
    "genres",
    "excludeGenres",
    "tags",
    "status",
    "format",
    "statuses",
    "formats",
    "demographics",
    "genreMode",
    "excludeMode",
    "year",
    "nsfw",
  ] as const) {
    const v = q[f];
    const used = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false;
    if (used && !provider.capabilities.filters.includes(f)) {
      throw new DawghwaError("VALIDATION_ERROR", `${provider.name} does not support the "${f}" filter`, {
        details: { supported: provider.capabilities.filters },
      });
    }
  }
  return { ...q, limit, page };
}

export async function browseCatalog(
  provider: MetadataProvider,
  query: CatalogQuery,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ result: CatalogPage } & CachedMeta> {
  const q = clampCatalogQuery(provider, query);
  const key = cacheKey(
    "catalog",
    provider.id,
    JSON.stringify([
      q.q?.trim().toLowerCase(),
      q.genres?.map((g) => g.toLowerCase()).sort(),
      q.excludeGenres?.map((g) => g.toLowerCase()).sort(),
      q.tags?.map((g) => g.toLowerCase()).sort(),
      q.status,
      q.format,
      q.statuses?.slice().sort(),
      q.formats?.slice().sort(),
      q.demographics?.slice().sort(),
      q.genreMode,
      q.excludeMode,
      q.year,
      q.sort,
      Boolean(q.nsfw),
      q.page,
      q.limit,
    ]),
  );
  const out = await getCache().wrap(key, getConfig().cache.policies.catalog, () => provider.browse(q), {
    forceRefresh: opts.forceRefresh,
  });
  return { result: out.value, cache: out.cache, age: out.age };
}

export async function getFilterOptions(provider: MetadataProvider): Promise<{ options: CatalogFilterOptions } & CachedMeta> {
  const out = await getCache().wrap(
    cacheKey("catalog-filters", provider.id),
    { ttl: 86_400, swr: 604_800 },
    () => provider.filterOptions(),
  );
  return { options: out.value, cache: out.cache, age: out.age };
}

export function describeMetadataProviders() {
  return enabledMetadataProviders().map((p) => ({
    id: p.id,
    name: p.name,
    default: p.id === getConfig().metadata.defaultProvider,
    attribution: p.attribution,
    capabilities: p.capabilities,
    circuit: breakerFor(p.id).snapshot().state,
  }));
}
