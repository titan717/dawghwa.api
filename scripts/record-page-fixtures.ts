/**
 * Records real provider responses for page-extraction fixture tests.
 *
 *   npx tsx scripts/record-page-fixtures.ts <probe.json> [ids...]
 *
 * For each provider, calls getChapterPages() against the live chapter URL
 * (taken from the provider's own chapter list in the probe file) while
 * recording every upstream response the adapter makes. HTML bodies are
 * trimmed (styles, SVG, comments, external scripts, unrelated markup
 * attributes) and the trimmed recording is replayed: the fixture is kept only
 * if the replay yields exactly the same page list as the live call.
 *
 * Output: src/tests/fixtures/pages/<id>.json.gz
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { getRegistry } from "../src/lib/providers/registry";

interface Recorded {
  url: string;
  method: string;
  body?: string;
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
}

const OUT = "src/tests/fixtures/pages";

function trimHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "<svg></svg>")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi, "")
    .replace(/<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, body: string) =>
      /https?:|\\\/\\\/|\/\/|pages|images|chapter|__NEXT|self\.__next_f|\$R|x-data|JSON\.parse|imgs|data-src/i.test(body)
        ? m
        : "<script></script>",
    )
    .replace(/\s(class|style)="[^"]{200,}"/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n\s*\n+/g, "\n");
}

function replayHttp(rec: Recorded[]) {
  let i = 0;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = rec.find((r, j) => j >= i && r.url === url && r.method === method) ?? rec.find((r) => r.url === url && r.method === method);
    if (!hit) throw new Error(`unrecorded request ${method} ${url}`);
    i++;
    const res = new Response(hit.text, { status: hit.status, headers: { "content-type": hit.contentType } });
    Object.defineProperty(res, "url", { value: hit.finalUrl });
    return res;
  };
}

async function main() {
  const [probeFile, ...ids] = process.argv.slice(2);
  const probe: Array<{ id: string; chapter?: { url: string } }> = JSON.parse(readFileSync(probeFile, "utf8"));
  mkdirSync(OUT, { recursive: true });
  const registry = getRegistry();
  for (const entry of probe) {
    if (ids.length && !ids.includes(entry.id)) continue;
    const provider = registry.get(entry.id);
    const chapterUrl = entry.chapter?.url;
    if (!provider?.capabilities.chapterPages || !chapterUrl || !provider.scraper.getChapterPages) continue;
    const scraper = provider.scraper as unknown as { http: (i: string | URL | Request, init?: RequestInit) => Promise<Response> };
    const realHttp = scraper.http.bind(scraper);
    const rec: Recorded[] = [];
    scraper.http = async (input, init) => {
      const res = await realHttp(input, init);
      const text = await res.clone().text();
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const contentType = res.headers.get("content-type") ?? "";
      rec.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        body: typeof init?.body === "string" ? init.body : undefined,
        status: res.status,
        finalUrl: res.url || url,
        contentType,
        text,
      });
      return res;
    };
    try {
      const live = await provider.scraper.getChapterPages({ url: chapterUrl });
      const liveUrls = JSON.stringify(live.map((p) => p.url));
      const replays = async () => {
        scraper.http = replayHttp(rec);
        try {
          return JSON.stringify((await provider.scraper.getChapterPages!({ url: chapterUrl })).map((p) => p.url)) === liveUrls;
        } catch {
          return false;
        }
      };
      const raw = rec.map((r) => r.text);
      for (const r of rec) if (/html/.test(r.contentType)) r.text = trimHtml(r.text);
      if (!(await replays())) {
        rec.forEach((r, i) => (r.text = raw[i]));
        if (!(await replays())) {
          console.error(`SKIP ${entry.id}: replay differs from the live result`);
          continue;
        }
        console.error(`note ${entry.id}: trimming changed the result; stored untrimmed`);
      }
      writeFileSync(
        `${OUT}/${entry.id}.json.gz`,
        gzipSync(JSON.stringify(
          {
            provider: entry.id,
            chapterUrl,
            recordedAt: new Date().toISOString().slice(0, 10),
            expected: { count: live.length, first: live[0]?.url, last: live[live.length - 1]?.url },
            responses: rec,
          },
          null,
          1,
        )),
      );
      console.error(`OK ${entry.id}: ${live.length} pages, ${rec.length} responses, ${Math.round(rec.reduce((n, r) => n + r.text.length, 0) / 1024)} KiB`);
    } catch (e) {
      console.error(`FAIL ${entry.id}: ${(e as Error).message}`);
    } finally {
      scraper.http = realHttp;
    }
  }
}

void main();
