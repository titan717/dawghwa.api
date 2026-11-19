/**
 * Page-list locators for the reader engines used by Dawghwa's providers.
 *
 * Each function receives the provider's public chapter reader HTML and
 * returns the raw page list in reading order, or throws a precise error
 * (locked, protected, format changed). Evidence for every engine is in
 * docs/PAGE_EXTRACTION.md; fixtures in src/tests/fixtures/pages/.
 */
import * as cheerio from "cheerio";
import {
  chapterLocked,
  decodeNextFlight,
  formatChanged,
  jsonValuesAfterKey,
  num,
  pagesNotFound,
  pagesProtected,
  parseJsonAt,
  type RawPage,
} from "./extract";

type Root = ReturnType<typeof cheerio.load>;

const IMG_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-cfsrc", "src"] as const;

/** First real image reference on an <img>, skipping lazy-load placeholders. */
export function imgSource($img: ReturnType<Root>): string | undefined {
  for (const a of IMG_ATTRS) {
    const v = $img.attr(a)?.trim();
    if (v && !v.startsWith("data:") && !/placeholder|loading\.(gif|svg)|lazy\.(gif|svg)|blank\.(gif|png)/i.test(v)) return v;
  }
  const srcset = $img.attr("data-srcset") ?? $img.attr("srcset");
  if (srcset) return srcset.split(",")[0]?.trim().split(/\s+/)[0];
  return undefined;
}

/** Plain <img> list under `selector`, in document order. */
export function imagesBySelector($: Root, selector: string): RawPage[] {
  const out: RawPage[] = [];
  $(selector).each((_, el) => {
    const $el = $(el);
    out.push({ url: imgSource($el), width: num($el.attr("width")), height: num($el.attr("height")) });
  });
  return out.filter((p) => p.url);
}

/**
 * MangaThemesia (WordPress): the reader calls `ts_reader.run({...})` with a
 * JSON config whose `sources[].images` is the ordered page list. Falls back to
 * the server-rendered `#readerarea img` list.
 */
export function themesiaPages(html: string, source: string): RawPage[] {
  const at = html.indexOf("ts_reader.run(");
  if (at >= 0) {
    const cfg = parseJsonAt(html, at + "ts_reader.run(".length) as { sources?: { images?: unknown[] }[] } | undefined;
    const sources = cfg?.sources ?? [];
    // the first source is the reader default; mirrors share the same order
    const images = sources.find((s) => Array.isArray(s.images) && s.images.length)?.images;
    if (images?.length) return images.map((u) => ({ url: typeof u === "string" ? u : undefined }));
  }
  const $ = cheerio.load(html);
  const fromDom = imagesBySelector($, "#readerarea img");
  if (fromDom.length) return fromDom;
  if (/(premium|locked|coin|purchase|unlock)/i.test($("#readerarea").text())) throw chapterLocked(source);
  if (at >= 0) throw pagesNotFound(source);
  throw formatChanged(source, "a MangaThemesia reader");
}

/**
 * Madara (WordPress): `.reading-content .page-break img`. Chapters protected
 * with Madara's "chapter protector" ship encrypted page data instead; those are
 * reported as protected, not decrypted.
 */
export function madaraPages(html: string, source: string): RawPage[] {
  const $ = cheerio.load(html);
  const pages = imagesBySelector($, ".reading-content .page-break img, .reading-content img.wp-manga-chapter-img");
  if (pages.length) return pages;
  // "text" chapters (chapter-type-text): the pages are embedded in the post body
  const embedded = imagesBySelector($, ".reading-content .text-left img, .reading-content .entry-content img");
  if (embedded.length) return embedded;
  if (/chapter_preloaded_images|var\s+chapter_data\s*=/.test(html)) throw pagesProtected(source, "encrypted page data (Madara chapter protector)");
  if ($(".reading-content").length) {
    if (/(premium|locked|coin|purchase|unlock|login)/i.test($(".reading-content").text())) throw chapterLocked(source);
    throw pagesNotFound(source);
  }
  throw formatChanged(source, "a Madara reader");
}

/**
 * Iken "vcomics" (TanStack Start): the dehydrated route state carries
 * `publicImages:[{id,url,order,width,height}]` plus access flags. Only
 * `publicImages` is read; when the chapter is not accessible it is locked.
 */
