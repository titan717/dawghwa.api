import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamHttpError, DawghwaError } from "@/lib/core/errors";
import type { ChapterVariant } from "@/lib/chapters/merge";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import { SourceBreakers } from "@/lib/v2/breaker";
import { HostPacer } from "@/lib/v2/pacer";
import { canonicalNumber, parseCanonicalTitle, resolveChapter, V2Error, type ResolveDeps } from "@/lib/v2/chapter";
import { meta } from "../chapters/fixtures";
import { CANON, pagesFor, rows, SECRET, type Upload } from "./fixtures";

function harness(uploads: Upload[], behaviour: Record<string, (v: ChapterVariant) => unknown>, extra: Partial<ResolveDeps> = {}) {
  const calls: string[] = [];
  const breakers = extra.breakers ?? new SourceBreakers(3, 60_000);
  const deps: ResolveDeps = {
    origin: "http://localhost",
    loadMeta: async () => meta(),
    aggregate: async () => ({ title: { id: CANON }, chapters: rows(uploads) }),
    loadPages: async (p: Provider, v: ChapterVariant) => {
      calls.push(v.sourceId);
      const fn = behaviour[v.sourceId];
      if (!fn) return pagesFor(v.sourceId) as never;
      return (await fn(v)) as never;
    },
    breakers,
    pacer: new HostPacer(0),
    ...extra,
  };
  return { deps, calls, breakers };
}

const fail403 = () => {
  throw new UpstreamHttpError(403, "https://example.invalid/x");
};
const priority = (id: string) => getRegistry().get(id)!.descriptor.priority;

beforeEach(() => {
  delete process.env.IMAGE_PROXY;
  delete process.env.IMAGE_PROXY_SECRET;
});

describe("GET /api/v2/chapter resolution: fallback order", () => {
  const both: Upload[] = [
    { source: "mangadex", number: "1" },
    { source: "dynasty-reader", number: "1" },
  ];
  const [first, second] = priority("mangadex") >= priority("dynasty-reader") ? ["mangadex", "dynasty-reader"] : ["dynasty-reader", "mangadex"];

  it("serves the first version in stable order when it works", async () => {
    const h = harness(both, {});
    const r = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(h.calls).toEqual([first]);
    expect(r.version).toMatchObject({ index: 0, count: 2, next: 1, edition: "scanlation" });
    expect(r.totalPages).toBe(3);
  });

  it("falls back automatically to the next source when the first fails (403 = failure, no retry)", async () => {
    const h = harness(both, { [first]: fail403 });
    const r = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(h.calls).toEqual([first, second]);
    expect(r.version.index).toBe(1);
    expect(r.version.next).toBe(0);
  });

  it("returns a generic 502 when every version fails, trying each exactly once", async () => {
    const h = harness(both, { mangadex: fail403, "dynasty-reader": fail403 });
    const e = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps).catch((x) => x);
    expect(e).toBeInstanceOf(V2Error);
    expect(e.status).toBe(502);
    expect(e.publicMessage).toBe("Chapter unavailable");
    expect(h.calls.sort()).toEqual(["dynasty-reader", "mangadex"]);
  });

  it("skips a source whose breaker is open and tries it last once half-open", async () => {
    let t = 0;
    const breakers = new SourceBreakers(3, 60_000, () => t);
    for (let i = 0; i < 3; i++) breakers.failure(first);
    const h = harness(both, {}, { breakers });
    const r = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(h.calls).toEqual([second]);
    expect(r.version.index).toBe(1);

    t = 60_000; // half-open: goes after closed sources
    const h2 = harness(both, { [second]: fail403 }, { breakers });
    const r2 = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h2.deps);
    expect(h2.calls).toEqual([second, first]);
    expect(r2.version.index).toBe(0);
    expect(breakers.state(first)).toBe("closed");
  });

  it("records source failures in the breaker and opens it after 3 consecutive failures", async () => {
    const h = harness(both, { [first]: fail403 });
    for (let i = 0; i < 3; i++) await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(h.breakers.state(first)).toBe("open");
    h.calls.length = 0;
    await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(h.calls).toEqual([second]);
  });

  it("chapter-specific failures (locked / empty) do not count against the source", async () => {
    const h = harness(both, {
      [first]: () => {
        throw new DawghwaError("CHAPTER_LOCKED", "locked");
      },
    });
    for (let i = 0; i < 4; i++) await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(h.breakers.state(first)).toBe("closed");
  });

  it("fails a version closed when a page is outside the source's declared image hosts", async () => {
    const h = harness(both, { [first]: () => [{ index: 0, url: "https://evil.example/1.jpg" }] });
    const r = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(h.calls).toEqual([first, second]);
    expect(r.version.index).toBe(1);
  });
});

