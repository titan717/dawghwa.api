import { describe, expect, it } from "vitest";
import { GET as genresGET } from "@/app/api/lists/genres/route";
import { catalogueVocabulary, resolveCatalogueRef } from "@/lib/catalogue";
import { anilistCatalogue, listVariables } from "@/lib/catalogue/anilist";
import { jsonResponse, mockFetch } from "../helpers";
import { get } from "../api/request";
import { anilistReply, captured, MD_SOLO, MD_UNLINKED } from "./fixtures";

const base = { page: 1, limit: 5, nsfw: false } as const;

describe("AniList catalogue backend: query mapping", () => {
  it("maps kind to format + country and keeps novels out by default", () => {
    expect(listVariables({ ...base, order: "trending" })).toMatchObject({
      sort: ["TRENDING_DESC", "POPULARITY_DESC"],
      format_in: ["MANGA", "ONE_SHOT"],
      country: undefined,
      isAdult: false,
    });
    expect(listVariables({ ...base, order: "popular", kind: "manhwa" })).toMatchObject({ format_in: ["MANGA"], country: "KR" });
    expect(listVariables({ ...base, order: "popular", kind: "manhua" })).toMatchObject({ country: "CN" });
    expect(listVariables({ ...base, order: "popular", kind: "manga" })).toMatchObject({ country: "JP" });
  });

  it("makes the start-date window inclusive and lets nsfw lift the adult filter", () => {
    const v = listVariables({ ...base, order: "popular", startedFrom: "2025-11-22", startedTo: "2026-11-22", nsfw: true });
    expect(v).toMatchObject({ startFrom: 20251121, startTo: 20261123, isAdult: undefined });
  });

  it("sends the mapped variables to AniList", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url).toBe("https://graphql.anilist.co");
      const { variables } = JSON.parse(String(init.body));
      expect(variables).toMatchObject({ country: "KR", sort: ["POPULARITY_DESC"], perPage: 5 });
      return anilistReply(init, () => "list-popular-manhwa");
    });
    const page = await anilistCatalogue.list({ ...base, order: "popular", kind: "manhwa" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.items.map((i) => i.ref)).toEqual(["anilist:105398", "anilist:119257", "anilist:85143", "anilist:86964", "anilist:140407"]);
    expect(page.items.every((i) => i.format === "manhwa")).toBe(true);
    expect(page.items[0]).toMatchObject({ title: "Solo Leveling", url: "https://anilist.co/manga/105398", adult: false });
    expect(page.pageInfo).toEqual({ page: 1, limit: 5, hasNextPage: true });
  });

  it("returns an empty page for a real zero-result answer", async () => {
    mockFetch((_, init) => anilistReply(init, () => "list-empty"));
    const page = await anilistCatalogue.list({ ...base, order: "popular", genre: "Mecha", kind: "manhwa", startedFrom: "1950-01-01", startedTo: "1950-12-31" });
    expect(page).toEqual({ items: [], pageInfo: { page: 1, limit: 5, hasNextPage: false } });
  });

  it("looks up several ids in one call", async () => {
    const fetch = mockFetch((_, init) => {
      expect(JSON.parse(String(init.body)).variables).toEqual({ ids: [105398, 119257, 85143], perPage: 3 });
      return anilistReply(init, () => "by-ids");
    });
    const items = await anilistCatalogue.byIds(["105398", "119257", "85143", "105398"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(items.map((i) => i.title).sort()).toEqual(["Omniscient Reader", "Solo Leveling", "Tower of God"]);
  });

  it("keeps positively rated recommendations, never the seed", async () => {
    mockFetch((_, init) => anilistReply(init, () => "recommendations-105398"));
    const r = await anilistCatalogue.recommendations("105398", { page: 1, limit: 10, nsfw: false });
    expect(r.seed?.ref).toBe("anilist:105398");
    expect(r.items[0]).toMatchObject({ ref: "anilist:119257", title: "Omniscient Reader" });
    expect(r.items.map((i) => i.ref)).not.toContain("anilist:105398");
    expect(r.items).toHaveLength(10);
    expect(r.pageInfo.hasNextPage).toBe(true);
  });

  it("drops recommendations users voted down", async () => {
    const body = captured<{ data: { Media: { recommendations: { nodes: { rating: number }[] } } } }>("anilist/recommendations-105398.json");
    const copy = structuredClone(body);
    copy.data.Media.recommendations.nodes[0].rating = 0;
    mockFetch(() => jsonResponse(copy));
    const r = await anilistCatalogue.recommendations("105398", { page: 1, limit: 10, nsfw: false });
    expect(r.items.map((i) => i.ref)).not.toContain("anilist:119257");
  });
});

