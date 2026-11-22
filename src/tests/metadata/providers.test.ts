import { describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/core/config";
import { browseCatalog, getMetadataProvider, getTitleMetadata, parseTitleRef } from "@/lib/metadata";
import { formatFromAniList } from "@/lib/metadata/anilist";
import { formatFromMangaDex, muSlugToId } from "@/lib/metadata/mangadex";
import { muStatus } from "@/lib/metadata/mangaupdates";
import { jsonResponse, mockFetch } from "../helpers";
import { AL_SOLO, MD_SOLO_ID, MU_SOLO } from "./fixtures";

describe("title refs", () => {
  it("parses provider refs and aliases", () => {
    expect(parseTitleRef("anilist:105398")).toEqual({ provider: "anilist", id: "105398" });
    expect(parseTitleRef("al:105398")).toEqual({ provider: "anilist", id: "105398" });
    expect(parseTitleRef(`md:${MD_SOLO_ID.toUpperCase()}`)).toEqual({ provider: "mangadex", id: MD_SOLO_ID });
    expect(parseTitleRef("mu:6z1uqw7")).toEqual({ provider: "mangaupdates", id: "15180124327" });
    expect(parseTitleRef("mangaupdates:15180124327")).toEqual({ provider: "mangaupdates", id: "15180124327" });
    expect(parseTitleRef("anilist%3A105398")).toEqual({ provider: "anilist", id: "105398" });
  });

  it("rejects malformed refs", () => {
    for (const bad of ["105398", "al:abc", "md:not-a-uuid", "foo:1", "mu:!!", `al:${"9".repeat(80)}`]) {
      expect(() => parseTitleRef(bad), bad).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });

  it("decodes MangaUpdates base36 slugs", () => {
    expect(muSlugToId("6z1uqw7")).toBe("15180124327");
    expect(muSlugToId("123")).toBeUndefined(); // legacy numeric ids
  });

  it("maps formats and statuses", () => {
    expect(formatFromAniList("MANGA", "KR")).toBe("manhwa");
    expect(formatFromAniList("MANGA", "CN")).toBe("manhua");
    expect(formatFromAniList("MANGA", "JP")).toBe("manga");
    expect(formatFromAniList("NOVEL", "JP")).toBe("novel");
    expect(formatFromMangaDex("ko", [])).toBe("manhwa");
    expect(formatFromMangaDex("ja", [])).toBe("manga");
    expect(muStatus({ status: "200 Chapters (Complete)", completed: true })).toBe("completed");
    expect(muStatus({ status: "Ongoing", completed: false })).toBe("ongoing");
    expect(muStatus({ status: "On hiatus", completed: false })).toBe("hiatus");
  });

  it("honours METADATA_PROVIDERS", () => {
    process.env.METADATA_PROVIDERS = "anilist";
    try {
      resetConfig();
      expect(() => getMetadataProvider("mangadex")).toThrow(expect.objectContaining({ code: "SOURCE_UNAVAILABLE" }));
    } finally {
      delete process.env.METADATA_PROVIDERS;
    }
  });
});

describe("AniList normalizer", () => {
  it("normalizes a GraphQL Media record and caches it", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url).toBe("https://graphql.anilist.co");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("user-agent")).toMatch(/^dawghwa-api\//);
      expect(JSON.parse(String(init.body)).variables).toEqual({ id: 105398 });
      return jsonResponse({ data: { Media: AL_SOLO } });
    });
    const r = await getTitleMetadata({ provider: "anilist", id: "105398" });
    expect(r.title).toMatchObject({
      ref: "anilist:105398",
      title: "Solo Leveling",
      format: "manhwa",
      status: "completed",
      year: 2018,
      score: 84,
      latestChapter: 201,
      authors: ["Chugong"],
      artists: ["DUBU"],
      externalIds: { anilist: 105398, mal: 121496 },
    });
    expect(r.title.altTitles).toContain("Na Honjaman Level Up");
    expect(r.title.description).not.toMatch(/<[a-z]/i);
    expect((await getTitleMetadata({ provider: "anilist", id: "105398" })).cache).toBe("hit");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps AniList 404s to NOT_FOUND", async () => {
    mockFetch(() => jsonResponse({ data: { Media: null }, errors: [{ message: "Not Found.", status: 404 }] }, { status: 404 }));
    await expect(getTitleMetadata({ provider: "anilist", id: "1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps AniList 429s to UPSTREAM_RATE_LIMITED", async () => {
    process.env.UPSTREAM_RETRIES = "0";
    try {
      resetConfig();
      mockFetch(() => jsonResponse({ errors: [{ message: "Too Many Requests.", status: 429 }] }, { status: 429, headers: { "retry-after": "1" } }));
      await expect(getTitleMetadata({ provider: "anilist", id: "2" })).rejects.toMatchObject({ code: "UPSTREAM_RATE_LIMITED" });
    } finally {
      delete process.env.UPSTREAM_RETRIES;
    }
  });
});

describe("MangaUpdates normalizer", () => {
  it("normalizes a series record", async () => {
    mockFetch((url) => {
      expect(url).toBe("https://api.mangaupdates.com/v1/series/15180124327");
      return jsonResponse(MU_SOLO);
    });
    const { title } = await getTitleMetadata(parseTitleRef("mu:6z1uqw7"));
    expect(title).toMatchObject({
      ref: "mangaupdates:15180124327",
      title: "Solo Leveling",
      format: "manhwa",
      status: "completed",
      year: 2018,
      score: 85,
      latestChapter: 200,
      authors: ["Chugong"],
      artists: ["DUBU"],
    });
    expect(title.altTitles).toEqual(["Na Honjaman Level Up"]);
  });

  it("filters adult genres unless nsfw is set and rejects unsupported filters", async () => {
    const bodies: Record<string, unknown>[] = [];
    mockFetch((url, init) => {
      expect(url).toBe("https://api.mangaupdates.com/v1/series/search");
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ total_hits: 1, results: [{ record: MU_SOLO }] });
    });
    const mu = getMetadataProvider("mangaupdates");
    const r = await browseCatalog(mu, { q: "solo", format: "manhwa", page: 1, limit: 10 });
    expect(r.result.items[0].ref).toBe("mangaupdates:15180124327");
    expect(r.result.pageInfo).toMatchObject({ total: 1, hasNextPage: false });
    expect(bodies[0]).toMatchObject({ search: "solo", type: ["Manhwa"], perpage: 10 });
    expect(bodies[0].exclude_genre).toEqual(expect.arrayContaining(["Hentai"]));
    await expect(browseCatalog(mu, { status: "ongoing", page: 1, limit: 10 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("MangaDex catalogue", () => {
  it("resolves genre names to tag UUIDs and limits content rating", async () => {
    const seen: URL[] = [];
    mockFetch((url) => {
      const u = new URL(url);
      seen.push(u);
      if (u.pathname === "/manga/tag") {
        return jsonResponse({
          result: "ok",
          data: [{ id: "391b0423-d847-456f-aff0-8b0cfc03066b", type: "tag", attributes: { name: { en: "Action" }, group: "genre" } }],
        });
      }
      if (u.pathname === "/manga") return jsonResponse({ result: "ok", total: 0, limit: 5, offset: 0, data: [] });
      throw new Error(`unexpected ${url}`);
    });
    const md = getMetadataProvider("mangadex");
    await browseCatalog(md, { genres: ["action"], format: "manhwa", page: 2, limit: 5 });
    const search = seen.find((u) => u.pathname === "/manga")!;
    expect(search.searchParams.getAll("includedTags[]")).toEqual(["391b0423-d847-456f-aff0-8b0cfc03066b"]);
    expect(search.searchParams.getAll("originalLanguage[]")).toContain("ko");
    expect(search.searchParams.getAll("contentRating[]")).not.toContain("pornographic");
    expect(search.searchParams.get("offset")).toBe("5");
    await expect(browseCatalog(md, { genres: ["no-such-genre"], page: 1, limit: 5 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("passes synopsis, tag names and demographic through on list items", async () => {
    mockFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/manga") {
        return jsonResponse({
          result: "ok",
          total: 1,
          limit: 1,
          offset: 0,
          data: [
            {
              id: "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0",
              type: "manga",
              attributes: {
                title: { en: "Solo Leveling" },
                altTitles: [],
                description: { en: " A hunter levels up. " },
                links: null,
                originalLanguage: "ko",
                lastVolume: null,
                lastChapter: "200",
                status: "completed",
                year: 2018,
                contentRating: "safe",
                publicationDemographic: "shounen",
                tags: [
                  { id: "a", attributes: { name: { en: "Action" }, group: "genre" } },
                  { id: "b", attributes: { name: { en: "Monsters" }, group: "theme" } },
                ],
                updatedAt: "2025-01-01T00:00:00+00:00",
              },
              relationships: [],
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const page = await browseCatalog(getMetadataProvider("mangadex"), { page: 1, limit: 1 }, { forceRefresh: true });
    const item = page.result.items[0]!;
    expect(item.description).toBe("A hunter levels up.");
    expect(item.tagNames).toEqual(["Action", "Monsters"]);
    expect(item.genres).toEqual(["Action"]);
    expect(item.demographic).toBe("shounen");
    expect(item.externalIds).toEqual({ mangadex: "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0" });
  });

  it("carries the exact tracker ids MangaDex publishes in links on list items", async () => {
    mockFetch((url) => {
      if (new URL(url).pathname === "/manga") {
        return jsonResponse({
          result: "ok",
          total: 1,
          limit: 1,
          offset: 0,
          data: [
            {
              id: "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0",
              type: "manga",
              attributes: {
                title: { en: "Solo Leveling" },
                altTitles: [],
                description: {},
                links: { al: "105398", mal: "121496", mu: "6z1uqw7", raw: "https://example.invalid/x" },
                originalLanguage: "ko",
                lastVolume: null,
                lastChapter: null,
                status: "completed",
                year: 2018,
                contentRating: "safe",
                tags: [],
                updatedAt: "2025-01-01T00:00:00+00:00",
              },
              relationships: [],
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const page = await browseCatalog(getMetadataProvider("mangadex"), { q: "links", page: 1, limit: 1 }, { forceRefresh: true });
    expect(page.result.items[0]!.externalIds).toEqual({
      mangadex: "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0",
      anilist: 105398,
      mal: 121496,
      mangaupdates: "15180124327",
    });
  });

  it("declares which sorts are backed by a real signal", () => {
    expect(getMetadataProvider("mangadex").capabilities.signals).toMatchObject({ follows: { sort: "popularity" }, chapterUpdates: { sort: "updated" } });
    expect(getMetadataProvider("mangadex").capabilities.signals?.trending).toBeUndefined();
    expect(getMetadataProvider("anilist").capabilities.signals).toMatchObject({ readership: { sort: "popularity" }, trending: { sort: "trending" } });
    // AniList "updated" is the record edit time, not a chapter release
    expect(getMetadataProvider("anilist").capabilities.signals?.chapterUpdates).toBeUndefined();
    for (const id of ["anilist", "mangadex", "mangaupdates"]) {
      const caps = getMetadataProvider(id).capabilities;
      for (const s of Object.values(caps.signals ?? {})) expect(caps.sorts, id).toContain(s.sort);
    }
  });

  it("refuses to page past the provider's depth limit", async () => {
    await expect(browseCatalog(getMetadataProvider("mangadex"), { page: 200, limit: 100 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});
