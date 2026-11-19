/**
 * Unified chapter merge.
 *
 * Pure and deterministic: given the chapter lists of several providers that
 * are already linked to one canonical title, produce one ordered list where
 * each row is one canonical chapter in one language, with every provider
 * upload of it as a variant.
 *
 * What is merged into one row (all required):
 *   - same canonical chapter number string ("10.5" never joins "10" or "10.50")
 *   - same season marker (or none)
 *   - same translation language (unknown language never joins a known one)
 *   - no volume contradiction (both known and different -> separate rows)
 *   - no title contradiction (both titles meaningful and clearly different)
 *
 * What is never merged across providers:
 *   - unnumbered entries (specials, extras, notices) unless their normalized
 *     titles are identical and meaningful
 *   - chapters whose number was invented from list position
 *
 * Different scanlation groups and editions inside one row are preserved as
 * distinct variants; the row reports how many distinct translations it has.
 */

import { dice, normalizeTitle } from "@/lib/metadata/match";
import { chapterDisplay, compareChapters, parseChapterNumber, type ChapterKind, type ParsedChapterNumber } from "./number";

export type Edition = "official" | "scanlation" | "unknown";

export interface ProviderChapterInput {
  sourceId: string;
  source: string;
  edition: Edition;
  chapters: {
    id: string;
    number: number;
    chapterLabel?: string | null;
    numberSource?: "provider" | "label" | "position";
    title?: string;
    url: string;
    volume?: string;
    language?: string;
    publishedAt?: string;
    lastUpdated?: string;
    pages?: number;
    sequence?: number;
    group?: { id: string; name: string; url?: string };
  }[];
}

export type VariantMatch = "exact" | "number" | "source-only";

export interface ChapterVariant {
  /** `<sourceId>:<providerChapterId>`, unique across the response. */
  variantId: string;
  sourceId: string;
  source: string;
  providerChapterId: string;
  url: string;
  language: string | null;
  edition: Edition;
  group?: { id: string; name: string; url?: string };
  title?: string;
  volume?: string;
  originalNumber: string | null;
  publishedAt?: string;
  lastUpdated?: string;
  pages?: number;
  /** How this variant was attached to the row. */
  match: VariantMatch;
}

export interface UnifiedChapter {
  /** Stable canonical chapter id: `<canonicalTitleId>/<lang>/<s?>/<kind>:<number|slug>`. */
  key: string;
  canonicalTitleId: string;
  kind: ChapterKind;
  /** Canonical number string or null (never a lossy float). */
  number: string | null;
  /** Float for legacy clients; 0 when unnumbered. */
  numberValue: number;
  season?: number;
  volume?: string;
  title?: string;
  display: string;
  language: string | null;
  /** Earliest known publication. */
  publishedAt?: string;
  /** Distinct translation groups among the variants. */
  translations: number;
  variants: ChapterVariant[];
  /** Index in the ascending order (stable). */
  order: number;
}

/** Titles providers put on chapters that carry no information ("Episode 12", "Ch. 3"). */
export function meaningfulTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const n = normalizeTitle(title)
    .replace(/\b(?:chapter|chap|ch|episode|ep|vol|volume|season|s)\b\s*\d*(?:\s\d+)?/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n.length >= 3 ? n : undefined;
}

function titlesConflict(a: string | undefined, b: string | undefined): boolean {
  const ma = meaningfulTitle(a);
  const mb = meaningfulTitle(b);
  if (!ma || !mb) return false;
  if (ma === mb || ma.includes(mb) || mb.includes(ma)) return false;
  return dice(ma.replace(/ /g, ""), mb.replace(/ /g, "")) < 0.45;
}

function slug(s: string): string {
  return normalizeTitle(s).replace(/ /g, "-").slice(0, 48) || "untitled";
}

interface Row {
  base: string;
  parsed: ParsedChapterNumber;
  language: string | null;
  volume?: string;
  title?: string;
  sequence?: number;
  variants: ChapterVariant[];
}

/**
 * Merge per-provider chapter lists. Provider order in `inputs` only affects
 * tie-breaks of display fields (first non-empty title wins) and is itself
 * sorted by sourceId, so the result does not depend on response arrival order.
 */
