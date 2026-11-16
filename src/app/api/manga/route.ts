import { z } from "zod";
import { booleanish, httpUrlSchema, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { getMangaInfo, resolveSourceUrl } from "@/lib/services/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  url: httpUrlSchema,
  source: sourceIdSchema.optional(),
  refresh: booleanish.optional(),
});

/**
 * POST /api/manga  { url, source?, refresh? }
 * Resolves basic metadata (title, source-specific id) for a manga URL using the
 * adapter's extractMangaInfo(). Cached with the "metadata" policy.
 */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  const { provider, url } = resolveSourceUrl(body.url, body.source);
  const r = await getMangaInfo(provider, url.toString(), { forceRefresh: body.refresh });
  return json(
    { manga: { ...r.info, url: url.toString() }, source: provider.name, sourceId: provider.id, meta: { cache: r.cache, age: r.age } },
    ctx,
  );
});
