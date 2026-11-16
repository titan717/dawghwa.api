# Contributing to Dawghwa API

Thanks for helping. This guide covers adding or fixing a source adapter and the checks every change must pass.

## Ground rules

- **Respect providers.** Do not add code that solves or bypasses Cloudflare/anti-bot challenges, replays cookies, or gets around access controls. If a site is permanently behind a challenge, it is not a viable source.
- **No fake results.** If an adapter cannot parse a page, it must throw or return `[]` for a genuine "nothing found". It must never return placeholder data. Broken sources are marked `shutdown` (see below), not left returning empty lists.
- **Only documented page APIs.** Implement `getChapterPages` only when the provider offers a documented, permitted API for it.

## Adding a source

### 1. Check viability

Visit the site several times over a few days. It needs working search and chapter listings that load without a CAPTCHA or challenge page.

### 2. Implement the adapter

Create `src/lib/scrapers/your-source.ts`. Always use `this.http()` (a `fetch`-compatible method) or `this.fetchWithRetry()`, never the global `fetch`. The shared client provides timeouts, cancellation, retries with backoff, per-source rate limiting, conditional requests, SSRF protection and anti-bot detection.

```typescript
import * as cheerio from "cheerio";
import { BaseScraper } from "./base";
import { ScrapedChapter, SearchResult, SourceType } from "@/types";

export class YourSourceScraper extends BaseScraper {
  getName(): string {
    return "YourSource";
  }

  getBaseUrl(): string {
    return "https://yoursource.com";
  }

  getType(): SourceType {
    return "scanlator"; // or "aggregator"
  }

  canHandle(url: string): boolean {
    return url.includes("yoursource.com");
  }

  async search(query: string): Promise<SearchResult[]> {
    const html = await this.fetchWithRetry(`${this.getBaseUrl()}/search?q=${encodeURIComponent(query)}`);
    const $ = cheerio.load(html);
    return $(".result")
      .map((_, el) => ({
        id: $(el).attr("data-id") ?? "",
        title: $(el).find(".title").text().trim(),
        url: new URL($(el).find("a").attr("href") ?? "", this.getBaseUrl()).toString(),
        latestChapter: Number($(el).find(".latest").text().replace(/[^\d.]/g, "")) || 0,
        lastUpdated: $(el).find(".date").text().trim(),
      }))
      .get();
  }

  async getChapterList(url: string): Promise<ScrapedChapter[]> {
    const res = await this.http(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    // ...
    return [];
  }
}
```

Notes:
- The domains in `canHandle()` (string literals in `url.includes("...")`) and the base URL host become the source's **domain allowlist**. URLs on any other host are rejected before a request is made.
- Throw on HTTP errors instead of returning `[]`. If you do catch errors, Dawghwa still detects that every request failed and reports an outage.
- Do not add your own retry loops or `setTimeout` sleeps. If you need a pause, use `await this.delay(ms)`, which is cancellable.
- Client-only sources (`isClientOnly(): true`) are parsed by clients through `/api/proxy/html`. The proxy only allows the domains of operational client-only sources, which come from the manifest automatically.

### 3. Register it

Add an instance to the `scrapers` array in `src/lib/scrapers/index.ts`, then regenerate the generated files:

```bash
npm run manifest       # src/lib/providers/manifest.generated.ts (CI checks it is current)
npm run docs:sources   # docs/SOURCES.md
```

Optional metadata goes in `src/lib/providers/status.ts`: `UNSTABLE_SOURCE_IDS`, `STATUS_NOTES`, `SOURCE_ALIASES`, `DEFAULT_PRIORITIES`, and `RATE_LIMITS` (only if the provider documents a limit).

### 4. Tests

- The offline contract tests in `src/tests/adapters/contract.test.ts` run automatically for every registered adapter. They check domain ownership, look-alike host rejection, safe failure on unexpected pages, and outage reporting.
- Add a fixture test for the parsing logic: save a trimmed HTML/JSON sample and mock `fetch` with the helpers in `src/tests/helpers.ts`. `src/tests/adapters/mangadex.test.ts` is an example.
- Live checks are optional and opt-in: `npm run test:live`, or `npm run health:report -- your-source`.

### 5. Retiring a source

If a site is gone or the adapter can no longer work, add its id to `src/lib/shutdown-sources.ts` and a note to `STATUS_NOTES` in `src/lib/providers/status.ts`. Keep the adapter file, so it can be revived later.

## Checks

Every pull request must pass:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs the same steps. Use clear commit messages and describe the source and what you tested in the pull request.
