import type { ChapterPage, MangaKind, MangaMetadata, ScrapedChapter, SearchResult } from "@/types";

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
    const metadata = normalizeMetadata(raw.metadata, baseUrl);
    if (metadata) r.metadata = metadata;
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
    if (raw.chapterLabel === null) c.chapterLabel = null;
    else if (typeof raw.chapterLabel === "string" && raw.chapterLabel.trim() && raw.chapterLabel.length <= 32) c.chapterLabel = raw.chapterLabel.trim();
    if (raw.numberSource === "provider" || raw.numberSource === "label" || raw.numberSource === "position") c.numberSource = raw.numberSource;
    const volume = text(raw.volume);
    if (volume && volume.length <= 32) c.volume = volume;
    if (typeof raw.language === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(raw.language.trim())) c.language = raw.language.trim().toLowerCase();
    if (typeof raw.publishedAt === "string" && Number.isFinite(Date.parse(raw.publishedAt))) c.publishedAt = new Date(raw.publishedAt).toISOString();
    const pages = finite(raw.pages);
    if (pages !== undefined && pages >= 0) c.pages = Math.round(pages);
    const sequence = finite(raw.sequence);
    if (sequence !== undefined && sequence > 0) c.sequence = Math.round(sequence);
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

const KINDS: readonly MangaKind[] = ["manga", "manhwa", "manhua", "comic"];

function textList(v: unknown, max = 50, maxLen = 300): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    const t = text(item);
    if (!t || t.length > maxLen) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

/**
 * Sanitise optional descriptive metadata. Unknown keys are dropped, lists are
 * de-duplicated and bounded, numbers must be finite, and the description is
 * kept as plain text (bounded to 4000 characters).
 */
export function normalizeMetadata(raw: unknown, baseUrl: string): MangaMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const out: MangaMetadata = {};
  const lists = ["altTitles", "tags", "genres", "themes", "formats", "authors", "artists", "availableLanguages"] as const;
  for (const key of lists) {
    const v = textList(m[key], key === "altTitles" ? 30 : 60);
    if (v) out[key] = v;
  }
  if (typeof m.description === "string") {
    const d = m.description.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (d) out.description = d.slice(0, 4000);
  }
  for (const key of ["originalLanguage", "demographic", "status", "contentRating", "createdAt", "updatedAt"] as const) {
    const v = text(m[key]);
    if (v && v.length <= 64) out[key] = v;
  }
  if (typeof m.kind === "string" && (KINDS as readonly string[]).includes(m.kind)) out.kind = m.kind as MangaKind;
  if (typeof m.longStrip === "boolean") out.longStrip = m.longStrip;
  const year = finite(m.year);
  if (year !== undefined && year >= 1900 && year <= 2100) out.year = Math.round(year);
  const rating = finite(m.rating);
  if (rating !== undefined && rating >= 0 && rating <= 10) out.rating = Math.round(rating * 100) / 100;
  const follows = finite(m.follows);
  if (follows !== undefined && follows >= 0) out.follows = Math.round(follows);
  const last = finite(m.lastChapter);
  if (last !== undefined && last >= 0) out.lastChapter = last;
  const cover = absolute(m.coverImageLarge, baseUrl);
  if (cover) out.coverImageLarge = cover;
  return Object.keys(out).length ? out : undefined;
}
