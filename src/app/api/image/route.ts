import { NextRequest } from "next/server";
import { assertPublicDestination } from "@/lib/core/net-guard";
import {
  COVER_MAX_BYTES,
  COVER_USER_AGENT,
  PAGE_MAX_BYTES,
  parseCoverUrl,
  parseMangaDexPageUrl,
  parseWebtoonPageUrl,
  reportMangaDexAtHome,
} from "@/lib/services/cover-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/image?url=...
 *
 * Relays only validated MangaDex cover and @Home chapter image URLs. No
 * caller-supplied headers/cookies are forwarded and redirects are not followed.
 * This is deliberately not a general-purpose URL proxy.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const raw = req.nextUrl.searchParams.get("url");
  const coverUrl = parseCoverUrl(raw);
  const pageUrl = parseMangaDexPageUrl(raw);
  const webtoonUrl = parseWebtoonPageUrl(raw);
  const url = coverUrl ?? pageUrl ?? webtoonUrl;
  if (!url) return fail(400, "url must be an allowed MangaDex or WEBTOON image URL", "VALIDATION_ERROR");

  const maxBytes = coverUrl ? COVER_MAX_BYTES : PAGE_MAX_BYTES;
  try {
    await assertPublicDestination(url.toString());
  } catch {
    return fail(400, "Image destination is not a public address", "PROXY_FORBIDDEN");
  }
  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": COVER_USER_AGENT,
        Accept: "image/avif,image/webp,image/*;q=0.8",
        ...(webtoonUrl ? { Referer: "https://www.webtoons.com/", Origin: "https://www.webtoons.com" } : {}),
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: 0, duration: Date.now() - started, cached: false });
    return fail(504, "Image request timed out", "UPSTREAM_TIMEOUT");
  }
  const type = upstream.headers.get("content-type") ?? "";
  const cached = (upstream.headers.get("x-cache") ?? "").toUpperCase().startsWith("HIT");
  if (upstream.status !== 200 || !type.toLowerCase().startsWith("image/")) {
    await upstream.body?.cancel().catch(() => {});
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: 0, duration: Date.now() - started, cached });
    return fail(upstream.status === 404 ? 404 : 502, "Image unavailable", "UPSTREAM_ERROR");
  }
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await upstream.body?.cancel().catch(() => {});
    if (pageUrl) reportMangaDexAtHome(url, { success: true, bytes: declared, duration: Date.now() - started, cached });
    return fail(502, "Image too large", "UPSTREAM_TOO_LARGE");
  }
  let body: ArrayBuffer;
  try {
    body = await upstream.arrayBuffer();
  } catch {
    if (pageUrl) reportMangaDexAtHome(url, { success: false, bytes: 0, duration: Date.now() - started, cached });
    return fail(502, "Image unavailable", "UPSTREAM_ERROR");
  }
  if (pageUrl) reportMangaDexAtHome(url, { success: true, bytes: body.byteLength, duration: Date.now() - started, cached });
  if (body.byteLength > maxBytes) return fail(502, "Image too large", "UPSTREAM_TOO_LARGE");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