describe("catalogue vocabulary", () => {
  it("hides the adult genre and adult tags unless nsfw", async () => {
    mockFetch((_, init) => anilistReply(init, () => "vocabulary"));
    const safe = await catalogueVocabulary();
    expect(safe.genres.map((g) => g.name)).toContain("Action");
    expect(safe.genres.map((g) => g.name)).not.toContain("Hentai");
    expect(safe.tags.some((t) => t.adult)).toBe(false);
    expect(safe.tags.map((t) => t.name)).toContain("Isekai");
    const all = await catalogueVocabulary({ nsfw: true });
    expect(all.genres.map((g) => g.name)).toContain("Hentai");
    expect(all.tags.length).toBeGreaterThan(safe.tags.length);
  });
});

describe("resolveCatalogueRef", () => {
  it("passes catalogue refs through without a lookup", async () => {
    const fetch = mockFetch(() => {
      throw new Error("no network expected");
    });
    expect(await resolveCatalogueRef({ provider: "anilist", id: "105398" })).toEqual({
      inputRef: "anilist:105398",
      status: "catalogue",
      id: "105398",
      ref: "anilist:105398",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows MangaDex's own AniList link", async () => {
    mockFetch((url) => {
      expect(new URL(url).pathname).toBe(`/manga/${MD_SOLO}`);
      return jsonResponse(captured(`mangadex/title-32d76d19.json`));
    });
    expect(await resolveCatalogueRef({ provider: "mangadex", id: MD_SOLO })).toEqual({
      inputRef: `mangadex:${MD_SOLO}`,
      status: "catalogue",
      id: "105398",
      ref: "anilist:105398",
    });
  });

  it("reports unlinked only when the title loaded and has no link", async () => {
    mockFetch(() => jsonResponse(captured(`mangadex/title-135aa183.json`)));
    const r = await resolveCatalogueRef({ provider: "mangadex", id: MD_UNLINKED });
    expect(r.status).toBe("unlinked");
    expect(r.status === "unlinked" && r.source.title).toBe("Love that Does Not Begin");
  });

  it("throws on a lookup failure and does not remember it", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return calls <= 3 ? jsonResponse({ result: "error" }, { status: 503 }) : jsonResponse(captured(`mangadex/title-32d76d19.json`));
    });
    await expect(resolveCatalogueRef({ provider: "mangadex", id: MD_SOLO })).rejects.toMatchObject({ code: "UPSTREAM_HTTP_ERROR" });
    expect((await resolveCatalogueRef({ provider: "mangadex", id: MD_SOLO })).status).toBe("catalogue");
  });
});

describe("GET /api/lists/genres", () => {
  it("lists non-adult genres and tags with cache headers", async () => {
    mockFetch((_, init) => anilistReply(init, () => "vocabulary"));
    const res = await genresGET(get("/api/lists/genres"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600, s-maxage=86400");
    const body = await res.json();
    expect(body.genres).toContain("Romance");
    expect(body.genres).not.toContain("Hentai");
    expect(body.tags).toContainEqual({ name: "Isekai", group: expect.any(String) });
    expect(body.attribution).toEqual({ name: "AniList", url: "https://anilist.co" });
  });

  it("is an error with no-store when AniList fails, never an empty list", async () => {
    mockFetch(() => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
    const res = await genresGET(get("/api/lists/genres"));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.code).toBe("UPSTREAM_HTTP_ERROR");
    expect(body.genres).toBeUndefined();
  });
});
