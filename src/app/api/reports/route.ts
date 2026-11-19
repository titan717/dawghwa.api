import { z } from "zod";
import { json, readJson, route, sourceIdSchema } from "@/lib/api/handler";
import { DawghwaError } from "@/lib/core/errors";
import { getRegistry } from "@/lib/providers/registry";
import { recordReport } from "@/lib/providers/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  sourceId: sourceIdSchema,
  kind: z.enum(["pages", "image", "empty"]),
  chapterKey: z.string().trim().max(400).optional(),
  providerChapterId: z.string().trim().max(160).optional(),
  errorCode: z.string().trim().max(60).regex(/^[\w.-]*$/).optional(),
  fallback: z.object({ attempted: z.boolean(), succeeded: z.boolean(), toSourceId: sourceIdSchema.optional() }).optional(),
});

/**
 * POST /api/reports
 * The reader reports a provider variant that failed to load (and whether an
 * equivalent variant from another provider succeeded). Counts surface in
 * /api/sources/capabilities; they never change routing on their own.
 */
export const POST = route(async (req, ctx) => {
  const body = await readJson(req, bodySchema);
  if (!getRegistry().get(body.sourceId)) throw new DawghwaError("SOURCE_NOT_FOUND", `Unknown source "${body.sourceId}"`);
  const r = recordReport(body.sourceId, body.kind, body.fallback);
  console.info(
    JSON.stringify({
      level: "info",
      event: "reader.failure.report",
      requestId: ctx.requestId,
      sourceId: body.sourceId,
      kind: body.kind,
      errorCode: body.errorCode,
      fallback: body.fallback,
    }),
  );
  return json({ accepted: true, totals: { total: r.total, fallbacks: r.fallbacks, fallbackSucceeded: r.fallbackSucceeded } }, ctx, { status: 202 });
});
