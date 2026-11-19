/**
 * Live-verification ledger for the native reader.
 *
 * A provider is listed here only after the full reading path was exercised
 * against the real provider (not fixtures): search/discovery, chapter list,
 * page manifest, image bytes through /api/image, and the app's native reader
 * rendering those images. Evidence points at the live test that proved it.
 * Re-run `npm run test:live` (API) and `npm run e2e:live` (app) before
 * changing an entry. Never add a provider here based on unit tests alone.
 */
export interface ReaderVerification {
  verifiedAt: string;
  search: boolean;
  metadata: boolean;
  chapters: boolean;
  pages: boolean;
  imageDelivery: boolean;
  nativeReader: boolean;
  sample: string;
  evidence: string[];
  limitations: string[];
}

export const READER_VERIFICATION: Record<string, ReaderVerification> = {
  mangadex: {
    verifiedAt: "2026-11-19",
    search: true,
    metadata: true,
    chapters: true,
    pages: true,
    imageDelivery: true,
    nativeReader: true,
    sample: "Aiura (mangadex:814b682b-4405-47f7-b568-19929304df47), chapter 1",
    evidence: ["src/tests/live/reader-providers.live.test.ts", "dawghwa e2e/live-providers.spec.ts"],
    limitations: [
      "Chapters hosted externally or licensed (no pages on MangaDex@Home) are not readable and are excluded.",
      "Chapter list currently requests English translations only.",
    ],
  },
  webtoon: {
    verifiedAt: "2026-11-19",
    search: true,
    metadata: true,
    chapters: true,
    pages: true,
    imageDelivery: true,
    nativeReader: true,
    sample: "unOrdinary (WEBTOON title_no=679), Prologue",
    evidence: ["src/tests/live/reader-providers.live.test.ts", "dawghwa e2e/live-providers.spec.ts"],
    limitations: [
      "Only publicly listed episodes; Daily Pass / Fast Pass / app-only episodes are never requested.",
      "Episode numbers are list positions; chapter numbers come from episode titles when present.",
    ],
  },
  "dynasty-reader": {
    verifiedAt: "2026-11-19",
    search: true,
    metadata: true,
    chapters: true,
    pages: true,
    imageDelivery: true,
    nativeReader: true,
    sample: "Aiura (dynasty-reader:aiura), aiura_ch01",
    evidence: ["src/tests/live/reader-providers.live.test.ts", "dawghwa e2e/live-providers.spec.ts"],
    limitations: ["Catalogue is mostly yuri/doujin; many mainstream titles have no Dynasty match."],
  },
};
