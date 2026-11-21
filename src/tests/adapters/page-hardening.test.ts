/**
 * Regression tests for the PR #6 review findings (docs/research/pr6-review.md).
 * Each test fails on 8facf09 (the reviewed head) and passes with the fixes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { afterEach, describe, expect, it } from "vitest";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import type { Provider } from "@/lib/providers/provider";
import { finalizePages, pickChapterList } from "@/lib/scrapers/pages/extract";
import { anySub, matchesImageRules } from "@/lib/scrapers/pages/policy";
import { imagesBySelector } from "@/lib/scrapers/pages/strategies";

interface Recorded {
  url: string;
  method: string;
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
}
interface Fixture {
  provider: string;
  chapterUrl: string;
  expected: { count: number; first: string; last: string };
  responses: Recorded[];
}
const fixture = (id: string): Fixture =>
  JSON.parse(gunzipSync(readFileSync(join(__dirname, "../fixtures/pages", `${id}.json.gz`))).toString("utf8"));

type HttpHolder = { http: (input: string | URL | Request, init?: RequestInit) => Promise<Response> };
const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});
function replay(provider: Provider, responses: Recorded[]) {
  const holder = provider.scraper as unknown as HttpHolder;
  const original = holder.http;
  restore.push(() => (holder.http = original));
  holder.http = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const hit = responses.find((r) => r.url === url && r.method === (init?.method ?? "GET").toUpperCase());
    if (!hit) throw new Error(`unrecorded request ${url}`);
    const res = new Response(hit.text, { status: hit.status, headers: { "content-type": hit.contentType } });
    Object.defineProperty(res, "url", { value: hit.finalUrl });
    return res;
  };
}
const pagesFor = (f: Fixture, responses: Recorded[]) => {
  const p = getRegistry().get(f.provider)!;
  replay(p, responses);
  return p.scraper.getChapterPages!({ url: f.chapterUrl });
};
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "resolved";
  } catch (e) {
    return e instanceof DawghwaError ? e.code : `other:${(e as Error).message}`;
  }
};
/** Append one Next.js flight chunk carrying `value` to the first response. */
const withFlight = (f: Fixture, value: unknown): Recorded[] =>
  f.responses.map((r, i) =>
    i === 0 ? { ...r, text: r.text.replace("</body>", `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(value))}])</script></body>`) } : r,
  );

describe("finding 1: the requested chapter's list, never the longest one", () => {
  it("a second, longer page list in the reader payload is refused instead of returned", async () => {
    const f = fixture("lua-comic");
    // another chapter's (longer) image list, as a preview / prefetch would embed it
    const other = Array.from({ length: f.expected.count + 5 }, (_, i) => `https://media.luacomic.org/file/other/uploads/next-chapter/${i}.webp`);
    expect(await codeOf(pagesFor(f, withFlight(f, { images: other })))).toBe("PAGE_FORMAT_CHANGED");
  });

  it("an identical repeated copy of the chapter's list is still read", async () => {
    const f = fixture("lua-comic");
    const pages = await pagesFor(f, f.responses);
    const copy = pages.map((p) => p.url);
    const again = await pagesFor(f, withFlight(f, { images: copy }));
    expect(again.map((p) => p.url)).toEqual(copy);
  });

  it("WebtoonClub picks the chapter object matching the requested chapter, even when another one is longer", async () => {
    const f = fixture("webtoonclub");
    const baseline = (await pagesFor(f, f.responses)).map((p) => p.url);
    const longer = { chapter: { id: 999, comicId: 1, chapterNumber: 9999, slug: "chapter-9999", images: Array.from({ length: 40 }, (_, i) => ({ filename: `x/${i}.webp`, sortOrder: i })) } };
    const got = (await pagesFor(f, withFlight(f, longer))).map((p) => p.url);
    expect(got).toEqual(baseline);
  });

  it("pickChapterList: distinct lists without a way to tell them apart are ambiguous", () => {
    expect(() => pickChapterList([["a"], ["b", "c"]], "Test")).toThrow(expect.objectContaining({ code: "PAGE_FORMAT_CHANGED" }));
    expect(pickChapterList([["a"], ["a"]], "Test")).toEqual(["a"]);
    expect(pickChapterList([["a"], ["b", "c"]], "Test", (l) => l[0] === "a")).toEqual(["a"]);
    expect(pickChapterList([], "Test")).toBeUndefined();
  });
});

