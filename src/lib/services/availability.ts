import { cacheKey, getCache } from "@/lib/core/cache";
import { getConfig } from "@/lib/core/config";
import { DawghwaError, ErrorCode } from "@/lib/core/errors";
import { bestTitleScore, confidenceFor, MatchConfidence, normalizeTitle } from "@/lib/metadata/match";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import type { SearchResult } from "@/types";
import type { SourceHealthResult } from "./health";
import { searchAll, StreamingSourceResult } from "./search";

/**
 * "Where can I read this?" — Comick-style source selection.
 *
 * Given the known titles of a series (from AniList/MangaDex/MangaUpdates or
 * supplied by the client), search every working source in parallel, match the
 * results against all known titles, and report which sources carry the series,
 * how confident the match is, and how far each source is (latest chapter), so
 * a client can let the user pick a source and then load chapters from it.
 */

export interface AvailabilityMatch {
  id: string;
  title: string;
  url: string;
  coverImage?: string;
  latestChapter: number;
  lastUpdated: string;
  lastUpdatedTimestamp?: number;
  score: number;
  confidence: MatchConfidence;
  matchedAgainst?: string;
}

export type SourceState = "working" | "blocked" | "failing" | "unknown";

export interface SourceAvailability {
  sourceId: string;
  source: string;
  type: string;
  status: string;
  state: SourceState;
  clientOnly: boolean;
  chapterPages: boolean;
  /** True when a result matched with confidence "exact" or "high". */
  available: boolean;
  best?: AvailabilityMatch;
  /** Other plausible results (alternate editions, lower-confidence matches). */
  candidates: AvailabilityMatch[];
  queries: string[];
  error?: string;
  errorCode?: ErrorCode;
  cached?: boolean;
  durationMs: number;
}

export interface SkippedSource {
  sourceId: string;
  source: string;
  status: string;
  state: SourceState;
  reason: string;
}

export interface AvailabilitySummary {
  done: true;
  title: string;
  queries: string[];
  totalSources: number;
  availableSources: number;
  noMatchSources: number;
  failedSources: number;
  skippedSources: number;
  /** Source ids with a match, best first (confidence, then latest chapter, then priority). */
  ranking: string[];
  durationMs: number;
}

export interface AvailabilityOptions {
  /** Titles used for matching (primary first). */
  titles: string[];
  /** Titles used as search queries (subset of titles, most useful first). */
  queries: string[];
  /** Series format (e.g. "manhwa"); novel editions are demoted unless this is "novel". */
  format?: string;
  providers?: Provider[];
  includeUnavailable?: boolean;
  minScore?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  onSource?: (line: SourceAvailability) => void;
  onSkipped?: (skipped: SkippedSource) => void;
}

/** Read the last health report without triggering a probe. */
async function lastHealth(): Promise<Record<string, SourceHealthResult> | undefined> {
  const entry = await getCache()
    .get<Record<string, SourceHealthResult>>(cacheKey("health", "all"))
    .catch(() => undefined);
  if (!entry) return undefined;
  const ageS = (Date.now() - entry.storedAt) / 1000;
  return ageS <= entry.ttl + entry.swr ? entry.value : undefined;
}

/** After this long without new evidence, a passively-observed block is retried. */
export const BLOCKED_RETRY_MS = 30 * 60_000;

export function sourceState(p: Provider, health?: SourceHealthResult): SourceState {
  if (p.circuit().state === "open") return "failing";
  const m = p.metrics;
  const lastOk = m.lastSuccessAt ? Date.parse(m.lastSuccessAt) : 0;
  const lastBad = m.lastFailureAt ? Date.parse(m.lastFailureAt) : 0;
  const healthAt = health ? Date.parse(health.lastChecked) : 0;
  // The most recent observation wins (live traffic vs. last health probe).
  if (Math.max(lastOk, lastBad) > healthAt) {
    if (lastOk >= lastBad) return "working";
    // Old failures expire so a source that recovered gets another chance.
    if (Date.now() - lastBad > BLOCKED_RETRY_MS) return "unknown";
    return m.lastErrorCode === "UPSTREAM_BLOCKED" ? "blocked" : "failing";
  }
  if (!health) return "unknown";
  if (health.status === "healthy") return "working";
  if (health.status === "cloudflare") return "blocked";
  return "failing";
}

