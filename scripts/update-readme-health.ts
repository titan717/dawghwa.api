/**
 * Probe every source in-process (no hosted API involved) and write
 * docs/SOURCE_STATUS.md plus docs/source-status.json.
 *
 *   npm run health:report            # all operational sources
 *   npm run health:report -- mangadex comix
 *
 * Results reflect reachability from the machine running the script; sources
 * behind anti-bot challenges often pass from residential IPs but fail from
 * CI/datacenter networks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRegistry } from "../src/lib/providers/registry";
import { probeAll, SourceStatus } from "../src/lib/services/health";

const LABEL: Record<string, string> = {
  [SourceStatus.HEALTHY]: "Healthy",
  [SourceStatus.CLOUDFLARE]: "Blocked (anti-bot)",
  [SourceStatus.TIMEOUT]: "Timeout",
  [SourceStatus.ERROR]: "Error",
};

async function main() {
  const registry = getRegistry();
  const only = process.argv.slice(2).map((s) => s.toLowerCase());
  const providers = registry
    .operational()
    .filter((p) => only.length === 0 || only.includes(p.id));
  const shutdown = registry.all().filter((p) => p.descriptor.status === "shutdown");

  console.error(`Probing ${providers.length} sources...`);
  const started = Date.now();
  const results = await probeAll(providers);
  const elapsed = Date.now() - started;
  const generatedAt = new Date().toISOString();

  const counts: Record<string, number> = {};
  for (const r of Object.values(results)) counts[r.status] = (counts[r.status] ?? 0) + 1;

  const rows = providers
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const r = results[p.id];
      const msg = (r?.message ?? "").replace(/\|/g, "\\|").slice(0, 120);
      return `| ${p.name} | \`${p.id}\` | ${p.descriptor.status} | ${LABEL[r?.status] ?? "Unknown"} | ${r?.responseTime ?? ""} | ${msg} |`;
    });

  const md = [
    "# Source status",
    "",
    `Generated ${generatedAt} by \`npm run health:report\` in ${(elapsed / 1000).toFixed(1)}s.`,
    "",
    "\"Declared\" is the maintained status in `src/lib/providers/status.ts`; \"Probe\" is the live result of a small search from the machine that ran the report. Anti-bot blocks frequently depend on the network the probe runs from.",
    "",
    `Summary: ${Object.entries(counts).map(([k, v]) => `${LABEL[k] ?? k}: ${v}`).join(", ")}; shut down (not probed): ${shutdown.length}.`,
    "",
    "| Source | ID | Declared | Probe | ms | Detail |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...rows,
    "",
    "## Shut down",
    "",
    ...shutdown.map((p) => `- ${p.name} (\`${p.id}\`)${p.descriptor.statusNote ? ` - ${p.descriptor.statusNote}` : ""}`),
    "",
  ].join("\n");

  const docs = path.join(process.cwd(), "docs");
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(docs, "SOURCE_STATUS.md"), md);
  writeFileSync(
    path.join(docs, "source-status.json"),
    JSON.stringify({ generatedAt, elapsedMs: elapsed, counts, sources: results }, null, 2) + "\n",
  );
  console.error(`Done: ${JSON.stringify(counts)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
