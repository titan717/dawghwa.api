/**
 * Page-image delivery for GET /api/v2/img/<token>.
 *
 * The token (see token.ts) is the only input. After it verifies, the URL is
 * re-checked against the source's declared page-image hosts, the destination
 * must be public, the request is paced (1 req/s per upstream host), and the
 * response must be HTTP 200, at most `maxBytes`, and its bytes must sniff as
 * JPEG/PNG/GIF/WebP/AVIF (SVG and anything else is refused). Upstream headers
 * are never forwarded. 403s and challenges are failures: no retry, no
 * alternate route.
 */

import { assertPublicDestination } from "@/lib/core/net-guard";
import { KeyedRateLimiter } from "@/lib/core/rate-limiter";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";
import { PAGE_MAX_BYTES, reportMangaDexAtHome } from "@/lib/services/cover-image";
import { fetchPageImage, isGenericBinaryType, pageImageHeaders, sniffImageType } from "@/lib/services/page-image";
import { imageProxySettings } from "./config";
import { v2Pacer, type HostPacer } from "./pacer";
import { verifyImageToken } from "./token";

export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

export type ImageOutcome =
  | { ok: true; body: Uint8Array; type: string; maxAge: number }
  | { ok: false; status: number; retryAfter?: number };

export interface ImageDeps {
  maxBytes?: number;
  pacer?: HostPacer;
  pacingMaxWaitMs?: number;
  providerFor?: (id: string) => Provider | undefined;
  now?: () => number;
  timeoutMs?: number;
}

let limiter: { perMinute: number; l: KeyedRateLimiter } | null = null;

/** Per-client limit for image requests (in-memory, per instance). */
export function takeImageRate(clientId: string): { allowed: boolean; retryAfter: number } {
  const perMinute = imageProxySettings().ratePerMinute;
  if (!limiter || limiter.perMinute !== perMinute) limiter = { perMinute, l: new KeyedRateLimiter(perMinute) };
  const r = limiter.l.take(`v2img:${clientId}`);
  return { allowed: r.allowed, retryAfter: r.retryAfter };
}

/** Test helper. */
export function resetImageRate(): void {
  limiter = null;
}

/** Read a body with a hard byte ceiling (a lying or absent Content-Length cannot bypass it). */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | "too-large" | "error"> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return "too-large";
  }
  if (!res.body) return "error";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    return "error";
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function deliverImage(token: string, deps: ImageDeps = {}): Promise<ImageOutcome> {
  const settings = imageProxySettings();
  if (!settings.enabled || !settings.secret) return { ok: false, status: 404 };
  const now = deps.now ?? Date.now;
  const v = verifyImageToken(token, settings.secret, now());
  if (!v.ok) return { ok: false, status: v.reason === "expired" ? 410 : 404 };

  const provider = (deps.providerFor ?? ((id: string) => getRegistry().get(id)))(v.claims.sourceId);
  if (!provider || !provider.operational || !provider.capabilities.chapterPages) return { ok: false, status: 404 };
  const url = provider.scraper.allowPageImage(v.claims.url);
  if (!url) return { ok: false, status: 404 };
  try {
    await assertPublicDestination(url.toString());
  } catch {
    return { ok: false, status: 404 };
  }

  const pacer = deps.pacer ?? v2Pacer();
  if (!(await pacer.wait(url.hostname, deps.pacingMaxWaitMs ?? 20_000))) return { ok: false, status: 503, retryAfter: 2 };

  const started = Date.now();
  const report = (success: boolean, bytes: number) => {
    if (provider.id === "mangadex") reportMangaDexAtHome(url, { success, bytes, duration: Date.now() - started, cached: false });
  };
  let upstream: Response;
  try {
    upstream = await fetchPageImage(provider, url, {
      headers: pageImageHeaders(provider),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 12_000),
      checkDestination: assertPublicDestination,
    });
  } catch {
    report(false, 0);
    return { ok: false, status: 504 };
  }
  const type = (upstream.headers.get("content-type") ?? "").toLowerCase();
  if (upstream.status !== 200 || !(type.startsWith("image/") || isGenericBinaryType(type))) {
    await upstream.body?.cancel().catch(() => {});
    report(false, 0);
    return { ok: false, status: upstream.status === 404 ? 404 : 502 };
  }
  const body = await readCapped(upstream, deps.maxBytes ?? PAGE_MAX_BYTES);
  if (body === "too-large") {
    report(false, 0);
    return { ok: false, status: 502 };
  }
  if (body === "error") {
    report(false, 0);
    return { ok: false, status: 502 };
  }
  // The bytes decide the type; a declared image/svg+xml or HTML error page is refused.
  const sniffed = sniffImageType(body);
  if (!sniffed || !ALLOWED_IMAGE_TYPES.has(sniffed)) {
    report(false, body.byteLength);
    return { ok: false, status: 502 };
  }
  report(true, body.byteLength);
  const maxAge = Math.max(0, Math.floor(v.claims.exp - now() / 1000));
  return { ok: true, body, type: sniffed, maxAge };
}