const NOVEL_MARK = /\b(?:light\s+|web\s+)?novels?\b|\bLN\b/i;

/**
 * Sources often list the novel next to the comic ("Solo Leveling (Novel)"),
 * and annotation stripping makes both score 1.0. Unless the series itself is a
 * novel, a novel-marked result is capped below "high" so it never wins.
 */
export function editionPenalty(candidate: string, titles: string[], format?: string): number {
  if (format === "novel") return 1;
  if (!NOVEL_MARK.test(candidate)) return 1;
  if (titles.some((t) => NOVEL_MARK.test(t))) return 1;
  return 0;
}

function toMatch(r: SearchResult, titles: string[], minScore: number, format?: string): AvailabilityMatch | undefined {
  const raw = bestTitleScore(r.title, titles);
  const against = raw.against;
  const score = editionPenalty(r.title, titles, format) ? raw.score : Math.min(raw.score, 0.7);
  const confidence = confidenceFor(score, minScore);
  if (!confidence) return undefined;
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    coverImage: r.coverImage,
    latestChapter: r.latestChapter,
    lastUpdated: r.lastUpdated,
    lastUpdatedTimestamp: r.lastUpdatedTimestamp,
    score,
    confidence,
    matchedAgainst: against,
  };
}

function rankMatches(a: AvailabilityMatch, b: AvailabilityMatch): number {
  return b.score - a.score || (b.latestChapter || 0) - (a.latestChapter || 0);
}

function evaluate(results: SearchResult[], titles: string[], minScore: number, format?: string) {
  const matches = results
    .map((r) => toMatch(r, titles, minScore, format))
    .filter((m): m is AvailabilityMatch => Boolean(m))
    .sort(rankMatches);
  const best = matches.find((m) => m.confidence !== "possible");
  return { best, candidates: matches.filter((m) => m !== best).slice(0, 3) };
}

const CONFIDENCE_ORDER: Record<MatchConfidence, number> = { exact: 2, high: 1, possible: 0 };

export function rankAvailability(lines: SourceAvailability[], providers: Map<string, Provider>): string[] {
  return lines
    .filter((l) => l.available && l.best)
    .sort((a, b) => {
      const ca = CONFIDENCE_ORDER[a.best!.confidence];
      const cb = CONFIDENCE_ORDER[b.best!.confidence];
      if (ca !== cb) return cb - ca;
      const chapters = (b.best!.latestChapter || 0) - (a.best!.latestChapter || 0);
      if (chapters) return chapters;
      if (a.state !== b.state) return a.state === "working" ? -1 : b.state === "working" ? 1 : 0;
      return (providers.get(b.sourceId)?.descriptor.priority ?? 0) - (providers.get(a.sourceId)?.descriptor.priority ?? 0);
    })
    .map((l) => l.sourceId);
}

