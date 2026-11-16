import { detectChallenge } from "./antibot";
import { getConfig } from "./config";
import { currentContext } from "./context";
import { DawghwaError, UpstreamHttpError, isAbortError, safeHost } from "./errors";
import { ProviderLimiter, ProviderRateLimit } from "./rate-limiter";
import { backoffDelay, combineSignals, parseRetryAfter, sleep, timeoutError } from "./retry";
import { SingleFlight } from "./singleflight";
import { assertPublicDestination } from "./net-guard";

/**
 * Shared outbound HTTP client used by every source adapter.
 *
 * Features (all transparent to adapters, which keep using a fetch-compatible API):
 *  - per-attempt timeout + cancellation via the operation's AbortSignal/deadline
 *  - retries with exponential backoff + full jitter, honouring Retry-After;
 *    only for network errors, timeouts, 408/425/429/5xx (never for 4xx like 403)
 *  - anti-bot challenge detection -> UPSTREAM_BLOCKED (no retries, no bypass)
 *  - per-provider token-bucket rate limit and concurrency cap
 *  - in-flight request deduplication for identical idempotent requests
 *  - conditional revalidation with ETag / Last-Modified (304 -> cached body)
 *  - bounded response size
 */

export interface BufferedResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
  url: string;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "accept-encoding", "transfer-encoding", "host", "content-length"]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

const limiters = new Map<string, ProviderLimiter>();
const limitOverrides = new Map<string, Partial<ProviderRateLimit>>();
const flights = new SingleFlight<BufferedResponse>();

interface ConditionalEntry {
  etag?: string;
  lastModified?: string;
  response: BufferedResponse;
  bytes: number;
}
const conditional = new Map<string, ConditionalEntry>();
let conditionalBytes = 0;

export function setProviderRateLimit(key: string, limits: Partial<ProviderRateLimit>): void {
  limitOverrides.set(key, limits);
  limiters.delete(key);
}

export function getLimiter(key: string): ProviderLimiter {
  let limiter = limiters.get(key);
  if (!limiter) {
    const cfg = getConfig().providers;
    limiter = new ProviderLimiter({
      rps: cfg.defaultRps,
      burst: cfg.defaultBurst,
      maxConcurrent: cfg.defaultMaxConcurrent,
      maxQueue: 200,
      ...limitOverrides.get(key),
    });
    limiters.set(key, limiter);
  }
  return limiter;
}

export function httpStats() {
  return {
    limiters: limiters.size,
    inflight: flights.size,
    conditionalEntries: conditional.size,
    conditionalBytes,
  };
}

/** Test helper. */
export function resetHttpState(): void {
  limiters.clear();
  conditional.clear();
  conditionalBytes = 0;
}

function toUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function buildHeaders(init: RequestInit | undefined): Headers {
  const cfg = getConfig().http;
  const headers = new Headers({
    "User-Agent": cfg.userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
  });
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
    });
  }
  return headers;
}

function bodyKey(body: RequestInit["body"]): string | null {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null; // FormData / streams: not safely dedupable
}

function headersKey(headers: Headers): string {
  const parts: string[] = [];
  headers.forEach((v, k) => {
    if (k !== "user-agent") parts.push(`${k}:${v}`);
  });
  return parts.sort().join("\n");
}

function toResponse(buf: BufferedResponse): Response {
  // 204/304 must not carry a body.
  const nullBody = buf.status === 204 || buf.status === 304;
  const res = new Response(nullBody ? null : buf.body.slice(0), {
    status: buf.status,
    statusText: buf.statusText,
    headers: buf.headers,
  });
  Object.defineProperty(res, "url", { value: buf.url });
  return res;
}

