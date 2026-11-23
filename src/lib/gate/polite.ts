/**
 * Polite fetcher for the provider gate runner (MASTER_PROMPT section 11, Spec Q).
 *
 *  - at most one request per second per host (the interval can only be raised)
 *  - up to 3 attempts; 429 and 5xx back off (Retry-After honoured, capped)
 *  - 401, 403, a challenge page or a login redirect throws BlockedError and
 *    latches the host: every later request to it fails immediately
 *  - honest identity only: our bot User-Agent; caller User-Agent, Referer,
 *    Origin, Cookie and sec-* headers are removed and recorded
 *  - SSRF guard on every hop (assertPublicDestination plus the guarded
 *    dispatcher); redirects only to the same host or a declared host
 *  - every request is logged for the politeness and reliability gates
 *
 * There is no retry by another route: no other user agent, no proxy, no
 * headless browser, no cookies.
 */

import { fetch as undiciFetch } from "undici";
import { detectChallenge } from "@/lib/core/antibot";
import { assertPublicDestination, guardedDispatcher } from "@/lib/core/net-guard";

export const GATE_USER_AGENT = "DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)";
export const MIN_INTERVAL_MS = 1_000;

export type FetchImpl = (input: string | URL, init: RequestInit) => Promise<Response>;

export class BlockedError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
    readonly status?: number,
  ) {
    super(`${host} blocked (${reason})`);
    this.name = "BlockedError";
  }
}

/** A request the fetcher refused to send (SSRF guard, undeclared host, latched host). */
export class RefusedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`refused ${url}: ${reason}`);
    this.name = "RefusedError";
  }
}

export class UnavailableError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`${host} unavailable (${reason})`);
    this.name = "UnavailableError";
  }
}

export interface RequestLogEntry {
  at: string;
  host: string;
  path: string;
  status: number | null;
  ms: number;
  attempt: number;
  outcome: "ok" | "http-error" | "retry" | "blocked" | "refused" | "network-error";
  /** Waited before this request because of Retry-After (ms). */
  retryAfterMs?: number;
  cacheControl?: string;
  etag?: boolean;
  lastModified?: boolean;
  age?: string;
  rateLimit?: string;
}

export interface PoliteOptions {
  minIntervalMs?: number;
  maxAttempts?: number;
  /** Longest Retry-After we wait; a longer one ends the request as unavailable. */
  maxRetryAfterMs?: number;
  maxRedirects?: number;
  /** Hosts a redirect may lead to besides the requested host (declared provider hosts). */
  extraHosts?: Iterable<string>;
  /** Refuse every host that is not declared (used when adapters run through fetchHop). */
  restrictToDeclared?: boolean;
  inner?: FetchImpl;
  guard?: (url: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const STRIP = new Set(["user-agent", "referer", "origin", "cookie", "authorization"]);
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|sign_in|account\/login|auth)(\/|$|\?)/i;

const defaultInner: FetchImpl = (input, init) =>
  undiciFetch(input, { ...(init as object), dispatcher: guardedDispatcher() } as never) as unknown as Promise<Response>;

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, "");
}

export class PoliteFetcher {
  readonly log: RequestLogEntry[] = [];
  /** Headers callers tried to set that were removed (lower-case names). */
  readonly strippedHeaders = new Set<string>();
  readonly blocked = new Map<string, BlockedError>();
  readonly refused: { url: string; reason: string }[] = [];
  /** Total time spent waiting for pacing slots and backoff (excluded from latency figures). */
  waitedMs = 0;

