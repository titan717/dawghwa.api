/**
 * Route-level tests for /api/v2/chapter and /api/v2/img/<token>: responses
 * (bodies AND headers) must contain none of the provider names, ids, aliases,
 * domains or image hosts registered in the codebase; errors are generic; the
 * image relay enforces its rate, size and content-type limits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as chapterGET } from "@/app/api/v2/chapter/route";
import { GET as imgGET } from "@/app/api/v2/img/[token]/route";
import { UpstreamHttpError } from "@/lib/core/errors";
import { resetConfig } from "@/lib/core/config";
import { resetApiRateLimits } from "@/lib/api/handler";
import { getTitleMetadata } from "@/lib/metadata";
import { getRegistry } from "@/lib/providers/registry";
import { aggregateChapters } from "@/lib/services/unified";
import { resetV2Breakers } from "@/lib/v2/breaker";
import { orderVersions } from "@/lib/v2/chapter";
import { deliverImage, resetImageRate } from "@/lib/v2/image";
import { findProviderTerm, providerTerms } from "@/lib/v2/leak";
import { HostPacer, setV2Pacer } from "@/lib/v2/pacer";
import { signImageToken } from "@/lib/v2/token";
import { meta } from "../chapters/fixtures";
import { mockFetch } from "../helpers";
import { get } from "../api/request";
import { CANON, PAGE_URL, pagesFor, rows, SECRET, type Upload } from "./fixtures";

vi.mock("@/lib/metadata", async (orig) => ({ ...(await orig<typeof import("@/lib/metadata")>()), getTitleMetadata: vi.fn() }));
vi.mock("@/lib/services/unified", async (orig) => ({ ...(await orig<typeof import("@/lib/services/unified")>()), aggregateChapters: vi.fn() }));

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...new Array(200).fill(7)]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const ALL: Upload[] = [
  { source: "mangadex", number: "1", title: "Read this on MangaDex" },
  { source: "dynasty-reader", number: "1", title: "Read this on MangaDex" },
  { source: "webtoon", number: "1" },
  { source: "mangadex", number: "2", title: "Rain" },
];

function serve(uploads: Upload[], pages: Record<string, () => unknown> = {}) {
  vi.mocked(getTitleMetadata).mockImplementation(async () => ({ title: meta(), cache: "miss", age: 0 }));
  vi.mocked(aggregateChapters).mockImplementation(async () => ({ title: { id: CANON }, chapters: rows(uploads) }) as never);
  for (const id of ["mangadex", "dynasty-reader", "webtoon"]) {
    const p = getRegistry().get(id)!;
    vi.spyOn(p.scraper, "getChapterPages").mockImplementation(async () => {
      const fn = pages[id];
      return (fn ? fn() : pagesFor(id)) as never;
    });
  }
}

async function assertNoLeak(res: Response): Promise<string> {
  const text = await res.clone().text();
  expect(findProviderTerm(text), `body leaks: ${text.slice(0, 300)}`).toBeUndefined();
  res.headers.forEach((v, k) => expect(findProviderTerm(`${k}: ${v}`), `header ${k} leaks`).toBeUndefined());
  return text;
}

const chapter = (qs: string) => chapterGET(get(`/api/v2/chapter?${qs}`));
const img = (token: string) => imgGET(get(`/api/v2/img/${token}`), { params: { token } });

beforeEach(() => {
  process.env.IMAGE_PROXY = "1";
  process.env.IMAGE_PROXY_SECRET = SECRET;
  delete process.env.IMAGE_PROXY_RATE_PER_MINUTE;
  resetV2Breakers();
  resetImageRate();
  setV2Pacer(new HostPacer(0));
});

describe("leak guard inventory", () => {
  it("covers every registered provider id, name, alias and domain plus image hosts", () => {
    const terms = providerTerms();
    const r = getRegistry();
    expect(terms.length).toBeGreaterThan(r.all().length * 2);
    for (const p of r.all()) {
      expect(terms).toContain(p.id.toLowerCase());
      for (const d of p.descriptor.domains) expect(terms).toContain(d.toLowerCase());
    }
    for (const t of ["pstatic.net", "mangadex.network", "anilist", "mangaupdates"]) expect(terms).toContain(t);
  });
});

describe("GET /api/v2/chapter (no provider details anywhere)", () => {
  it("success: body and headers contain no provider names/slugs/hosts; leaky chapter titles are dropped", async () => {
    serve(ALL);
    const res = await chapter(`title=${encodeURIComponent(CANON)}&n=1&lang=en`);
    expect(res.status).toBe(200);
    const body = JSON.parse(await assertNoLeak(res));
    expect(body.title).toBe(CANON);
    expect(body.chapter).toEqual({ number: "1", display: "Chapter 1", language: "en" });
    expect(body.pages).toHaveLength(3);
    expect(body.version).toMatchObject({ index: 0, count: 3 });
    expect(Object.keys(body).sort()).toEqual(["chapter", "pages", "pagesExpireAt", "title", "totalPages", "version"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps meaningful chapter titles", async () => {
    serve(ALL);
    const body = await (await chapter(`title=${encodeURIComponent(CANON)}&n=2`)).json();
    expect(body.chapter.title).toBe("Rain");
  });

  it("fallback and alt responses do not leak either", async () => {
    // Make the version at index 1 fail: alt=1 then falls back to index 2.
    const failing = orderVersions(rows(ALL).find((r) => r.number === "1")!.variants, (id) => getRegistry().get(id)!.descriptor.priority)[1]!.sourceId;
    serve(ALL, { [failing]: () => Promise.reject(new UpstreamHttpError(403, "https://dynasty-scans.com/x")) });
    for (const [qs, index] of [["n=1", 0], ["n=1&alt=1", 2], ["n=1&alt=2", 2]] as const) {
      const res = await chapter(`title=${encodeURIComponent(CANON)}&${qs}`);
      expect(res.status, qs).toBe(200);
      expect((await res.clone().json()).version.index, qs).toBe(index);
      await assertNoLeak(res);
    }
  });

  it("every failure is exactly {error: 'Chapter unavailable'} with a fitting status", async () => {
    const boom = () => Promise.reject(new UpstreamHttpError(403, "https://dynasty-scans.com/x"));
    serve(ALL, { mangadex: boom, "dynasty-reader": boom, webtoon: boom });
    const cases: [string, number][] = [
      [`title=${encodeURIComponent(CANON)}&n=1`, 502],
      [`title=${encodeURIComponent(CANON)}&n=99`, 404],
      [`title=${encodeURIComponent(CANON)}&n=1&alt=9`, 404],
      [`title=mangadex&n=1`, 400],
      [`title=${encodeURIComponent(CANON)}&n=abc`, 400],
      [`title=${encodeURIComponent(CANON)}&n=1&lang=<x>`, 400],
      [`title=${encodeURIComponent(CANON)}&n=1&alt=-1`, 400],
      [`n=1`, 400],
    ];
    for (const [qs, status] of cases) {
      const res = await chapter(qs);
      expect(res.status, qs).toBe(status);
      expect(await res.clone().json()).toEqual({ error: "Chapter unavailable" });
      await assertNoLeak(res);
    }
  });

  it("aggregation failures stay generic", async () => {
    serve(ALL);
    vi.mocked(aggregateChapters).mockImplementation(async () => {
      throw new Error("MangaDex returned HTTP 500 from api.mangadex.org");
    });
    const res = await chapter(`title=${encodeURIComponent(CANON)}&n=1`);
    expect(res.status).toBe(502);
    expect(await assertNoLeak(res)).toBe('{"error":"Chapter unavailable"}');
  });

  it("IMAGE_PROXY off keeps the current relay page URLs; everything else stays clean", async () => {
    delete process.env.IMAGE_PROXY;
    serve(ALL);
    const body = await (await chapter(`title=${encodeURIComponent(CANON)}&n=1`)).json();
    expect(new URL(body.pages[0].url).pathname).toBe("/api/image");
    const { pages, ...rest } = body;
    void pages;
    expect(findProviderTerm(JSON.stringify(rest))).toBeUndefined();
  });

  it("client rate limit applies and its response does not leak", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "1";
    resetConfig();
    resetApiRateLimits();
    serve(ALL);
    expect((await chapter(`title=${encodeURIComponent(CANON)}&n=1`)).status).toBe(200);
    const limited = await chapter(`title=${encodeURIComponent(CANON)}&n=1`);
    expect(limited.status).toBe(429);
    await assertNoLeak(limited);
    delete process.env.RATE_LIMIT_PER_MINUTE;
  });
});

describe("GET /api/v2/img/<token>", () => {
  const token = (source = "mangadex", url = PAGE_URL.mangadex!(0)) => signImageToken({ sourceId: source, url }, SECRET, 1800).token;

  it("relays a valid token's image with only safe headers", async () => {
    const f = mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg", "x-cache": "HIT from mangadex", server: "mangadex" } }));
    const res = await img(token());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Number(res.headers.get("cache-control")!.match(/max-age=(\d+)/)![1])).toBeGreaterThan(1700);
    await assertNoLeak(new Response(null, { headers: res.headers }));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    expect(f.mock.calls.map((c) => String(c[0]))).toContain(PAGE_URL.mangadex!(0));
  });

  it("404 when the proxy is off, the token is tampered or names a host outside the source's allowlist", async () => {
    mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    const good = token();
    const bad = good.slice(0, 20) + (good[20] === "A" ? "B" : "A") + good.slice(21);
    for (const t of [bad, token("mangadex", "https://evil.example/a.jpg"), token("not-a-source")]) {
      const res = await img(t);
      expect(res.status).toBe(404);
      expect(await assertNoLeak(res)).toBe('{"error":"Image unavailable"}');
    }
    delete process.env.IMAGE_PROXY;
    expect((await img(good)).status).toBe(404);
  });

  it("410 for an expired token", async () => {
    const t = signImageToken({ sourceId: "mangadex", url: PAGE_URL.mangadex!(0) }, SECRET, 300, Date.now() - 3_600_000).token;
    const res = await img(t);
    expect(res.status).toBe(410);
    await assertNoLeak(res);
  });

  it("treats an upstream 403/challenge as failure without retrying", async () => {
    const f = mockFetch(() => new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } }));
    const res = await img(token());
    expect(res.status).toBe(502);
    expect(f).toHaveBeenCalledTimes(1);
    await assertNoLeak(res);
  });

  it("only image content: non-image types and SVG are refused; octet-stream JPEG bytes are accepted", async () => {
    mockFetch(() => new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }));
    expect((await img(token())).status).toBe(502);
    mockFetch(() => new Response(SVG, { headers: { "content-type": "image/svg+xml" } }));
    expect((await img(token())).status).toBe(502);
    mockFetch(() => new Response(JPEG, { headers: { "content-type": "application/octet-stream" } }));
    const ok = await img(token());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
  });

  it("size limit: declared and streamed bodies over the cap are refused", async () => {
    mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg", "content-length": String(50 * 1024 * 1024) } }));
    expect((await img(token())).status).toBe(502);
    mockFetch(() => {
      const chunk = new Uint8Array(64 * 1024).fill(1);
      chunk.set(JPEG.subarray(0, 12));
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent++ > 10) c.close();
          else c.enqueue(chunk);
        },
      });
      return new Response(stream, { headers: { "content-type": "image/jpeg" } });
    });
    const out = await deliverImage(token(), { maxBytes: 256 * 1024 });
    expect(out).toEqual({ ok: false, status: 502 });
    const under = await deliverImage(token(), { maxBytes: 2 * 1024 * 1024 });
    expect(under.ok).toBe(true);
  });

  it("per-client rate limit returns 429 with Retry-After", async () => {
    process.env.IMAGE_PROXY_RATE_PER_MINUTE = "2";
    mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    const t = token();
    expect((await img(t)).status).toBe(200);
    expect((await img(t)).status).toBe(200);
    const limited = await img(t);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: "Too many requests" });
  });

  it("paces upstream requests to one host at 1/second and refuses past the wait budget", async () => {
    let now = 0;
    const sleeps: number[] = [];
    setV2Pacer(new HostPacer(1_000, () => now, async (ms) => void sleeps.push(ms)));
    mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    for (let i = 0; i < 2; i++) expect((await deliverImage(token("mangadex", PAGE_URL.mangadex!(i)), { pacingMaxWaitMs: 1_500 })).ok).toBe(true);
    expect(sleeps).toEqual([1_000]);
    // The third request would have to wait 2 s, beyond the 1.5 s budget: refused, never sent.
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    expect(await deliverImage(token("mangadex", PAGE_URL.mangadex!(2)), { pacingMaxWaitMs: 1_500 })).toEqual({ ok: false, status: 503, retryAfter: 2 });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
    now = 0;
  });
});