export function vcomicsPages(html: string, source: string): RawPage[] {
  if (/isAccessible:!1/.test(html) || /isPermanentlyLocked:!0|isLockedByCoins:!0/.test(html)) throw chapterLocked(source);
  // seroval-serialized: `publicImages:$R[62]=[$R[63]={id:..,url:"..",order:1,..},...]`
  const head = /publicImages:(?:\$R\[\d+\]=)?\[/.exec(html);
  if (!head) throw formatChanged(source, "the reader page list (publicImages)");
  const open = head.index + head[0].length - 1;
  const close = matchingBracket(html, open);
  if (close < 0) throw formatChanged(source, "the reader page list (publicImages)");
  const body = html.slice(open, close);
  const out: RawPage[] = [];
  const re = /url:"((?:[^"\\]|\\.)*)"(?:,order:(\d+))?(?:,width:(\d+))?(?:,height:(\d+))?/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    out.push({ url: JSON.parse(`"${m[1]}"`) as string, order: num(m[2]), width: num(m[3]), height: num(m[4]) });
  }
  if (!out.length) {
    if (/isLocked:!0/.test(html)) throw chapterLocked(source);
    throw pagesNotFound(source);
  }
  return out;
}

/** Index of the bracket closing the one at `open`, skipping string literals; -1 if unbalanced. */
function matchingBracket(s: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface CmsPage {
  pageNumber?: number;
  imageUrl?: string;
  width?: number;
  height?: number;
  isEncrypted?: boolean;
  isRedacted?: boolean;
  tiles?: unknown[];
  hasStrips?: boolean;
  hasFragments?: boolean;
}

/**
 * Next.js scanlation CMS (Diva, Drake, Elf, Kayn, Valir): flight data carries
 * `"pages":[{pageNumber,imageUrl,isEncrypted,tiles,hasStrips,hasFragments}]`.
 * Encrypted, tiled, stripped or fragmented pages are scrambled by the provider
 * and are refused rather than reassembled.
 */
export function nextCmsPages(html: string, source: string): RawPage[] {
  const flight = decodeNextFlight(html);
  if (!flight) throw formatChanged(source, "Next.js reader data");
  const lists = jsonValuesAfterKey(flight, "pages").filter(
    (v): v is CmsPage[] => Array.isArray(v) && v.length > 0 && typeof (v[0] as CmsPage)?.imageUrl === "string",
  );
  const pages = lists.sort((a, b) => b.length - a.length)[0];
  if (!pages) {
    if (/"isLocked"\s*:\s*true/.test(flight)) throw chapterLocked(source);
    throw pagesNotFound(source);
  }
  if (pages.some((p) => p.isEncrypted || (Array.isArray(p.tiles) && p.tiles.length) || p.hasStrips || p.hasFragments)) {
    throw pagesProtected(source, "scrambled image tiles");
  }
  if (pages.some((p) => p.isRedacted)) throw chapterLocked(source, "pages redacted for non-members");
  return pages.map((p) => ({ url: p.imageUrl, order: num(p.pageNumber), width: num(p.width), height: num(p.height) }));
}

/**
 * Keyoapp: `<img uid="...">` placeholders inside `#pages`, resolved by an
 * inline script to `https://<cdn>/uploads/<uid>`. The CDN origin is read from
 * that script, not assumed.
 */
export function keyoappPages(html: string, source: string): RawPage[] {
  const $ = cheerio.load(html);
  const cdn = html.match(/realUrl\s*=\s*`(https:\/\/[^`$]+\/)\$\{uid\}`/)?.[1];
  const out: RawPage[] = [];
  $("#pages img[uid], img[uid].myImage").each((_, el) => {
    const uid = $(el).attr("uid")?.trim();
    if (uid && /^[\w-]+(\.[a-z0-9]{2,5})?$/i.test(uid)) out.push({ url: cdn ? `${cdn}${uid}` : undefined, order: num($(el).attr("count")) });
  });
  if (out.length && !cdn) throw formatChanged(source, "the Keyoapp image CDN");
  if (out.length) return out;
  if (/(premium|locked|coin|purchase|unlock)/i.test($("#pages, main").first().text())) throw chapterLocked(source);
  throw pagesNotFound(source);
}

/** Astro island props (`[0,value]` / `[1,[...]]` devalue-style encoding). */
export function astroProps(html: string, component: RegExp): Record<string, unknown> | undefined {
  const $ = cheerio.load(html);
  let props: Record<string, unknown> | undefined;
  $("astro-island").each((_, el) => {
    if (props) return;
    const url = $(el).attr("component-url") ?? "";
    if (!component.test(url)) return;
    try {
      props = JSON.parse($(el).attr("props") ?? "") as Record<string, unknown>;
    } catch {
      props = undefined;
    }
  });
  return props;
}

/** Decode Astro's serialized prop value: [0,x] = x, [1,[...]] = array of encoded values. */
export function astroValue(v: unknown): unknown {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "number") return v;
  const [tag, val] = v as [number, unknown];
  if (tag === 1 && Array.isArray(val)) return val.map(astroValue);
  if (tag === 0 && val && typeof val === "object" && !Array.isArray(val)) {
    return Object.fromEntries(Object.entries(val as Record<string, unknown>).map(([k, x]) => [k, astroValue(x)]));
  }
  return val;
}

/**
 * Asmodeus (Keyoapp fork): `<script id="chapter-offline-data">` JSON with
 * `pages` (wsrv.nl resize URLs wrapping cdn.meowing.org/uploads/<file>) and
 * `locked`/`paid` flags. The wrapped CDN URL is used directly — it is the same
 * file the reader shows, without the third-party resizer in between.
 */
export function asmotoonPages(html: string, source: string): RawPage[] {
  const $ = cheerio.load(html);
  const rawJson = $("script#chapter-offline-data").first().text();
  if (!rawJson) return keyoappPages(html, source);
  let data: { pages?: unknown[]; locked?: boolean; paid?: number };
  try {
    data = JSON.parse(rawJson) as typeof data;
  } catch {
    throw formatChanged(source, "readable chapter-offline-data");
  }
  if (data.locked || (typeof data.paid === "number" && data.paid > 0)) throw chapterLocked(source);
  const pages = (data.pages ?? []).map((p): RawPage => {
    if (typeof p !== "string") return { url: undefined };
    try {
      const u = new URL(p);
      if (u.hostname === "wsrv.nl") {
        const inner = u.searchParams.get("url");
        return { url: inner ? (/^https?:\/\//.test(inner) ? inner : `https://${inner}`) : undefined };
      }
      return { url: p };
    } catch {
      return { url: undefined };
    }
  });
  if (!pages.length) throw pagesNotFound(source);
  return pages;
}

