/**
 * Contract any ProviderAdapter must meet before the gate runner can judge it.
 * Runs against the recorded fixture adapter and the bridged BaseScraper adapter.
 */
import { describe, expect, it } from "vitest";
import { resetConfig } from "@/lib/core/config";
import { adapterFromProvider, withPoliteFetcher } from "@/lib/gate/bridge";
import { fixtureAdapter, fixtureInner, type FixtureProvider } from "@/lib/gate/fixture";
import { GATE_USER_AGENT, PoliteFetcher, type FetchImpl } from "@/lib/gate/polite";
import type { ProviderAdapter } from "@/lib/gate/types";
import raw from "../fixtures/gate/synthetic-provider.json";
import { syntheticJson, syntheticProvider } from "./support";

const f = raw as unknown as FixtureProvider;

function fetcher() {
  let t = 0;
  const fx = fixtureInner(f);
  const inner: FetchImpl = async (i, init) => syntheticJson(new URL(i.toString())) ?? fx(i, init);
  return new PoliteFetcher({ inner, restrictToDeclared: true, extraHosts: [...f.hosts, ...f.imageHosts], now: () => t, sleep: async (ms) => void (t += ms) });
}

const subjects: [string, () => { adapter: ProviderAdapter; run: <T>(fn: () => Promise<T>) => Promise<T> }][] = [
  ["fixture adapter", () => ({ adapter: fixtureAdapter(f), run: (fn) => fn() })],
  [
    "bridged BaseScraper adapter",
    () => {
      process.env.UPSTREAM_USER_AGENT = GATE_USER_AGENT;
      resetConfig();
      const p = fetcher();
      return { adapter: adapterFromProvider(syntheticProvider(), { offlineAllowed: false, paths: f.paths }), run: (fn) => withPoliteFetcher(p, fn) };
    },
  ],
];

describe.each(subjects)("adapter contract: %s", (_name, make) => {
  it("declares id, flag and hosts in the expected format", () => {
    const { adapter } = make();
    expect(adapter.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(adapter.flag).toMatch(/^PROVIDER_[A-Z0-9_]+$/);
    expect(adapter.hosts.length).toBeGreaterThan(0);
    for (const h of [...adapter.hosts, ...adapter.imageHosts]) expect(h).toMatch(/^[a-z0-9.-]+$/);
    expect(typeof adapter.offlineAllowed).toBe("boolean");
  });

  it("search returns refs and titles as strings; unknown query returns []", async () => {
    const { adapter, run } = make();
    const r = await run(() => adapter.search("Lantern Harbor"));
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) {
      expect(typeof x.ref).toBe("string");
      expect(typeof x.title).toBe("string");
    }
    expect(await run(() => adapter.search("no such synthetic title"))).toEqual([]);
  });

  it("chapters carry numeric n, string refs and a language or null", async () => {
    const { adapter, run } = make();
    const [hit] = await run(() => adapter.search("Lantern Harbor"));
    const ch = await run(() => adapter.chapters(hit!.ref));
    expect(ch.length).toBeGreaterThan(0);
    for (const c of ch) {
      expect(Number.isFinite(c.n)).toBe(true);
      expect(typeof c.ref).toBe("string");
      expect(c.lang === null || typeof c.lang === "string").toBe(true);
    }
  });

  it("pages are https URLs on a declared image host that allowPage accepts", async () => {
    const { adapter, run } = make();
    const [hit] = await run(() => adapter.search("Lantern Harbor"));
    const [c] = await run(() => adapter.chapters(hit!.ref));
    const pages = await run(() => adapter.pages(c!.ref, c!.n));
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      const u = new URL(p);
      expect(u.protocol).toBe("https:");
      expect(adapter.imageHosts).toContain(u.hostname);
      expect(adapter.allowPage?.(p) ?? true).toBe(true);
    }
    expect(adapter.allowPage?.("https://elsewhere.example/p.png") ?? false).toBe(false);
  });
});
