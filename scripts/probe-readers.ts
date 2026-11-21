/**
 * Research probe: for every operational source, find a real title through the
 * provider's own search, take a real chapter from its own chapter list, fetch
 * that chapter's reader page and fingerprint how pages are delivered.
 *
 *   npx tsx scripts/probe-readers.ts [ids...] > /tmp/probe.json
 *
 * Output is evidence for docs/PAGE_EXTRACTION.md; it changes nothing.
 */
import { writeFileSync } from "node:fs";
import { getRegistry } from "../src/lib/providers/registry";
import { upstreamFetch } from "../src/lib/core/http";
import { SHUTDOWN_SOURCE_IDS } from "../src/lib/shutdown-sources";

const QUERIES = ["solo", "return", "level", "sword", "love", "the"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function fingerprint(html: string) {
  const f: string[] = [];
  if (/ts_reader\.run\(/.test(html)) f.push("themesia:ts_reader");
  if (/class="[^"]*reading-content/.test(html)) f.push("madara:reading-content");
  if (/wp-manga-chapter-img/.test(html)) f.push("madara:chapter-img");
  if (/<astro-island/.test(html)) f.push("astro");
  if (/self\.__next_f\.push/.test(html)) f.push("next:rsc");
  if (/__NEXT_DATA__/.test(html)) f.push("next:data");
  if (/__NUXT__|__NUXT_DATA__/.test(html)) f.push("nuxt");
  if (/data-sveltekit/.test(html)) f.push("sveltekit");
  if (/q:container/.test(html)) f.push("qwik");
  if (/wire:snapshot|livewire/.test(html)) f.push("livewire");
  if (/id="readerarea"/.test(html)) f.push("themesia:readerarea");
  if (/Just a moment|cf-chl|challenge-platform/.test(html)) f.push("cf-challenge");
  if (/premium|coins?\b|unlock/i.test(html) && /locked|lock-icon|is_locked|isLocked/i.test(html)) f.push("maybe-locked");
  const imgs = [...html.matchAll(/https?:\\?\/\\?\/[^"'\s<>()]+?\.(?:webp|jpe?g|png|avif|gif)(?:\?[^"'\s<>()]*)?/gi)].map((m) => m[0].replace(/\\\//g, "/"));
  const hosts: Record<string, number> = {};
  for (const u of imgs) {
    try {
      const h = new URL(u).hostname;
      hosts[h] = (hosts[h] ?? 0) + 1;
    } catch {
      /* ignore */
    }
  }
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => /chapter|reader|read/i.test(s)).slice(0, 5);
  return { f, imgCount: imgs.length, hosts, sampleImgs: [...new Set(imgs)].slice(0, 6), scripts, size: html.length };
}

async function probe(p: ReturnType<typeof getRegistry>["all"] extends () => (infer T)[] ? T : never) {
  const out: Record<string, unknown> = { id: p.id, name: p.name, pagesNow: p.capabilities.chapterPages };
  try {
    let hit;
    for (const q of QUERIES) {
      const r = await p.run("search", () => p.scraper.search(q), { timeoutMs: 25_000 }).catch((e) => ({ value: [], err: `${e?.code ?? ""} ${e?.message ?? e}`.slice(0, 140) }));
      const v = (r as { value: { url: string; title: string }[] }).value ?? [];
      if (v.length) {
        hit = v[0];
        out.query = q;
        break;
      }
      if ((r as { err?: string }).err) out.searchErr = ((out.searchErr as string | undefined) ?? "") + `${q}:${(r as { err?: string }).err}; `;
    }
    if (!hit) return { ...out, stage: "search" };
    out.title = hit.title;
    out.titleUrl = hit.url;
    const chs = (await p.run("chapters", () => p.scraper.getChapterList(hit.url), { timeoutMs: 30_000 })).value;
    out.chapterCount = chs.length;
    if (!chs.length) return { ...out, stage: "chapters" };
    const sorted = [...chs].sort((a, b) => a.number - b.number);
    const ch = sorted[0];
    out.chapter = { id: ch.id, number: ch.number, url: ch.url };
    const res = await p.run(
      "chapterPages",
      () => upstreamFetch(ch.url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", Referer: hit.url } }),
      { timeoutMs: 25_000 },
    );
    const html = await res.value.text();
    out.status = res.value.status;
    out.finalUrl = res.value.url;
    Object.assign(out, fingerprint(html));
    writeFileSync(`/tmp/probe-html/${p.id.replace(/[^\w-]/g, "_")}.html`, html);
    return { ...out, stage: "fetched" };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ...out, error: `${err.code ?? ""} ${err.message ?? e}`.slice(0, 200) };
  }
}

async function main() {
  const only = process.argv.slice(2);
  const ps = getRegistry()
    .operational()
    .filter((p) => !SHUTDOWN_SOURCE_IDS.has(p.id) && (only.length === 0 || only.includes(p.id)));
  const results: unknown[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (i < ps.length) {
        const p = ps[i++];
        const r = await probe(p);
        results.push(r);
        console.error(`${p.id}: ${(r as { stage?: string }).stage ?? "err"} ${(r as { f?: string[] }).f?.join(",") ?? (r as { error?: string }).error ?? ""}`);
      }
    }),
  );
  process.stdout.write(JSON.stringify(results, null, 1));
}

void main();
