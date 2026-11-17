import { z } from "zod";
import { booleanish, chargeExpensive, json, parseWith, route } from "@/lib/api/handler";
import { availabilityStream, loadTitle, titleRefFromPath, resolveSources, sourceListSchema, titlesFor } from "@/lib/api/titles";
import {
  findAvailability,
  type SkippedSource,
  type SourceAvailability,
} from "@/lib/services/availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const querySchema = z.object({
  sources: sourceListSchema.optional(),
  stream: booleanish.optional(),
  minScore: z.coerce.number().min(0.6).max(1).optional(),
  includeUnavailable: booleanish.optional(),
  refresh: booleanish.optional(),
});

/**
 * GET /api/titles/:ref/sources?sources=asurascan,mangadex&stream=1&minScore=0.82
 *
 * Which working sources carry this series, ranked best first, with the
 * source-specific URL to pass to POST /api/chapters.
 */
export const GET = route(async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const q = parseWith(querySchema, {
    sources: sp.get("sources") ?? undefined,
    stream: sp.get("stream") ?? undefined,
    minScore: sp.get("minScore") ?? undefined,
    includeUnavailable: sp.get("includeUnavailable") ?? undefined,
    refresh: sp.get("refresh") ?? undefined,
  });
  // Validate everything local before calling the metadata provider.
  const providers = resolveSources(q.sources);
  titleRefFromPath(req);
  if (!providers || providers.length > 3) chargeExpensive(ctx);
  const meta = await loadTitle(req, q.refresh);
  const { titles, queries } = titlesFor(meta);
  const head = { ref: meta.ref, title: meta.title, altTitles: meta.altTitles, coverImage: meta.coverImage };
  const opts = { titles, queries, format: meta.format, providers, minScore: q.minScore, includeUnavailable: q.includeUnavailable, forceRefresh: q.refresh };

  if (q.stream) {
    return availabilityStream(req, ctx, head, (h) => findAvailability({ ...opts, ...h }));
  }
  const sources: SourceAvailability[] = [];
  const skipped: SkippedSource[] = [];
  const summary = await findAvailability({
    ...opts,
    signal: req.signal,
    onSource: (l) => sources.push(l),
    onSkipped: (s) => skipped.push(s),
  });
  const order = new Map(summary.ranking.map((id, i) => [id, i]));
  sources.sort((a, b) => (order.get(a.sourceId) ?? 1e6) - (order.get(b.sourceId) ?? 1e6));
  return json({ title: head, sources, skipped, summary }, ctx);
});
