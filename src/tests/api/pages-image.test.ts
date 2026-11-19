/**
 * /api/pages dispatch and the per-provider /api/image relay (offline).
 * Provider responses come from real recorded fixtures (src/tests/fixtures/pages).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { POST as pagesPOST } from "@/app/api/pages/route";
import { GET as imageGET } from "@/app/api/image/route";
import { setResolver } from "@/lib/core/net-guard";
import { mockFetch } from "../helpers";
import { get, post } from "./request";

interface Fixture {
  chapterUrl: string;
  expected: { count: number; first: string; last: string };
  responses: Array<{ url: string; method: string; status: number; finalUrl: string; contentType: string; text: string }>;
}
const fixture = (id: string): Fixture =>
  JSON.parse(gunzipSync(readFileSync(join(__dirname, "../fixtures/pages", `${id}.json.gz`))).toString("utf8"));

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...new Array(200).fill(7)]);
const image = (url: string, source?: string) =>
  imageGET(get(`/api/image?url=${encodeURIComponent(url)}${source ? `&source=${encodeURIComponent(source)}` : ""}`));

/** Serve recorded fixture responses through the global fetch used by the HTTP layer. */
function serveFixture(f: Fixture) {
  return mockFetch((url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const hit = f.responses.find((r) => r.url === url && r.method === method);
    if (!hit) return new Response("not recorded", { status: 404 });
    const res = new Response(hit.text, { status: hit.status, headers: { "content-type": hit.contentType } });
    Object.defineProperty(res, "url", { value: hit.finalUrl });
    return res;
  });
}

