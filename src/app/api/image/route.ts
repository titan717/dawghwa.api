import { NextRequest } from "next/server";
import { COVER_MAX_BYTES, COVER_USER_AGENT, parseCoverUrl } from "@/lib/services/cover-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/image?url=https://uploads.mangadex.org/covers/<uuid>/<file>
 *
 * Relays a MangaDex cover. Cover file names are content-addressed, so the
 * response is cached for a long time at the CDN and in the browser. No client
 * headers or cookies are forwarded, redirects are not followed, and only image
 * responses up to 5 MB are passed through.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const url = parseCoverUrl(req.nextUrl.searchParams.get("url"));
  if (!url) return fail(400, "url must be a MangaDex cover URL", "VALIDATION_ERROR");

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": COVER_USER_AGENT, Accept: "image/avif,image/webp,image/*;q=0.8" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail(504, "Cover image timed out", "UPSTREAM_TIMEOUT");
  }
  const type = upstream.headers.get("content-type") ?? "";
  if (upstream.status !== 200 || !type.startsWith("image/")) {
    await upstream.body?.cancel().catch(() => {});
    return fail(upstream.status === 404 ? 404 : 502, "Cover image unavailable", "UPSTREAM_ERROR");
  }
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) {
    await upstream.body?.cancel().catch(() => {});
    return fail(502, "Cover image too large", "UPSTREAM_TOO_LARGE");
  }
  const body = await upstream.arrayBuffer();
  if (body.byteLength > COVER_MAX_BYTES) return fail(502, "Cover image too large", "UPSTREAM_TOO_LARGE");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