async function readLimited(res: Response, limit: number): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new DawghwaError("UPSTREAM_RESPONSE_TOO_LARGE", "Upstream response exceeded the size limit");
  }
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new DawghwaError("UPSTREAM_RESPONSE_TOO_LARGE", "Upstream response exceeded the size limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

function rememberConditional(key: string, buf: BufferedResponse): void {
  const cfg = getConfig().http;
  if (cfg.conditionalCacheEntries <= 0) return;
  const h = new Headers(buf.headers);
  const etag = h.get("etag") ?? undefined;
  const lastModified = h.get("last-modified") ?? undefined;
  if (!etag && !lastModified) return;
  if (/no-store/i.test(h.get("cache-control") ?? "")) return;
  const bytes = buf.body.byteLength;
  if (bytes > cfg.conditionalCacheMaxBytes / 8) return;
  const prev = conditional.get(key);
  if (prev) {
    conditionalBytes -= prev.bytes;
    conditional.delete(key);
  }
  conditional.set(key, { etag, lastModified, response: buf, bytes });
  conditionalBytes += bytes;
  while (conditional.size > cfg.conditionalCacheEntries || conditionalBytes > cfg.conditionalCacheMaxBytes) {
    const oldest = conditional.keys().next().value;
    if (oldest === undefined) break;
    conditionalBytes -= conditional.get(oldest)!.bytes;
    conditional.delete(oldest);
  }
}

const MAX_REDIRECTS = 5;

/**
 * fetch() with redirects followed manually so that every hop is checked by
 * assertPublicDestination (a public host must not be able to redirect us into
 * the private network). Callers that pass redirect:"manual"/"error" get the
 * native behaviour, still with the first hop checked.
 */
async function fetchWithGuardedRedirects(
  url: string,
  method: string,
  headers: Headers,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  headers = new Headers(headers);
  const mode = init.redirect ?? "follow";
  let current = url;
  let currentMethod = method;
  let body = init.body;
  for (let hop = 0; ; hop++) {
    await assertPublicDestination(current);
    const res = await fetch(current, {
      method: currentMethod,
      headers,
      body,
      redirect: mode === "follow" ? "manual" : mode,
      signal,
      cache: "no-store",
    });
    const location = res.headers.get("location");
    if (mode !== "follow" || res.status < 300 || res.status > 399 || res.status === 304 || !location) {
      if (hop > 0) Object.defineProperty(res, "url", { value: current });
      return res;
    }
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) {
      throw new DawghwaError("UPSTREAM_ERROR", `${safeHost(url)} redirected too many times`);
    }
    const next = new URL(location, current);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
      currentMethod = "GET";
      body = undefined;
      headers.delete("content-type");
    }
    if (next.origin !== new URL(current).origin) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    current = next.toString();
  }
}

