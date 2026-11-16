import { z } from "zod";
import { booleanish, httpUrlSchema, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { getChapters, resolveSourceUrl } from "@/lib/services/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  url: httpUrlSchema,
  source: sourceIdSchema.optional(),
  /** Pagination over the (cached) chapter list. Omit both for the full list. */
  offset: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
  /** "source" keeps the adapter's order (upstream behaviour). */
  order: z.enum(["source", "asc", "desc"]).optional(),
  refresh: booleanish.optional(),
});

/**
 * POST /api/chapters
 * { url, source?, offset?, limit?, order?: "source"|"asc"|"desc", refresh? }
 */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  const { provider, url } = resolveSourceUrl(body.url, body.source);
  const r = await getChapters(provider, url.toString(), { forceRefresh: body.refresh });

  let list = r.chapters;
  if (body.order === "asc" || body.order === "desc") {
    const dir = body.order === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => (a.number - b.number) * dir);
  }
  const offset = body.offset ?? 0;
  const limit = body.limit ?? list.length;
  const page = offset === 0 && limit >= list.length ? list : list.slice(offset, offset + limit);

  return json(
    {
      chapters: page,
      source: provider.name,
      sourceId: provider.id,
      totalChapters: r.chapters.length,
      pagination: {
        offset,
        limit,
        returned: page.length,
        total: r.chapters.length,
        hasMore: offset + page.length < r.chapters.length,
      },
      meta: { cache: r.cache, age: r.age },
    },
    ctx,
  );
});
