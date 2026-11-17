import { z } from "zod";
import { booleanish, httpUrlSchema, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { getMangaInfo, resolveSourceUrl } from "@/lib/services/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    url: httpUrlSchema.optional(),
    /** With `source`: a source-specific manga id (only for sources that can build a URL from it). */
    id: z.string().trim().min(1).max(128).regex(/^[\w-]+$/, "id contains invalid characters").optional(),
    source: sourceIdSchema.optional(),
    refresh: booleanish.optional(),
  })
  .refine((b) => b.url || (b.id && b.source), { message: "Provide url, or id with source" });

/**
 * POST /api/manga  { url, source?, refresh? }
 * Resolves basic metadata (title, source-specific id) for a manga URL using the
 * adapter's extractMangaInfo(). Cached with the "metadata" policy.
 */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  let rawUrl = body.url;
  if (!rawUrl) {
    const p = getRegistry().get(body.source!);
    if (!p) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${body.source}"`);
    rawUrl = p.scraper.urlForId?.(body.id!);
    if (!rawUrl) {
      throw new DawghwaError(
        p.scraper.urlForId ? "VALIDATION_ERROR" : "UNSUPPORTED_CAPABILITY",
        p.scraper.urlForId ? `"${body.id}" is not a valid ${p.name} id` : `${p.name} needs a manga url, not an id`,
      );
    }
  }
  const { provider, url } = resolveSourceUrl(rawUrl, body.source);
  const r = await getMangaInfo(provider, url.toString(), { forceRefresh: body.refresh });
  return json(
    { manga: { ...r.info, url: url.toString() }, source: provider.name, sourceId: provider.id, meta: { cache: r.cache, age: r.age } },
    ctx,
  );
});
