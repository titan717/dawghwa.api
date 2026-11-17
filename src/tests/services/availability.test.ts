import { describe, expect, it } from "vitest";
import { getRegistry } from "@/lib/providers/registry";
import {
  editionPenalty,
  findAvailability,
  rankAvailability,
  sourceState,
  type SourceAvailability,
} from "@/lib/services/availability";
import { jsonResponse, mockFetch } from "../helpers";
import { mdSearchHit } from "../metadata/fixtures";

const ID_MAIN = "32d76d19-8a05-4db0-9fc2-e0b0648fe9d0";
const ID_SPIN = "11111111-1111-4111-8111-111111111111";
const md = () => getRegistry().get("mangadex")!;

function mdSearch(byTitle: Record<string, unknown[]>) {
  const queries: string[] = [];
  const fetch = mockFetch((url) => {
    const u = new URL(url);
    if (u.hostname === "api.mangadex.org" && u.pathname === "/manga") {
      const title = u.searchParams.get("title") ?? "";
      queries.push(title);
      return jsonResponse({ result: "ok", total: 1, data: byTitle[title] ?? [] });
    }
    throw new Error(`unexpected ${url}`);
  });
  return { fetch, queries };
}

describe("findAvailability", () => {
  it("reports the best match with confidence and keeps spin-offs as candidates", async () => {
    mdSearch({
      "Solo Leveling": [mdSearchHit(ID_SPIN, "Solo Leveling: Ragnarok", "40"), mdSearchHit(ID_MAIN, "Solo Leveling", "200")],
    });
    const lines: SourceAvailability[] = [];
    const summary = await findAvailability({
      titles: ["Solo Leveling", "Na Honjaman Level Up"],
      queries: ["Solo Leveling", "Na Honjaman Level Up"],
      providers: [md()],
      onSource: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      sourceId: "mangadex",
      available: true,
      state: "working",
      best: { id: ID_MAIN, confidence: "exact", latestChapter: 200, url: `https://mangadex.org/title/${ID_MAIN}` },
      queries: ["Solo Leveling"],
    });
    expect(lines[0].candidates.map((c) => c.id)).toEqual([ID_SPIN]);
    expect(lines[0].candidates[0].confidence).toBe("possible");
    expect(summary).toMatchObject({ done: true, availableSources: 1, failedSources: 0, ranking: ["mangadex"] });
  });

  it("retries sources with no match using an alternative title", async () => {
    const { queries } = mdSearch({
      "Solo Leveling": [mdSearchHit(ID_SPIN, "Solo Leveling: Ragnarok")],
      "Na Honjaman Level Up": [mdSearchHit(ID_MAIN, "Na Honjaman Level Up")],
    });
    const lines: SourceAvailability[] = [];
    const summary = await findAvailability({
      titles: ["Solo Leveling", "Na Honjaman Level Up"],
      queries: ["Solo Leveling", "Na Honjaman Level Up"],
      providers: [md()],
      onSource: (l) => lines.push(l),
    });
    expect(queries).toEqual(["Solo Leveling", "Na Honjaman Level Up"]);
    expect(lines[0]).toMatchObject({ available: true, best: { id: ID_MAIN, matchedAgainst: "Na Honjaman Level Up" } });
    expect(lines[0].queries).toEqual(["Solo Leveling", "Na Honjaman Level Up"]);
    expect(lines[0].candidates.map((c) => c.id)).toContain(ID_SPIN);
    expect(summary.availableSources).toBe(1);
  });

  it("reports no match honestly instead of guessing", async () => {
    mdSearch({ "Solo Leveling": [mdSearchHit(ID_SPIN, "Something Else Entirely")] });
    const lines: SourceAvailability[] = [];
    const summary = await findAvailability({
      titles: ["Solo Leveling"],
      queries: ["Solo Leveling"],
      providers: [md()],
      onSource: (l) => lines.push(l),
    });
    expect(lines[0]).toMatchObject({ available: false, candidates: [] });
    expect(lines[0].best).toBeUndefined();
    expect(summary).toMatchObject({ availableSources: 0, noMatchSources: 1, ranking: [] });
  });

  it("isolates a failing source and marks blocked ones", async () => {
    mockFetch(() => new Response("<html><title>Just a moment...</title><div id=\"challenge-platform\"></div></html>", { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } }));
    const lines: SourceAvailability[] = [];
    const summary = await findAvailability({
      titles: ["Solo Leveling"],
      queries: ["Solo Leveling"],
      providers: [md()],
      onSource: (l) => lines.push(l),
    });
    expect(lines[0].available).toBe(false);
    expect(lines[0].errorCode).toBeTruthy();
    expect(summary.failedSources).toBe(1);
  });

  it("skips sources whose last observation was an anti-bot block unless asked", async () => {
    const p = md();
    p.metrics.lastFailureAt = new Date().toISOString();
    p.metrics.lastErrorCode = "UPSTREAM_BLOCKED";
    expect(sourceState(p)).toBe("blocked");
    const skipped: unknown[] = [];
    const summary = await findAvailability({
      titles: ["Solo Leveling"],
      queries: ["Solo Leveling"],
      providers: [p],
      onSkipped: (s) => skipped.push(s),
    });
    expect(skipped).toHaveLength(1);
    expect(summary).toMatchObject({ skippedSources: 1, totalSources: 1, availableSources: 0 });

    // Old evidence expires.
    p.metrics.lastFailureAt = new Date(Date.now() - 31 * 60_000).toISOString();
    expect(sourceState(p)).toBe("unknown");
  });

  it("skips sources that failed recently (e.g. timeouts) and retries them on request", async () => {
    const p = md();
    p.metrics.lastFailureAt = new Date().toISOString();
    p.metrics.lastErrorCode = "UPSTREAM_TIMEOUT";
    expect(sourceState(p)).toBe("failing");
    const skipped: { reason: string }[] = [];
    await findAvailability({ titles: ["Solo Leveling"], queries: ["Solo Leveling"], providers: [p], onSkipped: (s) => skipped.push(s) });
    expect(skipped[0].reason).toMatch(/UPSTREAM_TIMEOUT/);

    mdSearch({ "Solo Leveling": [mdSearchHit(ID_MAIN, "Solo Leveling")] });
    const summary = await findAvailability({
      titles: ["Solo Leveling"],
      queries: ["Solo Leveling"],
      providers: [p],
      includeUnavailable: true,
    });
    expect(summary).toMatchObject({ skippedSources: 0, availableSources: 1 });
    expect(sourceState(p)).toBe("working");
  });

  it("requires a searchable title", async () => {
    await expect(findAvailability({ titles: ["!!!"], queries: [], providers: [md()] })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("ranking and editions", () => {
  const line = (sourceId: string, confidence: "exact" | "high", latestChapter: number): SourceAvailability => ({
    sourceId,
    source: sourceId,
    type: "aggregator",
    status: "active",
    state: "working",
    clientOnly: false,
    chapterPages: false,
    available: true,
    best: { id: sourceId, title: "x", url: "https://x", latestChapter, lastUpdated: "", score: 1, confidence },
    candidates: [],
    queries: [],
    durationMs: 1,
  });

  it("ranks exact matches first, then by latest chapter", () => {
    const providers = new Map(getRegistry().all().map((p) => [p.id, p]));
    const ranked = rankAvailability(
      [line("a", "high", 300), line("b", "exact", 150), line("c", "exact", 200), { ...line("d", "exact", 999), available: false }],
      providers,
    );
    expect(ranked).toEqual(["c", "b", "a"]);
  });

  it("demotes novel editions unless the series is a novel", () => {
    expect(editionPenalty("Solo Leveling (Novel)", ["Solo Leveling"], "manhwa")).toBe(0);
    expect(editionPenalty("Solo Leveling (Light Novel)", ["Solo Leveling"])).toBe(0);
    expect(editionPenalty("Solo Leveling (Novel)", ["Solo Leveling"], "novel")).toBe(1);
    expect(editionPenalty("Solo Leveling", ["Solo Leveling"], "manhwa")).toBe(1);
    expect(editionPenalty("Novel's Extra", ["Novel's Extra"], "manhwa")).toBe(1);
  });
});
