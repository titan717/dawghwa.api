/**
 * Normalization of provider records into the canonical catalogue shape and
 * deduplication across providers.
 *
 * Merging is conservative. Two records become one entry only when
 *   1. they share an exact cross-database id the providers published
 *      (MangaDex `links` -> AniList/MAL/MangaUpdates ids, AniList `idMal`), or
 *   2. they come from different providers and have the same normalized title
 *      (titleSimilarity >= 0.96, src/lib/metadata/match), the same start year
 *      and the same type - all three must be known.
 * Any conflicting id of the same kind (two different AniList ids, say) blocks
 * the merge even if everything else agrees. Records from the same provider are
 * never merged by title: the provider itself says they are different series.
 *
 * The canonical id reuses src/lib/identity canonicalTitleId, so a catalogue
 * entry and /api/titles/:ref/identity agree on `dwg:<md|al|mu>:<id>`.
 */

import { canonicalTitleId } from "@/lib/identity";
import { titleSimilarity } from "@/lib/metadata/match";
import type { ExternalIds, MetadataProviderId, TitleSummary } from "@/lib/metadata/types";
import { canonicalGenres } from "./genres";
import type { CatalogEntry, CatalogRecord, RecordMatch } from "./types";

/** Title score needed (with year + type) for a title-based merge. */
export const DEDUP_TITLE_THRESHOLD = 0.96;

const ID_KEYS = ["mangadex", "anilist", "mal", "mangaupdates"] as const;
type IdKey = (typeof ID_KEYS)[number];

/** The record's own id plus every exact cross-reference it carries. */
export function recordIds(s: TitleSummary): ExternalIds {
  const ids: ExternalIds = {};
  for (const k of ID_KEYS) {
    const v = s.externalIds?.[k];
    if (v !== undefined && v !== null && v !== "") (ids as Record<IdKey, unknown>)[k] = v;
  }
  if (s.provider === "mangadex") ids.mangadex = s.providerId.toLowerCase();
  if (s.provider === "anilist" && /^\d+$/.test(s.providerId)) ids.anilist = Number(s.providerId);
  if (s.provider === "mangaupdates") ids.mangaupdates = s.providerId;
  if (ids.mangadex) ids.mangadex = ids.mangadex.toLowerCase();
  return ids;
}

function idValue(ids: ExternalIds, k: IdKey): string | undefined {
  const v = ids[k];
  return v === undefined ? undefined : String(v);
}

/** "match" when an id agrees, "conflict" when an id of the same kind differs, else "none". */
export function compareIds(a: ExternalIds, b: ExternalIds): "match" | "conflict" | "none" {
  let match = false;
  for (const k of ID_KEYS) {
    const x = idValue(a, k);
    const y = idValue(b, k);
    if (x === undefined || y === undefined) continue;
    if (x !== y) return "conflict";
    match = true;
  }
  return match ? "match" : "none";
}

/** Normalize one provider record into a single-record catalogue entry. */
export function normalizeSummary(s: TitleSummary, rank: number): CatalogEntry {
  const externalIds = recordIds(s);
  const record: CatalogRecord = {
    provider: s.provider,
    providerId: s.providerId,
    ref: s.ref,
    url: s.url,
    rank,
    ...(s.score !== undefined ? { score: s.score } : {}),
    match: "self",
  };
  const genres = canonicalGenres(s.genres ?? []);
  const genreKeys = new Set(genres.map((g) => g.toLowerCase()));
  const tags = s.tagNames?.filter((t) => t && !genreKeys.has(t.toLowerCase()));
  const entry: CatalogEntry = {
    id: canonicalTitleId({ provider: s.provider, providerId: s.providerId, externalIds }),
    ref: s.ref,
    title: s.title,
    altTitles: [...s.altTitles],
    genres,
    adult: Boolean(s.adult),
    externalIds,
    providers: [s.provider],
    records: [record],
  };
  if (s.coverImage) entry.coverImage = s.coverImage;
  if (s.format) entry.type = s.format;
  if (s.status && s.status !== "unknown") entry.status = s.status;
  if (s.year) entry.year = s.year;
  if (tags?.length) entry.tags = tags;
  if (s.description) entry.description = s.description;
  if (s.demographic) entry.demographic = s.demographic;
  if (s.latestChapter) entry.latestChapter = s.latestChapter;
  return entry;
}

function titlesOf(e: Pick<CatalogEntry, "title" | "altTitles">): string[] {
  return [e.title, ...e.altTitles].filter(Boolean);
}

function titleMatches(a: CatalogEntry, b: CatalogEntry): boolean {
  const A = titlesOf(a).slice(0, 12);
  const B = titlesOf(b).slice(0, 12);
  for (const x of A) for (const y of B) if (titleSimilarity(x, y) >= DEDUP_TITLE_THRESHOLD) return true;
  return false;
}

