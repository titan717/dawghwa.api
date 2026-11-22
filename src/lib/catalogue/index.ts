import { cacheKey, getCache } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { DawghwaError } from "@/lib/core/errors";
import { formatRef, getTitleMetadata, type TitleMetadata, type TitleRef } from "@/lib/metadata";
import { findMangaDexByLink } from "@/lib/metadata/mangadex";
import { anilistCatalogue } from "./anilist";
import type { CatalogueBackend, CatalogueVocabulary } from "./types";

export * from "./types";

/** `Cache-Control` for successful catalogue responses (errors are always no-store). */
export const CATALOGUE_CACHE = {
  lists: "public, max-age=300, s-maxage=900, stale-while-revalidate=3600",
  vocabulary: "public, max-age=3600, s-maxage=86400",
  recommendations: "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
  batch: "public, max-age=300, s-maxage=600, stale-while-revalidate=3600",
} as const;

/** The backend behind every catalogue list. Internal: clients never see or name it. */
export function catalogueBackend(): CatalogueBackend {
  const backend = anilistCatalogue;
  if (!getConfig().metadata.providers.includes(backend.id)) {
    throw new DawghwaError("SOURCE_UNAVAILABLE", "The catalogue is disabled on this server", {
      details: { reason: `metadata provider ${backend.id} is not enabled` },
    });
  }
  return backend;
}

/** Genres and tags the catalogue can list by. Adult entries only with `nsfw`. */
export async function catalogueVocabulary(opts: { nsfw?: boolean } = {}): Promise<CatalogueVocabulary> {
  const v = await catalogueBackend().vocabulary();
  if (opts.nsfw) return v;
  return { genres: v.genres.filter((g) => !g.adult), tags: v.tags.filter((t) => !t.adult) };
}

export type CatalogueResolution =
  | { inputRef: string; status: "catalogue"; id: string; ref: string }
  /** The title's own metadata loaded and links to no catalogue entry. */
  | { inputRef: string; status: "unlinked"; source: TitleMetadata };

/**
 * Map any title ref the client has stored (for example a `mangadex:` key from
 * older reading progress) to the catalogue entry it links to exactly. Only
 * published cross-references are used, never title similarity. Lookup
 * failures are thrown (and never cached), so a transient outage is not
 * reported as "no link".
 */
export async function resolveCatalogueRef(ref: TitleRef, opts: { forceRefresh?: boolean } = {}): Promise<CatalogueResolution> {
  const backend = catalogueBackend();
  const inputRef = formatRef(ref);
  if (ref.provider === backend.id) return { inputRef, status: "catalogue", id: ref.id, ref: inputRef };
  const { title: meta } = await getTitleMetadata(ref, { forceRefresh: opts.forceRefresh });
  let id = backend.linkedId(meta);
  if (!id && ref.provider === "mangaupdates" && getConfig().metadata.providers.includes("mangadex")) {
    // MangaUpdates publishes no AniList id; MangaDex's link table maps both exactly.
    const out = await getCache().wrap(
      cacheKey("catalogue-link", ref.provider, ref.id),
      getConfig().cache.policies.metadata,
      async () => {
        const titles = [meta.titles.english, meta.titles.romaji, meta.title].filter((t): t is string => Boolean(t));
        const hit = await findMangaDexByLink("mu", ref.id, titles);
        const linked = hit ? backend.linkedId({ provider: "mangadex", providerId: hit.id, externalIds: hit.externalIds }) : undefined;
        return { id: linked ?? null };
      },
      { forceRefresh: opts.forceRefresh },
    );
    id = out.value.id ?? undefined;
  }
  if (!id) return { inputRef, status: "unlinked", source: meta };
  return { inputRef, status: "catalogue", id, ref: `${backend.id}:${id}` };
}
