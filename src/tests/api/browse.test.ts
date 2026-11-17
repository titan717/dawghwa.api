import { describe, expect, it } from "vitest";
import { GET as browseGET, POST as browsePOST } from "@/app/api/browse/route";
import { POST as mangaPOST } from "@/app/api/manga/route";
import { GET as sourcesGET } from "@/app/api/sources/route";
import { normalizeMetadata } from "@/lib/providers/normalize";
import { kindFromLanguage, plainDescription } from "@/lib/scrapers/mangadex";
import { jsonResponse, mockFetch } from "../helpers";
import { get, post } from "./request";

const ID = "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0";
const TAGS = [
  { id: "tag-fantasy", attributes: { name: { en: "Fantasy" }, group: "genre" } },
  { id: "tag-romance", attributes: { name: { en: "Romance" }, group: "genre" } },
  { id: "tag-strip", attributes: { name: { en: "Long Strip" }, group: "format" } },
  { id: "tag-reinc", attributes: { name: { en: "Reincarnation" }, group: "theme" } },
];

function manga(extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    type: "manga",
    attributes: {
      title: { en: "Solo Leveling" },
      altTitles: [{ ko: "나 혼자만 레벨업" }, { en: "Solo Leveling" }],
      description: { en: "An **E-rank** hunter. [Read more](https://example.com)\n\n\n\nEnd." },
      lastChapter: "200",
      updatedAt: "2025-01-01T00:00:00Z",
      createdAt: "2019-01-01T00:00:00Z",
      originalLanguage: "ko",
      publicationDemographic: "shounen",
      status: "completed",
      year: 2018,
      contentRating: "safe",
      tags: [TAGS[0], TAGS[2]],
      availableTranslatedLanguages: ["en", null],
      ...extra,
    },
    relationships: [
      { id: "c", type: "cover_art", attributes: { fileName: "cover.jpg" } },
      { id: "a", type: "author", attributes: { name: "Chugong" } },
      { id: "b", type: "artist", attributes: { name: "Jang Sung-Rak" } },
    ],
  };
}

function mangadexApi(seen: string[] = []) {
  return mockFetch((url) => {
    seen.push(url);
    const u = new URL(url);
    if (u.pathname === "/manga/tag") return jsonResponse({ result: "ok", data: TAGS });
    if (u.pathname === "/manga") return jsonResponse({ result: "ok", total: 2, limit: 1, offset: 0, data: [manga()] });
    if (u.pathname === `/manga/${ID}`) return jsonResponse({ result: "ok", data: manga() });
    if (u.pathname === "/statistics/manga" || u.pathname === `/statistics/manga/${ID}`)
      return jsonResponse({ result: "ok", statistics: { [ID]: { rating: { bayesian: 9.3214, average: 9.4 }, follows: 1234 } } });
    throw new Error(`unexpected ${url}`);
  });
}

describe("metadata helpers", () => {
  it("derives the format kind from the original language", () => {
    expect(kindFromLanguage("ja")).toBe("manga");
    expect(kindFromLanguage("ko")).toBe("manhwa");
    expect(kindFromLanguage("zh-hk")).toBe("manhua");
    expect(kindFromLanguage("en")).toBe("comic");
    expect(kindFromLanguage(undefined)).toBeUndefined();
  });

  it("turns MangaDex descriptions into plain text", () => {
    expect(plainDescription("A **bold** [link](https://x.y) <b>tag</b>")).toBe("A bold link tag");
    expect(plainDescription("")).toBeUndefined();
  });

  it("sanitises metadata: drops junk, dedupes lists, bounds numbers", () => {
    const m = normalizeMetadata(
      {
        tags: ["Fantasy", "fantasy", "", 3, "Action"],
        rating: 42,
        follows: -1,
        year: 1800,
        kind: "novel",
        longStrip: "yes",
        coverImageLarge: "javascript:alert(1)",
        status: "completed",
        evil: "<script>",
      },
      "https://mangadex.org",
    );
    expect(m).toEqual({ tags: ["Fantasy", "Action"], status: "completed" });
    expect(normalizeMetadata(null, "https://x.y")).toBeUndefined();
  });
});

