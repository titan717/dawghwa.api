/**
 * Shared building blocks for chapter page extraction.
 *
 * Providers deliver pages in very different ways (plain <img> tags, a JSON
 * blob passed to a reader script, framework hydration state, ...). The
 * strategies in ./strategies.ts locate the page list; everything here turns
 * that raw list into the API's normalized, ordered page response and fails
 * loudly instead of returning something wrong:
 *
 *  - no pages                      -> PAGES_NOT_FOUND
 *  - provider marks chapter locked -> CHAPTER_LOCKED   (never bypassed)
 *  - scrambled / encrypted images  -> PAGES_PROTECTED  (never defeated)
 *  - image on an unexpected host   -> PAGE_FORMAT_CHANGED (no silent page drops)
 *  - malformed or plain-http entry -> PAGE_FORMAT_CHANGED (no silent page drops)
 *  - several different page lists  -> PAGE_FORMAT_CHANGED (never guess the chapter)
 */
import { DawghwaError } from "@/lib/core/errors";
import type { ChapterPage } from "@/types";

export interface RawPage {
  url: string | undefined | null;
  width?: number;
  height?: number;
  /** Provider-supplied ordinal; when every page has one, pages are sorted by it. */
  order?: number;
}

export interface FinalizeOptions {
  /** Base URL for resolving relative image paths (usually the chapter URL). */
  base: string;
  /** Provider display name for error messages. */
  source: string;
  /** Allowlist check for page image URLs (see BaseScraper.allowPageImage). */
  allow?: (url: URL) => boolean;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/gi, "/")
    .replace(/&#0?39;/g, "'");

/**
 * Resolve one raw image reference to an absolute URL, or undefined when it is
 * not a usable image reference at all (empty, data:/blob:, unparsable, or a
 * non-web scheme). Protocol-relative references become https. Plain http is
 * returned as-is so finalizePages can refuse it explicitly (page images are
 * HTTPS only).
 */
export function resolveImageUrl(raw: string | undefined | null, base: string): URL | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const s = decodeEntities(raw.trim()).replace(/\\\//g, "/");
  if (!s || s.startsWith("data:") || s.startsWith("blob:")) return undefined;
  try {
    const u = new URL(s.startsWith("//") ? `https:${s}` : s, base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a located page list. Every entry must become a page: an entry with
 * no usable image reference, a plain-http image, or an image on a host the
 * adapter did not declare fails the whole chapter (PAGE_FORMAT_CHANGED) rather
 * than being dropped, because a silently shortened chapter reads as complete.
 * Exact duplicate URLs are collapsed (readers that repeat the list for a
 * preloader); that is the only entry that may disappear.
 */
export function finalizePages(raw: RawPage[], opts: FinalizeOptions): ChapterPage[] {
  const withOrder = raw.length > 0 && raw.every((p) => Number.isFinite(p.order));
  const list = withOrder ? [...raw].sort((a, b) => (a.order as number) - (b.order as number)) : raw;
  const seen = new Set<string>();
  const pages: ChapterPage[] = [];
  const rejected: string[] = [];
  const malformed: number[] = [];
  const insecure: number[] = [];
  list.forEach((p, i) => {
    const u = resolveImageUrl(p.url, opts.base);
    if (!u) return void malformed.push(i);
    if (u.protocol !== "https:") return void insecure.push(i);
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    if (opts.allow && !opts.allow(u)) return void rejected.push(u.hostname);
    pages.push({
      index: pages.length,
      url: key,
      ...(p.width && Number.isFinite(p.width) && p.width > 0 ? { width: Math.round(p.width) } : {}),
      ...(p.height && Number.isFinite(p.height) && p.height > 0 ? { height: Math.round(p.height) } : {}),
    });
  });
  if (malformed.length) {
    throw new DawghwaError(
      "PAGE_FORMAT_CHANGED",
      `${opts.source} returned ${malformed.length} of ${list.length} page entries without a usable image URL`,
      { details: { malformed: malformed.length, total: list.length, positions: malformed.slice(0, 5) } },
    );
  }
  if (insecure.length) {
    throw new DawghwaError(
      "PAGE_FORMAT_CHANGED",
      `${opts.source} served ${insecure.length} page images over plain http; Dawghwa only relays https page images`,
      { details: { insecure: insecure.length, total: list.length } },
    );
  }
  if (rejected.length) {
    // Dropping pages would silently skip part of the chapter. Fail instead so
    // the reader can fall back to another version and the adapter gets fixed.
    throw new DawghwaError(
      "PAGE_FORMAT_CHANGED",
      `${opts.source} served page images from an unexpected host (${[...new Set(rejected)].slice(0, 3).join(", ")})`,
      { details: { hosts: [...new Set(rejected)].slice(0, 5) } },
    );
  }
  if (!pages.length) throw pagesNotFound(opts.source);
  return pages;
}

/**
 * Pick the one page list that belongs to the requested chapter.
 *
 * Framework payloads can embed several candidate lists (the chapter, a
 * preview of the next one, recommendations). Identical copies are collapsed;
 * `belongs` (when given) keeps only lists tied to the requested chapter. If
 * more than one distinct list is left the payload is ambiguous and the
 * request fails instead of guessing (the previous "longest list wins" rule
 * would return another chapter's pages whenever that one was longer).
 */
export function pickChapterList<T>(lists: T[], source: string, belongs?: (list: T) => boolean): T | undefined {
  const distinct = new Map<string, T>();
  for (const l of lists) distinct.set(JSON.stringify(l), l);
  let candidates = [...distinct.values()];
  if (belongs && candidates.length > 1) {
    const matching = candidates.filter(belongs);
    if (matching.length) candidates = matching;
  }
  if (candidates.length > 1) {
    throw new DawghwaError(
      "PAGE_FORMAT_CHANGED",
      `${source} reader data contains ${candidates.length} different page lists; refusing to guess which one is this chapter`,
      { details: { candidates: candidates.length } },
    );
  }
  return candidates[0];
}

export function pagesNotFound(source: string, why = "returned no page images for this chapter"): DawghwaError {
  return new DawghwaError("PAGES_NOT_FOUND", `${source} ${why}`);
}

export function chapterLocked(source: string, why?: string): DawghwaError {
  return new DawghwaError(
    "CHAPTER_LOCKED",
    `${source} has locked this chapter${why ? ` (${why})` : ""}. Dawghwa does not bypass paid, early-access or login-only chapters.`,
    { details: { reason: why ?? "locked" } },
  );
}

export function pagesProtected(source: string, why: string): DawghwaError {
  return new DawghwaError(
    "PAGES_PROTECTED",
    `${source} delivers this chapter as ${why}. Dawghwa does not defeat image protection, so it cannot be read in-app.`,
    { details: { reason: why } },
  );
}

export function formatChanged(source: string, what: string): DawghwaError {
  return new DawghwaError("PAGE_FORMAT_CHANGED", `${source} reader page did not contain ${what}; the provider may have changed its reader`);
}

/**
 * Next.js App Router flight data (`self.__next_f.push([1,"..."])`) decoded and
 * concatenated. Returns "" when the page has none.
 */
export function decodeNextFlight(html: string): string {
  let out = "";
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      out += JSON.parse(`"${m[1]}"`) as string;
    } catch {
      /* a malformed chunk is skipped; the caller validates what it finds */
    }
  }
  return out;
}

/**
 * Parse the JSON value (array or object) that starts at `start` by scanning
 * for its balanced end, honoring strings and escapes. Returns undefined when
 * the text is not valid JSON.
 */
export function parseJsonAt(text: string, start: number): unknown {
  const open = text[start];
  if (open !== "[" && open !== "{") return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Every JSON value that follows `"key":` in `text`. */
export function jsonValuesAfterKey(text: string, key: string): unknown[] {
  const out: unknown[] = [];
  const needle = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*`, "g");
  for (let m = needle.exec(text); m; m = needle.exec(text)) {
    const v = parseJsonAt(text, m.index + m[0].length);
    if (v !== undefined) out.push(v);
  }
  return out;
}

export const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
