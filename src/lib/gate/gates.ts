/**
 * The 9 provider gates of MASTER_PROMPT section 11 as pure evaluators.
 * Each returns pass, fail, not-run (an earlier stop) or needs-evidence
 * (an input a human or another agent must supply). The verdict is
 * "enabled" only when all 9 pass; even then this code never turns a flag on.
 */

import type { RequestLogEntry } from "./polite";
import { isAllowed, type RobotsFetch } from "./robots";
import {
  GATE_NAMES,
  type GateId,
  type GateResult,
  type LeakAuditResult,
  type QualityTitle,
  type RunRecord,
  type TermsReview,
  type TitleKind,
  type TitleOutcome,
} from "./types";

export const MIN_QUALITY_TITLES = 12;
export const CHAPTER_TOLERANCE = 0.05;
export const RELIABILITY_MIN_RUNS = 3;
export const RELIABILITY_MIN_GAP_MS = 6 * 60 * 60 * 1000;
export const RELIABILITY_MIN_SUCCESS = 0.95;
export const RELIABILITY_MAX_MEDIAN_MS = 2_000;
/** Projected requests per day per host we still call modest (gate 5). */
export const MODEST_DAILY_REQUESTS = 5_000;

const r = (gate: GateId, status: GateResult["status"], evidence: string[]): GateResult => ({ gate, name: GATE_NAMES[gate], status, evidence });

const isIsoDate = (s: unknown) => typeof s === "string" && !Number.isNaN(Date.parse(s));

/** Gate 1. Missing or unclear terms are a FAIL (as in the cycle-1 records). */
export function gateTerms(review: TermsReview | null): GateResult {
  if (!review) return r(1, "needs-evidence", ["No terms review supplied (--terms)."]);
  const ev = [`Reviewed by ${review.reviewedBy} on ${review.reviewedAt}.`, `Terms: ${review.termsUrl ?? "none found"}.`];
  if (review.termsSummary) ev.push(`Summary: ${review.termsSummary}`);
  if (!review.termsUrl) return r(1, "fail", [...ev, "No terms page: FAIL."]);
  if (!isIsoDate(review.reviewedAt) || !review.termsSummary.trim()) return r(1, "needs-evidence", [...ev, "Review date or summary missing."]);
  if (review.forbidsAutomation === null) return r(1, "fail", [...ev, "Terms unclear about automated access: FAIL."]);
  if (review.forbidsAutomation) return r(1, "fail", [...ev, "Terms forbid automated access or this use."]);
  return r(1, "pass", ev);
}

/** Gate 2. Every path the adapter uses must be allowed for our token and for `*`. */
export function gateRobots(robots: RobotsFetch | null, paths: readonly string[]): GateResult {
  if (!robots) return r(2, "not-run", ["robots.txt not checked (stopped earlier)."]);
  if (robots.kind === "blocked") return r(2, "fail", [`robots.txt refused (${robots.reason}); see gate 4.`]);
  if (robots.kind === "disallow-all") return r(2, "fail", [`robots.txt unavailable (${robots.reason}): treated as disallow-all.`]);
  if (robots.kind === "allow-all") return r(2, "pass", [`robots.txt HTTP ${robots.status}: no rules, all paths allowed (RFC 9309).`]);
  if (!paths.length) return r(2, "needs-evidence", ["Adapter declares no paths."]);
  const decisions = paths.map((p) => isAllowed(robots.robots, p));
  const ev = decisions.map((d) => `\`${d.path}\`: ${d.allowed ? "allowed" : "DISALLOWED"} (ours ${d.ours ? "allow" : "disallow"}, * ${d.star ? "allow" : "disallow"})`);
  if (robots.robots.signals.length) ev.push(`Signals: ${robots.robots.signals.join("; ")}`);
  return r(2, decisions.every((d) => d.allowed) ? "pass" : "fail", ev);
}

