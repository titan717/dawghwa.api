import { NextRequest } from "next/server";
import { clientIdFor } from "@/lib/api/handler";
import { deliverImage, takeImageRate } from "@/lib/v2/image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Pacing wait (up to 20 s) + upstream timeout (12 s) must fit inside the function budget. */
export const maxDuration = 60;

function fail(status: number, retryAfter?: number): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);
  return Response.json({ error: status === 429 ? "Too many requests" : "Image unavailable" }, { status, headers });
}

/**
 * GET /api/v2/img/<token>
 *
 * Opaque, short-lived page image URL issued by /api/v2/chapter when
 * IMAGE_PROXY is enabled. 404 when the proxy is off or the token is invalid,
 * 410 when it expired (re-request the chapter), 429 when the client exceeds
 * IMAGE_PROXY_RATE_PER_MINUTE. Contract: docs/API_V2.md.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }): Promise<Response> {
  const rate = takeImageRate(clientIdFor(req));
  if (!rate.allowed) return fail(429, rate.retryAfter);
  const r = await deliverImage(params.token);
  if (!r.ok) return fail(r.status, r.retryAfter);
  const body = r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": r.type,
      "Content-Length": String(r.body.byteLength),
      "Cache-Control": `public, max-age=${r.maxAge}, s-maxage=${r.maxAge}, immutable`,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
