import type { MetadataProviderId, TitleMetadata, TitleSummary } from "@/lib/metadata/types";

/**
 * Provider-neutral catalogue.
 *
 * Clients ask for lists (trending, new, popular, by genre, because you read,
 * a batch of saved titles) and never name a metadata provider. Items use the
 * shared `TitleSummary` shape and carry an opaque `ref` that every
 * `/api/titles/{ref}/...` route accepts. Clients must not parse `ref`.
 *
 * One `CatalogueBackend` serves every list, so refs within the catalogue stay
 * stable. The backend is an internal detail: replacing it changes `ref`
 * values for new rows but not the contract.
 */

export const CATALOGUE_KINDS = ["manga", "manhwa", "manhua"] as const;
/** Reading format: Japanese manga, Korean manhwa, Chinese manhua. */
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];

export const LIST_ORDERS = ["trending", "popular", "score", "newest"] as const;
export type ListOrder = (typeof LIST_ORDERS)[number];

export interface BackendListQuery {
  order: ListOrder;
  kind?: CatalogueKind;
  genre?: string;
  tag?: string;
  /** Inclusive start-date window, `YYYY-MM-DD` (UTC). */
  startedFrom?: string;
  startedTo?: string;
  nsfw: boolean;
  page: number;
  limit: number;
}

export interface CataloguePageInfo {
  page: number;
  limit: number;
  /** Page on this; upstream totals are capped/approximate and are not exposed. */
  hasNextPage: boolean;
}

export interface BackendPage {
  items: TitleSummary[];
  pageInfo: CataloguePageInfo;
}

export interface BackendRecommendations {
  /** The seed as the backend knows it, when it exists there. */
  seed?: TitleSummary;
  items: TitleSummary[];
  pageInfo: CataloguePageInfo;
}

export interface VocabularyEntry {
  name: string;
  group?: string;
  adult: boolean;
}

export interface CatalogueVocabulary {
  genres: VocabularyEntry[];
  tags: VocabularyEntry[];
}

export interface CatalogueAttribution {
  name: string;
  url: string;
}

export interface CatalogueBackend {
  /** The metadata provider whose ids appear in `ref`. */
  readonly id: MetadataProviderId;
  readonly attribution: CatalogueAttribution;
  readonly maxLimit: number;
  /** Highest page * limit the backend can serve. */
  readonly maxDepth: number;
  list(q: BackendListQuery): Promise<BackendPage>;
  /** Summaries for backend ids, in no particular order; unknown ids are absent. */
  byIds(ids: string[]): Promise<TitleSummary[]>;
  recommendations(id: string, q: { page: number; limit: number; nsfw: boolean }): Promise<BackendRecommendations>;
  vocabulary(): Promise<CatalogueVocabulary>;
  /** The backend id a metadata record links to exactly (its own id, or a published cross-reference). */
  linkedId(meta: Pick<TitleMetadata, "provider" | "providerId" | "externalIds">): string | undefined;
}
