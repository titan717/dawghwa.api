/**
 * Canonical chapter resolution for GET /api/v2/chapter.
 *
 * canonical title + chapter number + language
 *   -> merged chapter row (existing unified aggregation, cached and coalesced)
 *   -> versions (row variants) in a stable order
 *   -> first version whose page manifest loads, skipping sources whose v2
 *      breaker is open, falling back automatically to the next compatible one
 *   -> pages as image URLs (opaque tokens when IMAGE_PROXY is on)
 *
 * Nothing that identifies a provider is returned; see docs/API_V2.md.
 */

import { cacheKey, getCache } from "@/lib/core/cache";
import { DawghwaError, isSourceFailure, toDawghwaError } from "@/lib/core/errors";
import { parseNumberString } from "@/lib/chapters/number";
import type { ChapterVariant, Edition, UnifiedChapter } from "@/lib/chapters/merge";
import { getTitleMetadata, parseTitleRef } from "@/lib/metadata";
import type { TitleMetadata, TitleRef } from "@/lib/metadata/types";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import { getChapterPages } from "@/lib/services/catalog";
import { aggregateChapters } from "@/lib/services/unified";
import type { ChapterPage } from "@/types";
import { v2Breakers, type SourceBreakers } from "./breaker";
import { imageProxySettings } from "./config";
import { scrubText } from "./leak";
import { v2Pacer, type HostPacer } from "./pacer";
import { signImageToken } from "./token";

/** Client-facing failure: the body is always generic. */
export class V2Error extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage = "Chapter unavailable",
    readonly retryAfter?: number,
  ) {
    super(publicMessage);
    this.name = "V2Error";
  }
}

export interface ChapterQuery {
  title: string;
  n: string;
  lang: string;
  /** Version index to start from ("Try another version"). */
  alt?: number;
}

export interface V2Page {
  index: number;
  url: string;
  width?: number;
  height?: number;
}

export interface V2ChapterResponse {
  title: string;
  chapter: { number: string; display: string; title?: string; volume?: string; language: string };
  pages: V2Page[];
  totalPages: number;
  version: { index: number; count: number; next: number | null; edition: Edition };
  /** ISO time after which page URLs stop working (only with the image proxy). */
  pagesExpireAt?: string;
}

export interface ResolveDeps {
  loadMeta?: (ref: TitleRef) => Promise<TitleMetadata>;
  aggregate?: (meta: TitleMetadata) => Promise<{ title: { id: string }; chapters: UnifiedChapter[] }>;
  loadPages?: (provider: Provider, variant: ChapterVariant) => Promise<ChapterPage[]>;
  breakers?: SourceBreakers;
  pacer?: HostPacer;
  /** Longest a manifest request may wait for its host slot. */
  pacingMaxWaitMs?: number;
  providerFor?: (sourceId: string) => Provider | undefined;
  origin: string;
  now?: () => number;
  signal?: AbortSignal;
}

/** `dwg:md:<uuid>` / `dwg:al:<id>` / `dwg:mu:<id>` (canonical ids) or a metadata ref (`al:105398`). */
export function parseCanonicalTitle(raw: string): TitleRef {
  const v = raw.trim();
  if (!v || v.length > 96) throw new V2Error(400);
  const m = v.match(/^dwg:(md|al|mu):(.+)$/i);
  try {
    return parseTitleRef(m ? `${m[1]!.toLowerCase()}:${m[2]}` : v);
  } catch {
    throw new V2Error(400);
  }
}

/** Canonical chapter number string ("10", "10.5"), or null when not a plain number. */
export function canonicalNumber(raw: string): string | null {
  const p = parseNumberString(raw);
  if (!p) return null;
  return p.minor ? `${p.major}.${p.minor}` : String(p.major);
}

const MATCH_RANK: Record<ChapterVariant["match"], number> = { exact: 0, number: 1, "source-only": 2 };
const EDITION_RANK: Record<Edition, number> = { official: 0, scanlation: 1, unknown: 2 };

/**
 * Stable version order for a row (independent of breaker state, so `alt`
 * indices keep meaning the same version between calls): verified cross-source
 * matches first, official editions before scanlations, then provider
 * priority, then variant id.
 */
export function orderVersions(variants: ChapterVariant[], priorityOf: (sourceId: string) => number): ChapterVariant[] {
  return [...variants].sort(
    (a, b) =>
      MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
      EDITION_RANK[a.edition] - EDITION_RANK[b.edition] ||
      priorityOf(b.sourceId) - priorityOf(a.sourceId) ||
      a.variantId.localeCompare(b.variantId),
  );
}

/**
 * Which versions may be tried, in order, for one request.
 *
 * Automatic (no alt): the anchor (first version) then only versions that are
 * a safe silent replacement: same known language and edition, and a verified
 * cross-source match (a `source-only` version is allowed only from the
 * anchor's own source, where same number + language is the same chapter).
 * With alt=k the user asked for another version: k, k+1, ... any edition.
 * Sources whose breaker is open are skipped; half-open ones go last.
 */
export function attemptPlan(ordered: ChapterVariant[], alt: number | undefined, breakers: SourceBreakers): ChapterVariant[] {
  let plan: ChapterVariant[];
  if (alt === undefined) {
    const anchor = ordered[0];
    if (!anchor) return [];
    plan = [
      anchor,
      ...ordered
        .slice(1)
        .filter(
          (c) =>
            c.language !== null &&
            c.language === anchor.language &&
            c.edition === anchor.edition &&
            (c.match !== "source-only" || c.sourceId === anchor.sourceId),
        ),
    ];
  } else {
    plan = ordered.slice(alt);
  }
  return breakers.order(plan, (v) => v.sourceId);
}

