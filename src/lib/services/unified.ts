/**
 * Unified multi-source chapter aggregation.
 *
 *   metadata ref ──> canonical title ──> provider links ──> chapter lists ──> merge
 *                    (identity)          exact xref first,   bounded parallel,
 *                                        corroborated search per-provider timeout,
 *                                        second              cached independently
 *
 * Results are delivered progressively through `onEvent` so clients can render
 * the first provider's chapters while slower providers are still loading.
 * Concurrent identical requests share one in-flight aggregation.
 */

import { cacheKey, getCache } from "@/lib/core/cache";
import { SingleFlight } from "@/lib/core/singleflight";
import { DawghwaError } from "@/lib/core/errors";
import { titlesFor } from "@/lib/api/titles";
import { mergeChapters, type Edition, type ProviderChapterInput, type UnifiedChapter } from "@/lib/chapters/merge";
import {
  buildCanonicalTitle,
  exactProviderLinks,
  scoreCandidate,
  type CanonicalTitle,
  type CandidateRecord,
  type LinkEvidence,
  type ProviderLink,
} from "@/lib/identity";
import type { TitleMetadata } from "@/lib/metadata/types";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import { findAvailability, type AvailabilityMatch } from "./availability";
import { getChapters } from "./catalog";

/** Provider editions: WEBTOON publishes official translations; the others host scanlations. */
export const PROVIDER_EDITION: Record<string, Edition> = {
  webtoon: "official",
  mangadex: "scanlation",
  "dynasty-reader": "scanlation",
};

export function readerProviders(): Provider[] {
  return getRegistry()
    .operational()
    .filter((p) => p.capabilities.chapterPages && !p.capabilities.clientOnly);
}

export type SourceStatus = "linked" | "loading" | "ok" | "error" | "timeout" | "cancelled" | "no-match" | "review";

export interface SourceReport {
  sourceId: string;
  source: string;
  status: SourceStatus;
  link?: Omit<ProviderLink, "evidence"> & { evidence: LinkEvidence };
  /** Rejected / review-only candidates with evidence (never merged). */
  considered?: (Omit<CandidateRecord, "altTitles"> & { evidence: LinkEvidence })[];
  chapterCount?: number;
  cache?: string;
  durationMs?: number;
  error?: string;
  errorCode?: string;
}

export type UnifiedEvent =
  | { event: "identity"; title: CanonicalTitle }
  | { event: "source"; report: SourceReport }
  | { event: "chapters"; chapters: UnifiedChapter[]; complete: boolean; sourcesDone: number; sourcesTotal: number }
  | { event: "summary"; summary: UnifiedSummary };

export interface UnifiedSummary {
  canonicalTitleId: string;
  readerProviders: number;
  linkedSources: number;
  succeededSources: number;
  failedSources: number;
  totalChapters: number;
  totalVariants: number;
  mergedRows: number;
  firstResultMs?: number;
  durationMs: number;
}

export interface UnifiedResult {
  title: CanonicalTitle;
  chapters: UnifiedChapter[];
  sources: SourceReport[];
  summary: UnifiedSummary;
}

export interface UnifiedOptions {
  refresh?: boolean;
  signal?: AbortSignal;
  /** Per-provider chapter-list budget. */
  providerTimeoutMs?: number;
  concurrency?: number;
  onEvent?: (e: UnifiedEvent) => void;
  /** Injection points for tests. */
  providers?: Provider[];
  discover?: typeof discoverLinks;
}

async function mapBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        await fn(items[i]!);
      }
    }),
  );
}

/**
 * Link reading providers to the canonical title. Exact cross-references are
 * used as-is; the remaining providers are searched with every known title and
 * each candidate must pass `scoreCandidate` (title + corroborating signal).
 */
