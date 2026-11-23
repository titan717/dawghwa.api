/**
 * Gate runner orchestration. Order matters and is the safe one:
 *   1, 3, 9 from the terms review (no network). Gate 1 not passing stops the run.
 *   2 robots.txt for every adapter host. A block stops the run (gate 4 FAIL);
 *     a disallowed path stops it too (gate 2 FAIL).
 *   6 quality run, which also produces the evidence for 4 and 5.
 *   7 reliability from the history plus this run; 8 from SHIELD's leak audit.
 */

import { gateAccess, gateLeak, gateOffline, gatePoliteness, gateQuality, gateReliability, gateRights, gateRobots, gateTerms, verdict, type Verdict } from "./gates";
import type { PoliteFetcher } from "./polite";
import { runQuality } from "./quality";
import { fetchRobots, isAllowed, type RobotsFetch } from "./robots";
import { GATE_NAMES, type GateId, type GateResult, type LeakAuditResult, type ProviderAdapter, type QualityTitle, type RunRecord, type TermsReview, type TitleOutcome } from "./types";

export const RUNNER_VERSION = "1.0.0";

export interface GateRunInput {
  adapter: ProviderAdapter;
  fetcher: PoliteFetcher;
  review: TermsReview | null;
  titles: QualityTitle[];
  history: unknown[];
  leak: LeakAuditResult | null;
  minScore: number;
  projectedDailyRequests: number | null;
  now?: () => number;
}

export interface GateRunOutput {
  provider: string;
  flag: string;
  startedAt: string;
  endedAt: string;
  results: GateResult[];
  verdict: Verdict;
  offlineAllowed: boolean;
  robots: Record<string, RobotsFetch>;
  outcomes: TitleOutcome[] | null;
  /** Append to the history file for gate 7; null when no network run happened. */
  record: RunRecord | null;
  stoppedAt?: string;
}

const notRun = (gate: GateId, why: string): GateResult => ({ gate, name: GATE_NAMES[gate], status: "not-run", evidence: [why] });

export function recordFromLog(fetcher: PoliteFetcher, provider: string, startedAt: string, endedAt: string, outcomes: TitleOutcome[] | null): RunRecord {
  const sent = fetcher.sent();
  const ok = sent.filter((e) => e.outcome === "ok").length;
  const blocked = sent.filter((e) => e.outcome === "blocked").length;
  return {
    runnerVersion: RUNNER_VERSION,
    provider,
    startedAt,
    endedAt,
    requests: { total: sent.length, ok, failed: sent.length - ok - blocked, blocked },
    pageListMs: (outcomes ?? []).flatMap((o) => (o.pageList ? [o.pageList.ms] : [])),
  };
}

export async function runGates(input: GateRunInput): Promise<GateRunOutput> {
  const now = input.now ?? Date.now;
  const { adapter, fetcher, review } = input;
  const startedAt = new Date(now()).toISOString();
  fetcher.declareHosts([...adapter.hosts, ...adapter.imageHosts]);

  const g1 = gateTerms(review);
  const g3 = gateRights(review);
  const g9 = gateOffline(review);
  const robots: Record<string, RobotsFetch> = {};
  const out = (results: GateResult[], outcomes: TitleOutcome[] | null, record: RunRecord | null, stoppedAt?: string): GateRunOutput => {
    const sorted = [...results].sort((a, b) => a.gate - b.gate);
    return {
      provider: adapter.id,
      flag: adapter.flag,
      startedAt,
      endedAt: new Date(now()).toISOString(),
      results: sorted,
      verdict: verdict(sorted),
      offlineAllowed: g9.offlineAllowed,
      robots,
      outcomes,
      record,
      ...(stoppedAt ? { stoppedAt } : {}),
    };
  };

  if (g1.status !== "pass") {
    const why = "Not run: gate 1 (terms) did not pass, so no request was sent.";
    return out([g1, notRun(2, why), g3, notRun(4, why), notRun(5, why), notRun(6, why), notRun(7, why), notRun(8, why), g9.result], null, null, "gate 1");
  }

  // Gate 2 for every host the adapter calls.
  const g2parts: GateResult[] = [];
  for (const host of adapter.hosts) {
    const rf = await fetchRobots(fetcher, `https://${host}`);
    robots[host] = rf;
    const g = gateRobots(rf, adapter.paths);
    g2parts.push({ ...g, evidence: g.evidence.map((e) => `${host}: ${e}`) });
    if (rf.kind === "blocked") break;
  }
  const g2: GateResult = {
    gate: 2,
    name: GATE_NAMES[2],
    status: g2parts.length && g2parts.every((g) => g.status === "pass") ? "pass" : g2parts.some((g) => g.status === "fail") ? "fail" : "needs-evidence",
    evidence: g2parts.flatMap((g) => g.evidence),
  };
  const access = () =>
    gateAccess({
      log: fetcher.log,
      blocked: [...fetcher.blocked.values()].map((b) => ({ host: b.host, reason: b.reason })),
      refused: fetcher.refused,
      strippedHeaders: [...fetcher.strippedHeaders],
    });

  if (g2.status !== "pass" || fetcher.blocked.size) {
    const why = "Not run: stopped at robots.txt.";
    const endedAt = new Date(now()).toISOString();
    return out(
      [g1, g2, g3, access(), gatePoliteness(fetcher.log, input.projectedDailyRequests), notRun(6, why), notRun(7, why), notRun(8, why), g9.result],
      null,
      recordFromLog(fetcher, adapter.id, startedAt, endedAt, null),
      "gate 2",
    );
  }

  const q = await runQuality(adapter, fetcher, input.titles, { minScore: input.minScore, exclusions: review?.licensedExclusions, now });
  const endedAt = new Date(now()).toISOString();
  const record = recordFromLog(fetcher, adapter.id, startedAt, endedAt, q.outcomes);
  // Gate 2 again, on the paths the adapter really requested.
  const seen = new Set<string>();
  const disallowed: string[] = [];
  for (const e of fetcher.sent()) {
    const rf = robots[e.host];
    const key = `${e.host}${e.path}`;
    if (!rf || rf.kind !== "parsed" || seen.has(key)) continue;
    seen.add(key);
    if (!isAllowed(rf.robots, e.path).allowed) disallowed.push(key);
  }
  if (disallowed.length) {
    g2.status = "fail";
    g2.evidence.push(`Requested paths disallowed by robots.txt: ${disallowed.slice(0, 5).join(", ")}${disallowed.length > 5 ? ` (+${disallowed.length - 5})` : ""}.`);
  } else if (seen.size) {
    g2.evidence.push(`All ${seen.size} distinct requested paths on robots-checked hosts are allowed.`);
  }
  const g4 = access();
  const g5 = gatePoliteness(fetcher.log, input.projectedDailyRequests);
  const g6 = q.stopped ? { ...gateQuality(input.titles, q.outcomes, input.minScore, review?.siteLanguage), status: "fail" as const } : gateQuality(input.titles, q.outcomes, input.minScore, review?.siteLanguage);
  const g7 = gateReliability([...input.history, record], adapter.id);
  const g8 = gateLeak(input.leak);
  return out([g1, g2, g3, g4, g5, g6, g7, g8, g9.result], q.outcomes, record, q.stopped ? `blocked by ${q.stopped.host}` : undefined);
}
