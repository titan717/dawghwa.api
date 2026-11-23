/**
 * Provider gate runner (MASTER_PROMPT section 11). Prints a markdown report.
 * It NEVER turns a provider flag on and never changes env vars or config.
 *
 *   npm run gate:provider -- --dry-run
 *   npm run gate:provider -- --provider <id> --terms review.json --titles titles.json \
 *       [--history runs.json] [--leak leak.json] [--daily 800] [--paths /search,/series/*] [--out report.md]
 *
 *   --terms    TermsReview JSON written by SCOUT after reading the terms (src/lib/gate/types.ts)
 *   --titles   QualityTitle[] JSON, 12 or more titles (manga, manhwa, manhua)
 *   --history  RunRecord[] JSON; this run is appended to it (gate 7)
 *   --leak     SHIELD leak audit result JSON with the provider on (gate 8)
 *   --daily    projected requests per day per host (gate 5)
 *   --paths    robots.txt paths the adapter uses (gate 2); requested paths are checked too
 *   --dry-run  use the synthetic fixture provider, no network at all
 *
 * Only this runner touches real sites, with the polite fetcher: 1 request per
 * second per host, backoff, stop on 401/403/challenge, DawghwaBot user agent.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Before anything reads (and caches) the config: no hidden retries, 1 rps, honest UA.
const GATE_UA = "DawghwaBot/1.0 (+https://dawghwa.vercel.app/bot)";
process.env.UPSTREAM_RETRIES = "0";
process.env.SOURCE_DEFAULT_RPS = "1";
process.env.SOURCE_DEFAULT_BURST = "1";
process.env.SOURCE_DEFAULT_MAX_CONCURRENT = "1";
process.env.UPSTREAM_USER_AGENT = GATE_UA;
// The runner evaluates a source; it must be able to call it even under enforce.
delete process.env.PROVIDER_GATES;

function args(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const readJson = <T>(p: string | true | undefined): T | null => (typeof p === "string" ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);

async function main() {
  const a = args(process.argv.slice(2));
  const { getConfig } = await import("../../src/lib/core/config");
  const cfg = getConfig();
  if (cfg.http.retries !== 0 || cfg.providers.defaultRps !== 1 || cfg.http.userAgent !== GATE_UA) {
    throw new Error(`gate runner config not applied (retries=${cfg.http.retries}, rps=${cfg.providers.defaultRps}); refusing to run`);
  }
  const { PoliteFetcher, GATE_USER_AGENT } = await import("../../src/lib/gate/polite");
  if (GATE_USER_AGENT !== GATE_UA) throw new Error("user agent mismatch");
  const { runGates } = await import("../../src/lib/gate/run");
  const { renderReport } = await import("../../src/lib/gate/report");
  const daily = typeof a.daily === "string" ? Number(a.daily) : null;
  const history = readJson<unknown[]>(a.history) ?? [];
  const leak = readJson<import("../../src/lib/gate/types").LeakAuditResult>(a.leak);
  const minScore = cfg.availability.minScore;

  let output;
  if (a["dry-run"]) {
    const { fixtureAdapter, fixtureInner } = await import("../../src/lib/gate/fixture");
    const file = typeof a.fixture === "string" ? a.fixture : path.join(__dirname, "../../src/tests/fixtures/gate/synthetic-provider.json");
    const f = JSON.parse(readFileSync(file, "utf8"));
    // Virtual clock: pacing is computed and logged exactly, without waiting.
    let clock = Date.parse("2026-11-23T00:00:00Z");
    const fetcher = new PoliteFetcher({
      inner: fixtureInner(f),
      guard: async () => undefined, // synthetic hosts only; nothing leaves the process
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    output = await runGates({
      adapter: fixtureAdapter(f, { request: (u) => fetcher.get(u) }),
      fetcher,
      review: f.review,
      titles: f.titles,
      history,
      leak,
      minScore,
      projectedDailyRequests: daily ?? 600,
      now: () => clock,
    });
  } else {
    const id = a.provider;
    if (typeof id !== "string") throw new Error("--provider <id> or --dry-run is required");
    const { getRegistry } = await import("../../src/lib/providers/registry");
    const { adapterFromProvider, withPoliteFetcher } = await import("../../src/lib/gate/bridge");
    const provider = getRegistry().get(id);
    if (!provider) throw new Error(`unknown provider ${id}`);
    const review = readJson<import("../../src/lib/gate/types").TermsReview>(a.terms);
    const titles = readJson<import("../../src/lib/gate/types").QualityTitle[]>(a.titles) ?? [];
    const adapter = adapterFromProvider(provider, {
      offlineAllowed: review?.offline === "allowed",
      paths: typeof a.paths === "string" ? a.paths.split(",").map((s) => s.trim()).filter(Boolean) : [],
    });
    const fetcher = new PoliteFetcher({ restrictToDeclared: true, extraHosts: [...adapter.hosts, ...adapter.imageHosts] });
    output = await withPoliteFetcher(fetcher, () =>
      runGates({ adapter, fetcher, review, titles, history, leak, minScore, projectedDailyRequests: daily }),
    );
  }

  const report = renderReport(output);
  process.stdout.write(report + "\n");
  if (typeof a.out === "string") writeFileSync(a.out, report);
  if (typeof a.history === "string" && output.record && !a["dry-run"]) {
    writeFileSync(a.history, JSON.stringify([...history, output.record], null, 2) + "\n");
  }
  process.stdout.write(`\nverdict=${output.verdict} flag=${output.flag} (unchanged; the runner never sets flags)\n`);
}

main().catch((e) => {
  process.stderr.write(`gate runner: ${(e as Error).message}\n`);
  process.exit(1);
});
