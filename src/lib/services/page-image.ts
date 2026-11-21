import { getConfig } from "@/lib/core/config";
import { guardedFetch } from "@/lib/core/net-guard";
import type { Provider } from "@/lib/providers/provider";
import { COVER_USER_AGENT } from "./cover-image";

/**
 * Request headers for a provider's page images: the provider's reader
 * Referer (what its own reader sends) and the configured User-Agent. Shared by
 * /api/image and the live verifier so both exercise the same request.
 */
export function pageImageHeaders(provider: Provider): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "image/avif,image/webp,image/*;q=0.8",
    "User-Agent": provider.scraper.pageImageUserAgent() === "identifying" ? COVER_USER_AGENT : getConfig().http.userAgent,
  };
  const referer = provider.scraper.pageImageReferer();
  if (referer && provider.id !== "mangadex") h.Referer = referer;
  if (provider.id === "webtoon") h.Origin = "https://www.webtoons.com";
  return h;
}

const MAX_REDIRECTS = 3;

/**
 * Fetch a provider page image. Redirects are followed manually, at most
 * MAX_REDIRECTS hops, and only while every hop is still one of the provider's
 * declared page image hosts and resolves to a public address (a CDN moving
 * from an old to a new domain is the case this exists for).
 */
export async function fetchPageImage(
  provider: Provider,
  url: URL,
  init: { headers: Record<string, string>; signal?: AbortSignal; checkDestination: (u: string) => Promise<void> },
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await guardedFetch(current, { redirect: "manual", headers: init.headers, signal: init.signal });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!location || hop >= MAX_REDIRECTS) return new Response(null, { status: 502 });
    let next: URL | null;
    try {
      next = provider.scraper.allowPageImage(new URL(location, current));
    } catch {
      next = null;
    }
    if (!next) return new Response(null, { status: 502 });
    try {
      await init.checkDestination(next.toString());
    } catch {
      // A redirect into a private network is refused like any other bad hop.
      return new Response(null, { status: 502 });
    }
    current = next;
  }
}

/** Image type from magic bytes (JPEG, PNG, GIF, WebP, AVIF), or undefined. */
export function sniffImageType(b: Uint8Array): string | undefined {
  if (b.length < 12) return undefined;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return undefined;
}

/** Generic binary labels some page CDNs use for real images; the bytes decide. */
export const isGenericBinaryType = (t: string) => /^(application|binary)\/octet-stream\b/i.test(t);