/** Gate 3. A working rights contact; excluded titles are listed. */
export function gateRights(review: TermsReview | null): GateResult {
  if (!review) return r(3, "needs-evidence", ["No terms review supplied."]);
  const ev = [`Rights contact: ${review.rightsContactUrl ?? "none"}.`];
  if (review.licensedExclusions.length) ev.push(`Excluded titles: ${review.licensedExclusions.join(", ")}.`);
  if (!review.rightsContactUrl) return r(3, "fail", [...ev, "No DMCA or rights contact."]);
  if (review.rightsContactWorks !== true) return r(3, "fail", [...ev, "Rights contact not confirmed working."]);
  return r(3, "pass", ev);
}

export interface AccessEvidence {
  log: RequestLogEntry[];
  blocked: { host: string; reason: string }[];
  refused: { url: string; reason: string }[];
  strippedHeaders: string[];
}

/** Gate 4. Any block, refused destination or attempted header spoofing is a FAIL. */
export function gateAccess(a: AccessEvidence): GateResult {
  const sent = a.log.filter((e) => e.outcome !== "refused");
  if (!sent.length && !a.blocked.length) return r(4, "not-run", ["No request was sent."]);
  const ev = [`${sent.length} requests sent.`];
  let fail = false;
  for (const b of a.blocked) {
    ev.push(`Blocked by ${b.host}: ${b.reason}. Run stopped for that host.`);
    fail = true;
  }
  for (const x of a.refused) {
    ev.push(`Refused before sending: ${x.reason}.`);
    fail = true;
  }
  if (a.strippedHeaders.length) {
    ev.push(`Adapter tried to send ${a.strippedHeaders.join(", ")}; removed. An adapter that needs them would be spoofing.`);
    fail = true;
  }
  return r(4, fail ? "fail" : "pass", ev);
}

/** Gate 5. Measured spacing per host, retries, caching headers and projected volume. */
export function gatePoliteness(log: RequestLogEntry[], projectedDailyRequests: number | null): GateResult {
  const sent = log.filter((e) => e.outcome !== "refused");
  if (!sent.length) return r(5, "not-run", ["No request was sent."]);
  const byHost = new Map<string, number[]>();
  for (const e of sent) byHost.set(e.host, [...(byHost.get(e.host) ?? []), Date.parse(e.at)]);
  const ev: string[] = [];
  let fail = false;
  for (const [host, times] of byHost) {
    times.sort((a, b) => a - b);
    let min = Infinity;
    for (let i = 1; i < times.length; i++) min = Math.min(min, times[i]! - times[i - 1]!);
    ev.push(`${host}: ${times.length} requests, min interval ${Number.isFinite(min) ? `${min} ms` : "n/a"}.`);
    if (Number.isFinite(min) && min < 1_000) fail = true;
  }
  const retries = sent.filter((e) => e.outcome === "retry").length;
  const honoured = sent.filter((e) => e.retryAfterMs !== undefined).length;
  ev.push(`Retries after 429/5xx: ${retries}; requests sent after waiting Retry-After: ${honoured}.`);
  const cached = sent.filter((e) => e.cacheControl || e.etag || e.lastModified).length;
  ev.push(`Responses with caching headers: ${cached}/${sent.length}.`);
  if (projectedDailyRequests === null) {
    ev.push("Projected daily volume not supplied (--daily).");
    return r(5, fail ? "fail" : "needs-evidence", ev);
  }
  ev.push(`Projected daily requests per host: ${projectedDailyRequests} (limit ${MODEST_DAILY_REQUESTS}).`);
  if (projectedDailyRequests > MODEST_DAILY_REQUESTS) fail = true;
  return r(5, fail ? "fail" : "pass", ev);
}

export interface TitleVerdict {
  title: string;
  ok: boolean;
  reasons: string[];
}

