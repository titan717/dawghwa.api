import { describe, expect, it } from "vitest";
import { PoliteFetcher, type FetchImpl } from "@/lib/gate/polite";
import { crawlDelay, fetchRobots, isAllowed, parseRobots } from "@/lib/gate/robots";
import { CF_CHALLENGE_HTML } from "../helpers";

const TXT = `
# comment
User-agent: *
Disallow: /api/
Allow: /api/public/
Disallow: /*.json$
Disallow: /search?
Crawl-delay: 2
Content-Signal: search=yes, ai-train=no

User-agent: OtherBot
User-agent: DawghwaBot
Disallow: /read/
Allow: /read/free/
Crawl-delay: 5

Sitemap: https://site.example/sitemap.xml
`;

describe("robots.txt parsing (RFC 9309)", () => {
  const r = parseRobots(TXT);

  it("groups consecutive user-agent lines", () => {
    expect(r.groups).toHaveLength(2);
    expect(r.groups[1]!.agents).toEqual(["otherbot", "dawghwabot"]);
  });

  it("uses the longest match and lets Allow win ties", () => {
    expect(isAllowed(r, "/api/x").allowed).toBe(false);
    expect(isAllowed(r, "/api/public/x").allowed).toBe(true);
    const tie = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a\n");
    expect(isAllowed(tie, "/a").allowed).toBe(true);
  });

  it("supports * and $", () => {
    expect(isAllowed(r, "/data/list.json").allowed).toBe(false);
    expect(isAllowed(r, "/data/list.json?x=1").allowed).toBe(true);
    expect(isAllowed(r, "/search?q=a").allowed).toBe(false);
  });

  it("applies the stricter of our group and *", () => {
    const d = isAllowed(r, "/read/1");
    expect(d).toMatchObject({ allowed: false, ours: false, star: true });
    expect(isAllowed(r, "/read/free/1").allowed).toBe(true);
    expect(isAllowed(r, "/api/x")).toMatchObject({ ours: true, star: false, allowed: false });
  });

  it("treats an empty Disallow as allow-all and robots.txt itself as allowed", () => {
    const e = parseRobots("User-agent: *\nDisallow:\n");
    expect(isAllowed(e, "/anything").allowed).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /\n"), "/robots.txt").allowed).toBe(true);
  });

  it("records content signals, sitemaps and the larger crawl-delay", () => {
    expect(r.signals).toEqual(["content-signal: search=yes, ai-train=no"]);
    expect(r.sitemaps).toEqual(["https://site.example/sitemap.xml"]);
    expect(crawlDelay(r)).toBe(5);
  });
});

describe("robots.txt fetch rules", () => {
  const fetcher = (res: () => Response | Promise<Response>) => {
    let t = 0;
    const inner: FetchImpl = async () => res();
    return new PoliteFetcher({ inner, guard: async () => undefined, now: () => t, sleep: async (ms) => void (t += ms) });
  };

  it("2xx: parsed", async () => {
    const r = await fetchRobots(fetcher(() => new Response("User-agent: *\nDisallow: /x\n")), "https://s.example");
    expect(r.kind).toBe("parsed");
  });

  for (const status of [404, 410]) {
    it(`${status}: allow-all`, async () => {
      expect((await fetchRobots(fetcher(() => new Response("", { status })), "https://s.example")).kind).toBe("allow-all");
    });
  }

  it("other 4xx: disallow-all (stricter than the RFC)", async () => {
    expect((await fetchRobots(fetcher(() => new Response("", { status: 451 })), "https://s.example")).kind).toBe("disallow-all");
  });

  it("5xx: disallow-all", async () => {
    expect((await fetchRobots(fetcher(() => new Response("", { status: 500 })), "https://s.example")).kind).toBe("disallow-all");
  });

  it("unreachable: disallow-all", async () => {
    const r = await fetchRobots(fetcher(() => Promise.reject(new TypeError("fetch failed"))), "https://s.example");
    expect(r).toMatchObject({ kind: "disallow-all" });
  });

  for (const status of [401, 403]) {
    it(`${status}: blocked (gate 4)`, async () => {
      expect((await fetchRobots(fetcher(() => new Response("", { status })), "https://s.example")).kind).toBe("blocked");
    });
  }

  it("challenge on robots.txt: blocked", async () => {
    const r = await fetchRobots(fetcher(() => new Response(CF_CHALLENGE_HTML, { headers: { "content-type": "text/html" } })), "https://s.example");
    expect(r).toMatchObject({ kind: "blocked", reason: "challenge" });
  });
});
