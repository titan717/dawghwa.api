import { BaseScraper } from "@/lib/scrapers/base";
import type { ImageRule } from "@/lib/scrapers/pages/policy";
import { Provider } from "@/lib/providers/provider";
import type { ChapterPage, ScrapedChapter, SearchResult } from "@/types";
import fixture from "../fixtures/gate/synthetic-provider.json";

export const BASE = `https://${fixture.hosts[0]}`;
export const IMG = fixture.imageHosts[0]!;

/** A synthetic adapter that talks JSON to the synthetic host through the shared HTTP layer. */
export class SyntheticScraper extends BaseScraper {
  constructor(private readonly opts: { referer?: boolean } = {}) {
    super();
  }
  getName() {
    return "Synthetic Reader";
  }
  getBaseUrl() {
    return BASE;
  }
  canHandle(url: string) {
    return url.startsWith(BASE);
  }
  async extractMangaInfo(url: string) {
    return { title: url, id: url };
  }
  private async json<T>(url: string): Promise<T> {
    const res = await this.http(url, this.opts.referer ? { headers: { Referer: `${BASE}/` } } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  async search(q: string): Promise<SearchResult[]> {
    const rows = await this.json<{ ref: string; title: string }[]>(`${BASE}/search?q=${encodeURIComponent(q)}`);
    return rows.map((r) => ({ id: r.ref, title: r.title, url: r.ref, latestChapter: 0, lastUpdated: "" }));
  }
  async getChapterList(url: string): Promise<ScrapedChapter[]> {
    const rows = await this.json<{ n: number; ref: string; lang: string | null }[]>(url);
    return rows.map((r) => ({ id: `c${r.n}`, number: r.n, url: r.ref, ...(r.lang ? { language: r.lang } : {}) }));
  }
  async getChapterPages(ref: { chapterId?: string; url?: string }): Promise<ChapterPage[]> {
    const urls = await this.json<string[]>(ref.url!);
    return urls.map((u, index) => ({ index, url: u }));
  }
  pageImageRules(): ImageRule[] {
    return [{ host: IMG }];
  }
}

export function syntheticProvider(opts: { referer?: boolean } = {}): Provider {
  return new Provider(
    {
      id: "synthetic-reader",
      name: "Synthetic Reader",
      baseUrl: BASE,
      description: "synthetic test provider",
      type: "scanlator",
      status: "active",
      priority: 1,
      aliases: [],
      domains: [fixture.hosts[0]!],
      rateLimit: { rps: 100, burst: 100, maxConcurrent: 4, maxQueue: 100 },
    },
    new SyntheticScraper(opts),
  );
}

/** Serves the fixture as JSON for the synthetic scraper (search, chapter lists, page lists). */
export function syntheticJson(url: URL): Response | null {
  if (url.hostname !== fixture.hosts[0]) return null;
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
  if (url.pathname === "/search") return json((fixture.search as Record<string, unknown>)[url.searchParams.get("q") ?? ""] ?? []);
  const key = url.toString();
  if (key in fixture.chapters) return json((fixture.chapters as Record<string, unknown>)[key]);
  if (key in fixture.pages) return json((fixture.pages as Record<string, unknown>)[key]);
  return null;
}
