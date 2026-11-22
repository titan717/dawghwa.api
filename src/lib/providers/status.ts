import { SHUTDOWN_SOURCE_IDS } from "@/lib/shutdown-sources";
import type { ProviderRateLimit } from "@/lib/core/rate-limiter";

/**
 * Curated source status manifest.
 *
 *  active   - believed operational; included in "all" searches
 *  unstable - intermittently failing upstream (often anti-bot protection);
 *             still searched, results may be missing
 *  shutdown - site is gone or the adapter no longer works; never called,
 *             direct requests return SOURCE_UNAVAILABLE instead of fake data
 *
 * Seeded from the last upstream health table (GooglyBlox/comick-source-api
 * README @ 086d006). Live status is measured separately by /api/health and
 * by `npm run health:report` (docs/SOURCE_STATUS.md).
 */
export type ProviderStatus = "active" | "unstable" | "shutdown";

export const UNSTABLE_SOURCE_IDS: ReadonlySet<string> = new Set([
  "arya-scans",
  "atsumoe",
  "comix",
  "diva-scans",
  "greed-scans",
  "kdt-scans",
  "mangacloud",
  "manhuaus",
  "philia-scans",
  "qi-scans",
  "rage-scans",
  "raven-scans",
  "temple-scan",
]);

export const STATUS_NOTES: Record<string, string> = {
  "arven-comics": "Site shut down (upstream)",
  bato: "Adapter no longer works (upstream)",
  "falcon-scans": "Site shut down (upstream)",
  firescans: "Site shut down (upstream); HTTP 502 when probed 2026-11-16",
  "hades-scans": "Site shut down (upstream)",
  kaliscan: "Domain no longer resolves (probed 2026-11-16)",
  likemanga: "Site shut down (upstream); HTTP 502 when probed 2026-11-16",
  mangaloom: "Domain no longer resolves (probed 2026-11-16)",
  mangapark: "Site shut down (upstream); HTTP 502 when probed 2026-11-16",
  mangayy: "Domain no longer resolves (probed 2026-11-16)",
  utoon: "Site shut down (upstream)",
  weebdex: "Domain no longer resolves (probed 2026-11-16)",
  witchscans: "Site shut down (upstream); HTTP 502 when probed 2026-11-16",
  "yaksha-scans": "Site shut down (upstream)",
};

/**
 * Experimental sources: excluded from the registry (sources, search,
 * availability, catalog, frontpage, health) unless listed in
 * EXPERIMENTAL_PROVIDERS. Off by default; enabling one for users is a human
 * decision.
 *
 *  comix - blocked: comix.to and comix.ws serve a Cloudflare 403 block page to
 *          automated clients and no terms could be read (2026-11-22, see
 *          docs/providers/comix-study.md).
 */
export const EXPERIMENTAL_SOURCE_IDS: ReadonlySet<string> = new Set(["comix"]);

/** Additional ids accepted for a source (backwards compatible spellings). */
export const SOURCE_ALIASES: Record<string, string[]> = {
  "writers'-scans": ["writers-scans", "writerscans"],
  "danke-furs-lesen": ["danke", "danke-fürs-lesen"],
  "kdt-scans": ["silentquill"],
  "temple-scan": ["templetoons"],
};

/** Higher runs first in "all" searches and wins ties in source auto-detection. */
export const DEFAULT_PRIORITIES: Record<string, number> = {
  mangadex: 100,
  weebcentral: 90,
  asurascan: 85,
  flamecomics: 80,
  webtoon: 80,
  mangakatana: 70,
  comix: 70,
  "dynasty-reader": 60,
};

/**
 * Provider-level outbound rate limits. MangaDex documents a global limit of
 * ~5 requests/second per client; everyone else uses the configurable default.
 */
export const RATE_LIMITS: Record<string, Partial<ProviderRateLimit>> = {
  mangadex: { rps: 4, burst: 5, maxConcurrent: 4 },
  webtoon: { rps: 3, burst: 5, maxConcurrent: 3 },
};

export function statusFor(id: string): ProviderStatus {
  if (SHUTDOWN_SOURCE_IDS.has(id)) return "shutdown";
  if (UNSTABLE_SOURCE_IDS.has(id)) return "unstable";
  return "active";
}
