/**
 * Client-reported reading failures (a chapter's pages or images failed in the
 * reader and the app fell back to another provider). Kept separate from the
 * provider's own metrics so unauthenticated reports can never open a circuit
 * or hide a source; they only inform the capability matrix and operators.
 */
export type ReportKind = "pages" | "image" | "empty";

export interface ProviderReports {
  total: number;
  byKind: Record<ReportKind, number>;
  fallbacks: number;
  fallbackSucceeded: number;
  lastAt?: string;
}

const reports = new Map<string, ProviderReports>();
const MAX_PROVIDERS = 500;

export function recordReport(sourceId: string, kind: ReportKind, fallback?: { attempted: boolean; succeeded: boolean }): ProviderReports {
  let r = reports.get(sourceId);
  if (!r) {
    if (reports.size >= MAX_PROVIDERS) reports.clear();
    r = { total: 0, byKind: { pages: 0, image: 0, empty: 0 }, fallbacks: 0, fallbackSucceeded: 0 };
    reports.set(sourceId, r);
  }
  r.total += 1;
  r.byKind[kind] += 1;
  if (fallback?.attempted) r.fallbacks += 1;
  if (fallback?.succeeded) r.fallbackSucceeded += 1;
  r.lastAt = new Date().toISOString();
  return r;
}

export function reportsFor(sourceId: string): ProviderReports | undefined {
  return reports.get(sourceId);
}

export function resetReports(): void {
  reports.clear();
}
