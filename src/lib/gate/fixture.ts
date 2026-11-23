/**
 * A recorded-fixture provider for tests and `gate:provider --dry-run`.
 * Every name, host and title in the fixture files is synthetic: no real
 * provider data, markup or assets.
 */

import type { FetchImpl } from "./polite";
import type { ProviderAdapter, QualityTitle, TermsReview } from "./types";

export interface FixtureProvider {
  id: string;
  hosts: string[];
  imageHosts: string[];
  paths: string[];
  robots: { status: number; body?: string; headers?: Record<string, string> };
  review: TermsReview;
  titles: QualityTitle[];
  search: Record<string, { ref: string; title: string }[]>;
  chapters: Record<string, { n: number; ref: string; lang: string | null }[]>;
  pages: Record<string, string[]>;
  /** Per-URL overrides for the recorded responses (status, headers, body kind). */
  responses?: Record<string, { status: number; headers?: Record<string, string>; body?: "png" | "svg" | "html" | string }>;
}

/** Smallest bytes sniffImageType accepts as PNG (signature + IHDR start). */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';

/** A fetch that answers from the fixture: robots.txt, then page images. */
export function fixtureInner(f: FixtureProvider): FetchImpl {
  return async (input) => {
    const url = new URL(input.toString());
    const o = f.responses?.[url.toString()];
    if (o) {
      const body = o.body === "png" || o.body === undefined ? PNG_BYTES : o.body === "svg" ? SVG : o.body;
      return new Response(o.status === 204 || o.status === 304 ? null : body, { status: o.status, headers: o.headers });
    }
    if (url.pathname === "/robots.txt" && f.hosts.includes(url.hostname)) {
      return new Response(f.robots.status === 404 ? "" : (f.robots.body ?? ""), {
        status: f.robots.status,
        headers: { "content-type": "text/plain", ...f.robots.headers },
      });
    }
    if (f.imageHosts.includes(url.hostname)) {
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=86400" } });
    }
    if (f.hosts.includes(url.hostname)) {
      return new Response("{}", { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=300", etag: '"fx"' } });
    }
    return new Response("not found", { status: 404 });
  };
}

/** Adapter answering search, chapters and pages from the fixture. Its own data calls are counted as requests by the caller. */
export function fixtureAdapter(f: FixtureProvider, opts: { offlineAllowed?: boolean; request?: (url: string) => Promise<unknown> } = {}): ProviderAdapter {
  // Simulates the adapter's own upstream request for each call (through the polite fetcher when given).
  const call = async (url: string) => {
    await opts.request?.(url);
  };
  return {
    id: f.id,
    flag: `PROVIDER_${f.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
    offlineAllowed: opts.offlineAllowed ?? false,
    hosts: f.hosts,
    imageHosts: f.imageHosts,
    paths: f.paths,
    async search(q) {
      await call(`https://${f.hosts[0]}/search?q=${encodeURIComponent(q)}`);
      return f.search[q] ?? [];
    },
    async chapters(ref) {
      await call(ref);
      return f.chapters[ref] ?? [];
    },
    async pages(ref) {
      await call(ref);
      return f.pages[ref] ?? [];
    },
    allowPage: (u) => {
      try {
        return f.imageHosts.includes(new URL(u).hostname);
      } catch {
        return false;
      }
    },
  };
}
