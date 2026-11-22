import { describe, expect, it } from "vitest";
import {
  canonicalGenres,
  compareIds,
  excludeSeen,
  genreKey,
  mergeCatalogLists,
  normalizeSummary,
  recordIds,
  resolveGenre,
} from "@/lib/catalog";
import type { TitleSummary } from "@/lib/metadata/types";
import { canonicalTitleId } from "@/lib/identity";

const MD = "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0";

function al(id: number, title: string, extra: Partial<TitleSummary> = {}): TitleSummary {
  return {
    ref: `anilist:${id}`,
    provider: "anilist",
    providerId: String(id),
    title,
    altTitles: [],
    url: `https://anilist.co/manga/${id}`,
    genres: [],
    adult: false,
    externalIds: { anilist: id },
    ...extra,
  };
}

function md(id: string, title: string, extra: Partial<TitleSummary> = {}): TitleSummary {
  return {
    ref: `mangadex:${id}`,
    provider: "mangadex",
    providerId: id,
    title,
    altTitles: [],
    url: `https://mangadex.org/title/${id}`,
    genres: [],
    adult: false,
    externalIds: { mangadex: id },
    ...extra,
  };
}

function mu(id: string, title: string, extra: Partial<TitleSummary> = {}): TitleSummary {
  return {
    ref: `mangaupdates:${id}`,
    provider: "mangaupdates",
    providerId: id,
    title,
    altTitles: [],
    url: `https://www.mangaupdates.com/series/${id}`,
    genres: [],
    adult: false,
    externalIds: { mangaupdates: id },
    ...extra,
  };
}

describe("genres", () => {
  it("compares spellings by a normalized key and keeps one canonical name", () => {
    expect(genreKey("Sci-fi")).toBe(genreKey("Science Fiction"));
    expect(genreKey("Boys Love")).toBe(genreKey("Boys' Love"));
    expect(canonicalGenres(["Action", "action", "Sci-fi", "Science Fiction", " "])).toEqual(["Action", "Sci-Fi"]);
  });

  it("does not alias related but different genres", () => {
    expect(genreKey("Shounen Ai")).not.toBe(genreKey("Boys' Love"));
  });

  it("resolves a requested genre to the provider's spelling or reports it missing", () => {
    expect(resolveGenre("sci-fi", ["Action", "Sci-Fi"])).toBe("Sci-Fi");
    expect(resolveGenre("Science Fiction", ["Sci-fi"])).toBe("Sci-fi");
    expect(resolveGenre("Isekai", ["Action"])).toBeUndefined();
  });
});

describe("normalizeSummary", () => {
  it("maps a provider record without inventing fields", () => {
    const e = normalizeSummary(
      md(MD, "Solo Leveling", {
        format: "manhwa",
        status: "unknown",
        genres: ["Action", "Fantasy"],
        tagNames: ["Action", "Fantasy", "Long Strip"],
        externalIds: { mangadex: MD, anilist: 105398 },
      }),
      3,
    );
    expect(e).toEqual({
      id: `dwg:md:${MD}`,
      ref: `mangadex:${MD}`,
      title: "Solo Leveling",
      altTitles: [],
      type: "manhwa",
      genres: ["Action", "Fantasy"],
      tags: ["Long Strip"],
      adult: false,
      externalIds: { mangadex: MD, anilist: 105398 },
      providers: ["mangadex"],
      records: [{ provider: "mangadex", providerId: MD, ref: `mangadex:${MD}`, url: `https://mangadex.org/title/${MD}`, rank: 3, match: "self" }],
    });
    // "unknown" status is dropped, not shown as a real status
    expect(e.status).toBeUndefined();
  });

  it("uses the identity module's canonical id", () => {
    const s = al(105398, "Solo Leveling");
    expect(normalizeSummary(s, 0).id).toBe(canonicalTitleId({ provider: "anilist", providerId: "105398", externalIds: recordIds(s) }));
    expect(normalizeSummary(s, 0).id).toBe("dwg:al:105398");
  });

  it("adds the record's own id even when the provider omitted externalIds", () => {
    expect(recordIds({ ...mu("15180124327", "x"), externalIds: undefined })).toEqual({ mangaupdates: "15180124327" });
  });
});

describe("compareIds", () => {
  it("matches, conflicts or is unknown", () => {
    expect(compareIds({ anilist: 1 }, { anilist: 1, mal: 5 })).toBe("match");
    expect(compareIds({ anilist: 1, mal: 5 }, { anilist: 1, mal: 6 })).toBe("conflict");
    expect(compareIds({ anilist: 1 }, { mal: 6 })).toBe("none");
    expect(compareIds({ mangadex: MD }, { mangadex: MD })).toBe("match");
  });
});

