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
