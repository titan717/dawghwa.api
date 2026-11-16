/**
 * Backwards-compatible health utilities (upstream module path).
 *
 * The implementation now lives in `@/lib/services/health` (provider-aware,
 * breaker-integrated) and `@/lib/core/antibot` (stricter challenge detection).
 */
import { BaseScraper } from "@/lib/scrapers/base";
import { detectChallenge } from "@/lib/core/antibot";
import { getRegistry } from "@/lib/providers/registry";
import { probeAll, probeProvider, SourceHealthResult, SourceStatus } from "@/lib/services/health";

export { SourceStatus };
export type { SourceHealthResult };

/** Detects if a response is an anti-bot (Cloudflare etc.) challenge page. */
export function detectCloudflare(html: string, headers?: Headers): boolean {
  return detectChallenge(html, headers).blocked;
}

function providerFor(scraper: BaseScraper) {
  const provider = getRegistry().get(scraper.getId());
  if (!provider) throw new Error(`Scraper ${scraper.getName()} is not registered`);
  return provider;
}

/** Test if a source is healthy by attempting a search. */
export async function checkSourceHealth(
  scraper: BaseScraper,
  testQueries: string | string[] = ["the", "a"],
): Promise<SourceHealthResult> {
  const queries = Array.isArray(testQueries) ? testQueries : [testQueries];
  return probeProvider(providerFor(scraper), undefined, queries);
}

/** Check health of all given sources (bounded concurrency + overall deadline). */
export async function checkAllSourcesHealth(scrapers: BaseScraper[]): Promise<Map<string, SourceHealthResult>> {
  const results = await probeAll(scrapers.map(providerFor));
  return new Map(Object.entries(results));
}