export function mergeChapters(canonicalTitleId: string, inputs: ProviderChapterInput[]): UnifiedChapter[] {
  const sorted = [...inputs].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const rows = new Map<string, Row[]>();
  const order: Row[] = [];

  for (const input of sorted) {
    for (const ch of input.chapters) {
      const raw =
        ch.chapterLabel !== undefined
          ? ch.chapterLabel
          : ch.numberSource === "position"
            ? null
            : Number.isFinite(ch.number) && ch.number > 0
              ? String(ch.number)
              : null;
      const hint = ch.numberSource === "position" ? "position" : ch.numberSource === "label" ? "label" : "provider";
      const parsed = parseChapterNumber(raw, ch.title, hint);
      const language = ch.language ?? null;
      const variant: ChapterVariant = {
        variantId: `${input.sourceId}:${ch.id}`,
        sourceId: input.sourceId,
        source: input.source,
        providerChapterId: ch.id,
        url: ch.url,
        language,
        edition: input.edition,
        ...(ch.group ? { group: ch.group } : {}),
        ...(ch.title ? { title: ch.title } : {}),
        ...(ch.volume ? { volume: ch.volume } : {}),
        originalNumber: raw ?? null,
        ...(ch.publishedAt ? { publishedAt: ch.publishedAt } : {}),
        ...(ch.lastUpdated ? { lastUpdated: ch.lastUpdated } : {}),
        ...(ch.pages !== undefined ? { pages: ch.pages } : {}),
        match: "source-only",
      };

      const lang = language ?? "und";
      const season = parsed.season ? `s${parsed.season}` : "s0";
      let base: string;
      if (parsed.number !== null) base = `${lang}/${season}/${parsed.kind === "regular" ? "ch" : parsed.kind}:${parsed.number}`;
      else if (meaningfulTitle(ch.title)) base = `${lang}/${season}/${parsed.kind}:${slug(meaningfulTitle(ch.title)!)}`;
      else base = `${lang}/${season}/${parsed.kind}:${input.sourceId}-${ch.id}`;

      const candidates = rows.get(base) ?? [];
      const target = candidates.find(
        (r) =>
          !(r.volume && ch.volume && r.volume !== ch.volume) &&
          !titlesConflict(r.title, ch.title) &&
          // Same provider + same group twice means the provider lists two
          // different entries (e.g. a re-release or a part 2): keep them apart.
          !r.variants.some((v) => v.sourceId === input.sourceId && (v.group?.id ?? "") === (ch.group?.id ?? "")),
      );
      if (target) {
        variant.match = parsed.number !== null && meaningfulTitle(target.title) && meaningfulTitle(ch.title) ? "exact" : parsed.number !== null ? "number" : "exact";
        if (target.variants.length === 1 && target.variants[0]!.match === "source-only") target.variants[0]!.match = variant.match;
        target.variants.push(variant);
        if (!target.title && ch.title) target.title = ch.title;
        if (!target.volume && ch.volume) target.volume = ch.volume;
        continue;
      }
      // A conflicting row with the same base gets a distinguishing suffix.
      const key = candidates.length ? `${base}~${input.sourceId}-${ch.id}` : base;
      const row: Row = {
        base: key,
        parsed,
        language,
        ...(ch.volume ? { volume: ch.volume } : {}),
        ...(ch.title ? { title: ch.title } : {}),
        ...(ch.sequence !== undefined ? { sequence: ch.sequence } : {}),
        variants: [variant],
      };
      candidates.push(row);
      rows.set(base, candidates);
      order.push(row);
    }
  }

  const unified = order
    .map((r) => ({ r, sort: { parsed: r.parsed, sequence: r.sequence, title: r.title, key: r.base } }))
    .sort((a, b) => compareChapters(a.sort, b.sort) || (a.r.language ?? "").localeCompare(b.r.language ?? ""))
    .map(({ r }, index): UnifiedChapter => {
      r.variants.sort(
        (a, b) => a.sourceId.localeCompare(b.sourceId) || (a.group?.name ?? "").localeCompare(b.group?.name ?? "") || a.providerChapterId.localeCompare(b.providerChapterId),
      );
      const dates = r.variants.map((v) => v.publishedAt).filter((d): d is string => Boolean(d)).sort();
      const groups = new Set(r.variants.map((v) => `${v.sourceId}|${v.group?.id ?? v.edition}`));
      return {
        key: `${canonicalTitleId}/${r.base}`,
        canonicalTitleId,
        kind: r.parsed.kind,
        number: r.parsed.number,
        numberValue: r.parsed.major !== null ? Number(r.parsed.number) : 0,
        ...(r.parsed.season ? { season: r.parsed.season } : {}),
        ...(r.volume ? { volume: r.volume } : {}),
        ...(r.title ? { title: r.title } : {}),
        display: chapterDisplay(r.parsed, r.title),
        language: r.language,
        ...(dates[0] ? { publishedAt: dates[0] } : {}),
        translations: groups.size,
        variants: r.variants,
        order: index,
      };
    });
  return unified;
}

export type FallbackVerdict =
  | { ok: true; automatic: boolean; reason: string; differences: string[] }
  | { ok: false; reason: string };

/**
 * Is `candidate` an acceptable replacement for `failed`? Both must be
 * variants of the same unified row. Automatic fallback requires the same
 * language and edition; a different scanlation group is allowed but reported.
 */
export function fallbackCompatibility(row: UnifiedChapter, failed: ChapterVariant, candidate: ChapterVariant): FallbackVerdict {
  if (!row.variants.includes(failed) || !row.variants.includes(candidate)) {
    return { ok: false, reason: "Not the same canonical chapter" };
  }
  if (candidate.variantId === failed.variantId) return { ok: false, reason: "Same variant" };
  if (candidate.language !== failed.language || candidate.language === null) {
    return { ok: false, reason: "Different or unknown language" };
  }
  const differences: string[] = [];
  if (candidate.sourceId !== failed.sourceId) differences.push("source");
  if ((candidate.group?.id ?? "") !== (failed.group?.id ?? "")) differences.push("translation group");
  if (candidate.edition !== failed.edition) differences.push("edition");
  if (candidate.match === "source-only") return { ok: false, reason: "Variant match is unverified" };
  const automatic = !differences.includes("edition");
  return { ok: true, automatic, reason: automatic ? "Same chapter and language" : "Same chapter and language, different edition", differences };
}
