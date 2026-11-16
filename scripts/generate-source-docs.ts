/** Writes docs/SOURCES.md from the provider registry: npm run docs:sources */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getRegistry } from "../src/lib/providers/registry";

const providers = getRegistry()
  .all()
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name));
const badge = { active: "Active", unstable: "Unstable", shutdown: "Shut down" } as const;
const count = (s: string) => providers.filter((p) => p.descriptor.status === s).length;

const rows = providers.map((p) => {
  const c = p.capabilities;
  const caps = [
    "search",
    "chapters",
    c.frontpage ? "frontpage" : "",
    c.chapterPages ? "pages" : "",
    c.clientOnly ? "client-only" : "",
  ]
    .filter(Boolean)
    .join(", ");
  const note = (p.descriptor.statusNote ?? "").replace(/\|/g, "\\|");
  return `| ${p.name} | \`${p.id}\` | ${p.descriptor.baseUrl} | ${p.descriptor.type} | ${badge[p.descriptor.status]} | ${caps} | ${note} |`;
});

const md = `# Supported sources

Generated from the registry by \`npm run docs:sources\`. ${providers.length} adapters: ${count("active")} active, ${count("unstable")} unstable, ${count("shutdown")} shut down.

- **Active**: maintained adapter, expected to work (may still be blocked by anti-bot protection from some networks).
- **Unstable**: known to fail intermittently (upstream-reported); results are returned when the site responds.
- **Shut down**: the site is gone or the adapter no longer works. These are never called; requests return \`SOURCE_UNAVAILABLE\` instead of empty results.

Live reachability from a specific machine is in [SOURCE_STATUS.md](./SOURCE_STATUS.md) (\`npm run health:report\`) and at \`GET /api/health\`.

| Source | ID | Base URL | Type | Status | Capabilities | Note |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
writeFileSync(path.join(process.cwd(), "docs", "SOURCES.md"), md);
console.error(`Wrote docs/SOURCES.md (${providers.length} sources)`);
