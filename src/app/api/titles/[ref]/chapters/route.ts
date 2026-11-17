import { z } from "zod";
import { booleanish, json, parseWith, route, sourceIdSchema } from "@/lib/api/handler";
import { loadTitle, titleRefFromPath, titlesFor } from "@/lib/api/titles";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { findAvailability, type SourceAvailability } from "@/lib/services/availability";
import { getChapters } from "@/lib/services/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const querySchema = z.object({
  source: sourceIdSchema,
  minScore: z.coerce.number().min(0.6).max(1).optional(),
  order: z.enum(["source", "asc", "desc"]).optional(),
  refresh: booleanish.optional(),
});

/**
 * GET /api/titles/:ref/chapters?source=asurascan
 * Finds the series on the chosen source and returns that source's chapter list.
 */
export const GET = route(async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const q = parseWith(querySchema, {
    source: sp.get("source") ?? undefined,
    minScore: sp.get("minScore") ?? undefined,
    order: sp.get("order") ?? undefined,
    refresh: sp.get("refresh") ?? undefined,
  });
  const provider = getRegistry().get(q.source);
  if (!provider) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${q.source}"`, { details: { source: q.source } });
  provider.assertOperational();
  titleRefFromPath(req);

  const meta = await loadTitle(req, q.refresh);
  const { titles, queries } = titlesFor(meta);
  let line: SourceAvailability | undefined;
  await findAvailability({
    titles,
    queries,
    format: meta.format,
    providers: [provider],
    minScore: q.minScore,
    includeUnavailable: true,
    forceRefresh: q.refresh,
    signal: req.signal,
    onSource: (l) => (line = l),
  });
  const found = line as SourceAvailability | undefined;
  if (found?.error) {
    throw new DawghwaError(found.errorCode ?? "UPSTREAM_ERROR", `${provider.name}: ${found.error}`, {
      details: { source: provider.id },
    });
  }
  if (!found?.best) {
    throw new DawghwaError("NOT_FOUND", `"${meta.title}" was not found on ${provider.name}`, {
      details: { source: provider.id, candidates: found?.candidates ?? [] },
    });
  }
  const r = await getChapters(provider, found.best.url, { forceRefresh: q.refresh });
  let chapters = r.chapters;
  if (q.order === "asc" || q.order === "desc") {
    const dir = q.order === "asc" ? 1 : -1;
    chapters = [...chapters].sort((a, b) => (a.number - b.number) * dir);
  }
  return json(
    {
      title: { ref: meta.ref, title: meta.title },
      source: provider.name,
      sourceId: provider.id,
      match: found.best,
      chapters,
      totalChapters: chapters.length,
      meta: { cache: r.cache, age: r.age },
    },
    ctx,
  );
});