export async function discoverLinks(
  meta: TitleMetadata,
  canonical: CanonicalTitle,
  providers: Provider[],
  opts: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<{ links: ProviderLink[]; reports: SourceReport[] }> {
  const exact = exactProviderLinks(meta, providers);
  const linkedIds = new Set(exact.map((l) => l.sourceId));
  const rest = providers.filter((p) => !linkedIds.has(p.id));
  const reports: SourceReport[] = [];
  const links = [...exact];
  if (!rest.length) return { links, reports };

  const { titles, queries } = titlesFor(meta);
  const lines = new Map<string, AvailabilityMatch[]>();
  const errors = new Map<string, { error?: string; errorCode?: string }>();
  await findAvailability({
    titles,
    queries,
    format: meta.format,
    providers: rest,
    includeUnavailable: false,
    forceRefresh: opts.refresh,
    signal: opts.signal,
    onSource: (line) => {
      lines.set(line.sourceId, [...(line.best ? [line.best] : []), ...line.candidates]);
      if (line.error) errors.set(line.sourceId, { error: line.error, errorCode: line.errorCode });
    },
    onSkipped: (s) => errors.set(s.sourceId, { error: s.reason, errorCode: "SKIPPED" }),
  }).catch((e) => {
    if (opts.signal?.aborted) throw e;
  });

  await mapBounded(rest, 3, async (p) => {
    const matches = (lines.get(p.id) ?? []).slice(0, 3);
    const considered: SourceReport["considered"] = [];
    let chosen: ProviderLink | undefined;
    for (const m of matches) {
      const hintsFn = p.scraper.getIdentityHints?.bind(p.scraper);
      let hints: Awaited<ReturnType<NonNullable<typeof hintsFn>>> | undefined;
      if (hintsFn) {
        hints = await getCache()
          .wrap(cacheKey("identity-hints", p.id, m.url), { ttl: 86_400, swr: 604_800 }, async () => (await p.run("mangaInfo", () => hintsFn(m.url), { signal: opts.signal })).value, { forceRefresh: opts.refresh })
          .then((r) => r.value)
          .catch(() => undefined);
      }
      const candidate: CandidateRecord = {
        sourceId: p.id,
        source: p.name,
        providerTitleId: m.id,
        url: m.url,
        title: hints?.title || m.title,
        altTitles: hints?.altTitles,
        authors: hints ? hints.authors : undefined,
        year: hints?.year,
      };
      const evidence = scoreCandidate(canonical, candidate);
      if (evidence.decision === "linked" && !chosen) {
        chosen = { sourceId: p.id, source: p.name, providerTitleId: m.id, url: m.url, title: candidate.title, evidence };
      } else {
        considered.push({ sourceId: p.id, source: p.name, providerTitleId: m.id, url: m.url, title: candidate.title, authors: candidate.authors, evidence });
      }
    }
    if (chosen) {
      links.push(chosen);
      if (considered.length) reports.push({ sourceId: p.id, source: p.name, status: "linked", considered });
    } else {
      const err = errors.get(p.id);
      reports.push({
        sourceId: p.id,
        source: p.name,
        status: err ? "error" : considered.some((c) => c.evidence.decision === "review") ? "review" : "no-match",
        ...(considered.length ? { considered } : {}),
        ...(err ?? {}),
      });
    }
  });
  return { links, reports };
}

const inflight = new SingleFlight<UnifiedResult>();

export function aggregateChapters(meta: TitleMetadata, opts: UnifiedOptions = {}): Promise<UnifiedResult> {
  // Streaming callers need their own event sequence; JSON callers coalesce.
  if (opts.onEvent) return runAggregation(meta, opts);
  return inflight.do(`${meta.ref}|${opts.refresh ? 1 : 0}`, () => runAggregation(meta, opts)).promise;
}

async function runAggregation(meta: TitleMetadata, opts: UnifiedOptions): Promise<UnifiedResult> {
  const started = Date.now();
  const emit = opts.onEvent ?? (() => {});
  const canonical = buildCanonicalTitle(meta);
  emit({ event: "identity", title: canonical });

  const providers = opts.providers ?? readerProviders();
  const discover = opts.discover ?? discoverLinks;
  const { links, reports } = await discover(meta, canonical, providers, { refresh: opts.refresh, signal: opts.signal });
  for (const r of reports) emit({ event: "source", report: r });

  const byId = new Map(providers.map((p) => [p.id, p]));
  const sources = new Map<string, SourceReport>(reports.map((r) => [r.sourceId, r]));
  const inputs: ProviderChapterInput[] = [];
  let firstResultMs: number | undefined;
  let done = 0;
  const timeoutMs = opts.providerTimeoutMs ?? 25_000;

  await mapBounded(links, opts.concurrency ?? 4, async (link) => {
    const provider = byId.get(link.sourceId);
    const { evidence, ...rest } = link;
    const base: SourceReport = { sourceId: link.sourceId, source: link.source, status: "loading", link: { ...rest, evidence } };
    emit({ event: "source", report: base });
    const t0 = Date.now();
    let report: SourceReport;
    try {
      if (!provider) throw new DawghwaError("SOURCE_NOT_FOUND", "Provider disappeared");
      if (opts.signal?.aborted) throw new DawghwaError("CANCELLED", "Cancelled");
      const result = await withTimeout(getChapters(provider, link.url, { forceRefresh: opts.refresh }), timeoutMs, opts.signal);
      inputs.push({ sourceId: provider.id, source: provider.name, edition: PROVIDER_EDITION[provider.id] ?? "unknown", chapters: result.chapters });
      report = { ...base, status: "ok", chapterCount: result.chapters.length, cache: result.cache, durationMs: Date.now() - t0 };
    } catch (e) {
      const err = e instanceof DawghwaError ? e : new DawghwaError("UPSTREAM_ERROR", e instanceof Error ? e.message : "Chapter retrieval failed");
      report = {
        ...base,
        status: err.code === "UPSTREAM_TIMEOUT" ? "timeout" : err.code === "CANCELLED" ? "cancelled" : "error",
        error: err.message.slice(0, 240),
        errorCode: err.code,
        durationMs: Date.now() - t0,
      };
    }
    done++;
    sources.set(link.sourceId, { ...(sources.get(link.sourceId) ?? {}), ...report });
    emit({ event: "source", report });
    if (report.status === "ok") {
      if (firstResultMs === undefined) firstResultMs = Date.now() - started;
      emit({ event: "chapters", chapters: mergeChapters(canonical.id, inputs), complete: done === links.length, sourcesDone: done, sourcesTotal: links.length });
    }
  });

  const chapters = mergeChapters(canonical.id, inputs);
  const all = [...sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const summary: UnifiedSummary = {
    canonicalTitleId: canonical.id,
    readerProviders: providers.length,
    linkedSources: links.length,
    succeededSources: all.filter((s) => s.status === "ok").length,
    failedSources: all.filter((s) => s.status === "error" || s.status === "timeout").length,
    totalChapters: chapters.length,
    totalVariants: chapters.reduce((n, c) => n + c.variants.length, 0),
    mergedRows: chapters.filter((c) => new Set(c.variants.map((v) => v.sourceId)).size > 1).length,
    ...(firstResultMs !== undefined ? { firstResultMs } : {}),
    durationMs: Date.now() - started,
  };
  emit({ event: "chapters", chapters, complete: true, sourcesDone: done, sourcesTotal: links.length });
  emit({ event: "summary", summary });
  return { title: canonical, chapters, sources: all, summary };
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tm = setTimeout(() => reject(new DawghwaError("UPSTREAM_TIMEOUT", `No chapter list within ${ms}ms`, { retryable: true })), ms);
    const onAbort = () => reject(new DawghwaError("CANCELLED", "Request was cancelled by the client"));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(tm);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}