export async function findAvailability(opts: AvailabilityOptions): Promise<AvailabilitySummary> {
  const started = Date.now();
  const cfg = getConfig();
  const minScore = opts.minScore ?? cfg.availability.minScore;
  const titles = opts.titles.filter((t) => normalizeTitle(t));
  const queries = opts.queries.slice(0, 1 + cfg.availability.maxAltQueries);
  if (!titles.length || !queries.length) {
    throw new DawghwaError("VALIDATION_ERROR", "At least one searchable title is required");
  }

  const health = await lastHealth();
  const candidates = (opts.providers ?? getRegistry().operational()).filter((p) => p.operational);
  const providers: Provider[] = [];
  const skipped: SkippedSource[] = [];
  for (const p of candidates) {
    const state = sourceState(p, health?.[p.id]);
    if (!opts.includeUnavailable && (state === "blocked" || state === "failing")) {
      const s: SkippedSource = {
        sourceId: p.id,
        source: p.name,
        status: p.descriptor.status,
        state,
        reason:
          state === "blocked"
            ? "Source is behind anti-bot protection from this server; set includeUnavailable=true to try anyway"
            : p.circuit().state === "open"
              ? "Source circuit is open after repeated failures"
              : `Source failed recently (${p.metrics.lastErrorCode ?? "error"}); set includeUnavailable=true to try anyway`,
      };
      skipped.push(s);
      opts.onSkipped?.(s);
      continue;
    }
    providers.push(p);
  }
  const byId = new Map(providers.map((p) => [p.id, p]));

  const lines = new Map<string, SourceAvailability>();
  const pending = new Map<string, SourceAvailability>();
  const emit = (line: SourceAvailability) => {
    lines.set(line.sourceId, line);
    opts.onSource?.(line);
  };

  const toLine = (r: StreamingSourceResult, query: string, prev?: SourceAvailability): SourceAvailability => {
    const p = byId.get(r.sourceId)!;
    const { best, candidates: others } = evaluate(r.results, titles, minScore, opts.format);
    const prevCandidates = prev ? [...(prev.best ? [prev.best] : []), ...prev.candidates] : [];
    const state: SourceState = r.error ? (r.errorCode === "UPSTREAM_BLOCKED" ? "blocked" : "failing") : "working";
    return {
      sourceId: p.id,
      source: p.name,
      type: p.descriptor.type,
      status: p.descriptor.status,
      // A source that answered the first query is working even if a later query failed.
      state: prev?.state === "working" ? "working" : state,
      clientOnly: p.capabilities.clientOnly,
      chapterPages: p.capabilities.chapterPages,
      available: Boolean(best),
      best,
      candidates: [...others, ...prevCandidates].sort(rankMatches).slice(0, 3),
      queries: [...(prev?.queries ?? []), query],
      ...(r.error && !best && !prev?.best ? { error: r.error, errorCode: r.errorCode } : {}),
      cached: r.cached,
      durationMs: (prev?.durationMs ?? 0) + r.durationMs,
    };
  };

  // Phase 1: main title on every source.
  const overall = cfg.search.overallTimeoutMs;
  await searchAll(queries[0], {
    providers,
    overallTimeoutMs: overall,
    forceRefresh: opts.forceRefresh,
    signal: opts.signal,
    onResult: (r) => {
      const line = toLine(r, queries[0]);
      if (line.available || line.error || queries.length === 1) emit(line);
      else pending.set(line.sourceId, line);
    },
  });

  // Phase 2: alternative titles, only for sources that worked but had no match.
  for (const query of queries.slice(1)) {
    if (!pending.size || opts.signal?.aborted) break;
    const remaining = overall + 10_000 - (Date.now() - started);
    if (remaining < 2_000) break;
    const retry = [...pending.keys()].map((id) => byId.get(id)!);
    await searchAll(query, {
      providers: retry,
      overallTimeoutMs: remaining,
      forceRefresh: opts.forceRefresh,
      signal: opts.signal,
      onResult: (r) => {
        const prev = pending.get(r.sourceId)!;
        const line = toLine(r, query, prev);
        if (line.available) {
          pending.delete(r.sourceId);
          emit(line);
        } else {
          pending.set(r.sourceId, line);
        }
      },
    });
  }
  for (const line of pending.values()) emit(line);

  const all = [...lines.values()];
  return {
    done: true,
    title: titles[0],
    queries,
    totalSources: providers.length + skipped.length,
    availableSources: all.filter((l) => l.available).length,
    noMatchSources: all.filter((l) => !l.available && !l.error).length,
    failedSources: all.filter((l) => Boolean(l.error)).length,
    skippedSources: skipped.length,
    ranking: rankAvailability(all, byId),
    durationMs: Date.now() - started,
  };
}
