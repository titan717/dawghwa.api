import { z } from "zod";
import { booleanish, chargeExpensive, json, parseWith, route } from "@/lib/api/handler";
import { loadTitle, titleRefFromPath, titlesFor } from "@/lib/api/titles";
import { findAvailability, type SourceAvailability, type SkippedSource } from "@/lib/services/availability";
import { getChapters } from "@/lib/services/catalog";
import { getRegistry } from "@/lib/providers/registry";
import type { ScrapedChapter } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(64).default(32),
  refresh: booleanish.optional(),
});

type ChapterVariant = {
  sourceId: string;
  source: string;
  providerChapterId: string;
  url: string;
  group?: ScrapedChapter["group"];
  lastUpdated?: string;
};

type UnifiedChapter = {
  key: string;
  number: number;
  title?: string;
  language: null;
  languageVerified: false;
  matchConfidence: "possible" | "source-only";
  variants: ChapterVariant[];
};

function normalizeLabel(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function chapterKey(chapter: ScrapedChapter, sourceId: string): string {
  const title = normalizeLabel(chapter.title);
  // A number alone is not enough to merge specials or ambiguous provider rows.
  if (!title || !Number.isFinite(chapter.number) || chapter.number <= 0) {
    return `source:${sourceId}:${chapter.id}`;
  }
  return `chapter:${chapter.number}:${title}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * GET /api/titles/:ref/chapters/all
 *
 * Discovers reader-capable sources for the canonical metadata title, retrieves
 * their chapter lists with bounded concurrency, and returns a conservative
 * unified list. Chapter language is intentionally unknown unless a provider
 * supplies it in a future contract; same-number/title rows are possible
 * variants, not a claim that their translations are identical.
 */
export const GET = route(async (req, ctx) => {
  const q = parseWith(querySchema, {
    limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    refresh: req.nextUrl.searchParams.get("refresh") ?? undefined,
  });
  titleRefFromPath(req);
  chargeExpensive(ctx);

  const meta = await loadTitle(req, q.refresh);
  const { titles, queries } = titlesFor(meta);
  const providers = getRegistry()
    .operational()
    .filter((provider) => provider.capabilities.chapterPages && !provider.capabilities.clientOnly);

  const availability: SourceAvailability[] = [];
  const skipped: SkippedSource[] = [];
  const summary = await findAvailability({
    titles,
    queries,
    format: meta.format,
    providers,
    includeUnavailable: false,
    forceRefresh: q.refresh,
    signal: req.signal,
    onSource: (line) => availability.push(line),
    onSkipped: (line) => skipped.push(line),
  });

  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const ranked = summary.ranking
    .map((id) => availability.find((line) => line.sourceId === id))
    .filter((line): line is SourceAvailability => Boolean(line?.best && line.chapterPages))
    .slice(0, q.limit);

  const sourceResults = await mapWithConcurrency(ranked, 4, async (line) => {
    const provider = byId.get(line.sourceId);
    if (!provider || !line.best) return { sourceId: line.sourceId, source: line.source, status: "unavailable", chapters: [] as ScrapedChapter[], error: "Provider mapping disappeared" };
    try {
      const result = await getChapters(provider, line.best.url, { forceRefresh: q.refresh });
      return { sourceId: provider.id, source: provider.name, status: "ok", chapters: result.chapters, cache: result.cache, age: result.age };
    } catch (error) {
      return {
        sourceId: provider.id,
        source: provider.name,
        status: "error",
        chapters: [] as ScrapedChapter[],
        error: error instanceof Error ? error.message.slice(0, 240) : "Chapter retrieval failed",
      };
    }
  });

  const merged = new Map<string, UnifiedChapter>();
  for (const source of sourceResults) {
    for (const chapter of source.chapters) {
      const key = chapterKey(chapter, source.sourceId);
      const variant: ChapterVariant = {
        sourceId: source.sourceId,
        source: source.source,
        providerChapterId: chapter.id,
        url: chapter.url,
        ...(chapter.group ? { group: chapter.group } : {}),
        ...(chapter.lastUpdated ? { lastUpdated: chapter.lastUpdated } : {}),
      };
      const current = merged.get(key);
      if (current) {
        current.variants.push(variant);
        current.matchConfidence = "possible";
      } else {
        merged.set(key, {
          key,
          number: chapter.number,
          ...(chapter.title ? { title: chapter.title } : {}),
          language: null,
          languageVerified: false,
          matchConfidence: key.startsWith("source:") ? "source-only" : "possible",
          variants: [variant],
        });
      }
    }
  }

  const chapters = [...merged.values()].sort((a, b) => {
    const an = Number.isFinite(a.number) ? a.number : Number.POSITIVE_INFINITY;
    const bn = Number.isFinite(b.number) ? b.number : Number.POSITIVE_INFINITY;
    return an - bn || (a.title ?? "").localeCompare(b.title ?? "") || a.key.localeCompare(b.key);
  });

  return json({
    title: { ref: meta.ref, title: meta.title, altTitles: meta.altTitles },
    chapters,
    totalChapters: chapters.length,
    sources: sourceResults.map(({ chapters: rows, ...source }) => ({ ...source, chapterCount: rows.length })),
    skipped,
    summary: {
      ...summary,
      readerCapableSources: providers.length,
      matchedReaderSources: ranked.length,
      chapterSourcesSucceeded: sourceResults.filter((source) => source.status === "ok").length,
      chapterSourcesFailed: sourceResults.filter((source) => source.status !== "ok").length,
      truncated: summary.availableSources > ranked.length,
    },
    meta: { language: "unknown-until-provider-contract-supports-it" },
  }, ctx);
});