/** Why `incoming` (a single-record entry) belongs to `entry`, or undefined if it does not. */
export function matchEntry(entry: CatalogEntry, incoming: CatalogEntry): Exclude<RecordMatch, "self"> | undefined {
  const ids = compareIds(entry.externalIds, incoming.externalIds);
  if (ids === "conflict") return undefined;
  if (ids === "match") return "exact-id";
  const provider = incoming.providers[0];
  if (entry.providers.includes(provider)) return undefined;
  if (!entry.year || !incoming.year || entry.year !== incoming.year) return undefined;
  if (!entry.type || !incoming.type || entry.type !== incoming.type) return undefined;
  return titleMatches(entry, incoming) ? "title-year-type" : undefined;
}

function mergeInto(entry: CatalogEntry, incoming: CatalogEntry, match: Exclude<RecordMatch, "self">): void {
  for (const k of ID_KEYS) {
    if (entry.externalIds[k] === undefined && incoming.externalIds[k] !== undefined) {
      (entry.externalIds as Record<IdKey, unknown>)[k] = incoming.externalIds[k];
    }
  }
  const record = { ...incoming.records[0], match };
  if (!entry.records.some((r) => r.ref === record.ref)) entry.records.push(record);
  if (!entry.providers.includes(record.provider)) entry.providers.push(record.provider);
  const seen = new Set(titlesOf(entry).map((t) => t.toLowerCase()));
  for (const t of titlesOf(incoming)) {
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      entry.altTitles.push(t);
    }
  }
  entry.genres = canonicalGenres([...entry.genres, ...incoming.genres]);
  if (incoming.tags?.length) {
    const keys = new Set(entry.genres.map((g) => g.toLowerCase()));
    const tags = [...new Set([...(entry.tags ?? []), ...incoming.tags])].filter((t) => !keys.has(t.toLowerCase()));
    if (tags.length) entry.tags = tags;
  }
  entry.coverImage ??= incoming.coverImage;
  entry.type ??= incoming.type;
  entry.status ??= incoming.status;
  entry.year ??= incoming.year;
  entry.description ??= incoming.description;
  entry.demographic ??= incoming.demographic;
  if (incoming.latestChapter && (!entry.latestChapter || incoming.latestChapter > entry.latestChapter)) {
    entry.latestChapter = incoming.latestChapter;
  }
  entry.adult = entry.adult || incoming.adult;
}

function finalize(entry: CatalogEntry): CatalogEntry {
  const first = entry.records[0];
  entry.id = canonicalTitleId({ provider: first.provider, providerId: first.providerId, externalIds: entry.externalIds });
  // MangaDex refs resolve to readable chapters directly, so prefer them for detail links.
  entry.ref = entry.records.find((r) => r.provider === "mangadex")?.ref ?? first.ref;
  return entry;
}

export interface ProviderList {
  provider: MetadataProviderId;
  items: TitleSummary[];
}

/**
 * Merge several providers' ordered lists into one deduplicated list.
 *
 * Order: records are interleaved round-robin by their position in each
 * provider's list (rank 0 of every provider, then rank 1, ...), in the order
 * the lists are given. No cross-provider score is invented; each provider's
 * own ordering is preserved.
 */
export function mergeCatalogLists(lists: readonly ProviderList[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const depth = Math.max(0, ...lists.map((l) => l.items.length));
  for (let rank = 0; rank < depth; rank++) {
    for (const list of lists) {
      const s = list.items[rank];
      if (!s) continue;
      const incoming = normalizeSummary(s, rank);
      let merged = false;
      for (const entry of out) {
        if (entry.records.some((r) => r.ref === s.ref)) {
          merged = true;
          break;
        }
        const match = matchEntry(entry, incoming);
        if (match) {
          mergeInto(entry, incoming, match);
          merged = true;
          break;
        }
      }
      if (!merged) out.push(incoming);
    }
  }
  // A later record can carry the id that links two earlier entries (e.g. a
  // MangaDex record pointing at both an AniList and a MangaUpdates entry).
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (compareIds(out[i].externalIds, out[j].externalIds) !== "match") continue;
      for (const r of out[j].records) {
        const single = { ...out[j], records: [r], providers: [r.provider] };
        mergeInto(out[i], single, r.match === "self" ? "exact-id" : r.match);
      }
      out.splice(j, 1);
      j--;
    }
  }
  return out.map(finalize);
}

/** Remove entries already seen on earlier pages (by canonical id or any record ref). */
export function excludeSeen(entries: CatalogEntry[], seen: { ids?: Iterable<string>; refs?: Iterable<string> }): CatalogEntry[] {
  const ids = new Set(seen.ids ?? []);
  const refs = new Set(seen.refs ?? []);
  return entries.filter((e) => !ids.has(e.id) && !e.records.some((r) => refs.has(r.ref)));
}
