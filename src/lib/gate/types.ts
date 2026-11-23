/**
 * Types for the provider gate runner (MASTER_PROMPT section 11, Spec Q).
 * Internal only: none of this is part of an HTTP response.
 */

/** What an adapter must offer to be gated (Spec Q). */
export interface ProviderAdapter {
  /** Internal id, never exposed to users. */
  readonly id: string;
  /** Env flag, e.g. PROVIDER_EXAMPLE (see flags.ts). */
  readonly flag: string;
  /** From the terms review (gate 9). */
  readonly offlineAllowed: boolean;
  /** Site and API hosts the adapter calls (robots.txt is checked on each). */
  readonly hosts: readonly string[];
  /** Page-image hosts (redirect and request targets allowed for page loads). */
  readonly imageHosts: readonly string[];
  /** Paths the adapter requests, as robots.txt patterns are matched (gate 2). */
  readonly paths: readonly string[];
  search(q: string): Promise<{ ref: string; title: string; score?: number }[]>;
  chapters(ref: string): Promise<{ n: number; ref: string; lang: string | null }[]>;
  pages(ref: string, n: number): Promise<string[]>;
  /** Would the image relay serve this page URL (declared page-image host)? */
  allowPage?(url: string): boolean;
}

export type GateId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type GateStatus = "pass" | "fail" | "not-run" | "needs-evidence";

export interface GateResult {
  gate: GateId;
  name: string;
  status: GateStatus;
  evidence: string[];
}

export const GATE_NAMES: Record<GateId, string> = {
  1: "Terms",
  2: "robots.txt",
  3: "Rights and takedowns",
  4: "Access without circumvention",
  5: "Rate and politeness",
  6: "Quality on 12 or more titles",
  7: "Reliability",
  8: "Hidden-source compliance",
  9: "Offline permission",
};

/** Written by SCOUT (or a human) after reading the site's pages; the runner never guesses these. */
export interface TermsReview {
  provider: string;
  reviewedBy: string;
  /** ISO date the pages were read. */
  reviewedAt: string;
  termsUrl: string | null;
  /** Own-words summary, no quotes. */
  termsSummary: string;
  /** true = terms forbid automated access, bots, scraping or this kind of use. null = unclear (FAIL). */
  forbidsAutomation: boolean | null;
  rightsContactUrl: string | null;
  rightsContactWorks: boolean | null;
  /** Titles flagged as licensed elsewhere or under takedown (excluded from use). */
  licensedExclusions: string[];
  offline: "allowed" | "forbidden" | "unclear";
  offlineNote?: string;
  /** Language the site publishes in, when chapters do not report one (e.g. "en"). */
  siteLanguage?: string;
}

export type TitleKind = "manga" | "manhwa" | "manhua";

/** One title of the fixed quality list (gate 6). */
export interface QualityTitle {
  name: string;
  altNames?: string[];
  kind: TitleKind;
  popularity: "popular" | "niche";
  state: "ongoing" | "finished";
  language: string;
  /** Reference chapter count (from the canonical catalog), for the 5 percent check. */
  referenceChapters: number;
}

export interface TitleOutcome {
  title: string;
  kind: TitleKind;
  excluded?: boolean;
  matchScore: number | null;
  matchedTitle?: string;
  ref?: string;
  /** Distinct refs at or above the match threshold (more than one = duplicate/mismatch). */
  strongRefs: number;
  chapters: number | null;
  languages: string[];
  pageList?: { pages: number; ms: number };
  pagesLoaded?: number;
  pageFailures?: string[];
  error?: string;
}

/** One gate-runner run, appended to the reliability history (gate 7). */
export interface RunRecord {
  runnerVersion: string;
  provider: string;
  startedAt: string;
  endedAt: string;
  requests: { total: number; ok: number; failed: number; blocked: number };
  pageListMs: number[];
}

/** SHIELD's leak audit output for gate 8 (scripts/audit/leaks.mjs, app repo). */
export interface LeakAuditResult {
  ranAt: string;
  target: string;
  matches: number;
  providerOn?: boolean;
}
