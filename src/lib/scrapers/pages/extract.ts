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

/** Resolve one raw image reference to an absolute http(s) URL, or undefined. */
export function resolveImageUrl(raw: string | undefined | null, base: string): URL | undefined {
  if (!raw) return undefined;
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

export function finalizePages(raw: RawPage[], opts: FinalizeOptions): ChapterPage[] {
  const withOrder = raw.every((p) => Number.isFinite(p.order));
  const list = withOrder ? [...raw].sort((a, b) => (a.order as number) - (b.order as number)) : raw;
  const seen = new Set<string>();
  const pages: ChapterPage[] = [];
  const rejected: string[] = [];
  for (const p of list) {
    const u = resolveImageUrl(p.url, opts.base);
    if (!u) continue;
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (opts.allow && !opts.allow(u)) {
      rejected.push(u.hostname);
      continue;
    }
    pages.push({
      index: pages.length,
      url: key,
      ...(p.width && Number.isFinite(p.width) && p.width > 0 ? { width: Math.round(p.width) } : {}),
      ...(p.height && Number.isFinite(p.height) && p.height > 0 ? { height: Math.round(p.height) } : {}),
    });
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