describe("mergeCatalogLists", () => {
  it("merges records that share an exact id and keeps every record", () => {
    const out = mergeCatalogLists([
      { provider: "anilist", items: [al(105398, "Solo Leveling", { score: 84, genres: ["Action"], year: 2018 })] },
      {
        provider: "mangadex",
        items: [md(MD, "Solo Leveling", { genres: ["Action", "Adventure"], coverImage: "https://uploads.mangadex.org/c.jpg", externalIds: { mangadex: MD, anilist: 105398, mangaupdates: "15180124327" } })],
      },
      { provider: "mangaupdates", items: [mu("15180124327", "Solo Leveling", { score: 85 })] },
    ]);
    expect(out).toHaveLength(1);
    const e = out[0];
    expect(e.id).toBe(`dwg:md:${MD}`);
    expect(e.ref).toBe(`mangadex:${MD}`);
    expect(e.providers).toEqual(["anilist", "mangadex", "mangaupdates"]);
    expect(e.records.map((r) => [r.provider, r.match, r.score])).toEqual([
      ["anilist", "self", 84],
      ["mangadex", "exact-id", undefined],
      ["mangaupdates", "exact-id", 85],
    ]);
    expect(e.genres).toEqual(["Action", "Adventure"]);
    expect(e.coverImage).toBe("https://uploads.mangadex.org/c.jpg");
    expect(e.externalIds).toEqual({ anilist: 105398, mangadex: MD, mangaupdates: "15180124327" });
  });

  it("links two earlier entries through a later bridging record", () => {
    const out = mergeCatalogLists([
      { provider: "anilist", items: [al(1, "Alpha", { year: 2020, format: "manga" })] },
      { provider: "mangaupdates", items: [mu("99", "Alpha (Official)", { year: 2019, format: "manga" })] },
      { provider: "mangadex", items: [md(MD, "Alpha", { externalIds: { mangadex: MD, anilist: 1, mangaupdates: "99" } })] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].providers.sort()).toEqual(["anilist", "mangadex", "mangaupdates"]);
  });

  it("merges by title only with the same year and type, across providers", () => {
    const out = mergeCatalogLists([
      { provider: "anilist", items: [al(7, "Tower of God", { year: 2010, format: "manhwa" })] },
      { provider: "mangaupdates", items: [mu("70", "Tower of God", { year: 2010, format: "manhwa" })] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].records[1].match).toBe("title-year-type");
  });

  it("does not merge by title when year or type is missing or differs", () => {
    const cases: [Partial<TitleSummary>, Partial<TitleSummary>][] = [
      [{ year: 2010, format: "manhwa" }, { year: 2011, format: "manhwa" }],
      [{ year: 2010, format: "manhwa" }, { year: 2010, format: "novel" }],
      [{ year: 2010 }, { year: 2010, format: "manhwa" }],
      [{ format: "manga" }, { format: "manga" }],
    ];
    for (const [a, b] of cases) {
      const out = mergeCatalogLists([
        { provider: "anilist", items: [al(7, "Tower of God", a)] },
        { provider: "mangaupdates", items: [mu("70", "Tower of God", b)] },
      ]);
      expect(out, JSON.stringify([a, b])).toHaveLength(2);
    }
  });

  it("never merges sequels or different series with similar titles", () => {
    const out = mergeCatalogLists([
      { provider: "anilist", items: [al(1, "Solo Leveling", { year: 2018, format: "manhwa" })] },
      { provider: "mangaupdates", items: [mu("2", "Solo Leveling: Ragnarok", { year: 2018, format: "manhwa" })] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("blocks a merge when ids of the same kind conflict, even with equal titles", () => {
    const out = mergeCatalogLists([
      { provider: "anilist", items: [al(1, "Same", { year: 2020, format: "manga", externalIds: { anilist: 1, mal: 10 } })] },
      { provider: "mangaupdates", items: [mu("2", "Same", { year: 2020, format: "manga", externalIds: { mangaupdates: "2", mal: 11 } })] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("never merges two records of the same provider by title", () => {
    const out = mergeCatalogLists([{ provider: "anilist", items: [al(1, "Same", { year: 2020, format: "manga" }), al(2, "Same", { year: 2020, format: "manga" })] }]);
    expect(out).toHaveLength(2);
  });

  it("drops a repeated ref and interleaves providers by rank", () => {
    const out = mergeCatalogLists([
      { provider: "anilist", items: [al(1, "A1"), al(2, "A2"), al(1, "A1")] },
      { provider: "mangaupdates", items: [mu("1", "M1"), mu("2", "M2")] },
    ]);
    expect(out.map((e) => e.title)).toEqual(["A1", "M1", "A2", "M2"]);
  });

  it("is deterministic", () => {
    const lists = [
      { provider: "anilist" as const, items: [al(7, "Tower of God", { year: 2010, format: "manhwa" as const })] },
      { provider: "mangaupdates" as const, items: [mu("70", "Tower of God", { year: 2010, format: "manhwa" as const })] },
    ];
    expect(mergeCatalogLists(lists)).toEqual(mergeCatalogLists(lists));
  });
});

describe("excludeSeen", () => {
  it("filters by canonical id or any record ref", () => {
    const out = mergeCatalogLists([{ provider: "anilist", items: [al(1, "A"), al(2, "B"), al(3, "C")] }]);
    expect(excludeSeen(out, { ids: ["dwg:al:1"], refs: ["anilist:3"] }).map((e) => e.title)).toEqual(["B"]);
  });
});
