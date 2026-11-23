/**
 * Gate an existing registered Provider: a ProviderAdapter over its scraper,
 * and a scope in which every outbound adapter request goes through the polite
 * fetcher (paced, honest, stoppable) while keeping the SSRF guard: core/http
 * still runs assertPublicDestination on every hop, the fetcher runs it again,
 * and its default inner fetch uses the guarded dispatcher.
 */

import { getGuardedFetchImpl, setGuardedFetchImpl } from "@/lib/core/net-guard";
import type { Provider } from "@/lib/providers/provider";
import { getChapterPages } from "@/lib/services/catalog";
import { providerFlagName } from "./flags";
import type { PoliteFetcher } from "./polite";
import type { ProviderAdapter } from "./types";

export function imageHostsOf(p: Provider): string[] {
  const hosts = new Set<string>();
  for (const rule of p.scraper.pageImageRules()) {
    hosts.add(rule.host.toLowerCase());
    rule.proxiedHosts?.forEach((h) => hosts.add(h.toLowerCase()));
  }
  return [...hosts];
}

export function adapterFromProvider(p: Provider, opts: { offlineAllowed: boolean; paths?: string[]; hosts?: string[] }): ProviderAdapter {
  const ids = new Map<string, string>();
  return {
    id: p.id,
    flag: providerFlagName(p.id),
    offlineAllowed: opts.offlineAllowed,
    hosts: opts.hosts ?? [...p.descriptor.domains],
    imageHosts: imageHostsOf(p),
    paths: opts.paths ?? [],
    async search(q) {
      const { value } = await p.run("search", () => p.scraper.search(q));
      return value.map((r) => ({ ref: r.url, title: r.title }));
    },
    async chapters(ref) {
      const { value } = await p.run("chapters", () => p.scraper.getChapterList(ref));
      return value.map((c) => {
        ids.set(c.url, c.id);
        return { n: c.number, ref: c.url, lang: c.language ?? null };
      });
    },
    async pages(ref) {
      const { pages } = await getChapterPages(p, { url: ref, chapterId: ids.get(ref) });
      return pages.map((x) => x.url);
    },
    allowPage: (url) => p.scraper.allowPageImage(url) !== null,
  };
}

/** Run fn with the polite fetcher installed for every guarded request; always restores the previous one. */
export async function withPoliteFetcher<T>(fetcher: PoliteFetcher, fn: () => Promise<T>): Promise<T> {
  const previous = getGuardedFetchImpl();
  setGuardedFetchImpl(fetcher.fetchHop);
  try {
    return await fn();
  } finally {
    setGuardedFetchImpl(previous);
  }
}
