/**
 * Gate 6 quality run: for each fixed title, search, match, list chapters,
 * load one chapter's page list and every page image through the polite
 * fetcher. Pages are judged by their bytes (sniffImageType; SVG and anything
 * unknown is refused), exactly as the v2 image relay does, never by the
 * content-type header. The 5 percent and language checks happen in gates.ts.
 */

import { bestTitleScore } from "@/lib/metadata/match";
import { sniffImageType } from "@/lib/services/page-image";
import { BlockedError, type PoliteFetcher } from "./polite";
import type { ProviderAdapter, QualityTitle, TitleOutcome } from "./types";

const MAX_PAGE_BYTES = 15 * 1024 * 1024;

export interface QualityOptions {
  minScore: number;
  exclusions?: string[];
  now?: () => number;
  /** Stop the whole run at the first BlockedError (default true). */
  stopOnBlock?: boolean;
}

export async function loadPage(fetcher: PoliteFetcher, url: string): Promise<string | null> {
  const res = await fetcher.get(url, { headers: { accept: "image/avif,image/webp,image/*" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return `HTTP ${res.status}`;
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return "too large";
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_PAGE_BYTES) return "too large";
  return sniffImageType(bytes) ? null : "not an image";
}

export async function runQuality(
  adapter: ProviderAdapter,
  fetcher: PoliteFetcher,
  titles: QualityTitle[],
  opts: QualityOptions,
): Promise<{ outcomes: TitleOutcome[]; stopped?: BlockedError }> {
  const now = opts.now ?? Date.now;
  const excluded = new Set((opts.exclusions ?? []).map((t) => t.toLowerCase()));
  const outcomes: TitleOutcome[] = [];
  for (const t of titles) {
    const latched = [...fetcher.blocked.values()][0];
    if (latched && opts.stopOnBlock !== false) return { outcomes, stopped: latched };
    const o: TitleOutcome = { title: t.name, kind: t.kind, matchScore: null, strongRefs: 0, chapters: null, languages: [] };
    outcomes.push(o);
    if (excluded.has(t.name.toLowerCase())) {
      o.excluded = true;
      continue;
    }
    try {
      const names = [t.name, ...(t.altNames ?? [])];
      const results = await adapter.search(t.name);
      const scored = results.map((x) => ({ ...x, s: bestTitleScore(x.title, names).score })).sort((a, b) => b.s - a.s);
      const best = scored[0];
      o.strongRefs = new Set(scored.filter((x) => x.s >= opts.minScore).map((x) => x.ref)).size;
      if (!best) continue;
      o.matchScore = Math.round(best.s * 1000) / 1000;
      o.matchedTitle = best.title;
      o.ref = best.ref;
      if (best.s < opts.minScore) continue;
      const chapters = await adapter.chapters(best.ref);
      o.chapters = chapters.length;
      o.languages = [...new Set(chapters.map((c) => c.lang).filter((l): l is string => Boolean(l)))];
      const first = [...chapters].sort((a, b) => a.n - b.n)[0];
      if (!first) continue;
      const started = now();
      const waited = fetcher.waitedMs;
      const pages = await adapter.pages(first.ref, first.n);
      // Latency of the page list itself: our own pacing waits are not the site's latency.
      o.pageList = { pages: pages.length, ms: Math.max(0, now() - started - (fetcher.waitedMs - waited)) };
      o.pagesLoaded = 0;
      o.pageFailures = [];
      for (const [i, url] of pages.entries()) {
        if (adapter.allowPage && !adapter.allowPage(url)) {
          o.pageFailures.push(`page ${i}: host not declared for the relay`);
          continue;
        }
        const problem = await loadPage(fetcher, url);
        if (problem) o.pageFailures.push(`page ${i}: ${problem}`);
        else o.pagesLoaded++;
      }
    } catch (e) {
      // Adapters call through core/http, which wraps errors: the fetcher's latch is the source of truth.
      const blocked = e instanceof BlockedError ? e : [...fetcher.blocked.values()][0];
      if (blocked && opts.stopOnBlock !== false) {
        o.error = `blocked: ${blocked.reason}`;
        return { outcomes, stopped: blocked };
      }
      o.error = (e as Error).message?.slice(0, 160) || "error";
    }
  }
  return { outcomes };
}
