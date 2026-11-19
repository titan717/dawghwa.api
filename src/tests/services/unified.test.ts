import { describe, expect, it, vi } from "vitest";
import { aggregateChapters, type UnifiedEvent } from "@/lib/services/unified";
import { getRegistry } from "@/lib/providers/registry";
import type { ProviderLink } from "@/lib/identity";
import type { Provider } from "@/lib/providers/provider";
import type { ScrapedChapter } from "@/types";
import { meta } from "../chapters/fixtures";

/**
 * Integration tests for the aggregation pipeline with real Provider objects
 * (circuit breaker, metrics, normalisation, cache) and stubbed adapters.
 * These are offline tests; live provider verification is in tests/live.
 */
const ids = ["mangadex", "dynasty-reader", "webtoon"] as const;
function providers(): Record<(typeof ids)[number], Provider> {
  const r = getRegistry();
  return Object.fromEntries(ids.map((id) => [id, r.get(id)!])) as Record<(typeof ids)[number], Provider>;
}
const link = (p: Provider, url: string): ProviderLink => ({
  sourceId: p.id,
  source: p.name,
  providerTitleId: url,
  url,
  title: "Aiura",
  evidence: { method: "exact-id", decision: "linked", confidence: 1, signals: [], reason: "test" },
});
const chapters = (base: string, labels: string[], extra: Partial<ScrapedChapter> = {}): ScrapedChapter[] =>
  labels.map((l, i) => ({ id: `${base}-${l}`, number: Number(l), chapterLabel: l, url: `${base}/c/${l}`, language: "en", sequence: i, ...extra }));

function setup(lists: Partial<Record<(typeof ids)[number], () => Promise<unknown>>>) {
  const ps = providers();
  const used = ids.filter((id) => lists[id]).map((id) => ps[id]);
  const spies = used.map((p) => vi.spyOn(p.scraper, "getChapterList").mockImplementation(lists[p.id as (typeof ids)[number]] as never));
  const urls: Record<string, string> = { mangadex: "https://mangadex.org/title/x", "dynasty-reader": "https://dynasty-scans.com/series/aiura", webtoon: "https://www.webtoons.com/en/drama/x/list?title_no=1" };
  const discover = vi.fn(async () => ({ links: used.map((p) => link(p, urls[p.id]!)), reports: [] }));
  return { providers: used, discover, spies };
}

