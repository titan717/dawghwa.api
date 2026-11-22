#!/usr/bin/env node
/**
 * polite-fetch: a small, dependency-free HTTP client for studying a site's
 * PUBLIC structure. Built-in fetch only (Node >= 18).
 *
 * Rules it enforces (see ../SKILL.md):
 *  - robots.txt is read first for every host; disallowed paths are refused.
 *  - At most one request per `minIntervalMs` per host (default 1000 ms = 1 req/s).
 *  - Retries only 429 / 5xx / network errors, with exponential backoff
 *    base * 2^n (default 1s, 2s, 4s, 8s, 16s), max 5 retries. Retry-After
 *    (seconds or HTTP date) is honoured and wins over the computed delay.
 *  - STOP rules: 401, 403, 407, 451, or any anti-bot / CAPTCHA / challenge page
 *    marks the host as stopped. Every later call to that host throws
 *    StopError without touching the network. A Retry-After longer than
 *    `maxDelayMs` is also a stop.
 *  - A hard per-run request budget (default 30) across all hosts.
 *  - No cookies, no auth headers, no credentials are ever sent.
 *
 * Usage (CLI):
 *   node skills/site-structure-study/scripts/polite-fetch.mjs <url> [url...]
 * Prints one JSON line of recorded facts per request, plus a final summary.
 */

export class StopError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StopError";
    this.details = details;
  }
}

export class RobotsDisallowedError extends Error {
  constructor(url, rule) {
    super(`robots.txt disallows ${url} (rule: ${rule})`);
    this.name = "RobotsDisallowedError";
    this.url = url;
    this.rule = rule;
  }
}

export class BudgetExceededError extends Error {
  constructor(budget) {
    super(`request budget of ${budget} reached`);
    this.name = "BudgetExceededError";
  }
}

/** Response headers worth recording when studying a site. */
export const RECORDED_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "age",
  "vary",
  "retry-after",
  "ratelimit",
  "ratelimit-policy",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "link",
  "x-robots-tag",
  "server",
  "cf-mitigated",
  "location",
];

const STOP_STATUSES = new Set([401, 403, 407, 451]);

/** Heuristics for challenge / anti-bot / CAPTCHA pages. Conservative on purpose. */
const CHALLENGE_PATTERNS = [
  /<title>\s*(attention required|just a moment|access denied|security check|ddos-guard)/i,
  /cf-challenge|challenge-platform|cf_chl_/i,
  /g-recaptcha|h-captcha|hcaptcha\.com|turnstile/i,
  /sorry, you have been blocked/i,
  /please verify you are a human|are you a robot/i,
];

export function isChallenge(status, headers, bodyText) {
  if (headers.get("cf-mitigated")) return "cf-mitigated header";
  if (typeof bodyText === "string") {
    const head = bodyText.slice(0, 20_000);
    for (const p of CHALLENGE_PATTERNS) if (p.test(head)) return `body matches ${p}`;
  }
  if (status === 503 && /cloudflare|ddos-guard/i.test(headers.get("server") ?? "") && /html/i.test(headers.get("content-type") ?? "")) {
    return "503 HTML from protection service";
  }
  return null;
}

