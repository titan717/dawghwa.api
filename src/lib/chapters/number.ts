/**
 * Chapter number parsing.
 *
 * Provider chapter identifiers are strings ("10", "10.5", "0", "1.10",
 * "Prologue", "Episode 25", "Extra 2", null). Parsing them as floats loses
 * information ("1.10" === "1.1") and invents ordering for specials, so this
 * module keeps the exact digits and classifies the chapter kind separately.
 *
 * Ordering rules (documented in docs/UNIFIED_CHAPTERS.md):
 *   1. prologue
 *   2. regular numbered chapters by (major, minor) where minor is compared as
 *      an integer part number: 10 < 10.1 < 10.5 < 10.10 < 11
 *   3. epilogue
 *   4. unnumbered specials / extras / side stories / oneshots, by provider
 *      sequence then title (stable)
 */

export type ChapterKind = "prologue" | "regular" | "epilogue" | "special" | "oneshot" | "unnumbered";

export interface ParsedChapterNumber {
  kind: ChapterKind;
  /** Canonical number string without leading zeros ("10", "10.5", "0", "0.5"), or null. */
  number: string | null;
  major: number | null;
  /** Fraction digits exactly as written ("5" for 10.5, "10" for 1.10), or null. */
  minor: string | null;
  /** Season marker from labels such as "(S2) Episode 4"; numbers restart per season. */
  season?: number;
  /** How the number was obtained. */
  source: "provider" | "label" | "position" | "none";
}

