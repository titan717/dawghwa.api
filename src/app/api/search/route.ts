import { z } from "zod";
import { booleanish, chargeExpensive, json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import type { Provider } from "@/lib/providers/provider";
import { searchAll, searchProvider, StreamingSourceResult } from "@/lib/services/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  query: z.string({ required_error: "Search query is required" }).trim().min(1, "Search query is required").max(200, "query must be at most 200 characters"),
  /** A source id/name, or "all" (default). */
  source: sourceIdSchema.optional(),
  /** Explicit subset of sources for a multi-source search. */
  sources: z.array(sourceIdSchema).min(1).max(100).optional(),
  /** Stream NDJSON (default for multi-source) or return one JSON document. */
  stream: booleanish.optional(),
  refresh: booleanish.optional(),
});

function resolveMany(ids: string[]): Provider[] {
  const registry = getRegistry();
  const out: Provider[] = [];
  for (const id of ids) {
    const p = registry.get(id);
    if (!p) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${id}"`, { details: { source: id } });
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * POST /api/search
 * { query, source?: id | "all", sources?: id[], stream?: boolean, refresh?: boolean }
 */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  const multi = body.sources !== undefined || !body.source || body.source.toLowerCase() === "all";

  if (!multi) {
    const provider = getRegistry().get(body.source!);
    if (!provider) {
      throw new DawghwaError("SOURCE_NOT_FOUND", `Unsupported source "${body.source}". See GET /api/sources for available ids.`, {
        details: { source: body.source },
      });
    }
    const r = await searchProvider(provider, body.query, { forceRefresh: body.refresh });
    return json(
      {
        results: r.results,
        source: provider.name,
        sourceId: provider.id,
        meta: { cache: r.cache, age: r.age, durationMs: r.durationMs, total: r.results.length },
      },
      ctx,
    );
  }

  chargeExpensive(ctx);
  const providers = body.sources ? resolveMany(body.sources) : getRegistry().operational();
  const operational = providers.filter((p) => p.operational);
  const unavailable = providers.filter((p) => !p.operational);

  if (body.stream === false) {
    const lines: StreamingSourceResult[] = [];
    const summary = await searchAll(body.query, {
      providers: operational,
      forceRefresh: body.refresh,
      signal: req.signal,
      onResult: (l) => lines.push(l),
    });
    return json(
      {
        query: body.query,
        sources: lines,
        unavailable: unavailable.map((p) => ({ sourceId: p.id, source: p.name, status: p.descriptor.status })),
        summary,
      },
      ctx,
    );
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          abort.abort(); // client went away
        }
      };
      for (const p of unavailable) {
        write({
          source: p.name,
          sourceId: p.id,
          results: [],
          error: `${p.name} is ${p.isDisabled ? "disabled" : p.descriptor.status} and was skipped`,
          errorCode: "SOURCE_UNAVAILABLE",
          done: false,
          durationMs: 0,
        });
      }
      try {
        const summary = await searchAll(body.query, {
          providers: operational,
          forceRefresh: body.refresh,
          signal: abort.signal,
          onResult: write,
        });
        write({ ...summary, totalSources: summary.totalSources + unavailable.length, failedSources: summary.failedSources + unavailable.length, completedSources: summary.completedSources + unavailable.length });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  const headers = new Headers({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  ctx.headers.forEach((v, k) => headers.set(k, v));
  return new Response(stream, { headers });
});
