/**
 * Chapter page extraction, replayed from real provider responses.
 *
 * Every fixture in src/tests/fixtures/pages was recorded from the provider's
 * live reader (scripts/record-page-fixtures.ts) using a chapter URL taken from
 * that provider's own chapter list; HTML is trimmed only when the trimmed
 * replay produces exactly the same pages. These tests are offline and do not
 * depend on the provider being up. Live verification is separate
 * (scripts/verify-readers.ts, src/tests/live/reader-providers.live.test.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import type { Provider } from "@/lib/providers/provider";
import { finalizePages } from "@/lib/scrapers/pages/extract";
import { anySub, matchesImageRules, photon } from "@/lib/scrapers/pages/policy";

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
  recordedAt: string;
  expected: { count: number; first: string; last: string };
  responses: Recorded[];
}

const DIR = join(__dirname, "../fixtures/pages");
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json.gz"))
  .sort()
  .map((f) => JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString("utf8")) as Fixture);
const byId = new Map(fixtures.map((f) => [f.provider, f]));

type HttpHolder = { http: (input: string | URL | Request, init?: RequestInit) => Promise<Response> };
const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

/** Serve the adapter's upstream requests from `responses` (optionally edited). */
function replay(provider: Provider, responses: Recorded[]) {
  const holder = provider.scraper as unknown as HttpHolder;
  const original = holder.http;
  restore.push(() => (holder.http = original));
  const seen: string[] = [];
  holder.http = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url}`);
    const hit = responses.find((r) => r.url === url && r.method === method);
    if (!hit) throw new Error(`unrecorded request ${method} ${url}`);
    const res = new Response(hit.text, { status: hit.status, headers: { "content-type": hit.contentType } });
    Object.defineProperty(res, "url", { value: hit.finalUrl });
    return res;
  };
  return seen;
}

const provider = (id: string) => {
  const p = getRegistry().get(id);
  if (!p) throw new Error(`no provider ${id}`);
  return p;
};
const pagesFor = (f: Fixture, responses = f.responses) => {
  const p = provider(f.provider);
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
/** Edit the first HTML/JSON response body of a fixture. */
const edited = (f: Fixture, edit: (text: string) => string, index = 0) =>
  f.responses.map((r, i) => (i === index ? { ...r, text: edit(r.text) } : r));

describe("page extraction fixtures (real recorded provider responses)", () => {
  it("covers MangaDex, Asura Scans and other providers", () => {
    expect(byId.has("mangadex")).toBe(true);
    expect(byId.has("asurascan")).toBe(true);
    expect(fixtures.length).toBeGreaterThan(20);
  });

  describe.each(fixtures.map((f) => [f.provider, f] as const))("%s", (_id, f) => {
    it("extracts the recorded chapter's pages in reader order", async () => {
      const pages = await pagesFor(f);
      expect(pages).toHaveLength(f.expected.count);
      expect(pages[0]?.url).toBe(f.expected.first);
      expect(pages[pages.length - 1]?.url).toBe(f.expected.last);
      expect(pages.map((p) => p.index)).toEqual(pages.map((_, i) => i));
    });

    it("returns only absolute https/http image URLs on the provider's declared page hosts", async () => {
      const p = provider(f.provider);
      const pages = await pagesFor(f);
      expect(new Set(pages.map((x) => x.url)).size).toBe(pages.length);
      for (const page of pages) {
        const u = new URL(page.url);
        expect(["https:", "http:"]).toContain(u.protocol);
        expect(p.scraper.allowPageImage(page.url), page.url).not.toBeNull();
      }
    });

    it("rejects a chapter URL from another provider", async () => {
      const p = provider(f.provider);
      replay(p, f.responses);
      expect(await codeOf(p.scraper.getChapterPages!({ url: "https://example.org/some/chapter/1" }))).toBe("VALIDATION_ERROR");
    });

    it("surfaces an upstream failure instead of returning pages", async () => {
      const failing = f.responses.map((r) => ({ ...r, status: 500, text: "Internal Server Error", contentType: "text/plain" }));
      const code = await codeOf(pagesFor(f, failing));
      expect(code).not.toBe("resolved");
    });
  });
});

describe("provider-specific behaviour on real markup", () => {
  const asura = byId.get("asurascan")!;

  it("Asura: reads the Astro ChapterReader props in page order", async () => {
    const pages = await pagesFor(asura);
    const numbers = pages.map((p) => Number(p.url.match(/\/(\d{3})\.webp/)?.[1]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(pages.every((p) => p.url.startsWith("https://cdn.asurascans.com/asura-images/chapters/"))).toBe(true);
  });

  it("Asura: a locked chapter is reported as CHAPTER_LOCKED, not as pages", async () => {
    const locked = edited(asura, (t) => t.replace("&quot;isLocked&quot;:[0,false]", "&quot;isLocked&quot;:[0,true]"));
    expect(await codeOf(pagesFor(asura, locked))).toBe("CHAPTER_LOCKED");
  });

  it("Asura: a reader without the ChapterReader component is PAGE_FORMAT_CHANGED", async () => {
    const changed = edited(asura, (t) => t.replace(/ChapterReader/g, "SomethingElse"));
    expect(await codeOf(pagesFor(asura, changed))).toBe("PAGE_FORMAT_CHANGED");
  });

  it("Asura: page images on an unexpected host are refused (PAGE_FORMAT_CHANGED)", async () => {
    const moved = edited(asura, (t) => t.replace(/cdn\.asurascans\.com\/asura-images\/chapters/g, "evil.example/x"));
    expect(await codeOf(pagesFor(asura, moved))).toBe("PAGE_FORMAT_CHANGED");
  });

  it("MangaDex: uses the at-home server manifest, not a guessed URL", async () => {
    const md = byId.get("mangadex")!;
    expect(md.responses.some((r) => r.url.includes("/at-home/server/"))).toBe(true);
    const pages = await pagesFor(md);
    expect(pages[0]?.url).toMatch(/^https:\/\/[^/]+\/data(-saver)?\/[0-9a-f]+\//);
  });

  const theme = ["madarascans", "thunderscans", "violetscans", "eva-scans"].map((id) => byId.get(id)).find(Boolean);
  it("WordPress themes: a reader with no page images is PAGES_NOT_FOUND or PAGE_FORMAT_CHANGED, never an empty success", async () => {
    expect(theme).toBeDefined();
    const empty = edited(theme!, (t) => t.replace(/<img\b[^>]*>/gi, "").replace(/"images"\s*:\s*\[[^\]]*\]/g, '"images":[]'));
    expect(["PAGES_NOT_FOUND", "PAGE_FORMAT_CHANGED"]).toContain(await codeOf(pagesFor(theme!, empty)));
  });

  it("WordPress themes: a removed chapter that redirects to the site root is PAGES_NOT_FOUND", async () => {
    const root = `${new URL(theme!.chapterUrl).origin}/`;
    const redirected = theme!.responses.map((r, i) => (i === 0 ? { ...r, finalUrl: root } : r));
    expect(await codeOf(pagesFor(theme!, redirected))).toBe("PAGES_NOT_FOUND");
  });

  const mangapeak = byId.get("mangataro") ?? byId.get("roliascan");
  it("MangaPeak theme: the provider's INSUFFICIENT_ROLE gate is reported as CHAPTER_LOCKED", async () => {
    expect(mangapeak).toBeDefined();
    const gated = mangapeak!.responses.map((r) =>
      r.url.includes("/auth/chapter-content")
        ? { ...r, status: 403, text: JSON.stringify({ success: false, code: "INSUFFICIENT_ROLE" }) }
        : r,
    );
    expect(await codeOf(pagesFor(mangapeak!, gated))).toBe("CHAPTER_LOCKED");
  });

  it("MangaPeak theme: a text (novel) chapter is PAGES_NOT_FOUND", async () => {
    const text = mangapeak!.responses.map((r) =>
      r.url.includes("/auth/chapter-content") ? { ...r, text: JSON.stringify({ success: true, chapter_type: "text", images: [] }) } : r,
    );
    expect(await codeOf(pagesFor(mangapeak!, text))).toBe("PAGES_NOT_FOUND");
  });

  const stonescape = byId.get("stonescape");
  it("Stonescape: canvas-protected page delivery is PAGES_PROTECTED", async () => {
    expect(stonescape).toBeDefined();
    const protectedPages = stonescape!.responses.map((r) =>
      r.url.endsWith("/pages") ? { ...r, text: r.text.replace(/"delivery":"public"/g, '"delivery":"protected"') } : r,
    );
    expect(await codeOf(pagesFor(stonescape!, protectedPages))).toBe("PAGES_PROTECTED");
  });

  it("Stonescape: a locked (coin) chapter is CHAPTER_LOCKED", async () => {
    const locked = stonescape!.responses.map((r) =>
      r.url.includes("/by-slug/") ? { ...r, text: r.text.replace(/"locked":false/g, '"locked":true') } : r,
    );
    expect(await codeOf(pagesFor(stonescape!, locked))).toBe("CHAPTER_LOCKED");
  });

  const kappa = byId.get("kappabeast");
  it("KappaBeast: a chapter inside its early-access window is CHAPTER_LOCKED", async () => {
    expect(kappa).toBeDefined();
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    const early = kappa!.responses.map((r) =>
      r.url.includes("/chapters?") ? { ...r, text: r.text.replace(/"earlyAccessUntil":null/g, `"earlyAccessUntil":"${future}"`) } : r,
    );
    expect(await codeOf(pagesFor(kappa!, early))).toBe("CHAPTER_LOCKED");
  });
});

describe("page normalisation", () => {
  const allow = (u: URL) => u.hostname === "cdn.example";
  const base = "https://reader.example/chapter/1";

  it("sorts by the provider's ordinal and de-duplicates", () => {
    const pages = finalizePages(
      [
        { url: "https://cdn.example/3.webp", order: 3 },
        { url: "https://cdn.example/1.webp", order: 1 },
        { url: "https://cdn.example/2.webp", order: 2 },
        { url: "https://cdn.example/1.webp", order: 4 },
      ],
      { base, source: "Test", allow },
    );
    expect(pages.map((p) => p.url)).toEqual(["https://cdn.example/1.webp", "https://cdn.example/2.webp", "https://cdn.example/3.webp"]);
    expect(pages.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it("keeps document order when ordinals are missing and resolves relative and protocol-relative URLs", () => {
    const pages = finalizePages([{ url: "//cdn.example/b.jpg" }, { url: "https://cdn.example/a.jpg" }], { base, source: "Test", allow });
    expect(pages.map((p) => p.url)).toEqual(["https://cdn.example/b.jpg", "https://cdn.example/a.jpg"]);
  });

  it("empty input is PAGES_NOT_FOUND", () => {
    expect(() => finalizePages([], { base, source: "Test", allow })).toThrow(expect.objectContaining({ code: "PAGES_NOT_FOUND" }));
  });

  it("only data:/blob: placeholders is PAGES_NOT_FOUND", () => {
    expect(() => finalizePages([{ url: "data:image/gif;base64,R0lGOD" }], { base, source: "Test", allow })).toThrow(
      expect.objectContaining({ code: "PAGES_NOT_FOUND" }),
    );
  });

  it("images on an undeclared host are PAGE_FORMAT_CHANGED, never relayed", () => {
    expect(() => finalizePages([{ url: "https://elsewhere.example/1.jpg" }], { base, source: "Test", allow })).toThrow(
      expect.objectContaining({ code: "PAGE_FORMAT_CHANGED" }),
    );
  });
});

describe("page image allowlist rules", () => {
  it("pins shared CDNs to the provider's own path", () => {
    const rules = photon("example.org");
    expect(matchesImageRules(new URL("https://i0.wp.com/example.org/wp-content/1.jpg"), rules)).toBe(true);
    expect(matchesImageRules(new URL("https://i0.wp.com/other.org/wp-content/1.jpg"), rules)).toBe(false);
  });

  it("subdomain rules match subdomains but not look-alike hosts", () => {
    const rules = [anySub("cdn.example")];
    expect(matchesImageRules(new URL("https://img1.cdn.example/a.jpg"), rules)).toBe(true);
    expect(matchesImageRules(new URL("https://cdn.example/a.jpg"), rules)).toBe(true);
    expect(matchesImageRules(new URL("https://evilcdn.example/a.jpg"), rules)).toBe(false);
    expect(matchesImageRules(new URL("https://cdn.example.evil.org/a.jpg"), rules)).toBe(false);
  });

  it("proxy rules require the proxied target to be a declared host", () => {
    const rules = [{ host: "wsrv.nl", proxiedHosts: ["cdn.example"] }];
    expect(matchesImageRules(new URL("https://wsrv.nl/?url=https://cdn.example/a.jpg"), rules)).toBe(true);
    expect(matchesImageRules(new URL("https://wsrv.nl/?url=https://169.254.169.254/latest"), rules)).toBe(false);
    expect(matchesImageRules(new URL("https://wsrv.nl/"), rules)).toBe(false);
  });

  it("rejects credentials, odd ports and non-http schemes", () => {
    const rules = [{ host: "cdn.example" }];
    expect(matchesImageRules(new URL("https://user:pw@cdn.example/a.jpg"), rules)).toBe(false);
    expect(matchesImageRules(new URL("https://cdn.example:8443/a.jpg"), rules)).toBe(false);
    expect(matchesImageRules(new URL("ftp://cdn.example/a.jpg"), rules)).toBe(false);
  });
});

describe("capability reporting", () => {
  /** Providers investigated and documented as not readable (docs/PAGE_EXTRACTION.md). */
  const DOCUMENTED_UNSUPPORTED = ["mangago", "swarm", "rinko-comics", "novelcool"];

  it("chapterPages is true exactly when the adapter implements getChapterPages", () => {
    for (const p of getRegistry().all()) {
      expect(p.capabilities.chapterPages, p.id).toBe(typeof p.scraper.getChapterPages === "function");
    }
  });

  it("every provider claiming chapter pages restricts its image relay to its own hosts", () => {
    for (const p of getRegistry().all().filter((x) => x.capabilities.chapterPages)) {
      expect(p.scraper.allowPageImage("https://evil.example/page.jpg"), p.id).toBeNull();
      expect(p.scraper.allowPageImage("http://127.0.0.1/page.jpg"), p.id).toBeNull();
      const f = byId.get(p.id);
      if (f) expect(p.scraper.allowPageImage(f.expected.first), p.id).not.toBeNull();
    }
  });

  it("every provider claiming chapter pages has a recorded real-response fixture", () => {
    const missing = getRegistry()
      .all()
      .filter((p) => p.capabilities.chapterPages && !byId.has(p.id))
      .map((p) => p.id);
    expect(missing).toEqual([]);
  });

  it("providers documented as unsupported do not claim chapter pages", () => {
    for (const id of DOCUMENTED_UNSUPPORTED) {
      const p = getRegistry().get(id);
      if (p) expect(p.capabilities.chapterPages, id).toBe(false);
    }
  });
});
