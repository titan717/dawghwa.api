import { describe, expect, it } from "vitest";
import { GET as catalogGET } from "@/app/api/catalog/route";
import { GET as filtersGET } from "@/app/api/catalog/filters/route";
import { GET as providersGET } from "@/app/api/catalog/providers/route";
import { GET as titleGET } from "@/app/api/titles/[ref]/route";
import { GET as titleSourcesGET } from "@/app/api/titles/[ref]/sources/route";
import { GET as titleChaptersGET } from "@/app/api/titles/[ref]/chapters/route";
import { POST as availabilityPOST } from "@/app/api/availability/route";
import { jsonResponse, mockFetch } from "../helpers";
import { AL_SOLO, mdSearchHit } from "../metadata/fixtures";
import { get, ndjson, post } from "./request";

const MD_ID = "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0";

/** AniList + MangaDex fixtures shared by the title routes. */
function upstream(mdResults: unknown[] = [mdSearchHit(MD_ID, "Solo Leveling")]) {
  return mockFetch((url) => {
    const u = new URL(url);
    if (u.hostname === "graphql.anilist.co") {
      return jsonResponse({ data: { Media: AL_SOLO, Page: { pageInfo: { total: 1, currentPage: 1, hasNextPage: false }, media: [AL_SOLO] } } });
    }
    if (u.hostname === "api.mangadex.org" && u.pathname === "/manga") {
      return jsonResponse({ result: "ok", total: 1, data: mdResults });
    }
    if (u.hostname === "api.mangadex.org" && u.pathname === `/manga/${MD_ID}/feed`) {
      return jsonResponse({
        result: "ok",
        total: 1,
        limit: 500,
        offset: 0,
        data: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            type: "chapter",
            attributes: { chapter: "1", title: "Ch 1", pages: 20, publishAt: "2024-01-01T00:00:00Z" },
            relationships: [{ id: "g1", type: "scanlation_group", attributes: { name: "Group" } }],
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe("GET /api/catalog", () => {
  it("browses AniList with attribution and page info", async () => {
    upstream();
    const res = await catalogGET(get("/api/catalog?q=solo&genre=Action&genre=Fantasy&format=manhwa&limit=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("anilist");
    expect(body.items[0]).toMatchObject({ ref: "anilist:105398", title: "Solo Leveling", format: "manhwa" });
    expect(body.attribution.name).toBe("AniList");
    expect(body.pageInfo).toMatchObject({ page: 1, hasNextPage: false });
  });

  it("validates parameters", async () => {
    for (const q of ["limit=500", "format=comic", "sort=random", "provider=nope", "year=1200", "page=0"]) {
      const res = await catalogGET(get(`/api/catalog?${q}`));
      expect(res.status, q).toBe(400);
      expect((await res.json()).code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns 400 for filters a provider cannot apply", async () => {
    const res = await catalogGET(get("/api/catalog?provider=mangaupdates&status=ongoing"));
    expect(res.status).toBe(400);
    expect((await res.json()).details.supported).not.toContain("status");
  });

  it("passes multi-value MangaDex filters through and rejects them where unsupported", async () => {
    const seen: URL[] = [];
    mockFetch((url) => {
      const u = new URL(url);
      seen.push(u);
      if (u.pathname === "/manga/tag") {
        return jsonResponse({
          result: "ok",
          data: [
            { id: "t-action", type: "tag", attributes: { name: { en: "Action" }, group: "genre" } },
            { id: "t-romance", type: "tag", attributes: { name: { en: "Romance" }, group: "genre" } },
            { id: "t-horror", type: "tag", attributes: { name: { en: "Horror" }, group: "genre" } },
          ],
        });
      }
      if (u.pathname === "/manga") return jsonResponse({ result: "ok", total: 0, limit: 20, offset: 0, data: [] });
      throw new Error(`unexpected ${url}`);
    });
    const res = await catalogGET(
      get(
        "/api/catalog?provider=mangadex&status=ongoing&status=hiatus&format=manhwa,manhua&demographic=seinen" +
          "&genre=Action&genre=Romance&genreMode=or&excludeGenre=Horror&excludeMode=and",
      ),
    );
    expect(res.status).toBe(200);
    const md = seen.find((u) => u.pathname === "/manga")!.searchParams;
    expect(md.getAll("status[]")).toEqual(["ongoing", "hiatus"]);
    expect(md.getAll("originalLanguage[]")).toEqual(expect.arrayContaining(["ko", "zh"]));
    expect(md.getAll("publicationDemographic[]")).toEqual(["seinen"]);
    expect(md.getAll("includedTags[]")).toEqual(["t-action", "t-romance"]);
    expect(md.get("includedTagsMode")).toBe("OR");
    expect(md.getAll("excludedTags[]")).toEqual(["t-horror"]);
    expect(md.get("excludedTagsMode")).toBe("AND");

    for (const q of [
      "provider=anilist&status=ongoing&status=hiatus",
      "provider=anilist&demographic=seinen",
      "provider=anilist&genre=Action&genreMode=or",
      "provider=mangadex&demographic=kodomo",
      "provider=mangadex&genreMode=xor",
      "provider=mangadex&format=one_shot&format=manhwa",
    ]) {
      const r = await catalogGET(get(`/api/catalog?${q}`));
      expect(r.status, q).toBe(400);
      expect((await r.json()).code, q).toBe("VALIDATION_ERROR");
    }
  });

  it("lists providers and filter options", async () => {
    const res = await providersGET(get("/api/catalog/providers"));
    const body = await res.json();
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["anilist", "mangadex", "mangaupdates"]);
    mockFetch((url) =>
      new URL(url).hostname === "api.mangadex.org"
        ? jsonResponse({ result: "ok", data: [{ id: "t1", type: "tag", attributes: { name: { en: "Action" }, group: "genre" } }] })
        : jsonResponse({ data: { GenreCollection: ["Action"], MediaTagCollection: [{ name: "Dungeon", category: "Setting", isAdult: false }] } }),
    );
    const f = await (await filtersGET(get("/api/catalog/filters"))).json();
    expect(f.genres).toEqual(["Action"]);
    expect(f.capabilities.filters).toContain("status");
    const md = await (await filtersGET(get("/api/catalog/filters?provider=mangadex"))).json();
    expect(md.capabilities.filters).toEqual(expect.arrayContaining(["statuses", "formats", "demographics", "genreMode"]));
    expect(md.capabilities.demographics).toContain("seinen");
  });
});

describe("GET /api/titles/:ref", () => {
  it("returns normalized metadata", async () => {
    upstream();
    const res = await titleGET(get("/api/titles/al:105398"));
    expect(res.status).toBe(200);
    expect((await res.json()).title).toMatchObject({ ref: "anilist:105398", title: "Solo Leveling" });
  });

  it("rejects malformed refs", async () => {
    const res = await titleGET(get("/api/titles/al:abc"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/titles/:ref/sources", () => {
  it("returns ranked sources as JSON", async () => {
    upstream();
    const res = await titleSourcesGET(get("/api/titles/al:105398/sources?sources=mangadex"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title.ref).toBe("anilist:105398");
    expect(body.sources[0]).toMatchObject({ sourceId: "mangadex", available: true, best: { id: MD_ID, confidence: "exact" } });
    expect(body.summary).toMatchObject({ ranking: ["mangadex"], availableSources: 1 });
  });

  it("streams NDJSON events", async () => {
    upstream();
    const res = await titleSourcesGET(get("/api/titles/al:105398/sources?sources=mangadex&stream=1"));
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = await ndjson(res);
    expect(lines.map((l) => l.event)).toEqual(["title", "source", "summary"]);
  });

  it("validates the source list and minScore", async () => {
    expect((await titleSourcesGET(get("/api/titles/al:105398/sources?sources=nope"))).status).toBe(404);
    expect((await titleSourcesGET(get("/api/titles/al:105398/sources?minScore=0.1"))).status).toBe(400);
  });
});

describe("GET /api/titles/:ref/chapters", () => {
  it("finds the series on the chosen source and returns its chapters", async () => {
    upstream();
    const res = await titleChaptersGET(get("/api/titles/al:105398/chapters?source=mangadex"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sourceId: "mangadex", match: { id: MD_ID }, totalChapters: 1 });
  });

  it("returns 404 with candidates when the source has no confident match", async () => {
    upstream([mdSearchHit("11111111-1111-4111-8111-111111111111", "Solo Leveling: Ragnarok")]);
    const res = await titleChaptersGET(get("/api/titles/al:105398/chapters?source=mangadex"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.details.candidates[0].title).toBe("Solo Leveling: Ragnarok");
  });

  it("requires a known source", async () => {
    expect((await titleChaptersGET(get("/api/titles/al:105398/chapters"))).status).toBe(400);
    expect((await titleChaptersGET(get("/api/titles/al:105398/chapters?source=nope"))).status).toBe(404);
  });
});

describe("POST /api/availability", () => {
  it("works with a free-text title", async () => {
    upstream();
    const res = await availabilityPOST(post("/api/availability", { title: "Solo Leveling", sources: ["mangadex"] }));
    expect(res.status).toBe(200);
    expect((await res.json()).summary.ranking).toEqual(["mangadex"]);
  });

  it("validates the body", async () => {
    for (const body of [{}, { title: "" }, { title: "x".repeat(300) }, { title: "a", minScore: 2 }, { title: "a", sources: [] }]) {
      const res = await availabilityPOST(post("/api/availability", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});
