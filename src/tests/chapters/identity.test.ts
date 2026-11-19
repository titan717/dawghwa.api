import { describe, expect, it } from "vitest";
import { buildCanonicalTitle, canonicalTitleId, exactProviderLinks, LINK_THRESHOLDS, normalizePerson, scoreCandidate } from "@/lib/identity";
import type { TitleMetadata } from "@/lib/metadata/types";
import { meta } from "./fixtures";

const cand = (over: Record<string, unknown> = {}) => ({ sourceId: "dynasty-reader", source: "Dynasty", providerTitleId: "aiura", url: "https://dynasty-scans.com/series/aiura", title: "Aiura", authors: ["Chama"], ...over });

describe("canonical identity", () => {
  it("derives a deterministic id from the strongest identifier", () => {
    expect(canonicalTitleId(meta())).toBe("dwg:md:814b682b-4405-47f7-b568-19929304df47");
    expect(canonicalTitleId({ provider: "anilist", providerId: "1", externalIds: { mangadex: "ABC" } })).toBe("dwg:md:abc");
    expect(canonicalTitleId({ provider: "anilist", providerId: "105398", externalIds: {} })).toBe("dwg:al:105398");
    expect(canonicalTitleId({ provider: "mangaupdates", providerId: "x1", externalIds: {} })).toBe("dwg:mu:x1");
  });

  it("uses exact MangaDex and official WEBTOON links without searching", () => {
    const links = exactProviderLinks(
      meta({ links: [{ site: "WEBTOON", url: "https://www.webtoons.com/en/romance/lore-olympus/list?title_no=1320" }] } as Partial<TitleMetadata>),
      [{ id: "mangadex", name: "MangaDex" }, { id: "webtoon", name: "WEBTOON" }],
    );
    expect(links.map((l) => [l.sourceId, l.providerTitleId, l.evidence.method])).toEqual([
      ["mangadex", "814b682b-4405-47f7-b568-19929304df47", "exact-id"],
      ["webtoon", "1320", "exact-link"],
    ]);
  });

  it("ignores WEBTOON links that are not series list pages", () => {
    const links = exactProviderLinks(
      meta({ links: [{ site: "x", url: "https://www.webtoons.com/en/romance/lore-olympus/ep-1/viewer?title_no=1320&episode_no=1" }, { site: "y", url: "https://evil.example/list?title_no=1" }] } as Partial<TitleMetadata>),
      [{ id: "webtoon", name: "WEBTOON" }],
    );
    expect(links).toEqual([]);
  });
});

describe("scoreCandidate", () => {
  const c = buildCanonicalTitle(meta());

  it("links when title and author agree, with explainable evidence", () => {
    const e = scoreCandidate(c, cand());
    expect(e.decision).toBe("linked");
    expect(e.reason).toMatch(/Title and author/);
    expect(e.signals.find((s) => s.name === "author")?.effect).toBe(1);
  });

  it("never links on title similarity alone", () => {
    expect(scoreCandidate(c, cand({ authors: undefined })).decision).toBe("review");
    expect(scoreCandidate(c, cand({ authors: [] })).decision).toBe("review");
  });

  it("rejects contradicting authors even with an identical title", () => {
    const e = scoreCandidate(c, cand({ authors: ["Somebody Else"] }));
    expect(e.decision).toBe("rejected");
  });

  it("rejects novel editions and distant years", () => {
    expect(scoreCandidate(c, cand({ title: "Aiura (Novel)" })).decision).toBe("rejected");
    expect(scoreCandidate(buildCanonicalTitle(meta({ year: 2010 })), cand({ year: 2020 })).decision).toBe("rejected");
  });

  it("does not link dissimilar titles even with the same author", () => {
    expect(scoreCandidate(c, cand({ title: "A Completely Different Series" })).decision).not.toBe("linked");
  });

  it("is deterministic and pins thresholds", () => {
    expect(scoreCandidate(c, cand())).toEqual(scoreCandidate(c, cand()));
    expect(LINK_THRESHOLDS).toEqual({ title: 0.9, review: 0.75 });
  });

  it("normalizes person names across formats", () => {
    expect(normalizePerson("Kitazawa, Akari")).toBe(normalizePerson("Akari KITAZAWA"));
    expect(normalizePerson("AOI (あおい)")).toBe(normalizePerson("Aoi"));
  });
});
