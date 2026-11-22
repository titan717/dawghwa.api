import { mergeChapters, type Edition, type ProviderChapterInput, type UnifiedChapter } from "@/lib/chapters/merge";

export const CANON = "dwg:md:814b682b-4405-47f7-b568-19929304df47";
export const SECRET = "test-secret-0123456789abcdef-0123456789";

export const PAGE_URL: Record<string, (i: number) => string> = {
  mangadex: (i) => `https://uploads.mangadex.org/data/0123456789abcdef0123/${i + 1}-abc.jpg`,
  "dynasty-reader": (i) => `https://dynasty-scans.com/system/releases/000/001/aiura_ch01/${i + 1}.jpg`,
  webtoon: (i) => `https://webtoon-phinf.pstatic.net/20200101_1/panel_${i + 1}.jpg`,
};

const CHAPTER_URL: Record<string, (n: string, g: string) => string> = {
  mangadex: (n, g) => `https://mangadex.org/chapter/00000000-0000-0000-0000-00000000${n.padStart(2, "0")}${g ? "a" : "0"}${g.length}`,
  "dynasty-reader": (n) => `https://dynasty-scans.com/chapters/aiura_ch${n}`,
  webtoon: (n) => `https://www.webtoons.com/en/drama/aiura/episode-${n}/viewer?title_no=1&episode_no=${n}`,
};

export interface Upload {
  source: keyof typeof PAGE_URL;
  number: string;
  title?: string;
  language?: string;
  group?: string;
  edition?: Edition;
}

/** Real merged rows (src/lib/chapters/merge.ts) from simple provider uploads. */
export function rows(uploads: Upload[]): UnifiedChapter[] {
  const by = new Map<string, ProviderChapterInput>();
  const editions: Record<string, Edition> = { webtoon: "official", mangadex: "scanlation", "dynasty-reader": "scanlation" };
  uploads.forEach((u, i) => {
    const input = by.get(u.source) ?? { sourceId: u.source, source: u.source, edition: u.edition ?? editions[u.source]!, chapters: [] };
    input.chapters.push({
      id: `${u.source}-${u.number}-${u.group ?? ""}-${i}`,
      number: Number(u.number),
      chapterLabel: u.number,
      numberSource: "provider",
      title: u.title,
      url: CHAPTER_URL[u.source]!(u.number, u.group ?? ""),
      language: u.language ?? "en",
      sequence: i,
      ...(u.group ? { group: { id: u.group, name: u.group } } : {}),
    });
    by.set(u.source, input);
  });
  return mergeChapters(CANON, [...by.values()]);
}

export const pagesFor = (source: string, count = 3) =>
  Array.from({ length: count }, (_, i) => ({ index: i, url: PAGE_URL[source]!(i) }));
