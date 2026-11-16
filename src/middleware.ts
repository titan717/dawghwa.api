import { NextRequest, NextResponse } from "next/server";

/**
 * Edge middleware: CORS, preflight handling and an early request-size check.
 * Security headers are set in next.config.mjs for every route.
 */

const MAX_BODY = Number(process.env.API_MAX_BODY_BYTES || 16 * 1024);
const ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function allowOrigin(origin: string | null): string | null {
  if (ORIGINS.includes("*")) return "*";
  if (origin && ORIGINS.includes(origin)) return origin;
  return null;
}

function corsHeaders(req: NextRequest): Headers {
  const h = new Headers();
  const origin = allowOrigin(req.headers.get("origin"));
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    if (origin !== "*") h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, X-Request-Id");
    h.set("Access-Control-Expose-Headers", "X-Request-Id, X-Dawghwa-Version, RateLimit-Limit, RateLimit-Remaining, RateLimit-Policy, Retry-After");
    h.set("Access-Control-Max-Age", "86400");
  }
  return h;
}

export function middleware(req: NextRequest) {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: cors });
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    const res = NextResponse.json(
      { error: `Request body must be at most ${MAX_BODY} bytes`, code: "PAYLOAD_TOO_LARGE" },
      { status: 413 },
    );
    cors.forEach((v, k) => res.headers.set(k, v));
    return res;
  }
  const res = NextResponse.next();
  cors.forEach((v, k) => res.headers.set(k, v));
  return res;
}

export const config = { matcher: "/api/:path*" };
