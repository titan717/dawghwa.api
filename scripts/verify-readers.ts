/**
 * Live reader verification, end to end, per provider:
 *
 *   search (provider's own search) -> chapter list (provider's own list)
 *   -> POST /api/pages for the first, a middle and the latest chapter
 *   -> GET of the /api/image URL that response handed out, for the first,
 *      middle and last page, checked for status 200, image/* and magic bytes.
 *
 * The page and image steps go through the real route handlers, not the
 * helpers behind them, so URL rewriting, allowlists and the relay are covered:
 *
 *   VERIFY_BASE_URL unset   route handlers invoked in-process (mode "handlers")
 *   VERIFY_BASE_URL=<url>   real HTTP against a running API, e.g. `next start`
 *                           or a preview deployment (mode "http")
 *
 *   npx tsx scripts/verify-readers.ts [ids...]   > docs/page-extraction-verification.json
 *
 * The output records the mode and the network it ran from; a run from a
 * developer machine says nothing about the production egress network.
 * Runs only providers with capabilities.chapterPages. No fixtures, no mocks.
 */
import { getRegistry } from "../src/lib/providers/registry";
import { NextRequest } from "next/server";
import { POST as pagesPOST } from "../src/app/api/pages/route";
import { GET as imageGET } from "../src/app/api/image/route";
import { isGenericBinaryType, sniffImageType } from "../src/lib/services/page-image";
import type { Provider } from "../src/lib/providers/provider";

const BASE = process.env.VERIFY_BASE_URL?.replace(/\/$/, "");
const MODE = BASE ? "http" : "handlers";
const LOCAL = "http://localhost";

/** POST /api/pages, through HTTP or the in-process route handler. */
async function callPages(body: Record<string, unknown>): Promise<Response> {
  if (BASE) {
    return fetch(`${BASE}/api/pages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  }
  return pagesPOST(new NextRequest(`${LOCAL}/api/pages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

/** GET a page URL exactly as /api/pages returned it. */
async function callImage(pageUrl: string): Promise<Response> {
  const u = new URL(pageUrl);
  if (BASE) return fetch(pageUrl, { signal: AbortSignal.timeout(25_000) });
  if (u.origin !== LOCAL || u.pathname !== "/api/image") throw new Error(`page URL is not relayed through /api/image: ${u.host}`);
  return imageGET(new NextRequest(u));
}

const QUERIES = (process.env.VERIFY_QUERIES ?? "solo,return,level,sword,love,the").split(",");

function magic(b: Uint8Array): string | undefined {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0x47 && b[1] === 0x49) return "gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "avif";
  return undefined;
}

async function image(url: string) {
  const t = Date.now();
  try {
    const r = await callImage(url);
    const buf = new Uint8Array(await r.arrayBuffer());
    const kind = magic(buf);
    return {
      // same acceptance rule as /api/image: image/* or octet-stream whose bytes are an image
      ok:
        r.status === 200 &&
        ((r.headers.get("content-type") ?? "").startsWith("image/") || (isGenericBinaryType(r.headers.get("content-type") ?? "") && Boolean(sniffImageType(buf)))) &&
        Boolean(kind) &&
        buf.length > 64,
      status: r.status,
      type: r.headers.get("content-type"),
      kind,
      bytes: buf.length,
      ms: Date.now() - t,
    };
  } catch (e) {
    return { ok: false, why: String((e as Error).message ?? e), ms: Date.now() - t };
  }
}

async function verify(p: Provider) {
  const out: Record<string, unknown> = { id: p.id, name: p.name };
  let hit: { url: string; title: string } | undefined;
  for (const q of QUERIES) {
    try {
      const v = (await p.run("search", () => p.scraper.search(q), { timeoutMs: 25_000 })).value;
      if (v.length) {
        hit = v[0];
        out.query = q;
        break;
      }
    } catch (e) {
      out.searchError = (e as { code?: string }).code ?? String(e);
      if ((e as { code?: string }).code === "UPSTREAM_BLOCKED" || (e as { code?: string }).code === "SOURCE_CIRCUIT_OPEN") break;
    }
  }
  if (!hit) return { ...out, search: false };
  out.search = true;
  out.title = hit.title;
  let chapters;
  try {
    chapters = (await p.run("chapters", () => p.scraper.getChapterList(hit!.url), { timeoutMs: 30_000 })).value;
  } catch (e) {
    return { ...out, chapters: false, chaptersError: (e as { code?: string }).code ?? String(e) };
  }
  out.chapters = chapters.length > 0;
  out.chapterCount = chapters.length;
  if (!chapters.length) return out;
  const sorted = [...chapters].sort((a, b) => a.number - b.number);
  const picks = [...new Set([sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]])];
  const results = [];
  for (const ch of picks) {
    const t = Date.now();
    try {
      const res = await callPages({ source: p.id, url: ch.url, chapterId: /^[\w-]+$/.test(ch.id ?? "") ? ch.id : undefined, refresh: true });
      const body = (await res.json()) as { pages?: { index: number; url: string }[]; error?: string; code?: string };
      if (res.status !== 200 || !body.pages) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { code: body.code ?? `HTTP_${res.status}` });
      const r = { pages: body.pages };
      const idx = [...new Set([0, Math.floor(r.pages.length / 2), r.pages.length - 1])];
      const imgs = [];
      for (const i of idx) imgs.push({ page: i, ...(await image(r.pages[i].url)) });
      results.push({
        chapter: ch.number,
        url: ch.url,
        pages: r.pages.length,
        pagesMs: Date.now() - t,
        ordered: r.pages.every((pg, i) => pg.index === i),
        images: imgs,
        ok: r.pages.length > 0 && imgs.every((x) => x.ok),
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      results.push({ chapter: ch.number, url: ch.url, ok: false, error: err.code ?? "ERR", message: err.message?.slice(0, 200), pagesMs: Date.now() - t });
    }
  }
  out.samples = results;
  out.pages = results.some((r) => (r as { pages?: number }).pages);
  out.images = results.some((r) => r.ok);
  // a provider is verified when every sampled chapter either loaded fully or was explicitly locked
  out.verified = results.some((r) => r.ok) && results.every(
      (r) =>
        r.ok ||
        (r as { error?: string }).error === "CHAPTER_LOCKED" ||
        // removed upstream (chapter link redirects to the home page) is a provider fact, not an extraction failure
        ((r as { error?: string }).error === "PAGES_NOT_FOUND" && /removed this chapter/.test((r as { message?: string }).message ?? "")),
    );
  return out;
}

async function main() {
  const only = process.argv.slice(2);
  const ps = getRegistry()
    .operational()
    .filter((p) => p.capabilities.chapterPages && (only.length === 0 || only.includes(p.id)));
  const results: Record<string, unknown>[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, ps.length) }, async () => {
      while (i < ps.length) {
        const p = ps[i++];
        const r = await verify(p);
        results.push(r);
        const s = (r.samples as { chapter: number; pages?: number; ok: boolean; error?: string }[] | undefined) ?? [];
        console.error(`${r.verified ? "PASS" : "FAIL"} ${p.id}: ${s.map((x) => `ch${x.chapter}=${x.ok ? x.pages : x.error ?? "img"}`).join(" ") || (r.searchError ?? r.chaptersError ?? "no search hit")}`);
      }
    }),
  );
  results.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  process.stdout.write(
    JSON.stringify({ generatedAt: new Date().toISOString(), mode: MODE, target: BASE ?? "in-process route handlers", network: process.env.VERIFY_NETWORK ?? "unspecified (developer machine)", results }, null, 1),
  );
}

void main();