/**
 * Server-rendered reader: `<img>` elements under a provider-specific container,
 * in document order. `exclude` drops non-page images the reader inlines
 * (credit banners); a page list that is empty after that is "no pages".
 */
export function domPages(selector: string, opts: { exclude?: RegExp; container?: string } = {}) {
  return (html: string, source: string): RawPage[] => {
    const $ = cheerio.load(html);
    const pages = imagesBySelector($, selector).filter((p) => !(opts.exclude && opts.exclude.test(p.url ?? "")));
    if (pages.length) return pages;
    const container = opts.container ? $(opts.container) : $(selector.split(" ")[0]);
    if (!container.length) throw formatChanged(source, `the reader container (${opts.container ?? selector.split(" ")[0]})`);
    if (/(premium|locked|coin|purchase|unlock)/i.test(container.text())) throw chapterLocked(source);
    throw pagesNotFound(source);
  };
}

/**
 * Next.js reader whose flight data carries the chapter's pages as a plain URL
 * array under `key` (Lua Comic `"images"`, BaeToon `"pages"`). The longest such
 * array is the chapter (others are covers / recommendations).
 */
export function flightUrlList(key: string) {
  return (html: string, source: string): RawPage[] => {
    const flight = decodeNextFlight(html);
    if (!flight) throw formatChanged(source, "Next.js reader data");
    const lists = jsonValuesAfterKey(flight, key).filter(
      (v): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"),
    );
    const pages = lists.sort((a, b) => b.length - a.length)[0];
    if (!pages) {
      if (/"(isLocked|locked|isPremium)"\s*:\s*true/.test(flight)) throw chapterLocked(source);
      throw pagesNotFound(source);
    }
    return pages.map((url) => ({ url }));
  };
}

/**
 * MangaKatana: the reader assigns `data-src` from one inline array
 * (`obj.attr('data-src', <name>[i])`); the array name changes between deploys
 * and decoy arrays are present, so the name is read from that statement.
 */
