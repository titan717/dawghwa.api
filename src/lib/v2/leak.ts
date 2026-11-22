import { METADATA_PROVIDER_IDS } from "@/lib/metadata/types";
import { getRegistry } from "@/lib/providers/registry";

/**
 * Every provider-identifying string registered in the codebase: ids, display
 * names, aliases, domains, base-URL hosts and declared page-image hosts of
 * every source adapter, plus the metadata database ids. v2 responses must
 * contain none of them (tested); chapter titles that contain one are dropped.
 */
let cached: string[] | null = null;

/** Image hosts of adapters that validate page URLs with code instead of pageImageRules(). */
const CODE_VALIDATED_IMAGE_HOSTS = ["pstatic.net", "mangadex.network", "uploads.mangadex.org", "dynasty-scans.com"];

export function providerTerms(): string[] {
  if (cached) return cached;
  const terms = new Set<string>();
  const add = (s: string | undefined) => {
    const t = s?.trim().toLowerCase();
    if (t && t.length >= 3) terms.add(t);
  };
  for (const p of getRegistry().all()) {
    add(p.id);
    add(p.name);
    p.descriptor.aliases.forEach(add);
    p.descriptor.domains.forEach(add);
    try {
      add(new URL(p.descriptor.baseUrl).hostname.replace(/^www\./, ""));
    } catch {
      /* no base URL */
    }
    for (const rule of p.scraper.pageImageRules()) {
      add(rule.host);
      rule.proxiedHosts?.forEach(add);
    }
  }
  CODE_VALIDATED_IMAGE_HOSTS.forEach(add);
  METADATA_PROVIDER_IDS.forEach(add);
  cached = [...terms].sort((a, b) => b.length - a.length);
  return cached;
}

/** The first provider term found in `text` (case-insensitive), if any. */
export function findProviderTerm(text: string): string | undefined {
  const lower = text.toLowerCase();
  return providerTerms().find((t) => lower.includes(t));
}

/** Chapter titles are shown to users: drop any that names a provider. */
export function scrubText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return findProviderTerm(text) ? undefined : text;
}