function pickRow(chapters: UnifiedChapter[], number: string, lang: string): UnifiedChapter | undefined {
  const rows = chapters.filter((c) => c.number === number && c.language === lang && c.kind === "regular");
  // Several rows (volume/title conflicts) are possibly different chapters: serve the one with most versions.
  return rows.sort((a, b) => b.variants.length - a.variants.length || a.order - b.order)[0];
}

async function defaultLoadPages(provider: Provider, variant: ChapterVariant, pacer: HostPacer, maxWaitMs: number, signal?: AbortSignal) {
  const ref = { chapterId: variant.providerChapterId, url: variant.url };
  // Pace only when the manifest really goes upstream (fresh cache hits do not).
  const entry = await getCache().get(cacheKey("pages", provider.id, ref.url ?? ref.chapterId, "full"));
  const fresh = entry && (Date.now() - entry.storedAt) / 1000 < entry.ttl;
  if (!fresh) {
    let host: string;
    try {
      host = new URL(variant.url).hostname;
    } catch {
      host = `source:${provider.id}`;
    }
    if (!(await pacer.wait(host, maxWaitMs, signal))) {
      throw new DawghwaError("SOURCE_UNAVAILABLE", "pacing slot unavailable", { retryable: true });
    }
  }
  return (await getChapterPages(provider, ref)).pages;
}

export function pageUrl(provider: Provider, upstream: URL, origin: string, nowMs: number): { url: string; exp?: number } {
  const s = imageProxySettings();
  if (s.enabled && s.secret) {
    const { token, exp } = signImageToken({ sourceId: provider.id, url: upstream.toString() }, s.secret, s.ttlSeconds, nowMs);
    return { url: new URL(`/api/v2/img/${token}`, origin).toString(), exp };
  }
  // IMAGE_PROXY off: the existing relay, exactly as POST /api/pages issues it.
  const image = new URL("/api/image", origin);
  image.searchParams.set("url", upstream.toString());
  image.searchParams.set("source", provider.id);
  return { url: image.toString() };
}

export async function resolveChapter(q: ChapterQuery, deps: ResolveDeps): Promise<V2ChapterResponse> {
  const ref = parseCanonicalTitle(q.title);
  const number = canonicalNumber(q.n);
  if (number === null) throw new V2Error(400);
  const lang = q.lang.toLowerCase();
  const breakers = deps.breakers ?? v2Breakers();
  const pacer = deps.pacer ?? v2Pacer();
  const providerFor = deps.providerFor ?? ((id: string) => getRegistry().get(id));
  const now = deps.now ?? Date.now;

  let meta: TitleMetadata;
  try {
    meta = deps.loadMeta ? await deps.loadMeta(ref) : (await getTitleMetadata(ref, { enrich: true })).title;
  } catch (e) {
    const err = toDawghwaError(e);
    throw new V2Error(err.status === 404 ? 404 : 502);
  }
  let aggregated: { title: { id: string }; chapters: UnifiedChapter[] };
  try {
    aggregated = deps.aggregate ? await deps.aggregate(meta) : await aggregateChapters(meta, { signal: deps.signal });
  } catch {
    throw new V2Error(502);
  }
  const row = pickRow(aggregated.chapters, number, lang);
  if (!row) throw new V2Error(404);

  const ordered = orderVersions(row.variants, (id) => providerFor(id)?.descriptor.priority ?? 0);
  if (q.alt !== undefined && q.alt >= ordered.length) throw new V2Error(404);
  const plan = attemptPlan(ordered, q.alt, breakers);

  for (const variant of plan) {
    if (deps.signal?.aborted) throw new V2Error(499);
    const provider = providerFor(variant.sourceId);
    if (!provider || !provider.operational || !provider.capabilities.chapterPages) continue;
    if (!breakers.tryAcquire(provider.id)) continue;
    let pages: ChapterPage[];
    try {
      pages = deps.loadPages
        ? await deps.loadPages(provider, variant)
        : await defaultLoadPages(provider, variant, pacer, deps.pacingMaxWaitMs ?? 5_000, deps.signal);
      if (!pages.length) throw new DawghwaError("PAGES_NOT_FOUND", "empty");
      // Every page must be an image the relay will serve; otherwise this version fails closed.
      const allowed = pages.map((p) => provider.scraper.allowPageImage(p.url));
      if (allowed.some((u) => !u)) throw new DawghwaError("PAGE_FORMAT_CHANGED", "page outside declared hosts");
      const t = now();
      let exp: number | undefined;
      const out: V2Page[] = pages.map((p, i) => {
        const r = pageUrl(provider, allowed[i]!, deps.origin, t);
        if (r.exp !== undefined) exp = r.exp;
        return { index: i, url: r.url, ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}) };
      });
      breakers.success(provider.id);
      const index = ordered.indexOf(variant);
      return {
        title: aggregated.title.id,
        chapter: {
          number,
          display: `Chapter ${number}`,
          ...(scrubText(row.title) ? { title: scrubText(row.title) } : {}),
          ...(row.volume ? { volume: row.volume } : {}),
          language: lang,
        },
        pages: out,
        totalPages: out.length,
        version: { index, count: ordered.length, next: ordered.length > 1 ? (index + 1) % ordered.length : null, edition: variant.edition },
        ...(exp !== undefined ? { pagesExpireAt: new Date(exp * 1000).toISOString() } : {}),
      };
    } catch (e) {
      const err = toDawghwaError(e);
      if (isSourceFailure(err) || err.code === "PAGE_FORMAT_CHANGED") breakers.failure(provider.id);
      else breakers.neutral(provider.id);
      // 403 / challenge / any failure: move on to the next version. Never retried another way.
    }
  }
  throw new V2Error(plan.length ? 502 : 503);
}
