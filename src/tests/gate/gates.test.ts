import { describe, expect, it } from "vitest";
import {
  gateAccess,
  gateLeak,
  gateOffline,
  gatePoliteness,
  gateQuality,
  gateReliability,
  gateRights,
  gateRobots,
  gateTerms,
  judgeTitle,
  median,
  parseRunRecord,
  verdict,
} from "@/lib/gate/gates";
import { parseRobots } from "@/lib/gate/robots";
import type { RequestLogEntry } from "@/lib/gate/polite";
import { GATE_NAMES, type GateId, type GateResult, type QualityTitle, type RunRecord, type TermsReview, type TitleOutcome } from "@/lib/gate/types";
import fixture from "../fixtures/gate/synthetic-provider.json";

const review = (over: Partial<TermsReview> = {}): TermsReview => ({ ...(fixture.review as TermsReview), ...over });

describe("gate 1 terms", () => {
  it("passes only when terms exist and do not forbid automation", () => {
    expect(gateTerms(review()).status).toBe("pass");
    expect(gateTerms(review({ forbidsAutomation: true })).status).toBe("fail");
    expect(gateTerms(review({ forbidsAutomation: null })).status).toBe("fail");
    expect(gateTerms(review({ termsUrl: null })).status).toBe("fail");
    expect(gateTerms(review({ termsSummary: " " })).status).toBe("needs-evidence");
    expect(gateTerms(null).status).toBe("needs-evidence");
  });
});

describe("gate 2 robots", () => {
  const parsed = { kind: "parsed" as const, status: 200, robots: parseRobots("User-agent: *\nDisallow: /api/\n") };
  it("passes when every path is allowed", () => expect(gateRobots(parsed, ["/series/*", "/read/*"]).status).toBe("pass"));
  it("fails on a disallowed path", () => expect(gateRobots(parsed, ["/api/v1/search"]).status).toBe("fail"));
  it("follows the fetch rules", () => {
    expect(gateRobots({ kind: "allow-all", status: 404 }, ["/x"]).status).toBe("pass");
    expect(gateRobots({ kind: "disallow-all", status: 503, reason: "HTTP 503" }, ["/x"]).status).toBe("fail");
    expect(gateRobots({ kind: "blocked", status: 403, reason: "HTTP 403" }, ["/x"]).status).toBe("fail");
    expect(gateRobots(null, ["/x"]).status).toBe("not-run");
  });
});

describe("gate 3 rights", () => {
  it("needs a working rights contact", () => {
    expect(gateRights(review()).status).toBe("pass");
    expect(gateRights(review({ rightsContactUrl: null })).status).toBe("fail");
    expect(gateRights(review({ rightsContactWorks: null })).status).toBe("fail");
  });
});

const entry = (at: number, over: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  at: new Date(at).toISOString(),
  host: "s.example",
  path: "/",
  status: 200,
  ms: 100,
  attempt: 1,
  outcome: "ok",
  ...over,
});

describe("gate 4 access", () => {
  const log = [entry(0), entry(1000)];
  it("passes on clean access", () => expect(gateAccess({ log, blocked: [], refused: [], strippedHeaders: [] }).status).toBe("pass"));
  it("fails on any block", () => expect(gateAccess({ log, blocked: [{ host: "s.example", reason: "HTTP 403" }], refused: [], strippedHeaders: [] }).status).toBe("fail"));
  it("fails on a refused destination", () => expect(gateAccess({ log, blocked: [], refused: [{ url: "http://127.0.0.1/", reason: "ssrf-guard" }], strippedHeaders: [] }).status).toBe("fail"));
  it("fails when the adapter tried to spoof headers", () => expect(gateAccess({ log, blocked: [], refused: [], strippedHeaders: ["referer"] }).status).toBe("fail"));
  it("is not run without requests", () => expect(gateAccess({ log: [], blocked: [], refused: [], strippedHeaders: [] }).status).toBe("not-run"));
});