async function performRequest(
  url: string,
  method: string,
  headers: Headers,
  init: RequestInit,
  limiterKey: string,
  condKey: string | null,
): Promise<BufferedResponse> {
  const cfg = getConfig().http;
  const ctx = currentContext();
  const stats = ctx?.stats;
  const limiter = getLimiter(limiterKey);
  const callerSignal = init.signal ?? undefined;
  const opSignal = ctx?.signal;

  const cond = condKey ? conditional.get(condKey) : undefined;
  if (cond) {
    if (cond.etag && !headers.has("if-none-match")) headers.set("If-None-Match", cond.etag);
    if (cond.lastModified && !headers.has("if-modified-since")) headers.set("If-Modified-Since", cond.lastModified);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    const remaining = ctx?.deadline ? ctx.deadline - Date.now() : Infinity;
    if (remaining <= 25) {
      throw lastError ?? new DawghwaError("UPSTREAM_TIMEOUT", "Source operation deadline exceeded", { retryable: true });
    }
    if (attempt > 0 && stats) stats.retries += 1;

    const attemptTimeout = Math.min(cfg.requestTimeoutMs, remaining);
    const { signal, cleanup } = combineSignals([callerSignal, opSignal], attemptTimeout);
    let release: (() => void) | undefined;
    let retryDelay: number | undefined;
    try {
      release = await limiter.acquire(signal);
      if (stats) stats.upstreamRequests += 1;
      const res = await fetchWithGuardedRedirects(url, method, headers, init, signal);

      if (res.status === 304 && cond) {
        await res.body?.cancel().catch(() => undefined);
        if (stats) {
          stats.conditionalHits += 1;
          stats.upstreamSuccesses += 1;
        }
        return cond.response;
      }

      const body = await readLimited(res, cfg.maxResponseBytes);
      const buf: BufferedResponse = {
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        body,
        url: res.url || url,
      };

      if (res.ok) {
        if (stats) stats.upstreamSuccesses += 1;
        if (condKey) rememberConditional(condKey, buf);
        return buf;
      }

      if (res.status === 403 || res.status === 429 || res.status === 503 || res.status === 401) {
        const text = new TextDecoder().decode(body.byteLength > 65_536 ? body.slice(0, 65_536) : body);
        const challenge = detectChallenge(text, res.headers);
        if (challenge.blocked) {
          const err = new DawghwaError(
            "UPSTREAM_BLOCKED",
            `${safeHost(url)} is protected by an anti-bot challenge (${challenge.vendor})`,
            { details: { upstreamStatus: res.status, vendor: challenge.vendor } },
          );
          if (stats) stats.lastError = err;
          throw err;
        }
      }

      const httpErr = new UpstreamHttpError(res.status, url);
      if (res.status !== 404 && stats) stats.lastError = httpErr;
      if (RETRYABLE_STATUS.has(res.status) && attempt < cfg.retries) {
        lastError = httpErr;
        const ra = parseRetryAfter(res.headers.get("retry-after"));
        if (ra !== undefined && ra > cfg.retryMaxDelayMs) return buf; // too long to wait: give up now
        retryDelay = ra ?? backoffDelay(attempt, { baseMs: cfg.retryBaseDelayMs, maxMs: cfg.retryMaxDelayMs });
      } else {
        // Non-retryable (or exhausted): hand the response to the adapter, which decides.
        return buf;
      }
    } catch (error) {
      if (error instanceof DawghwaError && !error.retryable) throw error;
      // Caller / operation cancellation is final.
      if (callerSignal?.aborted || opSignal?.aborted) {
        throw opSignal?.reason instanceof Error ? opSignal.reason : error;
      }
      const timedOut = isAbortError(error) || signal.reason?.name === "TimeoutError";
      const wrapped = timedOut
        ? new DawghwaError("UPSTREAM_TIMEOUT", `${safeHost(url)} did not respond within ${attemptTimeout}ms`, {
            retryable: true,
            cause: error,
          })
        : error instanceof DawghwaError
          ? error
          : new DawghwaError("UPSTREAM_NETWORK_ERROR", `Could not reach ${safeHost(url)}`, {
              retryable: true,
              cause: error,
            });
      if (stats) stats.lastError = wrapped;
      lastError = wrapped;
      if (attempt >= cfg.retries) throw wrapped;
      retryDelay = backoffDelay(attempt, { baseMs: cfg.retryBaseDelayMs, maxMs: cfg.retryMaxDelayMs });
    } finally {
      release?.();
      cleanup();
    }

    if (retryDelay !== undefined) {
      const left = ctx?.deadline ? ctx.deadline - Date.now() : Infinity;
      if (retryDelay >= left) throw lastError ?? timeoutError();
      await sleep(retryDelay, opSignal ?? callerSignal);
    }
  }
  throw lastError ?? new DawghwaError("UPSTREAM_ERROR", "Upstream request failed");
}

/**
 * fetch()-compatible entry point for adapters. Always resolves to a fresh
 * Response object (safe to consume even when the underlying request was shared).
 */
export async function upstreamFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = toUrl(input);
  const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = buildHeaders(init);
  const ctx = currentContext();
  const limiterKey = ctx?.providerId ?? safeHost(url);

  const bk = bodyKey(init.body);
  const idempotent = method === "GET" || method === "HEAD" || (method === "POST" && bk !== null);
  const condKey = method === "GET" && !bk ? `${url}\n${headersKey(headers)}` : null;

  if (!idempotent || init.signal) {
    return toResponse(await performRequest(url, method, headers, init, limiterKey, condKey));
  }

  const key = `${method} ${url}\n${headersKey(headers)}\n${bk}`;
  const { promise, shared } = flights.do(key, () =>
    performRequest(url, method, headers, init, limiterKey, condKey),
  );
  if (shared && ctx) ctx.stats.dedupedRequests += 1;
  return toResponse(await promise);
}

/** Convenience helpers used by the shared BaseScraper. */
export async function upstreamText(url: string, init?: RequestInit): Promise<string> {
  const res = await upstreamFetch(url, init);
  if (!res.ok) throw new UpstreamHttpError(res.status, url);
  return res.text();
}
