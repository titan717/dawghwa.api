import { z } from "zod";
import { booleanish, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { browseCatalog, getBrowseVocabulary } from "@/lib/services/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tagName = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N} '&()./-]+$/u, "tag contains invalid characters");

const bodySchema = z.object({
  source: sourceIdSchema.optional(),
  query: z.string().trim().min(1).max(200).optional(),
  includedTags: z.array(tagName).max(20).optional(),
  excludedTags: z.array(tagName).max(20).optional(),
  includedTagsMode: z.enum(["and", "or"]).optional(),
  kinds: z.array(z.enum(["manga", "manhwa", "manhua", "comic"])).max(4).optional(),
  status: z.array(z.enum(["ongoing", "completed", "hiatus", "cancelled"])).max(4).optional(),
  demographic: z.array(z.enum(["shounen", "shoujo", "seinen", "josei", "none"])).max(5).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  createdWithinDays: z.number().int().min(1).max(3650).optional(),
  order: z.enum(["popular", "rating", "latest", "new", "relevance", "year"]).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  withStats: booleanish.optional(),
  refresh: booleanish.optional(),
});

function browseProviders() {
  return getRegistry()
    .all()
    .filter((p) => p.operational && p.capabilities.browse);
}

function pick(source?: string) {
  const id = source ?? browseProviders()[0]?.id;
  const provider = id ? getRegistry().get(id) : undefined;
  if (!provider) {
    throw new DawghwaError(id ? "SOURCE_NOT_FOUND" : "UNSUPPORTED_CAPABILITY", id ? `Unknown source "${id}"` : "No source supports browsing");
  }
  return provider;
}

/**
 * GET /api/browse            sources that support browsing
 * GET /api/browse?source=id  that source's vocabulary (tag names and groups, orders, filters)
 */
export const GET = route(async (req, ctx) => {
  const source = req.nextUrl.searchParams.get("source");
  if (!source) {
    return json(
      { sources: browseProviders().map((p) => ({ id: p.id, name: p.name })) },
      ctx,
      { cacheControl: "public, max-age=300" },
    );
  }
  const provider = pick(source);
  const r = await getBrowseVocabulary(provider);
  return json(
    { source: provider.name, sourceId: provider.id, ...r.vocabulary, meta: { cache: r.cache, age: r.age } },
    ctx,
    { cacheControl: "public, max-age=3600" },
  );
});

/** POST /api/browse { source?, query?, includedTags?, kinds?, status?, order?, offset?, limit?, ... } */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  const provider = pick(body.source);
  const { refresh, source: _source, ...query } = body;
  void _source;
  const r = await browseCatalog(provider, query, { forceRefresh: refresh });
  return json(
    {
      items: r.items,
      total: r.total,
      pagination: { offset: r.offset, limit: r.limit, returned: r.items.length, total: r.total, hasMore: r.hasMore },
      source: provider.name,
      sourceId: provider.id,
      meta: { cache: r.cache, age: r.age },
    },
    ctx,
  );
});
