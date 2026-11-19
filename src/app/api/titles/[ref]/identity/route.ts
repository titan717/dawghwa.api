import { z } from "zod";
import { booleanish, chargeExpensive, json, parseWith, route } from "@/lib/api/handler";
import { titleRefFromPath } from "@/lib/api/titles";
import { getTitleMetadata } from "@/lib/metadata";
import { buildCanonicalTitle } from "@/lib/identity";
import { discoverLinks, readerProviders } from "@/lib/services/unified";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/titles/:ref/identity
 *
 * The canonical title and, per reader-capable provider, which record was
 * linked and why (or why candidates were rejected / left for review).
 */
export const GET = route(async (req, ctx) => {
  const q = parseWith(z.object({ refresh: booleanish.optional() }), { refresh: req.nextUrl.searchParams.get("refresh") ?? undefined });
  const ref = titleRefFromPath(req);
  chargeExpensive(ctx);
  const { title: meta } = await getTitleMetadata(ref, { enrich: true, forceRefresh: q.refresh });
  const canonical = buildCanonicalTitle(meta);
  const providers = readerProviders();
  const { links, reports } = await discoverLinks(meta, canonical, providers, { refresh: q.refresh, signal: req.signal });
  return json({ title: canonical, links, unlinked: reports.filter((r) => !links.some((l) => l.sourceId === r.sourceId)), considered: reports }, ctx);
});