describe("POST /api/browse", () => {
  it("maps filters to the documented MangaDex query and returns metadata + statistics", async () => {
    const seen: string[] = [];
    mangadexApi(seen);
    const res = await browsePOST(
      post("/api/browse", {
        includedTags: ["fantasy", "Long Strip"],
        excludedTags: ["Romance"],
        kinds: ["manhwa", "manhua"],
        status: ["completed"],
        demographic: ["shounen"],
        order: "rating",
        limit: 1,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const listCall = decodeURIComponent(seen.find((u) => new URL(u).pathname === "/manga")!);
    expect(listCall).toContain("includedTags[]=tag-fantasy");
    expect(listCall).toContain("includedTags[]=tag-strip");
    expect(listCall).toContain("excludedTags[]=tag-romance");
    expect(listCall).toContain("originalLanguage[]=ko");
    expect(listCall).toContain("originalLanguage[]=zh");
    expect(listCall).toContain("status[]=completed");
    expect(listCall).toContain("publicationDemographic[]=shounen");
    expect(listCall).toContain("order[rating]=desc");
    expect(listCall).toContain("hasAvailableChapters=true");
    expect(body.sourceId).toBe("mangadex");
    expect(body.pagination).toMatchObject({ offset: 0, limit: 1, returned: 1, total: 2, hasMore: true });
    const item = body.items[0];
    expect(item).toMatchObject({ id: ID, title: "Solo Leveling", rating: 9.32, followers: "1234", latestChapter: 200 });
    expect(item.metadata).toMatchObject({
      kind: "manhwa",
      longStrip: true,
      genres: ["Fantasy"],
      formats: ["Long Strip"],
      authors: ["Chugong"],
      artists: ["Jang Sung-Rak"],
      status: "completed",
      demographic: "shounen",
      year: 2018,
      rating: 9.32,
      follows: 1234,
      altTitles: ["나 혼자만 레벨업"],
      availableLanguages: ["en"],
      coverImageLarge: `https://uploads.mangadex.org/covers/${ID}/cover.jpg.512.jpg`,
    });
    expect(item.metadata.description).toBe("An E-rank hunter. Read more\n\nEnd.");
  });

  it("rejects unknown tags instead of silently returning unfiltered results", async () => {
    const f = mangadexApi();
    const res = await browsePOST(post("/api/browse", { includedTags: ["Revenge"], limit: 5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.details?.unknownTags ?? body.error).toBeTruthy();
    expect(f.mock.calls.some(([u]) => new URL(String(u)).pathname === "/manga")).toBe(false);
  });

  it("validates the body", async () => {
    mangadexApi();
    expect((await browsePOST(post("/api/browse", { limit: 500 }))).status).toBe(400);
    expect((await browsePOST(post("/api/browse", { kinds: ["novel"] }))).status).toBe(400);
    expect((await browsePOST(post("/api/browse", { offset: 9990, limit: 50 }))).status).toBe(400);
  });

  it("returns 501 for sources without a listing API", async () => {
    const res = await browsePOST(post("/api/browse", { source: "asurascan" }));
    expect([501, 503]).toContain(res.status);
  });

  it("caches identical queries regardless of filter order", async () => {
    const f = mangadexApi();
    await browsePOST(post("/api/browse", { kinds: ["manga", "manhwa"], order: "new", limit: 2 }));
    const calls = f.mock.calls.length;
    const res = await browsePOST(post("/api/browse", { kinds: ["manhwa", "manga"], order: "new", limit: 2 }));
    expect((await res.json()).meta.cache).toBe("hit");
    expect(f.mock.calls.length).toBe(calls);
  });
});

describe("GET /api/browse", () => {
  it("lists browse-capable sources and the vocabulary", async () => {
    mangadexApi();
    const list = await (await browseGET(get("/api/browse"))).json();
    expect(list.sources).toEqual([{ id: "mangadex", name: "MangaDex" }]);
    const vocab = await (await browseGET(get("/api/browse?source=mangadex"))).json();
    expect(vocab.tags).toContainEqual({ name: "Fantasy", group: "genre" });
    expect(vocab.kinds).toEqual(["manga", "manhwa", "manhua", "comic"]);
    expect(vocab.maxOffset).toBe(10000);
  });

  it("advertises the browse capability in /api/sources", async () => {
    const body = await (await sourcesGET(get("/api/sources?capability=browse"))).json();
    expect(body.sources.map((s: { id: string }) => s.id)).toEqual(["mangadex"]);
  });
});

describe("POST /api/manga metadata", () => {
  it("returns cover and sanitised metadata for MangaDex", async () => {
    mangadexApi();
    const res = await mangaPOST(post("/api/manga", { url: `https://mangadex.org/title/${ID}` }));
    const body = await res.json();
    expect(body.manga).toMatchObject({
      title: "Solo Leveling",
      id: ID,
      coverImage: `https://uploads.mangadex.org/covers/${ID}/cover.jpg.256.jpg`,
    });
    expect(body.manga.metadata).toMatchObject({ kind: "manhwa", rating: 9.32, follows: 1234, longStrip: true });
  });
});