export function judgeTitle(t: QualityTitle, o: TitleOutcome, minScore: number, siteLanguage?: string): TitleVerdict {
  const reasons: string[] = [];
  if (o.error) reasons.push(o.error);
  if (o.matchScore === null || o.matchScore < minScore) reasons.push(`match ${o.matchScore ?? "none"} < ${minScore}`);
  if (o.strongRefs > 1) reasons.push(`${o.strongRefs} different series match (duplicate or mismatch)`);
  if (o.chapters === null) reasons.push("no chapter list");
  else if (t.referenceChapters > 0 && Math.abs(o.chapters - t.referenceChapters) / t.referenceChapters > CHAPTER_TOLERANCE)
    reasons.push(`chapters ${o.chapters} vs reference ${t.referenceChapters} (> 5%)`);
  const langs = o.languages.length ? o.languages : siteLanguage ? [siteLanguage] : [];
  if (!langs.length) reasons.push("language not reported");
  else if (!langs.some((l) => l.toLowerCase() === t.language.toLowerCase())) reasons.push(`language ${langs.join("/")} != ${t.language}`);
  if (!o.pageList || o.pageList.pages === 0) reasons.push("no page list");
  else if ((o.pagesLoaded ?? 0) < o.pageList.pages) reasons.push(`pages loaded ${o.pagesLoaded ?? 0}/${o.pageList.pages}`);
  if (o.pageFailures?.length) reasons.push(`page failures: ${o.pageFailures.slice(0, 3).join("; ")}`);
  return { title: t.name, ok: reasons.length === 0, reasons };
}

/** Gate 6. At least 12 usable titles covering manga, manhwa and manhua; every one passes. */
export function gateQuality(titles: QualityTitle[], outcomes: TitleOutcome[] | null, minScore: number, siteLanguage?: string): GateResult {
  if (!outcomes) return r(6, "not-run", ["Quality run not performed (stopped earlier)."]);
  const ev: string[] = [];
  const used = titles.filter((t) => !outcomes.find((o) => o.title === t.name)?.excluded);
  const kinds = new Set<TitleKind>(used.map((t) => t.kind));
  let fail = false;
  if (used.length < MIN_QUALITY_TITLES) {
    ev.push(`Only ${used.length} titles usable (need ${MIN_QUALITY_TITLES}).`);
    fail = true;
  }
  for (const k of ["manga", "manhwa", "manhua"] as const)
    if (!kinds.has(k)) {
      ev.push(`No ${k} title in the list.`);
      fail = true;
    }
  let passed = 0;
  for (const t of used) {
    const o = outcomes.find((x) => x.title === t.name);
    if (!o) {
      ev.push(`${t.name}: not run.`);
      fail = true;
      continue;
    }
    const v = judgeTitle(t, o, minScore, siteLanguage);
    if (v.ok) passed++;
    else fail = true;
    ev.push(`${t.name} (${t.kind}): ${v.ok ? "pass" : `FAIL: ${v.reasons.join(", ")}`}`);
  }
  ev.unshift(`${passed}/${used.length} titles pass (threshold ${minScore}, chapters within ${CHAPTER_TOLERANCE * 100}%).`);
  return r(6, fail ? "fail" : "pass", ev);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Parse one history record strictly; anything malformed is refused, never counted. */
export function parseRunRecord(x: unknown): RunRecord | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const req = o.requests as Record<string, unknown> | undefined;
  const nums = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (typeof o.runnerVersion !== "string" || !o.runnerVersion) return null;
  if (typeof o.provider !== "string" || !o.provider) return null;
  if (!isIsoDate(o.startedAt) || !isIsoDate(o.endedAt)) return null;
  if (Date.parse(o.endedAt as string) < Date.parse(o.startedAt as string)) return null;
  if (!req || !nums(req.total) || !nums(req.ok) || !nums(req.failed) || !nums(req.blocked)) return null;
  if ((req.ok as number) + (req.failed as number) + (req.blocked as number) !== req.total) return null;
  if (!Array.isArray(o.pageListMs) || !o.pageListMs.every(nums)) return null;
  return o as unknown as RunRecord;
}

