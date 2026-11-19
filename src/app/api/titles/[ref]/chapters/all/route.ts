import { setMaxListeners } from "node:events";
import { z } from "zod";
import { booleanish, chargeExpensive, json, parseWith, route } from "@/lib/api/handler";
import { titleRefFromPath } from "@/lib/api/titles";
import { getTitleMetadata } from "@/lib/metadata";
import { aggregateChapters, type UnifiedEvent } from "@/lib/services/unified";
import type { UnifiedChapter } from "@/lib/chapters/merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const querySchema = z.object({
  stream: booleanish.optional(),
  refresh: booleanish.optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
  language: z.string().trim().regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i).optional(),
});

function page(chapters: UnifiedChapter[], q: z.infer<typeof querySchema>) {
  let list = q.language ? chapters.filter((c) => c.language === q.language!.toLowerCase()) : chapters;
  if (q.order === "desc") list = [...list].reverse();
  const limit = q.limit ?? list.length;
  const slice = list.slice(q.offset, q.offset + limit);
  return {
    chapters: slice,
    pagination: { offset: q.offset, limit, returned: slice.length, total: list.length, hasMore: q.offset + slice.length < list.length },
  };
}

/**
 * GET /api/titles/:ref/chapters/all
 *   ?stream=1          NDJSON: identity, source (per provider, repeated as it progresses),
 *                      chapters (merged snapshot after every provider), summary
 *   ?order=asc|desc    &offset=&limit=   pagination over the merged list (JSON mode)
 *   ?language=en       only rows in that translation language
 *   ?refresh=1         bypass caches
 *
 * One canonical chapter list for a metadata title, merged across every
 * reader-capable provider linked to it. See docs/UNIFIED_CHAPTERS.md.
 */
export const GET = route(async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const q = parseWith(querySchema, {
    stream: sp.get("stream") ?? undefined,
    refresh: sp.get("refresh") ?? undefined,
    order: sp.get("order") ?? undefined,
    offset: sp.get("offset") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    language: sp.get("language") ?? undefined,
  });
  const ref = titleRefFromPath(req);
  chargeExpensive(ctx);
  // enrich: exact MangaDex/WEBTOON cross-references for AniList/MangaUpdates refs
  const { title: meta } = await getTitleMetadata(ref, { enrich: true, forceRefresh: q.refresh });

  if (q.stream) {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    setMaxListeners(200, abort.signal);
    req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            abort.abort();
          }
        };
        try {
          await aggregateChapters(meta, {
            refresh: q.refresh,
            signal: abort.signal,
            onEvent: (e: UnifiedEvent) => {
              if (e.event === "chapters") {
                const p = page(e.chapters, q);
                write({ ...e, chapters: p.chapters, pagination: p.pagination });
              } else write(e);
            },
          });
        } catch (e) {
          write({ event: "error", done: true, error: e instanceof Error ? e.message.slice(0, 240) : "Aggregation failed" });
        } finally {
          try {
            controller.close();
          } catch {
            /* closed */
          }
        }
      },
      cancel() {
        abort.abort();
      },
    });
    const headers = new Headers({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    ctx.headers.forEach((v, k) => headers.set(k, v));
    return new Response(stream, { headers });
  }

  const result = await aggregateChapters(meta, { refresh: q.refresh, signal: req.signal });
  const p = page(result.chapters, q);
  return json(
    {
      title: result.title,
      metadata: { ref: meta.ref, title: meta.title, coverImage: meta.coverImage, format: meta.format, status: meta.status },
      chapters: p.chapters,
      pagination: p.pagination,
      totalChapters: result.chapters.length,
      languages: [...new Set(result.chapters.map((c) => c.language ?? "und"))].sort(),
      sources: result.sources,
      summary: result.summary,
    },
    ctx,
  );
});
