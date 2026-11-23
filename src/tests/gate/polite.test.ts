import { describe, expect, it } from "vitest";
import { BlockedError, GATE_USER_AGENT, PoliteFetcher, RefusedError, UnavailableError, type FetchImpl } from "@/lib/gate/polite";
import { CF_CHALLENGE_HTML } from "../helpers";

function clock(start = Date.parse("2026-11-23T00:00:00Z")) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

type Seen = { url: string; headers: Headers; at: number };

function setup(handler: (url: URL, n: number) => Response, opts: Partial<ConstructorParameters<typeof PoliteFetcher>[0]> = {}) {
  const c = clock();
  const seen: Seen[] = [];
  const inner: FetchImpl = async (input, init) => {
    const url = new URL(input.toString());
    seen.push({ url: url.toString(), headers: new Headers(init.headers), at: c.now() });
    return handler(url, seen.length);
  };
  const f = new PoliteFetcher({ inner, guard: async () => undefined, now: c.now, sleep: c.sleep, ...opts });
  return { f, seen, c };
}

const ok = (body = "ok", headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

describe("PoliteFetcher pacing", () => {
  it("spaces requests to one host by at least 1 s", async () => {
    const { f, seen } = setup(() => ok());
    for (let i = 0; i < 4; i++) await f.get(`https://a.example/p${i}`);
    const gaps = seen.slice(1).map((s, i) => s.at - seen[i]!.at);
    expect(gaps).toEqual([1000, 1000, 1000]);
  });

  it("paces hosts independently", async () => {
    const { f, seen } = setup(() => ok());
    await f.get("https://a.example/");
    await f.get("https://b.example/");
    expect(seen[1]!.at - seen[0]!.at).toBe(0);
  });

  it("never goes below 1 request per second even if asked", async () => {
    const { f, seen } = setup(() => ok(), { minIntervalMs: 10 });
    await f.get("https://a.example/1");
    await f.get("https://a.example/2");
    expect(seen[1]!.at - seen[0]!.at).toBe(1000);
  });
});

describe("PoliteFetcher identity", () => {
  it("sends only the DawghwaBot user agent and strips spoofable headers", async () => {
    const { f, seen } = setup(() => ok());
    await f.get("https://a.example/", {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/124", Referer: "https://a.example/", Origin: "https://a.example", Cookie: "x=1", "sec-ch-ua": "x", Accept: "text/html" },
    });
    const h = seen[0]!.headers;
    expect(h.get("user-agent")).toBe(GATE_USER_AGENT);
    expect(h.get("referer")).toBeNull();
    expect(h.get("origin")).toBeNull();
    expect(h.get("cookie")).toBeNull();
    expect(h.get("sec-ch-ua")).toBeNull();
    expect(h.get("accept")).toBe("text/html");
    expect([...f.strippedHeaders].sort()).toEqual(["cookie", "origin", "referer", "sec-ch-ua", "user-agent"]);
  });

  it("does not record our own user agent as stripped", async () => {
    const { f } = setup(() => ok());
    await f.get("https://a.example/", { headers: { "user-agent": GATE_USER_AGENT } });
    expect(f.strippedHeaders.size).toBe(0);
  });
});

describe("PoliteFetcher stops", () => {
  for (const status of [401, 403]) {
    it(`throws BlockedError on ${status} and latches the host`, async () => {
      const { f, seen } = setup(() => new Response("no", { status }));
      await expect(f.get("https://a.example/x")).rejects.toBeInstanceOf(BlockedError);
      await expect(f.get("https://a.example/y")).rejects.toBeInstanceOf(BlockedError);
      expect(seen).toHaveLength(1); // no retry, no second request
      expect(f.log[0]!.outcome).toBe("blocked");
    });
  }

  it("treats a challenge page as a block", async () => {
    const { f } = setup(() => new Response(CF_CHALLENGE_HTML, { status: 200, headers: { "content-type": "text/html" } }));
    await expect(f.get("https://a.example/")).rejects.toMatchObject({ name: "BlockedError", reason: "challenge" });
  });

  it("treats cf-mitigated: challenge as a block", async () => {
    const { f } = setup(() => new Response("", { status: 200, headers: { "cf-mitigated": "challenge" } }));
    await expect(f.get("https://a.example/")).rejects.toBeInstanceOf(BlockedError);
  });

  it("treats a redirect to a login page as a block", async () => {
    const { f } = setup(() => new Response(null, { status: 302, headers: { location: "/login?next=/x" } }));
    await expect(f.get("https://a.example/x")).rejects.toMatchObject({ reason: "login redirect" });
  });
});

describe("PoliteFetcher backoff", () => {
  it("honours Retry-After on 429, then succeeds", async () => {
    const { f, seen } = setup((_, n) => (n === 1 ? new Response("", { status: 429, headers: { "retry-after": "5" } }) : ok()));
    const res = await f.get("https://a.example/");
    expect(res.status).toBe(200);
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(5000);
    expect(f.log[1]!.retryAfterMs).toBe(5000);
  });

  it("backs off on 5xx and gives up after 3 attempts", async () => {
    const { f, seen } = setup(() => new Response("", { status: 503 }));
    await expect(f.get("https://a.example/")).rejects.toBeInstanceOf(UnavailableError);
    expect(seen).toHaveLength(3);
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(2000);
  });

  it("does not wait for a Retry-After longer than the cap", async () => {
    const { f, seen } = setup(() => new Response("", { status: 429, headers: { "retry-after": "3600" } }));
    await expect(f.get("https://a.example/")).rejects.toThrow(/Retry-After too long/);
    expect(seen).toHaveLength(1);
  });
});

describe("PoliteFetcher redirects and SSRF", () => {
  it("follows same-host redirects", async () => {
    const { f } = setup((u) => (u.pathname === "/old" ? new Response(null, { status: 301, headers: { location: "/new" } }) : ok("new")));
    expect(await (await f.get("https://a.example/old")).text()).toBe("new");
  });

  it("follows redirects to declared hosts only", async () => {
    const { f } = setup((u) => (u.hostname === "a.example" ? new Response(null, { status: 302, headers: { location: "https://cdn.a-img.example/1.png" } }) : ok()));
    await expect(f.get("https://a.example/img")).rejects.toBeInstanceOf(RefusedError);
    expect(f.refused[0]!.reason).toMatch(/undeclared host/);
    f.declareHosts(["a-img.example"]);
    expect((await f.get("https://a.example/img")).status).toBe(200);
  });

  it("refuses undeclared hosts entirely in restricted mode", async () => {
    const { f, seen } = setup(() => ok(), { restrictToDeclared: true, extraHosts: ["a.example"] });
    await f.get("https://a.example/");
    await expect(f.get("https://elsewhere.example/")).rejects.toBeInstanceOf(RefusedError);
    expect(seen).toHaveLength(1);
  });

  it("runs the real SSRF guard on every hop: private and metadata addresses are refused", async () => {
    const { f, seen } = setup((u) => (u.pathname === "/hop" ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }) : ok()), {
      guard: undefined, // default: assertPublicDestination
      extraHosts: ["169.254.169.254"],
    });
    await expect(f.get("https://127.0.0.1/admin")).rejects.toBeInstanceOf(RefusedError);
    await expect(f.get("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(RefusedError);
    await expect(f.get("https://public.example/hop")).rejects.toBeInstanceOf(RefusedError);
    expect(seen.map((s) => s.url)).toEqual(["https://public.example/hop"]);
    expect(f.refused.every((r) => r.reason.startsWith("ssrf-guard"))).toBe(true);
  });
});
