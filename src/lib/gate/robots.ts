/**
 * robots.txt for the gate runner (RFC 9309), plus the fetch rules agreed with JUDGE:
 *
 *   2xx              parse it
 *   404 / 410        no robots.txt: everything allowed (RFC 9309 section 2.3.1.3)
 *   other 4xx        treated as disallow-all (stricter than the RFC)
 *   5xx/unreachable  disallow-all, so gate 2 FAILS
 *   401 / 403 / challenge on robots.txt itself: gate 4 FAILS and the run stops
 *
 * isAllowed() checks our product token's group AND the `*` group and only
 * allows a path both allow (the stricter reading, MASTER_PROMPT section 11).
 * Content-Signal and other non-standard lines are kept for the record.
 */

import { BlockedError, type PoliteFetcher } from "./polite";

export const GATE_PRODUCT_TOKEN = "dawghwabot";

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay?: number;
}

export interface RobotsFile {
  groups: Group[];
  /** Non-standard lines worth recording (Content-Signal, Content-Usage, AI-use...). */
  signals: string[];
  sitemaps: string[];
}

export type RobotsFetch =
  | { kind: "parsed"; status: number; robots: RobotsFile }
  | { kind: "allow-all"; status: number }
  | { kind: "disallow-all"; status: number | null; reason: string }
  | { kind: "blocked"; status: number | null; reason: string };

const SIGNAL_KEYS = /^(content-signal|content-usage|ai-\w+|x-robots-\w+|noai|noimageai)$/i;

export function parseRobots(text: string): RobotsFile {
  const groups: Group[] = [];
  const signals: string[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "allow" || key === "disallow") {
      if (!current) continue;
      if (key === "disallow" && value === "") continue; // empty Disallow allows everything
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (current && Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    } else if (key === "sitemap") {
      sitemaps.push(value);
    } else if (SIGNAL_KEYS.test(key)) {
      signals.push(`${key}: ${value}`);
    }
  }
  return { groups, signals, sitemaps };
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

function normalizePath(path: string): string {
  // Compare percent-encoded forms consistently (RFC 9309 2.2.2).
  try {
    return encodeURI(decodeURI(path));
  } catch {
    return path;
  }
}

/** Groups for a product token: exact (case-insensitive) match; `*` only when asked for. */
function groupsFor(robots: RobotsFile, token: string): Group[] {
  return robots.groups.filter((g) => g.agents.includes(token));
}

function decide(rules: Rule[], path: string): boolean {
  let best: Rule | undefined;
  let bestLen = -1;
  for (const r of rules) {
    if (!patternToRegex(normalizePath(r.pattern)).test(path)) continue;
    const len = r.pattern.length;
    if (len > bestLen || (len === bestLen && r.allow && !best?.allow)) {
      best = r;
      bestLen = len;
    }
  }
  return best ? best.allow : true;
}

export interface PathDecision {
  path: string;
  allowed: boolean;
  ours: boolean;
  star: boolean;
}

/** Allowed only if both our group (if any) and the `*` group allow it. */
export function isAllowed(robots: RobotsFile, rawPath: string, token = GATE_PRODUCT_TOKEN): PathDecision {
  const path = normalizePath(rawPath.startsWith("/") ? rawPath : `/${rawPath}`);
  if (path === "/robots.txt") return { path: rawPath, allowed: true, ours: true, star: true };
  const ourRules = groupsFor(robots, token).flatMap((g) => g.rules);
  const starRules = groupsFor(robots, "*").flatMap((g) => g.rules);
  const ours = decide(ourRules, path);
  const star = decide(starRules, path);
  return { path: rawPath, allowed: ours && star, ours, star };
}

/** The larger Crawl-delay of our group and `*`, in seconds. */
export function crawlDelay(robots: RobotsFile, token = GATE_PRODUCT_TOKEN): number | undefined {
  const values = [...groupsFor(robots, token), ...groupsFor(robots, "*")]
    .map((g) => g.crawlDelay)
    .filter((n): n is number => n !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

export async function fetchRobots(fetcher: PoliteFetcher, origin: string): Promise<RobotsFetch> {
  let res: Response;
  try {
    res = await fetcher.get(new URL("/robots.txt", origin));
  } catch (e) {
    if (e instanceof BlockedError) return { kind: "blocked", status: e.status ?? null, reason: e.reason };
    return { kind: "disallow-all", status: null, reason: `unreachable: ${(e as Error).message}` };
  }
  if (res.status >= 200 && res.status < 300) {
    const text = await res.text();
    return { kind: "parsed", status: res.status, robots: parseRobots(text) };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 404 || res.status === 410) return { kind: "allow-all", status: res.status };
  return { kind: "disallow-all", status: res.status, reason: `HTTP ${res.status}` };
}
