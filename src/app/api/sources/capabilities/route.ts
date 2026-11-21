import { json, route } from "@/lib/api/handler";
import { getRegistry } from "@/lib/providers/registry";
import { reportsFor } from "@/lib/providers/reports";
import { READER_VERIFICATION, VERIFICATION_RUN } from "@/lib/providers/verification";
import { sourceState } from "@/lib/services/availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/sources/capabilities
 *
 * Honest capability matrix. `declared` is what an adapter implements;
 * `verified` is only true for providers in the live-verification ledger.
 * `nativeReaderVerified` counts only providers whose full reading path was
 * proven end-to-end in the app against the live provider; `pagesVerified`
 * counts ledger entries whose live chapter pages and image bytes were checked.
 *
 * The ledger is static: it records one past run and is not re-checked at
 * request time. `verification` says how that run was made (the 2026-11-19
 * run called the extraction and image helpers directly, from a development
 * network, not the deployed /api/pages and /api/image routes). Live health is
 * in `availability`, which reflects this instance's real traffic.
 */
export const GET = route(async (_req, ctx) => {
  const rows = getRegistry()
    .all()
    .map((p) => {
      const v = READER_VERIFICATION[p.id];
      const m = p.metrics;
      return {
        id: p.id,
        name: p.name,
        registered: true,
        status: p.isDisabled ? "disabled" : p.descriptor.status,
        declared: {
          search: Boolean(p.capabilities.search),
          metadata: Boolean(p.capabilities.mangaInfo),
          chapters: Boolean(p.capabilities.chapters),
          pages: Boolean(p.capabilities.chapterPages),
          clientOnly: Boolean(p.capabilities.clientOnly),
        },
        verified: {
          search: v?.search ?? false,
          metadata: v?.metadata ?? false,
          chapters: v?.chapters ?? false,
          pages: v?.pages ?? false,
          imageDelivery: v?.imageDelivery ?? false,
          nativeReader: v?.nativeReader ?? false,
          verifiedAt: v?.verifiedAt ?? null,
          sample: v?.sample ?? null,
        },
        availability: {
          state: sourceState(p),
          circuit: p.circuit().state,
          requests: m.requests,
          successes: m.successes,
          failures: m.failures,
          avgLatencyMs: m.avgLatencyMs ?? null,
          lastErrorCode: m.lastErrorCode ?? null,
          readerReports: reportsFor(p.id) ?? null,
        },
        limitations: v?.limitations ?? (p.capabilities.chapterPages ? ["Not live-verified"] : ["No working, permitted page extraction; see docs/PAGE_EXTRACTION.md"]),
      };
    });
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  return json(
    {
      providers: rows,
      verification: VERIFICATION_RUN,
      totals: {
        registered: rows.length,
        declaredPages: count((r) => r.declared.pages),
        pagesVerified: count((r) => r.verified.pages && r.verified.imageDelivery),
        nativeReaderVerified: count((r) => r.verified.nativeReader),
      },
    },
    ctx,
    { cacheControl: "public, max-age=60" },
  );
});
