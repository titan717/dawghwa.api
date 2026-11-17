/**
 * Normalized title metadata and catalogue types.
 *
 * Metadata comes from documented public databases (AniList, MangaDex,
 * MangaUpdates), never from the reading sources. A title is addressed by a
 * "ref" of the form `<provider>:<id>`, e.g. `anilist:105398`,
 * `mangadex:32d76d19-8a05-4db0-9fc2-e0b0648fe9d0` or `mangaupdates:15180124327`.
 */

export const METADATA_PROVIDER_IDS = ["anilist", "mangadex", "mangaupdates"] as const;
export type MetadataProviderId = (typeof METADATA_PROVIDER_IDS)[number];

export type TitleFormat = "manga" | "manhwa" | "manhua" | "one_shot" | "novel" | "doujinshi" | "oel" | "other";
export type TitleStatus = "ongoing" | "completed" | "hiatus" | "cancelled" | "upcoming" | "unknown";

export const TITLE_FORMATS: readonly TitleFormat[] = ["manga", "manhwa", "manhua", "one_shot", "novel", "doujinshi", "oel", "other"];
export const TITLE_STATUSES: readonly TitleStatus[] = ["ongoing", "completed", "hiatus", "cancelled", "upcoming", "unknown"];

export interface TitleRef {
  provider: MetadataProviderId;
  id: string;
}

export interface ExternalIds {
  anilist?: number;
  mal?: number;
  mangadex?: string;
  /** Numeric MangaUpdates series id (as a string; it exceeds 2^31). */
  mangaupdates?: string;
}

export interface TitleSummary {
  /** `<provider>:<id>` */
  ref: string;
  provider: MetadataProviderId;
  providerId: string;
  /** Preferred display title (English, then romanized, then native). */
  title: string;
  altTitles: string[];
  url: string;
  coverImage?: string;
  format?: TitleFormat;
  status?: TitleStatus;
  year?: number;
  genres: string[];
  /** Normalized 0-100 score, when the provider has one. */
  score?: number;
  adult: boolean;
  latestChapter?: number;
}

export interface TitleTag {
  name: string;
  /** Relevance 0-100 where the provider ranks tags (AniList). */
  rank?: number;
  spoiler?: boolean;
  group?: string;
}

export interface TitleLink {
  site: string;
  url: string;
  type?: "info" | "official" | "raw" | "tracking" | "other";
}

export interface TitleMetadata extends TitleSummary {
  titles: {
    english?: string;
    romaji?: string;
    native?: string;
  };
  description?: string;
  bannerImage?: string;
  tags: TitleTag[];
  authors: string[];
  artists: string[];
  chapters?: number;
  volumes?: number;
  popularity?: number;
  countryOfOrigin?: string;
  originalLanguage?: string;
  externalIds: ExternalIds;
  links: TitleLink[];
  updatedAt?: string;
}

export type CatalogSort = "relevance" | "popularity" | "score" | "trending" | "updated" | "newest" | "title";
export const CATALOG_SORTS: readonly CatalogSort[] = ["relevance", "popularity", "score", "trending", "updated", "newest", "title"];

export interface CatalogQuery {
  q?: string;
  genres?: string[];
  excludeGenres?: string[];
  tags?: string[];
  status?: TitleStatus;
  format?: TitleFormat;
  year?: number;
  sort?: CatalogSort;
  nsfw?: boolean;
  page: number;
  limit: number;
}

export interface PageInfo {
  page: number;
  limit: number;
  total?: number;
  hasNextPage: boolean;
}

export interface CatalogPage {
  provider: MetadataProviderId;
  items: TitleSummary[];
  pageInfo: PageInfo;
}

export type CatalogFilter = "q" | "genres" | "excludeGenres" | "tags" | "status" | "format" | "year" | "sort" | "nsfw";

export interface CatalogCapabilities {
  filters: CatalogFilter[];
  sorts: CatalogSort[];
  formats: TitleFormat[];
  statuses: TitleStatus[];
  maxLimit: number;
  /** Highest page * limit the provider allows. */
  maxDepth?: number;
}

export interface CatalogFilterOptions {
  provider: MetadataProviderId;
  capabilities: CatalogCapabilities;
  genres: string[];
  tags: { name: string; group?: string; adult?: boolean }[];
}

export interface MetadataAttribution {
  name: string;
  url: string;
  terms: string;
}

export interface MetadataProvider {
  readonly id: MetadataProviderId;
  readonly name: string;
  readonly attribution: MetadataAttribution;
  readonly capabilities: CatalogCapabilities;
  /** Validates and canonicalizes a provider-specific id; throws VALIDATION_ERROR when malformed. */
  parseId(raw: string): string;
  getTitle(id: string): Promise<TitleMetadata>;
  browse(query: CatalogQuery): Promise<CatalogPage>;
  filterOptions(): Promise<CatalogFilterOptions>;
}