  private readonly next = new Map<string, number>();
  private readonly interval: number;
  private readonly maxAttempts: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxRedirects: number;
  private readonly extraHosts: Set<string>;
  private readonly restrict: boolean;
  private readonly inner: FetchImpl;
  private readonly guard: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: PoliteOptions = {}) {
    this.interval = Math.max(MIN_INTERVAL_MS, opts.minIntervalMs ?? MIN_INTERVAL_MS);
    this.maxAttempts = Math.min(3, Math.max(1, opts.maxAttempts ?? 3));
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.maxRedirects = Math.min(3, opts.maxRedirects ?? 3);
    this.extraHosts = new Set([...(opts.extraHosts ?? [])].map((h) => h.toLowerCase()));
    this.restrict = opts.restrictToDeclared ?? false;
    this.inner = opts.inner ?? defaultInner;
    this.guard = opts.guard ?? assertPublicDestination;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Allow redirects to these hosts too (exact host or a subdomain of one). */
  declareHosts(hosts: Iterable<string>): void {
    for (const h of hosts) this.extraHosts.add(h.toLowerCase());
  }

  private declared(host: string): boolean {
    for (const d of this.extraHosts) if (host === d || host.endsWith(`.${d}`)) return true;
    return false;
  }

  private headers(init: RequestInit): Headers {
    const out = new Headers();
    if (init.headers) {
      new Headers(init.headers).forEach((v, k) => {
        const key = k.toLowerCase();
        if (key === "user-agent" && v === GATE_USER_AGENT) return;
        if (STRIP.has(key) || key.startsWith("sec-")) {
          this.strippedHeaders.add(key);
          return;
        }
        out.set(key, v);
      });
    }
    out.set("user-agent", GATE_USER_AGENT);
    return out;
  }

  private async pace(host: string): Promise<void> {
    const t = this.now();
    const slot = Math.max(t, this.next.get(host) ?? 0);
    this.next.set(host, slot + this.interval);
    if (slot > t) {
      this.waitedMs += slot - t;
      await this.sleep(slot - t);
    }
  }

  private refuse(url: string, reason: string): never {
    this.refused.push({ url, reason });
    let host = url;
    let path = "";
    try {
      const u = new URL(url);
      host = hostOf(u);
      path = u.pathname + u.search;
    } catch {
      /* invalid */
    }
    this.log.push({ at: new Date(this.now()).toISOString(), host, path, status: null, ms: 0, attempt: 0, outcome: "refused" });
    throw new RefusedError(url, reason);
  }

  private block(host: string, reason: string, status?: number): never {
    const e = new BlockedError(host, reason, status);
    this.blocked.set(host, e);
    throw e;
  }

  /**
   * One hop, no redirect following (redirect: "manual"). This is what the
   * gate runner installs with setGuardedFetchImpl: core/http.ts already
   * follows redirects hop by hop through it.
   */
  readonly fetchHop: FetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const host = hostOf(url);
    const latched = this.blocked.get(host);
    if (latched) throw latched;
    if (url.protocol !== "https:" && url.protocol !== "http:") this.refuse(url.toString(), "scheme");
    if (this.restrict && !this.declared(host)) this.refuse(url.toString(), "undeclared host");
    try {
      await this.guard(url.toString());
    } catch (e) {
      this.refuse(url.toString(), `ssrf-guard: ${(e as Error).message}`);
    }
    const headers = this.headers(init);
    let retryAfterMs: number | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.pace(host);
      const started = this.now();
      const at = new Date(started).toISOString();
      let res: Response;
      try {
        res = await this.inner(url.toString(), {
          method: init.method ?? "GET",
          body: init.body,
          signal: init.signal,
          headers,
          redirect: "manual",
          cache: "no-store",
        } as RequestInit);
      } catch (e) {
        this.log.push({ at, host, path: url.pathname + url.search, status: null, ms: this.now() - started, attempt, outcome: "network-error", retryAfterMs });
        throw e;
      }
      const ms = this.now() - started;
      const entry: RequestLogEntry = {
        at,
        host,
        path: url.pathname + url.search,
        status: res.status,
        ms,
        attempt,
        outcome: "ok",
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(res.headers.get("cache-control") ? { cacheControl: res.headers.get("cache-control")! } : {}),
        ...(res.headers.has("etag") ? { etag: true } : {}),
        ...(res.headers.has("last-modified") ? { lastModified: true } : {}),
        ...(res.headers.get("age") ? { age: res.headers.get("age")! } : {}),
        ...(res.headers.get("ratelimit") || res.headers.get("x-ratelimit-remaining")
          ? { rateLimit: res.headers.get("ratelimit") ?? res.headers.get("x-ratelimit-remaining")! }
          : {}),
      };
      this.log.push(entry);

      if (res.status === 401 || res.status === 403) {
        entry.outcome = "blocked";
        await res.body?.cancel().catch(() => undefined);
        this.block(host, `HTTP ${res.status}`, res.status);
      }
      if (res.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
        entry.outcome = "blocked";
        await res.body?.cancel().catch(() => undefined);
        this.block(host, "challenge", res.status);
      }
      if (/text\/html/i.test(res.headers.get("content-type") ?? "")) {
        const body = await res.clone().text();
        if (detectChallenge(body, res.headers).blocked) {
          entry.outcome = "blocked";
          this.block(host, "challenge", res.status);
        }
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const target = new URL(location, url);
        if (LOGIN_PATH.test(target.pathname)) {
          entry.outcome = "blocked";
          this.block(host, "login redirect", res.status);
        }
      }
      if (res.status === 429 || res.status >= 500) {
        const raw = res.headers.get("retry-after");
        const header = raw === null ? NaN : /^\d+$/.test(raw.trim()) ? Number(raw) * 1000 : Date.parse(raw) - this.now();
        const wait = Number.isFinite(header) && header >= 0 ? header : 2 ** attempt * 1000;
        await res.body?.cancel().catch(() => undefined);
        if (wait > this.maxRetryAfterMs || attempt === this.maxAttempts) {
          entry.outcome = "http-error";
          throw new UnavailableError(host, `HTTP ${res.status}${wait > this.maxRetryAfterMs ? ", Retry-After too long" : ""}`);
        }
        entry.outcome = "retry";
        retryAfterMs = Number.isFinite(header) ? wait : undefined;
        this.waitedMs += wait;
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 400) entry.outcome = "http-error";
      return res;
    }
    throw new UnavailableError(host, "attempts exhausted");
  };

  /** GET with redirects followed only to the same host or a declared host. */
  async get(input: string | URL, init: RequestInit = {}): Promise<Response> {
    let current = new URL(input.toString());
    const origin = hostOf(current);
    for (let hop = 0; ; hop++) {
      const res = await this.fetchHop(current, init);
      const location = res.headers.get("location");
      if (res.status < 300 || res.status > 399 || res.status === 304 || !location) {
        if (hop > 0) Object.defineProperty(res, "url", { value: current.toString() });
        return res;
      }
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, current);
      const h = hostOf(next);
      if (hop >= this.maxRedirects) this.refuse(next.toString(), "too many redirects");
      if (h !== origin && h !== hostOf(current) && !this.declared(h)) this.refuse(next.toString(), "redirect to an undeclared host");
      current = next;
    }
  }

  /** Requests that reached the network (not refused before sending). */
  sent(): RequestLogEntry[] {
    return this.log.filter((e) => e.outcome !== "refused");
  }
}
