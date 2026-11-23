import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "@/lib/core/config";
import { getGuardedFetchImpl, setGuardedFetchImpl } from "@/lib/core/net-guard";
import { SourceBreakers } from "@/lib/v2/breaker";
import { adapterFromProvider, withPoliteFetcher } from "@/lib/gate/bridge";
import { fixtureInner, type FixtureProvider } from "@/lib/gate/fixture";
import { GATE_USER_AGENT, PoliteFetcher, type FetchImpl } from "@/lib/gate/polite";
import { runGates } from "@/lib/gate/run";
import fixture from "../fixtures/gate/synthetic-provider.json";
import { BASE, IMG, syntheticJson, syntheticProvider } from "./support";

const f = fixture as unknown as FixtureProvider;

function polite(handler?: (u: URL, n: number) => Response | null) {
  let t = Date.parse("2026-11-23T00:00:00Z");
  const seen: { url: string; ua: string | null; referer: string | null }[] = [];
  const base = fixtureInner(f);
  const inner: FetchImpl = async (input, init) => {
    const u = new URL(input.toString());
    const h = new Headers(init.headers);
    seen.push({ url: u.toString(), ua: h.get("user-agent"), referer: h.get("referer") });
    return handler?.(u, seen.length) ?? syntheticJson(u) ?? base(input, init);
  };
  const fetcher = new PoliteFetcher({ inner, restrictToDeclared: true, extraHosts: [...f.hosts, ...f.imageHosts], now: () => t, sleep: async (ms) => void (t += ms) });
  return { fetcher, seen };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bridge: existing Provider through the polite fetcher", () => {
  it("routes every adapter request through the fetcher with the bot UA, then restores the previous impl", async () => {
    const before = getGuardedFetchImpl();
    const { fetcher, seen } = polite();
    const adapter = adapterFromProvider(syntheticProvider(), { offlineAllowed: false, paths: ["/search", "/series/*", "/read/*"] });
    expect(adapter.flag).toBe("PROVIDER_SYNTHETIC_READER");
    expect(adapter.imageHosts).toEqual([IMG]);
    const results = await withPoliteFetcher(fetcher, () => adapter.search("Lantern Harbor"));
    expect(results[0]!.title).toBe("Lantern Harbor");
    expect(getGuardedFetchImpl()).toBe(before);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ua).toBe(GATE_USER_AGENT);
  });

  it("restores the previous impl even when the run throws", async () => {
    const before = getGuardedFetchImpl();
    const { fetcher } = polite();
    await expect(withPoliteFetcher(fetcher, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(getGuardedFetchImpl()).toBe(before);
  });

  it("an adapter that sends a Referer is stripped and fails gate 4", async () => {
    const { fetcher, seen } = polite();
    const adapter = adapterFromProvider(syntheticProvider({ referer: true }), { offlineAllowed: false, paths: ["/search"] });
    await withPoliteFetcher(fetcher, () => adapter.search("Lantern Harbor"));
    expect(seen[0]!.referer).toBeNull();
    expect(fetcher.strippedHeaders.has("referer")).toBe(true);
  });

  it("SSRF: adapter requests to 127.0.0.1 and 169.254.169.254 are refused before sending", async () => {
    let t = 0;
    const sent: string[] = [];
    const fetcher = new PoliteFetcher({
      inner: async (input) => {
        sent.push(input.toString());
        return new Response("[]");
      },
      extraHosts: ["127.0.0.1", "169.254.169.254"], // even if declared, the guard refuses
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    // Core http calls guardedFetch -> fetchImpl per hop; call the hop path as it would.
    await expect(withPoliteFetcher(fetcher, () => fetcher.fetchHop("http://127.0.0.1/search", {}))).rejects.toMatchObject({ name: "RefusedError" });
    await expect(withPoliteFetcher(fetcher, () => fetcher.fetchHop("http://169.254.169.254/latest/meta-data/", {}))).rejects.toMatchObject({ name: "RefusedError" });
    expect(sent).toEqual([]);
  });

  it("SSRF through a real adapter call: core http plus the fetcher refuse a private target", async () => {
    const { fetcher, seen } = polite();
    const provider = syntheticProvider();
    const adapter = adapterFromProvider(provider, { offlineAllowed: false });
    await expect(withPoliteFetcher(fetcher, () => adapter.chapters("http://169.254.169.254/latest/meta-data/"))).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it("an adapter whose HTTP layer sends a browser user agent fails gate 4", async () => {
    process.env.UPSTREAM_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0) Chrome/124";
    resetConfig();
    const { fetcher, seen } = polite();
    const adapter = adapterFromProvider(syntheticProvider(), { offlineAllowed: false, paths: ["/search"] });
    await withPoliteFetcher(fetcher, () => adapter.search("Lantern Harbor"));
    expect(seen[0]!.ua).toBe(GATE_USER_AGENT);
    expect(fetcher.strippedHeaders.has("user-agent")).toBe(true);
    delete process.env.UPSTREAM_USER_AGENT;
  });

  it("full gate run over the bridged provider reports all gates and never sets a flag", async () => {
    // As the CLI does before config is first read.
    process.env.UPSTREAM_USER_AGENT = GATE_USER_AGENT;
    resetConfig();
    const { fetcher } = polite();
    const provider = syntheticProvider();
    const adapter = adapterFromProvider(provider, { offlineAllowed: false, paths: ["/search", "/series/*", "/read/*"] });
    const before = { ...process.env };
    const out = await withPoliteFetcher(fetcher, () =>
      runGates({ adapter, fetcher, review: f.review, titles: f.titles, history: [], leak: null, minScore: 0.82, projectedDailyRequests: 600 }),
    );
    expect(out.results.map((r) => r.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "needs-evidence", "needs-evidence", "pass"]);
    expect(out.verdict).toBe("disabled");
    expect(process.env).toEqual(before);
    expect(process.env.PROVIDER_SYNTHETIC_READER).toBeUndefined();
    delete process.env.UPSTREAM_USER_AGENT;
  });
});

describe("breaker trip and recovery through the adapter path", () => {
  it("trips after the threshold, fails fast without sending, then recovers on a good half-open trial", async () => {
    process.env.BREAKER_FAILURE_THRESHOLD = "3";
    process.env.BREAKER_COOLDOWN_MS = "60000";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-23T00:00:00Z"));
    let down = true;
    const { fetcher, seen } = polite((u) => (down && u.pathname === "/search" ? new Response("{}", { status: 503 }) : null));
    const provider = syntheticProvider();
    const adapter = adapterFromProvider(provider, { offlineAllowed: false });
    await withPoliteFetcher(fetcher, async () => {
      for (let i = 0; i < 3; i++) await expect(adapter.search("Lantern Harbor")).rejects.toBeTruthy();
      expect(provider.circuit().state).toBe("open");
      const sentBefore = seen.length;
      await expect(adapter.search("Lantern Harbor")).rejects.toMatchObject({ code: "SOURCE_CIRCUIT_OPEN" });
      expect(seen.length).toBe(sentBefore); // fail fast: nothing sent while open
      down = false;
      vi.setSystemTime(Date.now() + 60_000);
      expect(provider.circuit().state).toBe("half_open");
      const r = await adapter.search("Lantern Harbor");
      expect(r.length).toBeGreaterThan(0);
      expect(provider.circuit().state).toBe("closed");
    });
    delete process.env.BREAKER_FAILURE_THRESHOLD;
    delete process.env.BREAKER_COOLDOWN_MS;
  });

  it("a failed half-open trial re-opens with a doubled cooldown", async () => {
    process.env.BREAKER_FAILURE_THRESHOLD = "2";
    process.env.BREAKER_COOLDOWN_MS = "10000";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-23T00:00:00Z"));
    const { fetcher } = polite((u) => (u.pathname === "/search" ? new Response("{}", { status: 500 }) : null));
    const provider = syntheticProvider();
    const adapter = adapterFromProvider(provider, { offlineAllowed: false });
    await withPoliteFetcher(fetcher, async () => {
      for (let i = 0; i < 2; i++) await expect(adapter.search("x")).rejects.toBeTruthy();
      vi.setSystemTime(Date.now() + 10_000);
      await expect(adapter.search("x")).rejects.toBeTruthy();
      const snap = provider.circuit();
      expect(snap.state).toBe("open");
      expect(snap.retryAt! - snap.openedAt!).toBe(20_000);
    });
    delete process.env.BREAKER_FAILURE_THRESHOLD;
    delete process.env.BREAKER_COOLDOWN_MS;
  });

  it("a 403 latches the host: the breaker counts it and the fetcher never sends again", async () => {
    process.env.BREAKER_FAILURE_THRESHOLD = "2";
    const { fetcher, seen } = polite((u) => (u.pathname === "/search" ? new Response("no", { status: 403 }) : null));
    const provider = syntheticProvider();
    const adapter = adapterFromProvider(provider, { offlineAllowed: false });
    await withPoliteFetcher(fetcher, async () => {
      await expect(adapter.search("a")).rejects.toBeTruthy();
      await expect(adapter.search("b")).rejects.toBeTruthy();
    });
    expect(seen).toHaveLength(1);
    expect(fetcher.blocked.has(new URL(BASE).hostname)).toBe(true);
    expect(provider.circuit().state).toBe("open");
    delete process.env.BREAKER_FAILURE_THRESHOLD;
  });

  it("v2 SourceBreakers: trip, skip in ordering, half-open last, recover", () => {
    let now = 0;
    const b = new SourceBreakers(2, 1000, () => now);
    b.failure("s1");
    b.failure("s1");
    expect(b.state("s1")).toBe("open");
    expect(b.tryAcquire("s1")).toBe(false);
    expect(b.order(["s1", "s2"], (x) => x)).toEqual(["s2"]);
    now = 1000;
    expect(b.order(["s1", "s2"], (x) => x)).toEqual(["s2", "s1"]);
    expect(b.tryAcquire("s1")).toBe(true);
    expect(b.tryAcquire("s1")).toBe(false); // single trial slot
    b.success("s1");
    expect(b.state("s1")).toBe("closed");
  });
});

// keep the hook untouched for other files
afterEach(() => expect(typeof setGuardedFetchImpl).toBe("function"));
