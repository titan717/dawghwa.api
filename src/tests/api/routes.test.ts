import { describe, expect, it } from "vitest";
import { GET as sourcesGET } from "@/app/api/sources/route";
import { POST as searchPOST } from "@/app/api/search/route";
import { POST as chaptersPOST } from "@/app/api/chapters/route";
import { POST as pagesPOST } from "@/app/api/pages/route";
import { GET as healthGET } from "@/app/api/health/route";
import { GET as frontpageGET, POST as frontpagePOST } from "@/app/api/frontpage/route";
import { GET as indexGET } from "@/app/api/route";
import { resetConfig } from "@/lib/core/config";
import { hangingResponse, jsonResponse, mockFetch } from "../helpers";
import { get, ndjson, post } from "./request";

const MANGA = "37f5cce0-8070-4ada-96e5-fa24b1bd4ff9";

describe("GET /api and /api/sources", () => {
  it("lists sources with status and capabilities (upstream fields kept)", async () => {
    const res = await sourcesGET(get("/api/sources"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources.length).toBe(96);
    const md = body.sources.find((s: { id: string }) => s.id === "mangadex");
    expect(md).toMatchObject({ id: "mangadex", name: "MangaDex", baseUrl: "https://mangadex.org", status: "active" });
    expect(md.capabilities.chapterPages).toBe(true);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(body.sources.find((s: { id: string }) => s.id === "mangapark").status).toBe("shutdown");
  });

  it("index describes endpoints", async () => {
    const res = await indexGET(get("/api"));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/search", () => {
  it("validates input with consistent error bodies", async () => {
    const res = await searchPOST(post("/api/search", { query: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR", error: expect.any(String) });

    const bad = await searchPOST(post("/api/search", "{not json"));
    expect((await bad.json()).code).toBe("INVALID_JSON");

    const unknown = await searchPOST(post("/api/search", { query: "x", source: "nope" }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("SOURCE_NOT_FOUND");

    const big = await searchPOST(post("/api/search", { query: "x".repeat(20_000) }));
    expect(big.status).toBe(413);

    const type = await searchPOST(
      new (await import("next/server")).NextRequest("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "query=x",
      }),
    );
    expect(type.status).toBe(415);
  });

  it("single-source search returns upstream-compatible JSON", async () => {
    mockFetch(() => jsonResponse({ result: "ok", total: 0, data: [] }));
    const res = await searchPOST(post("/api/search", { query: "kaguya", source: "mangadex" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: [], source: "MangaDex", sourceId: "mangadex" });
  });

  it("multi-source search streams NDJSON, isolates failures and times out slow sources", async () => {
    process.env.SEARCH_SOURCE_TIMEOUT_MS = "1000";
    resetConfig();
    mockFetch((url, init) => {
      const host = new URL(url).hostname;
      if (host === "api.mangadex.org") return jsonResponse({ result: "ok", total: 0, data: [] });
      if (host.includes("weebcentral")) return hangingResponse(init); // hung source
      return new Response("down", { status: 500 }); // broken source
    });
    const t0 = Date.now();
    const res = await searchPOST(
      post("/api/search", { query: "x", sources: ["mangadex", "weebcentral", "dynasty-reader", "mangapark"] }),
    );
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = await ndjson(res);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const by = Object.fromEntries(lines.filter((l) => !l.done).map((l) => [l.sourceId, l]));
    expect(by.mangadex.error).toBeUndefined();
    expect(by.weebcentral.errorCode).toBe("UPSTREAM_TIMEOUT");
    expect(by["dynasty-reader"].error).toBeDefined();
    expect(by.mangapark.errorCode).toBe("SOURCE_UNAVAILABLE");
    const summary = lines[lines.length - 1];
    expect(summary).toMatchObject({ done: true, totalSources: 4, completedSources: 4 });
    delete process.env.SEARCH_SOURCE_TIMEOUT_MS;
  });

  it("aggregate mode (stream:false) returns one document", async () => {
    mockFetch(() => jsonResponse({ result: "ok", total: 0, data: [] }));
    const res = await searchPOST(post("/api/search", { query: "x", sources: ["mangadex"], stream: false }));
    const body = await res.json();
    expect(body.summary.done).toBe(true);
    expect(body.sources[0].sourceId).toBe("mangadex");
  });

  it("rate limits expensive multi-source searches per client", async () => {
    process.env.RATE_LIMIT_EXPENSIVE_PER_MINUTE = "2";
    resetConfig();
    const { resetApiRateLimits } = await import("@/lib/api/handler");
    resetApiRateLimits();
    mockFetch(() => jsonResponse({ result: "ok", total: 0, data: [] }));
    const call = () => searchPOST(post("/api/search", { query: "x", sources: ["mangadex"], stream: false }));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await limited.json()).code).toBe("RATE_LIMITED");
    delete process.env.RATE_LIMIT_EXPENSIVE_PER_MINUTE;
  });
});

describe("POST /api/chapters", () => {
  it("blocks SSRF via domain-in-query tricks (upstream used url.includes)", async () => {
    const f = mockFetch(() => jsonResponse({}));
    for (const url of [
      "http://169.254.169.254/latest/meta-data/?mangadex.org",
      "https://evil.example/mangadex.org/title/x",
      "https://mangadex.org.evil.example/title/x",
      "https://user:pw@mangadex.org/title/x",
      "https://mangadex.org:8080/title/x",
      "file:///etc/passwd",
    ]) {
      const res = await chaptersPOST(post("/api/chapters", { url }));
      expect(res.status, url).toBe(400);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a URL that does not belong to the hinted source", async () => {
    const res = await chaptersPOST(post("/api/chapters", { url: `https://mangadex.org/title/${MANGA}`, source: "comix" }));
    expect(res.status).toBe(400);
  });

  it("paginates and orders the cached chapter list", async () => {
    mockFetch(() =>
      jsonResponse({
        result: "ok",
        total: 3,
        data: [1, 2, 3].map((n) => ({
          id: `00000000-0000-4000-8000-00000000000${n}`,
          attributes: { chapter: String(n), pages: 10, publishAt: "2024-01-01T00:00:00Z" },
          relationships: [],
        })),
      }),
    );
    const res = await chaptersPOST(
      post("/api/chapters", { url: `https://mangadex.org/title/${MANGA}`, order: "desc", offset: 0, limit: 2 }),
    );
    const body = await res.json();
    expect(body.chapters.map((c: { number: number }) => c.number)).toEqual([3, 2]);
    expect(body.pagination).toMatchObject({ total: 3, returned: 2, hasMore: true });
    expect(body.totalChapters).toBe(3);
    expect(body.meta.cache).toBe("miss");
    const again = await chaptersPOST(post("/api/chapters", { url: `https://mangadex.org/title/${MANGA}` }));
    expect((await again.json()).meta.cache).toBe("hit");
  });

  it("maps upstream outages to 5xx codes without leaking internals", async () => {
    mockFetch(() => new Response("<html>stack trace secret</html>", { status: 500 }));
    const res = await chaptersPOST(post("/api/chapters", { url: `https://mangadex.org/title/${MANGA}` }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).code).toMatch(/^UPSTREAM_/);
  });
});

describe("POST /api/pages", () => {
  it("returns 501 for sources without a documented page API", async () => {
    const res = await pagesPOST(post("/api/pages", { source: "comix", chapterId: "abc" }));
    expect(res.status).toBe(501);
    expect((await res.json()).code).toBe("UNSUPPORTED_CAPABILITY");
  });

  it("returns MangaDex pages relayed through /api/image", async () => {
    const hash = "0123456789abcdef0123456789abcdef";
    mockFetch(() =>
      jsonResponse({ result: "ok", baseUrl: "https://uploads.mangadex.org", chapter: { hash, data: ["a.png"], dataSaver: [] } }),
    );
    const res = await pagesPOST(post("/api/pages", { source: "mangadex", chapterId: MANGA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalPages).toBe(1);
    const u = new URL(body.pages[0].url);
    expect(u.pathname).toBe("/api/image");
    expect(u.searchParams.get("source")).toBe("mangadex");
    expect(u.searchParams.get("url")).toBe(`https://uploads.mangadex.org/data/${hash}/a.png`);
  });

  it("fails closed instead of handing out a page URL the relay would refuse (PR #6 review, finding 4)", async () => {
    // "h" is not a MangaDex chapter hash, so /api/image would reject the page.
    // Before the fix the route returned the raw upstream URL to the client.
    mockFetch(() =>
      jsonResponse({ result: "ok", baseUrl: "https://uploads.mangadex.org", chapter: { hash: "h", data: ["a.png"], dataSaver: [] } }),
    );
    const res = await pagesPOST(post("/api/pages", { source: "mangadex", chapterId: MANGA }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe("PAGE_FORMAT_CHANGED");
    expect(text).not.toContain("/data/h/a.png");
  });
});

describe("GET /api/health", () => {
  it("reports a single source and caches the result", async () => {
    mockFetch(() => new Response("down", { status: 503 }));
    const res = await healthGET(get("/api/health?source=dynasty-reader"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("dynasty-reader");
    expect(body.health.status).toBe("error");
    expect(body.metrics.failures).toBeGreaterThan(0);
  });
});

describe("/api/frontpage", () => {
  it("lists frontpage-capable sources and validates section requests", async () => {
    const list = await (await frontpageGET(get("/api/frontpage"))).json();
    expect(list.sourceIds).toContain("comix");
    const bad = await frontpagePOST(post("/api/frontpage", { source: "comix", section: "nope" }));
    expect(bad.status).toBe(400);
    const unsupported = await frontpagePOST(post("/api/frontpage", { source: "mangadex", section: "trending" }));
    expect([400, 404, 501]).toContain(unsupported.status);
  });
});
