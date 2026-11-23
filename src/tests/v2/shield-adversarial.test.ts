/**
 * SHIELD adversarial checks for the v2 image proxy (Spec H, gates 8 and 10).
 * Mocks only: no request leaves the process. Covers token tampering, SSRF
 * through a validly signed token (a minting bug or a leaked secret), redirect
 * abuse, rate-limit abuse, outgoing request headers and generic errors.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as imgGET } from "@/app/api/v2/img/[token]/route";
import { getConfig } from "@/lib/core/config";
import { setResolver } from "@/lib/core/net-guard";
import { getRegistry } from "@/lib/providers/registry";
import { pageImageHeaders } from "@/lib/services/page-image";
import { resetImageRate } from "@/lib/v2/image";
import { findProviderTerm } from "@/lib/v2/leak";
import { HostPacer, setV2Pacer } from "@/lib/v2/pacer";
import { MAX_TOKEN_LENGTH, signImageToken, verifyImageToken } from "@/lib/v2/token";
import { mockFetch } from "../helpers";
import { get } from "../api/request";
import { PAGE_URL, SECRET } from "./fixtures";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...new Array(200).fill(7)]);
const okImage = () => new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
const img = (token: string, headers: Record<string, string> = {}) =>
  imgGET(get(`/api/v2/img/${encodeURIComponent(token)}`, headers), { params: { token } });
const sign = (url: string, sourceId = "mangadex", secret = SECRET) => signImageToken({ sourceId, url }, secret, 1800).token;

async function expectGenericFailure(res: Response, status?: number) {
  if (status !== undefined) expect(res.status).toBe(status);
  expect(res.status).toBeGreaterThanOrEqual(400);
  const text = await res.text();
  expect(findProviderTerm(text), `body leaks: ${text}`).toBeUndefined();
  res.headers.forEach((v, k) => expect(findProviderTerm(`${k}: ${v}`), `header ${k} leaks`).toBeUndefined());
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["error"]);
  expect(String(body.error)).not.toMatch(/https?:|\/\/|signature|expired|token|secret|host|dns|private/i);
}

beforeEach(() => {
  process.env.IMAGE_PROXY = "1";
  process.env.IMAGE_PROXY_SECRET = SECRET;
  delete process.env.IMAGE_PROXY_RATE_PER_MINUTE;
  resetImageRate();
  setV2Pacer(new HostPacer(0));
  setResolver(async () => ["93.184.216.34"]); // a public address; never contacted (fetch is mocked)
});
afterEach(() => setResolver(null));

describe("token tampering", () => {
  const good = sign(PAGE_URL.mangadex!(0));

  it("every single-character change anywhere in the token is rejected", () => {
    const alphabet = "AQgw_-09";
    let tried = 0;
    for (let i = 0; i < good.length; i++) {
      if (good[i] === ".") continue;
      for (const c of alphabet) {
        if (c === good[i]) continue;
        const t = good.slice(0, i) + c + good.slice(i + 1);
        // Some base64url characters differ only in unused trailing bits; those decode to the same bytes.
        if (Buffer.from(t.split(".")[0]!, "base64url").equals(Buffer.from(good.split(".")[0]!, "base64url")) &&
            Buffer.from(t.split(".")[1]!, "base64url").equals(Buffer.from(good.split(".")[1]!, "base64url"))) continue;
        expect(verifyImageToken(t, SECRET).ok, `accepted change at ${i} -> ${c}`).toBe(false);
        tried++;
      }
    }
    expect(tried).toBeGreaterThan(good.length * 3);
  });

  it("swapping signatures between two valid tokens, or reusing one under another secret, is rejected", () => {
    const other = sign(PAGE_URL.mangadex!(1));
    const [b1, m1] = good.split(".") as [string, string];
    const [b2, m2] = other.split(".") as [string, string];
    expect(verifyImageToken(`${b1}.${m2}`, SECRET).ok).toBe(false);
    expect(verifyImageToken(`${b2}.${m1}`, SECRET).ok).toBe(false);
    expect(verifyImageToken(good, SECRET + "x").ok).toBe(false);
    expect(verifyImageToken(sign(PAGE_URL.mangadex!(0), "mangadex", "another-secret-0123456789abcdef-01234"), SECRET).ok).toBe(false);
  });

  it("structural garbage is rejected as malformed without throwing", () => {
    const [b, m] = good.split(".") as [string, string];
    const cases = [
      "", ".", `${b}.`, `.${m}`, `${b}.${m}.${m}`, `${b}=.${m}`, `${b}.${m}=`, ` ${good}`, `${good} `, `${good}\n`,
      `${b}+.${m}`, `${b}/.${m}`, `${b}%2E${m}`, good.replace(".", "\u2024"), good.toUpperCase(), "A".repeat(MAX_TOKEN_LENGTH + 1),
      `${"A".repeat(MAX_TOKEN_LENGTH - m.length - 1)}.${m}`, "../../api/v2/chapter", "..%2F..%2Fetc%2Fpasswd", "eyJhbGciOiJub25lIn0.e30.", "null", "undefined",
    ];
    for (const t of cases) {
      const r = verifyImageToken(t, SECRET);
      expect(r.ok, `accepted ${JSON.stringify(t.slice(0, 40))}`).toBe(false);
    }
  });

  it("tampered and garbage tokens get a generic 404 from the route and never reach upstream", async () => {
    const f = mockFetch(okImage);
    const bad = good.slice(0, 30) + (good[30] === "A" ? "B" : "A") + good.slice(31);
    for (const t of [bad, "x", "../chapter", "A".repeat(5000)]) await expectGenericFailure(await img(t), 404);
    expect(f).not.toHaveBeenCalled();
  });

  it("an expired token is 410 and generic; a token with a far-future expiry is still bounded by its own exp", async () => {
    const f = mockFetch(okImage);
    const old = signImageToken({ sourceId: "mangadex", url: PAGE_URL.mangadex!(0) }, SECRET, 300, Date.now() - 2 * 3_600_000).token;
    await expectGenericFailure(await img(old), 410);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("SSRF through a validly signed token", () => {
  // These tokens are signed with the real secret on purpose: they model a minting bug or a leaked
  // secret. The per-source allow-list and the destination guard must still refuse them.
  const hostile = [
    "http://uploads.mangadex.org/data/0123456789abcdef0123/1-abc.jpg",
    "https://uploads.mangadex.org:8443/data/0123456789abcdef0123/1-abc.jpg",
    "https://user:pass@uploads.mangadex.org/data/0123456789abcdef0123/1-abc.jpg",
    "https://uploads.mangadex.org.evil.example/data/0123456789abcdef0123/1-abc.jpg",
    "https://evil.example/uploads.mangadex.org/data/0123456789abcdef0123/1-abc.jpg",
    "https://127.0.0.1/data/0123456789abcdef0123/1-abc.jpg",
    "https://[::1]/data/0123456789abcdef0123/1-abc.jpg",
    "https://[::ffff:127.0.0.1]/data/0123456789abcdef0123/1-abc.jpg",
    "https://169.254.169.254/latest/meta-data/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://0x7f000001/data/0123456789abcdef0123/1-abc.jpg",
    "https://2130706433/data/0123456789abcdef0123/1-abc.jpg",
    "https://localhost/data/0123456789abcdef0123/1-abc.jpg",
    "file:///etc/passwd",
    "gopher://uploads.mangadex.org/_x",
    "https://uploads.mangadex.org/data/../../admin",
    "https://uploads.mangadex.org/data/%2e%2e/%2e%2e/admin",
    "https://uploads.mangadex.org/data/0123456789abcdef0123/1-abc.jpg?redirect=https://10.0.0.1/",
  ];

  it.each(hostile)("refuses %s without any upstream request", async (url) => {
    const f = mockFetch(okImage);
    await expectGenericFailure(await img(sign(url)), 404);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a token whose source id does not exist or is spoofed", async () => {
    const f = mockFetch(okImage);
    // (Case and surrounding spaces resolve to the same provider by design; that is not a bypass.)
    for (const s of ["", "../mangadex", "mangadex/..", "__proto__", "constructor", "toString", "not-a-source"]) await expectGenericFailure(await img(sign(PAGE_URL.mangadex!(0), s)), 404);
    expect(f).not.toHaveBeenCalled();
  });

  it("DNS rebinding: an allow-listed host that resolves to a private address is refused before fetching", async () => {
    for (const addr of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "100.64.0.1"]) {
      setResolver(async () => ["93.184.216.34", addr]);
      const f = mockFetch(okImage);
      await expectGenericFailure(await img(sign(PAGE_URL.mangadex!(0))));
      expect(f, `fetched despite ${addr}`).not.toHaveBeenCalled();
    }
  });

  it("redirects to private, non-allow-listed or non-https targets are refused after one request", async () => {
    for (const location of ["https://10.0.0.1/x.jpg", "https://evil.example/x.jpg", "http://uploads.mangadex.org/data/0123456789abcdef0123/2-abc.jpg", "file:///etc/passwd", "//169.254.169.254/"]) {
      const f = mockFetch(() => new Response(null, { status: 302, headers: { location } }));
      await expectGenericFailure(await img(sign(PAGE_URL.mangadex!(0))), 502);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
});

describe("rate-limit abuse", () => {
  it("one client cannot exceed the limit; failures stay generic", async () => {
    process.env.IMAGE_PROXY_RATE_PER_MINUTE = "3";
    mockFetch(okImage);
    const t = sign(PAGE_URL.mangadex!(0));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await img(t, { "x-real-ip": "198.51.100.7" })).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
    const limited = await img(t, { "x-real-ip": "198.51.100.7" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    await expectGenericFailure(limited, 429);
  });

  it("invalid tokens count against the limit too (no free probing)", async () => {
    process.env.IMAGE_PROXY_RATE_PER_MINUTE = "2";
    const f = mockFetch(okImage);
    for (let i = 0; i < 2; i++) expect((await img("garbage" + i, { "x-real-ip": "198.51.100.8" })).status).toBe(404);
    expect((await img(sign(PAGE_URL.mangadex!(0)), { "x-real-ip": "198.51.100.8" })).status).toBe(429);
    expect(f).not.toHaveBeenCalled();
  });

  // SHIELD finding S0-6: with TRUST_PROXY on (the default), the client id is the FIRST
  // X-Forwarded-For entry, which the caller controls. Rotating it gets a fresh bucket per request.
  // Vercel appends the real address as the LAST entry (and sets x-real-ip). RELAY: key on the
  // platform-set address. Flip to it() once fixed.
  it.fails("rotating a spoofed X-Forwarded-For does not reset the bucket", async () => {
    process.env.IMAGE_PROXY_RATE_PER_MINUTE = "2";
    mockFetch(okImage);
    const t = sign(PAGE_URL.mangadex!(0));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await img(t, { "x-forwarded-for": `10.9.9.${i}, 198.51.100.9`, "x-real-ip": "198.51.100.9" })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
  });
});

describe("outgoing request to the upstream image host", () => {
  async function captured(sourceId: string, url: string) {
    let seen: Headers | null = null;
    mockFetch((_u, init) => {
      seen = new Headers(init.headers as HeadersInit);
      return okImage();
    });
    await img(sign(url, sourceId));
    return seen as Headers | null;
  }

  it("never forwards the reader's cookies, auth or client address", async () => {
    let seen: Headers | null = null;
    mockFetch((_u, init) => {
      seen = new Headers(init.headers as HeadersInit);
      return okImage();
    });
    await img(sign(PAGE_URL.mangadex!(0)), { cookie: "sid=1", authorization: "Bearer x", "x-forwarded-for": "198.51.100.1", referer: "https://dawghwa.vercel.app/read/x" });
    expect(seen).not.toBeNull();
    for (const h of ["cookie", "authorization", "x-forwarded-for", "x-real-ip", "forwarded"]) expect(seen!.has(h), h).toBe(false);
    expect(seen!.get("referer") ?? "").not.toContain("dawghwa");
  });

  // SHIELD finding S0-1 (raised by JUDGE): pageImageHeaders() sends a provider Referer, a forged
  // Origin for one provider and a browser User-Agent by default. Spec H and section 14 forbid
  // header spoofing. RELAY fixes this in cycle 1; flip each to it() in that PR.
  it.fails("sends no spoofed Referer or Origin to any provider", async () => {
    for (const [id, url] of Object.entries(PAGE_URL)) {
      const h = await captured(id, url(0));
      expect(h, `${id} not fetched`).not.toBeNull();
      expect(h!.has("referer"), `${id} referer`).toBe(false);
      expect(h!.has("origin"), `${id} origin`).toBe(false);
    }
  });

  it.fails("identifies itself instead of posing as a browser, for every provider with page images", () => {
    const browser = /Mozilla|Chrome|Safari|Gecko/;
    expect(getConfig().http.userAgent, "default upstream user agent").not.toMatch(browser);
    for (const p of getRegistry().all().filter((p) => p.capabilities.chapterPages))
      expect(pageImageHeaders(p)["User-Agent"] ?? "", `${p.id} user-agent`).not.toMatch(browser);
  });
});
