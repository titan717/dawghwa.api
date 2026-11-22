import { z } from "zod";
import { booleanish, json, parseWith, route } from "@/lib/api/handler";
import { CATALOGUE_CACHE, catalogueBackend, catalogueVocabulary } from "@/lib/catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/lists/genres?nsfw=false
 * Genres and tags that GET /api/lists/genre/{name} accepts. Adult entries are
 * left out unless nsfw=true.
 */
export const GET = route(async (req, ctx) => {
  const q = parseWith(z.object({ nsfw: booleanish.optional() }), { nsfw: req.nextUrl.searchParams.get("nsfw") ?? undefined });
  const v = await catalogueVocabulary({ nsfw: q.nsfw });
  return json(
    {
      genres: v.genres.map((g) => g.name),
      tags: v.tags.map((t) => ({ name: t.name, ...(t.group ? { group: t.group } : {}) })),
      attribution: catalogueBackend().attribution,
    },
    ctx,
    { cacheControl: CATALOGUE_CACHE.vocabulary },
  );
});
