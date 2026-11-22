import { NextResponse } from "next/server";
import { json, route, type ApiContext } from "@/lib/api/handler";
import { resolveChapter, V2Error } from "@/lib/v2/chapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

function fail(status: number, ctx: ApiContext, message = "Chapter unavailable", retryAfter?: number): NextResponse {
  const res = NextResponse.json({ error: message }, { status });
  ctx.headers.forEach((v, k) => res.headers.set(k, v));
  res.headers.set("Cache-Control", "no-store");
  if (retryAfter !== undefined) res.headers.set("Retry-After", String(retryAfter));
  return res;
}

/**
 * GET /api/v2/chapter?title=<canonicalTitleId>&n=<chapterNumber>&lang=<lang>[&alt=<k>]
 *
 * One canonical chapter, served from the first working version with
 * automatic fallback. The body never names a provider; every failure is
 * {"error":"Chapter unavailable"}. Contract: docs/API_V2.md.
 */
export const GET = route(async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const title = sp.get("title") ?? "";
  const n = sp.get("n") ?? "";
  const lang = sp.get("lang") || "en";
  const altRaw = sp.get("alt");
  if (!title || !n || n.length > 16 || !LANG_RE.test(lang)) return fail(400, ctx);
  let alt: number | undefined;
  if (altRaw !== null && altRaw !== "") {
    if (!/^\d{1,2}$/.test(altRaw)) return fail(400, ctx);
    alt = Number(altRaw);
  }
  try {
    const body = await resolveChapter({ title, n, lang, alt }, { origin: req.nextUrl.origin, signal: req.signal });
    return json(body, ctx);
  } catch (e) {
    if (e instanceof V2Error) return fail(e.status === 499 ? 400 : e.status, ctx, e.publicMessage, e.retryAfter);
    return fail(502, ctx);
  }
});