/** Gate 7. At least 3 runs at least 6 hours apart, each with >= 95% success and median page-list < 2 s. */
export function gateReliability(history: unknown[], provider: string): GateResult {
  const ev: string[] = [];
  const valid: RunRecord[] = [];
  history.forEach((h, i) => {
    const rec = parseRunRecord(h);
    if (!rec) ev.push(`History entry ${i} refused: not a valid run record.`);
    else if (rec.provider !== provider) ev.push(`History entry ${i} is for another provider; ignored.`);
    else valid.push(rec);
  });
  valid.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  // Keep runs that start at least 6 h after the previous kept run.
  const spaced: RunRecord[] = [];
  for (const rec of valid) {
    const prev = spaced[spaced.length - 1];
    if (!prev || Date.parse(rec.startedAt) - Date.parse(prev.startedAt) >= RELIABILITY_MIN_GAP_MS) spaced.push(rec);
  }
  let fail = false;
  for (const rec of spaced) {
    const rate = rec.requests.total ? rec.requests.ok / rec.requests.total : 0;
    const med = median(rec.pageListMs);
    const ok = rate >= RELIABILITY_MIN_SUCCESS && med !== null && med < RELIABILITY_MAX_MEDIAN_MS && rec.requests.blocked === 0;
    if (!ok) fail = true;
    ev.push(
      `${rec.startedAt} (runner ${rec.runnerVersion}): ${rec.requests.ok}/${rec.requests.total} ok (${(rate * 100).toFixed(1)}%), blocked ${rec.requests.blocked}, median page list ${med ?? "n/a"} ms: ${ok ? "pass" : "FAIL"}.`,
    );
  }
  if (fail) return r(7, "fail", ev);
  if (spaced.length < RELIABILITY_MIN_RUNS) {
    ev.push(`${spaced.length} qualifying runs (need ${RELIABILITY_MIN_RUNS}, at least 6 h apart).`);
    return r(7, "needs-evidence", ev);
  }
  return r(7, "pass", ev);
}

/** Gate 8. SHIELD's leak audit with the provider on must find 0 matches. */
export function gateLeak(leak: LeakAuditResult | null): GateResult {
  if (!leak) return r(8, "needs-evidence", ["No leak audit result supplied (--leak). Needs a run with the provider on in a preview."]);
  if (!isIsoDate(leak.ranAt) || typeof leak.matches !== "number") return r(8, "needs-evidence", ["Leak audit result is malformed."]);
  const ev = [`Leak audit ${leak.ranAt} on ${leak.target}: ${leak.matches} matches${leak.providerOn ? " (provider on)" : ""}.`];
  if (!leak.providerOn) return r(8, "needs-evidence", [...ev, "The audit must run with the provider on."]);
  return r(8, leak.matches === 0 ? "pass" : "fail", ev);
}

/** Gate 9. Decides offlineAllowed: only an explicit allowance is true. */
export function gateOffline(review: TermsReview | null): { result: GateResult; offlineAllowed: boolean } {
  if (!review) return { result: r(9, "needs-evidence", ["No terms review supplied."]), offlineAllowed: false };
  const offlineAllowed = review.offline === "allowed";
  const why = review.offline === "allowed" ? "terms explicitly allow saved reading" : review.offline === "forbidden" ? "terms forbid saving" : "terms unclear, so false";
  return {
    result: r(9, "pass", [`offlineAllowed: ${offlineAllowed} (${why}).${review.offlineNote ? ` ${review.offlineNote}` : ""}`]),
    offlineAllowed,
  };
}

export type Verdict = "enabled" | "disabled" | "blocked";

/** enabled only if all 9 gates pass; blocked when access failed; otherwise disabled. */
export function verdict(results: GateResult[]): Verdict {
  const byGate = new Map(results.map((x) => [x.gate, x]));
  if (byGate.get(4)?.status === "fail") return "blocked";
  const all = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as GateId[]).every((g) => byGate.get(g)?.status === "pass");
  return all ? "enabled" : "disabled";
}
