/**
 * Provider-neutral catalogue model.
 *
 * A `CatalogEntry` is one series as Dawghwa sees it, independent of which
 * metadata database (AniList, MangaDex, MangaUpdates) listed it. Provider
 * records are normalized into this shape and records that are provably the
 * same series are merged into one entry (see ./dedup.ts). Every merged record
 * is kept in `records` with how it was matched, so nothing is hidden.
 */

import type { ExternalIds, MetadataProviderId, TitleFormat, TitleStatus } from "@/lib/metadata/types";

/** How a provider record was attached to an entry. */
export type RecordMatch =
  /** The first record of the entry. */
  | "self"
  /** Shares an exact cross-database id (MangaDex link, AniList id, MAL id, MangaUpdates id). */
  | "exact-id"
  /**
   * Same normalized title (score >= 0.96), same start year and same type.
   * Used only for list deduplication; it never links reading sources (that
   * needs the stricter corroborated match in src/lib/identity).
   */
  | "title-year-type";

export interface CatalogRecord {
  provider: MetadataProviderId;
  providerId: string;
  /** `<provider>:<id>`, usable with /api/titles/:ref. */
  ref: string;
  url: string;
  /** 0-based position in the provider's own ordering for this request. */
  rank: number;
  /** The provider's own 0-100 score, when it has one. Scales differ between providers. */
  score?: number;
  match: RecordMatch;
}

export interface CatalogEntry {
  /** Canonical id `dwg:<md|al|mu>:<id>` (src/lib/identity canonicalTitleId). */
  id: string;
  /** Preferred ref for detail requests (the first record, or MangaDex when present). */
  ref: string;
  title: string;
  altTitles: string[];
  coverImage?: string;
  /** manga, manhwa, manhua, one_shot, novel, ... */
  type?: TitleFormat;
  status?: TitleStatus;
  year?: number;
  /** Canonical genre names (see ./genres.ts), deduplicated across records. */
  genres: string[];
  /** Non-genre tags, when a provider returned them in the list. */
  tags?: string[];
  description?: string;
  demographic?: string;
  adult: boolean;
  /** Highest latest-chapter number any record reported. */
  latestChapter?: number;
  externalIds: ExternalIds;
  /** Providers listing this entry, in merge order. */
  providers: MetadataProviderId[];
  records: CatalogRecord[];
}
