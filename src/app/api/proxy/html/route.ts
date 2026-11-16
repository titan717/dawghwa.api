import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { upstreamFetch } from "@/lib/core/http";
import { assertPublicDestination } from "@/lib/core/net-guard";
import { getRegistry } from "@/lib/providers/registry";
import type { Provider } from "@/lib/providers/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

/**
 * Allowed proxy destinations: exactly the domains of sources that upstream
 * marks client-only (AsuraScan, WeebCentral). Nothing else is reachable.
 */
function proxyProviders(): Provider[] {
  return getRegistry()
    .all()
    .filter((p) => p.capabilities.clientOnly && p.operational);
}

function validateTarget(raw: string): { url: URL; provider: Provider } {
  if (raw.length > 2048) throw new DawghwaError("VALIDATION_ERROR", "url is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DawghwaError("VALIDATION_ERROR", "url must be an absolute https URL");
  }
  if (url.protocol !== "https:") throw new DawghwaError("PROXY_FORBIDDEN", "Only https URLs can be proxied");
  if (url.username || url.password) throw new DawghwaError("PROXY_FORBIDDEN", "Credentials in URLs are not allowed");
  if (url.port && url.port !== "443") throw new DawghwaError("PROXY_FORBIDDEN", "Custom ports are not allowed");
  const provider = proxyProviders().find((p) => p.ownsUrl(url));
  if (!provider) {
    throw new DawghwaError("PROXY_FORBIDDEN", "Destination host is not on the proxy allowlist", {
      details: { allowedDomains: proxyProviders().flatMap((p) => p.descriptor.domains) },
    });
  }
  return { url, provider };
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/**
 * GET /api/proxy/html?url=<https url on an allowlisted host>
 *
 * Fetches HTML for client-only sources. Hardened against SSRF: exact host
 * allowlist (upstream used an unanchored regex, so
 * `https://evil.example/?u=https://weebcentral.com` passed), https only,
 * DNS/IP checks, manual redirect handling with every hop re-validated, size
 * and time limits, no client headers or cookies forwarded, and the returned
 * HTML is sandboxed by CSP so it can never run scripts on the API origin.
 */
export const GET = route(async (req, ctx) => {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) throw new DawghwaError("VALIDATION_ERROR", "Missing URL parameter");

  let { url, provider } = validateTarget(raw);
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicDestination(url.toString());
    const current = url;
    const { value } = await provider.run(
      "chapters",
      () =>
        upstreamFetch(current.toString(), {
          redirect: "manual",
          headers: {
            Referer: `${current.protocol}//${current.host}/`,
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          },
        }),
      { timeoutMs: 15_000 },
    );
    res = value;
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === MAX_REDIRECTS) throw new DawghwaError("UPSTREAM_ERROR", "Too many redirects");
      ({ url, provider } = validateTarget(new URL(res.headers.get("location")!, current).toString()));
      continue;
    }
    break;
  }
  if (!res) throw new DawghwaError("UPSTREAM_ERROR", "No response from upstream");

  if (!res.ok) {
    throw new DawghwaError("UPSTREAM_HTTP_ERROR", `Failed to fetch HTML: upstream responded with HTTP ${res.status}`, {
      details: { upstreamStatus: res.status },
    });
  }
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type && !type.includes("text/html") && !type.includes("application/xhtml")) {
    throw new DawghwaError("PROXY_FORBIDDEN", "Upstream content is not HTML");
  }
  const html = await res.text();
  if (html.length > MAX_HTML_BYTES) throw new DawghwaError("UPSTREAM_RESPONSE_TOO_LARGE", "Upstream page is too large");

  const out = new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      // Never let proxied third-party HTML execute on our origin.
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline' *",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
      ...corsHeaders(),
    },
  });
  ctx.headers.forEach((v, k) => out.headers.set(k, v));
  return out;
});

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
