import { z } from "zod";
import { booleanish, json, parseWith, route } from "@/lib/api/handler";
import { titleRefFromPath } from "@/lib/api/titles";
import { getMetadataProvider, getTitleMetadata } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ enrich: booleanish.optional(), refresh: booleanish.optional() });

/**
 * GET /api/titles/:ref?enrich=true
 * ref: anilist:<id> | mangadex:<uuid> | mangaupdates:<id or slug> (aliases al:, md:, mu:)
 * enrich=true adds exact cross-database ids/links via MangaDex's own link table.
 */
export const GET = route(async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const q = parseWith(querySchema, { enrich: sp.get("enrich") ?? undefined, refresh: sp.get("refresh") ?? undefined });
  const ref = titleRefFromPath(req);
  const r = await getTitleMetadata(ref, { enrich: q.enrich, forceRefresh: q.refresh });
  return json(
    { title: r.title, attribution: getMetadataProvider(ref.provider).attribution, meta: { cache: r.cache, age: r.age } },
    ctx,
  );
});