describe("POST /api/pages (provider dispatch)", () => {
  it("resolves an Asura Scans chapter URL to the Asura adapter and returns its real pages", async () => {
    const f = fixture("asurascan");
    serveFixture(f);
    const res = await pagesPOST(post("/api/pages", { url: f.chapterUrl }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourceId).toBe("asurascan");
    expect(body.totalPages).toBe(f.expected.count);
    const first = new URL(body.pages[0].url);
    expect(first.pathname).toBe("/api/image");
    expect(first.searchParams.get("source")).toBe("asurascan");
    expect(first.searchParams.get("url")).toBe(f.expected.first);
    expect(body.pages.map((p: { index: number }) => p.index)).toEqual([...Array(f.expected.count).keys()]);
  });

  it("serves a repeat request from the cache without another upstream call", async () => {
    const f = fixture("thunderscans");
    const fetchMock = serveFixture(f);
    expect((await pagesPOST(post("/api/pages", { url: f.chapterUrl }))).status).toBe(200);
    const calls = fetchMock.mock.calls.length;
    const again = await (await pagesPOST(post("/api/pages", { url: f.chapterUrl }))).json();
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(again.meta.cache).not.toBe("miss");
    expect(again.sourceId).toBe("thunderscans");
  });

  it("does not serve one provider's cached pages for another provider's chapter", async () => {
    const a = fixture("asurascan");
    const b = fixture("thunderscans");
    serveFixture({ ...a, responses: [...a.responses, ...b.responses] });
    const first = await (await pagesPOST(post("/api/pages", { url: a.chapterUrl }))).json();
    const second = await (await pagesPOST(post("/api/pages", { url: b.chapterUrl }))).json();
    expect(first.sourceId).toBe("asurascan");
    expect(second.sourceId).toBe("thunderscans");
    expect(new URL(second.pages[0].url).searchParams.get("url")).toBe(b.expected.first);
  });

  it("rejects a source/url mismatch instead of guessing", async () => {
    mockFetch(() => new Response("x"));
    const res = await pagesPOST(post("/api/pages", { source: "mangadex", url: fixture("asurascan").chapterUrl }));
    expect(res.status).toBe(400);
  });

  it("maps a locked chapter to 403 CHAPTER_LOCKED", async () => {
    const f = fixture("asurascan");
    serveFixture({
      ...f,
      responses: f.responses.map((r) => ({ ...r, text: r.text.replace("&quot;isLocked&quot;:[0,false]", "&quot;isLocked&quot;:[0,true]") })),
    });
    const res = await pagesPOST(post("/api/pages", { url: f.chapterUrl }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("CHAPTER_LOCKED");
  });

  it("maps a changed reader to 502 PAGE_FORMAT_CHANGED", async () => {
    const f = fixture("asurascan");
    serveFixture({ ...f, responses: f.responses.map((r) => ({ ...r, text: "<html><body>new reader</body></html>" })) });
    const res = await pagesPOST(post("/api/pages", { url: f.chapterUrl }));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("PAGE_FORMAT_CHANGED");
  });

  it("reports providers without a page reader as UNSUPPORTED_CAPABILITY", async () => {
    mockFetch(() => new Response("x"));
    const res = await pagesPOST(post("/api/pages", { url: "https://www.mangago.me/read-manga/x/mf/v01/c001/" }));
    expect([400, 501]).toContain(res.status);
  });
});

describe("GET /api/image?source= (per-provider page relay)", () => {
  const asuraPage = fixture("asurascan").expected.first;

  it("relays an allowed page image with the provider's referer and no client headers", async () => {
    const fetchMock = mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    const res = await image(asuraPage, "asurascan");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("referer")).toMatch(/^https:\/\/asurascans\.com\//);
    expect(headers.get("cookie")).toBeNull();
  });

  it.each([
    ["another host", "https://evil.example/asura-images/chapters/x/001.webp"],
    ["the provider's host outside its page path", "https://cdn.asurascans.com/other/001.webp"],
    ["a private address", "https://169.254.169.254/latest/meta-data"],
  ])("refuses %s without any upstream request", async (_label, url) => {
    const fetchMock = mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    const res = await image(url, "asurascan");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses unknown or non-reader sources", async () => {
    const fetchMock = mockFetch(() => new Response(JPEG));
    expect((await image(asuraPage, "nope")).status).toBe(400);
    expect((await image(asuraPage, "mangago")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an allowed host that resolves to a private address", async () => {
    setResolver(async () => ["10.0.0.5"]);
    const fetchMock = mockFetch(() => new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    const res = await image(asuraPage, "asurascan");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows a redirect between the provider's own page hosts", async () => {
    const start = fixture("kenscans").expected.first;
    const moved = start.replace("storage.kencomics.com", "storage.kenscans.com");
    mockFetch((url) =>
      url === start
        ? new Response(null, { status: 301, headers: { location: moved } })
        : new Response(JPEG, { headers: { "content-type": "image/webp" } }),
    );
    expect((await image(start, "kenscans")).status).toBe(200);
  });

  it("does not follow a redirect off the provider's page hosts", async () => {
    const fetchMock = mockFetch((url) =>
      url === asuraPage
        ? new Response(null, { status: 302, headers: { location: "https://evil.example/x.jpg" } })
        : new Response(JPEG, { headers: { "content-type": "image/jpeg" } }),
    );
    expect((await image(asuraPage, "asurascan")).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after three redirect hops", async () => {
    let n = 0;
    const fetchMock = mockFetch(() => new Response(null, { status: 302, headers: { location: `${asuraPage}?hop=${++n}` } }));
    expect((await image(asuraPage, "asurascan")).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("accepts octet-stream only when the bytes are an image, and relabels it", async () => {
    const page = fixture("siren-scans").expected.first;
    mockFetch(() => new Response(JPEG, { headers: { "content-type": "application/octet-stream" } }));
    const ok = await image(page, "siren-scans");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");

    mockFetch(() => new Response("<html>challenge</html>".padEnd(300, " "), { headers: { "content-type": "application/octet-stream" } }));
    expect((await image(page, "siren-scans")).status).toBe(502);
  });

  it("never relays non-image responses (e.g. an HTML challenge page)", async () => {
    mockFetch(() => new Response("<html>Just a moment...</html>", { headers: { "content-type": "text/html" } }));
    expect((await image(asuraPage, "asurascan")).status).toBe(502);
  });
});