describe("gate 5 politeness", () => {
  it("passes at 1 req/s with a modest volume", () => expect(gatePoliteness([entry(0), entry(1000), entry(2500)], 800).status).toBe("pass"));
  it("fails faster than 1 req/s", () => expect(gatePoliteness([entry(0), entry(400)], 800).status).toBe("fail"));
  it("fails on a large projected volume", () => expect(gatePoliteness([entry(0)], 50_000).status).toBe("fail"));
  it("needs the projection", () => expect(gatePoliteness([entry(0)], null).status).toBe("needs-evidence"));
});

const titles = fixture.titles as QualityTitle[];
const good = (t: QualityTitle): TitleOutcome => ({
  title: t.name,
  kind: t.kind,
  matchScore: 1,
  strongRefs: 1,
  chapters: t.referenceChapters,
  languages: ["en"],
  pageList: { pages: 3, ms: 300 },
  pagesLoaded: 3,
  pageFailures: [],
});

describe("gate 6 quality", () => {
  const t = titles[0]!;
  it("judges each title", () => {
    expect(judgeTitle(t, good(t), 0.82).ok).toBe(true);
    expect(judgeTitle(t, { ...good(t), matchScore: 0.7 }, 0.82).reasons[0]).toMatch(/match/);
    expect(judgeTitle(t, { ...good(t), strongRefs: 2 }, 0.82).ok).toBe(false);
    expect(judgeTitle(t, { ...good(t), chapters: Math.ceil(t.referenceChapters * 1.06) }, 0.82).ok).toBe(false);
    expect(judgeTitle(t, { ...good(t), chapters: Math.floor(t.referenceChapters * 0.96) + 1 }, 0.82).ok).toBe(true);
    expect(judgeTitle(t, { ...good(t), languages: ["pt-br"] }, 0.82).ok).toBe(false);
    expect(judgeTitle(t, { ...good(t), languages: [] }, 0.82).ok).toBe(false);
    expect(judgeTitle(t, { ...good(t), languages: [] }, 0.82, "en").ok).toBe(true);
    expect(judgeTitle(t, { ...good(t), pagesLoaded: 2 }, 0.82).ok).toBe(false);
  });

  it("needs 12 titles and all three kinds", () => {
    expect(gateQuality(titles, titles.map(good), 0.82).status).toBe("pass");
    expect(gateQuality(titles.slice(0, 11), titles.slice(0, 11).map(good), 0.82).status).toBe("fail");
    const noManhua = titles.filter((x) => x.kind !== "manhua");
    expect(gateQuality(noManhua, noManhua.map(good), 0.82).evidence.join(" ")).toMatch(/No manhua/);
  });

  it("excluded titles do not count towards the 12", () => {
    const outcomes = titles.map((x, i) => (i === 0 ? { ...good(x), excluded: true } : good(x)));
    expect(gateQuality(titles, outcomes, 0.82).status).toBe("fail");
  });

  it("one failing title fails the gate", () => {
    const outcomes = titles.map((x, i) => (i === 3 ? { ...good(x), pagesLoaded: 0 } : good(x)));
    expect(gateQuality(titles, outcomes, 0.82).status).toBe("fail");
  });

  it("is not run without outcomes", () => expect(gateQuality(titles, null, 0.82).status).toBe("not-run"));
});

const rec = (startedAt: string, over: Partial<RunRecord> = {}): RunRecord => ({
  runnerVersion: "1.0.0",
  provider: "synthetic-reader",
  startedAt,
  endedAt: new Date(Date.parse(startedAt) + 600_000).toISOString(),
  requests: { total: 100, ok: 98, failed: 2, blocked: 0 },
  pageListMs: [400, 600, 900],
  ...over,
});