/**
 * Parse Retry-After (delta-seconds or HTTP-date) into milliseconds.
 * Returns null when absent or unparseable.
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null || value === "") return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - nowMs);
}

/** Backoff for retry attempt n (0-based): base * 2^n, capped. */
export function backoffDelay(attempt, baseDelayMs = 1000, maxDelayMs = 60_000) {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

/**
 * Minimal robots.txt parser (RFC 9309 subset): groups by user-agent, Allow /
 * Disallow with longest-match wins, Allow wins ties, `*` and `$` wildcards.
 * Also returns Content-Signal and Crawl-delay values seen in matching groups.
 */
export function parseRobots(text, userAgentToken) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], contentSignals: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") current.rules.push({ allow: key === "allow", path: value });
    else if (key === "content-signal") current.contentSignals.push(value);
    else if (key === "crawl-delay") current.crawlDelay = Number(value);
  }
  const token = String(userAgentToken || "").toLowerCase();
  const specific = token ? groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a))) : [];
  const matched = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = matched.flatMap((g) => g.rules);
  return {
    rules,
    contentSignals: matched.flatMap((g) => g.contentSignals),
    crawlDelay: matched.map((g) => g.crawlDelay).find((d) => typeof d === "number" && !Number.isNaN(d)) ?? null,
    isAllowed(pathWithQuery) {
      let best = null;
      for (const r of rules) {
        if (r.path === "") continue; // "Disallow:" (empty) allows everything
        if (!robotsPatternMatches(r.path, pathWithQuery)) continue;
        const len = r.path.length;
        if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow, rule: r };
      }
      return best ? { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.rule.path}` } : { allowed: true, rule: null };
    },
  };
}

function robotsPatternMatches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/**
 * Create a polite client. All options are injectable for tests.
 */
export function createPoliteClient(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    userAgent = "site-structure-study/1.0 (+public-structure research; 1 req/s)",
    minIntervalMs = 1000,
    baseDelayMs = 1000,
    maxDelayMs = 60_000,
    maxRetries = 5,
    budget = 30,
    timeoutMs = 20_000,
    checkRobots = true,
  } = options;

  const lastRequestAt = new Map(); // host -> ms
  const stopped = new Map(); // host -> reason
  const robotsCache = new Map(); // origin -> parsed robots | null
  const log = [];
  let used = 0;

  async function waitTurn(host) {
    const last = lastRequestAt.get(host);
    if (last != null) {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now());
  }

  async function rawRequest(url, { method = "GET" } = {}) {
    const host = url.host;
    if (stopped.has(host)) throw new StopError(`host ${host} is stopped: ${stopped.get(host)}`, { host });
    if (used >= budget) throw new BudgetExceededError(budget);
    await waitTurn(host);
    used += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = now();
    try {
      // No cookies, no Authorization: only a UA and Accept.
      const res = await fetchImpl(url.toString(), {
        method,
        redirect: "manual",
        headers: { "user-agent": userAgent, accept: "*/*" },
        signal: controller.signal,
      });
      return { res, ms: now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  function record(url, res, ms, attempt, bodyText) {
    const headers = {};
    for (const h of RECORDED_HEADERS) {
      const v = res.headers.get(h);
      if (v != null) headers[h] = v;
    }
    const entry = {
      at: new Date(now()).toISOString(),
      url: url.toString(),
      status: res.status,
      attempt,
      ms,
      bytes: typeof bodyText === "string" ? bodyText.length : null,
      headers,
    };
    log.push(entry);
    return entry;
  }

  function stopHost(host, reason, entry) {
    stopped.set(host, reason);
    throw new StopError(`STOP ${host}: ${reason}`, { host, reason, entry });
  }

  /** One request with retry/backoff and stop rules. Does not check robots. */
  async function request(input, opts = {}) {
    const url = new URL(input);
    if (url.username || url.password) throw new StopError("credentials in URL are not allowed", { url: url.toString() });
    let attempt = 0;
    for (;;) {
      let res, ms;
      try {
        ({ res, ms } = await rawRequest(url, opts));
      } catch (err) {
        if (err instanceof StopError || err instanceof BudgetExceededError) throw err;
        if (attempt >= maxRetries) throw err;
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        attempt += 1;
        continue;
      }
      const text = await res.text().catch(() => "");
      const entry = record(url, res, ms, attempt, text);
      if (STOP_STATUSES.has(res.status)) stopHost(url.host, `HTTP ${res.status}`, entry);
      const challenge = isChallenge(res.status, res.headers, text);
      if (challenge) stopHost(url.host, `challenge page (${challenge})`, entry);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) return { ...entry, text, gaveUp: false };
      if (attempt >= maxRetries) return { ...entry, text, gaveUp: true };
      const ra = parseRetryAfter(res.headers.get("retry-after"), now());
      if (ra != null && ra > maxDelayMs) stopHost(url.host, `Retry-After ${Math.round(ra / 1000)}s exceeds max ${maxDelayMs / 1000}s`, entry);
      await sleep(ra ?? backoffDelay(attempt, baseDelayMs, maxDelayMs));
      attempt += 1;
    }
  }

  async function robotsFor(url) {
    if (robotsCache.has(url.origin)) return robotsCache.get(url.origin);
    const r = await request(new URL("/robots.txt", url.origin));
    let parsed = null;
    if (r.status >= 200 && r.status < 300) parsed = parseRobots(r.text, userAgent);
    else if (r.status >= 400 && r.status < 500) parsed = parseRobots("", userAgent); // RFC 9309: 4xx = no restrictions
    else stopHost(url.host, `robots.txt unreachable (HTTP ${r.status}); RFC 9309 says assume complete disallow`);
    robotsCache.set(url.origin, parsed);
    return parsed;
  }

  /** Robots-checked GET. */
  async function get(input) {
    const url = new URL(input);
    if (checkRobots && url.pathname !== "/robots.txt") {
      const robots = await robotsFor(url);
      const verdict = robots.isAllowed(url.pathname + url.search);
      if (!verdict.allowed) throw new RobotsDisallowedError(url.toString(), verdict.rule);
    }
    return request(url);
  }

  return {
    get,
    request,
    robotsFor,
    log,
    stopped,
    get used() {
      return used;
    },
    settings: { userAgent, minIntervalMs, baseDelayMs, maxDelayMs, maxRetries, budget, timeoutMs },
  };
}

async function main(argv) {
  const urls = argv.slice(2);
  if (!urls.length) {
    console.error("usage: polite-fetch.mjs <url> [url...]");
    process.exitCode = 2;
    return;
  }
  const client = createPoliteClient();
  for (const u of urls) {
    try {
      const r = await client.get(u);
      const { text: _text, ...facts } = r;
      void _text;
      console.log(JSON.stringify(facts));
    } catch (err) {
      console.log(JSON.stringify({ url: u, error: err.name, message: err.message }));
      if (err instanceof StopError || err instanceof BudgetExceededError) {
        process.exitCode = 3;
      }
    }
  }
  console.log(JSON.stringify({ summary: { requests: client.used, settings: client.settings, stoppedHosts: Object.fromEntries(client.stopped) } }));
}

const isCli = typeof process !== "undefined" && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) await main(process.argv);
