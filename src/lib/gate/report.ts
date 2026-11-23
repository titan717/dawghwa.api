/**
 * Markdown report for docs/providers/<name>.md (internal docs only; provider
 * names never appear in API responses or the app).
 */

import type { GateRunOutput } from "./run";
import { RUNNER_VERSION } from "./run";

const STATUS: Record<string, string> = { pass: "pass", fail: "FAIL", "not-run": "not run", "needs-evidence": "needs evidence" };
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderReport(o: GateRunOutput, opts: { recheckDays?: number } = {}): string {
  const lines: string[] = [];
  const recheck = new Date(Date.parse(o.endedAt) + (opts.recheckDays ?? 30) * 86_400_000).toISOString().slice(0, 10);
  lines.push(`### Gate runner report: \`${o.provider}\``);
  lines.push("");
  lines.push(`Runner ${RUNNER_VERSION}. Started ${o.startedAt}, ended ${o.endedAt}. Flag \`${o.flag}\`.`);
  if (o.stoppedAt) lines.push(`Run stopped at ${o.stoppedAt}.`);
  lines.push("");
  lines.push("| Gate | Result | Evidence |");
  lines.push("|---|---|---|");
  for (const g of o.results) lines.push(`| ${g.gate} ${g.name} | ${STATUS[g.status]} | ${esc(g.evidence.join(" "))} |`);
  lines.push("");
  lines.push(`**Verdict: ${o.verdict}.** offlineAllowed: ${o.offlineAllowed}.`);
  lines.push(
    o.verdict === "enabled"
      ? `All 9 gates pass. The flag may be PROPOSED to AMIT with this report; the runner never sets it.`
      : `Flag \`${o.flag}\` stays OFF. Re-check after ${recheck}.`,
  );
  if (o.outcomes?.length) {
    lines.push("");
    lines.push("| Title | Kind | Match | Chapters | Languages | Page list | Pages loaded | Notes |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const t of o.outcomes) {
      const notes = t.excluded ? "excluded (rights)" : [t.error, ...(t.pageFailures ?? []).slice(0, 2)].filter(Boolean).join("; ");
      lines.push(
        `| ${esc(t.title)} | ${t.kind} | ${t.matchScore ?? "none"}${t.strongRefs > 1 ? ` (${t.strongRefs} series)` : ""} | ${t.chapters ?? "-"} | ${t.languages.join(", ") || "-"} | ${t.pageList ? `${t.pageList.pages} in ${t.pageList.ms} ms` : "-"} | ${t.pagesLoaded ?? "-"} | ${esc(notes || "")} |`,
      );
    }
  }
  if (o.record) {
    const r = o.record.requests;
    lines.push("");
    lines.push(`Requests: ${r.total} sent, ${r.ok} ok, ${r.failed} failed, ${r.blocked} blocked.`);
  }
  lines.push("");
  return lines.join("\n");
}
