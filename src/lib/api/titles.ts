import { setMaxListeners } from "node:events";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { DawghwaError } from "@/lib/core/errors";
import { getTitleMetadata, parseTitleRef, type TitleMetadata, type TitleRef } from "@/lib/metadata";
import { searchableTitles } from "@/lib/metadata/match";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import type { AvailabilitySummary, SkippedSource, SourceAvailability } from "@/lib/services/availability";
import type { ApiContext } from "./handler";

/** `/api/titles/<ref>/...` -> TitleRef (Next 14 route params are read from the path). */
export function titleRefFromPath(req: NextRequest): TitleRef {
  const parts = req.nextUrl.pathname.split("/");
  const i = parts.indexOf("titles");
  const raw = i >= 0 ? parts[i + 1] : undefined;
  if (!raw) throw new DawghwaError("VALIDATION_ERROR", "Missing title ref");
  return parseTitleRef(raw);
}

/** Every known title for matching, and the subset worth sending to sources as queries. */
export function titlesFor(meta: Pick<TitleMetadata, "title" | "altTitles"> & { titles?: TitleMetadata["titles"] }) {
  const ordered = [meta.titles?.english, meta.title, meta.titles?.romaji, ...meta.altTitles].filter(
    (t): t is string => Boolean(t && t.trim()),
  );
  const titles = [...new Set(ordered.map((t) => t.trim()))];
  return { titles, queries: searchableTitles(titles[0], titles.slice(1)) };
}

export async function loadTitle(req: NextRequest, refresh?: boolean) {
  const ref = titleRefFromPath(req);
  const { title } = await getTitleMetadata(ref, { forceRefresh: refresh });
  return title;
}

export const sourceListSchema = z
  .string()
  .trim()
  .max(2000)
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().max(64).regex(/^[\p{L}\p{N} '._-]+$/u, "source contains invalid characters")).max(100));

export function resolveSources(ids: string[] | undefined): Provider[] | undefined {
  if (!ids || !ids.length) return undefined;
  const registry = getRegistry();
  const out: Provider[] = [];
  for (const id of ids) {
    const p = registry.get(id);
    if (!p) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${id}"`, { details: { source: id } });
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** NDJSON response: one line per source, `skipped` lines, then the summary. */
export function availabilityStream(
  req: NextRequest,
  ctx: ApiContext,
  head: Record<string, unknown>,
  run: (hooks: {
    signal: AbortSignal;
    onSource: (l: SourceAvailability) => void;
    onSkipped: (s: SkippedSource) => void;
  }) => Promise<AvailabilitySummary>,
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  setMaxListeners(500, abort.signal);
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
      write({ event: "title", ...head });
      try {
        const summary = await run({
          signal: abort.signal,
          onSource: (l) => write({ event: "source", ...l }),
          onSkipped: (s) => write({ event: "skipped", ...s }),
        });
        write({ event: "summary", ...summary });
      } catch (e) {
        write({ event: "error", done: true, error: e instanceof DawghwaError ? e.message : "Availability lookup failed" });
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
}
