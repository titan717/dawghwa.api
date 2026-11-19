import { NextRequest } from "next/server";
import { assertPublicDestination } from "@/lib/core/net-guard";
import {
  COVER_MAX_BYTES,
  COVER_USER_AGENT,
  PAGE_MAX_BYTES,
  parseCoverUrl,
  parseMangaDexPageUrl,
  parseWebtoonPageUrl,
  parseDynastyPageUrl,
  reportMangaDexAtHome,
} from "@/lib/services/cover-image";
import { fetchPageImage, isGenericBinaryType, pageImageHeaders, sniffImageType } from "@/lib/services/page-image";
import type { Provider } from "@/lib/providers/provider";
import { getRegistry } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/image?url=...
 *
 * Relays MangaDex covers and chapter page images. With `source=<id>`, the
 * URL must match that reader-capable provider's declared page image hosts
 * (BaseScraper.pageImageRules); the provider's reader Referer is sent, as its
 * own reader does. No caller-supplied headers/cookies are forwarded, redirects
 * are followed only between that provider's page hosts (max 3 hops), private
 * addresses are refused and only image/* responses
 * are relayed. This is deliberately not a general-purpose URL proxy.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const raw = req.nextUrl.searchParams.get("url");
  const sourceId = req.nextUrl.searchParams.get("source");
  if (raw && raw.length > 2048) return fail(400, "url is too long", "VALIDATION_ERROR");

  let url: URL | null = null;
  let coverUrl: URL | null = null;
  let pageUrl: URL | null = null;
  let pageProvider: Provider | undefined;
  const headers: Record<string, string> = { Accept: "image/avif,image/webp,image/*;q=0.8" };

  if (sourceId) {
    // Chapter page of a reader-capable provider: only that adapter's declared page hosts.
    const provider = getRegistry().get(sourceId);
    if (!provider || !provider.operational || !provider.capabilities.chapterPages) {
      return fail(400, "source is not a reader-capable provider", "VALIDATION_ERROR");
    }
    url = provider.scraper.allowPageImage(raw);
    if (!url) return fail(400, `url is not an allowed ${provider.name} page image`, "VALIDATION_ERROR");
    if (provider.id === "mangadex") pageUrl = url;
    pageProvider = provider;
    Object.assign(headers, pageImageHeaders(provider));
  } else {
    // Legacy URLs (covers and pages issued before per-source relaying).
    coverUrl = parseCoverUrl(raw);
    pageUrl = parseMangaDexPageUrl(raw);
    const webtoonUrl = parseWebtoonPageUrl(raw);
    const dynastyUrl = parseDynastyPageUrl(raw);
    url = coverUrl ?? pageUrl ?? webtoonUrl ?? dynastyUrl;
    if (!url) return fail(400, "url must be an allowed cover or chapter page image URL", "VALIDATION_ERROR");
    headers["User-Agent"] = COVER_USER_AGENT;
    if (webtoonUrl) Object.assign(headers, { Referer: "https://www.webtoons.com/", Origin: "https://www.webtoons.com" });
    if (dynastyUrl) headers.Referer = "https://dynasty-scans.com/";
  }

  const maxBytes = coverUrl ? COVER_MAX_BYTES : PAGE_MAX_BYTES;
  try {
    await assertPublicDestination(url.toString());
  } catch {
    return fail(400, "Image destination is not a public address", "PROXY_FORBIDDEN");
  }
  const started = Date.now();
  let upstream: Response;
  try {
    const signal = AbortSignal.timeout(12_000);
    upstream = pageProvider
      ? await fetchPageImage(pageProvider, url, { headers, signal, checkDestination: assertPublicDestination })
      : await fetch(url, { redirect: "manual", headers, signal });
  } catch {
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: 0, duration: Date.now() - started, cached: false });
    return fail(504, "Image request timed out", "UPSTREAM_TIMEOUT");
  }
  let type = upstream.headers.get("content-type") ?? "";
  // Page CDNs that label images as octet-stream are accepted only if the bytes are an image.
  const sniff = Boolean(pageProvider) && isGenericBinaryType(type);
  const cached = (upstream.headers.get("x-cache") ?? "").toUpperCase().startsWith("HIT");
  if (upstream.status !== 200 || (!sniff && !type.toLowerCase().startsWith("image/"))) {
    await upstream.body?.cancel().catch(() => {});
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: 0, duration: Date.now() - started, cached });
    return fail(upstream.status === 404 ? 404 : 502, "Image unavailable", "UPSTREAM_ERROR");
  }
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel().catch(() => {});
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: declared, duration: Date.now() - started, cached });
    return fail(502, "Image too large", "UPSTREAM_TOO_LARGE");
  }
  if (!upstream.body) {
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: 0, duration: Date.now() - started, cached });
    return fail(502, "Image unavailable", "UPSTREAM_ERROR");
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: total, duration: Date.now() - started, cached });
        return fail(502, "Image too large", "UPSTREAM_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch {
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: total, duration: Date.now() - started, cached });
    return fail(502, "Image unavailable", "UPSTREAM_ERROR");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (sniff) {
    const sniffed = sniffImageType(body);
    if (!sniffed) return fail(502, "Image unavailable", "UPSTREAM_ERROR");
    type = sniffed;
  }
  if (pageUrl) reportMangaDexAtHome(url, { success: true, bytes: total, duration: Date.now() - started, cached });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(total),
      "Cache-Control": "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
