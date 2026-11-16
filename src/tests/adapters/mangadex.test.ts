import { describe, expect, it } from "vitest";
import { getRegistry } from "@/lib/providers/registry";
import { getChapterPages, getChapters } from "@/lib/services/catalog";
import { searchProvider } from "@/lib/services/search";
import { jsonResponse, mockFetch } from "../helpers";

const MANGA_ID = "37f5cce0-8070-4ada-96e5-fa24b1bd4ff9";
const CHAPTER_ID = "a1b2c3d4-0000-4000-8000-000000000001";

function chapter(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "chapter",
    attributes: { chapter: String(n), title: `Ch ${n}`, pages: 20, publishAt: "2024-01-01T00:00:00Z", ...extra },
    relationships: [{ id: "g1", type: "scanlation_group", attributes: { name: "Group" } }],
  };
}

const mangadex = () => getRegistry().get("mangadex")!;

describe("MangaDex adapter (fixtures)", () => {
  it("searches via the official API and builds result URLs", async () => {
    mockFetch((url) => {
      const u = new URL(url);
      expect(u.hostname).toBe("api.mangadex.org");
      if (u.pathname === "/manga") {
        return jsonResponse({
          result: "ok",
          total: 1,
          data: [
            {
              id: MANGA_ID,
              type: "manga",
              attributes: { title: { en: "Kaguya-sama" }, lastChapter: "281", updatedAt: "2024-01-01T00:00:00Z" },
              relationships: [{ id: "c", type: "cover_art", attributes: { fileName: "cover.jpg" } }],
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const r = await searchProvider(mangadex(), "kaguya");
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      id: MANGA_ID,
      title: "Kaguya-sama",
      url: `https://mangadex.org/title/${MANGA_ID}`,
      latestChapter: 281,
    });
    expect(r.cache).toBe("miss");
    expect((await searchProvider(mangadex(), "  KAGUYA ")).cache).toBe("hit"); // normalized cache key
  });

  it("fetches all feed pages in parallel and dedupes chapters", async () => {
    const total = 1_234;
    let inFlight = 0;
    let peak = 0;
    const offsets: number[] = [];
    mockFetch(async (url) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset"));
      offsets.push(offset);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      const count = Math.min(500, total - offset);
      const data = Array.from({ length: count }, (_, i) => chapter(offset + i + 1));
      if (offset === 0) data.push(chapter(1, { publishAt: "2020-01-01T00:00:00Z" })); // older duplicate
      if (offset === 0) data.push(chapter(9999, { externalUrl: "https://example.com" })); // external: skipped
      return jsonResponse({ result: "ok", total, limit: 500, offset, data });
    });
    const r = await getChapters(mangadex(), `https://mangadex.org/title/${MANGA_ID}`);
    expect(offsets.sort((a, b) => a - b)).toEqual([0, 500, 1000]);
    expect(peak).toBe(2); // pages 2 and 3 concurrently (upstream fetched sequentially)
    expect(r.chapters).toHaveLength(total);
    expect(r.chapters[0].number).toBe(1);
    expect(r.chapters[0].url).toMatch(/^https:\/\/mangadex\.org\/chapter\//);
  });

  it("returns chapter pages from the MangaDex@Home API", async () => {
    mockFetch((url) => {
      expect(url).toBe(`https://api.mangadex.org/at-home/server/${CHAPTER_ID}`);
      return jsonResponse({
        result: "ok",
        baseUrl: "https://uploads.mangadex.org",
        chapter: { hash: "abc123", data: ["1.png", "2.png"], dataSaver: ["1.jpg", "2.jpg"] },
      });
    });
    const p = mangadex();
    expect(p.capabilities.chapterPages).toBe(true);
    const r = await getChapterPages(p, { url: `https://mangadex.org/chapter/${CHAPTER_ID}` });
    expect(r.pages).toEqual([
      { index: 0, url: "https://uploads.mangadex.org/data/abc123/1.png" },
      { index: 1, url: "https://uploads.mangadex.org/data/abc123/2.png" },
    ]);
    const saver = await getChapterPages(p, { chapterId: CHAPTER_ID }, { dataSaver: true });
    expect(saver.pages[0].url).toBe("https://uploads.mangadex.org/data-saver/abc123/1.jpg");
  });

  it("rejects invalid chapter ids without calling upstream", async () => {
    const f = mockFetch(() => jsonResponse({}));
    await expect(getChapterPages(mangadex(), { chapterId: "not-a-uuid" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("maps MangaDex 404 to NOT_FOUND", async () => {
    mockFetch(() => jsonResponse({ result: "error" }, { status: 404 }));
    await expect(getChapterPages(mangadex(), { chapterId: CHAPTER_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("other adapters do not claim page support", () => {
    const withPages = getRegistry()
      .all()
      .filter((p) => p.capabilities.chapterPages)
      .map((p) => p.id);
    expect(withPages).toEqual(["mangadex"]);
  });
});