const NUMBER_RE = /^\s*0*(\d{1,6})(?:[.,](\d{1,4}))?\s*$/;
const PROLOGUE_RE = /\b(?:prologue|prolog|chapter\s*0\s*:\s*prologue)\b/i;
const EPILOGUE_RE = /\bepilogue\b/i;
const SPECIAL_RE = /\b(?:specials?|extras?|bonus|omake|side\s*stor(?:y|ies)|afterwords?|afterstor(?:y|ies)|after\s*story|interludes?|announcements?|notices?|hiatus|q\s*&\s*a|illustrations?|gallery|one[\s-]?shot)\b/i;
const ONESHOT_RE = /\bone[\s-]?shot\b/i;
// "Chapter 12", "Ch. 12.5", "Episode 25", "Ep. 25", "#25", "Vol. 2 Ch. 9"
const LABEL_RE = /(?:^|[\s(\[:,-])(?:chapter|chap|ch|episode|ep|#)\.?\s*0*(\d{1,6})(?:[.,](\d{1,4}))?(?![\d])/i;
const SEASON_RE = /(?:^|[\s(\[])(?:s|season)\s*\.?\s*(\d{1,2})\b(?=[\s)\]:-]|$)/i;

function canonical(major: number, minor: string | null): string {
  return minor !== null && minor !== "" ? `${major}.${minor}` : String(major);
}

/** Parse a raw provider number string. Returns null when it is not a plain number. */
export function parseNumberString(raw: string | null | undefined): { major: number; minor: string | null } | null {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).match(NUMBER_RE);
  if (!m) return null;
  const major = Number(m[1]);
  // "10.0" is chapter 10; "10.50" keeps its digits ("10.50" !== "10.5" as a part number).
  const minor = m[2] !== undefined && !/^0+$/.test(m[2]) ? m[2] : null;
  return { major, minor };
}

function classify(title: string | undefined): ChapterKind | undefined {
  if (!title) return undefined;
  if (PROLOGUE_RE.test(title)) return "prologue";
  if (EPILOGUE_RE.test(title)) return "epilogue";
  if (ONESHOT_RE.test(title)) return "oneshot";
  if (SPECIAL_RE.test(title)) return "special";
  return undefined;
}

/**
 * Parse a provider chapter.
 * @param raw   the provider's chapter number string (MangaDex `attributes.chapter`), if any
 * @param title the provider's chapter title / label
 * @param hint  how the provider produced `raw` (position = invented from list order)
 */
export function parseChapterNumber(
  raw: string | null | undefined,
  title?: string,
  hint: "provider" | "label" | "position" = "provider",
): ParsedChapterNumber {
  const titleKind = classify(title);
  const seasonMatch = title?.match(SEASON_RE);
  const season = seasonMatch ? Number(seasonMatch[1]) : undefined;

  let parsed = hint === "position" ? null : parseNumberString(raw);
  let source: ParsedChapterNumber["source"] = parsed ? hint : "none";
  if (!parsed && title) {
    const m = title.match(LABEL_RE);
    if (m) {
      parsed = { major: Number(m[1]), minor: m[2] !== undefined && !/^0+$/.test(m[2]) ? m[2] : null };
      source = "label";
    }
  }

  if (parsed) {
    // Numbered prologues/epilogues/extras keep their number for ordering and
    // matching; the kind is still reported so the UI can label them.
    // "Bonus Episode 2" / "Special Chapter 10" carry a number but are not chapter 2 / 10.
    const kind: ChapterKind =
      titleKind === "prologue" && parsed.major === 0 && parsed.minor === null
        ? "prologue"
        : titleKind === "special" || titleKind === "oneshot"
          ? titleKind
          : "regular";
    return { kind, number: canonical(parsed.major, parsed.minor), major: parsed.major, minor: parsed.minor, ...(season ? { season } : {}), source };
  }

  return {
    kind: titleKind ?? (hint === "position" ? "unnumbered" : "unnumbered"),
    number: null,
    major: null,
    minor: null,
    ...(season ? { season } : {}),
    source: hint === "position" && raw !== undefined && raw !== null ? "position" : "none",
  };
}

/** Ordering bucket: numbered specials sort next to their number; unnumbered ones go last. */
function bucket(p: ParsedChapterNumber): number {
  if (p.kind === "prologue") return 0;
  if (p.kind === "epilogue" && p.major === null) return 2;
  if (p.major !== null) return 1;
  return p.kind === "unnumbered" ? 4 : 3;
}

/** Within one number: the regular chapter first, then its specials. */
function kindTie(p: ParsedChapterNumber): number {
  return p.kind === "regular" ? 0 : p.kind === "epilogue" ? 1 : 2;
}

export interface SortableChapter {
  parsed: ParsedChapterNumber;
  /** Provider order, used only to keep unnumbered entries stable. */
  sequence?: number;
  title?: string;
  key: string;
}

function minorRank(minor: string | null): number {
  return minor === null ? -1 : Number(minor);
}

/** Deterministic ascending comparator for unified chapters. */
export function compareChapters(a: SortableChapter, b: SortableChapter): number {
  const sa = a.parsed.season ?? 0;
  const sb = b.parsed.season ?? 0;
  const ka = bucket(a.parsed);
  const kb = bucket(b.parsed);
  if (ka !== kb) return ka - kb;
  if (sa !== sb) return sa - sb;
  if (a.parsed.major !== null && b.parsed.major !== null) {
    if (a.parsed.major !== b.parsed.major) return a.parsed.major - b.parsed.major;
    const ma = minorRank(a.parsed.minor);
    const mb = minorRank(b.parsed.minor);
    if (ma !== mb) return ma - mb;
    // "10.5" vs "10.50": same integer part rank, different digits; shorter first.
    const la = a.parsed.minor?.length ?? 0;
    const lb = b.parsed.minor?.length ?? 0;
    if (la !== lb) return la - lb;
    const ta = kindTie(a.parsed);
    const tb = kindTie(b.parsed);
    if (ta !== tb) return ta - tb;
  } else if (a.parsed.major !== null || b.parsed.major !== null) {
    return a.parsed.major !== null ? -1 : 1;
  }
  const qa = a.sequence ?? Number.MAX_SAFE_INTEGER;
  const qb = b.sequence ?? Number.MAX_SAFE_INTEGER;
  if (qa !== qb) return qa - qb;
  return (a.title ?? "").localeCompare(b.title ?? "") || a.key.localeCompare(b.key);
}

/** Human label, e.g. "Chapter 10.5", "Prologue", "Special". */
export function chapterDisplay(parsed: ParsedChapterNumber, title?: string): string {
  const season = parsed.season ? `S${parsed.season} · ` : "";
  if (parsed.number !== null) {
    if (parsed.kind === "prologue") return `${season}Prologue`;
    if (parsed.kind === "special" || parsed.kind === "oneshot") return title || `${season}Special ${parsed.number}`;
    return `${season}Chapter ${parsed.number}`;
  }
  if (parsed.kind === "prologue") return `${season}Prologue`;
  if (parsed.kind === "epilogue") return `${season}Epilogue`;
  if (parsed.kind === "oneshot") return "Oneshot";
  if (parsed.kind === "special") return title || "Special";
  return title || "Untitled chapter";
}
