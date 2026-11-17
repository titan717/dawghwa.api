export interface ScanlationGroup {
  id: string;
  name: string;
  url?: string;
}

export interface ScrapedChapter {
  id: string;
  number: number;
  title?: string;
  url: string;
  isDownloaded?: boolean;
  lastUpdated?: string;
  group?: ScanlationGroup;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  coverImage?: string;
  latestChapter: number;
  lastUpdated: string;
  lastUpdatedTimestamp?: number;
  rating?: number;
  followers?: string;
  /** Descriptive metadata, when the provider's documented API supplies it. */
  metadata?: MangaMetadata;
}

export type SourceType = "scanlator" | "aggregator";

export interface SourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  description?: string;
  clientOnly?: boolean;
  type: SourceType;
}

export interface FrontpageManga {
  id: string;
  title: string;
  url: string;
  coverImage?: string;
  latestChapter?: number;
  lastUpdated?: string;
  lastUpdatedTimestamp?: number;
  rating?: number;
  followers?: string;
  type?: string; // manga, manhwa, manhua, etc.
  status?: string;
  synopsis?: string;
}

export type FrontpageSectionType =
  | "trending"
  | "most_followed"
  | "latest_hot"
  | "latest_new"
  | "recently_added"
  | "completed";

export interface FrontpageSection {
  id: string;
  title: string;
  type: FrontpageSectionType;
  items: FrontpageManga[];
  supportsPagination: boolean;
  supportsTimeFilter: boolean;
  availableTimeFilters?: number[]; // days: 1, 7, 30, 90, 180, 365
}

export interface FrontpageData {
  source: string;
  sections: FrontpageSection[];
  fetchedAt: number;
}

export interface FrontpageInfo {
  sourceId: string;
  sourceName: string;
  availableSections: {
    id: string;
    title: string;
    type: FrontpageSectionType;
    supportsTimeFilter: boolean;
    availableTimeFilters?: number[];
  }[];
}

/** One page (image) of a chapter, as provided by a documented provider API. */
export interface ChapterPage {
  index: number;
  url: string;
  width?: number;
  height?: number;
}

/** Publication format derived from the original language (MangaDex `originalLanguage`). */
export type MangaKind = "manga" | "manhwa" | "manhua" | "comic";

/**
 * Optional descriptive metadata. Only filled by adapters whose provider returns
 * it from a documented API (currently MangaDex). Fields are omitted, never
 * guessed, when the provider does not supply them.
 */
export interface MangaMetadata {
  altTitles?: string[];
  description?: string;
  /** All tag names (genres + themes + formats). */
  tags?: string[];
  genres?: string[];
  themes?: string[];
  formats?: string[];
  kind?: MangaKind;
  /** True when the provider marks the title as a vertical long strip (webtoon style). */
  longStrip?: boolean;
  originalLanguage?: string;
  demographic?: string;
  status?: string;
  year?: number;
  contentRating?: string;
  authors?: string[];
  artists?: string[];
  /** Provider rating on a 0-10 scale (MangaDex bayesian rating). */
  rating?: number;
  follows?: number;
  coverImageLarge?: string;
  /** Languages with available translated chapters. */
  availableLanguages?: string[];
  lastChapter?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type BrowseOrder = "popular" | "rating" | "latest" | "new" | "relevance" | "year";

export interface BrowseQuery {
  query?: string;
  includedTags?: string[];
  excludedTags?: string[];
  /** "and" (default): every included tag must match; "or": any of them. */
  includedTagsMode?: "and" | "or";
  kinds?: MangaKind[];
  status?: string[];
  demographic?: string[];
  year?: number;
  createdWithinDays?: number;
  order?: BrowseOrder;
  offset?: number;
  limit?: number;
  withStats?: boolean;
}

export interface BrowseItem extends SearchResult {
  metadata?: MangaMetadata;
}

export interface BrowseResult {
  items: BrowseItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface BrowseVocabulary {
  tags: { name: string; group: string }[];
  kinds: MangaKind[];
  status: string[];
  demographic: string[];
  orders: BrowseOrder[];
  maxOffset: number;
  maxLimit: number;
}
