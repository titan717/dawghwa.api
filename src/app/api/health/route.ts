import { NextRequest } from "next/server";
import { ApiContext, json, parseWith, route, sourceIdSchema } from "@/lib/api/handler";
import { cacheKey, getCache } from "@/lib/core/cache";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { getHealth, probeProvider, SourceHealthResult, SourceStatus } from "@/lib/services/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KEEP_ALIVE_MS = 5_000;

function summarize(sources: Record<string, SourceHealthResult>) {
  const counts = { healthy: 0, cloudflare: 0, timeout: 0, error: 0 };
  for (const r of Object.values(sources)) {
    if (r.status === SourceStatus.HEALTHY) counts.healthy++;
    else if (r.status === SourceStatus.CLOUDFLARE) counts.cloudflare++;
    else if (r.status === SourceStatus.TIMEOUT) counts.timeout++;
    else counts.error++;
  }
  return { total: Object.keys(sources).length, ...counts };
}

function shutdownList() {
  return getRegistry()
    .all()
    .filter((p) => !p.operational)
    .map((p) => ({ id: p.id, status: p.isDisabled ? "disabled" : p.descriptor.status, note: p.descriptor.statusNote }));
}

async function payload(forceRefresh: boolean) {
  const r = await getHealth(getRegistry().operational(), { forceRefresh });
  return {
    sources: r.sources,
    cached: r.cache === "hit" || r.cache === "stale",
    cacheAge: r.age,
    stale: r.cache === "stale",
    summary: summarize(r.sources),
    unavailable: shutdownList(),
  };
}

/**
 * A cold full health run can take up to HEALTH_OVERALL_TIMEOUT_MS. Like
 * upstream, stream whitespace keep-alives so proxies do not cut the response;
 * JSON parsers ignore leading whitespace.
 */
function streamed(ctx: ApiContext, forceRefresh: boolean): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(" "));
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch {
          clearInterval(keepAlive);
        }
      }, KEEP_ALIVE_MS);
      try {
        controller.enqueue(encoder.encode(JSON.stringify(await payload(forceRefresh))));
      } catch {
        controller.enqueue(
          encoder.encode(JSON.stringify({ error: "Failed to check source health", code: "INTERNAL_ERROR", requestId: ctx.requestId })),
        );
      } finally {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* closed */
        }
      }
    },
  });
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  ctx.headers.forEach((v, k) => headers.set(k, v));
  return new Response(stream, { headers });
}

async function handle(req: NextRequest, ctx: ApiContext, forceRefresh: boolean): Promise<Response> {
  const sourceParam = req.nextUrl.searchParams.get("source");
  if (sourceParam) {
    const id = parseWith(sourceIdSchema, sourceParam);
    const provider = getRegistry().get(id);
    if (!provider) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${id}"`);
    provider.assertOperational();
    const result = await getCache().wrap(
      cacheKey("health", "source", provider.id),
      { ttl: forceRefresh ? 0 : 120, swr: 0 },
      () => probeProvider(provider),
    );
    return json({ source: provider.id, health: result.value, circuit: provider.circuit(), metrics: provider.metrics }, ctx);
  }
  if (!forceRefresh) {
    const entry = await getCache().get(cacheKey("health", "all"));
    if (entry) return json(await payload(false), ctx, { cacheControl: "public, max-age=60" });
  }
  return streamed(ctx, forceRefresh);
}

/** GET /api/health[?source=id] - cached (5 min fresh, stale-while-revalidate 30 min). */
export const GET = route((req, ctx) => handle(req, ctx, false));

/** POST /api/health - force a fresh check (rate limited as an expensive call). */
export const POST = route((req, ctx) => handle(req, ctx, true), { rate: "expensive" });
