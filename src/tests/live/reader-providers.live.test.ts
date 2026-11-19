/**
 * LIVE provider verification for the native reader (LIVE_TESTS=1 only).
 *
 * Hits the real providers through the same route handlers the app uses:
 * discovery + merged chapter list -> page manifest -> image bytes via the
 * /api/image relay. Nothing here is mocked. Failures mean the provider is
 * not currently verified; update src/lib/providers/verification.ts.
 */
import { describe, expect, it } from "vitest";
import { GET as allGET } from "@/app/api/titles/[ref]/chapters/all/route";
import { POST as pagesPOST } from "@/app/api/pages/route";
import { GET as imageGET } from "@/app/api/image/route";
import { getRegistry } from "@/lib/providers/registry";
import { get, post } from "../api/request";

const AIURA = "mangadex:814b682b-4405-47f7-b568-19929304df47";
const UNORDINARY = "mangadex:de34e04a-a9a4-4d9b-b434-f13ad275230c";

interface Variant { sourceId: string; providerChapterId: string; url: string; language: string }
interface Row { key: string; number: string | null; variants: Variant[] }
interface AllBody { chapters: Row[]; sources: { sourceId: string; status: string }[]; summary: Record<string, number> }

async function all(ref: string): Promise<AllBody> {
  const res = await allGET(get(`/api/titles/${ref}/chapters/all`));
  expect(res.status).toBe(200);
  return (await res.json()) as AllBody;
}

const MAGIC: [string, string][] = [["ffd8ff", "image/jpeg"], ["89504e47", "image/png"], ["52494646", "image/webp"], ["47494638", "image/gif"]];

async function readChapter(v: Variant) {
  const res = await pagesPOST(post("/api/pages", v.sourceId === "webtoon" ? { source: v.sourceId, url: v.url } : { source: v.sourceId, chapterId: v.providerChapterId }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { pages: { url: string }[]; totalPages: number };
  expect(body.totalPages).toBeGreaterThan(0);
  for (const page of body.pages.slice(0, 2)) {
    const u = new URL(page.url);
    expect(u.pathname).toBe("/api/image");
    const img = await imageGET(get(`${u.pathname}${u.search}`));
    expect(img.status).toBe(200);
    const bytes = new Uint8Array(await img.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const hex = Buffer.from(bytes.slice(0, 4)).toString("hex");
    const kind = MAGIC.find(([m]) => hex.startsWith(m));
    expect(kind, `image magic ${hex}`).toBeDefined();
    expect(img.headers.get("content-type")).toContain("image/");
  }
  return body.totalPages;
}

describe.runIf(process.env.LIVE_TESTS === "1")("native reader providers (live)", () => {
  it("search works on all three reader providers", async () => {
    const r = getRegistry();
    const cases: [string, string, RegExp][] = [["mangadex", "Aiura", /aiura/i], ["dynasty-reader", "Aiura", /aiura/i], ["webtoon", "unOrdinary", /unordinary/i]];
    for (const [id, q, re] of cases) {
      const results = await r.get(id)!.scraper.search(q);
      expect(results.some((x) => re.test(x.title)), `${id} search`).toBe(true);
    }
  }, 60_000);

  it("merges MangaDex + Dynasty chapters on one canonical title and reads both", async () => {
    const body = await all(AIURA);
    const merged = body.chapters.filter((c) => new Set(c.variants.map((v) => v.sourceId)).size > 1);
    expect(merged.length).toBeGreaterThan(50);
    const ch1 = body.chapters.find((c) => c.number === "1")!;
    const md = ch1.variants.find((v) => v.sourceId === "mangadex")!;
    const dy = ch1.variants.find((v) => v.sourceId === "dynasty-reader")!;
    expect(await readChapter(md)).toBeGreaterThan(0);
    expect(await readChapter(dy)).toBeGreaterThan(0);
  }, 120_000);

  it("WEBTOON: full public episode list and readable episode", async () => {
    const body = await all(UNORDINARY);
    const wt = body.sources.find((s) => s.sourceId === "webtoon");
    expect(wt?.status).toBe("ok");
    expect(body.chapters.length).toBeGreaterThan(300);
    const first = body.chapters[0]!.variants.find((v) => v.sourceId === "webtoon")!;
    expect(await readChapter(first)).toBeGreaterThan(0);
  }, 120_000);
  /**
   * Scanlation-site readers: chapter references come from the provider's own
   * chapter list (never constructed), then pages via /api/pages and image
   * bytes via /api/image for the first, a middle and the latest chapter.
   */
  it.each([
    ["asurascan", "solo"],
    ["thunderscans", "the"],
    ["mangakatana", "solo"],
    ["kayn-scans", "solo"],
  ])("%s: own chapter list -> real pages -> images, in order", async (id, query) => {
    const provider = getRegistry().get(id)!;
    const results = await provider.scraper.search(query);
    expect(results.length, `${id} search`).toBeGreaterThan(0);
    let chapters: { url: string; number: number }[] = [];
    for (const r of results.slice(0, 4)) {
      chapters = await provider.scraper.getChapterList(r.url);
      if (chapters.length) break;
    }
    expect(chapters.length, `${id} chapter list`).toBeGreaterThan(0);
    const picks = [...new Set([0, Math.floor(chapters.length / 2), chapters.length - 1])].map((i) => chapters[i]!);
    let read = 0;
    for (const ch of picks) {
      const res = await pagesPOST(post("/api/pages", { source: id, url: ch.url }));
      const body = (await res.json()) as { pages: { url: string; index: number }[]; code?: string };
      if (res.status === 403 && body.code === "CHAPTER_LOCKED") continue; // the provider's own gate
      expect(res.status, `${id} ${ch.url} ${body.code ?? ""}`).toBe(200);
      expect(body.pages.map((p) => p.index)).toEqual(body.pages.map((_, i) => i));
      for (const page of [body.pages[0]!, body.pages[body.pages.length - 1]!]) {
        const u = new URL(page.url);
        expect(u.searchParams.get("source")).toBe(id);
        const img = await imageGET(get(`${u.pathname}${u.search}`));
        expect(img.status, page.url).toBe(200);
        const hex = Buffer.from(new Uint8Array(await img.arrayBuffer()).slice(0, 4)).toString("hex");
        expect(MAGIC.find(([m]) => hex.startsWith(m)), `image magic ${hex}`).toBeDefined();
      }
      read++;
    }
    expect(read, `${id}: at least one chapter readable`).toBeGreaterThan(0);
  }, 180_000);
});
