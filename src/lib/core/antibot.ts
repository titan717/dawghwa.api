/**
 * Anti-bot / challenge page detection.
 *
 * Upstream matched /cloudflare/i anywhere in the HTML, which flags every normal
 * page that loads a script from cdnjs.cloudflare.com. These patterns only match
 * actual interstitial / challenge pages. Dawghwa never tries to solve or bypass
 * these challenges: a challenged source is reported as UPSTREAM_BLOCKED.
 */
const CHALLENGE_PATTERNS: RegExp[] = [
  /<title>\s*just a moment\.{0,3}\s*<\/title>/i,
  /checking your browser before accessing/i,
  /cf-chl-(?:bypass|opt|widget)|cf_chl_opt|__cf_chl_/i,
  /challenge-platform/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /ddos protection by cloudflare/i,
  /enable javascript and cookies to continue/i,
  /ddos-guard/i,
  /<title>\s*(?:access denied|attention required)[^<]*<\/title>/i,
  /captcha-delivery\.com|geo\.captcha-delivery/i, // DataDome
  /sucuri website firewall/i,
];

export type AntiBotVendor = "cloudflare" | "ddos-guard" | "datadome" | "sucuri" | "unknown";

export function detectChallenge(body: string, headers?: Headers): { blocked: boolean; vendor?: AntiBotVendor } {
  if (headers?.get("cf-mitigated")?.toLowerCase() === "challenge") {
    return { blocked: true, vendor: "cloudflare" };
  }
  const sample = body.length > 64_000 ? body.slice(0, 64_000) : body;
  for (const pattern of CHALLENGE_PATTERNS) {
    if (pattern.test(sample)) {
      const vendor: AntiBotVendor = /ddos-guard/i.test(sample)
        ? "ddos-guard"
        : /captcha-delivery/i.test(sample)
          ? "datadome"
          : /sucuri/i.test(sample)
            ? "sucuri"
            : /cloudflare|cf[-_]chl|challenge-platform|just a moment/i.test(sample)
              ? "cloudflare"
              : "unknown";
      return { blocked: true, vendor };
    }
  }
  return { blocked: false };
}