describe("aggregateChapters", () => {
  it("merges chapters from several providers into one list", async () => {
    const s = setup({
      mangadex: async () => chapters("https://mangadex.org", ["1", "2", "3"]),
      "dynasty-reader": async () => chapters("https://dynasty-scans.com", ["1", "2", "2.5"]),
    });
    const r = await aggregateChapters(meta(), { providers: s.providers, discover: s.discover });
    expect(r.chapters.map((c) => c.number)).toEqual(["1", "2", "2.5", "3"]);
    expect(r.summary).toMatchObject({ linkedSources: 2, succeededSources: 2, mergedRows: 2, totalVariants: 6 });
    expect(r.chapters[0]!.variants.map((v) => v.sourceId)).toEqual(["dynasty-reader", "mangadex"]);
  });

  it("returns partial results when one provider fails", async () => {
    const s = setup({
      mangadex: async () => chapters("https://mangadex.org", ["1"]),
      "dynasty-reader": async () => {
        throw new TypeError("fetch failed");
      },
    });
    const r = await aggregateChapters(meta(), { providers: s.providers, discover: s.discover });
    expect(r.chapters).toHaveLength(1);
    expect(r.sources.find((x) => x.sourceId === "dynasty-reader")).toMatchObject({ status: "error" });
    expect(r.summary.failedSources).toBe(1);
  });

  it("times out a slow provider without blocking the others", async () => {
    const s = setup({
      mangadex: async () => chapters("https://mangadex.org", ["1"]),
      webtoon: () => new Promise(() => {}),
    });
    const t = Date.now();
    const r = await aggregateChapters(meta(), { providers: s.providers, discover: s.discover, providerTimeoutMs: 80 });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.sources.find((x) => x.sourceId === "webtoon")).toMatchObject({ status: "timeout", errorCode: "UPSTREAM_TIMEOUT" });
    expect(r.chapters).toHaveLength(1);
  });

  it("streams progressive events: first provider's chapters before the slow one finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({
      mangadex: async () => chapters("https://mangadex.org", ["1", "2"]),
      "dynasty-reader": async () => {
        await gate;
        return chapters("https://dynasty-scans.com", ["3"]);
      },
    });
    const events: UnifiedEvent[] = [];
    const p = aggregateChapters(meta(), {
      providers: s.providers,
      discover: s.discover,
      onEvent: (e) => {
        events.push(e);
        if (e.event === "chapters" && !e.complete) release();
      },
    });
    const r = await p;
    const chapterEvents = events.filter((e): e is Extract<UnifiedEvent, { event: "chapters" }> => e.event === "chapters");
    expect(chapterEvents[0]!.chapters).toHaveLength(2);
    expect(chapterEvents[0]!.complete).toBe(false);
    expect(chapterEvents.at(-1)!.chapters).toHaveLength(3);
    expect(events[0]!.event).toBe("identity");
    expect(events.at(-1)!.event).toBe("summary");
    expect(r.summary.firstResultMs).toBeDefined();
  });

  it("reports cancellation", async () => {
    const s = setup({ mangadex: () => new Promise(() => {}) });
    const ac = new AbortController();
    const p = aggregateChapters(meta(), { providers: s.providers, discover: s.discover, signal: ac.signal, onEvent: () => {} });
    setTimeout(() => ac.abort(), 20);
    const r = await p;
    expect(r.sources[0]).toMatchObject({ status: "cancelled" });
  });

  it("drops invalid provider rows instead of failing the title", async () => {
    const s = setup({
      mangadex: async () => [
        { id: "ok", number: 1, chapterLabel: "1", url: "https://mangadex.org/chapter/ok", language: "en" },
        { id: "nourl", number: 2 },
        { id: "nan", number: Number.NaN, url: "https://mangadex.org/chapter/nan" },
        null,
      ],
      "dynasty-reader": async () => "not a list",
    });
    const r = await aggregateChapters(meta(), { providers: s.providers, discover: s.discover });
    expect(r.chapters.map((c) => c.number)).toEqual(["1"]);
    expect(r.sources.find((x) => x.sourceId === "dynasty-reader")).toMatchObject({ status: "ok", chapterCount: 0 });
  });

  it("serves repeat requests from cache and refreshes on demand", async () => {
    const s = setup({ mangadex: async () => chapters("https://mangadex.org", ["1"]) });
    await aggregateChapters(meta(), { providers: s.providers, discover: s.discover });
    const second = await aggregateChapters(meta(), { providers: s.providers, discover: s.discover });
    expect(s.spies[0]).toHaveBeenCalledTimes(1);
    expect(second.sources[0]!.cache).toBe("hit");
    await aggregateChapters(meta(), { providers: s.providers, discover: s.discover, refresh: true });
    expect(s.spies[0]).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent identical requests", async () => {
    const s = setup({ mangadex: async () => chapters("https://mangadex.org", ["1"]) });
    const [a, b] = await Promise.all([
      aggregateChapters(meta(), { providers: s.providers, discover: s.discover }),
      aggregateChapters(meta(), { providers: s.providers, discover: s.discover }),
    ]);
    expect(a).toBe(b);
    expect(s.discover).toHaveBeenCalledTimes(1);
  });

  it("handles large paginated provider lists", async () => {
    const labels = Array.from({ length: 1500 }, (_, i) => String(i + 1));
    const s = setup({ webtoon: async () => chapters("https://www.webtoons.com", labels) });
    const r = await aggregateChapters(meta(), { providers: s.providers, discover: s.discover });
    expect(r.chapters).toHaveLength(1500);
    expect(r.chapters.at(-1)!.number).toBe("1500");
  });
});
