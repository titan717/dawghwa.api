/**
 * Page image allowlists.
 *
 * /api/image relays chapter page bytes only for URLs that the owning adapter
 * declares as its page image hosts. Rules are exact hosts (optionally with
 * subdomains), may pin a path prefix (shared CDNs such as i0.wp.com are only
 * allowed for the provider's own path), and may pin the target of a resizing
 * proxy (wsrv.nl?url=<provider cdn>). Anything else is rejected, so the relay
 * can never be used as a general-purpose proxy.
 */

export interface ImageRule {
  host: string;
  /** Also allow any subdomain of `host`. */
  subdomains?: boolean;
  /** Path must start with this prefix. */
  pathPrefix?: string;
  /** For image proxies: the `url` query parameter must point at one of these hosts. */
  proxiedHosts?: string[];
}

const normHost = (h: string) => h.toLowerCase().replace(/\.$/, "");

function hostMatches(host: string, rule: { host: string; subdomains?: boolean }): boolean {
  const h = normHost(host);
  const r = normHost(rule.host);
  return h === r || (Boolean(rule.subdomains) && h.endsWith(`.${r}`));
}

export function matchesImageRules(url: URL, rules: readonly ImageRule[]): boolean {
  // page images are relayed over HTTPS on the default port only
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  return rules.some((rule) => {
    if (!hostMatches(url.hostname, rule)) return false;
    if (rule.pathPrefix && !url.pathname.startsWith(rule.pathPrefix)) return false;
    if (rule.proxiedHosts) {
      const inner = url.searchParams.get("url");
      if (!inner) return false;
      let target: URL;
      try {
        target = new URL(/^https?:\/\//i.test(inner) ? inner : `https://${inner}`);
      } catch {
        return false;
      }
      if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")) return false;
      return rule.proxiedHosts.some((h) => hostMatches(target.hostname, { host: h }));
    }
    return true;
  });
}

/** Shorthand: a host and all its subdomains. */
export const anySub = (host: string): ImageRule => ({ host, subdomains: true });
/** WordPress Photon CDN (i0/i1/i2/i3.wp.com) limited to a provider's own path. */
export const photon = (siteHost: string): ImageRule[] =>
  ["i0.wp.com", "i1.wp.com", "i2.wp.com", "i3.wp.com"].map((host) => ({ host, pathPrefix: `/${siteHost}/` }));
