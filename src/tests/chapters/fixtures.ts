import type { TitleMetadata } from "@/lib/metadata/types";

export function meta(over: Partial<TitleMetadata> = {}): TitleMetadata {
  return {
    ref: "mangadex:814b682b-4405-47f7-b568-19929304df47",
    provider: "mangadex",
    providerId: "814b682b-4405-47f7-b568-19929304df47",
    title: "Aiura",
    altTitles: ["あいうら"],
    titles: { english: "Aiura" },
    tags: [],
    genres: [],
    authors: ["Chama"],
    artists: ["Chama"],
    externalIds: {},
    links: [],
    ...over,
  } as TitleMetadata;
}
