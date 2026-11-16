import type { ChapterPage, ScrapedChapter, SearchResult } from "@/types";

/**
 * Normalised schemas. Adapters are heterogeneous; these functions guarantee
 * every result leaving the API has the documented shape:
 *  - absolute http(s) URLs
 *  - trimmed non-empty titles
 *  - finite numbers (or the field omitted)
 *  - no duplicate entries
 * Entries that cannot be repaired are dropped (and counted), never invented.
 */

function absolute(url: unknown, base: string): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    const u = new URL(url.trim(), base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function finite(n: unknown): number | undefined {
  const v = typeof n === "string" ? parseFloat(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function text(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t || undefined;
}

export function normalizeSearchResults(
  items: unknown,
  baseUrl: string,
): { results: SearchResult[]; dropped: number } {
  if (!Array.isArray(items)) return { results: [], dropped: 0 };
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  let dropped = 0;
  for (const raw of items as Partial<SearchResult>[]) {
    const url = absolute(raw?.url, baseUrl);
    const title = text(raw?.title);
    if (!url || !title || seen.has(url)) {
      dropped++;
      continue;
    }
    seen.add(url);
    const r: SearchResult = {
      id: raw.id !== undefined && raw.id !== null && String(raw.id) ? String(raw.id) : url,
      title,
      url,
      latestChapter: finite(raw.latestChapter) ?? 0,
      lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated.trim() : "",
    };
    const cover = absolute(raw.coverImage, baseUrl);
    if (cover) r.coverImage = cover;
    const ts = finite(raw.lastUpdatedTimestamp);
    if (ts !== undefined) r.lastUpdatedTimestamp = ts;
    const rating = finite(raw.rating);
    if (rating !== undefined) r.rating = rating;
    if (raw.followers !== undefined && raw.followers !== null && String(raw.followers)) {
      r.followers = String(raw.followers);
    }
    results.push(r);
  }
  return { results, dropped };
}

export function normalizeChapters(
  items: unknown,
  baseUrl: string,
): { chapters: ScrapedChapter[]; dropped: number } {
  if (!Array.isArray(items)) return { chapters: [], dropped: 0 };
  const seen = new Set<string>();
  const chapters: ScrapedChapter[] = [];
  let dropped = 0;
  for (const raw of items as Partial<ScrapedChapter>[]) {
    const url = absolute(raw?.url, baseUrl);
    const number = finite(raw?.number);
    if (!url || number === undefined || seen.has(url)) {
      dropped++;
      continue;
    }
    seen.add(url);
    const c: ScrapedChapter = {
      id: raw.id !== undefined && raw.id !== null && String(raw.id) ? String(raw.id) : String(number),
      number,
      url,
    };
    const title = text(raw.title);
    if (title) c.title = title;
    if (typeof raw.lastUpdated === "string" && raw.lastUpdated.trim()) c.lastUpdated = raw.lastUpdated.trim();
    if (typeof raw.isDownloaded === "boolean") c.isDownloaded = raw.isDownloaded;
    if (raw.group && typeof raw.group === "object" && text(raw.group.name)) {
      c.group = {
        id: String(raw.group.id ?? raw.group.name),
        name: text(raw.group.name)!,
        ...(absolute(raw.group.url, baseUrl) ? { url: absolute(raw.group.url, baseUrl) } : {}),
      };
    }
    chapters.push(c);
  }
  return { chapters, dropped };
}

export function normalizePages(items: unknown): ChapterPage[] {
  if (!Array.isArray(items)) return [];
  return (items as Partial<ChapterPage>[])
    .map((p, i) => ({
      index: finite(p?.index) ?? i,
      url: absolute(p?.url, "https://invalid.local") ?? "",
      ...(finite(p?.width) ? { width: finite(p?.width) } : {}),
      ...(finite(p?.height) ? { height: finite(p?.height) } : {}),
    }))
    .filter((p) => p.url && !p.url.startsWith("https://invalid.local"));
}