describe("automatic fallback safety and alt (\"Try another version\")", () => {
  const mixed: Upload[] = [
    { source: "webtoon", number: "2" },
    { source: "mangadex", number: "2" },
  ];

  it("prefers the official edition and never silently switches edition", async () => {
    const h = harness(mixed, { webtoon: fail403 });
    const e = await resolveChapter({ title: CANON, n: "2", lang: "en" }, h.deps).catch((x) => x);
    expect(h.calls).toEqual(["webtoon"]);
    expect(e.status).toBe(502);
  });

  it("alt=k starts at version k and may change edition (user asked)", async () => {
    const h = harness(mixed, {});
    const r = await resolveChapter({ title: CANON, n: "2", lang: "en", alt: 1 }, h.deps);
    expect(h.calls).toEqual(["mangadex"]);
    expect(r.version).toMatchObject({ index: 1, count: 2, next: 0, edition: "scanlation" });
  });

  it("alt beyond the version count is a 404", async () => {
    const h = harness(mixed, {});
    await expect(resolveChapter({ title: CANON, n: "2", lang: "en", alt: 5 }, h.deps)).rejects.toMatchObject({ status: 404 });
  });

  it("falls back between groups of the same source; a single version has next=null", async () => {
    const h = harness(
      [
        { source: "mangadex", number: "3", group: "g1" },
        { source: "mangadex", number: "3", group: "g2" },
      ],
      { mangadex: (v) => (v.group?.id === "g1" ? fail403() : pagesFor("mangadex")) },
    );
    const r = await resolveChapter({ title: CANON, n: "3", lang: "en" }, h.deps);
    expect(h.calls).toEqual(["mangadex", "mangadex"]);
    expect(r.version.count).toBe(2);
    const single = harness([{ source: "mangadex", number: "4" }], {});
    expect((await resolveChapter({ title: CANON, n: "4", lang: "en" }, single.deps)).version.next).toBeNull();
  });

  it("never changes language: lang selects the row", async () => {
    const h = harness(
      [
        { source: "mangadex", number: "5", language: "es" },
        { source: "dynasty-reader", number: "5", language: "en" },
      ],
      {},
    );
    await resolveChapter({ title: CANON, n: "5", lang: "es" }, h.deps);
    expect(h.calls).toEqual(["mangadex"]);
    await expect(resolveChapter({ title: CANON, n: "5", lang: "fr" }, h.deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe("inputs", () => {
  it("accepts canonical ids and metadata refs", () => {
    expect(parseCanonicalTitle(CANON)).toEqual({ provider: "mangadex", id: "814b682b-4405-47f7-b568-19929304df47" });
    expect(parseCanonicalTitle("dwg:al:105398")).toMatchObject({ provider: "anilist" });
    expect(parseCanonicalTitle("al:105398")).toMatchObject({ provider: "anilist" });
    expect(() => parseCanonicalTitle("nope")).toThrow(V2Error);
  });

  it("normalises chapter numbers exactly like the merge", () => {
    expect(canonicalNumber("10.0")).toBe("10");
    expect(canonicalNumber("010.5")).toBe("10.5");
    expect(canonicalNumber("1.10")).toBe("1.10");
    expect(canonicalNumber("abc")).toBeNull();
  });

  it("chapter 2 never resolves to a numbered special", async () => {
    const h = harness([{ source: "mangadex", number: "2", title: "Bonus Episode 2" }], {});
    await expect(resolveChapter({ title: CANON, n: "2", lang: "en" }, h.deps)).rejects.toMatchObject({ status: 404 });
  });

  it("metadata failures are generic", async () => {
    const h = harness([], {}, { loadMeta: vi.fn(async () => Promise.reject(new DawghwaError("NOT_FOUND", "MangaDex said no"))) });
    const e = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps).catch((x) => x);
    expect(e).toMatchObject({ status: 404, publicMessage: "Chapter unavailable" });
  });
});

describe("page URLs", () => {
  it("IMAGE_PROXY off: existing /api/image relay URLs (current behaviour)", async () => {
    const h = harness([{ source: "mangadex", number: "1" }], {});
    const r = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(new URL(r.pages[0]!.url).pathname).toBe("/api/image");
    expect(r.pagesExpireAt).toBeUndefined();
  });

  it("IMAGE_PROXY on without a secret falls back to current behaviour", async () => {
    process.env.IMAGE_PROXY = "1";
    const h = harness([{ source: "mangadex", number: "1" }], {});
    const r = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    expect(new URL(r.pages[0]!.url).pathname).toBe("/api/image");
  });

  it("IMAGE_PROXY on with a secret: opaque /api/v2/img/<token> URLs with an expiry", async () => {
    process.env.IMAGE_PROXY = "true";
    process.env.IMAGE_PROXY_SECRET = SECRET;
    const h = harness([{ source: "mangadex", number: "1" }], {});
    const r = await resolveChapter({ title: CANON, n: "1", lang: "en" }, h.deps);
    for (const p of r.pages) {
      expect(new URL(p.url).pathname).toMatch(/^\/api\/v2\/img\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(p.url).not.toContain("mangadex");
    }
    expect(Date.parse(r.pagesExpireAt!)).toBeGreaterThan(Date.now());
  });
});