export function mangakatanaPages(html: string, source: string): RawPage[] {
  const name = html.match(/attr\(\s*['"]data-src['"]\s*,\s*([A-Za-z_$][\w$]*)\[i\]\s*\)/)?.[1];
  if (!name) throw formatChanged(source, "the page loader script");
  const decl = new RegExp(`var\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*\\[([^\\]]*)\\]`).exec(html);
  if (!decl) throw formatChanged(source, `the page list (${name})`);
  const urls = [...decl[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  if (!urls.length) throw pagesNotFound(source);
  return urls.map((url) => ({ url }));
}

/** XComic (Qwik): container state has `"imageUrls",<tag>,[0,"<url>",0,"<url>",...]`. */
export function xcomicPages(html: string, source: string): RawPage[] {
  const head = /"imageUrls",\d+,\[/.exec(html);
  if (!head) {
    if (/"(isLocked|locked)",\d+,(true|1)\b/.test(html)) throw chapterLocked(source);
    throw formatChanged(source, "the reader state (imageUrls)");
  }
  const open = head.index + head[0].length - 1;
  const close = matchingBracket(html, open);
  if (close < 0) throw formatChanged(source, "the reader state (imageUrls)");
  const urls = [...html.slice(open, close).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
  if (!urls.length) throw pagesNotFound(source);
  return urls.map((url) => ({ url }));
}

/** Pages Router reader: `__NEXT_DATA__` JSON with a `pages:[{url,width,height}]` list. */
export function nextDataPages(html: string, source: string): RawPage[] {
  const $ = cheerio.load(html);
  const raw = $("script#__NEXT_DATA__").first().text();
  if (!raw) throw formatChanged(source, "Next.js page data");
  const lists = jsonValuesAfterKey(raw, "pages").filter(
    (v): v is { url?: string; width?: number; height?: number }[] =>
      Array.isArray(v) && v.length > 0 && typeof (v[0] as { url?: unknown })?.url === "string",
  );
  const pages = lists.sort((a, b) => b.length - a.length)[0];
  if (!pages) {
    if (/"(isLocked|locked|isPremium)"\s*:\s*true/.test(raw)) throw chapterLocked(source);
    throw pagesNotFound(source);
  }
  return pages.map((p) => ({ url: p.url, width: num(p.width), height: num(p.height) }));
}

/**
 * Rithar Scans (Laravel Livewire + Alpine): the reader's `x-data` holds
 * `pages: JSON.parse('[{"path","width","height"}...]')`; the Livewire snapshot
 * carries `canRead` / `needsToUnlock` / `requiresLogin`, which are honoured.
 */
export function ritharPages(html: string, source: string): RawPage[] {
  const $ = cheerio.load(html);
  type Gate = { canRead?: boolean; needsToUnlock?: boolean; requiresLogin?: boolean };
  let gate: Gate | undefined;
  $("[wire\\:snapshot]").each((_, el) => {
    if (gate) return;
    try {
      const snap = JSON.parse($(el).attr("wire:snapshot") ?? "") as { data?: Record<string, unknown> };
      if (snap.data && "canRead" in snap.data) gate = snap.data as Gate;
    } catch {
      /* other components */
    }
  });
  if (gate && (gate.canRead === false || gate.needsToUnlock || gate.requiresLogin)) throw chapterLocked(source);
  let literal: string | undefined;
  $("[x-data]").each((_, el) => {
    if (literal !== undefined) return;
    const m = /\bpages:\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)/.exec($(el).attr("x-data") ?? "");
    if (m) literal = m[1];
  });
  if (literal === undefined) throw formatChanged(source, "the reader page list (x-data pages)");
  let pages: { path?: string; width?: number; height?: number }[];
  try {
    pages = JSON.parse(JSON.parse(`"${literal.replace(/\\'/g, "'")}"`) as string) as typeof pages;
  } catch {
    throw formatChanged(source, "a readable reader page list");
  }
  if (!Array.isArray(pages) || !pages.length) throw pagesNotFound(source);
  return pages.map((p) => ({ url: p?.path, width: num(p?.width), height: num(p?.height) }));
}

/**
 * WebtoonClub (Next.js): flight data has `"chapter":{id,comicId,images:[{filename,sortOrder,width,height}]}`.
 * The reader resolves `filename` exactly like this: names containing "/" live
 * at /uploads/<filename>, bare names at /uploads/chapters/<comicId>/<id>/<name>
 * on the site's own origin. robots.txt disallows /api/, which is not used.
 */
export function webtoonclubPages(origin: string) {
  return (html: string, source: string): RawPage[] => {
    const flight = decodeNextFlight(html);
    if (!flight) throw formatChanged(source, "Next.js reader data");
    type Img = { filename?: string; sortOrder?: number; width?: number; height?: number };
    type Ch = { id?: number | string; comicId?: number | string; images?: Img[]; isLocked?: boolean };
    const chapters = jsonValuesAfterKey(flight, "chapter").filter(
      (v): v is Ch => Boolean(v) && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as Ch).images),
    );
    const ch = chapters.sort((a, b) => (b.images?.length ?? 0) - (a.images?.length ?? 0))[0];
    if (!ch) {
      if (/"(isLocked|locked|isPremium)"\s*:\s*true/.test(flight)) throw chapterLocked(source);
      throw formatChanged(source, "the chapter image list");
    }
    if (ch.isLocked) throw chapterLocked(source);
    if (!ch.images?.length) throw pagesNotFound(source);
    return ch.images.map((img) => {
      const f = img.filename;
      const url = !f ? undefined : f.includes("/") ? `${origin}/uploads/${f}` : `${origin}/uploads/chapters/${ch.comicId}/${ch.id}/${f}`;
      return { url, order: num(img.sortOrder), width: num(img.width), height: num(img.height) };
    });
  };
}
