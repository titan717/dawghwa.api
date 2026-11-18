/**
 * Cover image relay for MangaDex.
 *
 * uploads.mangadex.org now answers browser-like requests (a browser
 * User-Agent) with a bot challenge, so `<img>` tags pointing at it fail in
 * real browsers. The API fetches the cover with its own identifying
 * User-Agent and serves the bytes, cacheable at the CDN.
 *
 * Only `https://uploads.mangadex.org/covers/<uuid>/<file>` is accepted, so
 * this cannot be used as a general proxy.
 */

export const COVER_HOST = "uploads.mangadex.org";
const COVER_PATH = /^\/covers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[\w-]+\.(?:jpe?g|png|webp|gif)(?:\.(?:256|512)\.jpg)?$/i;
export const COVER_MAX_BYTES = 5 * 1024 * 1024;
export const COVER_USER_AGENT = "Dawghwa/1.1 (+https://dawghwa.vercel.app)";

/** Returns the normalised upstream URL, or null if it is not an allowed cover URL. */
export function parseCoverUrl(raw: string | null): URL | null {
  if (!raw || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== COVER_HOST) return null;
  if (url.username || url.password || (url.port && url.port !== "443")) return null;
  if (url.search || url.hash) return null;
  if (!COVER_PATH.test(url.pathname)) return null;
  return new URL(`https://${COVER_HOST}${url.pathname}`);
}


/**
 * MangaDex chapter page URLs use the provider's documented @Home image paths.
 * Restrict the relay to those paths and provider-owned CDN hosts; never accept
 * arbitrary URLs or forward caller cookies/headers.
 */
const PAGE_HOST = /^(?:uploads\.mangadex\.org|s[0-9]+\.mangadex\.org|(?:[a-z0-9-]+\.)+mangadex\.network)$/i;
const PAGE_PATH = /^\/(?:[a-z0-9_-]+\/)*(?:data|data-saver)\/[a-z0-9_-]{16,128}\/[a-z0-9_.-]{1,128}\.(?:jpe?g|png|webp|gif)$/i;
export const PAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Returns a normalized MangaDex chapter image URL, or null for any other host/path. */
export function parseMangaDexPageUrl(raw: string | null): URL | null {
  if (!raw || raw.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !PAGE_HOST.test(url.hostname)) return null;
  if (url.username || url.password || (url.port && url.port !== "443")) return null;
  if (url.search || url.hash || url.pathname.split("/").includes("..") || !PAGE_PATH.test(url.pathname)) return null;
  return new URL(`https://${url.hostname.toLowerCase()}${url.pathname}`);
}


/** Fire-and-forget @Home network telemetry required by MangaDex for node-hosted pages. */
export function reportMangaDexAtHome(
  url: URL,
  result: { success: boolean; bytes: number; duration: number; cached: boolean },
): void {
  if (!url.hostname.toLowerCase().endsWith(".mangadex.network")) return;
  void fetch("https://api.mangadex.network/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.toString(), ...result }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Reporting must never delay or fail image delivery.
  });
}


const WEBTOON_PAGE_HOSTS = new Set(["webtoon-phinf.pstatic.net", "swebtoon-phinf.pstatic.net"]);
const WEBTOON_PAGE_PATH = /^\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:jpe?g|png|webp|gif)$/i;

/** Returns a normalized public WEBTOON panel URL, or null for any other URL. */
export function parseWebtoonPageUrl(raw: string | null): URL | null {
  if (!raw || raw.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !WEBTOON_PAGE_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || (url.port && url.port !== "443") || url.hash) return null;
  if (url.pathname.split("/").includes("..") || !WEBTOON_PAGE_PATH.test(url.pathname)) return null;
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key, value]) => key !== "type" || !/^q[0-9]{2,3}$/.test(value))) return null;
  return new URL(url.toString());
}
