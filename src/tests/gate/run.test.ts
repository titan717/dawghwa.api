import { describe, expect, it } from "vitest";
import { fixtureAdapter, fixtureInner, type FixtureProvider } from "@/lib/gate/fixture";
import { PoliteFetcher, type FetchImpl } from "@/lib/gate/polite";
import { renderReport } from "@/lib/gate/report";
import { RUNNER_VERSION, runGates } from "@/lib/gate/run";
import { parseRunRecord } from "@/lib/gate/gates";
import raw from "../fixtures/gate/synthetic-provider.json";

const base = raw as unknown as FixtureProvider;
const clone = (): FixtureProvider => JSON.parse(JSON.stringify(base));

function setup(f: FixtureProvider, override?: (u: URL) => Response | null) {
  let t = Date.parse("2026-11-23T00:00:00Z");
  const sent: string[] = [];
  const fx = fixtureInner(f);
  const inner: FetchImpl = async (input, init) => {
    sent.push(input.toString());
    return override?.(new URL(input.toString())) ?? fx(input, init);
  };
  const fetcher = new PoliteFetcher({ inner, restrictToDeclared: true, now: () => t, sleep: async (ms) => void (t += ms) });
  const adapter = fixtureAdapter(f, { request: (u) => fetcher.get(u) });
  const run = (extra: Partial<Parameters<typeof runGates>[0]> = {}) =>
    runGates({ adapter, fetcher, review: f.review, titles: f.titles, history: [], leak: null, minScore: 0.82, projectedDailyRequests: 600, now: () => t, ...extra });
  return { fetcher, sent, run };
}

const statuses = (o: { results: { status: string }[] }) => o.results.map((r) => r.status);

describe("runGates over the recorded fixture", () => {
  it("passes 1-6 and 9; 7 and 8 need evidence; verdict disabled; flag stays OFF", async () => {
    const before = { ...process.env };
    const { run } = setup(clone());
    const o = await run();
    expect(statuses(o)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "needs-evidence", "needs-evidence", "pass"]);
    expect(o.verdict).toBe("disabled");
    const md = renderReport(o);
    expect(md).toContain("stays OFF");
    expect(md).toContain("PROVIDER_SYNTHETIC_READER");
    expect(process.env).toEqual(before);
    // Gate 7 record is complete and parseable.
    expect(o.record!.runnerVersion).toBe(RUNNER_VERSION);
    expect(parseRunRecord(JSON.parse(JSON.stringify(o.record)))).not.toBeNull();
    expect(o.record!.requests.total).toBeGreaterThan(12);
  });

  it("with 3 spaced history records and a clean leak audit the verdict is enabled (proposal only)", async () => {
    const h = (i: number) => ({
      runnerVersion: RUNNER_VERSION,
      provider: "synthetic-reader",
      startedAt: new Date(Date.parse("2026-11-20T00:00:00Z") + i * 8 * 3600_000).toISOString(),
      endedAt: new Date(Date.parse("2026-11-20T00:05:00Z") + i * 8 * 3600_000).toISOString(),
      requests: { total: 70, ok: 70, failed: 0, blocked: 0 },
      pageListMs: [300, 400],
    });
    const { run } = setup(clone());
    const o = await run({ history: [h(0), h(1), h(2)], leak: { ranAt: "2026-11-23T00:00:00Z", target: "preview", matches: 0, providerOn: true } });
    expect(o.verdict).toBe("enabled");
    expect(renderReport(o)).toContain("the runner never sets it");
    expect(process.env.PROVIDER_SYNTHETIC_READER).toBeUndefined();
  });

  it("terms not passing: nothing is sent and every network gate is not-run", async () => {
    const f = clone();
    f.review.forbidsAutomation = true;
    const { run, sent } = setup(f);
    const o = await run();
    expect(sent).toEqual([]);
    expect(o.stoppedAt).toBe("gate 1");
    expect(o.results[0]!.status).toBe("fail");
    expect(o.results[1]!.status).toBe("not-run");
    expect(o.record).toBeNull();
  });

  it("robots.txt disallowing a needed path stops the run after robots", async () => {
    const f = clone();
    f.robots.body = "User-agent: DawghwaBot\nDisallow: /read/\n";
    const { run, sent } = setup(f);
    const o = await run();
    expect(o.stoppedAt).toBe("gate 2");
    expect(o.results[1]!.status).toBe("fail");
    expect(sent.every((u) => u.endsWith("/robots.txt"))).toBe(true);
  });

  it("robots.txt 403 fails gate 4 and stops", async () => {
    const f = clone();
    f.robots = { status: 403, body: "no" };
    const { run, sent } = setup(f);
    const o = await run();
    expect(o.results[3]!.status).toBe("fail");
    expect(o.verdict).toBe("blocked");
    expect(sent).toHaveLength(1);
  });

  it("a 403 mid-run blocks the host, fails gate 4 and never retries it", async () => {
    const f = clone();
    let n = 0;
    const { run, sent } = setup(f, (u) => (u.pathname === "/search" && ++n === 3 ? new Response("blocked", { status: 403 }) : null));
    const o = await run();
    expect(o.results[3]!.status).toBe("fail");
    expect(o.verdict).toBe("blocked");
    const afterBlock = sent.slice(sent.findIndex((u, i) => u.includes("/search") && sent.slice(0, i + 1).filter((x) => x.includes("/search")).length === 3) + 1);
    expect(afterBlock.filter((u) => new URL(u).hostname === f.hosts[0])).toEqual([]);
  });

  it("an SVG page is a page failure (type read from bytes)", async () => {
    const f = clone();
    const firstPage = Object.values(f.pages)[0]![0]!;
    f.responses = { [firstPage]: { status: 200, headers: { "content-type": "image/png" }, body: "svg" } };
    const { run } = setup(f);
    const o = await run();
    const failures = o.outcomes!.flatMap((x) => x.pageFailures ?? []);
    expect(failures.join(" ")).toMatch(/svg|not an image|type/i);
  });

  it("a requested path that robots disallows fails gate 2 after the fact", async () => {
    const f = clone();
    f.robots.body = "User-agent: DawghwaBot\nDisallow: /search?q=Iron\n";
    f.paths = ["/series/*", "/read/*"];
    const { run } = setup(f);
    const o = await run();
    expect(o.results[1]!.status).toBe("fail");
    expect(o.results[1]!.evidence.join(" ")).toContain("/search");
  });
});