describe("finding 2: malformed entries fail the chapter instead of disappearing", () => {
  const allow = (u: URL) => u.hostname === "cdn.example";
  const base = "https://reader.example/chapter/1";

  it("a page entry without a URL is PAGE_FORMAT_CHANGED, not a shorter chapter", () => {
    const raw = [{ url: "https://cdn.example/1.webp" }, { url: undefined }, { url: "https://cdn.example/3.webp" }];
    expect(() => finalizePages(raw, { base, source: "Test", allow })).toThrow(expect.objectContaining({ code: "PAGE_FORMAT_CHANGED" }));
  });

  it("a non-string entry (e.g. an object in a JSON page array) is PAGE_FORMAT_CHANGED", () => {
    const raw = [{ url: "https://cdn.example/1.webp" }, { url: { src: "x" } as unknown as string }];
    expect(() => finalizePages(raw, { base, source: "Test", allow })).toThrow(expect.objectContaining({ code: "PAGE_FORMAT_CHANGED" }));
  });

  it("an <img> in the reader with no usable source is reported, not filtered out", () => {
    const $ = cheerio.load(`<div id="r"><img src="https://cdn.example/1.webp"><img data-src="data:image/gif;base64,AA"><img src="https://cdn.example/3.webp"></div>`);
    const raw = imagesBySelector($, "#r img");
    expect(raw).toHaveLength(3);
    expect(() => finalizePages(raw, { base, source: "Test", allow })).toThrow(expect.objectContaining({ code: "PAGE_FORMAT_CHANGED" }));
  });

  it("MangaThemesia: a non-string image in ts_reader.run sources fails the chapter", async () => {
    const f = fixture("thunderscans");
    const edited = f.responses.map((r, i) => (i === 0 ? { ...r, text: r.text.replace(/("images":\[)"/, '$1null,"') } : r));
    expect(edited[0].text).not.toBe(f.responses[0].text);
    expect(await codeOf(pagesFor(f, edited))).toBe("PAGE_FORMAT_CHANGED");
  });
});

describe("finding 3: page images are HTTPS only, as documented", () => {
  it("allowlist rules refuse http and non-443 ports", () => {
    const rules = [anySub("cdn.example")];
    expect(matchesImageRules(new URL("https://cdn.example/a.jpg"), rules)).toBe(true);
    expect(matchesImageRules(new URL("http://cdn.example/a.jpg"), rules)).toBe(false);
    expect(matchesImageRules(new URL("https://cdn.example:80/a.jpg"), rules)).toBe(false);
    expect(matchesImageRules(new URL("https://cdn.example:8443/a.jpg"), rules)).toBe(false);
  });

  it("a resizing proxy may not wrap a plain-http or non-default-port target", () => {
    const rules = [{ host: "wsrv.nl", proxiedHosts: ["cdn.example"] }];
    expect(matchesImageRules(new URL("https://wsrv.nl/?url=https://cdn.example/a.jpg"), rules)).toBe(true);
    expect(matchesImageRules(new URL("https://wsrv.nl/?url=http://cdn.example/a.jpg"), rules)).toBe(false);
    expect(matchesImageRules(new URL("https://wsrv.nl/?url=https://cdn.example:8080/a.jpg"), rules)).toBe(false);
  });

  it("an http page image fails the chapter with a clear error", () => {
    const allow = (u: URL) => u.hostname === "cdn.example";
    expect(() => finalizePages([{ url: "http://cdn.example/1.jpg" }], { base: "https://reader.example/", source: "Test", allow })).toThrow(
      expect.objectContaining({ code: "PAGE_FORMAT_CHANGED", message: expect.stringContaining("plain http") }),
    );
  });
});

describe("finding 7: fixtures replay the full ordered page list, not only count/first/last", () => {
  const golden = JSON.parse(gunzipSync(readFileSync(join(__dirname, "../golden/expected-pages.json.gz"))).toString("utf8")) as Record<string, string[]>;
  const ids = Object.keys(golden).sort();

  it("has a golden list for every recorded fixture, consistent with its recorded count/first/last", () => {
    for (const id of ids) {
      const f = fixture(id);
      expect(golden[id]).toHaveLength(f.expected.count);
      expect(golden[id][0]).toBe(f.expected.first);
      expect(golden[id][golden[id].length - 1]).toBe(f.expected.last);
    }
    expect(ids.length).toBeGreaterThan(40);
  });

  it.each(ids)("%s: every page, in order", async (id) => {
    const f = fixture(id);
    const pages = await pagesFor(f, f.responses);
    expect(pages.map((p) => p.url)).toEqual(golden[id]);
  });

  it("a swap of two middle pages is caught (the old count/first/last check passed it)", () => {
    const id = ids.find((x) => golden[x].length >= 4)!;
    const list = [...golden[id]];
    [list[1], list[2]] = [list[2], list[1]];
    expect(list).toHaveLength(golden[id].length);
    expect(list[0]).toBe(golden[id][0]);
    expect(list[list.length - 1]).toBe(golden[id][golden[id].length - 1]);
    expect(list).not.toEqual(golden[id]);
  });
});