describe("gate 7 reliability", () => {
  it("passes with 3 runs at least 6 h apart", () => {
    const h = [rec("2026-11-23T00:00:00Z"), rec("2026-11-23T06:00:00Z"), rec("2026-11-23T12:30:00Z")];
    expect(gateReliability(h, "synthetic-reader").status).toBe("pass");
  });

  it("runs closer than 6 h do not count", () => {
    const h = [rec("2026-11-23T00:00:00Z"), rec("2026-11-23T03:00:00Z"), rec("2026-11-23T06:00:00Z")];
    expect(gateReliability(h, "synthetic-reader").status).toBe("needs-evidence");
  });

  it("fails below 95% success, on a slow median or on a block", () => {
    const base = [rec("2026-11-23T00:00:00Z"), rec("2026-11-23T06:00:00Z")];
    expect(gateReliability([...base, rec("2026-11-23T12:00:00Z", { requests: { total: 100, ok: 90, failed: 10, blocked: 0 } })], "synthetic-reader").status).toBe("fail");
    expect(gateReliability([...base, rec("2026-11-23T12:00:00Z", { pageListMs: [2500, 2100, 100] })], "synthetic-reader").status).toBe("fail");
    expect(gateReliability([...base, rec("2026-11-23T12:00:00Z", { requests: { total: 100, ok: 99, failed: 0, blocked: 1 } })], "synthetic-reader").status).toBe("fail");
  });

  it("refuses malformed records instead of counting them", () => {
    expect(parseRunRecord({})).toBeNull();
    expect(parseRunRecord({ ...rec("2026-11-23T00:00:00Z"), startedAt: "yesterday" })).toBeNull();
    expect(parseRunRecord({ ...rec("2026-11-23T00:00:00Z"), runnerVersion: "" })).toBeNull();
    expect(parseRunRecord({ ...rec("2026-11-23T00:00:00Z"), requests: { total: 5, ok: 5, failed: 1, blocked: 0 } })).toBeNull();
    expect(parseRunRecord({ ...rec("2026-11-23T00:00:00Z"), endedAt: "2026-11-22T00:00:00Z" })).toBeNull();
    const h = [rec("2026-11-23T00:00:00Z"), { junk: true }, rec("2026-11-23T06:00:00Z"), "x", rec("2026-11-23T12:00:00Z")];
    const g = gateReliability(h, "synthetic-reader");
    expect(g.status).toBe("pass");
    expect(g.evidence.filter((e) => e.includes("refused"))).toHaveLength(2);
  });

  it("ignores other providers' runs", () => {
    const h = [rec("2026-11-23T00:00:00Z"), rec("2026-11-23T06:00:00Z", { provider: "other" }), rec("2026-11-23T12:00:00Z")];
    expect(gateReliability(h, "synthetic-reader").status).toBe("needs-evidence");
  });

  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("gate 8 leak", () => {
  it("needs a run with the provider on and 0 matches", () => {
    expect(gateLeak(null).status).toBe("needs-evidence");
    expect(gateLeak({ ranAt: "2026-11-23T00:00:00Z", target: "preview", matches: 0 }).status).toBe("needs-evidence");
    expect(gateLeak({ ranAt: "2026-11-23T00:00:00Z", target: "preview", matches: 0, providerOn: true }).status).toBe("pass");
    expect(gateLeak({ ranAt: "2026-11-23T00:00:00Z", target: "preview", matches: 2, providerOn: true }).status).toBe("fail");
  });
});

describe("gate 9 offline", () => {
  it("only an explicit allowance is true", () => {
    expect(gateOffline(review({ offline: "allowed" })).offlineAllowed).toBe(true);
    expect(gateOffline(review({ offline: "forbidden" })).offlineAllowed).toBe(false);
    expect(gateOffline(review({ offline: "unclear" })).offlineAllowed).toBe(false);
    expect(gateOffline(null)).toMatchObject({ offlineAllowed: false, result: { status: "needs-evidence" } });
  });
});

describe("verdict", () => {
  const all = (status: GateResult["status"], except: Partial<Record<GateId, GateResult["status"]>> = {}) =>
    ([1, 2, 3, 4, 5, 6, 7, 8, 9] as GateId[]).map((gate) => ({ gate, name: GATE_NAMES[gate], status: except[gate] ?? status, evidence: [] }));
  it("enabled only when all 9 pass", () => {
    expect(verdict(all("pass"))).toBe("enabled");
    expect(verdict(all("pass", { 8: "needs-evidence" }))).toBe("disabled");
    expect(verdict(all("pass", { 1: "fail" }))).toBe("disabled");
    expect(verdict(all("pass", { 4: "fail" }))).toBe("blocked");
    expect(verdict(all("pass").slice(0, 8))).toBe("disabled");
  });
});
