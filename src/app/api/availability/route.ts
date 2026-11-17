import { z } from "zod";
import { booleanish, chargeExpensive, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { availabilityStream, resolveSources, titlesFor } from "@/lib/api/titles";
import { findAvailability, type SkippedSource, type SourceAvailability } from "@/lib/services/availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  title: z.string({ required_error: "title is required" }).trim().min(1, "title is required").max(200),
  altTitles: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  sources: z.array(sourceIdSchema).min(1).max(100).optional(),
  stream: booleanish.optional(),
  minScore: z.number().min(0.6).max(1).optional(),
  format: z.enum(["manga", "manhwa", "manhua", "one_shot", "novel", "doujinshi", "oel", "other"]).optional(),
  includeUnavailable: booleanish.optional(),
  refresh: booleanish.optional(),
});

/**
 * POST /api/availability { title, altTitles?, sources?, stream?, minScore?, includeUnavailable?, refresh? }
 * Same as GET /api/titles/:ref/sources for a free-text title (no metadata lookup).
 */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  const providers = resolveSources(body.sources);
  if (!providers || providers.length > 3) chargeExpensive(ctx);
  const { titles, queries } = titlesFor({ title: body.title, altTitles: body.altTitles ?? [] });
  const opts = { titles, queries, format: body.format, providers, minScore: body.minScore, includeUnavailable: body.includeUnavailable, forceRefresh: body.refresh };
  const head = { title: body.title, altTitles: body.altTitles ?? [] };

  if (body.stream) return availabilityStream(req, ctx, head, (h) => findAvailability({ ...opts, ...h }));
  const sources: SourceAvailability[] = [];
  const skipped: SkippedSource[] = [];
  const summary = await findAvailability({ ...opts, signal: req.signal, onSource: (l) => sources.push(l), onSkipped: (s) => skipped.push(s) });
  const order = new Map(summary.ranking.map((id, i) => [id, i]));
  sources.sort((a, b) => (order.get(a.sourceId) ?? 1e6) - (order.get(b.sourceId) ?? 1e6));
  return json({ title: head, sources, skipped, summary }, ctx);
});
