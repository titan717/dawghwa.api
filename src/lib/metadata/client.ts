import { CircuitBreaker } from "@/lib/core/circuit-breaker";
import { getConfig } from "@/lib/core/config";
import { newStats, runWithContext } from "@/lib/core/context";
import { DawghwaError, isSourceFailure, toDawghwaError } from "@/lib/core/errors";
import { setProviderRateLimit, upstreamFetch } from "@/lib/core/http";
import { combineSignals } from "@/lib/core/retry";
import type { MetadataProviderId } from "./types";

/**
 * Outbound calls to metadata databases go through the same shared HTTP client
 * as the reading sources (timeouts, retries with backoff honouring
 * Retry-After, SSRF guard, size limits), with their own rate-limit bucket and
 * circuit breaker so a database outage cannot affect source operations.
 *
 * MangaDex metadata shares the "mangadex" bucket with the MangaDex source
 * adapter, so both together stay inside MangaDex's documented limit.
 */
const LIMIT_KEYS: Record<MetadataProviderId, string> = {
  anilist: "meta:anilist",
  mangadex: "mangadex",
  mangaupdates: "meta:mangaupdates",
};

const breakers = new Map<MetadataProviderId, CircuitBreaker>();
let limitsApplied = false;

function applyLimits(): void {
  if (limitsApplied) return;
  limitsApplied = true;
  const perMinute = getConfig().metadata.anilistPerMinute;
  // Stay just under the documented limit and keep bursts small (AniList also
  // runs an undocumented burst limiter).
  setProviderRateLimit(LIMIT_KEYS.anilist, { rps: (perMinute * 0.9) / 60, burst: 3, maxConcurrent: 2 });
  // MangaUpdates asks for "reasonable spacing between requests" and caching.
  setProviderRateLimit(LIMIT_KEYS.mangaupdates, { rps: 2, burst: 4, maxConcurrent: 2 });
}

export function breakerFor(id: MetadataProviderId): CircuitBreaker {
  let b = breakers.get(id);
  if (!b) {
    const cfg = getConfig().providers;
    b = new CircuitBreaker(cfg.breakerFailureThreshold, cfg.breakerCooldownMs);
    breakers.set(id, b);
  }
  return b;
}

/** Test helper. */
export function resetMetadataClient(): void {
  breakers.clear();
  limitsApplied = false;
}

const NAMES: Record<MetadataProviderId, string> = {
  anilist: "AniList",
  mangadex: "MangaDex",
  mangaupdates: "MangaUpdates",
};

/**
 * Fetch JSON from a metadata provider. 404 becomes NOT_FOUND; other failures
 * are classified by the shared error model and feed the provider's breaker.
 */
export async function metaJson<T>(
  provider: MetadataProviderId,
  url: string,
  init: RequestInit = {},
  opts: { notFoundMessage?: string } = {},
): Promise<T> {
  applyLimits();
  const breaker = breakerFor(provider);
  breaker.assertCanPass(NAMES[provider]);
  const timeoutMs = getConfig().metadata.timeoutMs;
  const { signal, cleanup } = combineSignals([], timeoutMs);
  const started = Date.now();
  try {
    const res = await runWithContext(
      { providerId: LIMIT_KEYS[provider], signal, deadline: started + timeoutMs, stats: newStats() },
      () =>
        upstreamFetch(url, {
          ...init,
          headers: {
            Accept: "application/json",
            // Metadata APIs are called as an identified API client, not a browser
            // (MangaDex rejects spoofed browser user agents).
            "User-Agent": `dawghwa-api/${getConfig().version} (+https://github.com/titan717/dawghwa.api)`,
            ...(init.headers as Record<string, string> | undefined),
          },
        }),
    );
    if (res.status === 404) {
      breaker.onNeutral();
      throw new DawghwaError("NOT_FOUND", opts.notFoundMessage ?? `${NAMES[provider]} has no entry with this id`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new DawghwaError("UPSTREAM_ERROR", `${NAMES[provider]} returned an invalid response`, {
        // Status and type only (never the body) so a production failure is diagnosable from the response.
        details: { upstreamStatus: res.status, contentType: res.headers.get("content-type") ?? null },
        cause: new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`),
      });
    }
    if (!res.ok) {
      // AniList returns validation problems as 400 with a GraphQL error body.
      if (res.status === 400) {
        breaker.onNeutral();
        throw new DawghwaError("VALIDATION_ERROR", `${NAMES[provider]} rejected the request`, {
          details: { upstreamStatus: 400 },
        });
      }
      throw new DawghwaError(
        res.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_HTTP_ERROR",
        `HTTP ${res.status} from ${NAMES[provider]}`,
        { retryable: res.status >= 500 || res.status === 429, details: { upstreamStatus: res.status } },
      );
    }
    breaker.onSuccess();
    return body as T;
  } catch (e) {
    const err = toDawghwaError(e);
    if (isSourceFailure(err)) breaker.onFailure();
    throw err;
  } finally {
    cleanup();
  }
}

/** Strip HTML tags/entities from provider descriptions (AniList uses HTML). */
export function plainText(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const text = input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || undefined;
}

export function uniqueStrings(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
