import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  RobotsDisallowedError,
  StopError,
  backoffDelay,
  createPoliteClient,
  parseRetryAfter,
  parseRobots,
} from "../../../skills/site-structure-study/scripts/polite-fetch.mjs";

// Real captured data (2026-11-22, see analysis/comix-terms.md):
// comix.ws/robots.txt and the Cloudflare 403 block page served for comix.ws/.
const FIXTURES = join(__dirname, "../fixtures/site-study");
const ROBOTS = readFileSync(join(FIXTURES, "comix.ws-robots.txt"), "utf8");
const BLOCK_PAGE = readFileSync(join(FIXTURES, "cloudflare-block-403.html"), "utf8");

type Handler = (url: string) => Response;

/** Fake clock + fetch so timing rules are checked without real waiting or network. */
function harness(handler: Handler, opts: Record<string, unknown> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const calls: { url: string; at: number; init: RequestInit }[] = [];
  const client = createPoliteClient({
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.push({ url, at: clock, init });
      return handler(url);
    },
    ...opts,
  });
  return { client, sleeps, calls };
}

const ok = (body = "{}", headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("parseRobots (real comix.ws robots.txt)", () => {
  it("applies the * group, exposes content signals, and honours named-bot blocks", () => {
    const star = parseRobots(ROBOTS, "site-structure-study/1.0");
    expect(star.isAllowed("/browse?genres_in=16").allowed).toBe(true);
    expect(star.contentSignals).toEqual(["search=yes,ai-train=no,use=reference"]);
    const gpt = parseRobots(ROBOTS, "GPTBot/1.1");
    expect(gpt.isAllowed("/").allowed).toBe(false);
  });

  it("longest match wins and Allow wins ties", () => {
    const r = parseRobots("User-agent: *\nDisallow: /u/\nAllow: /u/public\nDisallow: /*.json$", "x");
    expect(r.isAllowed("/u/123").allowed).toBe(false);
    expect(r.isAllowed("/u/public/1").allowed).toBe(true);
    expect(r.isAllowed("/api/list.json").allowed).toBe(false);
    expect(r.isAllowed("/api/list.json?x=1").allowed).toBe(true);
  });
});

describe("timing helpers", () => {
  it("backs off 1s, 2s, 4s, 8s, 16s", () => {
    expect([0, 1, 2, 3, 4].map((n) => backoffDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000]);
  });
  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter("Sun, 22 Nov 2026 13:48:10 GMT", Date.parse("Sun, 22 Nov 2026 13:48:05 GMT"))).toBe(5000);
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("createPoliteClient", () => {
  it("reads robots.txt first and spaces requests to 1 per second per host", async () => {
    const { client, calls } = harness((u) => (u.endsWith("/robots.txt") ? new Response(ROBOTS) : ok()));
    await client.get("https://comix.ws/a");
    await client.get("https://comix.ws/b");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/robots.txt", "/a", "/b"]);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1000);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(1000);
  });

  it("never sends cookies or credentials", async () => {
    const { client, calls } = harness(() => ok(), { checkRobots: false });
    await client.get("https://comix.ws/a");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
    await expect(client.get("https://u:p@comix.ws/a")).rejects.toBeInstanceOf(StopError);
  });

  it("refuses paths robots.txt disallows without requesting them", async () => {
    const { client, calls } = harness((u) => (u.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /u/") : ok()));
    await expect(client.get("https://comix.ws/u/1")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls).toHaveLength(1);
  });

  it("stops on the real Cloudflare 403 block page and never touches the host again", async () => {
    const { client, calls } = harness(() => new Response(BLOCK_PAGE, { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } }), {
      checkRobots: false,
    });
    await expect(client.get("https://comix.ws/")).rejects.toBeInstanceOf(StopError);
    await expect(client.get("https://comix.ws/other")).rejects.toThrow(/stopped/);
    expect(calls).toHaveLength(1);
    expect(client.stopped.get("comix.ws")).toBe("HTTP 403");
  });

  it("stops on a challenge page even when the status is 200", async () => {
    const { client } = harness(() => new Response(BLOCK_PAGE, { status: 200, headers: { "content-type": "text/html" } }), { checkRobots: false });
    await expect(client.get("https://comix.ws/")).rejects.toThrow(/challenge page/);
  });

  it("retries 429 honouring Retry-After, then exponential backoff, max 5 retries", async () => {
    let n = 0;
    const { client, sleeps, calls } = harness(
      () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "3" } }) : new Response("", { status: 503 })),
      { checkRobots: false },
    );
    const r = await client.get("https://comix.ws/x");
    expect(r.gaveUp).toBe(true);
    expect(calls).toHaveLength(6); // 1 + 5 retries
    // retry waits: Retry-After 3s, then 2s, 4s, 8s, 16s (interval waits are folded in)
    expect(sleeps.filter((s) => s >= 2000)).toEqual([3000, 2000, 4000, 8000, 16000]);
  });

  it("treats a Retry-After beyond the cap as a stop", async () => {
    const { client } = harness(() => new Response("", { status: 429, headers: { "retry-after": "3600" } }), { checkRobots: false });
    await expect(client.get("https://comix.ws/x")).rejects.toThrow(/exceeds max/);
  });

  it("records caching and rate-limit headers", async () => {
    const { client } = harness(
      () => ok("{}", { "cache-control": "public, max-age=60", etag: '"abc"', "x-ratelimit-remaining": "59" }),
      { checkRobots: false },
    );
    const r = await client.get("https://comix.ws/x");
    expect(r.headers).toMatchObject({ "cache-control": "public, max-age=60", etag: '"abc"', "x-ratelimit-remaining": "59" });
  });

  it("enforces the run budget", async () => {
    const { client } = harness(() => ok(), { checkRobots: false, budget: 2 });
    await client.get("https://comix.ws/1");
    await client.get("https://comix.ws/2");
    await expect(client.get("https://comix.ws/3")).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
